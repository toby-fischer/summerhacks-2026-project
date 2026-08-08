// app/World.tsx
//
// One shared landscape. People draw a ridgeline; it becomes real terrain in
// the world everyone is walking through.
//
// What persists is the *sketch*, not the heightmap: 64x64 bytes is ~2KB of
// base64 in jsonb, where a 128x128 float heightmap would be ~64KB per row.
// Every client re-runs synthesize() and lands on identical terrain because the
// pipeline is deterministic — cheap to store, cheap to sync, impossible to
// desync.
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls, Sky, Stars } from '@react-three/drei';
import { createClient } from '@supabase/supabase-js';
import type { RealtimeChannel } from '@supabase/supabase-js';
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { heightAt, synthesize, type TerrainData } from './terrain';
import {
  BROADCAST_MS,
  STALE_MS,
  colorForId,
  joinTravellerChannel,
  makeSelfId,
  sendMove,
  type Traveller,
} from './presence';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

/** Sketch resolution as stored. Small enough for jsonb, enough for landform. */
const SKETCH_GRID = 64;
/** Footprint of one contributed massif, in metres. */
const PATCH_SCALE = 300;
const PATCH_MAX_H = 60;
const EYE = 1.8;

interface Patch {
  id: string;
  x: number;
  z: number;
  sketch: string;
  seed: number;
}

interface VegetationInstance {
  position: [number, number, number];
  rotation: number;
  scale: number;
  color: [number, number, number];
  normal: [number, number, number];
}

interface VegetationPatch {
  id: string;
  type: string;
  instances: VegetationInstance[];
}

const hashString = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
};

const seededRandom = (seed: number) => {
  let value = seed;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0xffffffff;
  };
};

const vegetationColor = (type: string) => {
  const lower = type.toLowerCase();
  const color = new THREE.Color();
  if (lower.includes('cherry')) return color.set('#f2b8de');
  if (lower.includes('blossom')) return color.set('#f8d5e6');
  if (lower.includes('dead') || lower.includes('withered') || lower.includes('burnt')) return color.set('#7d6b59');
  if (lower.includes('forest')) return color.set('#3e6a37');
  if (lower.includes('cactus')) return color.set('#7ca64b');
  return color.set('#5a8b3f');
};

type PlantShape =
  | 'oak'
  | 'pine'
  | 'maple'
  | 'willow'
  | 'palm'
  | 'cactus'
  | 'succulent'
  | 'flower'
  | 'rose'
  | 'tulip'
  | 'sunflower'
  | 'grass'
  | 'fern'
  | 'bush'
  | 'shrub'
  | 'mushroom'
  | 'generic';

const plantStyleFromType = (type: string): {
  species: PlantShape;
  height: number;
  trunkRadius: number;
  canopyRadius: number;
  trunkColor: THREE.Color;
  leafColor: THREE.Color;
  bloomColor: THREE.Color | null;
  accentColor: THREE.Color;
  detail: number;
} => {
  const lower = type.toLowerCase();
  const rand = seededRandom(hashString(type));

  const species: PlantShape = /rose/.test(lower)
    ? 'rose'
    : /tulip/.test(lower)
    ? 'tulip'
    : /sunflower/.test(lower)
    ? 'sunflower'
    : /cherry/.test(lower)
    ? 'flower'
    : /palm|coconut|date/.test(lower)
    ? 'palm'
    : /willow/.test(lower)
    ? 'willow'
    : /pine|spruce|fir|cedar|redwood|sequoia/.test(lower)
    ? 'pine'
    : /oak/.test(lower)
    ? 'oak'
    : /maple/.test(lower)
    ? 'maple'
    : /cactus|saguaro|succulent|aloe|agave/.test(lower)
    ? 'cactus'
    : /fern/.test(lower)
    ? 'fern'
    : /grass|reed|moss|lawn|wheat|barley|hay/.test(lower)
    ? 'grass'
    : /mushroom|fungus/.test(lower)
    ? 'mushroom'
    : /bush|shrub|hedge|holly|azalea|boxwood/.test(lower)
    ? 'bush'
    : /flower|blossom|orchid|lily|daisy|poppy|lotus/.test(lower)
    ? 'flower'
    : 'generic';

  const height = Math.max(0.6, Math.min(2.4, 0.8 + rand() * 1.6));
  const canopyRadius = Math.max(0.18, Math.min(0.7, 0.22 + rand() * 0.5));
  const trunkRadius = Math.max(0.05, Math.min(0.2, 0.06 + rand() * 0.12));

  const leafColor = vegetationColor(type).lerp(
    new THREE.Color('#8faf5c'), /flower|blossom/.test(lower) ? 0.18 : 0.08,
  );

  const bloomColor = /rose|tulip|sunflower|daisy|poppy|orchid|lotus|cherry/.test(lower)
    ? new THREE.Color(
        lower.includes('rose')
          ? '#d64d6b'
          : lower.includes('tulip')
          ? '#ff7fb2'
          : lower.includes('sunflower')
          ? '#ffd73e'
          : lower.includes('orchid')
          ? '#d79cd3'
          : lower.includes('lotus')
          ? '#f9d5d2'
          : lower.includes('daisy')
          ? '#f5e8a2'
          : '#f8b8d8',
      )
    : null;

  return {
    species,
    height,
    trunkRadius,
    canopyRadius,
    trunkColor: new THREE.Color('#6b4a2f').lerp(new THREE.Color('#8c6d49'), rand() * 0.3),
    leafColor,
    bloomColor,
    accentColor: bloomColor ?? vegetationColor(type).lerp(new THREE.Color('#5d8b51'), 0.12),
    detail: 1 + Math.round(rand() * 2),
  };
};

const paintVertexColors = (geometry: THREE.BufferGeometry, color: THREE.Color) => {
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
};

const createFlowerHead = (style: ReturnType<typeof plantStyleFromType>) => {
  const petals: THREE.BufferGeometry[] = [];
  const petalCount = 5 + style.detail * 2;
  for (let i = 0; i < petalCount; i++) {
    const petal = new THREE.SphereGeometry(style.canopyRadius * 0.45, 8, 6);
    petal.scale(1, 0.35, 0.5);
    const angle = (i / petalCount) * Math.PI * 2;
    petal.translate(
      Math.cos(angle) * style.canopyRadius * 0.42,
      style.height + style.canopyRadius * 0.72,
      Math.sin(angle) * style.canopyRadius * 0.42,
    );
    petal.rotateX(-Math.PI / 6);
    petal.rotateY(angle);
    paintVertexColors(petal, style.leafColor);
    petals.push(petal);
  }

  const center = new THREE.SphereGeometry(style.canopyRadius * 0.25, 10, 8);
  center.translate(0, style.height + style.canopyRadius * 0.72, 0);
  paintVertexColors(center, style.accentColor);
  return BufferGeometryUtils.mergeGeometries([...petals, center], false) as THREE.BufferGeometry;
};

const createCactusBody = (style: ReturnType<typeof plantStyleFromType>) => {
  const segments = 2 + style.detail;
  const pieces: THREE.BufferGeometry[] = [];
  for (let i = 0; i < segments; i++) {
    const radius = style.canopyRadius * (0.9 - i * 0.12);
    const height = 0.5 + i * 0.15;
    const piece = new THREE.CylinderGeometry(radius, radius, height, 8, 1);
    piece.translate(0, style.height * 0.3 + i * 0.35, 0);
    paintVertexColors(piece, style.leafColor);
    pieces.push(piece);
  }
  return BufferGeometryUtils.mergeGeometries(pieces, false) as THREE.BufferGeometry;
};

const createFernBlades = (style: ReturnType<typeof plantStyleFromType>) => {
  const blades: THREE.BufferGeometry[] = [];
  const count = 4 + style.detail * 2;
  for (let i = 0; i < count; i++) {
    const blade = new THREE.PlaneGeometry(style.canopyRadius * 0.15, style.height * 1.1, 4, 10);
    blade.rotateY((Math.PI / count) * i);
    blade.rotateZ(-Math.PI / 4);
    blade.translate(0, style.height * 0.6, 0);
    paintVertexColors(blade, style.leafColor);
    blades.push(blade);
  }
  return BufferGeometryUtils.mergeGeometries(blades, false) as THREE.BufferGeometry;
};

const createBushCanopy = (style: ReturnType<typeof plantStyleFromType>) => {
  const clumps: THREE.BufferGeometry[] = [];
  const count = 3 + style.detail;
  for (let i = 0; i < count; i++) {
    const sphere = new THREE.SphereGeometry(style.canopyRadius * (0.7 + Math.random() * 0.2), 10, 8);
    const angle = (Math.PI * 2 * i) / count;
    sphere.translate(
      Math.cos(angle) * style.canopyRadius * 0.3,
      style.height + style.canopyRadius * 0.2 + Math.random() * 0.1,
      Math.sin(angle) * style.canopyRadius * 0.3,
    );
    paintVertexColors(sphere, style.leafColor);
    clumps.push(sphere);
  }
  return BufferGeometryUtils.mergeGeometries(clumps, false) as THREE.BufferGeometry;
};

const createPlantGeometry = (type: string): THREE.BufferGeometry => {
  const style = plantStyleFromType(type);
  const trunk = new THREE.CylinderGeometry(style.trunkRadius, style.trunkRadius, style.height, 10, 1, false);
  trunk.translate(0, style.height / 2, 0);
  paintVertexColors(trunk, style.trunkColor);

  let canopy: THREE.BufferGeometry;
  switch (style.species) {
    case 'oak':
    case 'maple': {
      const spheres: THREE.BufferGeometry[] = [];
      const rings = 3 + style.detail;
      for (let i = 0; i < rings; i++) {
        const radius = style.canopyRadius * (1 - i * 0.15);
        const sphere = new THREE.SphereGeometry(radius, 12, 10);
        sphere.translate(0, style.height + radius * 0.4 - i * 0.1, 0);
        paintVertexColors(sphere, style.leafColor);
        spheres.push(sphere);
      }
      canopy = BufferGeometryUtils.mergeGeometries(spheres, false) as THREE.BufferGeometry;
      break;
    }
    case 'pine': {
      const cones: THREE.BufferGeometry[] = [];
      const levels = 3 + style.detail;
      for (let i = 0; i < levels; i++) {
        const radius = style.canopyRadius * (1 - i * 0.18);
        const cone = new THREE.ConeGeometry(radius, radius * 1.2, 10, 1);
        cone.translate(0, style.height + (levels - i) * 0.25, 0);
        paintVertexColors(cone, style.leafColor);
        cones.push(cone);
      }
      canopy = BufferGeometryUtils.mergeGeometries(cones, false) as THREE.BufferGeometry;
      break;
    }
    case 'willow': {
      const droops: THREE.BufferGeometry[] = [];
      const branches = 5 + style.detail;
      for (let i = 0; i < branches; i++) {
        const branch = new THREE.CylinderGeometry(style.canopyRadius * 0.05, style.canopyRadius * 0.08, style.canopyRadius * 2.2, 6, 1, true);
        branch.rotateZ(Math.PI / 2);
        branch.rotateY((i / branches) * Math.PI * 2);
        branch.translate(0, style.height + 0.2, 0);
        paintVertexColors(branch, style.leafColor);
        droops.push(branch);
      }
      canopy = BufferGeometryUtils.mergeGeometries(droops, false) as THREE.BufferGeometry;
      break;
    }
    case 'palm': {
      const rings: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 4; i++) {
        const segment = new THREE.CylinderGeometry(style.trunkRadius * 1.1, style.trunkRadius * 1.3, 0.35, 8, 1);
        segment.translate(0, style.height * 0.15 + i * 0.25, 0);
        paintVertexColors(segment, style.trunkColor);
        rings.push(segment);
      }
      const fronds: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 6; i++) {
        const blade = new THREE.PlaneGeometry(style.canopyRadius * 0.18, style.canopyRadius * 1.3, 6, 1);
        blade.rotateX(-Math.PI / 2.7);
        blade.rotateY((i / 6) * Math.PI * 2);
        blade.translate(0, style.height + 0.2, 0);
        paintVertexColors(blade, style.leafColor);
        fronds.push(blade);
      }
      canopy = BufferGeometryUtils.mergeGeometries([...rings, ...fronds], false) as THREE.BufferGeometry;
      break;
    }
    case 'cactus':
    case 'succulent':
      canopy = createCactusBody(style);
      break;
    case 'flower':
    case 'rose':
    case 'tulip':
    case 'sunflower':
      canopy = createFlowerHead(style);
      break;
    case 'fern':
      canopy = createFernBlades(style);
      break;
    case 'grass':
      canopy = createFernBlades(style);
      break;
    case 'mushroom': {
      const cap = new THREE.SphereGeometry(style.canopyRadius, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.translate(0, style.height + 0.1, 0);
      const stem = new THREE.CylinderGeometry(style.trunkRadius * 0.4, style.trunkRadius * 0.5, style.height * 0.6, 8);
      stem.translate(0, style.height * 0.3, 0);
      paintVertexColors(cap, style.leafColor);
      paintVertexColors(stem, style.trunkColor);
      canopy = BufferGeometryUtils.mergeGeometries([cap, stem], false) as THREE.BufferGeometry;
      break;
    }
    case 'bush':
    case 'shrub':
      canopy = createBushCanopy(style);
      break;
    default:
      canopy = new THREE.SphereGeometry(style.canopyRadius, 10, 8);
      canopy.translate(0, style.height + style.canopyRadius * 0.7, 0);
      paintVertexColors(canopy, style.leafColor);
  }

  if (style.species !== 'flower' && style.species !== 'rose' && style.species !== 'tulip' && style.species !== 'sunflower') {
    paintVertexColors(canopy, style.leafColor);
  }
  const geometry = BufferGeometryUtils.mergeGeometries([trunk, canopy], false) as THREE.BufferGeometry;
  geometry.computeVertexNormals();
  return geometry;
};

const surfaceNormal = (
  built: { patch: Patch; terrain: TerrainData }[],
  x: number,
  z: number,
) => {
  const y = groundAt(built, x, z);
  const dx = groundAt(built, x + 1, z) - y;
  const dz = groundAt(built, x, z + 1) - y;
  const normal = new THREE.Vector3(-dx, 1, -dz).normalize();
  const slope = Math.sqrt(dx * dx + dz * dz);
  return { normal, slope };
};

const createVegetationPatch = (
  built: { patch: Patch; terrain: TerrainData }[],
  x: number,
  z: number,
  type: string,
) => {
  const seed = hashString(`${type}:${x.toFixed(2)}:${z.toFixed(2)}`);
  const rand = seededRandom(seed);
  const instances: VegetationInstance[] = [];
  const radius = 20;
  const target = 180;

  for (let i = 0; i < target * 3 && instances.length < target; i++) {
    const angle = rand() * Math.PI * 2;
    const distance = Math.sqrt(rand()) * radius;
    const px = x + Math.cos(angle) * distance;
    const pz = z + Math.sin(angle) * distance;
    const { normal, slope } = surfaceNormal(built, px, pz);
    if (slope > 0.25) continue;

    const height = groundAt(built, px, pz);
    const scale = 0.6 + rand() * 1.0;
    instances.push({
      position: [px, height, pz],
      rotation: rand() * Math.PI * 2,
      scale,
      color: vegetationColor(type).toArray() as [number, number, number],
      normal: [normal.x, normal.y, normal.z],
    });
  }

  return {
    id: `${Date.now()}-${type.replace(/\s+/g, '-')}`,
    type,
    instances,
  };
};

/* ------------------------------------------------------------ encoding --- */

function encodeSketch(grid: Float32Array<ArrayBuffer>): string {
  const bytes = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    bytes[i] = Math.max(0, Math.min(255, Math.round(grid[i] * 255)));
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function decodeSketch(b64: string): Float32Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Float32Array(SKETCH_GRID * SKETCH_GRID);
  const n = Math.min(bin.length, out.length);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i) / 255;
  return out;
}

function terrainFor(p: Patch): TerrainData {
  return synthesize(decodeSketch(p.sketch), {
    size: SKETCH_GRID,
    scale: PATCH_SCALE,
    maxHeight: PATCH_MAX_H,
    seed: p.seed,
    // Lighter than the full-page demo: patches are smaller and several may
    // synthesize at once when a new visitor loads the world.
    erosion: 5000,
  });
}

/* -------------------------------------------------------------- terrain --- */

function PatchMesh({ patch, terrain }: { patch: Patch; terrain: TerrainData }) {
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(
      terrain.scale,
      terrain.scale,
      terrain.size - 1,
      terrain.size - 1,
    );
    g.rotateX(-Math.PI / 2);

    const pos = g.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);

    const sand = new THREE.Color('#6f6a4f');
    const grass = new THREE.Color('#3f6b4a');
    const rock = new THREE.Color('#6b7a8f');
    const snow = new THREE.Color('#e8eef7');
    const c = new THREE.Color();

    const half = terrain.scale / 2;
    for (let i = 0; i < pos.count; i++) {
      // Feather the rim to zero so a patch blends into the plain instead of
      // ending on a 60m cliff.
      const edge = Math.max(Math.abs(pos.getX(i)), Math.abs(pos.getZ(i))) / half;
      const falloff = 1 - THREE.MathUtils.smoothstep(edge, 0.6, 1);

      const h = (terrain.heights[i] ?? 0) * falloff;
      pos.setY(i, h);
      terrain.heights[i] = h; // keep heightAt() consistent with the mesh

      const t = h / terrain.maxHeight;
      if (t < 0.12) c.copy(sand).lerp(grass, t / 0.12);
      else if (t < 0.45) c.copy(grass).lerp(rock, (t - 0.12) / 0.33);
      else if (t < 0.75) c.copy(rock);
      else c.copy(rock).lerp(snow, (t - 0.75) / 0.25);

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, [terrain]);

  return (
    <mesh geometry={geometry} position={[patch.x, 0, patch.z]} receiveShadow castShadow>
      <meshStandardMaterial vertexColors roughness={0.93} metalness={0} flatShading />
    </mesh>
  );
}

/** Max across overlapping patches, so contributions stack into ridges. */
function groundAt(
  built: { patch: Patch; terrain: TerrainData }[],
  wx: number,
  wz: number,
): number {
  let h = 0;
  for (const { patch, terrain } of built) {
    const lx = wx - patch.x;
    const lz = wz - patch.z;
    const half = terrain.scale / 2;
    if (lx < -half || lx > half || lz < -half || lz > half) continue;
    const v = heightAt(terrain, lx, lz);
    if (v > h) h = v;
  }
  return h;
}

/* ------------------------------------------------------------ the plain --- */

function Plain() {
  const { camera } = useThree();
  const mesh = useRef<THREE.Mesh>(null);

  // Follows the player so the world has no edge to walk off; fog hides the rim.
  useFrame(() => {
    if (mesh.current) mesh.current.position.set(camera.position.x, 0, camera.position.z);
  });

  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[3000, 3000]} />
      <meshStandardMaterial color="#5f6a4d" roughness={0.97} />
    </mesh>
  );
}

/* ------------------------------------------------------------ traveller --- */

function Wisp({ traveller }: { traveller: Traveller }) {
  const group = useRef<THREE.Group>(null);
  const target = useRef(new THREE.Vector3(traveller.x, 0, traveller.z));

  // Broadcasts land at ~10Hz; interpolating turns discrete hops into motion.
  useFrame((state, delta) => {
    if (!group.current) return;
    target.current.set(traveller.x, traveller.y ?? 0, traveller.z);
    group.current.position.lerp(target.current, 1 - Math.pow(0.002, delta));
    group.current.position.y += Math.sin(state.clock.elapsedTime * 2) * 0.05;
  });

  return (
    <group ref={group}>
      <mesh position={[0, 1.2, 0]}>
        <sphereGeometry args={[0.42, 14, 12]} />
        <meshStandardMaterial
          color={traveller.color}
          emissive={traveller.color}
          emissiveIntensity={2.2}
          toneMapped={false}
        />
      </mesh>
      <pointLight position={[0, 1.4, 0]} color={traveller.color} intensity={6} distance={14} decay={2} />
    </group>
  );
}

function PlantInstances({
  geometry,
  instances,
}: {
  geometry: THREE.BufferGeometry;
  instances: VegetationInstance[];
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    if (!meshRef.current) return;
    instances.forEach((instance, index) => {
      dummy.position.set(...instance.position);
      dummy.rotation.set(0, instance.rotation, 0);
      dummy.scale.setScalar(instance.scale);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(index, dummy.matrix);
    });
    meshRef.current.count = instances.length;
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [instances, dummy, geometry]);

  return (
    <instancedMesh ref={meshRef} args={[geometry, undefined, instances.length]} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.7} metalness={0.08} />
    </instancedMesh>
  );
}

function VegetationLayer({ patches }: { patches: VegetationPatch[] }) {
  const plantsByType = useMemo(() => {
    const groups = new Map<string, VegetationInstance[]>();
    for (const patch of patches) {
      const list = groups.get(patch.type) ?? [];
      list.push(...patch.instances);
      groups.set(patch.type, list);
    }
    return groups;
  }, [patches]);

  const plantGeometries = useMemo(() => {
    const map = new Map<string, THREE.BufferGeometry>();
    for (const type of plantsByType.keys()) {
      map.set(type, createPlantGeometry(type));
    }
    return map;
  }, [plantsByType]);

  if (!patches.length) return null;

  return (
    <>
      {Array.from(plantsByType.entries()).map(([type, instances]) => (
        <PlantInstances
          key={type}
          geometry={plantGeometries.get(type)!}
          instances={instances}
        />
      ))}
    </>
  );
}

/* ------------------------------------------------------------- controls --- */

function Walker({
  built,
  channel,
  selfId,
  onOpenVegetation,
}: {
  built: { patch: Patch; terrain: TerrainData }[];
  channel: React.RefObject<RealtimeChannel | null>;
  selfId: string;
  onOpenVegetation: (x: number, z: number) => void;
}) {
  const { camera } = useThree();
  const move = useRef({ f: false, b: false, l: false, r: false, sprint: false });
  const dir = useRef(new THREE.Vector3());
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  const lastSend = useRef(0);
  const locked = useRef(false);

  useEffect(() => {
    const set = (code: string, v: boolean) => {
      if (code === 'KeyW' || code === 'ArrowUp') move.current.f = v;
      if (code === 'KeyS' || code === 'ArrowDown') move.current.b = v;
      if (code === 'KeyA' || code === 'ArrowLeft') move.current.l = v;
      if (code === 'KeyD' || code === 'ArrowRight') move.current.r = v;
      if (code === 'ShiftLeft' || code === 'ShiftRight') move.current.sprint = v;
    };
    const down = (e: KeyboardEvent) => {
      set(e.code, true);
      if (e.code === 'KeyE' && locked.current) {
        e.preventDefault();
        onOpenVegetation(camera.position.x, camera.position.z);
      }
    };
    const up = (e: KeyboardEvent) => set(e.code, false);
    const blur = () => (move.current = { f: false, b: false, l: false, r: false, sprint: false });

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [camera, onOpenVegetation]);

  useFrame((_, delta) => {
    const m = move.current;
    const speed = (m.sprint ? 40 : 16) * delta;
    const fwd = Number(m.b) - Number(m.f);
    const side = Number(m.r) - Number(m.l);

    if (fwd || side) {
      dir.current.set(side, 0, fwd).normalize().multiplyScalar(speed);
      euler.current.set(0, camera.rotation.y, 0);
      dir.current.applyEuler(euler.current);
      camera.position.add(dir.current);
    }

    // Stick to whatever terrain is underfoot; lerped so a ridge is a fall.
    const ground = groundAt(built, camera.position.x, camera.position.z) + EYE;
    camera.position.y += (ground - camera.position.y) * Math.min(1, delta * 10);

    const now = performance.now();
    const ch = channel.current;
    if (ch && now - lastSend.current > BROADCAST_MS) {
      lastSend.current = now;
      sendMove(ch, {
        id: selfId,
        x: camera.position.x,
        y: camera.position.y - EYE,
        z: camera.position.z,
        a: camera.rotation.y,
        color: colorForId(selfId),
      });
    }
  });

  return (
    <PointerLockControls
      onLock={() => (locked.current = true)}
      onUnlock={() => (locked.current = false)}
    />
  );
}

/* ----------------------------------------------------------------- page --- */

export default function World() {
  const [patches, setPatches] = useState<Patch[]>([]);
  const [travellers, setTravellers] = useState<Traveller[]>([]);
  const [vegetationAt, setVegetationAt] = useState<{ x: number; z: number } | null>(null);
  const [vegetationPatches, setVegetationPatches] = useState<VegetationPatch[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'offline'>(
    supabase ? 'connecting' : 'offline',
  );

  const selfId = useMemo(makeSelfId, []);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const travellerMap = useRef<Map<string, Traveller>>(new Map());

  // Synthesis is the expensive step, so it happens once per patch and is
  // cached by id — not on every render or frame.
  const cache = useRef<Map<string, TerrainData>>(new Map());
  const built = useMemo(
    () =>
      patches.map((patch) => {
        let terrain = cache.current.get(patch.id);
        if (!terrain) {
          terrain = terrainFor(patch);
          cache.current.set(patch.id, terrain);
        }
        return { patch, terrain };
      }),
    [patches],
  );

  const openVegetation = useCallback((x: number, z: number) => {
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
    setVegetationAt({ x, z });
  }, []);

  const plantVegetation = useCallback(
    (type: string, x: number, z: number) => {
      if (!type.trim()) return;
      setVegetationPatches((prev) => [...prev, createVegetationPatch(built, x, z, type.trim())]);
      setVegetationAt(null);
    },
    [built],
  );

  /* -------- load + realtime -------- */
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    const toPatch = (r: Record<string, unknown>): Patch | null => {
      const props = (r.properties ?? {}) as Record<string, unknown>;
      if (typeof props.sketch !== 'string') return null;
      return {
        id: String(r.id),
        x: Number(r.x) || 0,
        z: Number(r.z) || 0,
        sketch: props.sketch,
        seed: Number(props.seed) || 1337,
      };
    };

    supabase
      .from('world_assets')
      .select('*')
      .eq('type', 'terrain')
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        setPatches((prev) => {
          const byId = new Map(prev.map((p) => [p.id, p]));
          for (const row of data) {
            const p = toPatch(row as Record<string, unknown>);
            if (p) byId.set(p.id, p);
          }
          return [...byId.values()];
        });
      });

    const channel = supabase
      .channel('public:world_assets')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'world_assets' },
        (payload) => {
          const p = toPatch(payload.new as Record<string, unknown>);
          if (!p) return;
          setPatches((prev) => (prev.some((q) => q.id === p.id) ? prev : [...prev, p]));
        },
      )
      .subscribe((s) => {
        if (s === 'SUBSCRIBED') setStatus('live');
        else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setStatus('offline');
      });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  /* -------- presence -------- */
  useEffect(() => {
    if (!supabase) return;
    const channel = joinTravellerChannel(supabase, selfId, (t) => {
      travellerMap.current.set(t.id, t);
    });
    channelRef.current = channel;

    // One timer drives eviction and re-render, so React updates at 5Hz rather
    // than on every inbound broadcast.
    const timer = window.setInterval(() => {
      const now = performance.now();
      for (const [id, t] of travellerMap.current) {
        if (now - t.seen > STALE_MS) travellerMap.current.delete(id);
      }
      setTravellers([...travellerMap.current.values()]);
    }, 200);

    return () => {
      window.clearInterval(timer);
      channelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [selfId]);

  /* -------- contribute -------- */

  const label =
    status === 'live'
      ? `${travellers.length} traveller${travellers.length === 1 ? '' : 's'} nearby`
      : status === 'connecting'
        ? 'connecting…'
        : 'offline — solo world';

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black select-none">
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: [0, EYE, 40], fov: 72, near: 0.5, far: 3000 }}
        onCreated={({ scene }) => {
          scene.fog = new THREE.FogExp2('#b9c6d6', 0.0022);
        }}
      >
        <Sky sunPosition={[90, 25, -120]} turbidity={7} rayleigh={2.4} />
        <Stars radius={500} depth={70} count={700} factor={4} fade />
        <ambientLight intensity={0.6} />
        <directionalLight position={[120, 190, -70]} intensity={2.0} color="#fff3e2" castShadow />

        <Plain />
        {built.map(({ patch, terrain }) => (
          <PatchMesh key={patch.id} patch={patch} terrain={terrain} />
        ))}

        {travellers.map((t) => (
          <Wisp key={t.id} traveller={t} />
        ))}

        <VegetationLayer patches={vegetationPatches} />
        <Walker
          built={built}
          channel={channelRef}
          selfId={selfId}
          onOpenVegetation={openVegetation}
        />
      </Canvas>

      <div className="pointer-events-none absolute left-6 top-6 rounded-lg bg-black/50 p-4 backdrop-blur">
        <h1 className="text-lg font-semibold text-white">Infinite Terra</h1>
        <p className="mt-1 text-sm text-white/70">
          {patches.length} landform{patches.length === 1 ? '' : 's'} · {label}
        </p>
      </div>

      <div className="pointer-events-none absolute bottom-6 left-6 space-y-1 text-xs text-white/55">
        <p>
          <span className="text-white/85">Click</span> to look ·{' '}
          <span className="text-white/85">WASD</span> to walk ·{' '}
          <span className="text-white/85">Shift</span> to run
        </p>
        <p>
          <span className="text-white/85">E</span> to plant vegetation here ·{' '}
          <span className="text-white/85">Esc</span> to release
        </p>
      </div>

      {vegetationAt && (
        <VegetationPanel
          onCancel={() => setVegetationAt(null)}
          onPlant={(type) => plantVegetation(type, vegetationAt.x, vegetationAt.z)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ draw panel --- */

function VegetationPanel({
  onPlant,
  onCancel,
}: {
  onPlant: (type: string) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState('');

  const submit = useCallback(() => {
    const trimmed = type.trim();
    if (!trimmed) return;
    onPlant(trimmed);
  }, [onPlant, type]);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-neutral-900 p-6">
        <h2 className="text-lg font-semibold text-white">Plant vegetation here</h2>
        <p className="mt-1 text-sm text-white/60">
          Type a vegetation type like “cherry blossom” or “dead forest”. Hundreds of plants will appear on the terrain surface.
        </p>

        <input
          value={type}
          onChange={(e) => setType(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="e.g. cherry blossom, dead forest"
          className="mt-4 w-full rounded-lg border border-white/15 bg-white/5 px-4 py-3 text-white outline-none placeholder:text-white/40 focus:border-emerald-400"
          autoFocus
        />

        <div className="mt-4 flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/80 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="rounded-md bg-emerald-500 px-5 py-2 text-sm font-medium text-neutral-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!type.trim()}
          >
            Plant
          </button>
        </div>
      </div>
    </div>
  );
}
