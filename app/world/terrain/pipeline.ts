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
  /**
   * Blend between rounded fbm (0) and ridged multifractal (1).
   * Ridged noise is what turns "lumpy hills" into "mountain range with spines".
   */
  ridged?: number;
  /** Domain warp strength, 0..1. Bends ridgelines so they meander. */
  warp?: number;
  /** Final power curve. >1 pushes mass into valleys, <1 gives plateaus. */
  curve?: number;
  seed?: number;
}

export interface TerrainData {
  size: number;
  scale: number;
  maxHeight: number;
  /** Row-major elevations in metres, length size*size. */
  heights: Float32Array<ArrayBuffer>;
  /**
   * Per-cell steepness, 0 (flat) .. 1 (cliff). Computed here rather than in
   * the renderer because it needs the metre-scale cell spacing, and because
   * slope-based shading is what stops every patch looking like a colour ramp:
   * a cliff face is rock at any altitude.
   */
  slopes: Float32Array<ArrayBuffer>;
  stats: { min: number; max: number; mean: number; peaks: number };
}

/* ---------------------------------------------------------------- noise --- */

export function hash(x: number, y: number, seed: number): number {
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

/**
 * Ridged multifractal. Take signed noise, fold it with abs() and invert: the
 * V-shaped creases become sharp crests. This is the classic terrain trick —
 * fbm alone gives rounded blobs, ridged noise gives the knife-edge aretes that
 * make a range read as mountains.
 *
 * Each octave is also weighted by the previous one, so detail only accumulates
 * where the terrain is already high. That is the "multi" in multifractal, and
 * it is why peaks come out rugged while valleys stay smooth.
 */
function ridgedFbm(x: number, y: number, seed: number, octaves = 5): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  let weight = 1;

  for (let o = 0; o < octaves; o++) {
    // Signed noise -> fold -> invert. Squaring sharpens the crest.
    let n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + o * 977) * 2 - 1);
    n *= n;
    n *= weight;

    // Feed this octave forward as the next one's weight, clamped so it
    // cannot run away.
    weight = Math.min(1, n * 2);

    sum += n * amp;
    norm += amp;
    amp *= 0.55;
    freq *= 2.07;
  }
  return norm ? sum / norm : 0;
}

/**
 * Domain warping — evaluate the noise at a position that has itself been
 * displaced by noise. Straight ridgelines become sinuous ones, which is the
 * difference between "a traced pen stroke" and "a range that grew".
 * Cheap: two extra noise lookups per sample.
 */
function warpedSample(
  x: number,
  y: number,
  seed: number,
  strength: number,
  ridged: number,
): number {
  let sx = x;
  let sy = y;
  if (strength > 0) {
    const wx = fbm(x + 5.2, y + 1.3, seed + 4001, 3) - 0.5;
    const wy = fbm(x + 9.7, y + 7.1, seed + 8009, 3) - 0.5;
    sx += wx * strength * 4;
    sy += wy * strength * 4;
  }
  // Blend the two noise characters rather than switching between them, so a
  // style can sit anywhere on the rounded..jagged axis.
  if (ridged <= 0) return fbm(sx, sy, seed);
  if (ridged >= 1) return ridgedFbm(sx, sy, seed);
  return fbm(sx, sy, seed) * (1 - ridged) + ridgedFbm(sx, sy, seed) * ridged;
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

/* -------------------------------------------------------------- erosion --- */
//
// Droplet hydraulic erosion, following the Sebastian Lague / Hans Beyer
// formulation. Two things separate this from the naive version:
//
//   1. Erosion is spread over a weighted BRUSH, not dumped on one cell. A
//      single-cell cut leaves pinprick holes that read as noise; a radius-3
//      brush cuts a valley with banks.
//   2. Deposition is bilinear across the four cells the droplet sits between,
//      so sediment lands smoothly instead of stair-stepping.
//
// The brush is precomputed once per (size, radius) and cached, because
// recomputing it per droplet dominates the runtime.

interface Brush {
  /** Flat cell offsets from the droplet cell. */
  offsets: Int32Array;
  /** Matching normalized weights. */
  weights: Float32Array;
}

const brushCache = new Map<string, Brush>();

/**
 * Precompute a radial falloff brush. Weight is 1 - dist/radius, normalized.
 *
 * Unlike Lague's per-cell version we store a single offset table and skip
 * out-of-bounds cells at apply time. That trades a tiny bit of edge accuracy
 * for an O(radius^2) table instead of O(size^2 * radius^2) — which matters
 * because we synthesize on the client, on load, on a phone.
 */
function erosionBrush(radius: number): Brush {
  const key = `r${radius}`;
  const cached = brushCache.get(key);
  if (cached) return cached;

  const offsets: number[] = [];
  const weights: number[] = [];
  let total = 0;

  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const sq = x * x + y * y;
      if (sq >= radius * radius) continue;
      const w = 1 - Math.sqrt(sq) / radius;
      offsets.push(y, x); // stored as pairs; resolved against size at apply time
      weights.push(w);
      total += w;
    }
  }

  const brush: Brush = {
    offsets: Int32Array.from(offsets),
    weights: Float32Array.from(weights.map((w) => w / total)),
  };
  brushCache.set(key, brush);
  return brush;
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
  // Tuned for a normalized 0..1 heightfield at 128px, not Lague's world units.
  const inertia = 0.05;
  const capacityFactor = 4;
  const minCapacity = 0.01;
  const erodeSpeed = 0.3;
  const depositSpeed = 0.3;
  const evaporate = 0.02;
  const gravity = 4;
  const lifetime = 32;
  const radius = Math.max(2, Math.round(size / 42));

  const brush = erosionBrush(radius);
  const bLen = brush.weights.length;

  for (let d = 0; d < droplets; d++) {
    let x = hash(d, 7, seed) * (size - 2);
    let y = hash(d, 13, seed + 1) * (size - 2);
    let dirX = 0;
    let dirY = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let step = 0; step < lifetime; step++) {
      const nodeX = Math.floor(x);
      const nodeY = Math.floor(y);
      if (nodeX < 0 || nodeY < 0 || nodeX >= size - 1 || nodeY >= size - 1) break;

      const cellX = x - nodeX;
      const cellY = y - nodeY;
      const i = nodeY * size + nodeX;

      // Bilinear height and gradient from the four surrounding cells.
      const hNW = h[i];
      const hNE = h[i + 1];
      const hSW = h[i + size];
      const hSE = h[i + size + 1];

      const gradX = (hNE - hNW) * (1 - cellY) + (hSE - hSW) * cellY;
      const gradY = (hSW - hNW) * (1 - cellX) + (hSE - hNE) * cellX;
      const height =
        hNW * (1 - cellX) * (1 - cellY) +
        hNE * cellX * (1 - cellY) +
        hSW * (1 - cellX) * cellY +
        hSE * cellX * cellY;

      // Momentum: inertia near 0 means the droplet turns downhill immediately.
      dirX = dirX * inertia - gradX * (1 - inertia);
      dirY = dirY * inertia - gradY * (1 - inertia);
      const len = Math.hypot(dirX, dirY);
      if (len === 0) break;
      dirX /= len;
      dirY /= len;
      x += dirX;
      y += dirY;

      if (x < 0 || y < 0 || x >= size - 1 || y >= size - 1) break;

      // Height at the new position, same bilinear read.
      const nX = Math.floor(x);
      const nY = Math.floor(y);
      const fX = x - nX;
      const fY = y - nY;
      const j = nY * size + nX;
      const newHeight =
        h[j] * (1 - fX) * (1 - fY) +
        h[j + 1] * fX * (1 - fY) +
        h[j + size] * (1 - fX) * fY +
        h[j + size + 1] * fX * fY;

      const deltaHeight = newHeight - height;
      const capacity = Math.max(-deltaHeight * speed * water * capacityFactor, minCapacity);

      if (sediment > capacity || deltaHeight > 0) {
        // Uphill, or carrying more than it can: drop sediment. Bilinear across
        // the four cells so valley floors fill smoothly.
        const drop =
          deltaHeight > 0
            ? Math.min(deltaHeight, sediment)
            : (sediment - capacity) * depositSpeed;
        sediment -= drop;
        h[i] += drop * (1 - cellX) * (1 - cellY);
        h[i + 1] += drop * cellX * (1 - cellY);
        h[i + size] += drop * (1 - cellX) * cellY;
        h[i + size + 1] += drop * cellX * cellY;
      } else {
        // Downhill with capacity to spare: cut, spread over the brush so the
        // cut has banks instead of being a one-cell puncture.
        const take = Math.min((capacity - sediment) * erodeSpeed, -deltaHeight);
        for (let b = 0; b < bLen; b++) {
          const oy = brush.offsets[b * 2];
          const ox = brush.offsets[b * 2 + 1];
          const bx = nodeX + ox;
          const by = nodeY + oy;
          if (bx < 0 || by < 0 || bx >= size || by >= size) continue;
          const bi = by * size + bx;
          const amount = take * brush.weights[b];
          const delta = h[bi] < amount ? h[bi] : amount;
          h[bi] -= delta;
          sediment += delta;
        }
      }

      // Speed builds going downhill (deltaHeight negative raises it).
      speed = Math.sqrt(Math.max(0, speed * speed - deltaHeight * gravity));
      water *= 1 - evaporate;
      if (water < 0.01) break;
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
export function synthesize(sketch: Float32Array<ArrayBuffer>, opts: TerrainOptions = {}): TerrainData {
  const size = opts.size ?? 128;
  const scale = opts.scale ?? 500;
  const maxHeight = opts.maxHeight ?? 70;
  const roughness = opts.roughness ?? 0.45;
  const droplets = opts.erosion ?? 12000;
  const ridged = opts.ridged ?? 0.35;
  const warp = opts.warp ?? 0.25;
  const curve = opts.curve ?? 1.35;
  const seed = opts.seed ?? 1337;

  let h: Float32Array<ArrayBuffer> = Float32Array.from(sketch);

  // 1. Soften the drawing into landform.
  h = blur(h, size, Math.max(1, Math.round(size / 48)));
  normalize(h);

  // 2. Fractal detail, weighted by height so ridges get rugged and
  //    lowlands stay walkable. `ridged` picks the noise character and `warp`
  //    bends it so ridgelines meander instead of tracing the pen stroke.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const base = h[i];
      const detail = warpedSample((x / size) * 6, (y / size) * 6, seed, warp, ridged) - 0.5;
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

  // 4. Curve: >1 pushes mass toward valleys so peaks feel earned rather than
  //    the whole field sitting at mid height; <1 flattens into plateaus.
  for (let i = 0; i < h.length; i++) h[i] = Math.pow(h[i], curve);

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
    slopes: slopeMap(heights, size, scale),
    stats: { min, max, mean: sum / heights.length, peaks: countPeaks(h, size) },
  };
}

/**
 * Steepness per cell, normalized 0..1.
 *
 * Central differences in metres over the real cell spacing, turned into a
 * gradient magnitude. A gradient of 1.0 is a 45° slope, which we treat as
 * fully "cliff" — steeper than that is rare at 500m scale and clamps out.
 *
 * Exported because anything that modifies heights after synthesis (the patch
 * rim falloff, for one) has to rebuild this or the shading will describe
 * terrain that is no longer there.
 */
export function slopeMap(
  heights: Float32Array<ArrayBuffer>,
  size: number,
  scale: number,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(size * size);
  const spacing = scale / (size - 1); // metres between cells
  const inv = 1 / (2 * spacing);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < size - 1 ? x + 1 : size - 1;
      const ym = y > 0 ? y - 1 : 0;
      const yp = y < size - 1 ? y + 1 : size - 1;

      const gx = (heights[y * size + xp] - heights[y * size + xm]) * inv;
      const gy = (heights[yp * size + x] - heights[ym * size + x]) * inv;

      out[y * size + x] = Math.min(1, Math.hypot(gx, gy));
    }
  }
  return out;
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
