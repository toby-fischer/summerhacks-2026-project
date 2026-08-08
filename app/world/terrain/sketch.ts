// app/world/terrain/sketch.ts
//
// The stored recipe. We persist the 64x64 drawing (~2KB base64), not the
// 128x128 float heightmap (~64KB) synthesized from it — every client re-runs
// the deterministic pipeline and lands on identical terrain.

/** Sketch resolution as stored. Small enough for jsonb, enough for landform. */
export const SKETCH_GRID = 64;

/** Footprint of one contributed massif, in metres. */
export const PATCH_SCALE = 300;

/** Quantize a 0..1 grid to bytes and base64 it. */
export function encodeSketch(grid: Float32Array<ArrayBuffer>): string {
  const bytes = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    bytes[i] = Math.max(0, Math.min(255, Math.round(grid[i] * 255)));
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Inverse of encodeSketch. Short or corrupt input yields zeros, never throws. */
export function decodeSketch(b64: string): Float32Array<ArrayBuffer> {
  const out = new Float32Array(SKETCH_GRID * SKETCH_GRID);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return out; // a bad row must not take down the whole world
  }
  const n = Math.min(bin.length, out.length);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i) / 255;
  return out;
}
