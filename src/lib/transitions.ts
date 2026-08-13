// ─────────────────────────────────────────────────────────────────
// Transition catalog. A transition plays at the START of a clip and blends it
// with the previous clip over `duration` seconds. Each transition is expressed
// as a set of draw "layers" (previous and/or incoming clip) with an alpha,
// translation and scale — composited by the renderer. Same engine drives the
// live preview and the MP4 export.
// ─────────────────────────────────────────────────────────────────

export interface TransitionDef {
  id: string;
  name: string;
  tags: string[];
  defaultDuration: number;
}

export interface TransLayer {
  which: 'prev' | 'curr';
  /** 0–1 */
  alpha: number;
  /** translation as a fraction of width/height */
  dx: number;
  dy: number;
  /** extra scale multiplier */
  scale: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

type LayerFn = (p: number) => TransLayer[];

interface TransEntry extends TransitionDef {
  fn: LayerFn;
}

const T: TransEntry[] = [
  t('dissolve', 'Dissolve', ['Basic', 'Trending'], 0.5, (p) => [
    { which: 'prev', alpha: 1, dx: 0, dy: 0, scale: 1 },
    { which: 'curr', alpha: easeInOut(p), dx: 0, dy: 0, scale: 1 },
  ]),
  t('fade-black', 'Fade to Black', ['Basic'], 0.6, (p) =>
    p < 0.5
      ? [{ which: 'prev', alpha: 1 - p * 2, dx: 0, dy: 0, scale: 1 }]
      : [{ which: 'curr', alpha: (p - 0.5) * 2, dx: 0, dy: 0, scale: 1 }],
  ),
  t('fade-white', 'Fade to White', ['Basic'], 0.6, (p) =>
    // Approximated as a quick dissolve; the white flash is drawn by the renderer.
    p < 0.5
      ? [{ which: 'prev', alpha: 1 - p * 2, dx: 0, dy: 0, scale: 1 }]
      : [{ which: 'curr', alpha: (p - 0.5) * 2, dx: 0, dy: 0, scale: 1 }],
  ),
  t('slide-left', 'Slide Left', ['Basic', 'Camera'], 0.5, (p) => [
    { which: 'prev', alpha: 1, dx: -easeInOut(p), dy: 0, scale: 1 },
    { which: 'curr', alpha: 1, dx: 1 - easeInOut(p), dy: 0, scale: 1 },
  ]),
  t('slide-right', 'Slide Right', ['Basic', 'Camera'], 0.5, (p) => [
    { which: 'prev', alpha: 1, dx: easeInOut(p), dy: 0, scale: 1 },
    { which: 'curr', alpha: 1, dx: -(1 - easeInOut(p)), dy: 0, scale: 1 },
  ]),
  t('slide-up', 'Slide Up', ['Camera'], 0.5, (p) => [
    { which: 'prev', alpha: 1, dx: 0, dy: -easeInOut(p), scale: 1 },
    { which: 'curr', alpha: 1, dx: 0, dy: 1 - easeInOut(p), scale: 1 },
  ]),
  t('slide-down', 'Slide Down', ['Camera'], 0.5, (p) => [
    { which: 'prev', alpha: 1, dx: 0, dy: easeInOut(p), scale: 1 },
    { which: 'curr', alpha: 1, dx: 0, dy: -(1 - easeInOut(p)), scale: 1 },
  ]),
  t('zoom-in', 'Zoom In', ['Trending', 'Camera'], 0.5, (p) => [
    { which: 'prev', alpha: 1 - easeInOut(p), dx: 0, dy: 0, scale: 1 + 0.5 * p },
    { which: 'curr', alpha: easeInOut(p), dx: 0, dy: 0, scale: lerp(1.4, 1, p) },
  ]),
  t('zoom-out', 'Zoom Out', ['Trending', 'Camera'], 0.5, (p) => [
    { which: 'prev', alpha: 1 - easeInOut(p), dx: 0, dy: 0, scale: lerp(1, 0.6, p) },
    { which: 'curr', alpha: easeInOut(p), dx: 0, dy: 0, scale: lerp(0.7, 1, p) },
  ]),
  t('whip-left', 'Whip Left', ['Trending'], 0.35, (p) => [
    { which: 'prev', alpha: 1 - p, dx: -0.4 * p, dy: 0, scale: 1 },
    { which: 'curr', alpha: p, dx: 0.4 * (1 - p), dy: 0, scale: 1 },
  ]),
];

function t(id: string, name: string, tags: string[], defaultDuration: number, fn: LayerFn): TransEntry {
  return { id, name, tags, defaultDuration, fn };
}

const BY_ID = new Map<string, TransEntry>(T.map((e) => [e.id, e]));

export const TRANS_NONE_ID = 'none';

export function transitionCatalog(): TransitionDef[] {
  return T.map(({ fn, ...def }) => def);
}

export function transitionTags(): string[] {
  const set = new Set<string>();
  for (const e of T) e.tags.forEach((x) => set.add(x));
  return ['All', ...Array.from(set)];
}

export function transitionName(id: string | undefined): string {
  if (!id || id === TRANS_NONE_ID) return 'None';
  return BY_ID.get(id)?.name || 'None';
}

export function transitionDefaultDuration(id: string): number {
  return BY_ID.get(id)?.defaultDuration ?? 0.5;
}

/** The layers to composite for a transition at progress p ∈ [0,1]. */
export function transitionLayers(id: string, p: number): TransLayer[] {
  const e = BY_ID.get(id);
  if (!e) return [{ which: 'curr', alpha: 1, dx: 0, dy: 0, scale: 1 }];
  return e.fn(clamp01(p));
}

/** Some transitions flash a solid colour mid-way (e.g. fade to white). */
export function transitionFlash(id: string, p: number): { color: string; alpha: number } | null {
  if (id === 'fade-white') {
    const a = 1 - Math.abs(p - 0.5) * 2; // peaks at p=0.5
    return { color: '#ffffff', alpha: a };
  }
  return null;
}
