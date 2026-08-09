// app/world/terrain/styles.ts
//
// Named styles: "icy peaks", "cherry blossom", "volcanic".
//
// A style is nothing but a bag of numbers. That is the whole trick. The text
// agent maps a prompt onto one of these presets (or nudges its numbers), and
// the pipeline reads them — the model never emits geometry, so it can never
// emit geometry that fails to load.
//
// Two halves, deliberately separate:
//   shape   -> fed to synthesize(), changes the landform itself
//   palette -> fed to the mesh colouring, changes how it reads
//
// Shape params are part of the stored recipe, so they must stay deterministic.
// Palette params are pure presentation and can change without a re-synthesize.

import type { TerrainOptions } from './pipeline';

/** How the landform is built. A subset of TerrainOptions plus the new knobs. */
export interface StyleShape {
  /** Fractal detail strength, 0..1. Low = smooth hills, high = broken rock. */
  roughness: number;
  /** 0 = rounded fbm hills, 1 = sharp ridged-multifractal spines. */
  ridged: number;
  /** Domain warp strength. Bends ridgelines so they meander instead of running straight. */
  warp: number;
  /** Hydraulic erosion droplets. More = deeper, more branched valleys. */
  erosion: number;
  /** Final power curve. >1 pushes mass into valleys (dramatic), <1 flattens (plateau). */
  curve: number;
  /** Peak height in metres. */
  maxHeight: number;
}

/** How the landform is coloured. Heights are normalized 0..1 of maxHeight. */
export interface StylePalette {
  /** Hex colours, low band to high band. */
  low: string;
  mid: string;
  high: string;
  peak: string;
  /** Normalized height where `peak` takes over — the snowline. */
  snowline: number;
  /** Slopes steeper than this show `high` (rock) regardless of altitude. */
  rockSlope: number;
  /** Scatter tint for whatever flora the flora pipeline drops here. */
  accent: string;
}

export interface TerrainStyle {
  name: string;
  /** Shown in the UI when a style is picked. */
  label: string;
  shape: StyleShape;
  palette: StylePalette;
}

/* --------------------------------------------------------------- presets --- */

export const STYLES: Record<string, TerrainStyle> = {
  default: {
    name: 'default',
    label: 'Highlands',
    shape: { roughness: 0.72, ridged: 0.4, warp: 0.25, erosion: 2200, curve: 1.05, maxHeight: 55 },
    palette: {
      low: '#6f6a4f',
      mid: '#3f6b4a',
      high: '#6b7a8f',
      peak: '#e8eef7',
      snowline: 0.78,
      rockSlope: 0.62,
      accent: '#4a7c59',
    },
  },

  icy: {
    name: 'icy',
    label: 'Icy Peaks',
    // Sharp and tall: ridged weight makes knife-edge aretes, and erosion stays
    // light because past a couple of thousand droplets it sands them back into
    // a dome. Ridged and roughness are both held below the point where the
    // detail starts shattering the massif into separate islands — that reads
    // as scree, not a peak. Low snowline puts white almost everywhere.
    shape: { roughness: 0.6, ridged: 0.62, warp: 0.2, erosion: 2600, curve: 1.15, maxHeight: 70 },
    palette: {
      low: '#5b6a78',
      mid: '#8fa3b5',
      high: '#c3d2e0',
      peak: '#ffffff',
      snowline: 0.34,
      rockSlope: 0.72,
      accent: '#bcd4e6',
    },
  },

  blossom: {
    name: 'blossom',
    label: 'Cherry Blossom',
    // Soft and low. Rounded (low ridged), gentle curve so it reads as rolling
    // hills you'd walk through, not climb. Pink accent is what the flora
    // pipeline reads to scatter blossom trees.
    shape: { roughness: 0.4, ridged: 0.12, warp: 0.45, erosion: 1500, curve: 0.9, maxHeight: 34 },
    palette: {
      low: '#8f7f6a',
      mid: '#7fa86a',
      high: '#c98fa8',
      peak: '#ffd9e8',
      snowline: 0.72,
      rockSlope: 0.55,
      accent: '#ff9ec4',
    },
  },

  volcanic: {
    name: 'volcanic',
    label: 'Volcanic',
    // Steep cones, minimal erosion (fresh basalt hasn't been carved yet),
    // hard curve so the flanks fall away fast. Glowing peak.
    shape: { roughness: 0.55, ridged: 0.45, warp: 0.15, erosion: 1200, curve: 1.35, maxHeight: 64 },
    palette: {
      low: '#3a3230',
      mid: '#2e2724',
      high: '#4a3a34',
      peak: '#ff6a2a',
      snowline: 0.88,
      rockSlope: 0.5,
      accent: '#ff8c42',
    },
  },

  desert: {
    name: 'desert',
    label: 'Desert Mesa',
    // Flat tops: curve well below 1 gives plateaus, and near-zero erosion
    // keeps the mesa edges square instead of rounding them off.
    shape: { roughness: 0.5, ridged: 0.2, warp: 0.6, erosion: 800, curve: 0.6, maxHeight: 44 },
    palette: {
      low: '#c9a227',
      mid: '#b5763a',
      high: '#8f4f2f',
      peak: '#d9a066',
      snowline: 0.92,
      rockSlope: 0.45,
      accent: '#c98f4a',
    },
  },

  verdant: {
    name: 'verdant',
    label: 'Verdant Valley',
    // The most eroded style, but still modest in absolute terms: enough
    // droplets to carve branching valleys into the flanks without flattening
    // the massif into a mound.
    shape: { roughness: 0.6, ridged: 0.3, warp: 0.35, erosion: 4000, curve: 1.0, maxHeight: 48 },
    palette: {
      low: '#4a6b3a',
      mid: '#2f5c34',
      high: '#5f6b4a',
      peak: '#9fb08f',
      snowline: 0.85,
      rockSlope: 0.6,
      accent: '#3f8c4a',
    },
  },
};

export const DEFAULT_STYLE = STYLES.default;

/** Look up a style by name, falling back rather than throwing — a bad name from
 *  the agent must never break the render. */
export function styleFor(name?: string): TerrainStyle {
  if (!name) return DEFAULT_STYLE;
  return STYLES[name.toLowerCase()] ?? DEFAULT_STYLE;
}

/**
 * Merge a style's shape into synthesize() options.
 * Explicit opts win, so a caller can always override one number.
 */
export function optionsFor(style: TerrainStyle, opts: TerrainOptions = {}): TerrainOptions {
  return {
    roughness: style.shape.roughness,
    ridged: style.shape.ridged,
    warp: style.shape.warp,
    erosion: style.shape.erosion,
    curve: style.shape.curve,
    maxHeight: style.shape.maxHeight,
    ...opts,
  };
}

/* ----------------------------------------------------------------- agent --- */

/**
 * The parameter schema this pipeline accepts from the text agent, per the
 * shared contract. Keep it flat and numeric — models are reliable at
 * "icy peaks" -> {style: "icy", snowline: 0.3} and unreliable at anything
 * structured beyond that.
 */
export const AGENT_PARAM_SCHEMA = {
  style: { type: 'enum', values: Object.keys(STYLES), description: 'Base preset to start from.' },
  snowline: { type: 'number', min: 0, max: 1, description: 'Normalized height where peak colour starts.' },
  roughness: { type: 'number', min: 0, max: 1, description: 'Surface detail strength.' },
  ridged: { type: 'number', min: 0, max: 1, description: '0 rounded hills, 1 knife-edge ridges.' },
  maxHeight: { type: 'number', min: 10, max: 120, description: 'Peak height in metres.' },
} as const;

/** Clamp helper so an out-of-range number from the agent can't break geometry. */
function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Apply agent params on top of a base preset. Every field is optional and
 * every value is clamped, so a malformed response degrades to the preset
 * instead of producing broken terrain.
 */
export function applyAgentParams(params: Record<string, unknown>): TerrainStyle {
  const base = styleFor(typeof params.style === 'string' ? params.style : undefined);
  const shape = { ...base.shape };
  const palette = { ...base.palette };

  if ('roughness' in params) shape.roughness = clamp(params.roughness, 0, 1, shape.roughness);
  if ('ridged' in params) shape.ridged = clamp(params.ridged, 0, 1, shape.ridged);
  if ('warp' in params) shape.warp = clamp(params.warp, 0, 1, shape.warp);
  if ('curve' in params) shape.curve = clamp(params.curve, 0.4, 2.5, shape.curve);
  if ('maxHeight' in params) shape.maxHeight = clamp(params.maxHeight, 10, 120, shape.maxHeight);
  if ('erosion' in params) shape.erosion = Math.round(clamp(params.erosion, 0, 30000, shape.erosion));
  if ('snowline' in params) palette.snowline = clamp(params.snowline, 0, 1, palette.snowline);
  if ('rockSlope' in params) palette.rockSlope = clamp(params.rockSlope, 0, 1, palette.rockSlope);

  return { ...base, shape, palette };
}
