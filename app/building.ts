// app/building.ts
//
// Sketch -> simple building dimensions.
//
// For MVP we intentionally keep the output primitive (a single box), but still
// derive it from the drawing in a stable, explainable way:
//   - bounding-box size controls footprint
//   - ink density controls height

export interface BuildingData {
  width: number;
  depth: number;
  height: number;
  // Normalized metrics that are useful for HUD/debug tuning.
  coverage: number;
  meanInk: number;
  normWidth: number;
  normHeight: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function safeNumber(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Extract a building footprint and height from a 2D sketch.
 *
 * - Darker strokes are considered "ink".
 * - Bounding box in X/Y maps to building width/height (silhouette semantics).
 * - Building depth is derived from width and ink density.
 */
export function buildingFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  worldScale: number,
): BuildingData | null {
  const MIN_INK_MASS = width * height * 0.008;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let inkMass = 0;
  let weightedInkPixels = 0;
  const colInk = new Float32Array(width);
  const rowInk = new Float32Array(height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      if (a <= 0.001) continue;

      const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      const ink = (1 - lum) * a;
      if (ink <= 0.02) continue;

      inkMass += ink;
      weightedInkPixels++;
      colInk[x] += ink;
      rowInk[y] += ink;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (inkMass < MIN_INK_MASS || weightedInkPixels < 24 || maxX < minX || maxY < minY) return null;

  // Pull bounds inward to ignore the soft-brush fringe, so proportions track
  // the intentional silhouette instead of the fade-out halo.
  const tightenBounds = (arr: Float32Array<ArrayBuffer>, total: number): [number, number] => {
    const trim = total * 0.06;
    let left = 0;
    let right = arr.length - 1;
    let acc = 0;
    while (left < right && acc < trim) acc += arr[left++];
    acc = 0;
    while (right > left && acc < trim) acc += arr[right--];
    return [left, right];
  };
  const [tightMinX, tightMaxX] = tightenBounds(colInk, inkMass);
  const [tightMinY, tightMaxY] = tightenBounds(rowInk, inkMass);
  minX = Math.max(minX, tightMinX);
  maxX = Math.min(maxX, tightMaxX);
  minY = Math.max(minY, tightMinY);
  maxY = Math.min(maxY, tightMaxY);

  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  const normW = safeNumber(boxW / width, 0.2);
  const normH = safeNumber(boxH / height, 0.2);
  const coverage = safeNumber(inkMass / (width * height), 0.05);
  const meanInk = safeNumber(inkMass / weightedInkPixels, 0.4);

  // Treat the drawing as a front silhouette:
  //   X span -> width, Y span -> height.
  // Keep buildings intentionally modest relative to terrain patches.
  const widthMeters = clamp(normW * worldScale * 0.34, 4, worldScale * 0.18);
  const heightMeters = clamp(normH * worldScale * 0.4, 5, 62);

  // Depth is inferred from width and drawing "density". Denser blocks become
  // chunkier structures, while sparse line art stays slimmer.
  const chunkiness = clamp(0.34 + meanInk * 0.22 + Math.sqrt(Math.max(0, coverage)) * 0.12, 0.28, 0.62);
  const depthMeters = clamp(widthMeters * chunkiness, 3.2, worldScale * 0.12);

  if (!Number.isFinite(widthMeters) || !Number.isFinite(depthMeters) || !Number.isFinite(heightMeters)) {
    return null;
  }

  return {
    width: widthMeters,
    depth: depthMeters,
    height: heightMeters,
    coverage,
    meanInk,
    normWidth: normW,
    normHeight: normH,
    bounds: { minX, minY, maxX, maxY },
  };
}
