// app/world/contract.ts
//
// THE SHARED CONTRACT. Every pipeline reads and writes through this file.
//
// Why it exists: eight pipelines writing to one world will collide unless the
// shape of a contribution is fixed up front. This is the only file everyone
// depends on, so it changes by agreement — if you need a new field, add it
// here first and tell the team, don't invent a private shape in your folder.
//
// The rule that makes the world safe: contributions are ADDITIVE. Nothing you
// write ever deletes or overwrites someone else's work. Terrain stacks (max
// height wins), objects sit on top, sound layers. Nobody's contribution can
// disappear.

/* ------------------------------------------------------------- pipelines --- */

/** One per pipeline. Add yours here when you start. */
export type PipelineKind =
  | 'terrain'
  | 'structure'
  | 'interior'
  | 'creature'
  | 'flora'
  | 'weather'
  | 'path'
  | 'sound';

/* ------------------------------------------------------------ the record --- */

/**
 * One contribution — a single row in `world_assets`.
 *
 * `kind` says which pipeline owns it. `payload` is yours: it is jsonb, so put
 * whatever your pipeline needs in there. Nobody else reads inside your payload,
 * which means you can change it freely without breaking anyone.
 */
export interface Contribution<P = unknown> {
  id: string;
  kind: PipelineKind;
  /** World position in metres. Y is derived from terrain, not stored. */
  x: number;
  z: number;
  /** Rotation around Y in radians. */
  rotation: number;
  /** Anonymous per-tab id of whoever made it — for the dashboard, not auth. */
  author: string;
  created_at: string;
  /** Your pipeline's data. See the per-pipeline payload types below. */
  payload: P;
}

/* --------------------------------------------------------------- payloads --- */
//
// Each pipeline owns its payload shape. These are starting points — extend
// them as your pipeline grows. Keep them SMALL: payloads are re-fetched by
// every visitor, so store the seed/recipe, not the finished geometry.
//
// The terrain pipeline is the worked example: it stores a 64x64 sketch
// (~2KB of base64) rather than the 128x128 float heightmap (~64KB) it
// synthesizes from it. Every client regenerates identical terrain because
// the pipeline is deterministic. Do the same in yours where you can.

export interface TerrainPayload {
  /** Base64 of a 64x64 byte grid — the drawn ridgeline. */
  sketch: string;
  /** Erosion seed, so every client synthesizes the same landform. */
  seed: number;
  /** Optional style from the text agent: "icy", "lush", "volcanic"… */
  style?: string;
}

export interface StructurePayload {
  seed: number;
  /** Which kit-of-parts archetype: "cabin", "tower", "ruin"… */
  archetype: string;
  floors: number;
  palette: string[];
}

export interface InteriorPayload {
  /** Which structure this is the inside of. */
  structure_id: string;
  seed: number;
  rooms: number;
}

export interface CreaturePayload {
  seed: number;
  /** Which rigged archetype to instance. */
  archetype: string;
  /** Body proportions, 0..1 each — drives the procedural rig. */
  traits: Record<string, number>;
  palette: string[];
  /** How far it wanders from where it was placed, in metres. */
  roam_radius: number;
}

export interface FloraPayload {
  seed: number;
  species: string;
  /** Scatter radius in metres. */
  spread: number;
  density: number;
  palette: string[];
}

export interface WeatherPayload {
  /** "clear" | "rain" | "snow" | "fog" | "storm" — extend freely. */
  condition: string;
  intensity: number;
  /** Radius of influence in metres; weather blends between contributions. */
  radius: number;
}

export interface PathPayload {
  /** Waypoints in world space, [[x,z], …]. Paths connect what others built. */
  points: [number, number][];
  width: number;
  material: string;
}

export interface SoundPayload {
  seed: number;
  /** Which generative patch to run: "drone", "chimes", "wind"… */
  patch: string;
  /** Audible radius in metres. */
  radius: number;
  /** Musical key so overlapping zones stay consonant. */
  key: string;
  bpm?: number;
}

/** Map a kind to its payload type. */
export interface PayloadByKind {
  terrain: TerrainPayload;
  structure: StructurePayload;
  interior: InteriorPayload;
  creature: CreaturePayload;
  flora: FloraPayload;
  weather: WeatherPayload;
  path: PathPayload;
  sound: SoundPayload;
}

/* ------------------------------------------------------------- the agent --- */

/**
 * What the text agent returns. One shared endpoint interprets a prompt and
 * routes to a pipeline; your pipeline declares the params it accepts.
 *
 * The agent returns NAMED PRESETS AND SMALL NUMBERS, never raw geometry — the
 * research is unanimous that models bridge "icy peaks" -> {snowline: 0.6}
 * far more reliably than "icy peaks" -> a mesh.
 */
export interface Interpretation<K extends PipelineKind = PipelineKind> {
  kind: K;
  /** Params your pipeline understands. Define the schema in your folder. */
  params: Record<string, unknown>;
  /** Short human-readable name for the thing, e.g. "Frostspine Ridge". */
  label: string;
  /** False if the prompt was inappropriate — do not render. */
  safe: boolean;
}

/* ------------------------------------------------------------- utilities --- */

/**
 * Deterministic hash -> [0,1). Use this instead of Math.random() anywhere the
 * result must be identical for every visitor. Pure 32-bit integer ops, so it
 * cannot drift between machines.
 */
export function hash(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A seeded RNG for one contribution. Same seed in, same world out. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * How many of a thing to draw at a given distance. Every pipeline that
 * scatters instances should call this — it is what keeps the world at a
 * playable framerate once there are hundreds of contributions.
 */
export function lodCount(distance: number, full: number, falloff = 120): number {
  if (distance < falloff) return full;
  return Math.max(1, Math.round(full * (falloff / distance)));
}
