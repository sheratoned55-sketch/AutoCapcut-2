import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { Clip, ClipAnimationConfig, VideoExportSettings, ResolutionPreset } from '../types';
import { computeTransform, FrameTransform } from './animations';

// ─────────────────────────────────────────────────────────────────
// Canvas renderer + standalone MP4 exporter.
//
// The whole point: render the slideshow + animations ourselves, so the app
// produces a finished MP4 with NO CapCut and NO external tools. Encoding uses
// the browser/Electron WebCodecs API (hardware-accelerated H.264) muxed to MP4
// with mp4-muxer. The same drawFrame() powers the live preview.
// ─────────────────────────────────────────────────────────────────

export const RESOLUTIONS: Record<ResolutionPreset, { w: number; h: number; label: string; bitrate: number }> = {
  '480p': { w: 854, h: 480, label: '480p', bitrate: 2_500_000 },
  '720p': { w: 1280, h: 720, label: '720p (HD)', bitrate: 5_000_000 },
  '1080p': { w: 1920, h: 1080, label: '1080p (Full HD)', bitrate: 10_000_000 },
  '2k': { w: 2560, h: 1440, label: '2K (QHD)', bitrate: 18_000_000 },
};

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
 * Draw one composited frame: a black background, then the source scaled to
 * "cover" the canvas, with the animation transform applied about the centre.
 */
export function drawFrame(
  ctx: Ctx2D,
  src: DrawSource | null,
  transform: FrameTransform,
  W: number,
  H: number,
): void {
  // Opaque black background (letterbox + transparent-PNG safety).
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  if (!src) return;

  const { w: sw, h: sh } = srcDims(src);
  if (sw <= 0 || sh <= 0) return;

  const cover = Math.max(W / sw, H / sh);
  const dw = sw * cover;
  const dh = sh * cover;

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

/** Render a single clip's frame for the live preview canvas. */
export function renderPreviewFrame(
  ctx: Ctx2D,
  clip: Clip | null,
  src: DrawSource | null,
  globalTime: number,
  cfg: ClipAnimationConfig | undefined,
  W: number,
  H: number,
): void {
  if (!clip) {
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    return;
  }
  const localTime = globalTime - clip.start;
  const transform = computeTransform(cfg, localTime, clip.duration);
  drawFrame(ctx, src, transform, W, H);
}

// ─── MP4 export ──────────────────────────────────────────────────

export interface CancelSignal { cancelled: boolean }

export interface VideoExportInput {
  clips: Clip[];
  audioDuration: number;
  clipAnimations: Record<string, ClipAnimationConfig>;
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
  const res = RESOLUTIONS[settings.resolution];
  const W = res.w, H = res.h;
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
  const ctx = canvas.getContext('2d') as Ctx2D;
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

  // ── Video frames ──
  const frameDurUs = 1_000_000 / fps;
  let lastSeekedVideoId = '';
  for (let i = 0; i < totalFrames; i++) {
    checkCancel();
    if (encoderError) throw new Error(`Video encoder error: ${encoderError.message || encoderError}`);

    const time = i / fps;
    const clip = clipAt(clips, time);
    let src: DrawSource | null = null;
    if (clip) {
      if (clip.isImage) {
        src = imageBitmaps.get(clip.media.id) || null;
      } else {
        const v = videoElements?.get(clip.media.id) || null;
        if (v) {
          const seekTarget = clip.sourceTrimStart + (time - clip.start);
          if (clip.media.id !== lastSeekedVideoId || Math.abs(v.currentTime - seekTarget) > 0.05) {
            await seekVideo(v, seekTarget);
            lastSeekedVideoId = clip.media.id;
          }
          src = v;
        }
      }
    }
    const cfg = clip ? clipAnimations[clip.media.id] : undefined;
    const transform = clip ? computeTransform(cfg, time - clip.start, clip.duration) : { scale: 1, translateX: 0, translateY: 0, rotate: 0, opacity: 1 };
    drawFrame(ctx, src, transform, W, H);

    const frame = new VideoFrameCtor(canvas, { timestamp: Math.round(i * frameDurUs), duration: Math.round(frameDurUs) });
    videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();

    // Backpressure + keep the UI responsive.
    if (videoEncoder.encodeQueueSize > 8) {
      while (videoEncoder.encodeQueueSize > 4) {
        await new Promise((r) => setTimeout(r, 4));
        checkCancel();
      }
    }
    if (i % 10 === 0) {
      report((i / totalFrames) * 0.8, `Rendering video — frame ${i + 1}/${totalFrames}`);
      await new Promise((r) => setTimeout(r, 0));
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
  report(1, 'Done');
  return new Blob([buffer], { type: 'video/mp4' });
}
