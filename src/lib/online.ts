import { TranscriptWord } from '../types';
import { decodeTo16kMono, TranscriptionCancelled } from './audio';

const SR = 16000;
// Upload ~5-minute WAV chunks: well under Groq's file-size limit, and gives
// frequent progress updates for long recordings.
const CHUNK_S = 300;

interface GroqBridge {
  groqTranscribe: (
    apiKey: string,
    wavBuffer: ArrayBuffer,
    model?: string,
  ) => Promise<{ ok: boolean; error?: string; words?: any[]; segments?: any[]; text?: string }>;
}

function bridge(): GroqBridge | null {
  const b = (window as any).autocapcut;
  return b && typeof b.groqTranscribe === 'function' ? b : null;
}

/** Online transcription is only wired up in the desktop app (needs the IPC bridge). */
export function onlineAvailable(): boolean {
  return bridge() !== null;
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

function wordsFrom(res: { words?: any[]; segments?: any[] }): { word: string; start: number; end: number }[] {
  if (res.words && res.words.length) {
    return res.words.map((w) => ({
      word: (w.word ?? w.text ?? '').toString(),
      start: Number(w.start) || 0,
      end: Number(w.end) || 0,
    }));
  }
  // Fall back to segment-level timing if word timestamps aren't present.
  return (res.segments || []).map((s) => ({
    word: (s.text ?? '').toString(),
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
  }));
}

/**
 * Transcribe each audio part via Groq, shifting timestamps by each part's
 * cumulative offset. Decodes locally to 16 kHz mono, uploads ~5-minute WAV
 * chunks, and merges the returned word timings.
 */
export async function transcribeOnline(
  audioBlobs: Blob[],
  offsets: number[],
  apiKey: string,
  onProgress?: (part: number, total: number, fraction: number) => void,
  shouldCancel?: () => boolean,
): Promise<TranscriptWord[]> {
  const b = bridge();
  if (!b) throw new Error('Online transcription is only available in the desktop app.');

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

      const res = await b.groqTranscribe(apiKey, wav, 'whisper-large-v3-turbo');
      if (!res.ok) throw new Error(res.error || 'Groq request failed');

      for (const w of wordsFrom(res)) {
        const text = w.word.trim();
        if (!text) continue;
        const start = w.start + chunkOffsetSec + partOffset;
        const end = (w.end || w.start + 0.3) + chunkOffsetSec + partOffset;
        all.push({ word: text, start, end });
      }
      onProgress?.(i, audioBlobs.length, (c + 1) / chunkCount);
    }
    onProgress?.(i, audioBlobs.length, 1);
  }

  all.sort((a, b2) => a.start - b2.start);
  return all;
}
