// app/world/terrain/build.ts
//
// One call: a stored row in, everything the renderer needs out.
//
// This exists to fix a specific class of bug. The rim falloff (which feathers
// a patch into the plain instead of ending it on a 60m cliff) used to be
// applied by the mesh builder, mutating the cached TerrainData in place. That
// is only correct if the mesh is built exactly once per TerrainData — the
// second run would feather the already-feathered heights and flatten the
// patch, and `heightAt` would disagree with what you could see.
//
// So the falloff is baked HERE, once, into a fresh array. What comes out is
// already final: heights match the mesh, colours match the heights, and
// building twice is harmless.

import { synthesize, slopeMap, heightAt, type TerrainData } from './pipeline';
import { decodeSketch, resample, SKETCH_GRID, SYNTH_GRID, PATCH_SCALE } from './sketch';
import { shadeTerrain } from './shading';
import { styleFor, optionsFor, type TerrainStyle } from './styles';

/** The stored shape of a terrain contribution. */
export interface PatchInput {
  id: string;
  x: number;
  z: number;
  sketch: string;
  seed: number;
  style?: string;
}

export interface BuiltPatch {
  id: string;
  x: number;
  z: number;
  /** Heights already feathered at the rim — safe for both mesh and ground queries. */
  terrain: TerrainData;
  /** Per-vertex r,g,b, length size*size*3. */
  colors: Float32Array;
  style: TerrainStyle;
}

/**
 * Where the rim starts fading, as a fraction of half-width. Below this the
 * patch is at full height; between here and the edge it eases to zero.
 */
const RIM_START = 0.6;

/**
 * Smooth rim falloff for a square patch: 1 in the middle, 0 at the edge.
 * Uses the Chebyshev distance (max of |x|,|z|) so the fade follows the square
 * boundary rather than a circle inscribed in it.
 */
function rimFalloff(size: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Normalized -1..1 across the patch.
      const nx = (x / (size - 1)) * 2 - 1;
      const ny = (y / (size - 1)) * 2 - 1;
      const edge = Math.max(Math.abs(nx), Math.abs(ny));
      const t = Math.min(1, Math.max(0, (edge - RIM_START) / (1 - RIM_START)));
      out[y * size + x] = 1 - t * t * (3 - 2 * t); // smoothstep, inverted
    }
  }
  return out;
}

/** Cached per size — the falloff only depends on grid resolution. */
const falloffCache = new Map<number, Float32Array>();
function cachedFalloff(size: number): Float32Array {
  let f = falloffCache.get(size);
  if (!f) {
    f = rimFalloff(size);
    falloffCache.set(size, f);
  }
  return f;
}

/**
 * Synthesize one contribution into finished, render-ready terrain.
 *
 * Pure and deterministic: the same row produces the same result on every
 * client, which is the whole reason we store the sketch instead of the mesh.
 */
export function buildPatch(patch: PatchInput): BuiltPatch {
  const style = styleFor(patch.style);

  // Lift the stored silhouette to the finer synthesis grid first, so the
  // fractal and erosion passes have room to add detail between drawn cells.
  const sketch = resample(decodeSketch(patch.sketch), SKETCH_GRID, SYNTH_GRID);

  const terrain = synthesize(
    sketch,
    optionsFor(style, {
      size: SYNTH_GRID,
      scale: PATCH_SCALE,
      seed: patch.seed,
      // Erosion cost scales with droplet count, not grid size, so the finer
      // grid is nearly free here. Styles that ask for heavy erosion still get
      // proportionally more.
      erosion: Math.round(style.shape.erosion * 0.5),
    }),
  );

  // Bake the rim into the heights so mesh and ground queries can never
  // disagree, then recompute slopes against the flattened edges.
  const falloff = cachedFalloff(terrain.size);
  for (let i = 0; i < terrain.heights.length; i++) {
    terrain.heights[i] *= falloff[i];
  }
  terrain.slopes = slopeMap(terrain.heights, terrain.size, terrain.scale);

  const colors = shadeTerrain(terrain, style.palette, { seed: patch.seed });

  return { id: patch.id, x: patch.x, z: patch.z, terrain, colors, style };
}

/**
 * Ground height at a world position: the max across every overlapping patch.
 *
 * Max rather than sum, per the contract's additive law — overlapping
 * contributions stack into one ridge instead of doubling into a spike, and
 * nobody's landform can be flattened by someone building next to it.
 *
 * Lives here rather than in the renderer because everything that sits ON the
 * ground needs it — the walker, creatures, and whatever pipeline lands next.
 * Two implementations of this would eventually disagree, and the symptom would
 * be things sunk into hillsides.
 */
export function groundAt(built: readonly BuiltPatch[], wx: number, wz: number): number {
  let h = 0;
  for (const patch of built) {
    const { terrain } = patch;
    const lx = wx - patch.x;
    const lz = wz - patch.z;
    const half = terrain.scale / 2;
    if (lx < -half || lx > half || lz < -half || lz > half) continue;
    const v = heightAt(terrain, lx, lz);
    if (v > h) h = v;
  }
  return h;
}
