import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  ArrowLeft, Play, Pause, Download, RefreshCw, Loader2, CheckCircle2, AlertCircle,
  ChevronRight, FileVideo, FileImage, Clock, AlertTriangle, Settings, Terminal,
  RotateCw, FolderOpen, X, Plus, Upload, Check, AlertOctagon, Trash2, Sparkles, Film,
  Star, Shuffle
} from 'lucide-react';
import { useStore } from '../store';
import { Segment, Clip, CapCutTemplate, AnimCategory, ClipAnim, ClipTransition, VideoExportSettings, ResolutionPreset, AspectRatio, ImageFit } from '../types';
import { parseScriptFull, detectScriptMode, parseSegments, verifySegmentFill, segmentPreview, type SegmentVerification } from '../lib/matching';
import { ValidationReport } from '../lib/export';
import { buildPartOffsets } from '../lib/audio';
import { catalogFor, allTags, allAnims, animCategory, animName, computeTransform, isOverDuration, hasAnimation, getAnim, NONE_ID } from '../lib/animations';
import { drawFrame, renderTimelineFrame, RESOLUTIONS, frameDims, estimateExportBytes, formatBytes, type DrawSource, type TimelineRenderCtx } from '../lib/render';
import { transitionCatalog, transitionTags, transitionName, transitionDefaultDuration, TRANS_NONE_ID } from '../lib/transitions';

function fmtTime(s: number): string {
  if (!s || isNaN(s)) return '0:00.0';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

const SEGMENT_COLORS = [
  '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
];

function segColor(idx: number): string {
  return SEGMENT_COLORS[idx % SEGMENT_COLORS.length];
}

export function EditorScreen() {
  const store = useStore();
  const { currentProject: project } = store;
  const [activeTab, setActiveTab] = useState<'segments' | 'timeline' | 'animation' | 'preview' | 'export'>('segments');
  const [scriptText, setScriptText] = useState('');
  const [selectedClip, setSelectedClip] = useState<Clip | null>(null);

  if (!project) return null;

  const [parseMode, setParseMode] = useState<'number' | 'blank' | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [detectedCount, setDetectedCount] = useState<number | null>(null);

  // Live detection as user types
  useEffect(() => {
    if (!scriptText.trim()) { setParseMode(null); setDetectedCount(null); setParseWarnings([]); return; }
    const mode = detectScriptMode(scriptText);
    setParseMode(mode);
    if (mode === 'number') {
      const result = parseScriptFull(scriptText);
      setDetectedCount(result.segments.length);
      setParseWarnings(result.warnings);
    } else {
      const texts = parseSegments(scriptText);
      setDetectedCount(texts.length);
      setParseWarnings([]);
    }
  }, [scriptText]);

  const handleParseScript = () => {
    if (!scriptText.trim()) return;
    const result = parseScriptFull(scriptText);
    const segs: Segment[] = result.segments.map((s) => ({
      id: crypto.randomUUID(),
      index: s.index,
      text: s.text,
      startTime: 0,
      endTime: 0,
      confidence: 0,
      lowConfidence: false,
      matchedMedia: [],
      hasVideo: false,
      hasImages: false,
      hasMedia: false,
    }));
    store.updateSegments(segs);
    store.addLog(`Parsed ${segs.length} segments (${result.mode} split)`);
    for (const w of result.warnings) store.addLog(w, 'warn');
  };

  const addSegment = () => {
    const segs = [...project.segments, {
      id: crypto.randomUUID(),
      index: project.segments.length + 1,
      text: '',
      startTime: 0,
      endTime: 0,
      confidence: 0,
      lowConfidence: false,
      matchedMedia: [],
      hasVideo: false,
      hasImages: false,
      hasMedia: false,
    }];
    store.updateSegments(segs);
  };

  const updateSegmentText = (id: string, text: string) => {
    const segs = project.segments.map(s => s.id === id ? { ...s, text } : s);
    store.updateSegments(segs);
  };

  const updateSegmentTime = (id: string, field: 'startTime' | 'endTime', value: number) => {
    const segs = project.segments.map(s => s.id === id ? { ...s, [field]: value } : s);
    store.updateSegments(segs);
  };

  const removeSegment = (id: string) => {
    const segs = project.segments.filter(s => s.id !== id).map((s, i) => ({ ...s, index: i + 1 }));
    store.updateSegments(segs);
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white flex flex-col">
      <ExportOverlay />
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 bg-neutral-900">
        <div className="flex items-center gap-3">
          <button onClick={store.closeProject} className="text-neutral-400 hover:text-white transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h1 className="font-medium">{project.name}</h1>
          <span className="text-[11px] text-neutral-500 border border-neutral-700 rounded px-1.5 py-0.5">v{__APP_VERSION__}</span>
          {project.processed && (
            <span className="flex items-center gap-1 text-xs text-green-400 bg-green-950/50 px-2 py-0.5 rounded-full">
              <CheckCircle2 size={12} /> Ready
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {project.folders.mode === 'native' && (
            <button
              onClick={store.reconnectFolders}
              className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-white bg-neutral-800 hover:bg-neutral-700 rounded-lg px-3 py-1.5 transition-colors"
            >
              <FolderOpen size={14} /> Reconnect
            </button>
          )}
          <button
            onClick={() => store.runPipeline()}
            disabled={project.segments.length === 0}
            className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white rounded-lg px-4 py-1.5 font-medium transition-colors"
          >
            <Play size={14} /> Process
          </button>
        </div>
      </div>

      {/* Pipeline progress */}
      <PipelinePanel />

      {/* Tabs */}
      <div className="flex items-center gap-1 px-4 border-b border-neutral-800 bg-neutral-900 overflow-x-auto">
        {([
          { id: 'segments', label: 'Script', Icon: FileImage },
          { id: 'timeline', label: 'Timeline', Icon: Clock },
          { id: 'animation', label: 'Animation', Icon: Sparkles },
          { id: 'preview', label: 'Preview', Icon: Play },
          { id: 'export', label: 'Export', Icon: Download },
        ] as const).map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 whitespace-nowrap ${
              activeTab === id
                ? 'text-white border-purple-500'
                : 'text-neutral-400 border-transparent hover:text-neutral-200'
            }`}
          >
            <Icon size={14} className={activeTab === id ? 'text-purple-400' : ''} /> {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'segments' && (
          <SegmentsPanel
            scriptText={scriptText}
            setScriptText={setScriptText}
            onParse={handleParseScript}
            onAdd={addSegment}
            onUpdateText={updateSegmentText}
            onUpdateTime={updateSegmentTime}
            onRemove={removeSegment}
            parseMode={parseMode}
            detectedCount={detectedCount}
            parseWarnings={parseWarnings}
          />
        )}
        {activeTab === 'timeline' && (
          <TimelinePanel
            clips={project.clips}
            segments={project.segments}
            audioDuration={project.audioDuration}
            selectedClip={selectedClip}
            onSelectClip={setSelectedClip}
          />
        )}
        {activeTab === 'animation' && <AnimationPanel />}
        {activeTab === 'preview' && (
          <PreviewPanel clips={project.clips} audioDuration={project.audioDuration} />
        )}
        {activeTab === 'export' && <ExportPanel />}
      </div>

      {/* Log panel */}
      <LogPanel />
    </div>
  );
}

// ─── Pipeline Panel ───────────────────────────────────────────

function PipelinePanel() {
  const { currentProject: project, runPipeline, skipTranscription } = useStore();
  if (!project) return null;
  const steps = project.pipelineSteps;
  const hasActive = steps.some(s => s.status === 'running' || s.status === 'error');

  if (!hasActive && project.processed) return null;

  return (
    <div className="px-4 py-3 border-b border-neutral-800 bg-neutral-900/50">
      <div className="flex items-center gap-2 overflow-x-auto">
        {steps.map((step, i) => (
          <div key={step.key} className="flex items-center gap-2 shrink-0">
            {i > 0 && <ChevronRight size={14} className="text-neutral-600" />}
            <div className="flex items-center gap-2">
              {step.status === 'pending' && <div className="w-4 h-4 rounded-full border border-neutral-600" />}
              {step.status === 'running' && <Loader2 size={16} className="text-blue-400 animate-spin" />}
              {step.status === 'done' && <CheckCircle2 size={16} className="text-green-400" />}
              {step.status === 'error' && <AlertCircle size={16} className="text-red-400" />}
              <div className="flex flex-col">
                <span className={`text-xs font-medium ${
                  step.status === 'done' ? 'text-green-400' :
                  step.status === 'running' ? 'text-blue-400' :
                  step.status === 'error' ? 'text-red-400' : 'text-neutral-500'
                }`}>
                  {step.label}
                </span>
                {step.message && (
                  <span className="text-[10px] text-neutral-500">{step.message}</span>
                )}
              </div>
              {step.status === 'running' && step.progress > 0 && (
                <span className="text-[10px] text-neutral-400">{Math.round(step.progress)}%</span>
              )}
            </div>
            {step.status === 'error' && (
              <button
                onClick={() => runPipeline()}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 ml-1"
              >
                <RotateCw size={12} /> Retry
              </button>
            )}
            {step.key === 'transcribe' && step.status === 'running' && (
              <button
                onClick={() => skipTranscription()}
                title="Stop transcribing and space the script evenly across the audio instead"
                className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 border border-amber-500/40 rounded px-2 py-0.5 ml-1 whitespace-nowrap"
              >
                Skip transcription
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Segments Panel ───────────────────────────────────────────

interface SegmentsPanelProps {
  scriptText: string;
  setScriptText: (s: string) => void;
  onParse: () => void;
  onAdd: () => void;
  onUpdateText: (id: string, text: string) => void;
  onUpdateTime: (id: string, field: 'startTime' | 'endTime', value: number) => void;
  onRemove: (id: string) => void;
  parseMode: 'number' | 'blank' | null;
  detectedCount: number | null;
  parseWarnings: string[];
}

function SegmentsPanel(props: SegmentsPanelProps) {
  const { currentProject: project, retimeSegments } = useStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shiftSecs, setShiftSecs] = useState(6);
  if (!project) return null;

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Move every selected image earlier by `shiftSecs`. Non-selected images that
  // are in the way shrink to make room; the timeline stays gap-free (each image
  // ends exactly where the next begins), first at 0 and last at the audio end.
  const applyTimingFix = async () => {
    if (selected.size === 0) return;
    const dur = project.audioDuration || 0;
    const minDur = 0.2;
    const ordered = [...project.segments].sort((a, b) => a.index - b.index);
    const desired = ordered.map((s) =>
      selected.has(s.id) ? Math.max(0, s.startTime - shiftSecs) : s.startTime,
    );
    const starts: number[] = [];
    for (let i = 0; i < ordered.length; i++) {
      let st = desired[i];
      if (i > 0) st = Math.max(st, starts[i - 1] + minDur);
      if (dur > 0) st = Math.min(st, dur - minDur);
      starts.push(st);
    }
    if (starts.length) starts[0] = 0;
    const retimed = ordered.map((seg, i) => ({
      ...seg,
      startTime: starts[i],
      endTime: i < ordered.length - 1 ? starts[i + 1] : (dur || starts[i] + minDur),
    }));
    await retimeSegments(retimed);
  };

  return (
    <div className="p-4 space-y-4">
      {/* Script input */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-neutral-300">Script Input</h3>
          <button
            onClick={props.onParse}
            className="text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-3 py-1 font-medium transition-colors"
          >
            Parse
          </button>
        </div>
        <textarea
          value={props.scriptText}
          onChange={(e) => props.setScriptText(e.target.value)}
          placeholder={`Paste your script here.\n\nTwo modes (auto-detected):\n\n1. Numbered segments:\n1\nFirst paragraph text...\n2\nSecond paragraph text...\n\n2. Blank-line split:\nFirst paragraph.\n\nSecond paragraph.`}
          className="w-full h-32 bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500 resize-y"
        />
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          {props.parseMode && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${props.parseMode === 'number' ? 'bg-blue-950/50 text-blue-300' : 'bg-neutral-800 text-neutral-400'}`}>
              Mode: {props.parseMode === 'number' ? 'Number-split' : 'Blank-line'}
            </span>
          )}
          {props.detectedCount !== null && props.detectedCount > 0 && (
            <span className="text-xs text-neutral-400">
              {props.detectedCount} segments detected (numbered 1 to {props.detectedCount})
            </span>
          )}
          {props.parseWarnings.map((w, i) => (
            <span key={i} className="text-xs text-yellow-400 flex items-center gap-1">
              <AlertTriangle size={10} /> {w}
            </span>
          ))}
        </div>
        {props.parseMode === 'number' && props.detectedCount && props.detectedCount > 0 && (() => {
          const result = parseScriptFull(props.scriptText);
          return (
            <div className="mt-2 bg-neutral-800/50 rounded-lg p-2 max-h-40 overflow-y-auto">
              <pre className="text-xs text-neutral-400 whitespace-pre-wrap font-mono">{segmentPreview(result.segments)}</pre>
            </div>
          );
        })()}
      </div>

      {/* Per-image timing fix */}
      {project.segments.length > 0 && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-2">
          <h3 className="text-sm font-medium text-neutral-300 flex items-center gap-2">
            <Clock size={14} /> Fix late images
          </h3>
          <p className="text-xs text-neutral-500">
            Tick the images that appear late, set how many seconds late they are, then click the button.
            Selected images move earlier by that many seconds; images in the way adjust automatically.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-neutral-400">{selected.size} selected</span>
            <button
              onClick={() => setSelected(new Set(project.segments.map((s) => s.id)))}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              Select all
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-neutral-400 hover:text-neutral-200"
            >
              Clear
            </button>
            <div className="flex items-center gap-1 ml-2">
              <span className="text-xs text-neutral-400">Late by</span>
              <input
                type="number"
                step="0.5"
                value={shiftSecs}
                onChange={(e) => setShiftSecs(parseFloat(e.target.value) || 0)}
                className="w-16 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-neutral-400">sec</span>
            </div>
            <button
              onClick={applyTimingFix}
              disabled={selected.size === 0}
              className="text-xs bg-amber-600 hover:bg-amber-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white rounded-lg px-3 py-1.5 font-medium transition-colors"
            >
              Move selected earlier by {shiftSecs}s
            </button>
          </div>
        </div>
      )}

      {/* Segment list */}
      <div className="space-y-3">
        {project.segments.map((seg) => (
          <div
            key={seg.id}
            className={`bg-neutral-900 border rounded-xl p-4 ${selected.has(seg.id) ? 'border-amber-500' : 'border-neutral-800'}`}
            style={{ borderLeftColor: segColor(seg.index - 1), borderLeftWidth: 3 }}
          >
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={selected.has(seg.id)}
                onChange={() => toggleSelected(seg.id)}
                title="Select this image to fix its timing"
                className="mt-1.5 w-4 h-4 accent-amber-500 shrink-0 cursor-pointer"
              />
              <div
                className="flex items-center justify-center w-7 h-7 rounded-lg text-xs font-bold shrink-0"
                style={{ backgroundColor: segColor(seg.index - 1) + '30', color: segColor(seg.index - 1) }}
              >
                {seg.index}
              </div>
              <div className="flex-1 min-w-0">
                <textarea
                  value={seg.text}
                  onChange={(e) => props.onUpdateText(seg.id, e.target.value)}
                  className="w-full bg-transparent text-sm text-neutral-200 resize-none focus:outline-none border-none"
                  rows={2}
                  placeholder="Segment text..."
                />
                <div className="flex items-center gap-3 mt-2 flex-wrap">
                  <div className="flex items-center gap-1">
                    <Clock size={12} className="text-neutral-500" />
                    <input
                      type="number"
                      step="0.1"
                      value={seg.startTime.toFixed(1)}
                      onChange={(e) => props.onUpdateTime(seg.id, 'startTime', parseFloat(e.target.value) || 0)}
                      className="w-16 bg-neutral-800 border border-neutral-700 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                    <span className="text-neutral-500 text-xs">→</span>
                    <input
                      type="number"
                      step="0.1"
                      value={seg.endTime.toFixed(1)}
                      onChange={(e) => props.onUpdateTime(seg.id, 'endTime', parseFloat(e.target.value) || 0)}
                      className="w-16 bg-neutral-800 border border-neutral-700 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  {seg.matchedMedia.length > 0 && (
                    <span className="text-xs text-neutral-400">
                      {seg.matchedMedia.length} media: {seg.matchedMedia.map(m => m.kind).join(', ')}
                    </span>
                  )}
                  {seg.lowConfidence && (
                    <span className="flex items-center gap-1 text-xs text-yellow-500 bg-yellow-950/30 px-2 py-0.5 rounded">
                      <AlertTriangle size={10} /> Low confidence
                    </span>
                  )}
                  {!seg.hasMedia && project.processed && (
                    <span className="flex items-center gap-1 text-xs text-red-400 bg-red-950/30 px-2 py-0.5 rounded">
                      <AlertTriangle size={10} /> Missing media
                    </span>
                  )}
                  <button
                    onClick={() => props.onRemove(seg.id)}
                    className="text-neutral-500 hover:text-red-400 transition-colors ml-auto"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
        <button
          onClick={props.onAdd}
          className="w-full flex items-center justify-center gap-2 border border-dashed border-neutral-700 hover:border-neutral-500 rounded-xl py-3 text-sm text-neutral-400 hover:text-neutral-300 transition-colors"
        >
          <Plus size={16} /> Add Segment
        </button>
      </div>
    </div>
  );
}

// ─── Shared media-URL resolver ────────────────────────────────

async function resolveMediaBlob(project: any, media: { id: string; kind: string; blobId?: string; handlePath?: string }): Promise<Blob | null> {
  if (media.blobId) {
    const { getBlob } = await import('../lib/db');
    return (await getBlob(media.blobId)) || null;
  }
  if (project?.folders?.mode === 'native' && media.handlePath) {
    const { verifyPermission } = await import('../lib/fs');
    const { getHandle } = await import('../lib/db');
    const folderId = media.kind === 'video' ? project.folders.videosHandleId : project.folders.imagesHandleId;
    if (folderId) {
      const dirHandle = await getHandle(folderId) as FileSystemDirectoryHandle | undefined;
      if (dirHandle && await verifyPermission(dirHandle)) {
        const fileHandle = await dirHandle.getFileHandle(media.handlePath);
        return fileHandle.getFile();
      }
    }
  }
  return null;
}

/** Lazily resolves object URLs for a set of image clips (for thumbnails/preview). */
function useImageUrls(project: any, clips: Clip[]): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const created = useRef<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map = new Map<string, string>();
      const seen = new Set<string>();
      for (const clip of clips) {
        if (!clip.isImage || seen.has(clip.media.id)) continue;
        seen.add(clip.media.id);
        const blob = await resolveMediaBlob(project, clip.media);
        if (blob) {
          const url = URL.createObjectURL(blob);
          created.current.push(url);
          map.set(clip.media.id, url);
        }
      }
      if (!cancelled) setUrls(map);
    })();
    return () => {
      cancelled = true;
      created.current.forEach((u) => URL.revokeObjectURL(u));
      created.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, clips.length]);
  return urls;
}

// A tiny looping canvas that demos one animation on a source image (or gradient).
function AnimPreviewCanvas({ animId, imgUrl, size = 72, loopSec = 2.2 }: { animId: string; imgUrl?: string; size?: number; loopSec?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number>(0);
  const [hover, setHover] = useState(false);

  // Draw one frame at progress t (0..1 over the loop). Only the hovered tile
  // runs a rAF loop — the rest hold a single static frame, so a grid of dozens
  // of previews stays light on CPU/RAM (important on low-end PCs).
  const drawAt = useCallback((t: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const cat = getAnim(animId)?.category;
    const cfg = cat === 'combo'
      ? { combo: { animId, duration: loopSec, fullDuration: true } }
      : cat === 'out'
        ? { out: { animId, duration: loopSec, fullDuration: false } }
        : { in: { animId, duration: loopSec * 0.6, fullDuration: false } };
    const transform = computeTransform(cfg as any, t * loopSec, loopSec);
    let src: any = imgRef.current;
    if (!src) {
      const g = ctx.createLinearGradient(0, 0, size, size);
      g.addColorStop(0, '#3b3f6b'); g.addColorStop(1, '#7c3aed');
      const tmp = document.createElement('canvas'); tmp.width = size; tmp.height = size;
      const tctx = tmp.getContext('2d')!; tctx.fillStyle = g; tctx.fillRect(0, 0, size, size);
      tctx.fillStyle = 'rgba(255,255,255,0.9)'; tctx.font = `${size * 0.5}px sans-serif`;
      tctx.textAlign = 'center'; tctx.textBaseline = 'middle'; tctx.fillText('▧', size / 2, size / 2);
      src = tmp;
    }
    drawFrame(ctx, src, transform, size, size);
  }, [animId, size, loopSec]);

  useEffect(() => {
    if (!hover) { drawAt(getAnim(animId)?.category === 'out' ? 0 : 1); return; } // static rest frame
    startRef.current = performance.now();
    const draw = () => {
      const t = (((performance.now() - startRef.current) / 1000) % loopSec) / loopSec;
      drawAt(t);
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [hover, drawAt, animId, loopSec]);

  // Repaint the static frame once the image finishes loading.
  useEffect(() => {
    if (!imgUrl) { drawAt(getAnim(animId)?.category === 'out' ? 0 : 1); return; }
    const img = new Image();
    img.onload = () => { imgRef.current = img; if (!hover) drawAt(getAnim(animId)?.category === 'out' ? 0 : 1); };
    img.src = imgUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgUrl]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className="rounded-md bg-black w-full h-full object-cover"
    />
  );
}

// ─── Timeline Panel ───────────────────────────────────────────

interface TimelinePanelProps {
  clips: Clip[];
  segments: Segment[];
  audioDuration: number;
  selectedClip: Clip | null;
  onSelectClip: (c: Clip | null) => void;
}

function TimelinePanel({ clips, segments, audioDuration, selectedClip, onSelectClip }: TimelinePanelProps) {
  const totalDuration = audioDuration || clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
  if (totalDuration === 0) {
    return <div className="p-8 text-center text-neutral-500">Run the pipeline to see the timeline.</div>;
  }

  return (
    <div className="p-4 space-y-4">
      {/* Timeline track */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
        <h3 className="text-sm font-medium text-neutral-300 mb-3">Timeline</h3>
        {/* Time ruler */}
        <div className="relative h-5 mb-1">
          <div className="absolute inset-0 flex justify-between text-[10px] text-neutral-500">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i}>{fmtTime((totalDuration / 5) * i)}</span>
            ))}
          </div>
        </div>
        {/* Video/image track */}
        <div className="relative h-16 bg-neutral-800/50 rounded-lg overflow-hidden">
          {clips.map((clip) => {
            const left = (clip.start / totalDuration) * 100;
            const width = (clip.duration / totalDuration) * 100;
            const color = segColor(clip.segmentIndex - 1);
            return (
              <div
                key={clip.id}
                onClick={() => onSelectClip(clip)}
                className="absolute top-0 bottom-0 border-r border-neutral-900/50 cursor-pointer hover:brightness-125 transition-all flex items-center justify-center overflow-hidden"
                style={{
                  left: `${left}%`,
                  width: `${width}%`,
                  backgroundColor: color + '40',
                  borderTop: `2px solid ${color}`,
                }}
              >
                <div className="flex flex-col items-center px-1 min-w-0">
                  {clip.isImage ? <FileImage size={12} className="text-neutral-300 shrink-0" /> : <FileVideo size={12} className="text-neutral-300 shrink-0" />}
                  <span className="text-[9px] text-neutral-300 truncate">{clip.media.name}</span>
                </div>
              </div>
            );
          })}
        </div>
        {/* Audio track */}
        <div className="relative h-8 bg-neutral-800/30 rounded-lg mt-1 flex items-center px-3">
          <div className="text-xs text-neutral-400">Audio Track (Voiceover)</div>
          <div className="flex-1 mx-3 h-2 bg-neutral-700 rounded-full" />
          <span className="text-xs text-neutral-400">{fmtTime(totalDuration)}</span>
        </div>
        {/* Segment markers */}
        <div className="relative h-4 mt-1">
          {segments.map((seg) => (
            <div
              key={seg.id}
              className="absolute top-0 bottom-0 w-0.5"
              style={{ left: `${(seg.startTime / totalDuration) * 100}%`, backgroundColor: segColor(seg.index - 1) }}
            >
              <span className="text-[8px] text-neutral-400 absolute -left-2 top-0">{seg.index}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Clip details */}
      {selectedClip && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <h3 className="text-sm font-medium text-neutral-300 mb-3">Clip Details</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-neutral-500">File:</span> {selectedClip.media.name}</div>
            <div><span className="text-neutral-500">Type:</span> {selectedClip.isImage ? 'Image' : 'Video'}</div>
            <div><span className="text-neutral-500">Start:</span> {fmtTime(selectedClip.start)}</div>
            <div><span className="text-neutral-500">Duration:</span> {fmtTime(selectedClip.duration)}</div>
            <div><span className="text-neutral-500">Segment:</span> {selectedClip.segmentIndex}</div>
            {selectedClip.coveringMissing && <div className="text-yellow-500">Covers missing media</div>}
          </div>
        </div>
      )}

      {/* Segment summary */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
        <h3 className="text-sm font-medium text-neutral-300 mb-3">Segments</h3>
        <div className="space-y-1">
          {segments.map((seg) => (
            <div key={seg.id} className="flex items-center gap-2 text-xs">
              <span className="w-6 font-mono" style={{ color: segColor(seg.index - 1) }}>{seg.index}</span>
              <span className="text-neutral-400">{fmtTime(seg.startTime)} → {fmtTime(seg.endTime)}</span>
              <span className="text-neutral-500 truncate flex-1">{seg.text.slice(0, 60)}...</span>
              {seg.matchedMedia.length > 0 && <span className="text-neutral-400">{seg.matchedMedia.length} files</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Verification table */}
      {clips.length > 0 && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <h3 className="text-sm font-medium text-neutral-300 mb-3">Alignment Verification</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-neutral-500 border-b border-neutral-800">
                  <th className="text-left py-1.5 px-2">Seg #</th>
                  <th className="text-left py-1.5 px-2">Audio Start</th>
                  <th className="text-left py-1.5 px-2">Audio End</th>
                  <th className="text-left py-1.5 px-2">Spoken Dur</th>
                  <th className="text-left py-1.5 px-2">Images Dur</th>
                  <th className="text-left py-1.5 px-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((seg) => {
                  const v = verifySegmentFill(seg, clips);
                  const spokenDur = seg.endTime - seg.startTime;
                  const imagesDur = v.durationMicro / 1_000_000;
                  const match = Math.abs(imagesDur - spokenDur) < 0.01;
                  const isLowConf = seg.lowConfidence;
                  return (
                    <tr key={seg.id} className="border-b border-neutral-800/50">
                      <td className="py-1.5 px-2 font-mono" style={{ color: segColor(seg.index - 1) }}>{seg.index}</td>
                      <td className="py-1.5 px-2 text-neutral-400 font-mono">{fmtTime(seg.startTime)}</td>
                      <td className="py-1.5 px-2 text-neutral-400 font-mono">{fmtTime(seg.endTime)}</td>
                      <td className="py-1.5 px-2 text-neutral-400 font-mono">{spokenDur.toFixed(2)}s</td>
                      <td className="py-1.5 px-2 text-neutral-400 font-mono">{imagesDur.toFixed(2)}s</td>
                      <td className="py-1.5 px-2">
                        {match ? (
                          <span className={`px-2 py-0.5 rounded text-xs ${isLowConf ? 'bg-yellow-950/50 text-yellow-400' : 'bg-green-950/50 text-green-400'}`}>
                            {isLowConf ? 'MATCH (low conf)' : 'MATCH'}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-xs bg-red-950/50 text-red-400">
                            MISMATCH ({(imagesDur - spokenDur).toFixed(2)}s)
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Animation Panel ──────────────────────────────────────────

function AnimationPanel() {
  const store = useStore();
  const { currentProject: project, settings } = store;

  const [mode, setMode] = useState<'animate' | 'transition'>('animate');
  const [category, setCategory] = useState<AnimCategory>('combo');
  const [tag, setTag] = useState('All');
  const [showFavorites, setShowFavorites] = useState(false);
  const [selectedAnimId, setSelectedAnimId] = useState<string>('');
  const [duration, setDuration] = useState(0.7);
  const [fullDuration, setFullDuration] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selectedMedia, setSelectedMedia] = useState<Set<string>>(new Set());
  const [sequence, setSequence] = useState<{ slot: AnimCategory; anim: ClipAnim }[]>([]);
  // Transitions
  const [transId, setTransId] = useState<string>('');
  const [transTag, setTransTag] = useState('All');
  const [transDuration, setTransDuration] = useState(0.5);

  const favorites = new Set(settings?.favoriteAnimations || []);

  // Unique image clips in timeline order.
  const imageClips = useMemo(() => {
    if (!project) return [];
    const seen = new Set<string>();
    return project.clips.filter((c) => {
      if (!c.isImage || seen.has(c.media.id)) return false;
      seen.add(c.media.id);
      return true;
    });
  }, [project?.clips]);

  const imageUrls = useImageUrls(project, imageClips);
  const firstImgUrl = imageClips.length ? imageUrls.get(imageClips[0].media.id) : undefined;

  if (!project) return null;

  if (!project.processed || imageClips.length === 0) {
    return (
      <div className="p-8 text-center text-neutral-500">
        <Sparkles size={28} className="mx-auto mb-2 text-neutral-600" />
        Run <strong className="text-neutral-300">Process</strong> first. Once your images are matched to the audio,
        come back here to add animations.
      </div>
    );
  }

  const isCombo = category === 'combo';
  const catalog = (showFavorites ? allAnims().filter((a) => favorites.has(a.id)) : catalogFor(category))
    .filter((a) => showFavorites || tag === 'All' || a.tags.includes(tag));
  const tags = allTags(category);

  const currentAnim: ClipAnim | null = selectedAnimId
    ? { animId: selectedAnimId, duration, fullDuration, speed }
    : null;

  const pickAnim = (id: string) => {
    setSelectedAnimId(id);
    const def = getAnim(id);
    if (def && def.defaultDuration > 0) setDuration(def.defaultDuration);
    else if (def && def.defaultDuration === 0) setDuration(2);
    setSpeed(settings?.animationSpeeds?.[id] ?? 1);
  };
  const changeSpeed = (v: number) => {
    const s = Math.max(0.25, Math.min(3, Math.round(v * 100) / 100));
    setSpeed(s);
    if (selectedAnimId) store.setAnimationSpeed(selectedAnimId, s);
  };
  const slotOf = (id: string): AnimCategory => animCategory(id) || category;

  const applyAll = () => { if (currentAnim) store.applyAnimation(slotOf(selectedAnimId), currentAnim); };
  const applySelected = () => {
    if (currentAnim && selectedMedia.size > 0) store.applyAnimation(slotOf(selectedAnimId), currentAnim, Array.from(selectedMedia));
  };
  const randomAll = () => store.applyRandomAnimation(category, { duration, fullDuration });
  const randomSelected = () => { if (selectedMedia.size > 0) store.applyRandomAnimation(category, { duration, fullDuration }, Array.from(selectedMedia)); };
  const addToSequence = () => { if (currentAnim) setSequence((s) => [...s, { slot: slotOf(selectedAnimId), anim: currentAnim }]); };
  const applySequence = (toSelected: boolean) => {
    if (sequence.length === 0) return;
    store.applyAnimationSequence(sequence, toSelected ? Array.from(selectedMedia) : undefined);
  };

  const currentTrans: ClipTransition | null = transId && transId !== TRANS_NONE_ID ? { transId, duration: transDuration } : null;
  const applyTransAll = () => { if (currentTrans) store.applyTransition(currentTrans); };
  const applyTransSelected = () => { if (currentTrans && selectedMedia.size > 0) store.applyTransition(currentTrans, Array.from(selectedMedia)); };

  const toggleSelect = (id: string) => {
    setSelectedMedia((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };

  const animatedCount = imageClips.filter((c) => hasAnimation(project.clipAnimations?.[c.media.id])).length;
  const transCount = imageClips.filter((c) => project.transitions?.[c.media.id]?.transId && project.transitions[c.media.id].transId !== TRANS_NONE_ID).length;
  const transCatalog = transitionCatalog().filter((t) => transTag === 'All' || t.tags.includes(transTag));

  return (
    <div className="p-4 space-y-4">
      {/* Mode toggle */}
      <div className="flex gap-1 bg-neutral-900 border border-neutral-800 rounded-xl p-1 w-fit">
        {(['animate', 'transition'] as const).map((m) => (
          <button
            key={m}
            onClick={() => { setMode(m); setSelectedMedia(new Set()); }}
            className={`px-5 py-1.5 text-sm font-medium rounded-lg transition-colors ${mode === m ? 'bg-purple-600 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}
          >
            {m === 'animate' ? 'Animations' : 'Transitions'}
          </button>
        ))}
      </div>

      {mode === 'animate' ? (<>
        {/* Intro */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-200 flex items-center gap-2">
              <Sparkles size={16} className="text-purple-400" /> Animations
            </h3>
            <div className="flex items-center gap-3">
              <span className="text-xs text-neutral-500">{animatedCount}/{imageClips.length} images animated</span>
              {animatedCount > 0 && (
                <button onClick={() => store.clearAllAnimations()} className="text-xs text-red-400 hover:text-red-300">Clear all</button>
              )}
            </div>
          </div>
          <p className="text-xs text-neutral-500 mt-1">
            Built-in, professional animations — no CapCut needed. Star ⭐ favorites, set a duration (combos too),
            then apply to all images or the ones you select. Or build a <strong>sequence</strong> to spread different
            animations across your images in order.
          </p>
        </div>

        {/* Category tabs + favorites */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 bg-neutral-900 border border-neutral-800 rounded-xl p-1 w-fit">
            <button
              onClick={() => setShowFavorites((v) => !v)}
              title="Favorites"
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${showFavorites ? 'bg-yellow-500/20 text-yellow-300' : 'text-neutral-400 hover:text-neutral-200'}`}
            >
              <Star size={14} className={showFavorites ? 'fill-yellow-400 text-yellow-400' : ''} />
            </button>
            {(['in', 'out', 'combo'] as const).map((c) => (
              <button
                key={c}
                onClick={() => { setCategory(c); setShowFavorites(false); setSelectedAnimId(''); }}
                className={`px-5 py-1.5 text-sm font-medium rounded-lg capitalize transition-colors ${!showFavorites && category === c ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* Tag filters */}
        {!showFavorites && (
          <div className="flex gap-2 flex-wrap">
            {tags.map((t) => (
              <button key={t} onClick={() => setTag(t)} className={`px-3 py-1 text-xs rounded-full border transition-colors ${tag === t ? 'bg-purple-600/30 border-purple-500 text-purple-200' : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}>{t}</button>
            ))}
          </div>
        )}

        {/* Animation grid */}
        {catalog.length === 0 ? (
          <div className="text-xs text-neutral-500 py-6 text-center">
            {showFavorites ? 'No favorites yet — tap the ⭐ on any animation to add it here.' : 'No animations in this filter.'}
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
            {catalog.map((a) => (
              <div
                key={a.id}
                className={`group relative rounded-lg overflow-hidden border transition-all cursor-pointer ${selectedAnimId === a.id ? 'border-purple-500 ring-2 ring-purple-500/40' : 'border-neutral-800 hover:border-neutral-600'}`}
                onClick={() => pickAnim(a.id)}
              >
                <div className="aspect-square bg-black">
                  <AnimPreviewCanvas animId={a.id} imgUrl={firstImgUrl} size={96} />
                </div>
                <div className="px-1 py-1 text-[10px] text-neutral-300 truncate text-center bg-neutral-900">{a.name}</div>
                <button
                  onClick={(e) => { e.stopPropagation(); store.toggleFavoriteAnimation(a.id); }}
                  title="Favorite"
                  className="absolute top-1 left-1 bg-black/60 rounded-full p-0.5 hover:bg-black/80"
                >
                  <Star size={11} className={favorites.has(a.id) ? 'fill-yellow-400 text-yellow-400' : 'text-neutral-300'} />
                </button>
                {selectedAnimId === a.id && (
                  <div className="absolute top-1 right-1 bg-purple-500 rounded-full p-0.5"><Check size={10} className="text-white" /></div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Duration + apply controls */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400">Selected:</span>
              <span className="text-sm text-white font-medium">{selectedAnimId ? animName(selectedAnimId) : 'None'}</span>
            </div>
            <label className={`flex items-center gap-2 ${fullDuration ? 'opacity-50' : ''}`}>
              <span className="text-xs text-neutral-400">Duration</span>
              <input
                type="number" step="0.1" min="0.1"
                value={duration}
                disabled={fullDuration}
                onChange={(e) => setDuration(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
                className="w-20 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-purple-500 disabled:opacity-50"
              />
              <span className="text-xs text-neutral-500">sec</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={fullDuration} onChange={(e) => setFullDuration(e.target.checked)} className="w-4 h-4 accent-purple-500" />
              <span className="text-xs text-neutral-400">Full image duration</span>
            </label>
            {/* Speed */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400">Speed</span>
              <input
                type="range" min="0.25" max="3" step="0.05" value={speed}
                onChange={(e) => changeSpeed(parseFloat(e.target.value))}
                className="w-28 accent-purple-500"
              />
              <span className="text-xs text-white font-mono w-9 text-right">{speed.toFixed(2)}×</span>
              <button onClick={() => changeSpeed(1)} title="Reset speed" className="text-[11px] text-neutral-400 hover:text-neutral-200 border border-neutral-700 rounded px-1.5 py-0.5">reset</button>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={applyAll} disabled={!currentAnim} className="text-xs bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white rounded-lg px-4 py-2 font-medium transition-colors">Apply to all images</button>
            <button onClick={applySelected} disabled={!currentAnim || selectedMedia.size === 0} className="text-xs bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-800 disabled:text-neutral-600 text-white rounded-lg px-4 py-2 font-medium transition-colors border border-neutral-600">Apply to {selectedMedia.size} selected</button>
            <button onClick={addToSequence} disabled={!currentAnim} className="text-xs bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-800 disabled:text-neutral-600 text-white rounded-lg px-3 py-2 font-medium transition-colors border border-neutral-600">+ Add to sequence</button>
            <span className="mx-1 h-4 w-px bg-neutral-700" />
            <button onClick={randomAll} title="Give every image a random animation from this tab" className="text-xs bg-fuchsia-700/70 hover:bg-fuchsia-600 text-white rounded-lg px-3 py-2 font-medium transition-colors">🎲 Randomize all</button>
            <button onClick={randomSelected} disabled={selectedMedia.size === 0} className="text-xs bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-800 disabled:text-neutral-600 text-white rounded-lg px-3 py-2 font-medium transition-colors border border-neutral-600">🎲 Random → {selectedMedia.size} selected</button>
            <span className="mx-1 h-4 w-px bg-neutral-700" />
            <button onClick={() => setSelectedMedia(new Set(imageClips.map((c) => c.media.id)))} className="text-xs text-blue-400 hover:text-blue-300">Select all ({imageClips.length})</button>
            <button onClick={() => setSelectedMedia(new Set())} className="text-xs text-neutral-400 hover:text-neutral-200">Clear selection</button>
          </div>

          {/* Sequence builder */}
          {sequence.length > 0 && (
            <div className="border-t border-neutral-800 pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-neutral-400">Sequence ({sequence.length}) — cycles across images in order</span>
                <button onClick={() => setSequence([])} className="text-xs text-red-400 hover:text-red-300">Clear sequence</button>
              </div>
              <div className="flex gap-2 flex-wrap">
                {sequence.map((it, i) => (
                  <span key={i} className="flex items-center gap-1 text-[11px] bg-purple-600/20 text-purple-200 rounded px-2 py-1">
                    {i + 1}. {animName(it.anim.animId)}
                    <button onClick={() => setSequence((s) => s.filter((_, j) => j !== i))} className="text-purple-300 hover:text-white"><X size={10} /></button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <button onClick={() => applySequence(false)} className="text-xs bg-purple-600 hover:bg-purple-500 text-white rounded-lg px-3 py-1.5 font-medium">Apply sequence to all</button>
                <button onClick={() => applySequence(true)} disabled={selectedMedia.size === 0} className="text-xs bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-800 disabled:text-neutral-600 text-white rounded-lg px-3 py-1.5 font-medium border border-neutral-600">Apply to {selectedMedia.size} selected</button>
              </div>
            </div>
          )}
        </div>

        {/* Per-image list */}
        <ImageClipGrid imageClips={imageClips} imageUrls={imageUrls} project={project} selectedMedia={selectedMedia} toggleSelect={toggleSelect} onClear={(id) => store.clearClipAnimations(id)} showAnim onAdjustSpeed={(id, f) => store.adjustClipSpeed(id, f)} onResetSpeed={(id) => store.resetClipSpeed(id)} />
      </>) : (<>
        {/* Transitions */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-200 flex items-center gap-2"><Shuffle size={16} className="text-purple-400" /> Transitions</h3>
            <div className="flex items-center gap-3">
              <span className="text-xs text-neutral-500">{transCount}/{Math.max(0, imageClips.length - 1)} joins</span>
              {transCount > 0 && <button onClick={() => store.clearAllTransitions()} className="text-xs text-red-400 hover:text-red-300">Clear all</button>}
            </div>
          </div>
          <p className="text-xs text-neutral-500 mt-1">A transition blends into an image from the one before it. The first image has no transition.</p>
        </div>

        <div className="flex gap-2 flex-wrap">
          {transitionTags().map((t) => (
            <button key={t} onClick={() => setTransTag(t)} className={`px-3 py-1 text-xs rounded-full border transition-colors ${transTag === t ? 'bg-purple-600/30 border-purple-500 text-purple-200' : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-neutral-200'}`}>{t}</button>
          ))}
        </div>

        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {transCatalog.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTransId(t.id); setTransDuration(settings?.transitionDurations?.[t.id] ?? transitionDefaultDuration(t.id)); }}
              className={`relative rounded-lg border p-3 h-20 flex items-center justify-center text-center transition-all ${transId === t.id ? 'border-purple-500 ring-2 ring-purple-500/40 bg-purple-600/10' : 'border-neutral-800 hover:border-neutral-600 bg-neutral-900'}`}
            >
              <span className="text-xs text-neutral-200">{t.name}</span>
              {transId === t.id && <div className="absolute top-1 right-1 bg-purple-500 rounded-full p-0.5"><Check size={10} className="text-white" /></div>}
            </button>
          ))}
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2"><span className="text-xs text-neutral-400">Selected:</span><span className="text-sm text-white font-medium">{transitionName(transId)}</span></div>
            <label className="flex items-center gap-2"><span className="text-xs text-neutral-400">Duration</span>
              <input type="number" step="0.1" min="0.1" value={transDuration} onChange={(e) => { const v = Math.max(0.1, parseFloat(e.target.value) || 0.1); setTransDuration(v); if (transId) store.setTransitionDuration(transId, v); }} className="w-20 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-purple-500" />
              <span className="text-xs text-neutral-500">sec</span>
            </label>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={applyTransAll} disabled={!currentTrans} className="text-xs bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white rounded-lg px-4 py-2 font-medium transition-colors">Apply to all joins</button>
            <button onClick={applyTransSelected} disabled={!currentTrans || selectedMedia.size === 0} className="text-xs bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-800 disabled:text-neutral-600 text-white rounded-lg px-4 py-2 font-medium transition-colors border border-neutral-600">Apply to {selectedMedia.size} selected</button>
            <button onClick={() => setSelectedMedia(new Set(imageClips.slice(1).map((c) => c.media.id)))} className="text-xs text-blue-400 hover:text-blue-300">Select all</button>
            <button onClick={() => setSelectedMedia(new Set())} className="text-xs text-neutral-400 hover:text-neutral-200">Clear</button>
          </div>
        </div>

        <ImageClipGrid imageClips={imageClips} imageUrls={imageUrls} project={project} selectedMedia={selectedMedia} toggleSelect={toggleSelect} onClear={(id) => store.setTransition(id, null)} showTrans />
      </>)}
    </div>
  );
}

// Grid of image clips with their assigned animation/transition badges.
function ImageClipGrid({ imageClips, imageUrls, project, selectedMedia, toggleSelect, onClear, showAnim, showTrans, onAdjustSpeed, onResetSpeed }: {
  imageClips: Clip[]; imageUrls: Map<string, string>; project: any; selectedMedia: Set<string>;
  toggleSelect: (id: string) => void; onClear: (id: string) => void; showAnim?: boolean; showTrans?: boolean;
  onAdjustSpeed?: (id: string, factor: number) => void; onResetSpeed?: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-neutral-300">Images ({imageClips.length})</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {imageClips.map((clip) => {
          const cfg = project.clipAnimations?.[clip.media.id];
          const trans = project.transitions?.[clip.media.id];
          const over = showAnim && isOverDuration(cfg, clip.duration);
          const isSel = selectedMedia.has(clip.media.id);
          const url = imageUrls.get(clip.media.id);
          const hasTrans = trans && trans.transId && trans.transId !== TRANS_NONE_ID;
          return (
            <div key={clip.media.id} className={`rounded-lg overflow-hidden border transition-all ${over ? 'border-red-500 ring-2 ring-red-500/40' : isSel ? 'border-purple-500' : 'border-neutral-800'}`}>
              <button onClick={() => toggleSelect(clip.media.id)} className="block w-full relative aspect-video bg-black">
                {url ? <img src={url} className="w-full h-full object-cover" alt="" /> : <div className="w-full h-full bg-neutral-800" />}
                <span className="absolute top-1 left-1 bg-black/70 text-white text-[10px] rounded px-1.5 py-0.5">#{clip.segmentIndex}</span>
                {isSel && <span className="absolute top-1 right-1 bg-purple-500 rounded-full p-0.5"><Check size={10} className="text-white" /></span>}
                <span className="absolute bottom-1 right-1 bg-black/70 text-neutral-300 text-[10px] rounded px-1 py-0.5">{clip.duration.toFixed(1)}s</span>
              </button>
              <div className="px-2 py-1.5 bg-neutral-900 space-y-1">
                <div className="flex flex-wrap gap-1">
                  {showAnim && cfg?.combo && <AnimTag label={`◆ ${animName(cfg.combo.animId)}`} />}
                  {showAnim && cfg?.in && <AnimTag label={`▸ ${animName(cfg.in.animId)}`} />}
                  {showAnim && cfg?.out && <AnimTag label={`◂ ${animName(cfg.out.animId)}`} />}
                  {showAnim && !hasAnimation(cfg) && <span className="text-[10px] text-neutral-600">No animation</span>}
                  {showTrans && hasTrans && <AnimTag label={`⇥ ${transitionName(trans.transId)}`} />}
                  {showTrans && !hasTrans && <span className="text-[10px] text-neutral-600">No transition</span>}
                </div>
                {over && (
                  <div className="flex items-center gap-1 text-[10px] text-red-400">
                    <AlertTriangle size={10} /> Animation longer than image ({clip.duration.toFixed(1)}s) — adjust manually
                  </div>
                )}
                {showAnim && hasAnimation(cfg) && onAdjustSpeed && (
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-neutral-500">Speed</span>
                    <button onClick={() => onAdjustSpeed(clip.media.id, 1 / 1.25)} className="text-[11px] leading-none text-neutral-300 hover:text-white border border-neutral-700 rounded w-5 h-5">−</button>
                    <span className="text-[10px] text-neutral-300 font-mono w-9 text-center">{((cfg?.combo?.speed || cfg?.in?.speed || cfg?.out?.speed || 1)).toFixed(2)}×</span>
                    <button onClick={() => onAdjustSpeed(clip.media.id, 1.25)} className="text-[11px] leading-none text-neutral-300 hover:text-white border border-neutral-700 rounded w-5 h-5">+</button>
                    <button onClick={() => onResetSpeed && onResetSpeed(clip.media.id)} className="text-[10px] text-neutral-500 hover:text-neutral-200 ml-1">reset</button>
                  </div>
                )}
                {((showAnim && hasAnimation(cfg)) || (showTrans && hasTrans)) && (
                  <button onClick={() => onClear(clip.media.id)} className="text-[10px] text-neutral-500 hover:text-red-400">Remove</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AnimTag({ label }: { label: string }) {
  return <span className="text-[10px] bg-purple-600/20 text-purple-200 rounded px-1.5 py-0.5 whitespace-nowrap">{label}</span>;
}

// ─── Preview Panel ────────────────────────────────────────────

function PreviewPanel({ clips, audioDuration }: { clips: Clip[]; audioDuration: number }) {
  const { currentProject: project } = useStore();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const nextVideoRef = useRef<HTMLVideoElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [currentClip, setCurrentClip] = useState<Clip | null>(null);
  const [buffering, setBuffering] = useState(false);
  const objectUrls = useRef<Map<string, string>>(new Map());
  const rafRef = useRef<number>(0);
  const lastClipId = useRef<string>('');
  // Refs mirrored for the always-on canvas draw loop (avoids restarting rAF).
  const timeRef = useRef<number>(0);
  const clipRef = useRef<Clip | null>(null);
  const imgReadyRef = useRef<boolean>(false);
  // Kept current every render so the always-on draw loop sees live edits.
  const animCfgRef = useRef(project?.clipAnimations);
  animCfgRef.current = project?.clipAnimations;
  const transRef = useRef(project?.transitions);
  transRef.current = project?.transitions;
  // Decoded image bitmaps for the shared renderer (enables transitions/fit).
  const bitmapCache = useRef<Map<string, DrawSource>>(new Map());
  const clipsRef = useRef<Clip[]>(clips);
  clipsRef.current = clips;
  const ratio = project?.videoExport?.aspectRatio || '16:9';
  const fit = project?.videoExport?.imageFit || 'cover';
  const fitRef = useRef(fit); fitRef.current = fit;
  const pdims = frameDims('720p', ratio);
  const CANVAS_W = pdims.w, CANVAS_H = pdims.h;

  // Multi-part audio state
  const [partUrls, setPartUrls] = useState<string[]>([]);
  const [currentPart, setCurrentPart] = useState(0);
  const partDurations = project?.audioPartDurations || (project ? [project.audioDuration] : []);
  const offsets = buildPartOffsets(partDurations);
  const partBlobUrls = useRef<Map<string, string>>(new Map());

  // Resolve object URLs for media
  const getMediaUrl = useCallback(async (clip: Clip): Promise<string | null> => {
    if (clip.media.objectUrl) return clip.media.objectUrl;
    if (objectUrls.current.has(clip.media.id)) return objectUrls.current.get(clip.media.id)!;

    let blob: Blob | null = null;
    if (clip.media.blobId) {
      const { getBlob } = await import('../lib/db');
      blob = (await getBlob(clip.media.blobId)) || null;
    } else if (project?.folders.mode === 'native' && clip.media.handlePath) {
      const { verifyPermission } = await import('../lib/fs');
      const { getHandle } = await import('../lib/db');
      const folderId = clip.media.kind === 'video' ? project.folders.videosHandleId : project.folders.imagesHandleId;
      if (folderId) {
        const dirHandle = await getHandle(folderId) as FileSystemDirectoryHandle | undefined;
        if (dirHandle && await verifyPermission(dirHandle)) {
          const fileHandle = await dirHandle.getFileHandle(clip.media.handlePath);
          blob = await fileHandle.getFile();
        }
      }
    }
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    objectUrls.current.set(clip.media.id, url);
    return url;
  }, [project]);

  // Resolve ALL audio part URLs
  useEffect(() => {
    if (!project || partUrls.length > 0) return;
    (async () => {
      const { getBlob } = await import('../lib/db');
      const { verifyPermission } = await import('../lib/fs');
      const { getHandle } = await import('../lib/db');
      const urls: string[] = [];
      for (const part of project.folders.audioParts) {
        let blob: Blob | null = null;
        if (part.blobId) blob = (await getBlob(part.blobId)) || null;
        else if (part.handleId) {
          const handle = await getHandle(part.handleId) as FileSystemFileHandle | undefined;
          if (handle && await verifyPermission(handle)) blob = await handle.getFile();
        }
        if (blob) {
          const url = URL.createObjectURL(blob);
          partBlobUrls.current.set(part.id, url);
          urls.push(url);
        }
      }
      setPartUrls(urls);
    })();
  }, [project, partUrls.length]);

  // Map global time -> part index + local time
  const globalToLocal = useCallback((globalTime: number): { part: number; local: number } => {
    for (let i = 0; i < offsets.length; i++) {
      const partEnd = offsets[i] + partDurations[i];
      if (globalTime < partEnd || i === offsets.length - 1) {
        return { part: i, local: globalTime - offsets[i] };
      }
    }
    return { part: 0, local: globalTime };
  }, [offsets, partDurations]);

  // Find current clip at time
  const findClipAt = useCallback((time: number): Clip | null => {
    for (const clip of clips) {
      if (time >= clip.start && time < clip.start + clip.duration) return clip;
    }
    return null;
  }, [clips]);

  // Switch audio to a specific part at a local time
  const switchAudioPart = useCallback((partIdx: number, localTime: number) => {
    if (!audioRef.current || !partUrls[partIdx]) return;
    if (audioRef.current.src !== partUrls[partIdx]) {
      audioRef.current.src = partUrls[partIdx];
    }
    if (Math.abs(audioRef.current.currentTime - localTime) > 0.05) {
      audioRef.current.currentTime = localTime;
    }
    setCurrentPart(partIdx);
  }, [partUrls]);

  // Animation loop — gapless multi-part playback
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      if (audioRef.current) {
        const localT = audioRef.current.currentTime;
        const globalT = offsets[currentPart] + localT;
        setCurrentTime(globalT);
        timeRef.current = globalT;
        const clip = findClipAt(globalT);
        if (clip && clip.id !== lastClipId.current) {
          lastClipId.current = clip.id;
          setCurrentClip(clip);
          clipRef.current = clip;
          swapClipSource(clip);
        }
        // resync video if drift
        if (clip && !clip.isImage && videoRef.current) {
          const expectedTime = (globalT - clip.start) + clip.sourceTrimStart;
          if (Math.abs(videoRef.current.currentTime - expectedTime) > 0.3) {
            videoRef.current.currentTime = expectedTime;
          }
        }
        // Check if we've crossed a part boundary
        const partEnd = partDurations[currentPart] || 0;
        if (localT >= partEnd - 0.05 && currentPart < partUrls.length - 1) {
          // Switch to next part
          const nextPart = currentPart + 1;
          const overflow = localT - partEnd;
          switchAudioPart(nextPart, Math.max(0, overflow));
          if (playing) audioRef.current?.play().catch(() => {});
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, clips, findClipAt, offsets, currentPart, partDurations, partUrls.length, switchAudioPart]);

  const swapClipSource = useCallback(async (clip: Clip) => {
    const url = await getMediaUrl(clip);
    if (!url) return;
    if (clip.isImage) {
      if (imgRef.current) {
        imgReadyRef.current = false;
        imgRef.current.src = url;
      }
    } else {
      if (videoRef.current) {
        videoRef.current.src = url;
        const audioT = audioRef.current?.currentTime || 0;
        const globalT = offsets[currentPart] + audioT;
        videoRef.current.currentTime = (globalT - clip.start) + clip.sourceTrimStart;
        if (playing) videoRef.current.play().catch(() => {});
      }
    }
  }, [getMediaUrl, offsets, currentPart, playing]);

  // Decode image bitmaps once so the shared renderer can composite transitions.
  useEffect(() => {
    let cancelled = false;
    const cache = bitmapCache.current;
    (async () => {
      const seen = new Set<string>();
      for (const clip of clips) {
        if (!clip.isImage || seen.has(clip.media.id) || cache.has(clip.media.id)) continue;
        seen.add(clip.media.id);
        const blob = await resolveMediaBlob(project, clip.media);
        if (blob && !cancelled) {
          try { cache.set(clip.media.id, await createImageBitmap(blob)); } catch { /* skip */ }
        }
      }
    })();
    return () => {
      cancelled = true;
      cache.forEach((b) => { if ((b as any).close) (b as any).close(); });
      cache.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, clips.length]);

  // Always-on canvas draw loop: composites current clip + animation + transition.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const t = timeRef.current;
      const clip = clipRef.current;
      // Current video clip streams from the <video>; images come from the cache.
      const getSource = (mediaId: string): DrawSource | null => {
        if (clip && !clip.isImage && clip.media.id === mediaId) return videoRef.current;
        return bitmapCache.current.get(mediaId) || (clip?.isImage && imgReadyRef.current && clip.media.id === mediaId ? imgRef.current : null);
      };
      renderTimelineFrame(ctx as any, t, {
        clips: clipsRef.current,
        animCfgs: animCfgRef.current || {},
        transitions: transRef.current || {},
        getSource,
        W: canvas.width,
        H: canvas.height,
        fit: fitRef.current,
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const handlePlayPause = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
      videoRef.current?.pause();
      setPlaying(false);
    } else {
      // Ensure correct part is loaded for current time
      const { part, local } = globalToLocal(currentTime);
      switchAudioPart(part, local);
      audioRef.current.play().catch(() => {});
      setPlaying(true);
    }
  };

  const handleSeek = (time: number) => {
    const { part, local } = globalToLocal(time);
    switchAudioPart(part, local);
    setCurrentTime(time);
    timeRef.current = time;
    const clip = findClipAt(time);
    if (clip && clip.id !== lastClipId.current) {
      lastClipId.current = clip.id;
      setCurrentClip(clip);
      clipRef.current = clip;
      swapClipSource(clip);
    }
  };

  // Preload next clip
  useEffect(() => {
    if (!currentClip) return;
    const nextIdx = clips.findIndex(c => c.id === currentClip.id) + 1;
    if (nextIdx < clips.length && !clips[nextIdx].isImage && nextVideoRef.current) {
      getMediaUrl(clips[nextIdx]).then(url => {
        if (url && nextVideoRef.current) nextVideoRef.current.src = url;
      });
    }
  }, [currentClip, clips, getMediaUrl]);

  useEffect(() => {
    return () => {
      objectUrls.current.forEach(url => URL.revokeObjectURL(url));
      objectUrls.current.clear();
      partBlobUrls.current.forEach(url => URL.revokeObjectURL(url));
      partBlobUrls.current.clear();
    };
  }, []);

  if (clips.length === 0) {
    return <div className="p-8 text-center text-neutral-500">Run the pipeline to see the preview.</div>;
  }

  // Part summary
  const partSummary = partDurations.length > 0
    ? partDurations.map((d, i) => `Part ${i + 1}: ${fmtTime(d)}`).join(' + ') + ` = Total ${fmtTime(audioDuration)}`
    : '';

  return (
    <div className="p-4 space-y-4">
      <div className="bg-black rounded-xl overflow-hidden relative mx-auto" style={{ aspectRatio: `${CANVAS_W}/${CANVAS_H}`, maxHeight: '70vh', maxWidth: '100%' }}>
        <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} className="w-full h-full object-contain" />
        <video ref={videoRef} className="hidden" muted playsInline preload="auto" />
        <video ref={nextVideoRef} className="hidden" muted playsInline preload="auto" />
        <img ref={imgRef} className="hidden" alt="" onLoad={() => { imgReadyRef.current = true; }} />
        {buffering && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="animate-spin text-white" size={32} />
          </div>
        )}
        {partUrls.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-500">
            Loading audio...
          </div>
        )}
      </div>

      {/* Part summary */}
      {partSummary && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-xs text-neutral-300 font-mono">
          {partSummary}
        </div>
      )}

      {/* Transport controls */}
      <div className="flex items-center gap-3 bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3">
        <button onClick={handlePlayPause} className="text-white hover:text-blue-400 transition-colors">
          {playing ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <span className="text-xs text-neutral-400 font-mono">{fmtTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={audioDuration || 100}
          step={0.1}
          value={currentTime}
          onChange={(e) => handleSeek(parseFloat(e.target.value))}
          className="flex-1 accent-blue-500"
        />
        <span className="text-xs text-neutral-400 font-mono">{fmtTime(audioDuration)}</span>
      </div>

      <audio ref={audioRef} src={partUrls[0] || undefined} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => {
        // Auto-advance to next part if available
        if (currentPart < partUrls.length - 1) {
          const nextPart = currentPart + 1;
          switchAudioPart(nextPart, 0);
          audioRef.current?.play().catch(() => {});
        } else {
          setPlaying(false);
        }
      }} />

      {/* Current clip info */}
      {currentClip && (
        <div className="text-xs text-neutral-400">
          Playing: {currentClip.media.name} (Segment {currentClip.segmentIndex}) — Part {currentPart + 1}
        </div>
      )}
    </div>
  );
}

// ─── Standalone MP4 export ────────────────────────────────────

function VideoExportSection() {
  const store = useStore();
  const { currentProject: project } = store;
  const [resolution, setResolution] = useState<ResolutionPreset>('1080p');
  const [fps, setFps] = useState<30 | 60>(30);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9');
  const [imageFit, setImageFit] = useState<ImageFit>('cover');
  const [audioVolume, setAudioVolume] = useState(1);
  const exporting = !!store.videoExportState?.active;

  useEffect(() => {
    if (project?.videoExport) {
      setResolution(project.videoExport.resolution);
      setFps(project.videoExport.fps);
      if (project.videoExport.aspectRatio) setAspectRatio(project.videoExport.aspectRatio);
      if (project.videoExport.imageFit) setImageFit(project.videoExport.imageFit);
      if (typeof project.videoExport.audioVolume === 'number') setAudioVolume(project.videoExport.audioVolume);
    }
  }, [project?.id]);

  if (!project) return null;
  const safeName = project.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Untitled';

  const handleExport = () => {
    store.startVideoExport({ resolution, fps, aspectRatio, imageFit, audioVolume });
  };

  const res = RESOLUTIONS[resolution];
  const dims = frameDims(resolution, aspectRatio);

  return (
    <div className="bg-neutral-900 border border-purple-800/50 rounded-xl p-5 space-y-3">
      <h3 className="text-sm font-medium text-neutral-200 flex items-center gap-2">
        <Film size={16} className="text-purple-400" /> Export Video (MP4) — no CapCut needed
      </h3>
      <p className="text-xs text-neutral-500">
        Renders your images, audio, animations and transitions straight to an MP4 file on your PC.
      </p>
      <div className="flex items-center gap-4 flex-wrap">
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Resolution</label>
          <select
            value={resolution}
            onChange={(e) => setResolution(e.target.value as ResolutionPreset)}
            className="bg-neutral-800 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
          >
            {(Object.keys(RESOLUTIONS) as ResolutionPreset[]).map((r) => (
              <option key={r} value={r}>{RESOLUTIONS[r].label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Aspect ratio</label>
          <select
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
            className="bg-neutral-800 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
          >
            {(['16:9', '9:16', '1:1', '4:3'] as AspectRatio[]).map((r) => (
              <option key={r} value={r}>{r}{r === '16:9' ? ' (landscape)' : r === '9:16' ? ' (vertical)' : r === '1:1' ? ' (square)' : ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Image fit</label>
          <select
            value={imageFit}
            onChange={(e) => setImageFit(e.target.value as ImageFit)}
            className="bg-neutral-800 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
          >
            <option value="cover">Cover (fill, may crop)</option>
            <option value="contain">Contain (fit, may letterbox)</option>
            <option value="fill">Stretch to fill</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Frame rate</label>
          <div className="flex gap-1">
            {([30, 60] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFps(f)}
                className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                  fps === f ? 'bg-purple-600 border-purple-500 text-white' : 'bg-neutral-800 border-neutral-600 text-neutral-300 hover:bg-neutral-700'
                }`}
              >
                {f} fps
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs text-neutral-400 mb-1">Voice volume</label>
          <div className="flex items-center gap-2 h-[38px]">
            <input
              type="range" min="0" max="3" step="0.1" value={audioVolume}
              onChange={(e) => setAudioVolume(parseFloat(e.target.value))}
              className="w-32 accent-purple-500"
            />
            <span className="text-xs text-white font-mono w-10 text-right tabular-nums">{Math.round(audioVolume * 100)}%</span>
            {audioVolume !== 1 && <button onClick={() => setAudioVolume(1)} className="text-[11px] text-neutral-400 hover:text-neutral-200 border border-neutral-700 rounded px-1.5 py-0.5">reset</button>}
          </div>
        </div>
      </div>
      {(() => {
        const estBytes = estimateExportBytes(resolution, project.audioDuration || 0);
        const big = estBytes > 2 * 1_073_741_824;
        return (
          <div className="text-xs text-neutral-500">
            Output: <span className="text-neutral-300 font-mono">{dims.w}×{dims.h}</span> @ {fps}fps ·
            estimated size <span className={`font-mono ${big ? 'text-amber-400' : 'text-neutral-300'}`}>≈ {formatBytes(estBytes)}</span>
            {big && (
              <span className="block text-amber-400 mt-0.5">
                ⚠ Large file — make sure your drive has this much free space, or choose <strong>720p / 480p</strong> for a much smaller file.
              </span>
            )}
          </div>
        );
      })()}

      {/* Save folder */}
      {store.nativeExport ? (
        <div className="flex items-center gap-2 flex-wrap bg-neutral-800/40 border border-neutral-700 rounded-lg px-3 py-2">
          <FolderOpen size={14} className="text-neutral-400 shrink-0" />
          <span className="text-xs text-neutral-400">Save to:</span>
          <code className="text-xs text-blue-300 font-mono truncate max-w-[60%]">{store.videoExportFolder || '(default: Videos folder)'}</code>
          <button onClick={() => store.pickVideoExportFolder()} className="text-xs bg-neutral-700 hover:bg-neutral-600 text-white rounded px-2 py-1 ml-auto">Change…</button>
        </div>
      ) : (
        <p className="text-xs text-neutral-500">Saves to your browser's Downloads folder. (Use the desktop app to choose a folder.)</p>
      )}

      <button
        onClick={handleExport}
        disabled={!project.processed || project.clips.length === 0 || exporting}
        className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
      >
        {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
        {exporting ? 'Exporting…' : `Export ${res.label} MP4`}
      </button>
      {exporting && <p className="text-xs text-neutral-400">Export runs in the background — you can switch tabs or minimize. Progress is shown at the top.</p>}
      {!project.processed && <p className="text-xs text-yellow-500">Run the Process pipeline first.</p>}
    </div>
  );
}

// Global export overlay — visible on every tab while a render is running.
function ExportOverlay() {
  const { videoExportState: st, cancelVideoExport, revealLastExport, nativeExport } = useStore();
  if (!st) return null;
  const pct = Math.round(st.progress * 100);
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pointer-events-none">
      <div className="mt-3 w-full max-w-md bg-neutral-900/95 backdrop-blur border border-neutral-700 rounded-xl shadow-2xl p-4 pointer-events-auto">
        {st.error ? (
          <div className="flex items-start gap-2 text-sm text-red-300">
            <AlertOctagon size={16} className="mt-0.5 shrink-0" />
            <span>Export failed: {st.error}</span>
          </div>
        ) : st.done ? (
          <div className="flex items-center justify-between gap-2 text-sm text-green-300">
            <span className="flex items-center gap-2 min-w-0"><CheckCircle2 size={16} className="shrink-0" /> <span className="truncate">{st.message}</span></span>
            {nativeExport && <button onClick={revealLastExport} className="text-xs bg-neutral-700 hover:bg-neutral-600 text-white rounded px-2 py-1 shrink-0">Open folder</button>}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="flex items-center gap-2 text-sm font-medium text-neutral-100">
                <Film size={15} className="text-purple-400" /> Exporting video
              </span>
              <span className="text-xs text-neutral-400 font-mono tabular-nums">{pct}%</span>
            </div>
            <div className="h-2 bg-neutral-800 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-purple-500 to-fuchsia-400 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-neutral-400 truncate pr-2">{st.message}</span>
              <button onClick={cancelVideoExport} className="text-xs text-red-400 hover:text-red-300 shrink-0">Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Export Panel ────────────────────────────────────────────

function ExportPanel() {
  const { currentProject: project, exportDraft, exportFallback, importTemplate, templates, removeTemplate, settings, saveSettings, addLog, simulateTestExport } = useStore();
  const [draftsRoot, setDraftsRoot] = useState('');
  const [username, setUsername] = useState('');
  const [transMode, setTransMode] = useState<'online' | 'offline'>('offline');
  const [groqKey, setGroqKey] = useState('');
  const [imageOffset, setImageOffset] = useState(0);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [exporting, setExporting] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (settings) {
      setDraftsRoot(settings.draftsRootPath || '');
      setUsername(settings.username || '');
      setTransMode(settings.transcriptionMode || 'offline');
      setGroqKey(settings.groqApiKey || '');
      setImageOffset(settings.imageOffsetSec || 0);
    }
  }, [settings]);

  // Auto-select first template
  useEffect(() => {
    if (templates.length > 0 && !selectedTemplateId) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [templates, selectedTemplateId]);

  if (!project) return null;

  const selectedTemplate = templates.find(t => t.id === selectedTemplateId) || null;
  const safeName = project.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Untitled';
  const previewFoldPath = draftsRoot ? `${draftsRoot}/${safeName}` : '';

  const handleImportTemplate = async () => {
    setImporting(true);
    try {
      await importTemplate();
    } finally {
      setImporting(false);
    }
  };

  const handleSaveSettings = async () => {
    await saveSettings({
      draftsRootPath: draftsRoot,
      username,
      transcriptionMode: transMode,
      groqApiKey: groqKey.trim(),
      imageOffsetSec: imageOffset,
    });
  };

  const handleExport = async () => {
    if (!selectedTemplate) {
      addLog('Cannot export: no template imported. Import a CapCut template draft first.', 'error');
      return;
    }
    if (!draftsRoot.trim()) {
      addLog('Cannot export: drafts root path is empty. Please set your CapCut drafts path first.', 'error');
      return;
    }
    setExporting(true);
    setReport(null);
    try {
      const result = await exportDraft(draftsRoot.trim(), selectedTemplate);
      setReport(result.report);
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}_capcut.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setShowInstructions(true);
      if (result.report.passed) {
        addLog('Exported CapCut draft ZIP — validator PASSED');
      } else {
        addLog('Exported CapCut draft ZIP — validator FAILED (check report)', 'warn');
      }
    } catch (e: any) {
      addLog(`Export error: ${e.message}`, 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleFallbackExport = async () => {
    setExporting(true);
    try {
      const blob = await exportFallback();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}_cutsheet.zip`;
      a.click();
      URL.revokeObjectURL(url);
      addLog('Exported SRT/CSV cut-sheet');
    } catch (e: any) {
      addLog(`Export error: ${e.message}`, 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="p-4 space-y-4 max-w-2xl">
      {/* Standalone MP4 export — primary path */}
      <VideoExportSection />

      {/* Template import section (optional CapCut path) */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-medium text-neutral-300 flex items-center gap-2">
          <Upload size={16} /> CapCut Template (optional)
        </h3>
        <p className="text-xs text-neutral-500">
          For guaranteed compatibility with your CapCut version, import a template draft created by your own CapCut.
          Open CapCut Desktop, create a new empty project (add one image, one video, one audio), close CapCut, then select that draft's folder.
        </p>
        <button
          onClick={handleImportTemplate}
          disabled={importing}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
        >
          {importing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
          Import CapCut Template
        </button>

        {templates.length > 0 && (
          <div className="space-y-2">
            <label className="block text-xs text-neutral-400">Active template:</label>
            <div className="flex items-center gap-2">
              <select
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="flex-1 bg-neutral-800 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button
                onClick={() => { removeTemplate(selectedTemplateId); setSelectedTemplateId(''); }}
                className="text-red-400 hover:text-red-300 p-2"
                title="Delete template"
              >
                <Trash2 size={16} />
              </button>
            </div>
            {selectedTemplate && (
              <div className="text-xs text-green-400 flex items-center gap-1">
                <Check size={12} /> Detected drafts root: {selectedTemplate.detectedDraftsRoot || '(not found)'}
              </div>
            )}
          </div>
        )}

        {!selectedTemplate && (
          <div className="flex items-start gap-2 bg-red-950/30 border border-red-800 rounded-lg px-3 py-2 text-xs text-red-200">
            <AlertOctagon size={14} className="mt-0.5 shrink-0" />
            <span><strong>Export blocked:</strong> No template imported. You must import a CapCut template draft (created by your own CapCut) before exporting. Click the button above to import one.</span>
          </div>
        )}
      </div>

      {/* Transcription settings */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-medium text-neutral-300 flex items-center gap-2">
          <Settings size={16} /> Transcription
        </h3>
        <div className="flex gap-2">
          <button
            onClick={() => setTransMode('online')}
            className={`flex-1 rounded-lg px-3 py-2 text-sm border transition-colors ${
              transMode === 'online'
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-neutral-800 border-neutral-600 text-neutral-300 hover:bg-neutral-700'
            }`}
          >
            Online — Groq (fast)
          </button>
          <button
            onClick={() => setTransMode('offline')}
            className={`flex-1 rounded-lg px-3 py-2 text-sm border transition-colors ${
              transMode === 'offline'
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-neutral-800 border-neutral-600 text-neutral-300 hover:bg-neutral-700'
            }`}
          >
            Offline — free &amp; unlimited (on your PC)
          </button>
        </div>
        {transMode === 'offline' && (
          <p className="text-xs text-neutral-500">
            Runs a speech model on your own computer — no key, no limits, nothing uploaded.
            Uses the bundled fast engine; a 30-minute recording takes a couple of minutes.
          </p>
        )}
        <div className="pt-1">
          <label className="block text-sm text-neutral-300 mb-1.5">Image timing offset (seconds)</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="0.5"
              value={imageOffset}
              onChange={(e) => setImageOffset(parseFloat(e.target.value) || 0)}
              className="w-28 bg-neutral-800 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            />
            <span className="text-xs text-neutral-500">seconds</span>
          </div>
          <p className="text-xs text-neutral-500 mt-1">
            If images change <strong>too late</strong>, increase this (e.g. <strong>6</strong>) to move every image earlier.
            Negative moves them later. Then click <strong>Save</strong> and <strong>Process</strong> again.
          </p>
        </div>
        {transMode === 'online' && (
          <div className="space-y-2">
            <label className="block text-sm text-neutral-300">Groq API key</label>
            <input
              type="password"
              value={groqKey}
              onChange={(e) => setGroqKey(e.target.value)}
              placeholder="gsk_…"
              className="w-full bg-neutral-800 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500 font-mono text-xs"
            />
            <p className="text-xs text-neutral-500">
              Get a free key at <span className="text-blue-300">console.groq.com/keys</span> (no card).
              Stored only on your PC. Fast &amp; accurate; audio is sent to Groq for transcription.
              Click <strong>Save</strong> below, then press <strong>Process</strong>.
            </p>
          </div>
        )}
        <button
          onClick={handleSaveSettings}
          className="text-xs bg-neutral-700 hover:bg-neutral-600 text-white rounded-lg px-3 py-1.5 transition-colors"
        >
          Save
        </button>
      </div>

      {/* Path settings section */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-medium text-neutral-300 flex items-center gap-2">
          <Settings size={16} /> Drafts Root Path
        </h3>
        <p className="text-xs text-neutral-500">
          This is the CapCut drafts folder on your PC. It's auto-detected from your imported template.
          If no template, enter your Windows username to build the path, or paste the full path manually.
        </p>

        <div>
          <label className="block text-sm text-neutral-300 mb-1.5">Windows Username (optional)</label>
          <input
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (e.target.value.trim()) {
                setDraftsRoot(`C:/Users/${e.target.value.trim()}/AppData/Local/CapCut/User Data/Projects/com.lveditor.draft`);
              }
            }}
            placeholder="e.g. johnsmith"
            className="w-full bg-neutral-800 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm text-neutral-300 mb-1.5">Drafts Root Path</label>
          <input
            type="text"
            value={draftsRoot}
            onChange={(e) => setDraftsRoot(e.target.value)}
            placeholder="C:/Users/<USERNAME>/AppData/Local/CapCut/User Data/Projects/com.lveditor.draft"
            className="w-full bg-neutral-800 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500 font-mono text-xs"
          />
        </div>

        {previewFoldPath && (
          <div className="bg-neutral-800/50 border border-neutral-700 rounded-lg px-3 py-2">
            <p className="text-xs text-neutral-400 mb-1">Your project will be exported to:</p>
            <code className="text-xs text-blue-300 font-mono break-all">{previewFoldPath}</code>
          </div>
        )}

        <button
          onClick={handleSaveSettings}
          className="text-xs bg-neutral-700 hover:bg-neutral-600 text-white rounded-lg px-3 py-1.5 transition-colors"
        >
          Save settings
        </button>
      </div>

      {/* Export buttons */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-3">
        <div className="flex gap-3">
          <button
            onClick={handleExport}
            disabled={!draftsRoot.trim() || exporting || !project.processed || !selectedTemplate}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          >
            {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            Export CapCut Draft
          </button>
          <button
            onClick={handleFallbackExport}
            disabled={exporting || !project.processed}
            className="flex items-center gap-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors border border-neutral-600"
          >
            <Download size={16} />
            SRT/CSV Cut-Sheet
          </button>
          <button
            onClick={() => simulateTestExport(draftsRoot.trim() || 'C:/Users/test/AppData/Local/CapCut/User Data/Projects/com.lveditor.draft')}
            disabled={exporting || !project.processed}
            className="flex items-center gap-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors border border-neutral-600"
          >
            <Terminal size={16} />
            Run Test Simulation
          </button>
        </div>
        {!project.processed && (
          <p className="text-xs text-yellow-500">Run the Process pipeline first before exporting.</p>
        )}
        {!draftsRoot.trim() && (
          <p className="text-xs text-red-400">Set your drafts root path above before exporting.</p>
        )}
        {!selectedTemplate && (
          <p className="text-xs text-red-400">Import a CapCut template first — export is blocked without one.</p>
        )}
      </div>

      {/* Validator report */}
      {report && (
        <div className={`bg-neutral-900 border rounded-xl p-5 space-y-3 ${report.passed ? 'border-green-700' : 'border-red-700'}`}>
          <h3 className="text-sm font-medium flex items-center gap-2">
            {report.passed ? (
              <><CheckCircle2 size={16} className="text-green-400" /> <span className="text-green-400">Validator: PASSED</span></>
            ) : (
              <><AlertOctagon size={16} className="text-red-400" /> <span className="text-red-400">Validator: FAILED</span></>
            )}
            <span className="text-xs text-neutral-500">({report.checks.filter(c => c.pass).length}/{report.checks.length} checks)</span>
          </h3>
          <div className="space-y-1">
            {report.checks.map((check, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                {check.pass ? (
                  <Check size={14} className="text-green-400 mt-0.5 shrink-0" />
                ) : (
                  <X size={14} className="text-red-400 mt-0.5 shrink-0" />
                )}
                <span className="text-neutral-300">{check.name}</span>
                <span className="text-neutral-500 ml-auto text-right">{check.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Instructions */}
      {showInstructions && (
        <div className="bg-blue-950/30 border border-blue-800 rounded-xl p-5 space-y-3">
          <h4 className="text-sm font-medium text-blue-200 flex items-center gap-2">
            <AlertCircle size={16} /> How to import into CapCut
          </h4>
          <ol className="space-y-2 text-sm text-neutral-300 list-decimal list-inside">
            <li><strong>Close CapCut completely</strong> — check your system tray to make sure it's not running in the background.</li>
            <li>Extract the ZIP file directly into your CapCut drafts folder:
              <code className="block bg-neutral-800 rounded px-2 py-1 mt-1 text-xs text-blue-300 font-mono break-all">
                {draftsRoot || 'C:/Users/<USERNAME>/AppData/Local/CapCut/User Data/Projects/com.lveditor.draft/'}
              </code>
            </li>
            <li>Verify the structure shows:
              <code className="block bg-neutral-800 rounded px-2 py-1 mt-1 text-xs text-neutral-400 font-mono">
                {safeName}/<br />
                ├── draft_content.json<br />
                ├── draft_meta_info.json<br />
                └── Resources/
              </code>
              <span className="text-yellow-500 text-xs">Make sure there's no nested duplicate folder.</span>
            </li>
            <li>Open CapCut — the project "{safeName}" will appear in your drafts list.</li>
            <li>Keep it on your local C: drive — never OneDrive-synced folders, USB, or network drives.</li>
          </ol>
          <button onClick={() => setShowInstructions(false)} className="text-xs text-blue-400 hover:text-blue-300">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Log Panel ────────────────────────────────────────────────

function LogPanel() {
  const { logs, clearLogs } = useStore();
  const [expanded, setExpanded] = useState(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  if (logs.length === 0) return null;

  return (
    <div className="border-t border-neutral-800 bg-neutral-900">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between w-full px-4 py-2 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
      >
        <span className="flex items-center gap-2">
          <Terminal size={14} /> Log ({logs.length})
        </span>
        <span className="flex items-center gap-2">
          {expanded && <button onClick={(e) => { e.stopPropagation(); clearLogs(); }} className="hover:text-white">Clear</button>}
          {expanded ? '▼' : '▲'}
        </span>
      </button>
      {expanded && (
        <div className="max-h-32 overflow-y-auto px-4 pb-2 space-y-0.5">
          {logs.map((log, i) => (
            <div key={i} className={`text-xs font-mono ${
              log.level === 'error' ? 'text-red-400' :
              log.level === 'warn' ? 'text-yellow-400' : 'text-neutral-400'
            }`}>
              [{new Date(log.time).toLocaleTimeString()}] {log.message}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}
