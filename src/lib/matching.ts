import { MediaItem, Segment, Clip } from '../types';

// Parse filename to extract segment number and sub-index
// Examples: 1.jpg → seg 1, sub 0; 01.png → seg 1, sub 0; 001.jpg → seg 1, sub 0
// 1-1.jpg → seg 1, sub 1; 1_2.jpg → seg 1, sub 2; 1a.jpg → seg 1, sub 0 (alpha)
export interface ParsedName {
  segment: number;
  subIndex: number;
}

export function parseMediaName(name: string): ParsedName | null {
  const base = name.replace(/\.[^.]+$/, ''); // strip extension
  // Match patterns like: 1, 01, 001, 1-1, 1_2, 1a, 1-2, 01-3
  const match = base.match(/^0*(\d+)(?:[-_](\d+))?([a-z])?$/i);
  if (!match) return null;
  const segment = parseInt(match[1], 10);
  let subIndex = 0;
  if (match[2]) {
    subIndex = parseInt(match[2], 10);
  } else if (match[3]) {
    // alpha suffix: a=1, b=2, etc.
    subIndex = match[3].toLowerCase().charCodeAt(0) - 96;
  }
  if (isNaN(segment) || segment < 1) return null;
  return { segment, subIndex };
}

export function naturalSort(a: MediaItem, b: MediaItem): number {
  if (a.segment !== b.segment) return a.segment - b.segment;
  if (a.subIndex !== b.subIndex) return a.subIndex - b.subIndex;
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

// ─── Timeline building ───────────────────────────────────────
// All times are in integer microseconds to guarantee zero gaps.

function toMicro(s: number): number {
  return Math.round(s * 1_000_000);
}

function fromMicro(m: number): number {
  return m / 1_000_000;
}

export function buildTimeline(segments: Segment[]): Clip[] {
  const clips: Clip[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segStartMicro = toMicro(seg.startTime);
    const segEndMicro = toMicro(seg.endTime);
    const segDurMicro = segEndMicro - segStartMicro;
    if (segDurMicro <= 0) continue;

    const videos = seg.matchedMedia.filter((m) => m.kind === 'video');
    const images = seg.matchedMedia.filter((m) => m.kind === 'image').sort((a, b) => a.subIndex - b.subIndex);

    if (!seg.hasMedia) {
      // RULE C: no media — will be covered by extending previous segment's last image
      continue;
    }

    if (videos.length > 0) {
      // RULE A: video exists
      const video = videos[0];
      const videoDurMicro = video.duration ? Math.min(toMicro(video.duration), segDurMicro) : segDurMicro;

      if (videoDurMicro >= segDurMicro) {
        // Video covers the whole segment — trim at segment end
        clips.push({
          id: crypto.randomUUID(),
          segmentIndex: seg.index,
          media: video,
          start: fromMicro(segStartMicro),
          duration: fromMicro(segDurMicro),
          sourceTrimStart: 0,
          isImage: false,
          coveringMissing: false,
        });
      } else {
        // Video first at native duration, then images fill remaining
        clips.push({
          id: crypto.randomUUID(),
          segmentIndex: seg.index,
          media: video,
          start: fromMicro(segStartMicro),
          duration: fromMicro(videoDurMicro),
          sourceTrimStart: 0,
          isImage: false,
          coveringMissing: false,
        });

        const remainingMicro = segDurMicro - videoDurMicro;
        if (images.length > 0 && remainingMicro > 0) {
          const perImageMicro = Math.floor(remainingMicro / images.length);
          let cursorMicro = segStartMicro + videoDurMicro;
          for (let j = 0; j < images.length; j++) {
            const isLast = j === images.length - 1;
            const clipDurMicro = isLast ? (segEndMicro - cursorMicro) : perImageMicro;
            clips.push({
              id: crypto.randomUUID(),
              segmentIndex: seg.index,
              media: images[j],
              start: fromMicro(cursorMicro),
              duration: fromMicro(clipDurMicro),
              sourceTrimStart: 0,
              isImage: true,
              coveringMissing: false,
            });
            cursorMicro += clipDurMicro;
          }
        }
      }
    } else if (images.length > 0) {
      // RULE B: only images — distribute evenly across full segment
      const perImageMicro = Math.floor(segDurMicro / images.length);
      let cursorMicro = segStartMicro;
      for (let j = 0; j < images.length; j++) {
        const isLast = j === images.length - 1;
        const clipDurMicro = isLast ? (segEndMicro - cursorMicro) : perImageMicro;
        clips.push({
          id: crypto.randomUUID(),
          segmentIndex: seg.index,
          media: images[j],
          start: fromMicro(cursorMicro),
          duration: fromMicro(clipDurMicro),
          sourceTrimStart: 0,
          isImage: true,
          coveringMissing: false,
        });
        cursorMicro += clipDurMicro;
      }
    }
  }

  // RULE C: cover missing-media segments by extending previous image
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.hasMedia) continue;

    const segStartMicro = toMicro(seg.startTime);
    const segEndMicro = toMicro(seg.endTime);
    const segDurMicro = segEndMicro - segStartMicro;
    if (segDurMicro <= 0) continue;

    // Find the last image clip before this segment
    let lastImageClip: Clip | null = null;
    for (let c = clips.length - 1; c >= 0; c--) {
      if (clips[c].isImage && toMicro(clips[c].start) < segStartMicro) {
        lastImageClip = clips[c];
        break;
      }
    }

    if (lastImageClip) {
      lastImageClip.duration = fromMicro(toMicro(lastImageClip.duration) + segDurMicro);
    } else {
      let nextImageClip: Clip | null = null;
      for (let c = 0; c < clips.length; c++) {
        if (clips[c].isImage && toMicro(clips[c].start) >= segEndMicro) {
          nextImageClip = clips[c];
          break;
        }
      }
      if (nextImageClip) {
        nextImageClip.start = fromMicro(toMicro(nextImageClip.start) - segDurMicro);
        nextImageClip.duration = fromMicro(toMicro(nextImageClip.duration) + segDurMicro);
      }
    }
  }

  return clips;
}

/** Verify clips exactly fill a segment's time range (integer microseconds, zero gaps). */
export interface SegmentVerification {
  segmentIndex: number;
  startMicro: number;
  endMicro: number;
  durationMicro: number;
  clipCount: number;
  pass: boolean;
  gapMicro: number;
}

export function verifySegmentFill(seg: Segment, clips: Clip[]): SegmentVerification {
  const segStartMicro = toMicro(seg.startTime);
  const segEndMicro = toMicro(seg.endTime);
  const segDurMicro = segEndMicro - segStartMicro;
  const segClips = clips
    .filter((c) => c.segmentIndex === seg.index)
    .sort((a, b) => toMicro(a.start) - toMicro(b.start));

  let coveredMicro = 0;
  let gapMicro = 0;
  let cursor = segStartMicro;
  for (const c of segClips) {
    const cStart = toMicro(c.start);
    const cDur = toMicro(c.duration);
    if (cStart > cursor) gapMicro += cStart - cursor;
    cursor = Math.max(cursor, cStart + cDur);
    coveredMicro += cDur;
  }

  // pass if clips sum to segment duration and end at segment end
  const endOk = cursor === segEndMicro;
  const sumOk = coveredMicro === segDurMicro;
  return {
    segmentIndex: seg.index,
    startMicro: segStartMicro,
    endMicro: segEndMicro,
    durationMicro: segDurMicro,
    clipCount: segClips.length,
    pass: endOk && sumOk && gapMicro === 0,
    gapMicro,
  };
}

// ─── Script parsing ───────────────────────────────────────────
// Two modes:
//   - "number": a line that is ONLY a number (1, 1., 1), (1), [1]) marks a segment start.
//     The number = segment number; text until the next number line = that segment's text.
//   - "blank": fallback — segments split by blank lines (one paragraph = one segment).
// Outer quote marks are stripped from segment text.

function stripOuterQuotes(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  if (trimmed.length >= 2 && trimmed.startsWith('\u201C') && trimmed.endsWith('\u201D')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

const NUMBER_LINE_RE = /^\s*#?\s*[\(\[]?\s*(\d+)\s*[\.\)]?[\)\]]?\s*$/;

export type ScriptMode = 'number' | 'blank';

export interface ParseResult {
  mode: ScriptMode;
  segments: { index: number; text: string }[];
  warnings: string[];
}

/** Detect whether the script uses number-line splitting (3+ ascending number-only lines). */
export function detectScriptMode(text: string): ScriptMode {
  const lines = text.split(/\n/);
  const nums: number[] = [];
  for (const line of lines) {
    const m = line.match(NUMBER_LINE_RE);
    if (m) nums.push(parseInt(m[1], 10));
  }
  if (nums.length >= 2) return 'number';
  return 'blank';
}

export function parseSegments(text: string): string[] {
  return parseScriptFull(text).segments.map((s) => s.text);
}

export function segmentPreview(segments: { index: number; text: string }[], wordCount = 8): string {
  return segments.map((s) => {
    const words = s.text.split(/\s+/).slice(0, wordCount).join(' ');
    return `${s.index}: ${words}${s.text.split(/\s+/).length > wordCount ? '...' : ''}`;
  }).join('\n');
}

export function parseScriptFull(text: string): ParseResult {
  const mode = detectScriptMode(text);
  const warnings: string[] = [];

  if (mode === 'blank') {
    const segs = text
      .split(/\n\s*\n/)
      .map((s) => stripOuterQuotes(s))
      .filter((s) => s.length > 0);
    return {
      mode: 'blank',
      segments: segs.map((t, i) => ({ index: i + 1, text: t })),
      warnings,
    };
  }

  // Number mode: split at number-only lines
  const lines = text.split(/\n/);
  const rawSegments: { index: number; text: string }[] = [];
  let current: { index: number; text: string } | null = null;

  for (const line of lines) {
    const m = line.match(NUMBER_LINE_RE);
    if (m) {
      if (current) rawSegments.push(current);
      current = { index: parseInt(m[1], 10), text: '' };
    } else if (current) {
      const t = line.trim();
      if (t) {
        current.text = current.text ? current.text + ' ' + t : t;
      }
    }
  }
  if (current) rawSegments.push(current);

  // Strip outer quotes from each
  const segments = rawSegments.map((s) => ({ index: s.index, text: stripOuterQuotes(s.text) }));

  // Validate sequential numbers
  const nums = segments.map((s) => s.index);
  const seen = new Set<number>();
  const dupes: number[] = [];
  for (const n of nums) {
    if (seen.has(n)) dupes.push(n);
    seen.add(n);
  }
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const missing: number[] = [];
  for (let i = sorted[0]; i <= sorted[sorted.length - 1]; i++) {
    if (!seen.has(i)) missing.push(i);
  }
  if (missing.length > 0) warnings.push(`Missing segment numbers: ${missing.join(', ')}`);
  if (dupes.length > 0) warnings.push(`Duplicate segment numbers: ${dupes.join(', ')}`);
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] < nums[i - 1]) {
      warnings.push(`Out-of-order: ${nums[i - 1]} appears before ${nums[i]}`);
      break;
    }
  }

  return { mode: 'number', segments, warnings };
}
