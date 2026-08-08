// app/terrain.ts
//
// Sketch -> walkable terrain.
//
// The hard part is not reading the drawing; it is that a traced drawing looks
// like a drawing. A hand-drawn ridgeline at 500m scale reads as a wobbly ramp,
// not a mountain. So the sketch only supplies the *silhouette*, and the passes
// below add the detail that makes it read as landscape:
//
//   sketch -> heightmap -> smooth -> fractal detail -> erosion -> normals
//
// All of it is deterministic and runs in a few ms, so there is no model in the
// live path and nothing to fail during a demo.

export interface TerrainOptions {
  /** Grid resolution. 128 is plenty for a 500m field and stays cheap. */
  size?: number;
  /** World size in metres. */
  scale?: number;
  /** Peak height in metres. */
  maxHeight?: number;
  /** Fractal detail strength, 0..1. */
  roughness?: number;
  /** Hydraulic erosion droplet count. 0 disables. */
  erosion?: number;
  seed?: number;
}

export interface TerrainData {
  size: number;
  scale: number;
  maxHeight: number;
  /** Row-major elevations in metres, length size*size. */
  heights: Float32Array<ArrayBuffer>;
  stats: { min: number; max: number; mean: number; peaks: number };
}

/* ---------------------------------------------------------------- noise --- */

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smoothstep(x - xi);
  const yf = smoothstep(y - yi);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a * (1 - xf) * (1 - yf) + b * xf * (1 - yf) + c * (1 - xf) * yf + d * xf * yf;
}

/** Fractal brownian motion — octaves of noise at halving amplitude. */
function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 977) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07; // non-integer avoids octaves aligning into visible grids
  }
  return sum / norm;
}

/* ------------------------------------------------------------ from image --- */

/**
 * Read a sketch into a normalized 0..1 height grid.
 *
 * Dark pixels mean high ground: people draw mountains with dark strokes on a
 * light page, so ink density is a good proxy for elevation. Alpha is honoured
 * so a transparent canvas works too.
 */
export function heightsFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  size: number,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(size * size);

  for (let gy = 0; gy < size; gy++) {
    for (let gx = 0; gx < size; gx++) {
      // Box-filter the source region so thin strokes are not missed by
      // point sampling — a 1px pen line would vanish otherwise.
      const x0 = Math.floor((gx / size) * width);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) / size) * width));
      const y0 = Math.floor((gy / size) * height);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) / size) * height));

      let acc = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          const a = data[i + 3] / 255;
          // Perceptual luminance, then invert: dark ink = high ground.
          const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          acc += (1 - lum) * a;
          n++;
        }
      }
      out[gy * size + gx] = n ? acc / n : 0;
    }
  }
  return out;
}

/* --------------------------------------------------------------- passes --- */

/** Separable box blur. Turns jagged pen strokes into landform-scale slopes. */
function blur(
  h: Float32Array<ArrayBuffer>,
  size: number,
  radius: number,
): Float32Array<ArrayBuffer> {
  if (radius < 1) return h;
  const tmp = new Float32Array(h.length);
  const out = new Float32Array(h.length);
  const w = radius * 2 + 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) {
        s += h[y * size + Math.min(size - 1, Math.max(0, x + k))];
      }
      tmp[y * size + x] = s / w;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) {
        s += tmp[Math.min(size - 1, Math.max(0, y + k)) * size + x];
      }
      out[y * size + x] = s / w;
    }
  }
  return out;
}

/**
 * Hydraulic erosion. Drops virtual water, lets it run downhill carrying
 * sediment, and deposits it in hollows.
 *
 * This is the single pass that makes terrain look real: it carves valleys that
 * branch and converge the way water actually shapes rock. Without it, fbm
 * detail reads as generic bumpiness.
 */
function erode(h: Float32Array<ArrayBuffer>, size: number, droplets: number, seed: number): void {
  const idx = (x: number, y: number) => y * size + x;

  for (let d = 0; d < droplets; d++) {
    let x = hash(d, 7, seed) * (size - 1);
    let y = hash(d, 13, seed + 1) * (size - 1);
    let sediment = 0;
    let vx = 0;
    let vy = 0;
    let water = 1;

    for (let step = 0; step < 40; step++) {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      if (xi < 1 || yi < 1 || xi >= size - 2 || yi >= size - 2) break;

      // Central-difference gradient; water flows down the steepest slope.
      const gx = h[idx(xi + 1, yi)] - h[idx(xi - 1, yi)];
      const gy = h[idx(xi, yi + 1)] - h[idx(xi, yi - 1)];

      vx = vx * 0.85 - gx * 0.6;
      vy = vy * 0.85 - gy * 0.6;
      const len = Math.hypot(vx, vy) || 1;
      x += vx / len;
      y += vy / len;

      const nxi = Math.floor(x);
      const nyi = Math.floor(y);
      if (nxi < 1 || nyi < 1 || nxi >= size - 2 || nyi >= size - 2) break;

      const dh = h[idx(nxi, nyi)] - h[idx(xi, yi)];
      const capacity = Math.max(-dh, 0.0005) * water * 5;

      if (sediment > capacity || dh > 0) {
        // Uphill or over capacity: drop sediment, filling valleys.
        const drop = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * 0.4;
        h[idx(xi, yi)] += drop;
        sediment -= drop;
      } else {
        // Downhill with room to carry: cut into the slope.
        const take = Math.min((capacity - sediment) * 0.4, -dh);
        h[idx(xi, yi)] -= take;
        sediment += take;
      }
      water *= 0.98;
    }
  }
}

function normalize(h: Float32Array<ArrayBuffer>): void {
  let min = Infinity;
  let max = -Infinity;
  for (const v of h) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  for (let i = 0; i < h.length; i++) h[i] = (h[i] - min) / range;
}

/** Count local maxima above half height — a rough "how many peaks" read. */
function countPeaks(h: Float32Array<ArrayBuffer>, size: number): number {
  let peaks = 0;
  for (let y = 2; y < size - 2; y++) {
    for (let x = 2; x < size - 2; x++) {
      const v = h[y * size + x];
      if (v < 0.5) continue;
      let isPeak = true;
      for (let dy = -2; dy <= 2 && isPeak; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx || dy) {
            if (h[(y + dy) * size + (x + dx)] > v) {
              isPeak = false;
              break;
            }
          }
        }
      }
      if (isPeak) peaks++;
    }
  }
  return peaks;
}

/* ------------------------------------------------------------- pipeline --- */

/**
 * Turn a normalized sketch grid into finished terrain.
 *
 * Order matters: smooth first so pen jitter does not become spiky rock, then
 * add fractal detail *scaled by elevation* (peaks are rugged, valleys are
 * gentle — flat detail everywhere looks like noise), then erode.
 */
export function synthesize(sketch: Float32Array<ArrayBufferLike>, opts: TerrainOptions = {}): TerrainData {
  const size = opts.size ?? 128;
  const scale = opts.scale ?? 500;
  const maxHeight = opts.maxHeight ?? 70;
  const roughness = opts.roughness ?? 0.45;
  const droplets = opts.erosion ?? 12000;
  const seed = opts.seed ?? 1337;

  let h: Float32Array<ArrayBuffer> = Float32Array.from(sketch);

  // 1. Soften the drawing into landform.
  h = blur(h, size, Math.max(1, Math.round(size / 48)));
  normalize(h);

  // 2. Fractal detail, weighted by height so ridges get rugged and
  //    lowlands stay walkable.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const base = h[i];
      const detail = fbm((x / size) * 6, (y / size) * 6, seed) - 0.5;
      h[i] = base + detail * roughness * (0.25 + base * 0.9);
    }
  }
  normalize(h);

  // 3. Carve valleys.
  if (droplets > 0) {
    erode(h, size, droplets, seed);
    h = blur(h, size, 1); // erosion leaves single-cell spikes
    normalize(h);
  }

  // 4. Gentle curve: pushes mass toward valleys so peaks feel earned
  //    rather than the whole field sitting at mid height.
  for (let i = 0; i < h.length; i++) h[i] = Math.pow(h[i], 1.35);

  const heights = new Float32Array(h.length);
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < h.length; i++) {
    const v = h[i] * maxHeight;
    heights[i] = v;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return {
    size,
    scale,
    maxHeight,
    heights,
    stats: { min, max, mean: sum / heights.length, peaks: countPeaks(h, size) },
  };
}

/** Bilinear height lookup in world space — used to stand the player on the ground. */
export function heightAt(t: TerrainData, wx: number, wz: number): number {
  const half = t.scale / 2;
  const u = ((wx + half) / t.scale) * (t.size - 1);
  const v = ((wz + half) / t.scale) * (t.size - 1);
  if (u < 0 || v < 0 || u > t.size - 1 || v > t.size - 1) return 0;

  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = Math.min(t.size - 1, x0 + 1);
  const y1 = Math.min(t.size - 1, y0 + 1);
  const fx = u - x0;
  const fy = v - y0;

  const h00 = t.heights[y0 * t.size + x0];
  const h10 = t.heights[y0 * t.size + x1];
  const h01 = t.heights[y1 * t.size + x0];
  const h11 = t.heights[y1 * t.size + x1];

  return (
    h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy
  );
}
