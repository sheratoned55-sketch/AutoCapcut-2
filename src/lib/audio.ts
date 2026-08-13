import { TranscriptWord } from '../types';

export async function decodeAudioFile(file: File | Blob): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new AudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();
  return audioBuffer;
}

export async function decodeAndConcatAudio(files: (File | Blob)[], onProgress?: (done: number, total: number) => void): Promise<AudioBuffer> {
  const ctx = new AudioContext();
  const buffers: AudioBuffer[] = [];

  for (let i = 0; i < files.length; i++) {
    const arrayBuffer = await files[i].arrayBuffer();
    const buf = await ctx.decodeAudioData(arrayBuffer);
    buffers.push(buf);
    onProgress?.(i + 1, files.length);
  }

  if (buffers.length === 1) {
    ctx.close();
    return buffers[0];
  }

  // compute total length and sample rate
  const sampleRate = buffers[0].sampleRate;
  const numChannels = Math.max(...buffers.map(b => b.numberOfChannels));
  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);

  const combined = ctx.createBuffer(numChannels, totalLength, sampleRate);
  let offset = 0;
  for (const buf of buffers) {
    for (let ch = 0; ch < numChannels; ch++) {
      const srcData = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      combined.getChannelData(ch).set(srcData, offset);
    }
    offset += buf.length;
  }

  ctx.close();
  return combined;
}

/** Decode each audio part separately, returning per-part durations and the combined AudioBuffer. */
export async function decodeAudioParts(
  files: (File | Blob)[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ buffer: AudioBuffer; durations: number[] }> {
  const ctx = new AudioContext();
  const buffers: AudioBuffer[] = [];
  const durations: number[] = [];

  for (let i = 0; i < files.length; i++) {
    const arrayBuffer = await files[i].arrayBuffer();
    const buf = await ctx.decodeAudioData(arrayBuffer);
    buffers.push(buf);
    durations.push(buf.duration);
    onProgress?.(i + 1, files.length);
  }

  if (buffers.length === 1) {
    ctx.close();
    return { buffer: buffers[0], durations };
  }

  const sampleRate = buffers[0].sampleRate;
  const numChannels = Math.max(...buffers.map(b => b.numberOfChannels));
  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);

  const combined = ctx.createBuffer(numChannels, totalLength, sampleRate);
  let offset = 0;
  for (const buf of buffers) {
    for (let ch = 0; ch < numChannels; ch++) {
      const srcData = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      combined.getChannelData(ch).set(srcData, offset);
    }
    offset += buf.length;
  }

  ctx.close();
  return { buffer: combined, durations };
}

/** Build cumulative offset table from per-part durations. */
export function buildPartOffsets(durations: number[]): number[] {
  const offsets: number[] = [];
  let cum = 0;
  for (const d of durations) {
    offsets.push(cum);
    cum += d;
  }
  return offsets;
}

/** Transcribe each audio part separately, shifting timestamps by each part's cumulative offset. */
export async function transcribeAudioParts(
  audioBlobs: Blob[],
  offsets: number[],
  onModelProgress?: (progress: { progress: number }) => void,
  onPartProgress?: (part: number, total: number, fraction: number) => void,
  shouldCancel?: () => boolean,
): Promise<TranscriptWord[]> {
  const allWords: TranscriptWord[] = [];

  for (let i = 0; i < audioBlobs.length; i++) {
    onPartProgress?.(i, audioBlobs.length, 0);
    const offset = offsets[i] || 0;
    const words = await transcribeAudio(
      audioBlobs[i],
      onModelProgress,
      (fraction) => onPartProgress?.(i, audioBlobs.length, fraction),
      shouldCancel,
    );
    for (const w of words) {
      allWords.push({
        word: w.word,
        start: w.start + offset,
        end: w.end + offset,
      });
    }
    onPartProgress?.(i, audioBlobs.length, 1);
  }

  // Sort by start time (parts are already in order, but just in case)
  allWords.sort((a, b) => a.start - b.start);
  return allWords;
}

export interface SilenceInfo {
  time: number; // center of silence in seconds
  start: number; // when the pause begins (speech stops)
  end: number; // when the pause ends (speech resumes) — the boundary we snap to
  duration: number;
}

export function detectSilences(audioBuffer: AudioBuffer, threshold = 0.02, minSilenceDuration = 0.3): SilenceInfo[] {
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);
  const blockSize = Math.floor(sampleRate * 0.05); // 50ms blocks
  const silences: SilenceInfo[] = [];

  let silenceStart = -1;
  for (let i = 0; i < channelData.length; i += blockSize) {
    let sum = 0;
    const end = Math.min(i + blockSize, channelData.length);
    for (let j = i; j < end; j++) {
      sum += channelData[j] * channelData[j];
    }
    const rms = Math.sqrt(sum / (end - i));

    if (rms < threshold) {
      if (silenceStart === -1) silenceStart = i;
    } else {
      if (silenceStart !== -1) {
        const startSec = silenceStart / sampleRate;
        const endSec = i / sampleRate;
        const silenceDuration = endSec - startSec;
        if (silenceDuration >= minSilenceDuration) {
          silences.push({
            time: (startSec + endSec) / 2,
            start: startSec,
            end: endSec,
            duration: silenceDuration,
          });
        }
        silenceStart = -1;
      }
    }
  }
  return silences;
}

/**
 * Snap a segment's start (a Whisper first-word time) to the pause that PRECEDES
 * that word, so the image appears exactly when the new segment's speech begins.
 *
 * A narration segment starts right after a pause, so we search BACKWARD for the
 * nearest silence whose END (when speech resumes) is <= the word start, within
 * `window` seconds. The silence END is used as the boundary. Only if no pause
 * exists behind the word within the window do we fall forward to the nearest
 * pause ahead. The 1.5s cap keeps it from grabbing a pause 6-8s away.
 */
export function snapStartToSilence(wordStart: number, silences: SilenceInfo[], window = 1.5): number {
  if (!silences.length) return wordStart;
  let bestBack = -Infinity;
  for (const s of silences) {
    // pause that ends at/just before the word begins
    if (s.end <= wordStart + 0.05 && s.end >= wordStart - window && s.end > bestBack) {
      bestBack = s.end;
    }
  }
  if (bestBack !== -Infinity) return bestBack;

  // Fallback: nearest pause ahead within the window (use its END too).
  let bestFwd = Infinity;
  for (const s of silences) {
    if (s.end > wordStart && s.end <= wordStart + window && s.end < bestFwd) {
      bestFwd = s.end;
    }
  }
  return bestFwd !== Infinity ? bestFwd : wordStart;
}

export function snapToSilence(time: number, silences: SilenceInfo[], window = 1.5): number {
  return snapStartToSilence(time, silences, window);
}

export function getAudioDuration(audioBuffer: AudioBuffer): number {
  return audioBuffer.duration;
}

// ─── Whisper transcription via Transformers.js ───────────────

let whisperPipeline: any = null;
let whisperLoadPromise: Promise<any> | null = null;

export async function loadWhisperModel(
  onProgress?: (progress: { progress: number }) => void,
): Promise<any> {
  if (whisperPipeline) return whisperPipeline;
  if (whisperLoadPromise) return whisperLoadPromise;

  whisperLoadPromise = (async () => {
    const transformers = await import('@xenova/transformers');
    const { pipeline, env } = transformers;

    // Both the Whisper model AND the ONNX-runtime WASM binaries are bundled
    // with the app (dist/models and dist/ort, populated at build time) and
    // loaded from paths relative to the current document. This means the very
    // first transcription needs NO network at all — nothing to download, so it
    // can never stall on "Loading model". If the bundled model is somehow
    // missing, transformers.js falls back to downloading it from Hugging Face.
    //
    // IMPORTANT: mutate env.backends.onnx (the live onnxruntime env object);
    // replacing env.backends with a new object silently disconnects these
    // settings from onnxruntime and WASM loading fails.
    env.allowLocalModels = true;
    env.useBrowserCache = false;
    (env as any).localModelPath = new URL('models/', document.baseURI).href;
    env.backends.onnx.wasm.wasmPaths = new URL('ort/', document.baseURI).href;
    // Single-threaded: the WASM pthread path is unreliable here and gave no
    // real speedup in testing. Transcription still runs faster than realtime,
    // and the UI now shows steady progress (see transcribeAudio).
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;

    whisperPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      progress_callback: (data: any) => {
        if (data.status === 'progress' && onProgress) {
          onProgress({ progress: data.progress || 0 });
        } else if (data.status === 'initiate') {
          onProgress?.({ progress: 5 });
        } else if (data.status === 'download') {
          onProgress?.({ progress: 10 });
        } else if (data.status === 'ready') {
          onProgress?.({ progress: 95 });
        }
      },
    });
    return whisperPipeline;
  })();

  return whisperLoadPromise;
}

const WHISPER_SR = 16000;
// Transcribe one 30s window at a time (Whisper's native chunk size). Small
// windows give frequent progress updates and, crucially, a checkpoint between
// each one where the user can cancel — so transcription is never a black box
// you can't get out of.
const TRANSCRIBE_WINDOW_S = 30;

export class TranscriptionCancelled extends Error {
  constructor() {
    super('Transcription cancelled');
    this.name = 'TranscriptionCancelled';
  }
}

/** Reject if a promise doesn't settle within `ms`, so a hung step can't freeze the app forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Decode any audio blob to a 16 kHz mono Float32Array (what Whisper expects). */
export async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctx: typeof AudioContext =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  // Chromium/Electron honor the requested sampleRate, resampling on decode.
  const ctx = new Ctx({ sampleRate: WHISPER_SR });
  try {
    const buf = await ctx.decodeAudioData(arrayBuffer);
    if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
    const n = buf.length;
    const out = new Float32Array(n);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) out[i] += data[i];
    }
    for (let i = 0; i < n; i++) out[i] /= buf.numberOfChannels;
    return out;
  } finally {
    ctx.close();
  }
}

export async function transcribeAudio(
  audioBlob: Blob,
  onModelProgress?: (progress: { progress: number }) => void,
  onTranscribeProgress?: (fraction: number) => void,
  shouldCancel?: () => boolean,
): Promise<TranscriptWord[]> {
  try {
    const pipeline = await loadWhisperModel(onModelProgress);

    // Decoding a corrupt/odd file can hang the AudioContext; cap it.
    const samples = await withTimeout(decodeTo16kMono(audioBlob), 120_000, 'Audio decode');
    const windowSize = TRANSCRIBE_WINDOW_S * WHISPER_SR;
    const windowCount = Math.max(1, Math.ceil(samples.length / windowSize));
    const words: TranscriptWord[] = [];

    onTranscribeProgress?.(0);
    for (let w = 0; w < windowCount; w++) {
      if (shouldCancel?.()) throw new TranscriptionCancelled();
      const startSample = w * windowSize;
      const slice = samples.subarray(startSample, Math.min(startSample + windowSize, samples.length));
      const offsetSec = startSample / WHISPER_SR;

      // A single 30s window should take seconds; if it runs far longer the
      // model has gotten stuck, so bail out to the even-timing fallback rather
      // than freezing forever.
      const output: any = await withTimeout(
        pipeline(slice, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 }),
        90_000,
        'Transcription step',
      );

      // Whisper can return null timestamps (commonly the final word's end) —
      // backfill them so alignment math never sees NaN, then shift by the
      // window's offset into the full recording.
      for (const c of (output.chunks || []) as any[]) {
        const word = (c.text || '').trim();
        if (!word) continue;
        const start = typeof c.timestamp?.[0] === 'number' ? c.timestamp[0] : 0;
        const end = typeof c.timestamp?.[1] === 'number' ? c.timestamp[1] : start + 0.5;
        words.push({ word, start: start + offsetSec, end: end + offsetSec });
      }
      onTranscribeProgress?.((w + 1) / windowCount);
    }

    return words;
  } catch (err) {
    // Clean up pipeline state so a retry is possible
    whisperPipeline = null;
    whisperLoadPromise = null;
    throw err;
  }
}

// ─── Text normalization for alignment ─────────────────────────

export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[.,?!'""—–:;()…\[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeWord)
    .filter((w) => w.length > 0);
}

// ─── Fuzzy matching (Levenshtein) ─────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ─── Segment alignment via first/last 4-6 words ───────────────

export interface AlignmentResult {
  startTime: number;
  endTime: number;
  confidence: number;
  lowConfidence: boolean;
  /** Raw Whisper start time of the matched first word (before any silence snap). */
  whisperFirstWordStart: number;
  /** The matched first word text (for debugging the offset source). */
  matchedFirstWord: string;
  /** Start after silence-snapping (before contiguity adjustment). */
  snappedStart: number;
}

export function alignSegment(
  segmentText: string,
  transcript: TranscriptWord[],
  searchAfterTime: number,
  audioEndTime: number,
): AlignmentResult {
  const segWords = normalizeWords(segmentText);
  if (segWords.length === 0 || transcript.length === 0) {
    return {
      startTime: searchAfterTime, endTime: audioEndTime, confidence: 0, lowConfidence: true,
      whisperFirstWordStart: searchAfterTime, matchedFirstWord: '', snappedStart: searchAfterTime,
    };
  }

  const firstPhrase = segWords.slice(0, Math.min(5, segWords.length));
  const lastPhrase = segWords.slice(-Math.min(5, segWords.length));

  // Find best match for first phrase
  let bestStart = -1;
  let bestStartScore = 0;
  const phraseLen = firstPhrase.length;

  for (let i = 0; i <= transcript.length - phraseLen; i++) {
    if (transcript[i].end < searchAfterTime - 0.5) continue;
    let score = 0;
    for (let j = 0; j < phraseLen; j++) {
      score += wordSimilarity(firstPhrase[j], normalizeWord(transcript[i + j].word));
    }
    score /= phraseLen;
    if (score > bestStartScore) {
      bestStartScore = score;
      bestStart = i;
    }
  }

  // Find best match for last phrase (after start)
  let bestEnd = -1;
  let bestEndScore = 0;
  const lastPhraseLen = lastPhrase.length;
  const startSearchIdx = bestStart >= 0 ? bestStart + phraseLen : 0;

  for (let i = startSearchIdx; i <= transcript.length - lastPhraseLen; i++) {
    let score = 0;
    for (let j = 0; j < lastPhraseLen; j++) {
      score += wordSimilarity(lastPhrase[j], normalizeWord(transcript[i + j].word));
    }
    score /= lastPhraseLen;
    if (score > bestEndScore) {
      bestEndScore = score;
      bestEnd = i + lastPhraseLen - 1;
    }
  }

  const confidence = (bestStartScore + bestEndScore) / 2;
  const lowConfidence = confidence < 0.5;

  let startTime: number;
  let endTime: number;
  let matchedFirstWord = '';

  if (bestStart >= 0 && bestStartScore > 0.3) {
    // Use the matched first word's START time (never its end).
    startTime = transcript[bestStart].start;
    matchedFirstWord = transcript[bestStart].word;
  } else {
    startTime = searchAfterTime;
  }

  if (bestEnd >= 0 && bestEndScore > 0.3) {
    endTime = transcript[bestEnd].end;
  } else {
    endTime = audioEndTime;
  }

  if (endTime <= startTime) {
    endTime = startTime + 1;
  }

  return {
    startTime, endTime, confidence, lowConfidence,
    whisperFirstWordStart: startTime, matchedFirstWord, snappedStart: startTime,
  };
}

/** Cheap word similarity with an early-out so the whole-transcript scan stays
 *  fast on long recordings (skip Levenshtein when lengths are far apart). */
function fastSim(a: string, b: string): number {
  if (a === b) return 1;
  if (Math.abs(a.length - b.length) > 2) return 0;
  return wordSimilarity(a, b);
}

/** Best position of `phrase` anywhere in the normalized transcript words. */
function bestPhraseMatch(phrase: string[], tWords: string[]): { idx: number; score: number } {
  const L = phrase.length;
  if (L === 0 || tWords.length < L) return { idx: -1, score: 0 };
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i + L <= tWords.length; i++) {
    let s = 0;
    for (let j = 0; j < L; j++) s += fastSim(phrase[j], tWords[i + j]);
    s /= L;
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, score: bestScore };
}

interface Anchor {
  seg: number;
  wordPos: number;
  time: number;
}

/** Linear-interpolate a time for `wordPos` between the surrounding anchors
 *  (anchors sorted ascending by wordPos, including the 0 and end bookends). */
function interpTime(wordPos: number, anchors: Anchor[]): number {
  for (let k = 0; k < anchors.length - 1; k++) {
    const a = anchors[k];
    const b = anchors[k + 1];
    if (wordPos <= b.wordPos) {
      const span = b.wordPos - a.wordPos;
      const frac = span > 0 ? (wordPos - a.wordPos) / span : 0;
      return a.time + (b.time - a.time) * frac;
    }
  }
  return anchors[anchors.length - 1].time;
}

/**
 * Full word-by-word alignment of the whole script against the whole transcript,
 * using a banded Needleman–Wunsch sequence alignment. Every script word is
 * matched (not just the first/last of each segment), and each is given the audio
 * time it is actually spoken at — read straight from the transcript's per-word
 * ("live subtitle") timings. Words with no transcript match get a time
 * interpolated between their known neighbours.
 *
 * Returns per-script-word times + which words matched, or null when the input is
 * too large or too empty (the caller then falls back to the anchor method).
 */
function alignWordsToTranscript(
  scriptWords: string[],
  tWords: string[],
  transcript: TranscriptWord[],
  audioDuration: number,
): { time: number[]; matched: boolean[]; matchedFraction: number } | null {
  const N = scriptWords.length;
  const M = tWords.length;
  if (N === 0 || M === 0) return null;

  // Diagonal band: the alignment stays near the i·(M/N) diagonal because the
  // script and the transcript are the same words in the same order.
  const band = Math.min(M, Math.max(60, Math.ceil(N * 0.15) + 40));
  // Cap total work/memory; caller falls back to the lighter anchor method.
  if (N * (2 * band + 1) > 40_000_000) return null;

  const GAP = -0.5;
  const NEG = -1e9;
  const slope = M / N;

  // Full backpointer grid (Int8 per row) for traceback; scores only need the
  // previous row, so we keep just two score rows.
  const loArr = new Int32Array(N + 1);
  const dirs: Int8Array[] = new Array(N + 1); // 0 diag, 1 up (script gap), 2 left (transcript gap)
  let prevScore: Float32Array | null = null;
  let prevLo = 0;

  for (let i = 0; i <= N; i++) {
    const center = Math.round(i * slope);
    const lo = Math.max(0, center - band);
    const hi = Math.min(M, center + band);
    loArr[i] = lo;
    const w = hi - lo + 1;
    const cur = new Float32Array(w).fill(NEG);
    const dr = new Int8Array(w);
    const prevW = prevScore ? prevScore.length : 0;

    for (let j = lo; j <= hi; j++) {
      const k = j - lo;
      if (i === 0 && j === 0) {
        cur[k] = 0;
        dr[k] = 0;
        continue;
      }
      let best = NEG;
      let bd: number = 0;
      // diagonal: align scriptWords[i-1] with tWords[j-1]
      if (i > 0 && j > 0 && prevScore) {
        const pk = j - 1 - prevLo;
        if (pk >= 0 && pk < prevW && prevScore[pk] > NEG / 2) {
          const sim = fastSim(scriptWords[i - 1], tWords[j - 1]);
          const v = prevScore[pk] + (2 * sim - 1);
          if (v > best) {
            best = v;
            bd = 0;
          }
        }
      }
      // up: consume a script word with no transcript word (deletion)
      if (i > 0 && prevScore) {
        const pk = j - prevLo;
        if (pk >= 0 && pk < prevW && prevScore[pk] > NEG / 2) {
          const v = prevScore[pk] + GAP;
          if (v > best) {
            best = v;
            bd = 1;
          }
        }
      }
      // left: skip a transcript word (insertion)
      if (j > lo && cur[k - 1] > NEG / 2) {
        const v = cur[k - 1] + GAP;
        if (v > best) {
          best = v;
          bd = 2;
        }
      }
      cur[k] = best;
      dr[k] = bd;
    }

    dirs[i] = dr;
    prevScore = cur;
    prevLo = lo;
  }

  // The bottom-right corner (N, M) must be reachable.
  {
    const k = M - loArr[N];
    if (!prevScore || k < 0 || k >= prevScore.length || prevScore[k] <= NEG / 2) return null;
  }

  // Traceback: assign each script word the start time of the transcript word it
  // aligned with (diagonal moves); gaps stay -1 and are interpolated below.
  const time = new Array<number>(N).fill(-1);
  const matched = new Array<boolean>(N).fill(false);
  let i = N;
  let j = M;
  while (i > 0 || j > 0) {
    if (i === 0) { j--; continue; }
    if (j === 0) { i--; continue; }
    const k = j - loArr[i];
    if (k < 0 || k >= dirs[i].length) break;
    const d = dirs[i][k];
    if (d === 0) {
      const sim = fastSim(scriptWords[i - 1], tWords[j - 1]);
      time[i - 1] = transcript[j - 1].start;
      matched[i - 1] = sim >= 0.5;
      i--;
      j--;
    } else if (d === 1) {
      i--;
    } else {
      j--;
    }
  }

  const matchedCount = matched.reduce((a, b) => a + (b ? 1 : 0), 0);

  // Keep known times non-decreasing, then fill unknown words by linear
  // interpolation between the surrounding known times (bracketed by 0 and the
  // audio end) so every segment boundary has a real time.
  let lastT = 0;
  for (let x = 0; x < N; x++) {
    if (time[x] >= 0) {
      if (time[x] < lastT) time[x] = lastT;
      else lastT = time[x];
    }
  }
  const filled = new Array<number>(N);
  let prevIdx = -1;
  for (let x = 0; x < N; x++) {
    if (time[x] >= 0) {
      const startT = prevIdx >= 0 ? time[prevIdx] : 0;
      for (let y = prevIdx + 1; y < x; y++) {
        filled[y] = startT + (time[x] - startT) * ((y - prevIdx) / (x - prevIdx));
      }
      filled[x] = time[x];
      prevIdx = x;
    }
  }
  if (prevIdx < 0) {
    for (let y = 0; y < N; y++) filled[y] = (y / N) * audioDuration;
  } else {
    const startT = time[prevIdx];
    const span = N - prevIdx;
    for (let y = prevIdx + 1; y < N; y++) {
      filled[y] = startT + (audioDuration - startT) * ((y - prevIdx) / span);
    }
  }

  return { time: filled, matched, matchedFraction: matchedCount / N };
}

/**
 * Fallback start times when full word alignment isn't usable: score each
 * segment's opening phrase across the transcript, keep only the mutually
 * consistent (monotonic, near-expected-position) matches as anchors, and
 * interpolate the rest by word position.
 */
function anchorRawStarts(
  segments: { text: string }[],
  segWords: string[][],
  tWords: string[],
  transcript: TranscriptWord[],
  audioDuration: number,
): { raw: number[]; conf: number[]; word: string[] } {
  const n = segments.length;
  const cumBefore: number[] = new Array(n);
  let running = 0;
  for (let i = 0; i < n; i++) {
    cumBefore[i] = running;
    running += segWords[i].length;
  }
  const totalWords = Math.max(1, running);

  const cand = segments.map((_, i) => {
    const phrase = segWords[i].slice(0, Math.min(6, segWords[i].length));
    const m = bestPhraseMatch(phrase, tWords);
    return {
      seg: i,
      idx: m.idx,
      score: m.score,
      time: m.idx >= 0 ? transcript[m.idx].start : -1,
      word: m.idx >= 0 ? transcript[m.idx].word : '',
    };
  });

  const posTol = Math.max(8, audioDuration * 0.2);
  const strong = cand.filter((c) => {
    if (c.idx < 0 || c.score < 0.62) return false;
    const expected = (cumBefore[c.seg] / totalWords) * audioDuration;
    return Math.abs(c.time - expected) <= posTol;
  });

  const anchorsFromStrong: typeof strong = [];
  if (strong.length) {
    const dp = new Array(strong.length).fill(1);
    const prev = new Array(strong.length).fill(-1);
    let bestEnd = 0;
    for (let a = 0; a < strong.length; a++) {
      for (let b = 0; b < a; b++) {
        if (strong[b].time < strong[a].time && dp[b] + 1 > dp[a]) {
          dp[a] = dp[b] + 1;
          prev[a] = b;
        }
      }
      if (dp[a] > dp[bestEnd]) bestEnd = a;
    }
    for (let k = bestEnd; k !== -1; k = prev[k]) anchorsFromStrong.push(strong[k]);
    anchorsFromStrong.reverse();
  }

  const isAnchor = new Set(anchorsFromStrong.map((a) => a.seg));
  const anchors: Anchor[] = [
    { seg: -1, wordPos: 0, time: 0 },
    ...anchorsFromStrong.map((a) => ({ seg: a.seg, wordPos: cumBefore[a.seg], time: a.time })),
    { seg: n, wordPos: totalWords, time: audioDuration },
  ];

  const raw: number[] = new Array(n);
  const conf: number[] = new Array(n);
  const word: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    raw[i] = interpTime(cumBefore[i], anchors);
    const anchored = isAnchor.has(i);
    conf[i] = anchored ? cand[i].score : 0.45;
    word[i] = anchored ? cand[i].word : '';
  }
  return { raw, conf, word };
}

/**
 * Align script segments to the audio.
 *
 * Primary path: a full word-by-word sequence alignment of the entire script
 * against the entire transcript (banded Needleman–Wunsch). This uses EVERY word
 * of every segment and reads each segment's start straight from the transcript's
 * per-word timing, so an image lasts exactly as long as its part of the script
 * is spoken — the durations follow the audio instead of first/last-word guesses.
 * If the transcript is too garbled (few words align) or the script is very large,
 * it falls back to the anchor + interpolation method.
 *
 * Starts then snap back to the nearest speech pause, and boundaries are made
 * contiguous (image i shows until segment i+1's speech begins).
 */
export function alignAllSegments(
  segments: { text: string }[],
  transcript: TranscriptWord[],
  audioDuration: number,
  silences: SilenceInfo[] = [],
): AlignmentResult[] {
  const n = segments.length;
  if (n === 0) return [];

  const tWords = transcript.map((t) => normalizeWord(t.word));
  const segWords = segments.map((s) => normalizeWords(s.text));

  // Flat script-word list with each segment's first-word index.
  const scriptWords: string[] = [];
  const segStart: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    segStart[i] = scriptWords.length;
    for (const w of segWords[i]) scriptWords.push(w);
  }
  const totalWords = Math.max(1, scriptWords.length);

  let raw: number[];
  let conf: number[];
  let matchedWord: string[];

  const dp = transcript.length > 0
    ? alignWordsToTranscript(scriptWords, tWords, transcript, audioDuration)
    : null;

  if (dp && dp.matchedFraction >= 0.3) {
    // Full word alignment succeeded — derive each segment's start and confidence
    // from the actual per-word audio timings.
    raw = new Array(n);
    conf = new Array(n);
    matchedWord = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = segStart[i];
      raw[i] = s < dp.time.length ? dp.time[s] : (s / totalWords) * audioDuration;
      const end = i < n - 1 ? segStart[i + 1] : scriptWords.length;
      let matchedN = 0;
      let count = 0;
      for (let w = s; w < end; w++) {
        count++;
        if (dp.matched[w]) matchedN++;
      }
      conf[i] = count > 0 ? matchedN / count : 0;
      matchedWord[i] = segWords[i][0] || '';
    }
  } else {
    const fb = anchorRawStarts(segments, segWords, tWords, transcript, audioDuration);
    raw = fb.raw;
    conf = fb.conf;
    matchedWord = fb.word;
  }

  const results: AlignmentResult[] = segments.map((_, i) => ({
    startTime: raw[i],
    endTime: audioDuration,
    confidence: conf[i],
    lowConfidence: conf[i] < 0.5,
    whisperFirstWordStart: raw[i],
    matchedFirstWord: matchedWord[i],
    snappedStart: raw[i],
  }));

  // Snap each start BACK to the pause just before speech resumes, so the image
  // appears exactly when the new segment starts being spoken.
  for (const r of results) {
    r.snappedStart = snapStartToSilence(r.whisperFirstWordStart, silences, 1.5);
    r.startTime = r.snappedStart;
  }

  // Contiguity: first starts at 0, each END = next segment START, last ends at
  // the audio end, and starts stay strictly monotonic.
  if (results.length > 0) {
    results[0].startTime = 0;
    for (let i = 1; i < results.length; i++) {
      if (!(results[i].startTime > results[i - 1].startTime)) {
        results[i].startTime = Math.min(results[i - 1].startTime + 0.05, audioDuration);
      }
    }
    for (let i = 0; i < results.length; i++) {
      results[i].endTime = i < results.length - 1 ? results[i + 1].startTime : audioDuration;
      if (results[i].endTime <= results[i].startTime) {
        results[i].endTime = Math.min(results[i].startTime + 0.5, audioDuration);
      }
    }
  }

  return results;
}
