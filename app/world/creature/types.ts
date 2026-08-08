// app/world/creature/types.ts

/** Stored recipe for one creature. Two 64x64 sketches, ~4KB of base64. */
export interface CreaturePayload {
  /** Base64 of the silhouette grid — flood-filled into a solid at render. */
  outlineSketch: string;
  /** Base64 of the marks painted onto that silhouette. */
  patternSketch: string;
}

/** A creature as the renderer wants it: payload flattened onto a position. */
export interface Creature extends CreaturePayload {
  id: string;
  x: number;
  z: number;
  /** Rotation around Y, so a herd doesn't all face the same way. */
  rotation: number;
}
