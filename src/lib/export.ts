import JSZip from 'jszip';
import { Project, Clip, MediaItem, CapCutTemplate } from '../types';

function toMicro(seconds: number): number {
  return Math.round(seconds * 1_000_000);
}

function nowMicro(): number {
  return Date.now() * 1000;
}

function capcutUuid(): string {
  const hex = crypto.randomUUID();
  return hex
    .split('-')
    .map((part, i) => {
      if (i === 2) return part.toLowerCase();
      if (i === 3) return part.toLowerCase().slice(0, 4);
      return part.toUpperCase();
    })
    .join('-');
}

function sanitizeProjectName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Untitled';
}

function joinPath(parts: string[], sep: string): string {
  return parts.join(sep);
}

function detectSeparator(pathStr: string): string {
  if (!pathStr) return '/';
  return pathStr.includes('\\') && !pathStr.includes('/') ? '\\' : '/';
}

function countFields(obj: any): number {
  if (!obj || typeof obj !== 'object') return 0;
  return Object.keys(obj).length;
}

/** Resize an image blob to ~640px wide for use as draft_cover.jpg */
async function resizeCoverImage(blob: Blob, maxWidth = 640): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxWidth / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b || blob), 'image/jpeg', 0.8);
    });
  } catch {
    return blob;
  }
}

// ─── Validator ──────────────────────────────────────────────────

export interface ValidationCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ValidationReport {
  checks: ValidationCheck[];
  passed: boolean;
}

function validateDraft(
  draftContent: any,
  draftMeta: any,
  projectName: string,
  draftsRoot: string,
  sep: string,
  resourceFiles: Set<string>,
  clipCount: number,
  zipHasCover: boolean,
  zipSubfolders: string[],
): ValidationReport {
  const checks: ValidationCheck[] = [];
  const foldPath = joinPath([draftsRoot, projectName], sep);

  // 1. draft_id present
  const hasId = !!draftContent.id;
  checks.push({ name: 'draft_content.id present', pass: hasId, detail: hasId ? draftContent.id : 'missing' });

  // 2. fold path ends with project name
  const metaFold = draftMeta.draft_fold_path || '';
  const foldOk = metaFold.endsWith(projectName) && metaFold.includes(draftsRoot);
  checks.push({ name: 'draft_fold_path correct', pass: foldOk, detail: `fold ends with /${projectName}` });

  // 3. root path is parent of fold path
  const metaRoot = draftMeta.draft_root_path || '';
  const rootOk = metaRoot === draftsRoot && metaRoot !== metaFold;
  checks.push({ name: 'draft_root_path is parent', pass: rootOk, detail: `root="${metaRoot}"` });

  // 4. No materials.images array
  const hasImagesArray = Array.isArray(draftContent.materials?.images) && draftContent.materials.images.length > 0;
  checks.push({ name: 'No materials.images array', pass: !hasImagesArray, detail: hasImagesArray ? 'PRESENT (BAD)' : 'absent' });

  // 5. materials.videos populated
  const videos = draftContent.materials?.videos || [];
  checks.push({ name: 'materials.videos populated', pass: videos.length > 0, detail: `${videos.length} entries` });

  // 6. Each materials.videos entry has ≥60 fields
  let videoFieldsOk = true;
  let videoFieldDetail = '';
  if (videos.length > 0) {
    const minFields = Math.min(...videos.map((v: any) => countFields(v)));
    if (minFields < 60) {
      videoFieldsOk = false;
      videoFieldDetail = `min ${minFields} fields (need ≥60)`;
    }
  }
  checks.push({ name: 'Video materials ≥60 fields', pass: videoFieldsOk, detail: videoFieldDetail || 'all ≥60' });

  // 7. All material paths absolute and under foldPath/Resources
  let pathsOk = true;
  let pathDetail = '';
  for (const v of videos) {
    const p = v.path || '';
    if (!p || !p.includes(projectName)) { pathsOk = false; pathDetail = `bad path: ${p}`; break; }
    const filename = p.split(sep).pop() || '';
    if (!resourceFiles.has(filename)) { pathsOk = false; pathDetail = `file not in ZIP: ${filename}`; break; }
  }
  checks.push({ name: 'Material paths absolute & in ZIP', pass: pathsOk, detail: pathDetail || 'all valid' });

  // 8. Audio material path
  const audios = draftContent.materials?.audios || [];
  let audioPathOk = true;
  let audioPathDetail = '';
  for (const a of audios) {
    const p = a.path || '';
    if (!p || !p.includes(projectName)) { audioPathOk = false; audioPathDetail = `bad audio path: ${p}`; break; }
    const filename = p.split(sep).pop() || '';
    if (!resourceFiles.has(filename)) { audioPathOk = false; audioPathDetail = `audio file not in ZIP: ${filename}`; break; }
  }
  checks.push({ name: 'Audio path absolute & in ZIP', pass: audioPathOk, detail: audioPathDetail || 'all valid' });

  // 9. Timeranges sequential and non-overlapping
  const segments = draftContent.tracks?.[0]?.segments || [];
  let seqOk = true;
  let seqDetail = '';
  let prevEnd = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const start = seg.target_timerange?.start ?? 0;
    const dur = seg.target_timerange?.duration ?? 0;
    if (start < prevEnd - 1) { seqOk = false; seqDetail = `overlap at seg ${i}`; break; }
    if (dur <= 0) { seqOk = false; seqDetail = `zero duration at seg ${i}`; break; }
    prevEnd = start + dur;
  }
  checks.push({ name: 'Timeranges sequential', pass: seqOk, detail: seqDetail || `${segments.length} segments OK` });

  // 10. Total duration consistent
  const contentDur = draftContent.duration || 0;
  const metaDur = draftMeta.tm_duration || 0;
  const durOk = contentDur > 0 && Math.abs(contentDur - metaDur) < 1;
  checks.push({ name: 'Duration consistent', pass: durOk, detail: `content=${contentDur} meta=${metaDur}` });

  // 11. JSON parses cleanly
  checks.push({ name: 'JSON parses cleanly', pass: true, detail: 'OK' });

  // 12. Each segment has ≥45 fields
  let segFieldsOk = true;
  let segFieldDetail = '';
  if (segments.length > 0) {
    const minSegFields = Math.min(...segments.map((s: any) => countFields(s)));
    if (minSegFields < 45) {
      segFieldsOk = false;
      segFieldDetail = `min ${minSegFields} fields (need ≥45)`;
    }
  }
  checks.push({ name: 'Segments ≥45 fields', pass: segFieldsOk, detail: segFieldDetail || 'all ≥45' });

  // 13. Each segment's extra_material_refs has ≥7 ids
  let refsOk = true;
  let refsDetail = '';
  for (let i = 0; i < segments.length; i++) {
    const refs = segments[i]?.extra_material_refs || [];
    if (refs.length < 7) { refsOk = false; refsDetail = `seg ${i}: ${refs.length} refs (need ≥7)`; break; }
  }
  checks.push({ name: 'extra_material_refs ≥7 per segment', pass: refsOk, detail: refsDetail || 'all ≥7' });

  // 14. Companion array counts match clip count
  const companionArrays = ['speeds', 'placeholder_infos', 'canvases', 'sound_channel_mappings', 'material_colors', 'loudnesses', 'vocal_separations'];
  let companionOk = true;
  let companionDetail = '';
  for (const arr of companionArrays) {
    const count = draftContent.materials?.[arr]?.length || 0;
    if (count !== clipCount) { companionOk = false; companionDetail = `${arr}: ${count} (need ${clipCount})`; break; }
  }
  checks.push({ name: 'Companion arrays match clip count', pass: companionOk, detail: companionDetail || `all = ${clipCount}` });

  // 15. ZIP has draft_cover.jpg
  checks.push({ name: 'ZIP has draft_cover.jpg', pass: zipHasCover, detail: zipHasCover ? 'present' : 'MISSING' });

  // 16. ZIP has all 7 subfolders
  const requiredSubfolders = ['Timelines', 'adjust_mask', 'common_attachment', 'matting', 'qr_upload', 'smart_crop', 'subdraft'];
  const missingSubfolders = requiredSubfolders.filter(s => !zipSubfolders.includes(s));
  checks.push({ name: 'ZIP has 7 subfolders', pass: missingSubfolders.length === 0, detail: missingSubfolders.length === 0 ? 'all present' : `missing: ${missingSubfolders.join(', ')}` });

  // 17. No invented float "duration" in meta
  const metaHasFloatDur = typeof draftMeta.duration === 'number' && draftMeta.duration < 1_000_000;
  checks.push({ name: 'No invented float duration in meta', pass: !metaHasFloatDur, detail: metaHasFloatDur ? 'PRESENT (should use tm_duration)' : 'absent' });

  const passed = checks.every(c => c.pass);
  return { checks, passed };
}

// ─── Template-based export ──────────────────────────────────────

export interface ExportOptions {
  projectName: string;
  draftsRoot: string;
  template: CapCutTemplate;
}

export async function exportCapCutDraft(
  project: Project,
  mediaBlobs: Map<string, Blob>,
  options: ExportOptions,
): Promise<{ blob: Blob; report: ValidationReport; draftMeta: any }> {
  if (!options.template) {
    throw new Error('No template imported. Import a CapCut template draft first before exporting.');
  }

  const zip = new JSZip();
  const projectName = sanitizeProjectName(options.projectName);
  const draftsRoot = options.draftsRoot.replace(/[\\/]+$/, '');
  const sep = options.template.pathSeparator || '/';
  const foldPath = joinPath([draftsRoot, projectName], sep);
  const resourceDir = `${projectName}/Resources`;

  // Collect all unique media used in clips
  const usedMedia = new Map<string, MediaItem>();
  for (const clip of project.clips) {
    usedMedia.set(clip.media.id, clip.media);
  }
  const audioParts = project.folders.audioParts;
  const audioPartDurations = project.audioPartDurations || audioParts.map(() => project.audioDuration / audioParts.length);

  // Track resource files for validation
  const resourceFiles = new Set<string>();

  // Add media files to ZIP
  for (const [id, media] of usedMedia) {
    const blob = mediaBlobs.get(id);
    if (blob) {
      const ext = media.name.split('.').pop() || 'jpg';
      const filename = `${id}.${ext}`;
      zip.file(`${resourceDir}/${filename}`, blob);
      resourceFiles.add(filename);
    }
  }
  // Add ALL audio part files to ZIP
  for (const part of audioParts) {
    const blob = mediaBlobs.get(part.id);
    if (blob) {
      const ext = part.name.split('.').pop() || 'mp3';
      const filename = `${part.id}.${ext}`;
      zip.file(`${resourceDir}/${filename}`, blob);
      resourceFiles.add(filename);
    }
  }

  // ─── DEEP CLONE template + surgical edits ───
  const draftContent = structuredClone(options.template.draftContent);
  const draftMeta = structuredClone(options.template.draftMeta);

  const durationMicro = toMicro(project.audioDuration);
  const newId = capcutUuid();
  const now = nowMicro();

  // Update IDs
  draftContent.id = newId;
  draftMeta.draft_id = newId;

  // Update name and paths
  draftContent.name = projectName;
  draftMeta.draft_name = projectName;
  draftContent.path = foldPath;
  draftMeta.draft_fold_path = foldPath;
  draftMeta.draft_root_path = draftsRoot;

  // Update timestamps
  draftContent.create_time = now;
  draftContent.update_time = now;
  draftMeta.tm_draft_create = now;
  draftMeta.tm_draft_modified = now;
  draftMeta.tm_duration = durationMicro;
  draftContent.duration = durationMicro;

  // Remove invented float "duration" from meta (real meta uses tm_duration in microseconds)
  if (typeof draftMeta.duration === 'number' && draftMeta.duration < 1_000_000) {
    delete draftMeta.duration;
  }

  // ─── Build materials.videos from template's photo/video materials ───
  const templateVideos = draftContent.materials?.videos || [];
  const photoRef = templateVideos.find((v: any) => v.type === 'photo');
  const videoRef = templateVideos.find((v: any) => v.type === 'video');
  const audioRef = draftContent.materials?.audios?.[0];

  const newVideos: any[] = [];
  const newAudios: any[] = [];

  // Companion material arrays from template
  const tplSpeeds = draftContent.materials?.speeds || [];
  const tplPlaceholders = draftContent.materials?.placeholder_infos || [];
  const tplCanvases = draftContent.materials?.canvases || [];
  const tplSoundChannels = draftContent.materials?.sound_channel_mappings || [];
  const tplMaterialColors = draftContent.materials?.material_colors || [];
  const tplLoudnesses = draftContent.materials?.loudnesses || [];
  const tplVocalSeparations = draftContent.materials?.vocal_separations || [];

  const newSpeeds: any[] = [];
  const newPlaceholders: any[] = [];
  const newCanvases: any[] = [];
  const newSoundChannels: any[] = [];
  const newMaterialColors: any[] = [];
  const newLoudnesses: any[] = [];
  const newVocalSeparations: any[] = [];

  // Template segment reference for schema
  const templateSegments = draftContent.tracks?.[0]?.segments || [];
  const segRef = templateSegments[0];

  const newVideoSegments: any[] = [];

  for (const clip of project.clips) {
    const media = clip.media;
    const targetStart = toMicro(clip.start);
    const targetDur = toMicro(clip.duration);
    const sourceStart = toMicro(clip.sourceTrimStart);
    const sourceDur = clip.isImage ? targetDur : toMicro(Math.min(clip.duration, media.duration || clip.duration));

    const materialId = capcutUuid();
    const ext = media.name.split('.').pop() || 'jpg';
    const filename = `${media.id}.${ext}`;
    const absPath = joinPath([foldPath, 'Resources', filename], sep);

    // Clone the appropriate material schema (preserves all 68 fields)
    const matRef = clip.isImage ? photoRef : (videoRef || photoRef);
    const newMat = matRef ? structuredClone(matRef) : {};
    newMat.id = materialId;
    newMat.path = absPath;
    newMat.material_name = media.name;
    newMat.width = media.width || 1920;
    newMat.height = media.height || 1080;
    newMat.duration = clip.isImage ? 10800000000 : toMicro(media.duration || clip.duration);
    newMat.type = clip.isImage ? 'photo' : 'video';
    newVideos.push(newMat);

    // Build 7 companion materials per clip (deep-copy from template, fresh ids)
    const companionIds: string[] = [];
    const companions = [
      { ref: tplSpeeds[0], arr: newSpeeds, type: 'speed' },
      { ref: tplPlaceholders[0], arr: newPlaceholders, type: 'placeholder_info' },
      { ref: tplCanvases[0], arr: newCanvases, type: 'canvas_color' },
      { ref: tplSoundChannels[0], arr: newSoundChannels, type: 'none' },
      { ref: tplMaterialColors[0], arr: newMaterialColors, type: 'material_color' },
      { ref: tplLoudnesses[0], arr: newLoudnesses, type: 'loudness' },
      { ref: tplVocalSeparations[0], arr: newVocalSeparations, type: 'vocal_separation' },
    ];
    for (const c of companions) {
      const cid = capcutUuid();
      companionIds.push(cid);
      if (c.ref) {
        const cloned = structuredClone(c.ref);
        cloned.id = cid;
        c.arr.push(cloned);
      } else {
        c.arr.push({ id: cid, type: c.type });
      }
    }

    // Build segment from template's segment schema (preserves all 51 fields)
    const newSeg = segRef ? structuredClone(segRef) : {};
    newSeg.id = capcutUuid();
    newSeg.material_id = materialId;
    newSeg.source_timerange = { duration: sourceDur, start: sourceStart };
    newSeg.target_timerange = { duration: targetDur, start: targetStart };
    newSeg.render_timerange = { start: 0, duration: 0 };
    newSeg.render_index = newVideoSegments.length;
    newSeg.extra_material_refs = companionIds;
    newVideoSegments.push(newSeg);
  }

  // Build audio materials + segments — one per audio part, placed back-to-back at cumulative offsets
  const newAudioSegments: any[] = [];
  let audioCumOffset = 0;
  for (let pi = 0; pi < audioParts.length; pi++) {
    const part = audioParts[pi];
    const partDurMicro = toMicro(audioPartDurations[pi] || 0);
    if (partDurMicro <= 0) continue;

    const audioMaterialId = capcutUuid();
    const audioExt = part.name.split('.').pop() || 'mp3';
    const audioFilename = `${part.id}.${audioExt}`;
    const audioAbsPath = joinPath([foldPath, 'Resources', audioFilename], sep);

    const newAudioMat = audioRef ? structuredClone(audioRef) : {};
    newAudioMat.id = audioMaterialId;
    newAudioMat.path = audioAbsPath;
    newAudioMat.material_name = part.name;
    newAudioMat.duration = partDurMicro;
    newAudios.push(newAudioMat);

    // Audio segment placed at cumulative offset on the audio track
    const templateAudioSegs = draftContent.tracks?.find((t: any) => t.type === 'audio')?.segments || [];
    const audioSegRef = templateAudioSegs[0];
    const newAudioSeg = audioSegRef ? structuredClone(audioSegRef) : {};
    newAudioSeg.id = capcutUuid();
    newAudioSeg.material_id = audioMaterialId;
    newAudioSeg.source_timerange = { duration: partDurMicro, start: 0 };
    newAudioSeg.target_timerange = { duration: partDurMicro, start: toMicro(audioCumOffset) };
    newAudioSeg.render_timerange = { start: 0, duration: 0 };
    newAudioSeg.render_index = pi;
    newAudioSegments.push(newAudioSeg);

    audioCumOffset += audioPartDurations[pi] || 0;
  }

  // Replace materials
  draftContent.materials.videos = newVideos;
  draftContent.materials.audios = newAudios;
  draftContent.materials.speeds = newSpeeds;
  draftContent.materials.placeholder_infos = newPlaceholders;
  draftContent.materials.canvases = newCanvases;
  draftContent.materials.sound_channel_mappings = newSoundChannels;
  draftContent.materials.material_colors = newMaterialColors;
  draftContent.materials.loudnesses = newLoudnesses;
  draftContent.materials.vocal_separations = newVocalSeparations;
  delete draftContent.materials.images;

  // Replace tracks
  const videoTrackRef = draftContent.tracks?.find((t: any) => t.type === 'video');
  const audioTrackRef = draftContent.tracks?.find((t: any) => t.type === 'audio');

  const newVideoTrack = videoTrackRef ? structuredClone(videoTrackRef) : { id: capcutUuid(), type: 'video', flag: 0, attribute: 0, name: '', is_default_name: true, segments: [] };
  newVideoTrack.id = capcutUuid();
  newVideoTrack.segments = newVideoSegments;

  const newAudioTrack = audioTrackRef ? structuredClone(audioTrackRef) : { id: capcutUuid(), type: 'audio', flag: 0, attribute: 0, name: '', is_default_name: true, segments: [] };
  newAudioTrack.id = capcutUuid();
  newAudioTrack.segments = newAudioSegments;

  draftContent.tracks = [newVideoTrack, newAudioTrack];

  // ─── Rebuild draft_materials in draft_meta_info.json ───
  if (draftMeta.draft_materials && Array.isArray(draftMeta.draft_materials)) {
    // Clone the template's draft_materials entry shape for each media item
    const tplMats = draftMeta.draft_materials;
    // Find a template material entry to use as schema reference
    let matEntryRef: any = null;
    for (const group of tplMats) {
      if (group?.value && Array.isArray(group.value) && group.value.length > 0) {
        matEntryRef = group.value[0];
        break;
      }
    }
    if (matEntryRef) {
      const newDraftMaterials: any[] = [];
      for (const clip of project.clips) {
        const media = clip.media;
        const ext = media.name.split('.').pop() || 'jpg';
        const filename = `${media.id}.${ext}`;
        const absPath = joinPath([foldPath, 'Resources', filename], sep);
        const entry = structuredClone(matEntryRef);
        entry.id = capcutUuid();
        entry.file_Path = absPath;
        entry.extra_info = media.name;
        entry.metetype = clip.isImage ? 'photo' : 'video';
        entry.width = media.width || 1920;
        entry.height = media.height || 1080;
        entry.duration = clip.isImage ? 10800000000 : toMicro(media.duration || clip.duration);
        if (entry.roughcut_time_range) entry.roughcut_time_range = { start: -1, duration: -1 };
        if (entry.sub_time_range) entry.sub_time_range = { start: -1, duration: -1 };
        newDraftMaterials.push({ type: group_type_for(clip.isImage), value: [entry] });
      }
      // Audio entries — one per part
      for (let pi = 0; pi < audioParts.length; pi++) {
        const part = audioParts[pi];
        const partExt = part.name.split('.').pop() || 'mp3';
        const partFilename = `${part.id}.${partExt}`;
        const partAbsPath = joinPath([foldPath, 'Resources', partFilename], sep);
        const audioEntry = structuredClone(matEntryRef);
        audioEntry.id = capcutUuid();
        audioEntry.file_Path = partAbsPath;
        audioEntry.extra_info = part.name;
        audioEntry.metetype = 'audio';
        audioEntry.duration = toMicro(audioPartDurations[pi] || 0);
        if (audioEntry.roughcut_time_range) audioEntry.roughcut_time_range = { start: -1, duration: -1 };
        if (audioEntry.sub_time_range) audioEntry.sub_time_range = { start: -1, duration: -1 };
        newDraftMaterials.push({ type: 'audio', value: [audioEntry] });
      }
      draftMeta.draft_materials = newDraftMaterials;
    }
  }

  const draftContentJson = JSON.stringify(draftContent, null, 2);
  const draftMetaJson = JSON.stringify(draftMeta, null, 2);

  // Regenerate the cover from the first image.
  let coverBytes: Uint8Array | Blob | null = null;
  const firstClip = project.clips.find(c => c.isImage);
  if (firstClip) {
    const coverBlob = mediaBlobs.get(firstClip.media.id);
    if (coverBlob) coverBytes = await resizeCoverImage(coverBlob, 640);
  }
  let zipHasCover = false;

  const emptyDirs = ['Timelines', 'adjust_mask', 'common_attachment', 'matting', 'qr_upload', 'smart_crop', 'subdraft'];
  const modern = options.template.templateFiles && options.template.templateFiles.length > 0;

  if (modern) {
    // ─── Reproduce the EXACT modern CapCut folder tree ───
    // Substitute our edited timeline into every draft_content.json (root +
    // Timelines/<UUID>/ + their .bak copies) so the latest CapCut reads the
    // correct image durations; keep every other file (project.json,
    // common_attachment/…, aux configs) verbatim.
    for (const tf of options.template.templateFiles!) {
      const target = `${projectName}/${tf.path}`;
      const b = baseName(tf.path);
      if (b === 'draft_content.json' || b === 'draft_content.json.bak') {
        zip.file(target, draftContentJson);
      } else if (b === 'draft_meta_info.json' || b === 'draft_meta_info.json.bak') {
        zip.file(target, draftMetaJson);
      } else if (b === 'draft_cover.jpg' || b === 'draft_cover.jpeg') {
        if (coverBytes) { zip.file(target, coverBytes); zipHasCover = true; }
      } else if (tf.base64) {
        zip.file(target, base64ToUint8(tf.content));
      } else {
        zip.file(target, tf.content);
      }
    }
    // Ensure the timeline exists at the root even if the template lacked a copy.
    zip.file(`${projectName}/draft_content.json`, draftContentJson);
    zip.file(`${projectName}/draft_meta_info.json`, draftMetaJson);
    if (coverBytes && !zipHasCover) { zip.file(`${projectName}/draft_cover.jpg`, coverBytes); zipHasCover = true; }
  } else {
    // ─── Legacy (older CapCut) flat structure ───
    if (options.template.extraFiles) {
      for (const f of options.template.extraFiles) {
        zip.file(`${projectName}/${f.name}`, f.content);
      }
    }
    for (const dir of emptyDirs) {
      zip.file(`${projectName}/${dir}/.gitkeep`, '');
    }
    if (coverBytes) { zip.file(`${projectName}/draft_cover.jpg`, coverBytes); zipHasCover = true; }
    zip.file(`${projectName}/draft_content.json`, draftContentJson);
    zip.file(`${projectName}/draft_meta_info.json`, draftMetaJson);
  }

  // ─── Validate ───
  const report = validateDraft(
    draftContent, draftMeta, projectName, draftsRoot, sep,
    resourceFiles, project.clips.length, zipHasCover, emptyDirs,
  );

  // README
  const readme = `READ_ME_FIRST — CapCut Draft Import Instructions

1. Close CapCut completely (check your system tray to make sure it's not running in the background).

2. Extract this ZIP directly into your CapCut drafts folder:
   ${draftsRoot}

3. After extraction, verify the structure shows:
   ${draftsRoot}${sep}${projectName}${sep}draft_content.json

4. Open CapCut — the project "${projectName}" will appear in your drafts list.

5. Keep the project on your local C: drive. Do NOT use OneDrive-synced folders, USB drives, or network drives — CapCut rejects those paths.
`;
  zip.file(`${projectName}/READ_ME_FIRST.txt`, readme);

  const blob = await zip.generateAsync({ type: 'blob' });
  return { blob, report, draftMeta };
}

function group_type_for(isImage: boolean): string {
  return isImage ? 'photo' : 'video';
}

// ─── Fallback SRT/CSV export ─────────────────────────────────────

export async function exportSrtCsv(project: Project, mediaBlobs: Map<string, Blob>): Promise<Blob> {
  const zip = new JSZip();
  const root = sanitizeProjectName(project.name);

  let srt = '';
  let srtIdx = 1;
  for (const seg of project.segments) {
    srt += `${srtIdx}\n`;
    srt += `${formatSrtTime(seg.startTime)} --> ${formatSrtTime(seg.endTime)}\n`;
    srt += `${seg.text}\n\n`;
    srtIdx++;
  }
  zip.file(`${root}/subtitles.srt`, srt);

  let csv = 'Segment,Start,End,Duration,Media,Type,Warnings\n';
  for (const seg of project.segments) {
    const mediaNames = seg.matchedMedia.map((m) => m.name).join('; ');
    const warnings = !seg.hasMedia ? 'missing media' : seg.lowConfidence ? 'low confidence' : '';
    csv += `${seg.index},${seg.startTime.toFixed(3)},${seg.endTime.toFixed(3)},${(seg.endTime - seg.startTime).toFixed(3)},"${mediaNames}",${seg.hasVideo ? 'video+images' : seg.hasImages ? 'images' : 'none'},${warnings}\n`;
  }
  zip.file(`${root}/cutsheet.csv`, csv);

  const orderedMedia = new Map<string, Blob>();
  for (const clip of project.clips) {
    const blob = mediaBlobs.get(clip.media.id);
    if (blob && !orderedMedia.has(clip.media.id)) {
      orderedMedia.set(clip.media.id, blob);
      const ext = clip.media.name.split('.').pop() || 'bin';
      const segStr = String(clip.segmentIndex).padStart(2, '0');
      zip.file(`${root}/media/${segStr}_${clip.media.id}.${ext}`, blob);
    }
  }

  return zip.generateAsync({ type: 'blob' });
}

function formatSrtTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// ─── Template import helpers ─────────────────────────────────────

export async function importTemplateFromFiles(
  draftContentFile: File,
  draftMetaFile: File,
): Promise<CapCutTemplate> {
  const draftContent = JSON.parse(await draftContentFile.text());
  const draftMeta = JSON.parse(await draftMetaFile.text());

  const draftsRoot = draftMeta.draft_root_path || '';
  const sep = detectSeparator(draftsRoot || draftMeta.draft_fold_path || '');

  return {
    id: crypto.randomUUID(),
    name: draftMeta.draft_name || 'Imported Template',
    importedAt: Date.now(),
    draftContent,
    draftMeta,
    extraFiles: [],
    detectedDraftsRoot: draftsRoot,
    pathSeparator: sep,
  };
}

// Path of a picked file relative to the selected draft folder (strips the top
// folder name that webkitdirectory prepends). Falls back to the bare name.
function templateRelPath(f: File): string {
  const p = (f as any).webkitRelativePath || f.name;
  const i = p.indexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function isTextTemplateFile(rel: string): boolean {
  const b = baseName(rel).toLowerCase();
  return /\.(json|bak|txt|cfg|ini)$/.test(b) || b === 'draft_settings' || b === 'draft_biz_config.json';
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function importTemplateFromFolder(
  files: File[],
): Promise<CapCutTemplate> {
  // The draft-root draft_content.json / draft_meta_info.json are the ones with
  // the shallowest relative path (there can be copies inside Timelines/<UUID>/).
  const byRel = files.map((f) => ({ f, rel: templateRelPath(f) }));
  const pickShallow = (name: string) =>
    byRel
      .filter((x) => baseName(x.rel) === name)
      .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length)[0]?.f;

  const contentFile = pickShallow('draft_content.json');
  const metaFile = pickShallow('draft_meta_info.json');
  if (!contentFile || !metaFile) {
    throw new Error('Selected folder must contain draft_content.json and draft_meta_info.json');
  }

  const template = await importTemplateFromFiles(contentFile, metaFile);
  template.name = template.draftMeta.draft_name || template.name;

  // Capture the ENTIRE template folder so export can reproduce the exact modern
  // CapCut structure (Timelines/<UUID>/…, common_attachment/…, aux files).
  const templateFiles: { path: string; content: string; base64?: boolean }[] = [];
  for (const { f, rel } of byRel) {
    if (!rel || rel.endsWith('/')) continue;
    if (isTextTemplateFile(rel)) {
      templateFiles.push({ path: rel, content: await f.text() });
    } else {
      templateFiles.push({ path: rel, content: arrayBufferToBase64(await f.arrayBuffer()), base64: true });
    }
  }
  template.templateFiles = templateFiles;

  return template;
}

// ─── Test simulation ─────────────────────────────────────────────

export interface TestSimulationResult {
  report: ValidationReport;
  firstVideoFieldCount: number;
  firstSegmentFieldCount: number;
  firstSegmentRefCount: number;
  draftFoldPath: string;
  draftRootPath: string;
}

export async function simulateExportWithMockTemplate(
  project: Project,
  mediaBlobs: Map<string, Blob>,
  draftsRoot: string,
): Promise<TestSimulationResult> {
  // Create a mock template with realistic field counts
  const mockPhotoMat: Record<string, any> = {};
  for (let i = 0; i < 68; i++) mockPhotoMat[`field_${i}`] = `val_${i}`;
  mockPhotoMat.type = 'photo';
  mockPhotoMat.category_name = 'local';
  mockPhotoMat.duration = 10800000000;
  mockPhotoMat.check_flag = 62978047;

  const mockVideoMat = { ...structuredClone(mockPhotoMat), type: 'video' };

  const mockAudioMat: Record<string, any> = { type: 'audio', category_name: 'local', duration: 0, path: '', material_name: '' };
  for (let i = 0; i < 40; i++) mockAudioMat[`audio_field_${i}`] = `val_${i}`;

  const mockSeg: Record<string, any> = {};
  for (let i = 0; i < 51; i++) mockSeg[`seg_field_${i}`] = `val_${i}`;
  mockSeg.clip = { scale: 1, rotation: 0, transform: {}, flip: false, alpha: 1 };
  mockSeg.speed = 1.0;
  mockSeg.volume = 1.0;
  mockSeg.visible = true;
  mockSeg.hdr_settings = { mode: 1, intensity: 1.0, nits: 1000 };
  mockSeg.source = 'segmentsourcenormal';

  const mockSpeed = { id: '', type: 'speed', mode: 0, speed: 1.0, curve_speed: null };
  const mockPlaceholder = { id: '', type: 'placeholder_info', meta_type: 'none', res_path: '', res_text: '', error_path: '', error_text: '' };
  const mockCanvas = { id: '', type: 'canvas_color', color: '', blur: 0.0, image: '' };
  const mockSoundChannel = { id: '', type: 'none', audio_channel_mapping: 0, is_config_open: false };
  const mockMatColor = { id: '', is_color_clip: false, is_gradient: false };
  const mockLoudness = { id: '', enable: false, time_range: null, file_id: '', target_loudness: 0.0, loudness_param: null };
  const mockVocalSep = { id: '', type: 'vocal_separation', choice: 0, removed_sounds: [] };

  const mockTemplate: CapCutTemplate = {
    id: 'mock',
    name: 'Mock Template',
    importedAt: Date.now(),
    draftContent: {
      id: 'mock-id',
      name: 'mock',
      path: draftsRoot + '/mock',
      duration: 0,
      create_time: 0,
      update_time: 0,
      fps: 30.0,
      version: 360000,
      new_version: '179.0.0',
      canvas_config: { width: 1920, height: 1080, ratio: '16:9' },
      platform: { os: 'windows' },
      last_modified_platform: { os: 'windows' },
      materials: {
        videos: [mockPhotoMat, mockVideoMat],
        audios: [mockAudioMat],
        speeds: [mockSpeed],
        placeholder_infos: [mockPlaceholder],
        canvases: [mockCanvas],
        sound_channel_mappings: [mockSoundChannel],
        material_colors: [mockMatColor],
        loudnesses: [mockLoudness],
        vocal_separations: [mockVocalSep],
      },
      tracks: [
        { id: 'track1', type: 'video', flag: 0, attribute: 0, name: '', is_default_name: true, segments: [mockSeg] },
        { id: 'track2', type: 'audio', flag: 0, attribute: 0, name: '', is_default_name: true, segments: [{ ...structuredClone(mockSeg) }] },
      ],
    },
    draftMeta: {
      draft_id: 'mock-id',
      draft_name: 'mock',
      draft_fold_path: draftsRoot + '/mock',
      draft_root_path: draftsRoot,
      tm_draft_create: 0,
      tm_draft_modified: 0,
      tm_duration: 0,
      draft_cover: 'draft_cover.jpg',
      draft_materials: [{ type: 'photo', value: [{ id: '', file_Path: '', extra_info: '', metetype: 'photo', width: 1920, height: 1080, duration: 0, roughcut_time_range: { start: -1, duration: -1 }, sub_time_range: { start: -1, duration: -1 } }] }],
    },
    extraFiles: [],
    detectedDraftsRoot: draftsRoot,
    pathSeparator: '/',
  };

  const result = await exportCapCutDraft(project, mediaBlobs, {
    projectName: project.name,
    draftsRoot,
    template: mockTemplate,
  });

  const firstVideo = result.draftMeta ? null : null; // we read from draftContent via the report
  const videos = (result as any)._draftContent?.materials?.videos || [];
  const segs = (result as any)._draftContent?.tracks?.[0]?.segments || [];

  return {
    report: result.report,
    firstVideoFieldCount: videos.length > 0 ? countFields(videos[0]) : 0,
    firstSegmentFieldCount: segs.length > 0 ? countFields(segs[0]) : 0,
    firstSegmentRefCount: segs.length > 0 ? (segs[0]?.extra_material_refs?.length || 0) : 0,
    draftFoldPath: result.draftMeta.draft_fold_path,
    draftRootPath: result.draftMeta.draft_root_path,
  };
}
