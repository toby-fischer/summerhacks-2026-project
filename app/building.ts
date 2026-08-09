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
  /**
   * How much of the drawing's vertical span reads as a pitched roof — the
   * silhouette narrowing toward the top instead of staying full-width, like
   * a triangle drawn on top of a box. 0 means no roof was drawn (a plain
   * box); up to ~0.6 for a pronounced peak. Used both to keep that peak from
   * inflating the derived floor count, and to steer classifyBuildingType
   * toward a pitched-roof type regardless of how tall the drawing is.
   */
  roofFrac: number;
  /**
   * A coarse bottom-to-top width/offset profile of the drawing's "body"
   * (the part below the detected roofline), sampled into MAX_FLOOR_BANDS
   * fixed bands. Lets an L-shaped, tapering, or lopsided sketch show up as
   * a stepped/offset building instead of always collapsing to a uniform
   * box — index 0 is the bottom band, the last index is the top band.
   * widthFrac is relative to the widest band; offsetFrac is the band's
   * horizontal center offset relative to the overall body half-width.
   */
  floorProfile: { widthFrac: number; offsetFrac: number }[];
}

export const MAX_FLOOR_BANDS = 5;

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
  // Per-row horizontal extent of ink — lets us tell a peaked roofline (rows
  // narrowing toward the top) apart from a plain box (every row full-width).
  const rowMinX = new Float32Array(height).fill(width);
  const rowMaxX = new Float32Array(height).fill(-1);

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
      if (x < rowMinX[y]) rowMinX[y] = x;
      if (x > rowMaxX[y]) rowMaxX[y] = x;
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

  // Detect a peaked roofline: walk down from the top of the silhouette and
  // find where its width recovers to near the "body" width (the typical
  // width across the bottom 60% of the drawing). Rows above that line are
  // the roof; a plain box never narrows, so this comes out ~0 for one.
  let roofFrac = 0;
  const floorProfile: { widthFrac: number; offsetFrac: number }[] = [];
  {
    const rowCount = maxY - minY + 1;
    if (rowCount >= 6) {
      const widths: number[] = [];
      const centers: number[] = [];
      for (let y = minY; y <= maxY; y++) {
        const w = rowMaxX[y] >= rowMinX[y] ? rowMaxX[y] - rowMinX[y] + 1 : 0;
        widths.push(w);
        centers.push(w > 0 ? (rowMinX[y] + rowMaxX[y]) / 2 : 0);
      }
      const bottomStart = Math.floor(rowCount * 0.4);
      const bottomWidths = widths.slice(bottomStart).filter((w) => w > 0);
      const bodyWidth = bottomWidths.length ? bottomWidths.reduce((a, b) => a + b, 0) / bottomWidths.length : 0;
      let eaveRow = rowCount;
      if (bodyWidth > 0) {
        for (let i = 0; i < rowCount; i++) {
          if (widths[i] >= bodyWidth * 0.82) {
            eaveRow = i;
            break;
          }
        }
        const peakFrac = eaveRow / rowCount;
        // Only count it as a roof if the very top is meaningfully narrower
        // than the body (a point or ridge, not just noisy antialiasing).
        const topWidth = widths[0] || 0;
        if (topWidth < bodyWidth * 0.65 && peakFrac > 0.08) {
          roofFrac = clamp(peakFrac, 0, 0.6);
        } else {
          eaveRow = 0;
        }
      } else {
        eaveRow = 0;
      }

      // Sample the body (everything below the roofline) into fixed bottom-
      // to-top bands so the massing can follow a taper/notch/lean without
      // depending on exactly how many floors the building ends up with.
      const bodyStart = eaveRow;
      const bodyRowCount = rowCount - bodyStart;
      const overallCenter = (minX + maxX) / 2;
      const overallHalfW = Math.max(1, (maxX - minX + 1) / 2);
      if (bodyRowCount >= 1) {
        const rawBands: { width: number; offset: number }[] = [];
        for (let b = 0; b < MAX_FLOOR_BANDS; b++) {
          // Band 0 = bottom of the drawing, last band = just under the eave.
          const bandBottom = bodyStart + Math.floor(((MAX_FLOOR_BANDS - b) / MAX_FLOOR_BANDS) * bodyRowCount);
          const bandTop = bodyStart + Math.floor(((MAX_FLOOR_BANDS - b - 1) / MAX_FLOOR_BANDS) * bodyRowCount);
          const lo = Math.min(bandBottom, bandTop);
          const hi = Math.max(bandBottom, bandTop);
          let wSum = 0;
          let wCount = 0;
          let cSum = 0;
          for (let i = lo; i < hi && i < rowCount; i++) {
            if (widths[i] > 0) {
              wSum += widths[i];
              wCount++;
              cSum += centers[i];
            }
          }
          const avgWidth = wCount > 0 ? wSum / wCount : 0;
          const avgCenter = wCount > 0 ? cSum / wCount : overallCenter;
          rawBands.push({ width: avgWidth, offset: avgCenter - overallCenter });
        }
        const maxBandWidth = Math.max(...rawBands.map((b) => b.width), 1);
        for (const band of rawBands) {
          floorProfile.push({
            widthFrac: clamp(safeNumber(band.width / maxBandWidth, 1), 0.55, 1.05),
            offsetFrac: clamp(safeNumber(band.offset / overallHalfW, 0), -0.3, 0.3),
          });
        }
      }
    }
  }
  while (floorProfile.length < MAX_FLOOR_BANDS) {
    floorProfile.push({ widthFrac: 1, offsetFrac: 0 });
  }

  // Treat the drawing as a front silhouette:
  //   X span -> width, Y span -> height.
  // Keep buildings intentionally modest relative to terrain patches.
  // The roof band is excluded from the height fed into floor-count math
  // downstream — otherwise drawing a more pronounced peak paradoxically
  // makes a house taller/tower-like instead of just giving it a bigger roof.
  const widthMeters = clamp(normW * worldScale * 0.34, 4, worldScale * 0.18);
  const bodyNormH = normH * (1 - roofFrac);
  const heightMeters = clamp(bodyNormH * worldScale * 0.4, 5, 62);

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
    roofFrac,
    floorProfile,
  };
}

/**
 * Architectural type, inferred entirely from the same width/depth/floors
 * that already come from the sketch — no extra input from the user needed.
 * A wide, flat, single-storey drawing reads as a bungalow; a tall, narrow
 * one as a tower; a big, dense drawing as a mansion; and so on.
 */
export type BuildingType = 'bungalow' | 'house' | 'apartment' | 'mansion' | 'tower';

export function classifyBuildingType(
  floors: number,
  width: number,
  depth: number,
  coverage: number,
  roofFrac = 0,
): BuildingType {
  const footprint = width * depth;
  // A clearly-drawn peaked roof is a strong, deliberate signal — honor it
  // over the floor-count heuristic (a tall, narrow drawing with a triangle
  // on top should stay a pitched-roof house/mansion, not become a tower).
  const hasPeakRoof = roofFrac > 0.14;
  if (floors >= 3 && !hasPeakRoof) return Math.min(width, depth) >= 7.5 ? 'apartment' : 'tower';
  if (footprint >= 68 || (coverage > 0.22 && footprint >= 52)) return 'mansion';
  if (hasPeakRoof && floors >= 3) return 'mansion';
  if (floors === 1 && footprint >= 40) return 'bungalow';
  return 'house';
}

/**
 * Cultural/architectural flavor — an axis orthogonal to BuildingType.
 * BuildingType decides structure (floor count, garage, room roles);
 * CultureStyle decides roof grammar, trim, and palette. Assigned
 * deterministically per building (see hashCultureStyle in World.tsx) rather
 * than drawn, so no sketch input is needed for it.
 */
export type CultureStyle = 'mediterranean' | 'nordic' | 'japanese' | 'colonial' | 'tudor' | 'adobe' | 'modern';

export const CULTURE_STYLES: CultureStyle[] = [
  'mediterranean',
  'nordic',
  'japanese',
  'colonial',
  'tudor',
  'adobe',
  'modern',
];
