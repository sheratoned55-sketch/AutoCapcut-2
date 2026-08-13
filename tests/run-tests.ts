/**
 * In-browser test suite. Served by `vite dev` at /tests/harness.html and
 * driven by Playwright (or open it manually in a browser).
 * Add ?whisper=1 to also run the full Whisper transcription test
 * (downloads the model, ~40 MB, needs internet).
 */
import {
  parseMediaName, naturalSort, buildTimeline, verifySegmentFill,
  detectScriptMode, parseSegments, parseScriptFull,
} from '../src/lib/matching';
import {
  normalizeWord, normalizeWords, wordSimilarity, alignSegment, alignAllSegments,
  detectSilences, snapToSilence, buildPartOffsets,
  decodeAudioFile, decodeAudioParts, transcribeAudio,
} from '../src/lib/audio';
import {
  saveProject, getProject, deleteProject, saveBlob, getBlob, setSetting, getSetting,
} from '../src/lib/db';
import { simulateExportWithMockTemplate, exportSrtCsv } from '../src/lib/export';
import { isAudioFile, isImageFile, isVideoFile, genId } from '../src/lib/fs';
import type { MediaItem, Segment, Project, TranscriptWord } from '../src/types';

interface TestResult { name: string; ok: boolean; error?: string; ms: number; detail?: string }
const results: TestResult[] = [];
(window as any).__RESULTS__ = { done: false, results };

const resultsEl = document.getElementById('results')!;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function approx(a: number, b: number, eps = 0.05): boolean {
  return Math.abs(a - b) <= eps;
}

async function test(name: string, fn: () => void | Promise<void | string>) {
  const t0 = performance.now();
  try {
    const detail = (await fn()) || undefined;
    const ms = Math.round(performance.now() - t0);
    results.push({ name, ok: true, ms, detail: detail as string | undefined });
    resultsEl.innerHTML += `<div class="pass">PASS ${name} (${ms}ms)${detail ? ' — ' + detail : ''}</div>`;
  } catch (e: any) {
    const ms = Math.round(performance.now() - t0);
    results.push({ name, ok: false, error: e?.message || String(e), ms });
    resultsEl.innerHTML += `<div class="fail">FAIL ${name}: ${e?.message || e}</div>`;
  }
}

// ─── WAV synthesis helpers ────────────────────────────────────

/** Encode mono Float32 samples as a 16-bit PCM WAV blob. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  writeStr(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Tone / silence pattern: array of [durationSec, freqHz|0 for silence]. */
function makeWav(pattern: [number, number][], sampleRate = 16000): Blob {
  const total = pattern.reduce((s, [d]) => s + d, 0);
  const samples = new Float32Array(Math.round(total * sampleRate));
  let idx = 0;
  for (const [dur, freq] of pattern) {
    const n = Math.round(dur * sampleRate);
    for (let i = 0; i < n; i++, idx++) {
      samples[idx] = freq > 0 ? 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate) : 0;
    }
  }
  return encodeWav(samples, sampleRate);
}

function mediaItem(over: Partial<MediaItem>): MediaItem {
  return { id: genId(), kind: 'image', name: '1.jpg', segment: 1, subIndex: 0, size: 100, ...over };
}
function segment(over: Partial<Segment>): Segment {
  return {
    id: genId(), index: 1, text: 'hello world', startTime: 0, endTime: 5,
    confidence: 1, lowConfidence: false, matchedMedia: [], hasVideo: false, hasImages: false, hasMedia: false,
    ...over,
  };
}

async function main() {
  // ── File name / type helpers ──
  await test('parseMediaName: plain numbers', () => {
    assert(JSON.stringify(parseMediaName('1.jpg')) === '{"segment":1,"subIndex":0}', '1.jpg');
    assert(JSON.stringify(parseMediaName('01.png')) === '{"segment":1,"subIndex":0}', '01.png');
    assert(JSON.stringify(parseMediaName('12.mp4')) === '{"segment":12,"subIndex":0}', '12.mp4');
  });
  await test('parseMediaName: sub-indexes and rejects', () => {
    assert(JSON.stringify(parseMediaName('1-2.jpg')) === '{"segment":1,"subIndex":2}', '1-2.jpg');
    assert(JSON.stringify(parseMediaName('3_1.png')) === '{"segment":3,"subIndex":1}', '3_1.png');
    assert(JSON.stringify(parseMediaName('2b.png')) === '{"segment":2,"subIndex":2}', '2b alpha');
    assert(parseMediaName('cover.jpg') === null, 'non-numeric rejected');
    assert(parseMediaName('0.jpg') === null, 'segment 0 rejected');
  });
  await test('file type detection', () => {
    assert(isAudioFile('a.MP3') && isAudioFile('b.flac') && !isAudioFile('c.mp4'), 'audio');
    assert(isImageFile('a.JPG') && isImageFile('b.webp') && !isImageFile('c.mp3'), 'image');
    assert(isVideoFile('a.MOV') && isVideoFile('b.mkv') && !isVideoFile('c.png'), 'video');
  });
  await test('naturalSort orders by segment then subIndex', () => {
    const items = [
      mediaItem({ name: '2.jpg', segment: 2, subIndex: 0 }),
      mediaItem({ name: '1-2.jpg', segment: 1, subIndex: 2 }),
      mediaItem({ name: '1.jpg', segment: 1, subIndex: 0 }),
    ].sort(naturalSort);
    assert(items.map(i => i.name).join(',') === '1.jpg,1-2.jpg,2.jpg', 'order');
  });

  // ── Script parsing ──
  await test('script parsing: numbered mode', () => {
    const text = '1\nFirst segment text here\n2\nSecond segment text\n3\nThird one';
    assert(detectScriptMode(text) === 'number', 'mode');
    const segs = parseSegments(text);
    assert(segs.length === 3, `expected 3 segments, got ${segs.length}`);
    assert(segs[0].includes('First segment'), 'seg1 text');
  });
  await test('script parsing: blank-line mode', () => {
    const text = 'First paragraph\n\nSecond paragraph\n\nThird';
    const r = parseScriptFull(text);
    assert(r.mode === 'blank', 'mode');
    assert(r.segments.length === 3, `expected 3, got ${r.segments.length}`);
    assert(r.segments[2].index === 3 && r.segments[2].text === 'Third', 'indexing');
  });

  // ── Text normalization + fuzzy matching ──
  await test('normalizeWord / normalizeWords', () => {
    assert(normalizeWord('Hello,') === 'hello', 'punctuation stripped');
    assert(normalizeWord('"World!"') === 'world', 'quotes stripped');
    assert(normalizeWords('Hello,  World! ').join('|') === 'hello|world', 'split+filter');
  });
  await test('wordSimilarity', () => {
    assert(wordSimilarity('hello', 'hello') === 1, 'identical');
    assert(wordSimilarity('hello', 'hallo') === 0.8, 'one edit');
    assert(wordSimilarity('abc', 'xyz') < 0.34, 'different');
  });

  // ── Alignment ──
  const transcript: TranscriptWord[] = 'the quick brown fox jumps over the lazy dog and runs far away home'
    .split(' ').map((w, i) => ({ word: w, start: i, end: i + 0.9 }));
  await test('alignSegment finds phrase window', () => {
    const r = alignSegment('the quick brown fox jumps', transcript, 0, 15);
    assert(approx(r.startTime, 0, 0.01), `start ${r.startTime}`);
    assert(!r.lowConfidence, 'confidence');
  });
  await test('alignAllSegments: monotonic, covers full audio', () => {
    const rs = alignAllSegments(
      [{ text: 'the quick brown fox jumps' }, { text: 'over the lazy dog and' }, { text: 'runs far away home' }],
      transcript, 15,
    );
    assert(rs.length === 3, 'count');
    assert(rs[0].startTime === 0 && rs[2].endTime === 15, 'bounds');
    for (let i = 1; i < rs.length; i++) {
      assert(rs[i].startTime >= rs[i - 1].endTime - 1e-9, `overlap at ${i}`);
    }
  });

  // ── Audio decoding ──
  await test('decodeAudioFile: WAV roundtrip', async () => {
    const wav = makeWav([[2, 440]]);
    const buf = await decodeAudioFile(wav);
    assert(approx(buf.duration, 2, 0.1), `duration ${buf.duration}`);
  });
  await test('decodeAudioParts + buildPartOffsets', async () => {
    const { buffer, durations } = await decodeAudioParts([makeWav([[1, 440]]), makeWav([[2, 330]])]);
    assert(durations.length === 2, 'two parts');
    assert(approx(durations[0], 1, 0.1) && approx(durations[1], 2, 0.1), 'part durations');
    assert(approx(buffer.duration, 3, 0.2), `combined ${buffer.duration}`);
    const offsets = buildPartOffsets(durations);
    assert(offsets[0] === 0 && approx(offsets[1], 1, 0.1), 'offsets');
  });

  // ── Silence detection ──
  await test('detectSilences + snapToSilence', async () => {
    const wav = makeWav([[1, 440], [0.6, 0], [1, 440]]);
    const buf = await decodeAudioFile(wav);
    const silences = detectSilences(buf);
    assert(silences.length >= 1, `found ${silences.length} silences`);
    const mid = silences.find(s => approx(s.time, 1.3, 0.25));
    assert(mid, `silence near 1.3s, got ${silences.map(s => s.time.toFixed(2)).join(',')}`);
    assert(approx(snapToSilence(1.2, silences), mid!.time, 0.01), 'snap');
  });

  // ── Timeline building ──
  await test('buildTimeline: images fill segment exactly', () => {
    const imgs = [mediaItem({ name: '1.jpg', subIndex: 0 }), mediaItem({ name: '1-1.jpg', subIndex: 1 }), mediaItem({ name: '1-2.jpg', subIndex: 2 })];
    const seg = segment({ startTime: 0, endTime: 10, matchedMedia: imgs, hasImages: true, hasMedia: true });
    const clips = buildTimeline([seg]);
    assert(clips.length === 3, `3 clips, got ${clips.length}`);
    const v = verifySegmentFill(seg, clips);
    assert(v.pass, `verifySegmentFill: ${JSON.stringify(v)}`);
  });
  await test('buildTimeline: video then images; missing segment covered', () => {
    const video = mediaItem({ kind: 'video', name: '1.mp4', duration: 4 });
    const img = mediaItem({ name: '1-1.jpg', subIndex: 1 });
    const segs = [
      segment({ index: 1, startTime: 0, endTime: 10, matchedMedia: [video, img], hasVideo: true, hasImages: true, hasMedia: true }),
      segment({ index: 2, startTime: 10, endTime: 14, matchedMedia: [], hasMedia: false }),
    ];
    const clips = buildTimeline(segs);
    assert(clips.length === 2, `2 clips, got ${clips.length}`);
    assert(!clips[0].isImage && approx(clips[0].duration, 4), 'video native duration');
    // image extended to cover the missing segment: 6s remainder + 4s missing
    assert(approx(clips[1].duration, 10, 0.001), `covering image duration ${clips[1].duration}`);
  });

  // ── IndexedDB persistence ──
  await test('db: project save/get/delete', async () => {
    const p = { id: 'test-proj', name: 'T', createdAt: 1, updatedAt: 1, segments: [], clips: [], audioDuration: 0, audioPartDurations: [], transcript: [], pipelineSteps: [], processed: false, folders: { audioParts: [], mode: 'fallback' } };
    await saveProject(p);
    const got = await getProject('test-proj');
    assert(got && got.name === 'T', 'roundtrip');
    await deleteProject('test-proj');
    assert(!(await getProject('test-proj')), 'deleted');
  });
  await test('db: blob + settings roundtrip', async () => {
    await saveBlob('test-blob', new Blob(['hello']));
    const b = await getBlob('test-blob');
    assert(b && (await b.text()) === 'hello', 'blob');
    await setSetting('k', { a: 1 });
    assert((await getSetting('k'))?.a === 1, 'setting');
  });

  // ── CapCut export ──
  const exportProject: Project = {
    id: 'exp', name: 'Export Test', createdAt: 1, updatedAt: 1,
    folders: { audioParts: [{ id: 'a1', name: 'voice.mp3', blobId: 'exp-audio', size: 10 }], mode: 'fallback' },
    segments: [segment({ startTime: 0, endTime: 4, matchedMedia: [], hasImages: true, hasMedia: true })],
    clips: [], audioDuration: 4, audioPartDurations: [4], transcript: [], pipelineSteps: [], processed: true,
  };
  const img = mediaItem({ name: '1.jpg', blobId: 'exp-img' });
  exportProject.segments[0].matchedMedia = [img];
  exportProject.clips = buildTimeline(exportProject.segments);
  // A real, decodable image so the export's draft_cover.jpg resize succeeds.
  const realJpeg = await new Promise<Blob>((resolve) => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const g = c.getContext('2d')!;
    g.fillStyle = '#22d3ee'; g.fillRect(0, 0, 320, 180);
    c.toBlob((b) => resolve(b!), 'image/jpeg', 0.9);
  });
  // The app keys the blob map by media.id and audioPart.id (not blobId).
  const mediaBlobs = new Map<string, Blob>([
    [img.id, realJpeg],
    ['a1', makeWav([[4, 440]])],
  ]);
  await test('export: simulateExportWithMockTemplate validates', async () => {
    const r = await simulateExportWithMockTemplate(exportProject, mediaBlobs, 'C:/Users/test/CapCut/Drafts');
    const failed = r.report.checks.filter((c) => !c.pass);
    assert(r.report.passed, `validation failed: ${failed.map(c => `${c.name}: ${c.detail}`).join('; ')}`);
    return `${r.report.checks.length} checks ok`;
  });
  await test('export: SRT/CSV zip is produced', async () => {
    const blob = await exportSrtCsv(exportProject, mediaBlobs);
    assert(blob.size > 100, `zip size ${blob.size}`);
  });

  // ── Whisper inference end-to-end (opt-in: ?whisper=1) ──
  // The real proof that transcription works: this calls the actual product
  // function `transcribeAudio`, which loads the bundled ONNX WASM backend (the
  // part that crashed with "registerBackend") and the bundled Whisper model,
  // then runs inference. When served from the built app it uses dist/models +
  // dist/ort — i.e. fully offline, exactly like the packaged desktop app.
  if (new URLSearchParams(location.search).get('whisper') === '1') {
    await test('whisper: real transcribeAudio runs offline on bundled model', async () => {
      // Synthetic 3s clip — the transcript content is irrelevant; what matters
      // is that the model + WASM load locally, inference completes, and every
      // timestamp comes back finite.
      const wav = makeWav([[1, 220], [0.5, 0], [1.5, 330]]);
      let lastProgress = 0;
      const words = await transcribeAudio(wav, (p) => { lastProgress = p.progress; });
      assert(Array.isArray(words), 'returns an array of words');
      for (const w of words) {
        assert(Number.isFinite(w.start) && Number.isFinite(w.end), `NaN timestamp: ${JSON.stringify(w)}`);
      }
      return `transcribeAudio completed (progress ${Math.round(lastProgress)}), ${words.length} words`;
    });
  }

  (window as any).__RESULTS__.done = true;
  const failed = results.filter(r => !r.ok).length;
  resultsEl.innerHTML += `<h2>${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} (${results.length} tests)</h2>`;
}

main();
