// app/biomes.ts
//
// Deterministic world generation. Everything here is a pure function of world
// coordinates, which matters for two reasons:
//
//   1. The world is shared. Two people standing in the same place must see the
//      same mushrooms, so scatter cannot use Math.random().
//   2. Nothing is stored. A 400x400 field of flora would be a lot of rows in
//      Supabase; deriving it from coordinates costs nothing and never desyncs.

import * as THREE from 'three';

export type BiomeId = 'meadow' | 'hollow' | 'reach';

export interface Biome {
  id: BiomeId;
  name: string;
  /** Distance fog. Doubles as the horizon color, so it reads as the sky's ground haze. */
  fog: string;
  /** Ground albedo. Kept dark so emissive props stay the brightest thing on screen. */
  ground: string;
  /** Tints the biome's fill light. */
  light: string;
  /** Firefly / mote color. */
  motes: string;
  /** Emissive color for whatever grows here. */
  flora: string;
  /** Color a beacon takes when planted in this biome. */
  beacon: string;
  /** Exponential fog density. Denser reads as more enclosed. */
  density: number;
}

export const BIOMES: Record<BiomeId, Biome> = {
  meadow: {
    id: 'meadow',
    name: 'Verdant Meadow',
    fog: '#050b14',
    ground: '#16323b',
    light: '#4a7f8c',
    motes: '#ffc46b',
    flora: '#6bd68a',
    beacon: '#ffd88a',
    density: 0.018,
  },
  hollow: {
    id: 'hollow',
    name: 'Fungal Hollow',
    fog: '#0a0618',
    ground: '#241c42',
    light: '#8a4fd6',
    motes: '#5ff2e0',
    flora: '#42e8d0',
    beacon: '#ff7ae0',
    // Denser than the meadow to feel enclosed, but not so dense it erases the
    // mushrooms it exists to frame.
    density: 0.016,
  },
  reach: {
    id: 'reach',
    name: 'Amethyst Reach',
    fog: '#0d0618',
    ground: '#281b4d',
    light: '#a065ff',
    motes: '#d8a2ff',
    flora: '#b06bff',
    beacon: '#9d7aff',
    density: 0.022,
  },
};

export const BIOME_IDS = Object.keys(BIOMES) as BiomeId[];

/**
 * Integer hash -> [0,1). Deterministic across machines: pure 32-bit integer ops,
 * no floating point accumulation that could drift between platforms.
 */
export function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise built on hash2. Smooth, seamless, and cheap. */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);

  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);

  return (
    a * (1 - xf) * (1 - yf) + b * xf * (1 - yf) + c * (1 - xf) * yf + d * xf * yf
  );
}

/** Two octaves. Enough to break up straight edges without looking noisy. */
function fbm(x: number, y: number): number {
  return noise2(x, y) * 0.65 + noise2(x * 2.3 + 11.7, y * 2.3 - 4.1) * 0.35;
}

export interface BiomeSample {
  weights: Record<BiomeId, number>;
  dominant: BiomeId;
}

const SCALE = 0.0055; // world units -> noise space. Larger biomes = smaller number.

/**
 * Biome weights at a world position, normalized to sum to 1.
 *
 * Direction sets the broad layout (hollow north, reach east) so the world is
 * navigable — "the mushrooms are north" is a thing you can tell someone. Noise
 * then warps the borders so they wander instead of running as straight lines.
 */
export function sampleBiome(x: number, z: number): BiomeSample {
  const warp = (fbm(x * SCALE, z * SCALE) - 0.5) * 2.2;

  // Smooth directional fields in [0,1], nudged off-center by the noise warp.
  const north = THREE.MathUtils.clamp(-z / 260 + warp * 0.55, -1, 1);
  const east = THREE.MathUtils.clamp(x / 260 + warp * 0.55, -1, 1);

  const hollow = Math.max(0, north) ** 1.6;
  const reach = Math.max(0, east) ** 1.6;
  // Meadow is the default: it wins wherever neither other biome asserts itself.
  const meadow = Math.max(0.12, 1 - hollow - reach);

  const total = hollow + reach + meadow;
  const weights = {
    meadow: meadow / total,
    hollow: hollow / total,
    reach: reach / total,
  } as Record<BiomeId, number>;

  let dominant: BiomeId = 'meadow';
  for (const id of BIOME_IDS) {
    if (weights[id] > weights[dominant]) dominant = id;
  }

  return { weights, dominant };
}

/** Blend any per-biome color by the sampled weights, writing into `target`. */
export function blendColor(
  weights: Record<BiomeId, number>,
  key: 'fog' | 'ground' | 'light' | 'motes' | 'flora',
  target: THREE.Color,
): THREE.Color {
  let r = 0;
  let g = 0;
  let b = 0;
  const tmp = blendColor._tmp;
  for (const id of BIOME_IDS) {
    const w = weights[id];
    if (w <= 0.001) continue;
    tmp.set(BIOMES[id][key]);
    r += tmp.r * w;
    g += tmp.g * w;
    b += tmp.b * w;
  }
  target.setRGB(r, g, b);
  return target;
}
blendColor._tmp = new THREE.Color();

/** Blend the scalar fog density the same way, so borders don't pop. */
export function blendDensity(weights: Record<BiomeId, number>): number {
  let d = 0;
  for (const id of BIOME_IDS) d += BIOMES[id].density * weights[id];
  return d;
}

export interface Prop {
  key: string;
  position: [number, number, number];
  rotation: number;
  scale: number;
  biome: BiomeId;
}

/**
 * Scatter props across a cell grid. One candidate per cell, jittered — a cheap
 * Poisson-ish distribution that avoids both clumping and visible grid rows.
 *
 * Only cells within `radius` of the viewer are considered, so cost is bounded
 * by view distance rather than world size. The world itself is unbounded.
 */
export function propsAround(
  cx: number,
  cz: number,
  radius: number,
  cell: number,
  wanted: BiomeId,
  density: number,
): Prop[] {
  const out: Prop[] = [];
  const c0x = Math.floor((cx - radius) / cell);
  const c1x = Math.floor((cx + radius) / cell);
  const c0z = Math.floor((cz - radius) / cell);
  const c1z = Math.floor((cz + radius) / cell);
  const r2 = radius * radius;

  for (let gx = c0x; gx <= c1x; gx++) {
    for (let gz = c0z; gz <= c1z; gz++) {
      const h = hash2(gx, gz);
      if (h > density) continue;

      // Reuse the hash at different scales for jitter/rotation/size. Cheaper
      // than more hashing and the correlation isn't perceptible in scatter.
      const jx = hash2(gx + 9871, gz);
      const jz = hash2(gx, gz + 1237);
      const px = (gx + jx) * cell;
      const pz = (gz + jz) * cell;

      const dx = px - cx;
      const dz = pz - cz;
      if (dx * dx + dz * dz > r2) continue;

      // A prop only appears if its own square is that biome, so flora fades out
      // near borders instead of ending on a hard line.
      const { weights } = sampleBiome(px, pz);
      if (weights[wanted] < 0.45) continue;

      out.push({
        key: `${gx}:${gz}`,
        position: [px, 0, pz],
        rotation: hash2(gx + 55, gz + 55) * Math.PI * 2,
        scale: 0.65 + hash2(gx - 31, gz + 17) * 0.7,
        biome: wanted,
      });
    }
  }
  return out;
}
