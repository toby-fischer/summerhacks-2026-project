// app/world/weather/Clouds.tsx
//
// Minecraft clouds: flat white slabs on a grid, drifting in one direction,
// forever.
//
// This replaces drei's <Cloud>, which is a stack of soft alpha billboards —
// pretty, but expensive (a lot of overdraw) and completely at odds with a
// world made of hard-edged terrain. Blocky clouds are cheaper AND they suit
// the aesthetic, which is a rare pairing.
//
// How it stays free:
//
//   - ONE InstancedMesh. Every slab is the same box; only the per-instance
//     matrix differs, so the whole sky is a single draw call.
//   - The grid is FIXED and rides with the player, exactly like the rain
//     cylinder. Instances are placed once at mount and never rewritten — the
//     drift is the group's position, not per-instance work.
//   - The layer wraps with mod(), so a fixed patch of sky tiles forever. Walk
//     in one direction for an hour and there are still clouds, and it never
//     cost anything to keep them there.
//
// Which cells are solid comes from the shared hash(), so every visitor sees
// the same cloudscape — the same rule the terrain pipeline follows.

'use client';

import * as React from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { hash } from '../contract';
import type { Atmosphere as AtmosphereState } from './conditions';

/** Edge length of one cloud slab, metres. Minecraft's are 12 blocks wide. */
const CELL = 26;
/** Grid is GRID x GRID cells centred on the player. */
const GRID = 28;
/** Height of the layer above y=0. */
const ALTITUDE = 128;
/** Slab thickness. Thin, so they read as flat sheets from below. */
const THICKNESS = 7;
/** Drift speed, m/s. Slow — clouds you can see moving are distracting. */
const DRIFT = 1.6;

const SPAN = CELL * GRID;

export interface BlockCloudsProps {
  state: React.RefObject<AtmosphereState>;
}

/**
 * One instanced layer of cloud slabs.
 *
 * Cover is applied by scaling instances to zero rather than by rebuilding the
 * buffer, so cloud cover can animate continuously with the weather blend
 * without ever touching the CPU-side instance data.
 */
export function BlockClouds({ state }: BlockCloudsProps) {
  const meshRef = React.useRef<THREE.InstancedMesh>(null);
  const groupRef = React.useRef<THREE.Group>(null);

  // Which cells hold a slab, and how each is offset. Computed once.
  const cells = React.useMemo(() => {
    const out: { x: number; z: number; jitter: number; scale: number }[] = [];
    const half = GRID / 2;

    for (let gz = -half; gz < half; gz++) {
      for (let gx = -half; gx < half; gx++) {
        // Two octaves of the shared hash: a coarse one that carves the sky into
        // big open regions, and a fine one that ragged-edges them. One octave
        // alone gives TV static — evenly scattered single blocks with no shape.
        const coarse = hash(Math.floor(gx / 4), Math.floor(gz / 4), 7);
        const fine = hash(gx, gz, 91);
        const density = coarse * 0.68 + fine * 0.32;
        if (density < 0.42) continue;

        out.push({
          x: gx * CELL,
          z: gz * CELL,
          jitter: hash(gx, gz, 404) * 6 - 3,
          // Slight size variation so the grid doesn't read as a chessboard.
          scale: 0.85 + hash(gx, gz, 55) * 0.3,
        });
      }
    }
    return out;
  }, []);

  const count = cells.length;

  // Write every instance matrix once. Nothing rewrites these per frame.
  const scratch = React.useMemo(
    () => ({
      m: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scl: new THREE.Vector3(),
      color: new THREE.Color(),
    }),
    [],
  );

  React.useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    for (let i = 0; i < count; i++) {
      const c = cells[i];
      scratch.pos.set(c.x, c.jitter, c.z);
      scratch.scl.set(CELL * c.scale, THICKNESS, CELL * c.scale);
      scratch.m.compose(scratch.pos, scratch.quat, scratch.scl);
      mesh.setMatrixAt(i, scratch.m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [cells, count, scratch]);

  // Geometry and material are constructed imperatively and handed to the
  // InstancedMesh as args. Declaring them as JSX children instead leaves the
  // mesh briefly constructed with a null geometry, and it never recovers —
  // the layer silently renders nothing.
  const geometry = React.useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  React.useEffect(() => () => geometry.dispose(), [geometry]);

  const material = React.useMemo(
    () =>
      new THREE.MeshLambertMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0.86,
        // Both sides: you fly through these, and a back-face-culled slab
        // vanishes the moment you're above it.
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  React.useEffect(() => () => material.dispose(), [material]);

  useFrame(({ camera, clock }) => {
    const w = state.current;
    const group = groupRef.current;
    const mesh = meshRef.current;
    if (!w || !group || !mesh) return;

    // Wrap the drift into one cell so the layer tiles seamlessly and the
    // offset never grows large enough to lose float precision.
    const drift = (clock.elapsedTime * DRIFT * (0.5 + w.wind * 0.12)) % CELL;

    // Snap the layer to the player's cell, then add the sub-cell drift. This is
    // the whole trick: the grid is small and local, but because it re-centres
    // on whichever cell you're standing in, it looks infinite.
    const cx = Math.round(camera.position.x / CELL) * CELL;
    const cz = Math.round(camera.position.z / CELL) * CELL;
    group.position.set(cx + drift, ALTITUDE, cz + drift);

    // Cover scales opacity. Below a threshold the whole layer switches off, so
    // clear weather costs one visibility check rather than a draw call.
    const cover = THREE.MathUtils.clamp(w.cloud, 0, 1);
    group.visible = cover > 0.04;
    material.opacity = 0.3 + cover * 0.6;

    // Clouds darken under storm and pick up the weather's tint, so an overcast
    // sky isn't a field of bright white slabs over a black world.
    scratch.color.setRGB(w.tint[0], w.tint[1], w.tint[2]);
    material.color.setRGB(1, 1, 1).lerp(scratch.color, 0.35 + w.gloom * 0.5);
  });

  return (
    <group ref={groupRef}>
      <instancedMesh
        ref={meshRef}
        args={[geometry, material, Math.max(1, count)]}
        frustumCulled={false}
        renderOrder={-1}
      />
    </group>
  );
}

/** Roughly how far the layer reaches. Exported so the fog can be tuned to hide
 *  its rim rather than letting you see the edge of the sky. */
export const CLOUD_SPAN = SPAN;
