import { TranscriptWord } from '../types';
import { decodeTo16kMono, TranscriptionCancelled } from './audio';

const SR = 16000;
// whisper.cpp handles long audio, but we still transcribe in ~2-minute chunks
// so the progress bar moves and Skip can interrupt between chunks.
const CHUNK_S = 120;

interface NativeBridge {
  nativeAvailable: () => Promise<boolean>;
  nativeTranscribe: (
    wavBuffer: ArrayBuffer,
  ) => Promise<{ ok: boolean; error?: string; words?: { word: string; start: number; end: number }[] }>;
}

function bridge(): NativeBridge | null {
  const b = (window as any).autocapcut;
  return b && typeof b.nativeTranscribe === 'function' ? b : null;
}

/** Whether the bundled native engine is present (desktop app only). */
export async function nativeAvailable(): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  try {
    return await b.nativeAvailable();
  } catch {
    return false;
  }
}

/** Encode 16 kHz mono Float32 samples as a 16-bit PCM WAV ArrayBuffer. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/**
 * Transcribe each audio part with the bundled native whisper.cpp engine,
 * shifting timestamps by each part's cumulative offset.
 */
export async function transcribeNative(
  audioBlobs: Blob[],
  offsets: number[],
  onProgress?: (part: number, total: number, fraction: number) => void,
  shouldCancel?: () => boolean,
): Promise<TranscriptWord[]> {
  const b = bridge();
  if (!b) throw new Error('Native transcription is only available in the desktop app.');

  const all: TranscriptWord[] = [];
  for (let i = 0; i < audioBlobs.length; i++) {
    onProgress?.(i, audioBlobs.length, 0);
    const partOffset = offsets[i] || 0;
    const samples = await decodeTo16kMono(audioBlobs[i]);
    const chunkSize = CHUNK_S * SR;
    const chunkCount = Math.max(1, Math.ceil(samples.length / chunkSize));

    for (let c = 0; c < chunkCount; c++) {
      if (shouldCancel?.()) throw new TranscriptionCancelled();
      const startSample = c * chunkSize;
      const slice = samples.subarray(startSample, Math.min(startSample + chunkSize, samples.length));
      const wav = encodeWav(slice, SR);
      const chunkOffsetSec = startSample / SR;

      const res = await b.nativeTranscribe(wav);
      if (!res.ok) throw new Error(res.error || 'Native transcription failed');

      for (const w of res.words || []) {
        const text = (w.word || '').trim();
        if (!text) continue;
        all.push({
          word: text,
          start: w.start + chunkOffsetSec + partOffset,
          end: w.end + chunkOffsetSec + partOffset,
        });
      }
      onProgress?.(i, audioBlobs.length, (c + 1) / chunkCount);
    }
    onProgress?.(i, audioBlobs.length, 1);
  }

  all.sort((a, b2) => a.start - b2.start);
  return all;
}
