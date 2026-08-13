import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { Clip, ClipAnimationConfig, ClipTransition, VideoExportSettings, ResolutionPreset, AspectRatio, ImageFit } from '../types';
import { computeTransform, FrameTransform } from './animations';
import { transitionLayers, transitionFlash, TRANS_NONE_ID } from './transitions';

// ─────────────────────────────────────────────────────────────────
// Canvas renderer + standalone MP4 exporter.
//
// The whole point: render the slideshow + animations ourselves, so the app
// produces a finished MP4 with NO CapCut and NO external tools. Encoding uses
// the browser/Electron WebCodecs API (hardware-accelerated H.264) muxed to MP4
// with mp4-muxer. The same drawFrame() powers the live preview.
// ─────────────────────────────────────────────────────────────────

// Resolution presets are anchored on the frame's SHORT side (height for
// landscape). Actual width/height are derived from the chosen aspect ratio.
export const RESOLUTIONS: Record<ResolutionPreset, { h: number; label: string; bitrate: number }> = {
  '480p': { h: 480, label: '480p', bitrate: 2_500_000 },
  '720p': { h: 720, label: '720p (HD)', bitrate: 5_000_000 },
  '1080p': { h: 1080, label: '1080p (Full HD)', bitrate: 10_000_000 },
  '2k': { h: 1440, label: '2K (QHD)', bitrate: 18_000_000 },
};

const ASPECT: Record<AspectRatio, [number, number]> = {
  '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:3': [4, 3],
};

/** Frame pixel dimensions for a resolution + aspect ratio (both even). */
export function frameDims(resolution: ResolutionPreset, aspect: AspectRatio): { w: number; h: number } {
  const base = RESOLUTIONS[resolution].h;
  const [aw, ah] = ASPECT[aspect];
  // Anchor the base on the taller side so portrait keeps its detail.
  let h: number, w: number;
  if (ah >= aw) { h = base * (aspect === '9:16' ? 16 / 9 : 1); w = Math.round((h * aw) / ah); }
  else { h = base; w = Math.round((h * aw) / ah); }
  const even = (n: number) => (Math.round(n) % 2 === 0 ? Math.round(n) : Math.round(n) + 1);
  return { w: even(w), h: even(h) };
}

/** Anything the 2D canvas can draw from. */
export type DrawSource = ImageBitmap | HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas;

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function srcDims(src: DrawSource): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth || 1920, h: src.videoHeight || 1080 };
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
    return { w: src.naturalWidth || 1920, h: src.naturalHeight || 1080 };
  }
  return { w: (src as any).width || 1920, h: (src as any).height || 1080 };
}

/**
 * Draw one composited layer: optionally a black background, then the source
 * fitted to the frame with the given transform applied about the centre.
 */
export function drawFrame(
  ctx: Ctx2D,
  src: DrawSource | null,
  transform: FrameTransform,
  W: number,
  H: number,
  fit: ImageFit = 'cover',
  clearBg = true,
): void {
  if (clearBg) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  if (!src) return;

  const { w: sw, h: sh } = srcDims(src);
  if (sw <= 0 || sh <= 0) return;

  let dw: number, dh: number;
  if (fit === 'fill') {
    dw = W; dh = H;
  } else {
    const f = fit === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
    dw = sw * f; dh = sh * f;
  }

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity));
  ctx.translate(W / 2 + transform.translateX * W, H / 2 + transform.translateY * H);
  ctx.rotate(transform.rotate);
  ctx.scale(transform.scale, transform.scale);
  try {
    ctx.drawImage(src as CanvasImageSource, -dw / 2, -dh / 2, dw, dh);
  } catch {
    /* source not yet decodable this frame — skip */
  }
  ctx.restore();
}

/** Find the clip covering a global time (seconds). */
export function clipAt(clips: Clip[], time: number): Clip | null {
  for (const c of clips) {
    if (time >= c.start && time < c.start + c.duration) return c;
  }
  return clips.length ? clips[clips.length - 1] : null;
}

/** Stable per-clip key for looking up animation config. */
export function clipKey(clip: Clip): string {
  return clip.media.id;
}

export interface TimelineRenderCtx {
  clips: Clip[];
  animCfgs: Record<string, ClipAnimationConfig>;
  transitions: Record<string, ClipTransition>;
  /** resolve the drawable source for a media id (image bitmap or video element) */
  getSource: (mediaId: string) => DrawSource | null;
  W: number;
  H: number;
  fit: ImageFit;
}

/**
 * The one function that composites a full timeline frame — animation +
 * transitions + fit. Shared by the live preview and the MP4 exporter so the
 * preview is a faithful proof of the export.
 */
export function renderTimelineFrame(ctx: Ctx2D, time: number, r: TimelineRenderCtx): void {
  const clip = clipAt(r.clips, time);
  if (!clip) {
    ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, r.W, r.H); ctx.restore();
    return;
  }
  const idx = r.clips.indexOf(clip);
  const tcfg = r.transitions?.[clip.media.id];

  // Inside a transition window at the start of this clip → composite prev+curr.
  if (tcfg && tcfg.transId !== TRANS_NONE_ID && tcfg.duration > 0 && idx > 0 && time < clip.start + tcfg.duration) {
    const prev = r.clips[idx - 1];
    const p = (time - clip.start) / tcfg.duration;
    // black base
    ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, r.W, r.H); ctx.restore();
    for (const layer of transitionLayers(tcfg.transId, p)) {
      const c = layer.which === 'prev' ? prev : clip;
      const localT = layer.which === 'prev'
        ? Math.min(time - prev.start, prev.duration)
        : time - clip.start;
      const base = computeTransform(r.animCfgs[c.media.id], localT, c.duration);
      const merged: FrameTransform = {
        scale: base.scale * layer.scale,
        translateX: base.translateX + layer.dx,
        translateY: base.translateY + layer.dy,
        rotate: base.rotate + (layer.rotate || 0),
        opacity: base.opacity * layer.alpha,
      };
      drawFrame(ctx, r.getSource(c.media.id), merged, r.W, r.H, r.fit, false);
    }
    const flash = transitionFlash(tcfg.transId, p);
    if (flash && flash.alpha > 0) {
      ctx.save(); ctx.globalAlpha = Math.min(1, flash.alpha); ctx.fillStyle = flash.color;
      ctx.fillRect(0, 0, r.W, r.H); ctx.restore();
    }
    return;
  }

  // Normal single-clip frame.
  const transform = computeTransform(r.animCfgs[clip.media.id], time - clip.start, clip.duration);
  drawFrame(ctx, r.getSource(clip.media.id), transform, r.W, r.H, r.fit, true);
}

// ─── MP4 export ──────────────────────────────────────────────────

export interface CancelSignal { cancelled: boolean }

export interface VideoExportInput {
  clips: Clip[];
  audioDuration: number;
  clipAnimations: Record<string, ClipAnimationConfig>;
  transitions?: Record<string, ClipTransition>;
  /** decoded images keyed by media id */
  imageBitmaps: Map<string, DrawSource>;
  /** optional seekable <video> elements keyed by media id */
  videoElements?: Map<string, HTMLVideoElement>;
  /** concatenated audio (all parts) — may be null for silent export */
  audioBuffer: AudioBuffer | null;
  settings: VideoExportSettings;
  onProgress?: (fraction: number, message: string) => void;
  signal?: CancelSignal;
}

export function webCodecsAvailable(): boolean {
  return typeof (globalThis as any).VideoEncoder === 'function'
    && typeof (globalThis as any).VideoFrame === 'function';
}

async function pickAvcCodec(width: number, height: number, fps: number, bitrate: number): Promise<string> {
  const VE: any = (globalThis as any).VideoEncoder;
  const candidates = [
    'avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.64002a',
    'avc1.640028', 'avc1.4d0028', 'avc1.42001f',
  ];
  for (const codec of candidates) {
    try {
      const support = await VE.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
      if (support?.supported) return codec;
    } catch { /* try next */ }
  }
  return 'avc1.42001f'; // baseline fallback
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    if (Math.abs(video.currentTime - time) < 0.001) { resolve(); return; }
    video.addEventListener('seeked', done, { once: true });
    try { video.currentTime = time; } catch { resolve(); }
    // Safety timeout so a stuck seek can't hang the whole export.
    setTimeout(() => resolve(), 400);
  });
}

/**
 * Render the timeline to an MP4 Blob. Video is drawn frame-by-frame with the
 * assigned animations; audio (all parts, already concatenated) is AAC-encoded
 * and muxed in.
 */
export async function exportVideo(input: VideoExportInput): Promise<Blob> {
  if (!webCodecsAvailable()) {
    throw new Error('In-app video encoding needs WebCodecs (Chromium / the desktop app). Please export from the AutoCapcut desktop app.');
  }

  const { clips, audioDuration, clipAnimations, imageBitmaps, videoElements, audioBuffer, settings } = input;
  const transitions = input.transitions || {};
  const fit: ImageFit = settings.imageFit || 'cover';
  const res = RESOLUTIONS[settings.resolution];
  const { w: W, h: H } = frameDims(settings.resolution, settings.aspectRatio || '16:9');
  const fps = settings.fps;
  const total = Math.max(audioDuration, clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0));
  if (total <= 0) throw new Error('Nothing to export — the timeline is empty.');
  const totalFrames = Math.max(1, Math.ceil(total * fps));

  const report = (f: number, m: string) => input.onProgress?.(Math.max(0, Math.min(1, f)), m);
  const checkCancel = () => { if (input.signal?.cancelled) throw new Error('Export cancelled'); };

  // Canvas
  const canvas: any = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(W, H)
    : Object.assign(document.createElement('canvas'), { width: W, height: H });
  // alpha:false lets the compositor skip per-pixel blending work — faster.
  const ctx = canvas.getContext('2d', { alpha: false }) as Ctx2D;
  if (!ctx) throw new Error('Could not create a 2D canvas context for rendering.');

  // Audio config
  const hasAudio = !!audioBuffer && audioBuffer.length > 0;
  const sampleRate = hasAudio ? audioBuffer!.sampleRate : 48000;
  const channels = hasAudio ? Math.min(audioBuffer!.numberOfChannels, 2) : 2;

  // Muxer
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    ...(hasAudio ? { audio: { codec: 'aac', numberOfChannels: channels, sampleRate } } : {}),
    fastStart: 'in-memory',
  } as any);

  // Encoders
  const VideoEncoderCtor: any = (globalThis as any).VideoEncoder;
  const VideoFrameCtor: any = (globalThis as any).VideoFrame;
  const codec = await pickAvcCodec(W, H, fps, res.bitrate);

  let encoderError: any = null;
  const videoEncoder = new VideoEncoderCtor({
    output: (chunk: any, meta: any) => muxer.addVideoChunk(chunk, meta),
    error: (e: any) => { encoderError = e; },
  });
  videoEncoder.configure({ codec, width: W, height: H, bitrate: res.bitrate, framerate: fps });

  // Source provider for the unified renderer.
  const getSource = (mediaId: string): DrawSource | null =>
    imageBitmaps.get(mediaId) || videoElements?.get(mediaId) || null;
  const renderCtx: TimelineRenderCtx = { clips, animCfgs: clipAnimations, transitions, getSource, W, H, fit };

  // ── Video frames ──
  const frameDurUs = 1_000_000 / fps;
  let lastYield = performance.now();
  for (let i = 0; i < totalFrames; i++) {
    if (encoderError) throw new Error(`Video encoder error: ${encoderError.message || encoderError}`);

    const time = i / fps;
    // Seek the current clip's video (if any) so it shows the right frame.
    const cur = clipAt(clips, time);
    if (cur && !cur.isImage) {
      const v = videoElements?.get(cur.media.id);
      if (v) {
        const seekTarget = cur.sourceTrimStart + (time - cur.start);
        if (Math.abs(v.currentTime - seekTarget) > 0.06) await seekVideo(v, seekTarget);
      }
    }

    renderTimelineFrame(ctx, time, renderCtx);

    const frame = new VideoFrameCtor(canvas, { timestamp: Math.round(i * frameDurUs), duration: Math.round(frameDurUs) });
    // Keyframe every 2s for good seeking without bloating size.
    videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();

    // Backpressure: let the encoder drain if its queue grows too deep.
    if (videoEncoder.encodeQueueSize > 30) {
      while (videoEncoder.encodeQueueSize > 10) {
        await new Promise((r) => setTimeout(r));
        checkCancel();
      }
    }
    // Yield roughly every 120ms of wall-clock so the UI/progress stay live
    // without the per-frame await overhead that made exports crawl.
    const now = performance.now();
    if (now - lastYield > 120) {
      report((i / totalFrames) * 0.8, `Rendering video — frame ${i + 1}/${totalFrames}`);
      await new Promise((r) => setTimeout(r));
      checkCancel();
      lastYield = performance.now();
    }
  }
  await videoEncoder.flush();
  report(0.85, 'Video track done');

  // ── Audio ──
  if (hasAudio) {
    checkCancel();
    const AudioEncoderCtor: any = (globalThis as any).AudioEncoder;
    const AudioDataCtor: any = (globalThis as any).AudioData;
    if (AudioEncoderCtor && AudioDataCtor) {
      let audioErr: any = null;
      const audioEncoder = new AudioEncoderCtor({
        output: (chunk: any, meta: any) => muxer.addAudioChunk(chunk, meta),
        error: (e: any) => { audioErr = e; },
      });
      audioEncoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 128_000 });

      const totalSamples = audioBuffer!.length;
      const chunkFrames = 4096;
      const chData: Float32Array[] = [];
      for (let c = 0; c < channels; c++) chData.push(audioBuffer!.getChannelData(c));

      for (let offset = 0; offset < totalSamples; offset += chunkFrames) {
        checkCancel();
        if (audioErr) throw new Error(`Audio encoder error: ${audioErr.message || audioErr}`);
        const n = Math.min(chunkFrames, totalSamples - offset);
        // planar f32: [ch0 samples..., ch1 samples...]
        const planar = new Float32Array(n * channels);
        for (let c = 0; c < channels; c++) {
          planar.set(chData[c].subarray(offset, offset + n), c * n);
        }
        const audioData = new AudioDataCtor({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: n,
          numberOfChannels: channels,
          timestamp: Math.round((offset / sampleRate) * 1_000_000),
          data: planar,
        });
        audioEncoder.encode(audioData);
        audioData.close();
        if ((offset / chunkFrames) % 20 === 0) {
          report(0.85 + (offset / totalSamples) * 0.1, 'Encoding audio…');
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      await audioEncoder.flush();
    }
  }

  report(0.97, 'Finalizing MP4…');
  muxer.finalize();
  const buffer: ArrayBuffer = (target as any).buffer;
  scrubFingerprint(buffer);
  report(1, 'Done');
  return new Blob([buffer], { type: 'video/mp4' });
}

// The muxer writes its own name ("mp4-muxer-hdlr") into each track's handler
// box — a tool fingerprint. Overwrite it in-place with a neutral, generic ISO
// handler name (same byte length, so box sizes stay valid). We do not fake any
// other editor's identity; we only remove the machine tag.
function scrubFingerprint(buffer: ArrayBuffer): void {
  const bytes = new Uint8Array(buffer);
  const needle = 'mp4-muxer-hdlr';
  const replacement = 'ISO Media file'; // exactly 14 chars, same as the needle
  const find = [...needle].map((c) => c.charCodeAt(0));
  for (let i = 0; i <= bytes.length - find.length; i++) {
    let match = true;
    for (let j = 0; j < find.length; j++) {
      if (bytes[i + j] !== find[j]) { match = false; break; }
    }
    if (match) {
      for (let j = 0; j < replacement.length; j++) bytes[i + j] = replacement.charCodeAt(j);
      i += find.length - 1;
    }
  }
}
