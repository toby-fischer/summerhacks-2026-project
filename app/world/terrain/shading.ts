// app/world/terrain/shading.ts
//
// Turning a heightfield into something you'd screenshot.
//
// Three ideas, all cheap, all done on the CPU once at build time so there is
// no custom material to maintain and instancing stays trivial:
//
//   1. ALTITUDE BANDS from the style palette (low -> mid -> high -> peak).
//   2. SLOPE OVERRIDE — steep faces are rock at any altitude. This is the one
//      that matters. Without it every patch is a horizontal colour ramp and
//      reads as a contour map; with it, cliffs are grey and shelves are green,
//      which is what real hillsides do.
//   3. A little deterministic mottling so large flat areas aren't dead flat
//      colour.
//
// No Three.js import: this stays pure so it can be unit-tested and so the
// renderer owns all the Three-specific work.

import type { TerrainData } from './pipeline';
import type { StylePalette } from './styles';
import { hash } from './pipeline';

/* ----------------------------------------------------------------- colour --- */

interface RGB {
  r: number;
  g: number;
  b: number;
}

/** '#rrggbb' -> linear-ish 0..1 RGB. */
function parseHex(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
}

/* ---------------------------------------------------------------- shading --- */

export interface ShadeOptions {
  /**
   * Per-vertex rim falloff, same length as heights. Supplied by the renderer
   * so colour matches the geometry it actually drew rather than the raw
   * heightfield. Optional.
   */
  falloff?: Float32Array;
  /** Mottling strength, 0..1. */
  mottle?: number;
  seed?: number;
}

/**
 * Build a per-vertex colour buffer (r,g,b triples) for a terrain patch.
 *
 * Returns a flat Float32Array of length size*size*3, ready to drop straight
 * into a BufferAttribute.
 */
export function shadeTerrain(
  terrain: TerrainData,
  palette: StylePalette,
  opts: ShadeOptions = {},
): Float32Array {
  const { heights, slopes, maxHeight } = terrain;
  const count = heights.length;
  const out = new Float32Array(count * 3);

  const low = parseHex(palette.low);
  const mid = parseHex(palette.mid);
  const high = parseHex(palette.high);
  const peak = parseHex(palette.peak);

  const mottleAmt = opts.mottle ?? 0.06;
  const seed = opts.seed ?? 1337;
  const size = terrain.size;

  // The snowline sits at a fraction of max height; the bands below it are
  // spread across the remaining range so a low snowline doesn't squash
  // everything else into nothing.
  const snow = palette.snowline;
  const bandLow = snow * 0.28;
  const bandMid = snow * 0.62;

  for (let i = 0; i < count; i++) {
    const fall = opts.falloff ? opts.falloff[i] : 1;
    const t = Math.min(1, (heights[i] * fall) / (maxHeight || 1));

    // 1. Altitude bands.
    let c: RGB;
    if (t < bandLow) {
      c = mix(low, mid, smoothstep(0, bandLow, t));
    } else if (t < bandMid) {
      c = mix(mid, high, smoothstep(bandLow, bandMid, t));
    } else if (t < snow) {
      c = high;
    } else {
      c = mix(high, peak, smoothstep(snow, Math.min(1, snow + 0.18), t));
    }

    // 2. Slope override. Steep ground shows rock — but never overrides the
    //    peak band, because a snowy summit stays snowy however steep it is.
    const steep = smoothstep(palette.rockSlope * 0.7, palette.rockSlope, slopes[i]);
    if (steep > 0 && t < snow) {
      c = mix(c, high, steep * 0.85);
    }

    // 3. Deterministic mottling — same for every client, so no visual drift.
    const x = i % size;
    const y = (i / size) | 0;
    const n = (hash(x, y, seed) - 0.5) * mottleAmt;

    out[i * 3] = Math.min(1, Math.max(0, c.r + n));
    out[i * 3 + 1] = Math.min(1, Math.max(0, c.g + n));
    out[i * 3 + 2] = Math.min(1, Math.max(0, c.b + n));
  }

  return out;
}
