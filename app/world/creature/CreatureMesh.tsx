// app/world/creature/CreatureMesh.tsx
//
// One drawn creature, standing on the terrain.

'use client';

import { useEffect, useMemo } from 'react';
import { decodeSketch } from '../terrain';
import { buildCreatureGeometry, buildCreatureTexture } from './mesh';
import type { Creature } from './types';

export function CreatureMesh({
  creature,
  groundY,
}: {
  creature: Creature;
  groundY: number;
}) {
  // Both passes are pure functions of the stored sketches, so this runs once
  // per creature rather than per frame. Keyed on the sketches themselves and
  // not the row, so an id reconciling from temp to real doesn't rebuild it.
  const { geometry, texture, height } = useMemo(() => {
    const { geometry, height } = buildCreatureGeometry(
      decodeSketch(creature.outlineSketch),
    );
    const texture = buildCreatureTexture(decodeSketch(creature.patternSketch));
    return { geometry, texture, height };
  }, [creature.outlineSketch, creature.patternSketch]);

  // Geometry and canvas textures hold GPU memory that React does not free.
  // With people spawning creatures all demo, leaking every one of them is the
  // difference between a world that runs for an hour and one that doesn't.
  useEffect(() => {
    return () => {
      geometry.dispose();
      texture.dispose();
    };
  }, [geometry, texture]);

  return (
    <mesh
      geometry={geometry}
      position={[creature.x, groundY + height / 2, creature.z]}
      rotation={[0, creature.rotation, 0]}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial map={texture} roughness={0.8} />
    </mesh>
  );
}
