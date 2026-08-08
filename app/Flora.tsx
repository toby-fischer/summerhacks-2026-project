// app/Flora.tsx
'use client';

import { useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Instance, Instances } from '@react-three/drei';
import * as THREE from 'three';

import { BIOMES, propsAround, type BiomeId, type Prop } from './biomes';

const VIEW_RADIUS = 110;
// Rebuild only after the player leaves the cell they were in. Without this the
// scatter recomputes every frame; with it, once every several seconds of walking.
const REBUILD_STEP = 24;

/**
 * Recomputes the local prop scatter when the player crosses a cell boundary.
 * Returns plain data — the caller decides how to render it.
 */
function useScatter(biome: BiomeId, cell: number, density: number): Prop[] {
  const { camera } = useThree();

  // Seed from the camera's real position rather than assuming the origin, so
  // the first frame is already correct after a spawn or a teleport.
  const initial = useMemo<[number, number]>(
    () => [
      Math.round(camera.position.x / REBUILD_STEP) * REBUILD_STEP,
      Math.round(camera.position.z / REBUILD_STEP) * REBUILD_STEP,
    ],
    [camera],
  );

  const [anchor, setAnchor] = useState<[number, number]>(initial);
  const last = useRef<[number, number]>([
    initial[0] / REBUILD_STEP,
    initial[1] / REBUILD_STEP,
  ]);

  useFrame(() => {
    const gx = Math.round(camera.position.x / REBUILD_STEP);
    const gz = Math.round(camera.position.z / REBUILD_STEP);
    if (gx !== last.current[0] || gz !== last.current[1]) {
      last.current = [gx, gz];
      setAnchor([gx * REBUILD_STEP, gz * REBUILD_STEP]);
      return;
    }
    // Safety net: if the camera has drifted far from the anchor without a
    // crossing being detected (teleport, respawn, a dropped frame), resync.
    const dx = camera.position.x - anchor[0];
    const dz = camera.position.z - anchor[1];
    if (dx * dx + dz * dz > REBUILD_STEP * REBUILD_STEP * 4) {
      setAnchor([gx * REBUILD_STEP, gz * REBUILD_STEP]);
    }
  });

  return useMemo(
    () => propsAround(anchor[0], anchor[1], VIEW_RADIUS, cell, biome, density),
    [anchor, biome, cell, density],
  );
}

/**
 * Glowing mushrooms: a stalk plus an emissive cap.
 *
 * Two Instances trees rather than one, because instancing requires a single
 * shared geometry+material. Two draw calls total regardless of mushroom count.
 */
export function Mushrooms() {
  const props = useScatter('hollow', 7, 0.55);
  const color = BIOMES.hollow.flora;

  return (
    <group>
      <Instances limit={1200} range={props.length} castShadow>
        <cylinderGeometry args={[0.14, 0.24, 2, 6]} />
        <meshStandardMaterial
          color="#3b3358"
          emissive={color}
          emissiveIntensity={0.5}
          roughness={0.9}
        />
        {props.map((p) => (
          <Instance
            key={p.key}
            position={[p.position[0], p.scale, p.position[2]]}
            scale={[p.scale, p.scale, p.scale]}
            rotation={[0, p.rotation, 0]}
          />
        ))}
      </Instances>

      {/* Caps are the light source of this biome, so they are deliberately
          oversized and use meshBasicMaterial: unlit and unaffected by fog
          falloff, so they stay legible at distance instead of dissolving. */}
      <Instances limit={1200} range={props.length}>
        <sphereGeometry args={[1.05, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.6]} />
        <meshBasicMaterial color={color} toneMapped={false} fog={false} />
        {props.map((p) => (
          <Instance
            key={p.key}
            position={[p.position[0], p.scale * 2.0, p.position[2]]}
            scale={[p.scale * 1.5, p.scale * 1.2, p.scale * 1.5]}
            rotation={[0, p.rotation, 0]}
          />
        ))}
      </Instances>
    </group>
  );
}

/** Amethyst shards: angled low-poly spikes, emissive so they read at distance. */
export function Crystals() {
  const props = useScatter('reach', 9, 0.5);
  const color = BIOMES.reach.flora;

  return (
    <Instances limit={1200} range={props.length} castShadow>
      <coneGeometry args={[0.55, 4.2, 5]} />
      {/* Unlit and fog-exempt for the same reason as the mushroom caps: these
          are the biome's light sources and must read from far away. */}
      <meshBasicMaterial color={color} toneMapped={false} fog={false} />
      {props.map((p) => (
        <Instance
          key={p.key}
          position={[p.position[0], p.scale * 1.9, p.position[2]]}
          scale={[p.scale, p.scale * 1.6, p.scale]}
          // Tilt shards off-axis so a field of them looks grown, not planted.
          rotation={[Math.sin(p.rotation) * 0.32, p.rotation, Math.cos(p.rotation) * 0.32]}
        />
      ))}
    </Instances>
  );
}

/** Meadow grass. Not emissive — it reads as silhouette against the fog. */
export function GrassTufts() {
  const props = useScatter('meadow', 6, 0.55);
  const color = BIOMES.meadow.flora;

  return (
    <Instances limit={1200} range={props.length}>
      <coneGeometry args={[0.1, 2.2, 4]} />
      <meshStandardMaterial
        color="#2f6b4f"
        emissive={color}
        emissiveIntensity={1.1}
        roughness={0.95}
      />
      {props.map((p) => {
        // Exaggerate the size spread. Uniform scale made the field read as a
        // repeating pattern; varied blade height reads as growth.
        const h = 0.45 + p.scale * 1.5;
        return (
          <Instance
            key={p.key}
            position={[p.position[0], h * 1.1, p.position[2]]}
            scale={[p.scale * 0.9, h, p.scale * 0.9]}
            rotation={[Math.sin(p.rotation) * 0.22, p.rotation, Math.cos(p.rotation) * 0.18]}
          />
        );
      })}
    </Instances>
  );
}

/**
 * Beacons players leave behind: a bright emissive core inside a translucent
 * additive shell. That pairing fakes a bloom halo at a fraction of the cost of
 * a real post-processing pass, which matters since these can number in the
 * hundreds and we want them lighting the world, not tanking the framerate.
 */
export function Beacon({
  position,
  color,
  index,
}: {
  position: [number, number, number];
  color: string;
  index: number;
}) {
  const core = useRef<THREE.Mesh>(null);
  const shell = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    // Offset by index so a cluster pulses out of phase rather than in unison.
    const t = clock.elapsedTime * 1.6 + index * 1.7;
    const pulse = 1 + Math.sin(t) * 0.09;
    const bob = Math.sin(t * 0.6) * 0.12;

    if (core.current) {
      core.current.position.y = position[1] + bob;
      core.current.rotation.y += 0.004;
    }
    if (shell.current) {
      shell.current.position.y = position[1] + bob;
      shell.current.scale.setScalar(pulse);
    }
  });

  return (
    <group position={[position[0], 0, position[2]]}>
      <mesh ref={core} position={[0, position[1], 0]} castShadow>
        <octahedronGeometry args={[0.5, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={3.2}
          toneMapped={false}
          flatShading
        />
      </mesh>

      {/* Halo. A sphere with BackSide + additive blending fakes bloom: the
          far shell shows through the near one, so intensity falls off toward
          the rim instead of reading as a hard silhouette. A low-poly solid
          here renders as an opaque block, which is exactly wrong. */}
      <mesh ref={shell} position={[0, position[1], 0]}>
        <sphereGeometry args={[0.78, 20, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.055}
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* Real light so beacons genuinely illuminate nearby ground. */}
      <pointLight position={[0, position[1], 0]} color={color} intensity={7} distance={13} decay={2} />
    </group>
  );
}
