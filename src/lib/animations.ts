import { AnimationDef, ClipAnimationConfig, AnimCategory } from '../types';

// ─────────────────────────────────────────────────────────────────
// Standalone animation engine.
//
// Every animation is a pure function of progress `p ∈ [0,1]` that returns a
// FrameTransform. The SAME function drives the live canvas preview and the
// MP4 export, so what you see is exactly what renders. No CapCut, no external
// assets — these are our own transforms.
//
// Convention:
//   • IN animations end at the identity transform at p = 1 (image "arrives").
//   • OUT animations start at the identity transform at p = 0 (image "leaves").
//   • COMBO animations run continuously across the clip (p = localTime/clipDur).
// ─────────────────────────────────────────────────────────────────

export interface FrameTransform {
  /** uniform scale about the clip centre (1 = fit/cover) */
  scale: number;
  /** horizontal shift as a fraction of canvas width (0 = centred) */
  translateX: number;
  /** vertical shift as a fraction of canvas height */
  translateY: number;
  /** rotation in radians */
  rotate: number;
  /** 0–1 */
  opacity: number;
}

export const IDENTITY: FrameTransform = {
  scale: 1, translateX: 0, translateY: 0, rotate: 0, opacity: 1,
};

// ─── Easing helpers ──────────────────────────────────────────────
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const TAU = Math.PI * 2;

type AnimFn = (p: number) => Partial<FrameTransform>;

interface AnimEntry extends AnimationDef {
  fn: AnimFn;
}

// ─── IN animations (p: 0→1, identity at 1) ───────────────────────
const IN: AnimEntry[] = [
  a('fade-in', 'Fade In', ['Basic', 'Trending'], 0.6, (p) => ({ opacity: easeOut(p) })),
  a('zoom-in', 'Zoom In', ['Basic', 'Trending'], 0.7, (p) => ({ scale: lerp(1.35, 1, easeOut(p)), opacity: clamp01(p * 1.5) })),
  a('zoom-out-in', 'Zoom Out', ['Basic'], 0.7, (p) => ({ scale: lerp(0.6, 1, easeOut(p)), opacity: clamp01(p * 1.5) })),
  a('slide-left-in', 'Slide Left', ['Basic'], 0.6, (p) => ({ translateX: lerp(0.6, 0, easeOut(p)) })),
  a('slide-right-in', 'Slide Right', ['Basic'], 0.6, (p) => ({ translateX: lerp(-0.6, 0, easeOut(p)) })),
  a('slide-up-in', 'Slide Up', ['Basic'], 0.6, (p) => ({ translateY: lerp(0.6, 0, easeOut(p)) })),
  a('slide-down-in', 'Slide Down', ['Basic'], 0.6, (p) => ({ translateY: lerp(-0.6, 0, easeOut(p)) })),
  a('rotate-in', 'Rotate In', ['Light'], 0.7, (p) => ({ rotate: lerp(-0.35, 0, easeOut(p)), scale: lerp(0.8, 1, easeOut(p)), opacity: clamp01(p * 1.5) })),
  a('spin-in', 'Spin In', ['Glitch'], 0.7, (p) => ({ rotate: lerp(-TAU, 0, easeOut(p)), scale: lerp(0.4, 1, easeOut(p)), opacity: clamp01(p * 2) })),
  a('bounce-in', 'Bounce In', ['Trending'], 0.8, (p) => ({ scale: lerp(0.5, 1, easeOutBack(p)), opacity: clamp01(p * 2) })),
  a('mask-wipe-in', 'Reveal', ['Mask'], 0.7, (p) => ({ scale: lerp(1.12, 1, easeOut(p)), opacity: easeInOut(p) })),
  a('shake-in', 'Shake In', ['Glitch'], 0.6, (p) => ({ translateX: (1 - p) * 0.05 * Math.sin(p * 40), opacity: clamp01(p * 2), scale: lerp(1.1, 1, easeOut(p)) })),
  // ── More (CapCut / Filmora style, tuned for AI-story image channels) ──
  a('drop-in', 'Drop In', ['Trending'], 0.8, (p) => ({ translateY: lerp(-0.7, 0, easeOutBack(p)), opacity: clamp01(p * 2) })),
  a('rise-in', 'Rise Up', ['Trending', 'Cinematic'], 0.7, (p) => ({ translateY: lerp(0.4, 0, easeOut(p)), scale: lerp(1.08, 1, easeOut(p)), opacity: easeOut(p) })),
  a('expand-in', 'Expand', ['Basic'], 0.6, (p) => ({ scale: easeOut(p), opacity: clamp01(p * 2) })),
  a('zoom-blur-in', 'Zoom Blur In', ['Trending', 'Cinematic'], 0.5, (p) => ({ scale: lerp(1.9, 1, easeOut(p)), opacity: clamp01(p * 2.2) })),
  a('roll-in-left', 'Roll In', ['Light'], 0.7, (p) => ({ rotate: lerp(-0.7, 0, easeOut(p)), translateX: lerp(-0.5, 0, easeOut(p)), opacity: clamp01(p * 1.6) })),
  a('flash-in', 'Flash In', ['Glitch'], 0.5, (p) => ({ opacity: p < 0.3 ? p / 0.3 * 0.7 : clamp01(0.7 + (p - 0.3)), scale: lerp(1.05, 1, easeOut(p)) })),
  a('drift-in', 'Drift In', ['Cinematic'], 0.9, (p) => ({ translateX: lerp(0.12, 0, easeOut(p)), scale: 1.08, opacity: easeOut(p) })),
  a('skew-in', 'Tilt In', ['Light'], 0.6, (p) => ({ rotate: lerp(0.15, 0, easeOut(p)), scale: lerp(1.1, 1, easeOut(p)), opacity: clamp01(p * 1.6) })),
];

// ─── OUT animations (p: 0→1, identity at 0) ──────────────────────
const OUT: AnimEntry[] = [
  a('fade-out', 'Fade Out', ['Basic', 'Trending'], 0.6, (p) => ({ opacity: 1 - easeOut(p) })),
  a('zoom-in-out', 'Zoom In', ['Basic'], 0.7, (p) => ({ scale: lerp(1, 1.4, easeInOut(p)), opacity: 1 - clamp01(p * 1.3) })),
  a('zoom-out-out', 'Zoom Out', ['Basic', 'Trending'], 0.7, (p) => ({ scale: lerp(1, 0.55, easeInOut(p)), opacity: 1 - clamp01(p * 1.3) })),
  a('slide-left-out', 'Slide Left', ['Basic'], 0.6, (p) => ({ translateX: lerp(0, -0.6, easeInOut(p)) })),
  a('slide-right-out', 'Slide Right', ['Basic'], 0.6, (p) => ({ translateX: lerp(0, 0.6, easeInOut(p)) })),
  a('slide-up-out', 'Slide Up', ['Basic'], 0.6, (p) => ({ translateY: lerp(0, -0.6, easeInOut(p)) })),
  a('slide-down-out', 'Slide Down', ['Basic'], 0.6, (p) => ({ translateY: lerp(0, 0.6, easeInOut(p)) })),
  a('rotate-out', 'Rotate Out', ['Light'], 0.7, (p) => ({ rotate: lerp(0, 0.35, easeInOut(p)), scale: lerp(1, 0.8, easeInOut(p)), opacity: 1 - clamp01(p * 1.3) })),
  a('spin-out', 'Spin Out', ['Glitch'], 0.7, (p) => ({ rotate: lerp(0, TAU, easeInOut(p)), scale: lerp(1, 0.4, easeInOut(p)), opacity: 1 - clamp01(p * 1.5) })),
  a('mask-wipe-out', 'Conceal', ['Mask'], 0.7, (p) => ({ scale: lerp(1, 1.12, easeInOut(p)), opacity: 1 - easeInOut(p) })),
  // ── More ──
  a('drop-out', 'Drop Out', ['Trending'], 0.7, (p) => ({ translateY: lerp(0, 0.7, easeInOut(p)), opacity: 1 - clamp01(p * 1.4) })),
  a('rise-out', 'Rise Out', ['Cinematic'], 0.7, (p) => ({ translateY: lerp(0, -0.4, easeInOut(p)), scale: lerp(1, 1.08, easeInOut(p)), opacity: 1 - easeInOut(p) })),
  a('expand-out', 'Expand Out', ['Basic'], 0.6, (p) => ({ scale: lerp(1, 1.8, easeInOut(p)), opacity: 1 - clamp01(p * 1.4) })),
  a('zoom-blur-out', 'Zoom Blur Out', ['Trending', 'Cinematic'], 0.5, (p) => ({ scale: lerp(1, 1.9, easeInOut(p)), opacity: 1 - clamp01(p * 2.2) })),
  a('roll-out-right', 'Roll Out', ['Light'], 0.7, (p) => ({ rotate: lerp(0, 0.7, easeInOut(p)), translateX: lerp(0, 0.5, easeInOut(p)), opacity: 1 - clamp01(p * 1.6) })),
  a('drift-out', 'Drift Out', ['Cinematic'], 0.9, (p) => ({ translateX: lerp(0, -0.12, easeInOut(p)), scale: 1.08, opacity: 1 - easeInOut(p) })),
];

// ─── COMBO animations (continuous across the whole clip) ─────────
const COMBO: AnimEntry[] = [
  a('kenburns-zoom-in', 'Zoom 1', ['Trending', 'Camera'], 0, (p) => ({ scale: lerp(1.0, 1.18, p) })),
  a('kenburns-zoom-out', 'Zoom 2', ['Trending', 'Camera'], 0, (p) => ({ scale: lerp(1.18, 1.0, p) })),
  a('kenburns-pan-r', 'Pan Right', ['Camera'], 0, (p) => ({ scale: 1.15, translateX: lerp(-0.06, 0.06, p) })),
  a('kenburns-pan-l', 'Pan Left', ['Camera'], 0, (p) => ({ scale: 1.15, translateX: lerp(0.06, -0.06, p) })),
  a('kenburns-pan-u', 'Pan Up', ['Camera'], 0, (p) => ({ scale: 1.15, translateY: lerp(0.06, -0.06, p) })),
  a('rock-vertical', 'Rock Vertically', ['Trending', 'Camera'], 0, (p) => ({ scale: 1.1, translateY: 0.03 * Math.sin(p * TAU * 1.5) })),
  a('rock-horizontal', 'Rock Horizontally', ['Camera'], 0, (p) => ({ scale: 1.1, translateX: 0.03 * Math.sin(p * TAU * 1.5) })),
  a('pulse', 'Pulse', ['Light'], 0, (p) => ({ scale: 1 + 0.05 * Math.sin(p * TAU * 3) })),
  a('sway', 'Sway', ['Light'], 0, (p) => ({ scale: 1.06, rotate: 0.03 * Math.sin(p * TAU) })),
  a('breathe', 'Breathe', ['Light'], 0, (p) => ({ scale: 1.05 + 0.05 * (0.5 - 0.5 * Math.cos(p * TAU * 2)) })),
  a('shake', 'Shake', ['Glitch'], 0, (p) => ({ scale: 1.06, translateX: 0.008 * Math.sin(p * 90), translateY: 0.008 * Math.cos(p * 83) })),
  a('spin-slow', 'Spin', ['Glitch', 'Camera'], 0, (p) => ({ scale: 1.15, rotate: p * 0.2 })),
  // ── Ken-Burns variants + cinematic moves (the staples for AI-story videos) ──
  a('kb-tl-br', 'Zoom TL→BR', ['Cinematic', 'Camera'], 0, (p) => ({ scale: lerp(1.06, 1.22, p), translateX: lerp(0.05, -0.05, p), translateY: lerp(0.05, -0.05, p) })),
  a('kb-tr-bl', 'Zoom TR→BL', ['Cinematic', 'Camera'], 0, (p) => ({ scale: lerp(1.06, 1.22, p), translateX: lerp(-0.05, 0.05, p), translateY: lerp(0.05, -0.05, p) })),
  a('kb-out-slow', 'Slow Pull-Out', ['Cinematic', 'Camera'], 0, (p) => ({ scale: lerp(1.25, 1.05, p) })),
  a('kb-in-slow', 'Slow Push-In', ['Cinematic', 'Camera'], 0, (p) => ({ scale: lerp(1.02, 1.16, p) })),
  a('float', 'Float', ['Cinematic', 'Light'], 0, (p) => ({ scale: 1.1, translateY: 0.02 * Math.sin(p * TAU) })),
  a('drift-cine', 'Cinematic Drift', ['Cinematic', 'Camera'], 0, (p) => ({ scale: 1.14, translateX: lerp(-0.05, 0.05, p), translateY: lerp(0.02, -0.02, p) })),
  a('heartbeat', 'Heartbeat', ['Light'], 0, (p) => ({ scale: 1.05 + 0.03 * Math.max(0, Math.sin(p * TAU * 4)) })),
  a('parallax', 'Parallax', ['3D', 'Camera'], 0, (p) => ({ scale: 1.16, translateX: 0.06 * Math.sin(p * TAU * 0.5), rotate: 0.01 * Math.sin(p * TAU) })),
];

function a(id: string, name: string, tags: string[], defaultDuration: number, fn: AnimFn): AnimEntry {
  // category is a placeholder here; the real value is stamped on below per-array.
  return { id, name, tags, defaultDuration, fn, category: 'in' };
}

// Stamp the real category onto each entry.
IN.forEach((e) => (e.category = 'in'));
OUT.forEach((e) => (e.category = 'out'));
COMBO.forEach((e) => (e.category = 'combo'));

const ALL: AnimEntry[] = [...IN, ...OUT, ...COMBO];
const BY_ID = new Map<string, AnimEntry>(ALL.map((e) => [e.id, e]));

/** The "None" pseudo-entry, used to clear a slot in the UI. */
export const NONE_ID = '__none__';

export function catalogFor(category: AnimCategory): AnimationDef[] {
  return ALL.filter((e) => e.category === category).map(stripFn);
}

/** Every animation across all categories (for building a favorites list). */
export function allAnims(): AnimationDef[] {
  return ALL.map(stripFn);
}

export function animCategory(id: string): AnimCategory | null {
  return BY_ID.get(id)?.category ?? null;
}

export function allTags(category: AnimCategory): string[] {
  const set = new Set<string>();
  for (const e of ALL) if (e.category === category) e.tags.forEach((t) => set.add(t));
  return ['All', ...Array.from(set)];
}

export function getAnim(id: string): AnimationDef | null {
  const e = BY_ID.get(id);
  return e ? stripFn(e) : null;
}

export function animName(id: string | undefined): string {
  if (!id) return 'None';
  return BY_ID.get(id)?.name || 'None';
}

function stripFn(e: AnimEntry): AnimationDef {
  const { fn, ...def } = e;
  return def;
}

// ─── Transform composition ───────────────────────────────────────

function merge(base: FrameTransform, part: Partial<FrameTransform>): FrameTransform {
  return {
    scale: base.scale * (part.scale ?? 1),
    translateX: base.translateX + (part.translateX ?? 0),
    translateY: base.translateY + (part.translateY ?? 0),
    rotate: base.rotate + (part.rotate ?? 0),
    opacity: base.opacity * (part.opacity ?? 1),
  };
}

/**
 * Compute the composite transform for a clip at `localTime` seconds into a clip
 * of length `clipDur` seconds, given its animation config. A `combo` animation
 * (if present) takes over the whole clip; otherwise `in` plays at the start and
 * `out` plays at the end.
 */
export function computeTransform(
  cfg: ClipAnimationConfig | undefined,
  localTime: number,
  clipDur: number,
): FrameTransform {
  if (!cfg || clipDur <= 0) return IDENTITY;
  let t: FrameTransform = { ...IDENTITY };

  if (cfg.combo && cfg.combo.animId !== NONE_ID) {
    const e = BY_ID.get(cfg.combo.animId);
    if (e) {
      // Combo runs across its duration window (or the whole clip when
      // fullDuration), then holds the final pose for the rest of the clip.
      const window = cfg.combo.fullDuration ? clipDur : Math.min(cfg.combo.duration || clipDur, clipDur);
      const p = window > 0 ? clamp01(localTime / window) : 0;
      t = merge(t, e.fn(p));
    }
    return t;
  }

  if (cfg.in && cfg.in.animId !== NONE_ID) {
    const e = BY_ID.get(cfg.in.animId);
    if (e) {
      const inDur = cfg.in.fullDuration ? clipDur : Math.min(cfg.in.duration, clipDur);
      if (inDur > 0 && localTime < inDur) {
        t = merge(t, e.fn(clamp01(localTime / inDur)));
      }
    }
  }

  if (cfg.out && cfg.out.animId !== NONE_ID) {
    const e = BY_ID.get(cfg.out.animId);
    if (e) {
      const outDur = cfg.out.fullDuration ? clipDur : Math.min(cfg.out.duration, clipDur);
      if (outDur > 0 && localTime > clipDur - outDur) {
        t = merge(t, e.fn(clamp01(1 - (clipDur - localTime) / outDur)));
      }
    }
  }

  return t;
}

/**
 * Does this clip's animation config request more time than the clip has?
 * Used to highlight clips that need manual duration adjustment (never forced).
 */
export function isOverDuration(cfg: ClipAnimationConfig | undefined, clipDur: number): boolean {
  if (!cfg || clipDur <= 0) return false;
  const inDur = cfg.in && !cfg.in.fullDuration && cfg.in.animId !== NONE_ID ? cfg.in.duration : 0;
  const outDur = cfg.out && !cfg.out.fullDuration && cfg.out.animId !== NONE_ID ? cfg.out.duration : 0;
  if (inDur > clipDur + 1e-6) return true;
  if (outDur > clipDur + 1e-6) return true;
  if (inDur + outDur > clipDur + 1e-6) return true;
  return false;
}

/** Whether a config has any active animation. */
export function hasAnimation(cfg: ClipAnimationConfig | undefined): boolean {
  if (!cfg) return false;
  const active = (x?: { animId: string }) => !!x && x.animId !== NONE_ID;
  return active(cfg.in) || active(cfg.out) || active(cfg.combo);
}
