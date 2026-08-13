import { createContext, useContext, useEffect, useRef, useState, ReactNode, useCallback } from 'react';
import { Project, Segment, MediaItem, Clip, TranscriptWord, PipelineStep, FolderRefs, AudioPart, ProjectMode, CapCutTemplate, AppSettings, ClipAnim, ClipAnimationConfig, ClipTransition, AnimCategory, VideoExportSettings } from './types';
import { saveProject, getAllProjects, deleteProject, getHandle, getBlob, saveBlob, saveHandle, getStorageEstimate, saveTemplate, getAllTemplates, deleteTemplate, getSetting, setSetting } from './lib/db';
import { genId, isAudioFile, isImageFile, isVideoFile, verifyPermission, readFileFromHandle, pickFolder, requestReadPermissions } from './lib/fs';
import { decodeAndConcatAudio, detectSilences, snapToSilence, transcribeAudio, alignAllSegments, loadWhisperModel, decodeAudioParts, buildPartOffsets, transcribeAudioParts } from './lib/audio';
import { transcribeOnline, onlineAvailable } from './lib/online';
import { transcribeNative, nativeAvailable } from './lib/native';
import { parseMediaName, naturalSort, buildTimeline } from './lib/matching';
import { exportCapCutDraft, exportSrtCsv, importTemplateFromFolder, simulateExportWithMockTemplate, ValidationReport } from './lib/export';
import { exportVideo as renderVideoToMp4, DrawSource, CancelSignal } from './lib/render';

interface LogEntry {
  time: number;
  message: string;
  level: 'info' | 'warn' | 'error';
}

interface StoreContextValue {
  projects: Project[];
  currentProject: Project | null;
  logs: LogEntry[];
  storageInfo: { usage: number; quota: number };
  loading: boolean;
  whisperModelProgress: number;
  loadProjects: () => Promise<void>;
  createProject: (name: string, folders: FolderRefs) => Promise<Project>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => void;
  removeProject: (id: string) => Promise<void>;
  updateProject: (updates: Partial<Project>) => Promise<void>;
  updateSegments: (segments: Segment[]) => Promise<void>;
  retimeSegments: (segments: Segment[]) => Promise<void>;
  runPipeline: () => Promise<void>;
  skipTranscription: () => void;
  reconnectFolders: () => Promise<void>;
  exportDraft: (draftsRoot: string, template: CapCutTemplate | null) => Promise<{ blob: Blob; report: ValidationReport; draftMeta: any }>;
  exportFallback: () => Promise<Blob>;
  simulateTestExport: (draftsRoot: string) => Promise<void>;
  // ─── Animations (standalone) ───
  setClipAnimation: (mediaId: string, slot: AnimCategory, anim: ClipAnim | null) => Promise<void>;
  applyAnimation: (slot: AnimCategory, anim: ClipAnim, mediaIds?: string[]) => Promise<void>;
  applyAnimationSequence: (items: { slot: AnimCategory; anim: ClipAnim }[], mediaIds?: string[]) => Promise<void>;
  clearClipAnimations: (mediaId: string) => Promise<void>;
  clearAllAnimations: () => Promise<void>;
  toggleFavoriteAnimation: (animId: string) => Promise<void>;
  // ─── Transitions ───
  setTransition: (mediaId: string, trans: ClipTransition | null) => Promise<void>;
  applyTransition: (trans: ClipTransition, mediaIds?: string[]) => Promise<void>;
  clearAllTransitions: () => Promise<void>;
  exportVideo: (settings: VideoExportSettings, onProgress: (f: number, m: string) => void, signal: CancelSignal) => Promise<Blob>;
  importTemplate: () => Promise<CapCutTemplate | null>;
  templates: CapCutTemplate[];
  loadTemplates: () => Promise<void>;
  removeTemplate: (id: string) => Promise<void>;
  settings: AppSettings | null;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  addLog: (message: string, level?: 'info' | 'warn' | 'error') => void;
  clearLogs: () => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}

function blankProject(name: string, folders: FolderRefs): Project {
  const now = Date.now();
  return {
    id: genId(),
    name,
    createdAt: now,
    updatedAt: now,
    folders,
    segments: [],
    clips: [],
    audioDuration: 0,
    audioPartDurations: [],
    transcript: [],
    pipelineSteps: defaultPipelineSteps(),
    processed: false,
  };
}

function defaultPipelineSteps(): PipelineStep[] {
  return [
    { key: 'load', label: 'Loading audio', status: 'pending', progress: 0 },
    { key: 'transcribe', label: 'Transcribing audio', status: 'pending', progress: 0 },
    { key: 'align', label: 'Aligning segments', status: 'pending', progress: 0 },
    { key: 'scan', label: 'Scanning media folders', status: 'pending', progress: 0 },
    { key: 'build', label: 'Building timeline', status: 'pending', progress: 0 },
    { key: 'ready', label: 'Ready', status: 'pending', progress: 0 },
  ];
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [storageInfo, setStorageInfo] = useState({ usage: 0, quota: 0 });
  const [loading, setLoading] = useState(false);
  const [whisperModelProgress, setWhisperModelProgress] = useState(0);
  const [templates, setTemplates] = useState<CapCutTemplate[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Lets the user bail out of a slow transcription and fall back to even timing.
  const cancelTranscribeRef = useRef(false);
  const skipTranscription = useCallback(() => { cancelTranscribeRef.current = true; }, []);
  // Folder handles cached at open time so we can request their permission
  // synchronously on the Process click (before the click's activation expires).
  const projectHandlesRef = useRef<FileSystemHandle[]>([]);
  const cacheProjectHandles = useCallback(async (project: Project) => {
    const ids: string[] = [];
    const f = project.folders;
    if (f?.mode === 'native') {
      f.audioParts?.forEach((p) => p.handleId && ids.push(p.handleId));
      if (f.imagesHandleId) ids.push(f.imagesHandleId);
      if (f.videosHandleId) ids.push(f.videosHandleId);
    }
    const handles: FileSystemHandle[] = [];
    for (const id of ids) {
      const h = await getHandle(id);
      if (h) handles.push(h);
    }
    projectHandlesRef.current = handles;
  }, []);

  const addLog = useCallback((message: string, level: 'info' | 'warn' | 'error' = 'info') => {
    setLogs((prev) => [...prev.slice(-200), { time: Date.now(), message, level }]);
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  const loadProjects = useCallback(async () => {
    const all = await getAllProjects();
    setProjects(all.sort((a, b) => b.updatedAt - a.updatedAt));
    const storage = await getStorageEstimate();
    setStorageInfo(storage);
  }, []);

  const persist = useCallback((project: Project) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveProject({ ...project, updatedAt: Date.now() });
    }, 500);
  }, []);

  const updateProject = useCallback(async (updates: Partial<Project>) => {
    setCurrentProject((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...updates, updatedAt: Date.now() };
      persist(next);
      return next;
    });
  }, [persist]);

  const createProject = useCallback(async (name: string, folders: FolderRefs): Promise<Project> => {
    const project = blankProject(name, folders);
    await saveProject(project);
    setProjects((prev) => [project, ...prev]);
    setCurrentProject(project);
    cacheProjectHandles(project);
    return project;
  }, [cacheProjectHandles]);

  const openProject = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const all = await getAllProjects();
      const project = all.find((p) => p.id === id);
      if (project) {
        setCurrentProject(project);
        addLog(`Opened project: ${project.name}`);
        cacheProjectHandles(project);
      }
    } finally {
      setLoading(false);
    }
  }, [addLog, cacheProjectHandles]);

  const closeProject = useCallback(() => {
    setCurrentProject(null);
  }, []);

  const removeProject = useCallback(async (id: string) => {
    await deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
    if (currentProject?.id === id) setCurrentProject(null);
    const storage = await getStorageEstimate();
    setStorageInfo(storage);
  }, [currentProject]);

  const updateSegments = useCallback(async (segments: Segment[]) => {
    await updateProject({ segments });
  }, [updateProject]);

  // Apply new segment timings and rebuild the timeline (clips) from them, so the
  // export reflects the change — used by the per-image "timing fix" tool.
  const retimeSegments = useCallback(async (segments: Segment[]) => {
    const clips = buildTimeline(segments);
    await updateProject({ segments, clips });
    addLog('Re-timed selected images and rebuilt the timeline.');
  }, [updateProject, addLog]);

  // ─── Resolve audio blob from project ─────────────────────
  const resolveAudioBlob = useCallback(async (project: Project): Promise<Blob | null> => {
    const parts = project.folders.audioParts;
    if (!parts || parts.length === 0) return null;

    if (project.folders.mode === 'native') {
      const blobs: Blob[] = [];
      for (const part of parts) {
        if (part.handleId) {
          const handle = await getHandle(part.handleId) as FileSystemFileHandle | undefined;
          if (handle) {
            if (!(await verifyPermission(handle))) return null;
            blobs.push(await handle.getFile());
          }
        }
      }
      if (blobs.length === 1) return blobs[0];
      // concat multiple — return combined via AudioBuffer later
      return blobs[0]; // first blob, decodeAndConcat handles all
    } else {
      // fallback mode — get all blobs
      const blobs: Blob[] = [];
      for (const part of parts) {
        if (part.blobId) {
          const blob = await getBlob(part.blobId);
          if (blob) blobs.push(blob);
        }
      }
      return blobs[0] || null;
    }
  }, []);

  const resolveAllAudioBlobs = useCallback(async (project: Project): Promise<Blob[]> => {
    const parts = project.folders.audioParts;
    if (!parts || parts.length === 0) return [];

    const blobs: Blob[] = [];
    if (project.folders.mode === 'native') {
      for (const part of parts) {
        if (part.handleId) {
          const handle = await getHandle(part.handleId) as FileSystemFileHandle | undefined;
          if (handle) {
            if (!(await verifyPermission(handle))) continue;
            blobs.push(await handle.getFile());
          }
        }
      }
    } else {
      for (const part of parts) {
        if (part.blobId) {
          const blob = await getBlob(part.blobId);
          if (blob) blobs.push(blob);
        }
      }
    }
    return blobs;
  }, []);

  // ─── Scan media folders ──────────────────────────────────
  const scanMediaFolders = useCallback(async (project: Project): Promise<MediaItem[]> => {
    const items: MediaItem[] = [];

    if (project.folders.mode === 'native') {
      // Images folder
      if (project.folders.imagesHandleId) {
        const dirHandle = await getHandle(project.folders.imagesHandleId) as FileSystemDirectoryHandle | undefined;
        if (dirHandle && await verifyPermission(dirHandle)) {
          for await (const entry of (dirHandle as any).values()) {
            if (entry.kind !== 'file') continue;
            const parsed = parseMediaName(entry.name);
            if (!parsed) continue;
            if (isImageFile(entry.name)) {
              const file = await entry.getFile();
              items.push({
                id: genId(),
                kind: 'image',
                name: entry.name,
                segment: parsed.segment,
                subIndex: parsed.subIndex,
                handlePath: entry.name,
                size: file.size,
              });
            }
          }
        }
      }
      // Videos folder
      if (project.folders.videosHandleId) {
        const dirHandle = await getHandle(project.folders.videosHandleId) as FileSystemDirectoryHandle | undefined;
        if (dirHandle && await verifyPermission(dirHandle)) {
          for await (const entry of (dirHandle as any).values()) {
            if (entry.kind !== 'file') continue;
            const parsed = parseMediaName(entry.name);
            if (!parsed) continue;
            if (isVideoFile(entry.name)) {
              const file = await entry.getFile();
              const duration = await probeVideoDuration(file);
              items.push({
                id: genId(),
                kind: 'video',
                name: entry.name,
                segment: parsed.segment,
                subIndex: parsed.subIndex,
                handlePath: entry.name,
                size: file.size,
                duration,
              });
            }
          }
        }
      }
    } else {
      // Fallback mode — blobs stored in db
      if (project.folders.imagesBlobIds) {
        for (const blobId of project.folders.imagesBlobIds) {
          const blob = await getBlob(blobId);
          if (!blob) continue;
          // Need filename — stored as part of blob id mapping
          // We stored the File object which has .name
          const file = blob as File;
          const parsed = parseMediaName(file.name);
          if (!parsed || !isImageFile(file.name)) continue;
          items.push({
            id: genId(),
            kind: 'image',
            name: file.name,
            segment: parsed.segment,
            subIndex: parsed.subIndex,
            blobId,
            size: file.size,
          });
        }
      }
      if (project.folders.videosBlobIds) {
        for (const blobId of project.folders.videosBlobIds) {
          const blob = await getBlob(blobId);
          if (!blob) continue;
          const file = blob as File;
          const parsed = parseMediaName(file.name);
          if (!parsed || !isVideoFile(file.name)) continue;
          const duration = await probeVideoDuration(file);
          items.push({
            id: genId(),
            kind: 'video',
            name: file.name,
            segment: parsed.segment,
            subIndex: parsed.subIndex,
            blobId,
            size: file.size,
            duration,
          });
        }
      }
    }

    return items.sort(naturalSort);
  }, []);

  // ─── Run full pipeline ───────────────────────────────────
  const runPipeline = useCallback(async () => {
    if (!currentProject) return;
    let project = { ...currentProject };

    // Ask for folder permissions right now, while the Process click still counts
    // as a user gesture — the pipeline runs for minutes, so requesting later
    // (during "Scanning media folders") fails with "User activation is required".
    await requestReadPermissions(projectHandlesRef.current);

    const steps = defaultPipelineSteps();
    await updateProject({ pipelineSteps: steps, processed: false });

    try {
      // Step 1: Load audio
      steps[0].status = 'running';
      steps[0].message = 'Decoding audio files...';
      await updateProject({ pipelineSteps: [...steps] });
      addLog('Loading audio...');

      const audioBlobs = await resolveAllAudioBlobs(project);
      if (audioBlobs.length === 0) {
        steps[0].status = 'error';
        steps[0].message = 'No audio files found';
        await updateProject({ pipelineSteps: [...steps] });
        return;
      }

      const { buffer: audioBuffer, durations: partDurations } = await decodeAudioParts(audioBlobs, (done, total) => {
        steps[0].progress = (done / total) * 100;
        updateProject({ pipelineSteps: [...steps] });
      });
      const audioDuration = audioBuffer.duration;
      const offsets = buildPartOffsets(partDurations);
      steps[0].status = 'done';
      steps[0].progress = 100;
      steps[0].message = `${audioBlobs.length} part(s), ${audioDuration.toFixed(1)}s`;
      project.audioDuration = audioDuration;
      project.audioPartDurations = partDurations;
      await updateProject({ pipelineSteps: [...steps], audioDuration, audioPartDurations: partDurations });
      // Log each part + total so the user can verify all parts were loaded
      for (let i = 0; i < audioBlobs.length; i++) {
        const name = project.folders.audioParts[i]?.name || `Part ${i + 1}`;
        addLog(`Part ${i + 1}: ${name} — ${partDurations[i].toFixed(2)}s (offset ${offsets[i].toFixed(2)}s)`);
      }
      addLog(`Total audio duration: ${audioDuration.toFixed(2)}s from ${audioBlobs.length} part(s)`);

      // Step 2: Transcribe
      steps[1].status = 'running';
      steps[1].message = 'Loading Whisper model...';
      await updateProject({ pipelineSteps: [...steps] });
      addLog('Transcribing audio with Whisper...');

      let transcript: TranscriptWord[] = [];
      let usedFallback = false;
      if (project.transcript && project.transcript.length > 0) {
        addLog('Using cached transcript');
        transcript = project.transcript;
      } else {
        try {
          let started = false;
          let loggedPart = -1;
          cancelTranscribeRef.current = false;
          const useOnline =
            settings?.transcriptionMode === 'online' && !!settings?.groqApiKey && onlineAvailable();

          const onPartProgress = (part: number, total: number, fraction: number) => {
            started = true;
            const overall = (part + fraction) / total;
            steps[1].progress = Math.round(10 + overall * 90);
            steps[1].message = total > 1
              ? `Transcribing audio — part ${part + 1}/${total}, ${Math.round(fraction * 100)}%`
              : `Transcribing audio — ${Math.round(fraction * 100)}%`;
            updateProject({ pipelineSteps: [...steps] });
            if (part !== loggedPart) {
              loggedPart = part;
              addLog(useOnline
                ? `Transcribing part ${part + 1}/${total} with Groq (online)…`
                : `Transcribing part ${part + 1}/${total}… (runs on your CPU; press “Skip transcription” for even timing)`);
            }
          };

          // Offline can use the fast bundled native engine (whisper.cpp) when
          // present, or the in-browser WASM engine as a last resort.
          const useNative = !useOnline && (await nativeAvailable());

          if (useOnline) {
            steps[1].message = 'Transcribing audio online (Groq)…';
            await updateProject({ pipelineSteps: [...steps] });
            addLog('Using Groq online transcription (fast).');
            transcript = await transcribeOnline(
              audioBlobs, offsets, settings!.groqApiKey!, onPartProgress, () => cancelTranscribeRef.current,
            );
          } else {
            let nativeDone = false;
            if (useNative) {
              try {
                steps[1].message = 'Transcribing audio (offline, fast)…';
                await updateProject({ pipelineSteps: [...steps] });
                addLog('Using bundled offline engine (whisper.cpp) — free, unlimited, on your PC.');
                transcript = await transcribeNative(
                  audioBlobs, offsets, onPartProgress, () => cancelTranscribeRef.current,
                );
                nativeDone = true;
              } catch (nativeErr: any) {
                if (nativeErr?.name === 'TranscriptionCancelled') throw nativeErr;
                addLog(`Fast offline engine unavailable (${nativeErr.message}); using the in-browser engine.`, 'warn');
              }
            }
            if (!nativeDone) {
              transcript = await transcribeAudioParts(audioBlobs, offsets, (p) => {
                if (started) return;
                setWhisperModelProgress(p.progress);
                steps[1].message = `Loading speech model… ${Math.round(p.progress)}%`;
                steps[1].progress = Math.min(9, p.progress * 0.1);
                updateProject({ pipelineSteps: [...steps] });
              }, onPartProgress, () => cancelTranscribeRef.current);
            }
          }
          steps[1].message = `Transcribed ${transcript.length} words`;
          steps[1].progress = 100;
          await updateProject({ pipelineSteps: [...steps] });
        } catch (err: any) {
          const cancelled = err?.name === 'TranscriptionCancelled';
          addLog(
            cancelled
              ? 'Transcription skipped — using even timing across the audio instead.'
              : `Transcription failed: ${err.message}. Falling back to even timing.`,
            'warn',
          );
          steps[1].status = 'done';
          steps[1].progress = 100;
          steps[1].message = 'Using even timing';
          usedFallback = true;
          await updateProject({ pipelineSteps: [...steps] });
        }
      }
      if (!usedFallback) {
        steps[1].status = 'done';
        steps[1].progress = 100;
        steps[1].message = `${transcript.length} words`;
      }
      project.transcript = transcript;
      await updateProject({ pipelineSteps: [...steps], transcript });
      if (!usedFallback) {
        addLog(`Transcribed: ${transcript.length} words across ${audioBlobs.length} part(s)`);
        // Log first 10 and last 10 words with timestamps
        addLog('First 10 words:');
        for (let i = 0; i < Math.min(10, transcript.length); i++) {
          const w = transcript[i];
          addLog(`  [${w.start.toFixed(2)}-${w.end.toFixed(2)}] "${w.word}"`);
        }
        addLog('Last 10 words:');
        for (let i = Math.max(0, transcript.length - 10); i < transcript.length; i++) {
          const w = transcript[i];
          addLog(`  [${w.start.toFixed(2)}-${w.end.toFixed(2)}] "${w.word}"`);
        }
        // Verify last word end ≈ audio duration
        if (transcript.length > 0) {
          const lastEnd = transcript[transcript.length - 1].end;
          const gap = audioDuration - lastEnd;
          if (gap > 2) {
            addLog(`WARNING: Transcription stopped early — last word ends at ${lastEnd.toFixed(2)}s but audio is ${audioDuration.toFixed(2)}s (gap ${gap.toFixed(2)}s)`, 'warn');
          } else {
            addLog(`Transcription covers full audio (last word ends at ${lastEnd.toFixed(2)}s, audio ${audioDuration.toFixed(2)}s)`);
          }
        }
      }

      // Step 3: Align segments
      steps[2].status = 'running';
      steps[2].message = 'Aligning segments to transcript...';
      await updateProject({ pipelineSteps: [...steps] });
      addLog('Aligning segments...');

      if (project.segments.length > 0) {
        let updatedSegments: Segment[];
        if (transcript.length === 0) {
          // Fallback: proportional distribution by text length
          addLog('Using proportional timing (no transcript available)');
          const totalChars = project.segments.reduce((sum, s) => sum + Math.max(s.text.length, 1), 0);
          let elapsed = 0;
          updatedSegments = project.segments.map((seg, i) => {
            const ratio = Math.max(seg.text.length, 1) / totalChars;
            const dur = audioDuration * ratio;
            const start = i === 0 ? 0 : elapsed;
            const end = i === project.segments.length - 1 ? audioDuration : start + dur;
            elapsed = end;
            return {
              ...seg,
              startTime: start,
              endTime: end,
              confidence: 0,
              lowConfidence: true,
            };
          });
          steps[2].message = `${updatedSegments.length} segments (proportional)`;
        } else {
          // Detect pauses in the real audio so segment starts can snap to the
          // moment speech resumes (fixes images landing on a later pause).
          const silences = detectSilences(audioBuffer);
          addLog(`Detected ${silences.length} pauses for boundary snapping`);
          const alignments = alignAllSegments(
            project.segments.map((s) => ({ text: s.text })),
            transcript,
            audioDuration,
            silences,
          );
          updatedSegments = project.segments.map((seg, i) => ({
            ...seg,
            startTime: alignments[i].startTime,
            endTime: alignments[i].endTime,
            confidence: alignments[i].confidence,
            lowConfidence: alignments[i].lowConfidence,
          }));

          // ── Offset verification table (whisper start vs snapped start) ──
          const offsetDeltas: number[] = [];
          addLog('Seg | first words              | whisper |  start  |  delta | conf');
          for (let i = 0; i < alignments.length; i++) {
            const a = alignments[i];
            const delta = a.startTime - a.whisperFirstWordStart;
            offsetDeltas.push(delta);
            const words = project.segments[i].text.trim().split(/\s+/).slice(0, 4).join(' ').slice(0, 24).padEnd(24);
            addLog(
              `${String(i + 1).padStart(3)} | ${words} | ${a.whisperFirstWordStart.toFixed(2).padStart(7)} | ` +
              `${a.startTime.toFixed(2).padStart(7)} | ${delta.toFixed(2).padStart(6)} | ${a.confidence.toFixed(2)}`,
              Math.abs(delta) > 1 ? 'warn' : undefined,
            );
          }
          const sorted = [...offsetDeltas].sort((x, y) => x - y);
          const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
          addLog('=== GLOBAL OFFSET CHECK ===');
          addLog(`median(start - whisperStart) = ${median.toFixed(2)}s | min ${Math.min(...offsetDeltas).toFixed(2)}s | max ${Math.max(...offsetDeltas).toFixed(2)}s`,
            Math.abs(median) > 2 ? 'warn' : undefined);
          // Whisper-vs-audio offset check: where does speech actually begin in the
          // audio (first silence ends) vs where Whisper puts its first word? A big
          // gap means the transcript timestamps themselves are shifted.
          const leadSilence = silences.find((s) => s.start < 0.3);
          const speechOnset = leadSilence ? leadSilence.end : 0;
          const whisperFirst = transcript[0]?.start ?? 0;
          addLog(`audio speech begins ≈ ${speechOnset.toFixed(2)}s | whisper first word at ${whisperFirst.toFixed(2)}s | gap ${(whisperFirst - speechOnset).toFixed(2)}s`,
            Math.abs(whisperFirst - speechOnset) > 2 ? 'warn' : undefined);
          if (whisperFirst - speechOnset > 2) {
            addLog('WARNING: Whisper timestamps look shifted vs the audio — the offset is in the transcript, not the alignment.', 'warn');
          }
          if (Math.abs(median) > 2) {
            addLog(`WARNING: systematic ${median.toFixed(2)}s offset detected — corrected in alignment.`, 'warn');
          }
          // Per-segment debug for segment 1 and segment 10
          for (const dbg of [0, 9]) {
            if (dbg >= alignments.length) continue;
            const a = alignments[dbg];
            addLog(`--- SEGMENT ${dbg + 1} DEBUG ---`);
            addLog(`  expected first words: "${project.segments[dbg].text.trim().split(/\s+/).slice(0, 5).join(' ')}"`);
            addLog(`  matched whisper word: "${a.matchedFirstWord}"  raw start ${a.whisperFirstWordStart.toFixed(2)}s`);
            addLog(`  snapped start ${a.snappedStart.toFixed(2)}s → final start ${a.startTime.toFixed(2)}s (delta ${(a.startTime - a.whisperFirstWordStart).toFixed(2)}s)`);
          }
          steps[2].message = `${updatedSegments.length} segments aligned`;
        }

        // Apply the user's manual image-timing offset: shift every segment
        // earlier by imageOffsetSec (fixes "images change late"). Uniform shift
        // keeps contiguity (end[i] == start[i+1]); first stays at 0 and last
        // ends at the audio end.
        const imageOffset = settings?.imageOffsetSec || 0;
        if (imageOffset !== 0) {
          updatedSegments = updatedSegments.map((seg) => {
            const start = Math.max(0, Math.min(seg.startTime - imageOffset, audioDuration));
            let end = Math.max(start, Math.min(seg.endTime - imageOffset, audioDuration));
            if (end <= start) end = Math.min(start + 0.5, audioDuration);
            return { ...seg, startTime: start, endTime: end };
          });
          if (updatedSegments.length > 0) {
            updatedSegments[0] = { ...updatedSegments[0], startTime: 0 };
            const last = updatedSegments.length - 1;
            updatedSegments[last] = { ...updatedSegments[last], endTime: audioDuration };
          }
          addLog(`Applied image timing offset of ${imageOffset}s (images shifted ${imageOffset > 0 ? 'earlier' : 'later'}).`);
        }

        project.segments = updatedSegments;
        steps[2].status = 'done';
        steps[2].progress = 100;
        await updateProject({ pipelineSteps: [...steps], segments: updatedSegments });
        addLog(`Aligned ${updatedSegments.length} segments`);
      } else {
        steps[2].status = 'done';
        steps[2].progress = 100;
        steps[2].message = 'No segments to align';
        await updateProject({ pipelineSteps: [...steps] });
      }

      // Step 4: Scan media folders
      steps[3].status = 'running';
      steps[3].message = 'Scanning folders...';
      await updateProject({ pipelineSteps: [...steps] });
      addLog('Scanning media folders...');

      const mediaItems = await scanMediaFolders(project);
      steps[3].status = 'done';
      steps[3].progress = 100;
      steps[3].message = `${mediaItems.length} media files`;
      addLog(`Found ${mediaItems.length} media files`);

      // Match media to segments
      const segMediaMap = new Map<number, MediaItem[]>();
      for (const item of mediaItems) {
        const arr = segMediaMap.get(item.segment) || [];
        arr.push(item);
        segMediaMap.set(item.segment, arr);
      }
      const updatedSegments = project.segments.map((seg) => {
        const matched = (segMediaMap.get(seg.index) || []).sort(naturalSort);
        const hasVideo = matched.some((m) => m.kind === 'video');
        const hasImages = matched.some((m) => m.kind === 'image');
        return {
          ...seg,
          matchedMedia: matched,
          hasVideo,
          hasImages,
          hasMedia: matched.length > 0,
        };
      });
      project.segments = updatedSegments;
      await updateProject({ pipelineSteps: [...steps], segments: updatedSegments });

      // Step 5: Build timeline
      steps[4].status = 'running';
      steps[4].message = 'Building timeline...';
      await updateProject({ pipelineSteps: [...steps] });
      addLog('Building timeline...');

      const clips = buildTimeline(updatedSegments);
      project.clips = clips;
      steps[4].status = 'done';
      steps[4].progress = 100;
      steps[4].message = `${clips.length} clips`;
      await updateProject({ pipelineSteps: [...steps], clips });
      addLog(`Built timeline: ${clips.length} clips`);

      // Verification table: per-segment audio vs images duration
      addLog('=== SEGMENT VERIFICATION TABLE ===');
      addLog(`Seg# | Audio Start | Audio End | Spoken Dur | Images Dur | Status`);
      let allMatch = true;
      for (const seg of updatedSegments) {
        const segClips = clips.filter((c) => c.segmentIndex === seg.index);
        const imagesDur = segClips.reduce((sum, c) => sum + c.duration, 0);
        const spokenDur = seg.endTime - seg.startTime;
        const match = Math.abs(imagesDur - spokenDur) < 0.01;
        if (!match) allMatch = false;
        addLog(
          `${seg.index} | ${seg.startTime.toFixed(3)} | ${seg.endTime.toFixed(3)} | ${spokenDur.toFixed(3)}s | ${imagesDur.toFixed(3)}s | ${match ? 'MATCH' : 'MISMATCH'}`,
          match ? undefined : 'warn',
        );
      }
      addLog(allMatch ? 'All segments MATCH.' : 'Some segments MISMATCH!', allMatch ? undefined : 'warn');
      addLog('=== END VERIFICATION ===');

      // Step 6: Ready
      steps[5].status = 'done';
      steps[5].progress = 100;
      steps[5].message = 'All ready';
      await updateProject({ pipelineSteps: [...steps], processed: true });
      addLog('Pipeline complete!');
      setWhisperModelProgress(0);
    } catch (err: any) {
      addLog(`Pipeline error: ${err.message}`, 'error');
      const failedStep = steps.find((s) => s.status === 'running');
      if (failedStep) {
        failedStep.status = 'error';
        failedStep.message = err.message;
        await updateProject({ pipelineSteps: [...steps] });
      }
    }
  }, [currentProject, updateProject, addLog, resolveAllAudioBlobs, scanMediaFolders, settings]);

  // ─── Reconnect folders (native mode) ─────────────────────
  const reconnectFolders = useCallback(async () => {
    if (!currentProject || currentProject.folders.mode !== 'native') return;
    const folders = currentProject.folders;
    let reconnected = true;

    if (folders.imagesHandleId) {
      const handle = await getHandle(folders.imagesHandleId) as FileSystemDirectoryHandle | undefined;
      if (handle && !(await verifyPermission(handle))) reconnected = false;
    }
    if (folders.videosHandleId) {
      const handle = await getHandle(folders.videosHandleId) as FileSystemDirectoryHandle | undefined;
      if (handle && !(await verifyPermission(handle))) reconnected = false;
    }
    for (const part of folders.audioParts) {
      if (part.handleId) {
        const handle = await getHandle(part.handleId) as FileSystemFileHandle | undefined;
        if (handle && !(await verifyPermission(handle))) reconnected = false;
      }
    }

    if (reconnected) addLog('Folders reconnected successfully');
    else addLog('Some folders could not be reconnected', 'warn');
  }, [currentProject, addLog]);

  // ─── Export ──────────────────────────────────────────────
  const collectMediaBlobs = useCallback(async (project: Project): Promise<Map<string, Blob>> => {
    const blobs = new Map<string, Blob>();

    // Audio — include ALL parts (not just the first)
    const audioBlobs = await resolveAllAudioBlobs(project);
    for (let i = 0; i < audioBlobs.length && i < project.folders.audioParts.length; i++) {
      blobs.set(project.folders.audioParts[i].id, audioBlobs[i]);
    }

    // Media
    if (project.folders.mode === 'native') {
      const allMedia = new Map<string, MediaItem>();
      for (const seg of project.segments) {
        for (const m of seg.matchedMedia) {
          allMedia.set(m.id, m);
        }
      }
      for (const [id, media] of allMedia) {
        if (media.handlePath) {
          // find which folder
          const folderId = media.kind === 'video' ? project.folders.videosHandleId : project.folders.imagesHandleId;
          if (folderId) {
            const dirHandle = await getHandle(folderId) as FileSystemDirectoryHandle | undefined;
            if (dirHandle && await verifyPermission(dirHandle)) {
              const fileHandle = await dirHandle.getFileHandle(media.handlePath);
              const file = await fileHandle.getFile();
              blobs.set(id, file);
            }
          }
        }
      }
    } else {
      // fallback — blobs stored in db
      const seenBlobIds = new Set<string>();
      for (const seg of project.segments) {
        for (const m of seg.matchedMedia) {
          if (m.blobId && !seenBlobIds.has(m.blobId)) {
            seenBlobIds.add(m.blobId);
            const blob = await getBlob(m.blobId);
            if (blob) blobs.set(m.id, blob);
          }
        }
      }
    }

    return blobs;
  }, [resolveAllAudioBlobs]);

  const exportDraft = useCallback(async (draftsRoot: string, template: CapCutTemplate | null): Promise<{ blob: Blob; report: ValidationReport; draftMeta: any }> => {
    if (!currentProject) throw new Error('No project open');
    if (!template) throw new Error('No template imported. Import a CapCut template draft first.');
    const blobs = await collectMediaBlobs(currentProject);
    const result = await exportCapCutDraft(currentProject, blobs, {
      projectName: currentProject.name,
      draftsRoot,
      template,
    });
    addLog(`Export complete. Validator: ${result.report.passed ? 'PASS' : 'FAIL'} (${result.report.checks.filter(c => c.pass).length}/${result.report.checks.length} checks)`);
    for (const check of result.report.checks) {
      addLog(`  ${check.pass ? 'PASS' : 'FAIL'} — ${check.name}: ${check.detail}`);
    }
    addLog(`draft_fold_path: ${result.draftMeta.draft_fold_path}`);
    addLog(`draft_root_path: ${result.draftMeta.draft_root_path}`);
    return result;
  }, [currentProject, collectMediaBlobs, addLog]);

  const exportFallback = useCallback(async (): Promise<Blob> => {
    if (!currentProject) throw new Error('No project open');
    const blobs = await collectMediaBlobs(currentProject);
    return exportSrtCsv(currentProject, blobs);
  }, [currentProject, collectMediaBlobs]);

  const simulateTestExport = useCallback(async (draftsRoot: string): Promise<void> => {
    if (!currentProject) throw new Error('No project open');
    addLog('=== TEST SIMULATION START ===');
    addLog(`Project: ${currentProject.name}, clips: ${currentProject.clips.length}, duration: ${currentProject.audioDuration}s`);
    try {
      const blobs = await collectMediaBlobs(currentProject);
      const result = await simulateExportWithMockTemplate(currentProject, blobs, draftsRoot);
      addLog(`Validator: ${result.report.passed ? 'PASS' : 'FAIL'} (${result.report.checks.filter(c => c.pass).length}/${result.report.checks.length} checks)`);
      for (const check of result.report.checks) {
        addLog(`  ${check.pass ? 'PASS' : 'FAIL'} — ${check.name}: ${check.detail}`);
      }
      addLog(`First video material field count: ${result.firstVideoFieldCount}`);
      addLog(`First segment field count: ${result.firstSegmentFieldCount}`);
      addLog(`First segment extra_material_refs count: ${result.firstSegmentRefCount}`);
      addLog(`draft_fold_path: ${result.draftFoldPath}`);
      addLog(`draft_root_path: ${result.draftRootPath}`);
    } catch (e: any) {
      addLog(`Test simulation error: ${e.message}`, 'error');
    }
    addLog('=== TEST SIMULATION END ===');
  }, [currentProject, collectMediaBlobs, addLog]);

  // ─── Animations ──────────────────────────────────────────
  // Animation config is keyed by media id (stable across "fix late images"
  // retimes, which reuse the same MediaItem objects). Assigning animations
  // never rebuilds the timeline, so the audio↔image matching is untouched.
  const setClipAnimation = useCallback(async (mediaId: string, slot: AnimCategory, anim: ClipAnim | null) => {
    setCurrentProject((prev) => {
      if (!prev) return prev;
      const map: Record<string, ClipAnimationConfig> = { ...(prev.clipAnimations || {}) };
      const cfg: ClipAnimationConfig = { ...(map[mediaId] || {}) };
      if (anim) {
        cfg[slot] = anim;
        // A combo animation replaces in+out; picking in/out clears any combo.
        if (slot === 'combo') { delete cfg.in; delete cfg.out; }
        else delete cfg.combo;
      } else {
        delete cfg[slot];
      }
      if (!cfg.in && !cfg.out && !cfg.combo) delete map[mediaId];
      else map[mediaId] = cfg;
      const next = { ...prev, clipAnimations: map, updatedAt: Date.now() };
      persist(next);
      return next;
    });
  }, [persist]);

  const applyAnimation = useCallback(async (slot: AnimCategory, anim: ClipAnim, mediaIds?: string[]) => {
    setCurrentProject((prev) => {
      if (!prev) return prev;
      // Default target: every image clip. (Videos can be targeted explicitly.)
      const targets = mediaIds && mediaIds.length > 0
        ? mediaIds
        : Array.from(new Set(prev.clips.filter((c) => c.isImage).map((c) => c.media.id)));
      const map: Record<string, ClipAnimationConfig> = { ...(prev.clipAnimations || {}) };
      for (const id of targets) {
        const cfg: ClipAnimationConfig = { ...(map[id] || {}) };
        cfg[slot] = { ...anim };
        if (slot === 'combo') { delete cfg.in; delete cfg.out; }
        else delete cfg.combo;
        map[id] = cfg;
      }
      const next = { ...prev, clipAnimations: map, updatedAt: Date.now() };
      persist(next);
      return next;
    });
    addLog(`Applied ${slot} animation "${anim.animId}" to ${mediaIds?.length ? mediaIds.length + ' selected' : 'all'} image(s).`);
  }, [persist, addLog]);

  const clearClipAnimations = useCallback(async (mediaId: string) => {
    setCurrentProject((prev) => {
      if (!prev) return prev;
      const map = { ...(prev.clipAnimations || {}) };
      delete map[mediaId];
      const next = { ...prev, clipAnimations: map, updatedAt: Date.now() };
      persist(next);
      return next;
    });
  }, [persist]);

  const clearAllAnimations = useCallback(async () => {
    await updateProject({ clipAnimations: {} });
    addLog('Cleared all animations.');
  }, [updateProject, addLog]);

  // Apply an ORDERED list of animations across the target images, cycling
  // through the list in timeline order — e.g. [A,B,C] → img1=A, img2=B,
  // img3=C, img4=A … This is the "sequence-wise multiple animations" flow.
  const applyAnimationSequence = useCallback(async (items: { slot: AnimCategory; anim: ClipAnim }[], mediaIds?: string[]) => {
    if (items.length === 0) return;
    setCurrentProject((prev) => {
      if (!prev) return prev;
      // Ordered, de-duplicated list of target media ids (timeline order).
      const order: string[] = [];
      const seen = new Set<string>();
      const wanted = mediaIds && mediaIds.length > 0 ? new Set(mediaIds) : null;
      for (const c of prev.clips) {
        if (!c.isImage || seen.has(c.media.id)) continue;
        if (wanted && !wanted.has(c.media.id)) continue;
        seen.add(c.media.id);
        order.push(c.media.id);
      }
      const map: Record<string, ClipAnimationConfig> = { ...(prev.clipAnimations || {}) };
      order.forEach((id, i) => {
        const { slot, anim } = items[i % items.length];
        const cfg: ClipAnimationConfig = { ...(map[id] || {}) };
        cfg[slot] = { ...anim };
        if (slot === 'combo') { delete cfg.in; delete cfg.out; }
        else delete cfg.combo;
        map[id] = cfg;
      });
      const next = { ...prev, clipAnimations: map, updatedAt: Date.now() };
      persist(next);
      return next;
    });
    addLog(`Applied a sequence of ${items.length} animation(s) across ${mediaIds?.length ? mediaIds.length + ' selected' : 'all'} image(s).`);
  }, [persist, addLog]);

  const toggleFavoriteAnimation = useCallback(async (animId: string) => {
    const base = settings || { draftsRootPath: '', username: '' };
    const favs = new Set(base.favoriteAnimations || []);
    if (favs.has(animId)) favs.delete(animId); else favs.add(animId);
    const next = { ...base, favoriteAnimations: Array.from(favs) };
    await setSetting('appSettings', next);
    setSettings(next);
  }, [settings]);

  // ─── Transitions ─────────────────────────────────────────
  const setTransition = useCallback(async (mediaId: string, trans: ClipTransition | null) => {
    setCurrentProject((prev) => {
      if (!prev) return prev;
      const map = { ...(prev.transitions || {}) };
      if (trans) map[mediaId] = trans; else delete map[mediaId];
      const next = { ...prev, transitions: map, updatedAt: Date.now() };
      persist(next);
      return next;
    });
  }, [persist]);

  const applyTransition = useCallback(async (trans: ClipTransition, mediaIds?: string[]) => {
    setCurrentProject((prev) => {
      if (!prev) return prev;
      // A transition plays at a clip's start, so skip the very first clip.
      const imageClipIds: string[] = [];
      const seen = new Set<string>();
      prev.clips.forEach((c, idx) => {
        if (idx === 0 || seen.has(c.media.id)) return;
        seen.add(c.media.id);
        imageClipIds.push(c.media.id);
      });
      const targets = mediaIds && mediaIds.length > 0 ? mediaIds.filter((id) => id !== prev.clips[0]?.media.id) : imageClipIds;
      const map = { ...(prev.transitions || {}) };
      for (const id of targets) map[id] = { ...trans };
      const next = { ...prev, transitions: map, updatedAt: Date.now() };
      persist(next);
      return next;
    });
    addLog(`Applied "${trans.transId}" transition to ${mediaIds?.length ? mediaIds.length + ' selected' : 'all'} clip(s).`);
  }, [persist, addLog]);

  const clearAllTransitions = useCallback(async () => {
    await updateProject({ transitions: {} });
    addLog('Cleared all transitions.');
  }, [updateProject, addLog]);

  // ─── Standalone MP4 export ───────────────────────────────
  const exportVideo = useCallback(async (
    settings: VideoExportSettings,
    onProgress: (f: number, m: string) => void,
    signal: CancelSignal,
  ): Promise<Blob> => {
    if (!currentProject) throw new Error('No project open');
    const project = currentProject;
    if (!project.processed || project.clips.length === 0) {
      throw new Error('Run Process first — there is no timeline to render yet.');
    }

    onProgress(0.02, 'Collecting media…');
    const blobs = await collectMediaBlobs(project);

    // Decode images to bitmaps (one per unique image clip).
    onProgress(0.05, 'Decoding images…');
    const imageBitmaps = new Map<string, DrawSource>();
    const videoElements = new Map<string, HTMLVideoElement>();
    const tempUrls: string[] = [];
    const seen = new Set<string>();
    for (const clip of project.clips) {
      if (seen.has(clip.media.id)) continue;
      seen.add(clip.media.id);
      const blob = blobs.get(clip.media.id);
      if (!blob) continue;
      if (clip.isImage) {
        try {
          const bmp = await createImageBitmap(blob);
          imageBitmaps.set(clip.media.id, bmp);
        } catch { /* skip undecodable image */ }
      } else {
        const url = URL.createObjectURL(blob);
        tempUrls.push(url);
        const v = document.createElement('video');
        v.muted = true; v.preload = 'auto'; v.src = url;
        await new Promise<void>((resolve) => {
          v.onloadeddata = () => resolve();
          v.onerror = () => resolve();
          setTimeout(resolve, 3000);
        });
        videoElements.set(clip.media.id, v);
      }
    }

    // Decode all audio parts into a single buffer.
    onProgress(0.1, 'Decoding audio…');
    let audioBuffer: AudioBuffer | null = null;
    try {
      const audioBlobs = await resolveAllAudioBlobs(project);
      if (audioBlobs.length > 0) {
        const decoded = await decodeAudioParts(audioBlobs);
        audioBuffer = decoded.buffer;
      }
    } catch (e: any) {
      addLog(`Audio decode failed, exporting silent video: ${e.message}`, 'warn');
    }

    try {
      const blob = await renderVideoToMp4({
        clips: project.clips,
        audioDuration: project.audioDuration,
        clipAnimations: project.clipAnimations || {},
        transitions: project.transitions || {},
        imageBitmaps,
        videoElements,
        audioBuffer,
        settings,
        onProgress,
        signal,
      });
      addLog(`Video export complete: ${settings.resolution} @ ${settings.fps}fps, ${(blob.size / 1_048_576).toFixed(1)} MB`);
      return blob;
    } finally {
      tempUrls.forEach((u) => URL.revokeObjectURL(u));
      imageBitmaps.forEach((b) => { if ((b as any).close) (b as any).close(); });
    }
  }, [currentProject, collectMediaBlobs, resolveAllAudioBlobs, addLog]);

  const loadTemplates = useCallback(async () => {
    const tpls = await getAllTemplates();
    setTemplates(tpls);
  }, []);

  const importTemplate = useCallback(async (): Promise<CapCutTemplate | null> => {
    try {
      const result = await pickFolder();
      let files: File[] = [];
      if (result.mode === 'native' && result.handle) {
        // Native: iterate directory
        for await (const entry of (result.handle as any).values()) {
          if (entry.kind === 'file') {
            const file = await entry.getFile();
            files.push(file);
          }
        }
      } else if (result.files) {
        files = result.files;
      }
      if (files.length === 0) return null;

      // Filter to relevant files
      const relevantFiles = files.filter(f =>
        f.name === 'draft_content.json' ||
        f.name === 'draft_meta_info.json' ||
        f.name === 'draft_settings' ||
        f.name === 'draft_virtual_store.json' ||
        f.name === 'draft_biz_config.json' ||
        f.name === 'draft_agency_config.json' ||
        f.name === 'key_value.json' ||
        f.name === 'performance_opt_info.json' ||
        f.name === 'timeline_layout.json'
      );

      if (!relevantFiles.find(f => f.name === 'draft_content.json') || !relevantFiles.find(f => f.name === 'draft_meta_info.json')) {
        throw new Error('Selected folder must contain draft_content.json and draft_meta_info.json');
      }

      const template = await importTemplateFromFolder(relevantFiles);
      await saveTemplate(template);
      setTemplates(prev => [...prev, template]);
      addLog(`Imported template: ${template.name} (root: ${template.detectedDraftsRoot})`);

      // Auto-save detected drafts root to settings
      if (template.detectedDraftsRoot) {
        const newSettings: AppSettings = {
          draftsRootPath: template.detectedDraftsRoot,
          username: settings?.username || '',
        };
        await setSetting('appSettings', newSettings);
        setSettings(newSettings);
        addLog(`Auto-detected drafts root: ${template.detectedDraftsRoot}`);
      }

      return template;
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        addLog(`Template import error: ${e.message}`, 'error');
      }
      return null;
    }
  }, [settings, addLog]);

  const removeTemplate = useCallback(async (id: string) => {
    await deleteTemplate(id);
    setTemplates(prev => prev.filter(t => t.id !== id));
    addLog(`Deleted template: ${id}`);
  }, [addLog]);

  const loadSettings = useCallback(async () => {
    const s = await getSetting('appSettings');
    setSettings(s || { draftsRootPath: '', username: '' });
  }, []);

  const saveSettings = useCallback(async (newSettings: AppSettings) => {
    await setSetting('appSettings', newSettings);
    setSettings(newSettings);
    addLog(`Saved settings: root=${newSettings.draftsRootPath}`);
  }, [addLog]);

  useEffect(() => {
    loadProjects();
    loadTemplates();
    loadSettings();
  }, [loadProjects, loadTemplates, loadSettings]);

  const value: StoreContextValue = {
    projects,
    currentProject,
    logs,
    storageInfo,
    loading,
    whisperModelProgress,
    loadProjects,
    createProject,
    openProject,
    closeProject,
    removeProject,
    skipTranscription,
    updateProject,
    updateSegments,
    retimeSegments,
    runPipeline,
    reconnectFolders,
    exportDraft,
    exportFallback,
    simulateTestExport,
    setClipAnimation,
    applyAnimation,
    applyAnimationSequence,
    clearClipAnimations,
    clearAllAnimations,
    toggleFavoriteAnimation,
    setTransition,
    applyTransition,
    clearAllTransitions,
    exportVideo,
    importTemplate,
    templates,
    loadTemplates,
    removeTemplate,
    settings,
    loadSettings,
    saveSettings,
    addLog,
    clearLogs,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

// ─── Video duration probing ───────────────────────────────────
function probeVideoDuration(file: File | Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      const dur = video.duration;
      URL.revokeObjectURL(url);
      resolve(dur || 0);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    video.src = url;
  });
}
