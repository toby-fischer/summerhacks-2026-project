// app/world/terrain/sketch.ts
//
// The stored recipe. We persist the 64x64 drawing (~2KB base64), not the
// 128x128 float heightmap (~64KB) synthesized from it — every client re-runs
// the deterministic pipeline and lands on identical terrain.

/** Sketch resolution as stored. Small enough for jsonb, enough for landform. */
export const SKETCH_GRID = 64;

/**
 * Footprint of one contributed massif, in metres.
 *
 * Deliberately smaller than the 64-cell sketch grid might suggest: at 300m a
 * patch sprawled far enough that two contributions placed a normal walk apart
 * overlapped, and the max-height stack turned them into one shapeless mass.
 * 180m keeps a mountain readable as *one* mountain.
 */
export const PATCH_SCALE = 180;

/**
 * Synthesis grid for a patch. Higher than the stored sketch (64) on purpose —
 * the sketch supplies the silhouette, and upsampling gives the fractal and
 * erosion passes room to put detail *between* the drawn cells. At 64 on a
 * 180m patch each cell is ~2.8m and the surface comes out a smooth dome;
 * at 128 it's ~1.4m, which is where ridges and gullies become visible.
 */
export const SYNTH_GRID = 128;

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

/**
 * Bilinearly resample a square grid. Used to lift the stored 64x64 sketch to
 * the finer synthesis grid before the detail passes run — upsampling the
 * silhouette costs nothing and gives fbm and erosion somewhere to put detail.
 */
export function resample(
  src: Float32Array<ArrayBuffer>,
  from: number,
  to: number,
): Float32Array<ArrayBuffer> {
  if (from === to) return Float32Array.from(src);
  const out = new Float32Array(to * to);
  const ratio = (from - 1) / (to - 1);

  for (let y = 0; y < to; y++) {
    const sy = y * ratio;
    const y0 = Math.floor(sy);
    const y1 = Math.min(from - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < to; x++) {
      const sx = x * ratio;
      const x0 = Math.floor(sx);
      const x1 = Math.min(from - 1, x0 + 1);
      const fx = sx - x0;

      out[y * to + x] =
        src[y0 * from + x0] * (1 - fx) * (1 - fy) +
        src[y0 * from + x1] * fx * (1 - fy) +
        src[y1 * from + x0] * (1 - fx) * fy +
        src[y1 * from + x1] * fx * fy;
    }
  }
  return out;
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
