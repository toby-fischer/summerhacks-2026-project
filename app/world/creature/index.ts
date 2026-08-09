// app/world/creature/index.ts
//
// The creature pipeline's public surface. Import from '@/app/world/creature',
// not from the files inside.
//
//   mesh.ts               outline sketch -> solid geometry, pattern -> texture
//   CreatureMesh.tsx      one creature in the scene
//   CreatureDrawPanel.tsx the two-step sketching UI

export { CreatureMesh } from './CreatureMesh';
export { CreatureDrawPanel } from './CreatureDrawPanel';
export { buildCreatureGeometry, buildCreatureTexture } from './mesh';
export type { Creature, CreaturePayload } from './types';
