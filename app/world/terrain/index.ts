// app/world/terrain/index.ts
//
// The terrain pipeline's public surface. Import from '@/app/world/terrain',
// not from the files inside — that keeps the internals free to move.
//
//   pipeline.ts  sketch -> heightmap (pure maths, no React/Three)
//   styles.ts    named parameter presets + the text-agent schema
//   shading.ts   heightmap + style -> per-vertex colours
//   sketch.ts    encode/decode the stored recipe
//   build.ts     the one call the renderer makes

export {
  synthesize,
  heightAt,
  heightsFromImageData,
  hash,
  type TerrainData,
  type TerrainOptions,
} from './pipeline';

export {
  STYLES,
  DEFAULT_STYLE,
  styleFor,
  optionsFor,
  applyAgentParams,
  AGENT_PARAM_SCHEMA,
  type TerrainStyle,
  type StyleShape,
  type StylePalette,
} from './styles';

export { shadeTerrain, type ShadeOptions } from './shading';

export { encodeSketch, decodeSketch, SKETCH_GRID, PATCH_SCALE } from './sketch';

export { buildPatch, type PatchInput, type BuiltPatch } from './build';
