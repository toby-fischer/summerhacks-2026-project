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

import { buildingFromImageData, type BuildingData } from './building';
import {
  generateFloorplan,
  generateFurniture,
  rectMinusHole,
  type BuildingSpec,
  type Floorplan,
  type FurnitureKind,
  type FurniturePiece,
  type RectBox,
  type RoomRole,
} from './interior';
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
const PROXIMITY_AUDIO_DISTANCE = 15; // Max distance in meters to hear animal
/** How far ahead of the player a new sketch lands — enough that even the
 *  largest generated building (~12.6m wide) can't spawn on top of them. */
const SKETCH_SPAWN_DISTANCE = 14;

// Preset color options for the marker
const COLOR_PALETTE = [
  { name: 'Black', value: '#000000' },
  { name: 'Charcoal', value: '#4b5563' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'White', value: '#f0f0f0' },
];

const MARKER_SIZES = [
  { label: 'S', size: 6 },
  { label: 'M', size: 16 },
  { label: 'L', size: 28 },
];

interface Patch {
  id: string;
  x: number;
  z: number;
  sketch: string;
  seed: number;
}

interface AnimalData {
  id: string;
  x: number;
  z: number;
  outlineSketch: string;
  patternSketch: string;
  soundDataUrl?: string | null;
}

interface BuildingAsset {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  coverage: number;
  meanInk: number;
  normWidth: number;
  normHeight: number;
}

type DrawCommit =
  | { kind: 'terrain'; grid: Float32Array<ArrayBuffer> }
  | { kind: 'building'; building: BuildingData };

/* ------------------------------------------------------------ encoding --- */

function encodeSketch(grid: Float32Array): string {
  const bytes = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    bytes[i] = Math.max(0, Math.min(255, Math.round(grid[i] * 255)));
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function decodeSketch(b64: string): Float32Array {
  const bin = atob(b64);
  const out = new Float32Array(SKETCH_GRID * SKETCH_GRID);
  const n = Math.min(bin.length, out.length);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i) / 255;
  return out;
}

function encodeColorSketch(grid: Uint8Array): string {
  let s = '';
  for (let i = 0; i < grid.length; i++) s += String.fromCharCode(grid[i]);
  return btoa(s);
}

function decodeColorSketch(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
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

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function hash01(seed: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
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

function sampleFootprintGround(
  built: { patch: Patch; terrain: TerrainData }[],
  cx: number,
  cz: number,
  width: number,
  depth: number,
): { center: number; nw: number; ne: number; sw: number; se: number } {
  const halfW = width / 2;
  const halfD = depth / 2;
  return {
    center: groundAt(built, cx, cz),
    nw: groundAt(built, cx - halfW, cz + halfD),
    ne: groundAt(built, cx + halfW, cz + halfD),
    sw: groundAt(built, cx - halfW, cz - halfD),
    se: groundAt(built, cx + halfW, cz - halfD),
  };
}

type PartKind = 'foundation' | 'wall' | 'trim' | 'roof' | 'window' | 'door' | 'accent' | 'awning';
interface PartTransform {
  kind: PartKind;
  style: 0 | 1 | 2;
  position: [number, number, number];
  scale: [number, number, number];
  rotation: [number, number, number];
}

/**
 * Footprint (world-space center + size) that a building occupies at ground
 * level. Shared by the visual assembly and the walker's collision check so
 * the two can never disagree about where a wall actually is.
 */
function footprintFor(building: BuildingAsset): { cx: number; cz: number; width: number; depth: number } {
  const WORLD_BUILDING_SCALE = 0.45;
  const rawW = clamp(finiteOr(building.width, 12) * WORLD_BUILDING_SCALE, 1.8, PATCH_SCALE * 0.16);
  const rawD = clamp(finiteOr(building.depth, 8) * WORLD_BUILDING_SCALE, 1.6, PATCH_SCALE * 0.12);
  const cx = finiteOr(building.x, 0);
  const cz = finiteOr(building.z, 0);
  const bayW = 1.8;
  const baysX = clamp(Math.round(rawW / bayW), 2, 7);
  const baysZ = clamp(Math.round(rawD / bayW), 2, 6);
  return { cx, cz, width: baysX * bayW, depth: baysZ * bayW };
}

/**
 * Everything derived from a building row that both the exterior kit and the
 * interior/door logic need to agree on. Computed once per building so the
 * door you can see is exactly the door you can walk through.
 */
interface BuildingLayout {
  cx: number;
  cz: number;
  width: number;
  depth: number;
  floors: number;
  floorH: number;
  bodyH: number;
  style: 0 | 1 | 2;
  doorW: number;
  doorH: number;
  floorY: number;
  profile: { center: number; nw: number; ne: number; sw: number; se: number };
}

function buildingLayout(
  building: BuildingAsset,
  built: { patch: Patch; terrain: TerrainData }[],
): BuildingLayout {
  const WORLD_BUILDING_SCALE = 0.45;
  const rawH = clamp(finiteOr(building.height, 18) * WORLD_BUILDING_SCALE, 2.4, 48);
  const { cx, cz, width, depth } = footprintFor(building);
  const floorH = 2.6;
  const floors = clamp(Math.round(rawH / floorH), 1, 5);
  const bodyH = floors * floorH;
  const style = Math.floor(hash01(building.id, 7) * 3) as 0 | 1 | 2;
  const profile = sampleFootprintGround(built, cx, cz, width, depth);
  const floorY = Math.max(profile.nw, profile.ne, profile.sw, profile.se);
  const doorW = Math.min(style === 2 ? 2.1 : 1.7, width * (style === 1 ? 0.18 : 0.24));
  const doorH = Math.min(style === 1 ? 2.6 : 2.3, floorH * (style === 1 ? 0.94 : 0.86));
  return { cx, cz, width, depth, floors, floorH, bodyH, style, doorW, doorH, floorY, profile };
}

/** Matches the wall thickness buildPartsForBuilding actually renders. */
const EXTERIOR_WALL_T = 0.24;

/**
 * The building's exterior walls as thin collision segments, with a gap left
 * open at the door — there is no invisible box around the whole building,
 * so walking through the doorway is the only way in, exactly like walking
 * up to any other wall.
 */
function exteriorWallFootprints(layout: BuildingLayout): Footprint[] {
  const halfW = layout.width / 2;
  const halfD = layout.depth / 2;
  const out: Footprint[] = [
    { cx: layout.cx - halfW + EXTERIOR_WALL_T / 2, cz: layout.cz, width: EXTERIOR_WALL_T, depth: layout.depth },
    { cx: layout.cx + halfW - EXTERIOR_WALL_T / 2, cz: layout.cz, width: EXTERIOR_WALL_T, depth: layout.depth },
    { cx: layout.cx, cz: layout.cz - halfD + EXTERIOR_WALL_T / 2, width: layout.width, depth: EXTERIOR_WALL_T },
  ];

  // Front (south) wall has the doorway gap.
  const doorHalf = layout.doorW / 2 + 0.25;
  const minX = layout.cx - halfW;
  const maxX = layout.cx + halfW;
  const gapCenter = layout.cx;
  const wallZ = layout.cz + halfD - EXTERIOR_WALL_T / 2;
  if (gapCenter - doorHalf > minX + 0.15) {
    const a = minX;
    const b = gapCenter - doorHalf;
    out.push({ cx: (a + b) / 2, cz: wallZ, width: b - a, depth: EXTERIOR_WALL_T });
  }
  if (gapCenter + doorHalf < maxX - 0.15) {
    const a = gapCenter + doorHalf;
    const b = maxX;
    out.push({ cx: (a + b) / 2, cz: wallZ, width: b - a, depth: EXTERIOR_WALL_T });
  }
  return out;
}

/** True once a player has walked far enough through the doorway gap to be inside the shell. */
function insideBuildingShell(layout: BuildingLayout, x: number, z: number): boolean {
  const lx = x - layout.cx;
  const lz = z - layout.cz;
  const innerHalfW = layout.width / 2 - EXTERIOR_WALL_T;
  const innerHalfD = layout.depth / 2 - EXTERIOR_WALL_T;
  return Math.abs(lx) < innerHalfW && Math.abs(lz) < innerHalfD;
}

function buildPartsForBuilding(building: BuildingAsset, layout: BuildingLayout): PartTransform[] {
  const { cx, cz, width, depth, floors, floorH, bodyH, style, doorW, doorH, floorY, profile } = layout;

  // Human-designed module dimensions. Buildings are assembled from these only.
  const bayW = 1.8;
  const wallT = 0.24;
  const trimT = 0.18;
  const trimH = 0.2;

  const baysX = Math.round(width / bayW);
  const baysZ = Math.round(depth / bayW);

  const sideSlope = floorY - Math.min(profile.nw, profile.ne, profile.sw, profile.se);
  const centerY = floorY + bodyH / 2;
  const seed = hash01(building.id, 41);
  const styleCfg =
    style === 0
      ? { windowBias: 0.18, roofSteps: 2, roofShrink: 0.86, trimEvery: 1, awningProb: 0.38, cornerAccent: true } // civic / clean
      : style === 1
        ? { windowBias: 0.35, roofSteps: 4, roofShrink: 0.78, trimEvery: 1, awningProb: 0.12, cornerAccent: true } // tower / dense
        : { windowBias: 0.08, roofSteps: 1, roofShrink: 0.9, trimEvery: 2, awningProb: 0.52, cornerAccent: false }; // market / low

  const put = (
    kind: PartKind,
    position: [number, number, number],
    scale: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0],
  ) => {
    parts.push({ kind, style, position, scale, rotation });
  };

  const parts: PartTransform[] = [];
  const halfW = width / 2;
  const halfD = depth / 2;

  const sideHeight = bodyH + sideSlope;
  // Foundation plinth + slope posts so building sits cleanly on uneven terrain.
  put('foundation', [cx, floorY - 0.16, cz], [width + 0.36, 0.32, depth + 0.36]);
  const supports: Array<[number, number, number]> = [
    [cx - halfW, profile.sw, cz - halfD],
    [cx + halfW, profile.se, cz - halfD],
    [cx - halfW, profile.nw, cz + halfD],
    [cx + halfW, profile.ne, cz + halfD],
  ];
  for (const [x, gy, z] of supports) {
    const h = Math.max(0.18, floorY - gy + 0.24);
    put('foundation', [x, gy + h / 2 - 0.02, z], [0.36, h, 0.36]);
  }

  // Side wall slabs.
  put('wall', [cx - halfW + wallT / 2, centerY, cz], [wallT, sideHeight, depth]);
  put('wall', [cx + halfW - wallT / 2, centerY, cz], [wallT, sideHeight, depth]);
  put('wall', [cx, centerY, cz - halfD + wallT / 2], [width, sideHeight, wallT]);
  put('wall', [cx, centerY, cz + halfD - wallT / 2], [width, sideHeight, wallT]);

  // Floor trims.
  for (let f = 1; f <= floors; f++) {
    if (f % styleCfg.trimEvery !== 0) continue;
    const y = floorY + f * floorH;
    put('trim', [cx, y, cz], [width + trimT, trimH, depth + trimT]);
  }

  if (styleCfg.cornerAccent) {
    const accentH = Math.max(0.9, bodyH * (style === 1 ? 1.03 : 0.94));
    const accentW = style === 1 ? 0.22 : 0.18;
    put('accent', [cx - halfW + accentW / 2, floorY + accentH / 2, cz - halfD + accentW / 2], [accentW, accentH, accentW]);
    put('accent', [cx + halfW - accentW / 2, floorY + accentH / 2, cz - halfD + accentW / 2], [accentW, accentH, accentW]);
    put('accent', [cx - halfW + accentW / 2, floorY + accentH / 2, cz + halfD - accentW / 2], [accentW, accentH, accentW]);
    put('accent', [cx + halfW - accentW / 2, floorY + accentH / 2, cz + halfD - accentW / 2], [accentW, accentH, accentW]);
  }

  // Front door.
  put('door', [cx, floorY + doorH / 2, cz + halfD + 0.01], [doorW, doorH, 0.06]);

  // Windows: deterministic pattern so no two buildings are identical.
  const windowW = style === 1 ? 0.7 : style === 2 ? 0.92 : 0.8;
  const windowH = style === 2 ? 0.78 : style === 1 ? 1.02 : 0.9;
  for (let f = 0; f < floors; f++) {
    const wy = floorY + f * floorH + floorH * 0.56;
    for (let i = 0; i < baysX; i++) {
      const x = cx - halfW + bayW * (i + 0.5);
      const frontOpen = i === Math.floor(baysX / 2) && f === 0;
      if (!frontOpen && hash01(`${building.id}-f-${f}-x-${i}`, 5) > styleCfg.windowBias + seed * 0.2) {
        put('window', [x, wy, cz + halfD + 0.012], [windowW, windowH, 0.04]);
        if (f < floors - 1 && hash01(`${building.id}-awn-f-${f}-x-${i}`, 103) < styleCfg.awningProb) {
          put('awning', [x, wy + windowH * 0.6, cz + halfD + 0.26], [windowW * 1.06, 0.08, 0.38]);
        }
      }
      if (hash01(`${building.id}-b-${f}-x-${i}`, 13) > styleCfg.windowBias + 0.02) {
        put('window', [x, wy, cz - halfD - 0.012], [windowW, windowH, 0.04]);
      }
    }
    for (let i = 0; i < baysZ; i++) {
      const z = cz - halfD + bayW * (i + 0.5);
      if (hash01(`${building.id}-l-${f}-z-${i}`, 29) > styleCfg.windowBias + 0.16) {
        put('window', [cx - halfW - 0.012, wy, z], [0.04, windowH, windowW]);
      }
      if (hash01(`${building.id}-r-${f}-z-${i}`, 43) > styleCfg.windowBias + 0.16) {
        put('window', [cx + halfW + 0.012, wy, z], [0.04, windowH, windowW]);
      }
    }
  }

  // Stepped roof from fixed modules.
  const roofSteps = styleCfg.roofSteps;
  let roofW = width * 0.96;
  let roofD = depth * 0.96;
  for (let i = 0; i < roofSteps; i++) {
    const rh = style === 1 ? 0.28 : style === 2 ? 0.4 : 0.34;
    const ry = floorY + bodyH + rh / 2 + i * (rh * 0.98);
    put('roof', [cx, ry, cz], [roofW, rh, roofD]);
    roofW *= styleCfg.roofShrink;
    roofD *= styleCfg.roofShrink;
  }
  // Roof cap accent for stronger silhouettes.
  if (style !== 2) {
    put(
      'accent',
      [cx, floorY + bodyH + roofSteps * 0.34 + 0.18, cz],
      [Math.max(0.35, roofW * 0.56), 0.28 + style * 0.08, Math.max(0.35, roofD * 0.56)],
    );
  }

  return parts;
}

function InstancedKitMesh({
  parts,
  kind,
  style,
  color,
  emissive,
  roughness,
  metalness,
  transparent = false,
  opacity = 1,
}: {
  parts: PartTransform[];
  kind: PartKind;
  style: 0 | 1 | 2;
  color: string;
  emissive?: string;
  roughness?: number;
  metalness?: number;
  transparent?: boolean;
  opacity?: number;
}) {
  const filtered = useMemo(
    () => parts.filter((p) => p.kind === kind && p.style === style),
    [parts, kind, style],
  );
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    if (!ref.current) return;
    // Instanced meshes are spread across the world; default frustum culling
    // can incorrectly cull them based on unit geometry at origin.
    ref.current.frustumCulled = false;
    for (let i = 0; i < filtered.length; i++) {
      const p = filtered[i];
      dummy.position.set(p.position[0], p.position[1], p.position[2]);
      dummy.rotation.set(p.rotation[0], p.rotation[1], p.rotation[2]);
      dummy.scale.set(p.scale[0], p.scale[1], p.scale[2]);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
    }
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.computeBoundingSphere();
  }, [dummy, filtered]);

  if (filtered.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, filtered.length]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        emissiveIntensity={emissive ? 0.22 : 0}
        roughness={roughness}
        metalness={metalness}
        transparent={transparent}
        opacity={opacity}
        depthWrite={!transparent}
        toneMapped
      />
    </instancedMesh>
  );
}

function BuildingKit({
  layouts,
}: {
  layouts: { building: BuildingAsset; layout: BuildingLayout }[];
}) {
  const parts = useMemo(() => {
    const out: PartTransform[] = [];
    for (const { building, layout } of layouts) out.push(...buildPartsForBuilding(building, layout));
    return out;
  }, [layouts]);

  return (
    <>
      {([
        {
          style: 0 as const,
          foundation: '#4f5648',
          wall: '#5f685a',
          wallEm: '#233126',
          trim: '#7d8c72',
          roof: '#738066',
          roofEm: '#2b3a2f',
          window: '#94b8a9',
          windowEm: '#6dcaa9',
          door: '#8e7e5f',
          doorEm: '#3f2f17',
          accent: '#8e9f80',
          awning: '#aebf8d',
        },
        {
          style: 1 as const,
          foundation: '#4b4f5a',
          wall: '#5e6172',
          wallEm: '#222a3e',
          trim: '#888ba3',
          roof: '#6d7087',
          roofEm: '#303552',
          window: '#9fb2d4',
          windowEm: '#78a2f0',
          door: '#776f83',
          doorEm: '#312843',
          accent: '#8f92aa',
          awning: '#9aa0be',
        },
        {
          style: 2 as const,
          foundation: '#5c5042',
          wall: '#76634e',
          wallEm: '#3a2919',
          trim: '#9c8261',
          roof: '#8b6f53',
          roofEm: '#51341f',
          window: '#c5b595',
          windowEm: '#dca96d',
          door: '#5f4a34',
          doorEm: '#352211',
          accent: '#a28c6f',
          awning: '#c8aa7a',
        },
      ] as const).map((p) => (
        <React.Fragment key={`style-${p.style}`}>
          <InstancedKitMesh parts={parts} kind="foundation" style={p.style} color={p.foundation} roughness={0.96} metalness={0} />
          <InstancedKitMesh parts={parts} kind="wall" style={p.style} color={p.wall} emissive={p.wallEm} roughness={0.9} metalness={0.03} />
          <InstancedKitMesh parts={parts} kind="trim" style={p.style} color={p.trim} roughness={0.84} metalness={0.02} />
          <InstancedKitMesh parts={parts} kind="roof" style={p.style} color={p.roof} emissive={p.roofEm} roughness={0.82} metalness={0.04} />
          <InstancedKitMesh parts={parts} kind="window" style={p.style} color={p.window} emissive={p.windowEm} roughness={0.2} metalness={0.06} />
          <InstancedKitMesh parts={parts} kind="door" style={p.style} color={p.door} emissive={p.doorEm} roughness={0.75} metalness={0.02} />
          <InstancedKitMesh parts={parts} kind="accent" style={p.style} color={p.accent} emissive={p.wallEm} roughness={0.86} metalness={0.03} />
          <InstancedKitMesh parts={parts} kind="awning" style={p.style} color={p.awning} emissive={p.roofEm} roughness={0.64} metalness={0.02} />
        </React.Fragment>
      ))}
    </>
  );
}

/* ----------------------------------------------------------- interiors --- */

/**
 * Interiors live in the same scene, at the building's own x/z, just deep
 * underground — far enough below the terrain/plain (y=0) and every patch's
 * positive heights that nothing ever pokes through. Walking through a door
 * teleports the camera down here instead of swapping scenes, so realtime
 * presence, lighting and the renderer all keep working unmodified.
 */
const INTERIOR_Y_BASE = -600;
const INTERIOR_FLOOR_H = 3.4;

interface ActiveInterior {
  buildingId: string;
  floor: number;
}

function interiorOrigin(layout: BuildingLayout, floor: number): [number, number, number] {
  return [layout.cx, INTERIOR_Y_BASE + floor * INTERIOR_FLOOR_H, layout.cz];
}

function specFor(building: BuildingAsset, layout: BuildingLayout): BuildingSpec {
  return {
    id: building.id,
    width: layout.width,
    depth: layout.depth,
    floors: layout.floors,
    style: layout.style,
    doorW: layout.doorW,
    doorH: layout.doorH,
  };
}

/** Same door palette the exterior shell paints its front door with, kept in sync. */
const STYLE_DOOR: Record<0 | 1 | 2, { color: string; emissive: string; frame: string }> = {
  0: { color: '#8e7e5f', emissive: '#3f2f17', frame: '#3f4438' },
  1: { color: '#776f83', emissive: '#312843', frame: '#34394a' },
  2: { color: '#5f4a34', emissive: '#352211', frame: '#463a2c' },
};

interface BoxTransform {
  position: [number, number, number];
  scale: [number, number, number];
  rotation?: [number, number, number];
}

function InstancedBoxes({
  transforms,
  color,
  emissive,
  roughness = 0.88,
  metalness = 0.02,
}: {
  transforms: BoxTransform[];
  color: string;
  emissive?: string;
  roughness?: number;
  metalness?: number;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.frustumCulled = false;
    for (let i = 0; i < transforms.length; i++) {
      const t = transforms[i];
      const r = t.rotation ?? [0, 0, 0];
      dummy.position.set(t.position[0], t.position[1], t.position[2]);
      dummy.rotation.set(r[0], r[1], r[2]);
      dummy.scale.set(t.scale[0], t.scale[1], t.scale[2]);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
    }
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.computeBoundingSphere();
  }, [dummy, transforms]);

  if (transforms.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, transforms.length]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        emissiveIntensity={emissive ? 0.25 : 0}
        roughness={roughness}
        metalness={metalness}
        toneMapped
      />
    </instancedMesh>
  );
}

const FURNITURE_COLOR: Record<FurnitureKind, string> = {
  rug: '#8a5a4a',
  desk: '#6b5338',
  chair: '#4f4536',
  shelf: '#5a4a36',
  crate: '#7a6440',
  table: '#6b5338',
  lamp: '#e4cf8f',
  bed: '#8fa0b8',
};

/** Per-role floor finish so rooms read as different spaces, not one big box. */
const ROOM_FLOOR_TINT: Record<RoomRole, number> = {
  foyer: 1.08,
  office: 0.96,
  storage: 0.74,
  lounge: 1.14,
  stair: 0.86,
};

function shade(hex: string, mul: number): string {
  const n = parseInt(hex.slice(1), 16);
  const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp255(((n >> 16) & 255) * mul);
  const g = clamp255(((n >> 8) & 255) * mul);
  const b = clamp255((n & 255) * mul);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** One floor's rooms, walls, stairs and furniture, rendered at its underground origin. */
function InteriorScene({
  building,
  layout,
  floor,
  floorplan,
  furniture,
  style,
}: {
  building: BuildingAsset;
  layout: BuildingLayout;
  floor: number;
  floorplan: Floorplan;
  furniture: FurniturePiece[];
  style: 0 | 1 | 2;
}) {
  const origin = interiorOrigin(layout, floor);
  const doorInfo = STYLE_DOOR[style];

  const palette =
    style === 0
      ? { floor: '#8a8474', wall: '#cfc9b8', ceiling: '#b7b2a2', trim: '#5f685a', glow: '#bfe6c9' }
      : style === 1
        ? { floor: '#767c8c', wall: '#c3c7d4', ceiling: '#9fa4b4', trim: '#5e6172', glow: '#bcd0ff' }
        : { floor: '#8f7a5c', wall: '#d8c7a8', ceiling: '#bda87e', trim: '#76634e', glow: '#ffe3ad' };

  // Stairwell shafts punch through the floor slab (descending) and/or the
  // ceiling slab (ascending) instead of the stairs visually clipping through
  // a solid plate.
  const stairHole = useMemo<RectBox | null>(() => {
    const s = floorplan.stair;
    if (!s) return null;
    return { cx: s.cx, cz: s.cz, halfW: s.halfW * 1.05, halfD: s.halfD * 1.05 };
  }, [floorplan.stair]);

  const floorSlab = useMemo<BoxTransform[]>(
    () =>
      rectMinusHole(floorplan.halfW, floorplan.halfD, floorplan.stair?.down ? stairHole : null).map((r) => ({
        position: [r.cx, -0.1, r.cz],
        scale: [r.halfW * 2, 0.2, r.halfD * 2],
      })),
    [floorplan.halfW, floorplan.halfD, floorplan.stair, stairHole],
  );
  const ceilingSlab = useMemo<BoxTransform[]>(
    () =>
      rectMinusHole(floorplan.halfW, floorplan.halfD, floorplan.stair?.up ? stairHole : null).map((r) => ({
        position: [r.cx, floorplan.wallHeight + 0.12, r.cz],
        scale: [r.halfW * 2, 0.24, r.halfD * 2],
      })),
    [floorplan.halfW, floorplan.halfD, floorplan.wallHeight, floorplan.stair, stairHole],
  );
  const wallBoxes = useMemo<BoxTransform[]>(
    () =>
      floorplan.walls.map((w) => ({
        position: [w.cx, floorplan.wallHeight / 2, w.cz],
        scale: [w.halfW * 2, floorplan.wallHeight, w.halfD * 2],
      })),
    [floorplan.walls, floorplan.wallHeight],
  );
  // Baseboard + crown trim along every wall run — a plain box reads as a
  // slab, a two-tone strip at floor and ceiling reads as a built room.
  const baseboards = useMemo<BoxTransform[]>(
    () =>
      floorplan.walls.map((w) => ({
        position: [w.cx, 0.16, w.cz],
        scale: [w.halfW * 2 + 0.03, 0.28, w.halfD * 2 + 0.03],
      })),
    [floorplan.walls],
  );
  const crown = useMemo<BoxTransform[]>(
    () =>
      floorplan.walls.map((w) => ({
        position: [w.cx, floorplan.wallHeight - 0.14, w.cz],
        scale: [w.halfW * 2 + 0.03, 0.16, w.halfD * 2 + 0.03],
      })),
    [floorplan.walls, floorplan.wallHeight],
  );

  // Room floor patches: a tinted plate per room, inset from its walls, so
  // each role visibly reads as its own space instead of one shared color.
  const roomFloors = useMemo<{ transforms: BoxTransform[]; color: string }[]>(() => {
    const groups = new Map<string, BoxTransform[]>();
    for (const room of floorplan.rooms) {
      const w = room.maxX - room.minX - 0.36;
      const d = room.maxZ - room.minZ - 0.36;
      if (w <= 0.2 || d <= 0.2) continue;
      const tone = shade(palette.floor, ROOM_FLOOR_TINT[room.role]);
      const arr = groups.get(tone) ?? [];
      arr.push({
        position: [(room.minX + room.maxX) / 2, 0.006, (room.minZ + room.maxZ) / 2],
        scale: [w, 0.03, d],
      });
      groups.set(tone, arr);
    }
    return Array.from(groups.entries()).map(([color, transforms]) => ({ color, transforms }));
  }, [floorplan.rooms, palette.floor]);

  // Punched window insets along the exterior perimeter, glowing softly so
  // rooms don't read as sealed boxes — deterministic per building/floor/wall.
  const windows = useMemo<BoxTransform[]>(() => {
    const out: BoxTransform[] = [];
    const bay = 2.1;
    const wH = Math.min(1.3, floorplan.wallHeight * 0.42);
    const wY = floorplan.wallHeight * 0.58;
    const seed = `${building.id}-iw-${floor}`;
    const runs: { axis: 'x' | 'z'; fixed: number; from: number; to: number; skip?: [number, number] }[] = [
      { axis: 'z', fixed: floorplan.halfD, from: -floorplan.halfW, to: floorplan.halfW, skip: floor === 0 ? [-1.6, 1.6] : undefined },
      { axis: 'z', fixed: -floorplan.halfD, from: -floorplan.halfW, to: floorplan.halfW },
      { axis: 'x', fixed: floorplan.halfW, from: -floorplan.halfD, to: floorplan.halfD },
      { axis: 'x', fixed: -floorplan.halfW, from: -floorplan.halfD, to: floorplan.halfD },
    ];
    runs.forEach((run, ri) => {
      const span = run.to - run.from;
      const count = Math.max(1, Math.floor(span / bay));
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        const p = run.from + span * t;
        if (run.skip && p > run.skip[0] && p < run.skip[1]) continue;
        if (hash01(seed, ri * 97 + i) < 0.3) continue;
        if (run.axis === 'z') {
          out.push({ position: [p, wY, run.fixed], scale: [Math.min(1.1, bay * 0.5), wH, 0.05] });
        } else {
          out.push({ position: [run.fixed, wY, p], scale: [0.05, wH, Math.min(1.1, bay * 0.5)] });
        }
      }
    });
    return out;
  }, [floorplan.halfW, floorplan.halfD, floorplan.wallHeight, building.id, floor]);

  // Door slab + frame at the ground-floor threshold — without it, looking
  // back at the doorway from inside showed straight through to empty space.
  const doorPanels = useMemo<{ frame: BoxTransform[]; slab: BoxTransform[] }>(() => {
    if (floor !== 0) return { frame: [], slab: [] };
    const w = layout.doorW;
    const h = Math.min(floorplan.wallHeight - 0.2, layout.doorH);
    const z = floorplan.halfD - 0.03;
    return {
      frame: [
        { position: [0, h + 0.1, z], scale: [w + 0.3, 0.2, 0.14] },
        { position: [-w / 2 - 0.1, h / 2, z], scale: [0.2, h + 0.2, 0.14] },
        { position: [w / 2 + 0.1, h / 2, z], scale: [0.2, h + 0.2, 0.14] },
      ],
      slab: [{ position: [0, h / 2, z + 0.05], scale: [w * 0.94, h * 0.96, 0.06] }],
    };
  }, [floor, layout.doorW, layout.doorH, floorplan.halfD, floorplan.wallHeight]);

  // Visual steps only — the actual walkable height comes from Walker's
  // continuous stair-progress calculation, not from these box positions.
  const stairSteps = useMemo<BoxTransform[]>(() => {
    const s = floorplan.stair;
    if (!s) return [];
    const steps = 9;
    const out: BoxTransform[] = [];
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const z = s.cz + s.halfD - t * s.halfD * 2;
      const y = t * INTERIOR_FLOOR_H;
      out.push({ position: [s.cx, y - 0.08, z], scale: [s.halfW * 2 * 0.92, 0.16, (s.halfD * 2) / steps] });
    }
    return out;
  }, [floorplan.stair]);

  // Thin railing posts framing the stair opening, so the punched-out hole
  // reads as a deliberate landing rather than a rendering gap.
  const railings = useMemo<BoxTransform[]>(() => {
    const s = floorplan.stair;
    if (!s || (!s.up && !s.down)) return [];
    const out: BoxTransform[] = [];
    const rH = 0.9;
    const corners: [number, number][] = [
      [s.cx - s.halfW * 1.05, s.cz - s.halfD * 1.05],
      [s.cx + s.halfW * 1.05, s.cz - s.halfD * 1.05],
      [s.cx - s.halfW * 1.05, s.cz + s.halfD * 1.05],
      [s.cx + s.halfW * 1.05, s.cz + s.halfD * 1.05],
    ];
    for (const [x, z] of corners) out.push({ position: [x, rH / 2, z], scale: [0.1, rH, 0.1] });
    return out;
  }, [floorplan.stair]);

  const byKind = useMemo(() => {
    const map = new Map<FurnitureKind, BoxTransform[]>();
    for (const f of furniture) {
      const arr = map.get(f.kind) ?? [];
      arr.push({ position: f.position, scale: f.scale, rotation: f.rotation });
      map.set(f.kind, arr);
    }
    return map;
  }, [furniture]);

  return (
    <group position={origin}>
      <ambientLight intensity={0.5} />
      <pointLight position={[0, floorplan.wallHeight - 0.4, 0]} intensity={7} distance={22} decay={2} color="#fff3d8" />
      {floorplan.rooms.map((room, i) => (
        <pointLight
          key={i}
          position={[(room.minX + room.maxX) / 2, floorplan.wallHeight - 0.3, (room.minZ + room.maxZ) / 2]}
          intensity={2.4}
          distance={9}
          decay={2}
          color="#fff6e0"
        />
      ))}
      <InstancedBoxes transforms={floorSlab} color={palette.floor} roughness={0.95} />
      {roomFloors.map((g, i) => (
        <InstancedBoxes key={i} transforms={g.transforms} color={g.color} roughness={0.9} />
      ))}
      <InstancedBoxes transforms={ceilingSlab} color={palette.ceiling} roughness={0.95} />
      <InstancedBoxes transforms={wallBoxes} color={palette.wall} roughness={0.9} />
      <InstancedBoxes transforms={baseboards} color={palette.trim} roughness={0.8} />
      <InstancedBoxes transforms={crown} color={palette.trim} roughness={0.8} />
      <InstancedBoxes transforms={windows} color={palette.glow} emissive={palette.glow} roughness={0.25} metalness={0.1} />
      <InstancedBoxes transforms={doorPanels.frame} color={doorInfo.frame} roughness={0.75} />
      <InstancedBoxes
        transforms={doorPanels.slab}
        color={doorInfo.color}
        emissive={doorInfo.emissive}
        roughness={0.7}
      />
      <InstancedBoxes transforms={stairSteps} color={palette.trim} roughness={0.82} />
      <InstancedBoxes transforms={railings} color={palette.trim} roughness={0.6} metalness={0.2} />
      {(Object.keys(FURNITURE_COLOR) as FurnitureKind[]).map((kind) => {
        const items = byKind.get(kind);
        if (!items || items.length === 0) return null;
        return (
          <InstancedBoxes
            key={kind}
            transforms={items}
            color={FURNITURE_COLOR[kind]}
            roughness={kind === 'lamp' ? 0.3 : 0.82}
            emissive={kind === 'lamp' ? '#fff0c0' : undefined}
          />
        );
      })}
    </group>
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

interface Footprint {
  cx: number;
  cz: number;
  width: number;
  depth: number;
}

function AnimalMesh({
  animal,
  groundY,
}: {
  animal: AnimalData;
  groundY: number;
}) {
  const { camera } = useThree();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Setup Audio Object
  useEffect(() => {
    if (!animal.soundDataUrl) return;
    const audio = new Audio(animal.soundDataUrl);
    audio.loop = true; // Enable native looping
    audioRef.current = audio;

    return () => {
      audio.pause();
      audioRef.current = null;
    };
  }, [animal.soundDataUrl]);

  // Handle continuous proximity volume updates and playback loop
  useFrame(() => {
    if (!audioRef.current) return;

    const dx = camera.position.x - animal.x;
    const dz = camera.position.z - animal.z;
    const distance = Math.hypot(dx, dz);

    const inRange = distance <= PROXIMITY_AUDIO_DISTANCE;

    if (inRange) {
      // Attenuate volume dynamically based on distance
      const volume = Math.max(0, 1 - distance / PROXIMITY_AUDIO_DISTANCE);
      audioRef.current.volume = volume;

      // Start looping if not already playing
      if (audioRef.current.paused) {
        audioRef.current.play().catch(() => {
          // Playback blocked if user hasn't interacted with page yet
        });
      }
    } else {
      // Pause playback when out of range
      if (!audioRef.current.paused) {
        audioRef.current.pause();
      }
    }
  });

  const { geometry, texture, height } = useMemo(() => {
    const rawOutline = decodeColorSketch(animal.outlineSketch);
    const patternColorGrid = decodeColorSketch(animal.patternSketch);

    const isPixelPainted = (grid: Uint8Array, idx: number) => {
      if (grid.length !== SKETCH_GRID * SKETCH_GRID * 4) return false;
      const r = grid[idx];
      const g = grid[idx + 1];
      const b = grid[idx + 2];
      const a = grid[idx + 3];
      return a > 50 && (r < 245 || g < 245 || b < 245);
    };

    // Extract average color from the outline sketch
    let outlineR = 255;
    let outlineG = 255;
    let outlineB = 255;
    let paintedCount = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;

    if (rawOutline.length === SKETCH_GRID * SKETCH_GRID * 4) {
      for (let i = 0; i < SKETCH_GRID * SKETCH_GRID * 4; i += 4) {
        if (isPixelPainted(rawOutline, i)) {
          sumR += rawOutline[i];
          sumG += rawOutline[i + 1];
          sumB += rawOutline[i + 2];
          paintedCount++;
        }
      }
      if (paintedCount > 0) {
        outlineR = Math.round(sumR / paintedCount);
        outlineG = Math.round(sumG / paintedCount);
        outlineB = Math.round(sumB / paintedCount);
      }
    }

    // 1. Build solid 3D mask combining both outline and pattern strokes
    const solidGrid = new Uint8Array(SKETCH_GRID * SKETCH_GRID);

    if (rawOutline.length === SKETCH_GRID * SKETCH_GRID * 4 || patternColorGrid.length === SKETCH_GRID * SKETCH_GRID * 4) {
      for (let i = 0; i < SKETCH_GRID * SKETCH_GRID; i++) {
        const idx = i * 4;
        if (isPixelPainted(rawOutline, idx) || isPixelPainted(patternColorGrid, idx)) {
          solidGrid[i] = 1;
        }
      }
    } else {
      // Legacy float outline fallback
      const legacyOutline = decodeSketch(animal.outlineSketch);
      for (let i = 0; i < legacyOutline.length; i++) {
        if (legacyOutline[i] > 0.15) solidGrid[i] = 1;
      }
    }

    const outside = new Uint8Array(SKETCH_GRID * SKETCH_GRID);
    const queue: number[] = [];

    const pushIfOutside = (x: number, y: number) => {
      if (x < 0 || x >= SKETCH_GRID || y < 0 || y >= SKETCH_GRID) return;
      const idx = y * SKETCH_GRID + x;
      if (!outside[idx] && !solidGrid[idx]) {
        outside[idx] = 1;
        queue.push(idx);
      }
    };

    // Flood fill background starting from outer perimeter
    for (let x = 0; x < SKETCH_GRID; x++) {
      pushIfOutside(x, 0);
      pushIfOutside(x, SKETCH_GRID - 1);
    }
    for (let y = 0; y < SKETCH_GRID; y++) {
      pushIfOutside(0, y);
      pushIfOutside(SKETCH_GRID - 1, y);
    }

    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const x = idx % SKETCH_GRID;
      const y = Math.floor(idx / SKETCH_GRID);
      pushIfOutside(x + 1, y);
      pushIfOutside(x - 1, y);
      pushIfOutside(x, y + 1);
      pushIfOutside(x, y - 1);
    }

    const isSolid = (x: number, y: number) => {
      if (x < 0 || x >= SKETCH_GRID || y < 0 || y >= SKETCH_GRID) return false;
      return !outside[y * SKETCH_GRID + x];
    };

    // 2. Construct solid 3D figure geometry
    const scale = 2.5;
    const depth = 0.6;
    const dx = scale / SKETCH_GRID;
    const dy = scale / SKETCH_GRID;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let vertCount = 0;

    const addQuad = (
      p0: [number, number, number],
      p1: [number, number, number],
      p2: [number, number, number],
      p3: [number, number, number],
      norm: [number, number, number],
      uv0: [number, number],
      uv1: [number, number],
      uv2: [number, number],
      uv3: [number, number],
    ) => {
      positions.push(...p0, ...p1, ...p2, ...p3);
      normals.push(...norm, ...norm, ...norm, ...norm);
      uvs.push(...uv0, ...uv1, ...uv2, ...uv3);

      indices.push(
        vertCount, vertCount + 1, vertCount + 2,
        vertCount, vertCount + 2, vertCount + 3,
      );
      vertCount += 4;
    };

    for (let y = 0; y < SKETCH_GRID; y++) {
      for (let x = 0; x < SKETCH_GRID; x++) {
        if (!isSolid(x, y)) continue;

        const x0 = (x / SKETCH_GRID - 0.5) * scale;
        const x1 = x0 + dx;
        const y1 = ((SKETCH_GRID - y) / SKETCH_GRID - 0.5) * scale;
        const y0 = y1 - dy;
        const z0 = -depth / 2;
        const z1 = depth / 2;

        const uMin = x / SKETCH_GRID;
        const uMax = (x + 1) / SKETCH_GRID;
        const vMin = 1 - (y + 1) / SKETCH_GRID;
        const vMax = 1 - y / SKETCH_GRID;

        // Front face (+Z)
        addQuad(
          [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
          [0, 0, 1],
          [uMin, vMin], [uMax, vMin], [uMax, vMax], [uMin, vMax],
        );

        // Back face (-Z)
        addQuad(
          [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0],
          [0, 0, -1],
          [uMax, vMin], [uMin, vMin], [uMin, vMax], [uMax, vMax],
        );

        // Left face (-X)
        if (!isSolid(x - 1, y)) {
          addQuad(
            [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0],
            [-1, 0, 0],
            [uMin, vMin], [uMin, vMin], [uMin, vMax], [uMin, vMax],
          );
        }

        // Right face (+X)
        if (!isSolid(x + 1, y)) {
          addQuad(
            [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1],
            [1, 0, 0],
            [uMax, vMin], [uMax, vMin], [uMax, vMax], [uMax, vMax],
          );
        }

        // Top face (+Y)
        if (!isSolid(x, y - 1)) {
          addQuad(
            [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0],
            [0, 1, 0],
            [uMin, vMax], [uMax, vMax], [uMax, vMax], [uMin, vMax],
          );
        }

        // Bottom face (-Y)
        if (!isSolid(x, y + 1)) {
          addQuad(
            [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
            [0, -1, 0],
            [uMin, vMin], [uMax, vMin], [uMax, vMin], [uMin, vMin],
          );
        }
      }
    }

    let geom: THREE.BufferGeometry;
    let meshHeight = 1.2;

    if (positions.length === 0) {
      geom = new THREE.BoxGeometry(1, 1, 1);
    } else {
      geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geom.setIndex(indices);
      geom.computeBoundingBox();
      if (geom.boundingBox) {
        meshHeight = geom.boundingBox.max.y - geom.boundingBox.min.y;
      }
      geom.center();
    }

    // 3. Composite canvas texture (Pattern over Outline over Base Outline Color)
    const canvas = document.createElement('canvas');
    canvas.width = SKETCH_GRID;
    canvas.height = SKETCH_GRID;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(SKETCH_GRID, SKETCH_GRID);

    for (let i = 0; i < SKETCH_GRID * SKETCH_GRID * 4; i += 4) {
      const pixelIdx = i / 4;
      const x = pixelIdx % SKETCH_GRID;
      const y = Math.floor(pixelIdx / SKETCH_GRID);

      const patternPainted = isPixelPainted(patternColorGrid, i);
      const outlinePainted = isPixelPainted(rawOutline, i);

      if (patternPainted) {
        imgData.data[i] = patternColorGrid[i];
        imgData.data[i + 1] = patternColorGrid[i + 1];
        imgData.data[i + 2] = patternColorGrid[i + 2];
        imgData.data[i + 3] = patternColorGrid[i + 3];
      } else if (outlinePainted) {
        imgData.data[i] = rawOutline[i];
        imgData.data[i + 1] = rawOutline[i + 1];
        imgData.data[i + 2] = rawOutline[i + 2];
        imgData.data[i + 3] = rawOutline[i + 3];
      } else {
        // Fill remaining solid body pixels with the extracted outline stroke color
        imgData.data[i] = outlineR;
        imgData.data[i + 1] = outlineG;
        imgData.data[i + 2] = outlineB;
        imgData.data[i + 3] = isSolid(x, y) ? 255 : 0;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(1, 1);
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;

    return { geometry: geom, texture: tex, height: meshHeight };
  }, [animal]);

  return (
    <mesh
      geometry={geometry}
      position={[animal.x, groundY + height / 2, animal.z]}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial map={texture} roughness={0.8} />
    </mesh>
  );
}

/**
 * How far the player's body pokes out past the camera point, in metres.
 * Kept tight (rather than a generous shoulder-width) because it's tested
 * against thin wall segments now, both outdoors (building walls) and
 * indoors (room walls) — anything bigger starts closing off doorway gaps.
 */
const WALL_CLEARANCE = 0.32;

function collidesAt(footprints: Footprint[], x: number, z: number, radius: number = WALL_CLEARANCE): boolean {
  for (const f of footprints) {
    const halfW = f.width / 2 + radius;
    const halfD = f.depth / 2 + radius;
    if (x > f.cx - halfW && x < f.cx + halfW && z > f.cz - halfD && z < f.cz + halfD) return true;
  }
  return false;
}

/** Interior wall segments are thin AABBs too — same collision test, different boxes. */
function wallBoxToFootprint(w: { cx: number; cz: number; halfW: number; halfD: number }): Footprint {
  return { cx: w.cx, cz: w.cz, width: w.halfW * 2, depth: w.halfD * 2 };
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

/* ------------------------------------------------------------- controls --- */

function Walker({
  built,
  footprints,
  buildingLayouts,
  getFloor,
  interior,
  onInteriorChange,
  channel,
  selfId,
  onOpenDraw,
  onOpenAnimalDraw,
  isModalOpen,
}: {
  built: { patch: Patch; terrain: TerrainData }[];
  footprints: Footprint[];
  buildingLayouts: { building: BuildingAsset; layout: BuildingLayout }[];
  getFloor: (
    building: BuildingAsset,
    layout: BuildingLayout,
    floor: number,
  ) => { floorplan: Floorplan; furniture: FurniturePiece[] };
  interior: ActiveInterior | null;
  onInteriorChange: (interior: ActiveInterior | null) => void;
  channel: React.RefObject<RealtimeChannel | null>;
  selfId: string;
  onOpenDraw: (x: number, z: number) => void;
  onOpenAnimalDraw: (x: number, z: number) => void;
  isModalOpen: boolean;
}) {
  const { camera } = useThree();
  const move = useRef({ f: false, b: false, l: false, r: false, sprint: false });
  const dir = useRef(new THREE.Vector3());
  const lastSend = useRef(0);
  const interiorRef = useRef(interior);
  interiorRef.current = interior;

  // Force the browser out of pointer lock whenever a draw modal opens, so
  // clicks land on the panel instead of re-locking the view.
  useEffect(() => {
    if (isModalOpen) document.exitPointerLock();
  }, [isModalOpen]);
  // Tracks progress through the stairwell as a straight-line walk rather
  // than an absolute position, so the same physical cell can be re-used to
  // climb any number of floors without ambiguity about which flight a given
  // (x, z) belongs to.
  const stairRef = useRef<{
    buildingId: string;
    enteredFloor: number;
    enteredZ: number;
    dir: 'ascend' | 'descend';
  } | null>(null);

  useEffect(() => {
    const set = (code: string, v: boolean) => {
      if (code === 'KeyW' || code === 'ArrowUp') move.current.f = v;
      if (code === 'KeyS' || code === 'ArrowDown') move.current.b = v;
      if (code === 'KeyA' || code === 'ArrowLeft') move.current.l = v;
      if (code === 'KeyD' || code === 'ArrowRight') move.current.r = v;
      if (code === 'ShiftLeft' || code === 'ShiftRight') move.current.sprint = v;
    };
    const down = (e: KeyboardEvent) => {
      if (isModalOpen) return;
      set(e.code, true);
      // Spawn ahead of the player, not underfoot — otherwise a newly
      // generated building's collision box (or animal mesh) traps you.
      const forwardSpawn = (distance: number): [number, number] => {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        forward.y = 0;
        if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
        else forward.normalize();
        return [camera.position.x + forward.x * distance, camera.position.z + forward.z * distance];
      };
      if (e.code === 'KeyE' && !interiorRef.current) {
        e.preventDefault();
        const [x, z] = forwardSpawn(SKETCH_SPAWN_DISTANCE);
        onOpenDraw(x, z);
      } else if (e.code === 'KeyR' && !interiorRef.current) {
        e.preventDefault();
        const [x, z] = forwardSpawn(SKETCH_SPAWN_DISTANCE);
        onOpenAnimalDraw(x, z);
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
  }, [camera, onOpenDraw, onOpenAnimalDraw, isModalOpen]);

  useFrame((_, delta) => {
    if (isModalOpen) return;
    const m = move.current;
    const speed = (m.sprint ? 40 : 16) * delta;
    const fwd = Number(m.b) - Number(m.f);
    const side = Number(m.r) - Number(m.l);
    dir.current.set(0, 0, 0);
    if (fwd || side) {
      // Use full camera quaternion then flatten Y: keeps movement stable even
      // when camera pitch changes.
      dir.current.set(side, 0, fwd).applyQuaternion(camera.quaternion);
      dir.current.y = 0;
      if (dir.current.lengthSq() > 0) dir.current.normalize().multiplyScalar(speed);
    }

    if (!interior) {
      /* ---------------- outdoors: terrain + building walls ---------------- */
      if (dir.current.lengthSq() > 0) {
        // Resolve against buildings axis-by-axis so sliding along a wall
        // feels natural instead of stopping dead on any glancing contact.
        // The only opening in any wall is the doorway, so this is also the
        // entire "how do you get inside" mechanic — no keypress involved.
        const nextX = camera.position.x + dir.current.x;
        const nextZ = camera.position.z + dir.current.z;
        if (!collidesAt(footprints, nextX, nextZ)) {
          camera.position.x = nextX;
          camera.position.z = nextZ;
        } else if (!collidesAt(footprints, nextX, camera.position.z)) {
          camera.position.x = nextX;
        } else if (!collidesAt(footprints, camera.position.x, nextZ)) {
          camera.position.z = nextZ;
        }
      }

      // Stick to whatever terrain is underfoot; lerped so a ridge is a fall.
      const ground = groundAt(built, camera.position.x, camera.position.z) + EYE;
      camera.position.y += (ground - camera.position.y) * Math.min(1, delta * 10);

      // Walked far enough through a doorway gap to be inside the shell —
      // drop straight into that building's interior, floor 0.
      for (const { building, layout } of buildingLayouts) {
        if (insideBuildingShell(layout, camera.position.x, camera.position.z)) {
          stairRef.current = null;
          camera.position.y = INTERIOR_Y_BASE + EYE;
          onInteriorChange({ buildingId: building.id, floor: 0 });
          break;
        }
      }

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
          seen: now,
        });
      }
      return;
    }

    /* -------------------------------- indoors -------------------------------- */
    const found = buildingLayouts.find((bl) => bl.building.id === interior.buildingId);
    if (!found) {
      onInteriorChange(null);
      return;
    }
    const { building, layout } = found;
    const { floorplan } = getFloor(building, layout, interior.floor);

    let lx = camera.position.x - layout.cx;
    let lz = camera.position.z - layout.cz;

    if (dir.current.lengthSq() > 0) {
      const wallFootprints = floorplan.walls.map(wallBoxToFootprint);
      const nextLX = lx + dir.current.x;
      const nextLZ = lz + dir.current.z;
      if (!collidesAt(wallFootprints, nextLX, nextLZ)) {
        lx = nextLX;
        lz = nextLZ;
      } else if (!collidesAt(wallFootprints, nextLX, lz)) {
        lx = nextLX;
      } else if (!collidesAt(wallFootprints, lx, nextLZ)) {
        lz = nextLZ;
      }
    }

    // Ground floor's front wall has the same doorway gap outdoors and in —
    // walking back through it (past the wall line) leaves the building the
    // same way you came in, no keypress needed.
    if (interior.floor === 0 && (Math.abs(lx) > floorplan.halfW || Math.abs(lz) > floorplan.halfD)) {
      camera.position.x = layout.cx + lx;
      camera.position.z = layout.cz + lz;
      camera.position.y = groundAt(built, camera.position.x, camera.position.z) + EYE;
      stairRef.current = null;
      onInteriorChange(null);
      return;
    }
    // Upper floors have no door to the outside — a wall-lined safety net so
    // a stairwell edge case can't drift a player into the void.
    lx = clamp(lx, -floorplan.halfW - 2.5, floorplan.halfW + 2.5);
    lz = clamp(lz, -floorplan.halfD - 2.5, floorplan.halfD + 2.5);

    const floorBase = INTERIOR_Y_BASE + interior.floor * INTERIOR_FLOOR_H;
    let worldGroundY = floorBase;

    const stair = floorplan.stair;
    if (stair && Math.abs(lx - stair.cx) < stair.halfW && Math.abs(lz - stair.cz) < stair.halfD) {
      if (!stairRef.current || stairRef.current.buildingId !== building.id) {
        stairRef.current = {
          buildingId: building.id,
          enteredFloor: interior.floor,
          enteredZ: lz,
          dir: lz >= stair.cz ? 'ascend' : 'descend',
        };
      }
      const s = stairRef.current;
      const runLength = Math.max(0.5, stair.halfD * 2);
      if (s.dir === 'ascend' && stair.up) {
        const t = clamp((s.enteredZ - lz) / runLength, 0, 1);
        worldGroundY = INTERIOR_Y_BASE + s.enteredFloor * INTERIOR_FLOOR_H + t * INTERIOR_FLOOR_H;
        if (t >= 0.999 && interior.floor === s.enteredFloor) {
          onInteriorChange({ buildingId: building.id, floor: s.enteredFloor + 1 });
        }
      } else if (s.dir === 'descend' && stair.down) {
        const t = clamp((lz - s.enteredZ) / runLength, 0, 1);
        worldGroundY = INTERIOR_Y_BASE + s.enteredFloor * INTERIOR_FLOOR_H - t * INTERIOR_FLOOR_H;
        if (t >= 0.999 && interior.floor === s.enteredFloor) {
          onInteriorChange({ buildingId: building.id, floor: s.enteredFloor - 1 });
        }
      }
    } else {
      stairRef.current = null;
    }

    camera.position.x = layout.cx + lx;
    camera.position.z = layout.cz + lz;
    camera.position.y += (worldGroundY + EYE - camera.position.y) * Math.min(1, delta * 10);

    const now = performance.now();
    const ch = channel.current;
    if (ch && now - lastSend.current > BROADCAST_MS) {
      lastSend.current = now;
      sendMove(ch, {
        id: selfId,
        x: lx,
        y: worldGroundY - floorBase,
        z: lz,
        a: camera.rotation.y,
        color: colorForId(selfId),
        seen: now,
        interiorId: building.id,
        floor: interior.floor,
      });
    }
  });

  // Fully unmount while drawing so a stray pointer/keyboard event can't
  // re-trigger a lock underneath the modal.
  if (isModalOpen) return null;
  return <PointerLockControls />;
}

/* ----------------------------------------------------------------- page --- */

export default function World() {
  const [patches, setPatches] = useState<Patch[]>([]);
  const [buildings, setBuildings] = useState<BuildingAsset[]>([]);
  const [animals, setAnimals] = useState<AnimalData[]>([]);
  const [travellers, setTravellers] = useState<Traveller[]>([]);
  const [drawAt, setDrawAt] = useState<{ x: number; z: number } | null>(null);
  const [animalDrawAt, setAnimalDrawAt] = useState<{ x: number; z: number } | null>(null);
  const [interior, setInterior] = useState<ActiveInterior | null>(null);
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
  const buildingLayouts = useMemo(
    () => buildings.map((building) => ({ building, layout: buildingLayout(building, built) })),
    [buildings, built],
  );
  const buildingFootprints = useMemo(
    () => buildingLayouts.flatMap(({ layout }) => exteriorWallFootprints(layout)),
    [buildingLayouts],
  );

  // Floorplans/furniture are pure functions of (building id, floor), so once
  // generated they're cached forever rather than regenerated on every visit.
  const interiorCache = useRef<Map<string, Map<number, { floorplan: Floorplan; furniture: FurniturePiece[] }>>>(
    new Map(),
  );
  const getFloor = useCallback(
    (building: BuildingAsset, layout: BuildingLayout, floor: number) => {
      let byFloor = interiorCache.current.get(building.id);
      if (!byFloor) {
        byFloor = new Map();
        interiorCache.current.set(building.id, byFloor);
      }
      let entry = byFloor.get(floor);
      if (!entry) {
        const floorplan = generateFloorplan(specFor(building, layout), floor);
        const furniture = generateFurniture(floorplan, layout.style, building.id);
        entry = { floorplan, furniture };
        byFloor.set(floor, entry);
      }
      return entry;
    },
    [],
  );
  const activeInterior = useMemo(() => {
    if (!interior) return null;
    const found = buildingLayouts.find((bl) => bl.building.id === interior.buildingId);
    if (!found) return null;
    const { floorplan, furniture } = getFloor(found.building, found.layout, interior.floor);
    return { building: found.building, layout: found.layout, floorplan, furniture };
  }, [interior, buildingLayouts, getFloor]);

  /* -------- load + realtime -------- */
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    const toPatch = (r: Record<string, unknown>): Patch | null => {
      if (r.type !== 'terrain') return null;
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
    const toBuilding = (r: Record<string, unknown>): BuildingAsset | null => {
      if (r.type !== 'building') return null;
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const width = Number(props.width);
      const depth = Number(props.depth);
      const height = Number(props.height);
      if (!Number.isFinite(width) || !Number.isFinite(depth) || !Number.isFinite(height)) return null;
      const inferredNormW = Number.isFinite(width) ? clamp(width / PATCH_SCALE, 0.05, 1) : 0.2;
      const inferredNormH = Number.isFinite(height) ? clamp(height / PATCH_SCALE, 0.05, 1) : 0.2;
      return {
        id: String(r.id),
        x: Number(r.x) || 0,
        z: Number(r.z) || 0,
        width,
        depth,
        height,
        coverage: Number(props.coverage) || 0,
        meanInk: Number(props.meanInk) || 0,
        normWidth: Number(props.normWidth) || inferredNormW,
        normHeight: Number(props.normHeight) || inferredNormH,
      };
    };
    const toAnimal = (r: Record<string, unknown>): AnimalData | null => {
      if (r.type !== 'animal') return null;
      const props = (r.properties ?? {}) as Record<string, unknown>;
      if (typeof props.outlineSketch !== 'string' || typeof props.patternSketch !== 'string') return null;
      return {
        id: String(r.id),
        x: Number(r.x) || 0,
        z: Number(r.z) || 0,
        outlineSketch: props.outlineSketch,
        patternSketch: props.patternSketch,
        soundDataUrl: typeof props.soundDataUrl === 'string' ? props.soundDataUrl : null,
      };
    };

    supabase
      .from('world_assets')
      .select('*')
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
        setBuildings((prev) => {
          const byId = new Map(prev.map((b) => [b.id, b]));
          for (const row of data) {
            const b = toBuilding(row as Record<string, unknown>);
            if (b) byId.set(b.id, b);
          }
          return [...byId.values()];
        });
        setAnimals((prev) => {
          const byId = new Map(prev.map((a) => [a.id, a]));
          for (const row of data) {
            const a = toAnimal(row as Record<string, unknown>);
            if (a) byId.set(a.id, a);
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
          const row = payload.new as Record<string, unknown>;
          const p = toPatch(row);
          if (p) {
            setPatches((prev) => (prev.some((q) => q.id === p.id) ? prev : [...prev, p]));
          }
          const b = toBuilding(row);
          if (b) {
            setBuildings((prev) => (prev.some((q) => q.id === b.id) ? prev : [...prev, b]));
          }
          const a = toAnimal(row);
          if (a) {
            setAnimals((prev) => (prev.some((q) => q.id === a.id) ? prev : [...prev, a]));
          }
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
  const commit = useCallback((draft: DrawCommit, x: number, z: number) => {
    if (draft.kind === 'terrain') {
      const sketch = encodeSketch(draft.grid);
      const seed = Math.floor(Math.random() * 1e9);
      const tempId = `temp-terrain-${seed}`;

      // Optimistic: the terrain is under your feet immediately, and the write
      // reconciles behind it.
      setPatches((prev) => [...prev, { id: tempId, x, z, sketch, seed }]);
      setDrawAt(null);

      if (!supabase) return;

      supabase
        .from('world_assets')
        .insert({ x, z, type: 'terrain', color: '#8fa8c8', properties: { sketch, seed } })
        .select()
        .then(({ data, error }) => {
          setPatches((prev) => {
            const without = prev.filter((p) => p.id !== tempId);
            if (error || !data?.length) return without; // roll back on failure
            const row = data[0] as Record<string, unknown>;
            const id = String(row.id);
            cache.current.set(id, cache.current.get(tempId) ?? terrainFor({ id, x, z, sketch, seed }));
            cache.current.delete(tempId);
            return without.some((p) => p.id === id)
              ? without
              : [...without, { id, x, z, sketch, seed }];
          });
        });
      return;
    }

    const seed = Math.floor(Math.random() * 1e9);
    const tempId = `temp-building-${seed}`;
    const optimistic: BuildingAsset = {
      id: tempId,
      x,
      z,
      width: draft.building.width,
      depth: draft.building.depth,
      height: draft.building.height,
      coverage: draft.building.coverage,
      meanInk: draft.building.meanInk,
      normWidth: draft.building.normWidth,
      normHeight: draft.building.normHeight,
    };
    setBuildings((prev) => [...prev, optimistic]);
    setDrawAt(null);

    if (!supabase) return;

    supabase
      .from('world_assets')
      .insert({
        x,
        z,
        type: 'building',
        color: '#7f8ea8',
        properties: {
          schemaVersion: 1,
          width: draft.building.width,
          depth: draft.building.depth,
          height: draft.building.height,
          coverage: draft.building.coverage,
          meanInk: draft.building.meanInk,
          normWidth: draft.building.normWidth,
          normHeight: draft.building.normHeight,
        },
      })
      .select()
      .then(({ data, error }) => {
        setBuildings((prev) => {
          const without = prev.filter((b) => b.id !== tempId);
          if (error || !data?.length) return without;
          const row = data[0] as Record<string, unknown>;
          const props = (row.properties ?? {}) as Record<string, unknown>;
          const saved: BuildingAsset = {
            id: String(row.id),
            x: Number(row.x) || x,
            z: Number(row.z) || z,
            width: Number(props.width) || optimistic.width,
            depth: Number(props.depth) || optimistic.depth,
            height: Number(props.height) || optimistic.height,
            coverage: Number(props.coverage) || optimistic.coverage,
            meanInk: Number(props.meanInk) || optimistic.meanInk,
            normWidth: Number(props.normWidth) || optimistic.normWidth,
            normHeight: Number(props.normHeight) || optimistic.normHeight,
          };
          return without.some((b) => b.id === saved.id) ? without : [...without, saved];
        });
      });
  }, []);

  /* -------- contribute animal -------- */
  const commitAnimal = useCallback(
    (
      outlineGrid: Uint8Array,
      patternGrid: Uint8Array,
      soundDataUrl: string | null,
      x: number,
      z: number,
    ) => {
      const outlineSketch = encodeColorSketch(outlineGrid);
      const patternSketch = encodeColorSketch(patternGrid);
      const tempId = `temp-animal-${Math.random() * 1e9}`;

      setAnimals((prev) => [...prev, { id: tempId, x, z, outlineSketch, patternSketch, soundDataUrl }]);
      setAnimalDrawAt(null);

      if (!supabase) return;

      supabase
        .from('world_assets')
        .insert({ x, z, type: 'animal', properties: { outlineSketch, patternSketch, soundDataUrl } })
        .select()
        .then(({ data, error }) => {
          setAnimals((prev) => {
            const without = prev.filter((a) => a.id !== tempId);
            if (error || !data?.length) return without;
            const row = data[0] as Record<string, unknown>;
            const id = String(row.id);
            return without.some((a) => a.id === id)
              ? without
              : [...without, { id, x, z, outlineSketch, patternSketch, soundDataUrl }];
          });
        });
    },
    [],
  );

  const label =
    status === 'live'
      ? `${travellers.length} traveller${travellers.length === 1 ? '' : 's'} nearby`
      : status === 'connecting'
        ? 'connecting…'
        : 'offline — solo world';

  const isModalOpen = drawAt !== null || animalDrawAt !== null;

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
        <BuildingKit layouts={buildingLayouts} />

        {animals.map((a) => (
          <AnimalMesh key={a.id} animal={a} groundY={groundAt(built, a.x, a.z)} />
        ))}
        {activeInterior && (
          <InteriorScene
            building={activeInterior.building}
            layout={activeInterior.layout}
            floor={interior!.floor}
            floorplan={activeInterior.floorplan}
            furniture={activeInterior.furniture}
            style={activeInterior.layout.style}
          />
        )}

        {travellers
          .filter((t) => !t.interiorId || (interior !== null && t.interiorId === interior.buildingId && t.floor === interior.floor))
          .map((t) => {
            if (!t.interiorId) return <Wisp key={t.id} traveller={t} />;
            const found = buildingLayouts.find((bl) => bl.building.id === t.interiorId);
            if (!found) return null;
            const origin = interiorOrigin(found.layout, t.floor ?? 0);
            const placed: Traveller = { ...t, x: origin[0] + t.x, y: origin[1] + t.y, z: origin[2] + t.z };
            return <Wisp key={t.id} traveller={placed} />;
          })}

        <Walker
          built={built}
          footprints={buildingFootprints}
          buildingLayouts={buildingLayouts}
          getFloor={getFloor}
          interior={interior}
          onInteriorChange={setInterior}
          channel={channelRef}
          selfId={selfId}
          onOpenDraw={(x, z) => setDrawAt({ x, z })}
          onOpenAnimalDraw={(x, z) => setAnimalDrawAt({ x, z })}
          isModalOpen={isModalOpen}
        />
      </Canvas>

      <div className="pointer-events-none absolute left-6 top-6 rounded-lg bg-black/50 p-4 backdrop-blur">
        <h1 className="text-lg font-semibold text-white">Infinite Terra</h1>
        <p className="mt-1 text-sm text-white/70">
          {patches.length} landform{patches.length === 1 ? '' : 's'} · {buildings.length}{' '}
          building{buildings.length === 1 ? '' : 's'} · {animals.length} animal{animals.length === 1 ? '' : 's'} ·{' '}
          {label}
        </p>
      </div>

      <div className="pointer-events-none absolute bottom-6 left-6 space-y-1 text-xs text-white/55">
        <p>
          <span className="text-white/85">Click</span> to look ·{' '}
          <span className="text-white/85">WASD</span> to walk ·{' '}
          <span className="text-white/85">Shift</span> to run
        </p>
        {interior ? (
          <p>Floor {interior.floor + 1} — find the stairwell to change floors, or walk back out the door</p>
        ) : (
          <p>
            <span className="text-white/85">E</span> to sketch terrain/buildings here · walk through a door to step
            inside · <span className="text-white/85">R</span> to create an animal ·{' '}
            <span className="text-white/85">Esc</span> to release
          </p>
        )}
      </div>

      {drawAt && (
        <DrawPanel
          onCancel={() => setDrawAt(null)}
          onCommit={(draft) => commit(draft, drawAt.x, drawAt.z)}
        />
      )}

      {animalDrawAt && (
        <AnimalDrawPanel
          onCancel={() => setAnimalDrawAt(null)}
          onCommit={(outlineGrid, patternGrid, soundDataUrl) =>
            commitAnimal(outlineGrid, patternGrid, soundDataUrl, animalDrawAt.x, animalDrawAt.z)
          }
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ draw panel --- */

function DrawPanel({
  onCommit,
  onCancel,
}: {
  onCommit: (draft: DrawCommit) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [mode, setMode] = useState<'terrain' | 'building'>('terrain');
  const [error, setError] = useState<string | null>(null);

  const clear = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 512, 512);
    setError(null);
  }, []);

  useEffect(() => {
    clear();
  }, [clear]);

  const paint = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * c.width;
    const y = ((e.clientY - r.top) / r.height) * c.height;

    if (mode === 'terrain') {
      // Soft wide brush: gradients give the heightmap slopes to work with,
      // where a hard 1px pen produces a wall.
      const g = ctx.createRadialGradient(x, y, 0, x, y, 28);
      g.addColorStop(0, 'rgba(0,0,0,0.9)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 28, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // Building mode uses a tighter brush so silhouette proportions stay true.
    ctx.fillStyle = 'rgba(0,0,0,0.96)';
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
  }, [mode]);

  const submit = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    setError(null);

    if (mode === 'terrain') {
      // Downsample straight to the stored grid.
      const grid = new Float32Array(SKETCH_GRID * SKETCH_GRID);
      const step = c.width / SKETCH_GRID;
      for (let gy = 0; gy < SKETCH_GRID; gy++) {
        for (let gx = 0; gx < SKETCH_GRID; gx++) {
          let acc = 0;
          let n = 0;
          for (let y = Math.floor(gy * step); y < Math.floor((gy + 1) * step); y++) {
            for (let x = Math.floor(gx * step); x < Math.floor((gx + 1) * step); x++) {
              const i = (y * c.width + x) * 4;
              const lum =
                (0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]) /
                255;
              acc += 1 - lum; // dark ink = high ground
              n++;
            }
          }
          grid[gy * SKETCH_GRID + gx] = n ? acc / n : 0;
        }
      }
      onCommit({ kind: 'terrain', grid });
      return;
    }

    const building = buildingFromImageData(img.data, c.width, c.height, PATCH_SCALE);
    if (!building) {
      setError('Draw a darker, larger silhouette first.');
      return;
    }
    onCommit({ kind: 'building', building });
  }, [mode, onCommit]);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-neutral-900 p-6">
        <h2 className="text-lg font-semibold text-white">
          {mode === 'terrain' ? 'Raise mountains here' : 'Place a generated building'}
        </h2>
        <p className="mt-1 text-sm text-white/60">
          {mode === 'terrain'
            ? 'Draw a ridgeline — darker and thicker means higher ground.'
            : 'Draw a front-view building silhouette. Sketch width drives width; sketch height drives building height.'}
        </p>

        <div className="mt-3 flex rounded-lg border border-white/10 bg-black/20 p-1 text-sm">
          <button
            onClick={() => {
              setMode('terrain');
              setError(null);
            }}
            className={`rounded-md px-3 py-1.5 transition ${
              mode === 'terrain' ? 'bg-emerald-500 text-neutral-950' : 'text-white/75 hover:bg-white/10'
            }`}
          >
            Terrain
          </button>
          <button
            onClick={() => {
              setMode('building');
              setError(null);
            }}
            className={`rounded-md px-3 py-1.5 transition ${
              mode === 'building' ? 'bg-emerald-500 text-neutral-950' : 'text-white/75 hover:bg-white/10'
            }`}
          >
            Building
          </button>
        </div>

        <canvas
          ref={canvasRef}
          width={512}
          height={512}
          onPointerDown={(e) => {
            drawing.current = true;
            paint(e);
          }}
          onPointerMove={paint}
          onPointerUp={() => (drawing.current = false)}
          onPointerLeave={() => (drawing.current = false)}
          className="mt-4 aspect-square w-full cursor-crosshair touch-none rounded-lg bg-white"
        />

        <div className="mt-4 flex justify-end gap-3">
          <button
            onClick={clear}
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/80 hover:bg-white/10"
          >
            Clear
          </button>
          <button
            onClick={onCancel}
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/80 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="rounded-md bg-emerald-500 px-5 py-2 text-sm font-medium text-neutral-950 hover:bg-emerald-400"
          >
            {mode === 'terrain' ? 'Raise it' : 'Build it'}
          </button>
        </div>
        {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------- animal draw panel --- */

export function AnimalDrawPanel({
  onCommit,
  onCancel,
}: {
  onCommit: (
    outlineGrid: Uint8Array,
    patternGrid: Uint8Array,
    soundDataUrl: string | null,
  ) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<'outline' | 'pattern' | 'sound'>('outline');
  const [outlineGrid, setOutlineGrid] = useState<Uint8Array | null>(null);
  const [patternGrid, setPatternGrid] = useState<Uint8Array | null>(null);

  // Audio recording states
  const [isRecording, setIsRecording] = useState(false);
  const [timeLeft, setTimeLeft] = useState(5);
  const [soundDataUrl, setSoundDataUrl] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  const [color, setColor] = useState('#000000');
  const [markerSize, setMarkerSize] = useState(14);

  // Initialize canvas background to white on mount only
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 512, 512);
  }, []); // Keep empty array so step transition doesn't wipe canvas

  const getCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * c.width,
      y: ((e.clientY - r.top) / r.height) * c.height,
    };
  };

  const drawLine = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;

      ctx.strokeStyle = color;
      ctx.lineWidth = markerSize;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    },
    [color, markerSize]
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = true;
    const pos = getCanvasCoords(e);
    if (!pos) return;
    lastPos.current = pos;

    drawLine(pos, pos);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const pos = getCanvasCoords(e);
    if (!pos || !lastPos.current) return;

    drawLine(lastPos.current, pos);
    lastPos.current = pos;
  };

  const stopDrawing = () => {
    drawing.current = false;
    lastPos.current = null;
  };

  const captureColorGrid = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return new Uint8Array(SKETCH_GRID * SKETCH_GRID * 4);

    const img = ctx.getImageData(0, 0, c.width, c.height);
    const colorGrid = new Uint8Array(SKETCH_GRID * SKETCH_GRID * 4);
    const pixelStep = c.width / SKETCH_GRID;

    for (let gy = 0; gy < SKETCH_GRID; gy++) {
      for (let gx = 0; gx < SKETCH_GRID; gx++) {
        let rAcc = 0;
        let gAcc = 0;
        let bAcc = 0;
        let aAcc = 0;
        let count = 0;

        for (let y = Math.floor(gy * pixelStep); y < Math.floor((gy + 1) * pixelStep); y++) {
          for (let x = Math.floor(gx * pixelStep); x < Math.floor((gx + 1) * pixelStep); x++) {
            const i = (y * c.width + x) * 4;
            rAcc += img.data[i];
            gAcc += img.data[i + 1];
            bAcc += img.data[i + 2];
            aAcc += img.data[i + 3];
            count++;
          }
        }

        const outIdx = (gy * SKETCH_GRID + gx) * 4;
        colorGrid[outIdx] = count ? Math.round(rAcc / count) : 255;
        colorGrid[outIdx + 1] = count ? Math.round(gAcc / count) : 255;
        colorGrid[outIdx + 2] = count ? Math.round(bAcc / count) : 255;
        colorGrid[outIdx + 3] = count ? Math.round(aAcc / count) : 255;
      }
    }

    return colorGrid;
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = () => {
          setSoundDataUrl(reader.result as string);
        };
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setTimeLeft(5);

      timerRef.current = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            stopRecording();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err) {
      console.error('Microphone access error:', err);
    }
  };

  const stopRecording = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onloadend = () => {
      setSoundDataUrl(reader.result as string);
    };
  };

  const handleNextToPattern = () => {
    const grid = captureColorGrid();
    setOutlineGrid(grid);
    setStep('pattern');
    setMarkerSize(20);
  };

  const handleNextToSound = () => {
    const grid = captureColorGrid();
    setPatternGrid(grid);
    setStep('sound');
  };

  const handleDone = () => {
    if (!outlineGrid || !patternGrid) return;
    onCommit(outlineGrid, patternGrid, soundDataUrl);
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-neutral-900 p-6">
        <h2 className="text-lg font-semibold text-white">
          {step === 'outline' && '1. Draw Animal Outline'}
          {step === 'pattern' && '2. Draw Animal Pattern'}
          {step === 'sound' && '3. Add Animal Sound'}
        </h2>
        <p className="mt-1 text-sm text-white/60">
          {step === 'outline' && 'Sketch the profile silhouette of your creature.'}
          {step === 'pattern' && 'Paint spots, stripes, or skin details onto the form.'}
          {step === 'sound' && 'Record a 5-second sound or upload an audio file for your animal.'}
        </p>

        {step !== 'sound' && (
          <>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
          <div className="flex flex-wrap gap-1.5">
            {COLOR_PALETTE.map((c) => (
              <button
                key={c.value}
                onClick={() => setColor(c.value)}
                title={c.name}
                className={`h-6 w-6 rounded-full border transition-transform ${
                  color === c.value
                    ? 'scale-110 border-white ring-2 ring-white/50'
                    : 'border-transparent hover:scale-105'
                }`}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>

          <div className="flex items-center gap-1">
            {MARKER_SIZES.map((s) => (
              <button
                key={s.label}
                onClick={() => setMarkerSize(s.size)}
                className={`h-7 w-7 rounded-md text-xs font-semibold ${
                  markerSize === s.size
                    ? 'bg-white text-black'
                    : 'bg-white/10 text-white/70 hover:bg-white/20'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <canvas
          ref={canvasRef}
          width={512}
          height={512}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDrawing}
          onPointerLeave={stopDrawing}
          className="mt-3 aspect-square w-full cursor-crosshair touch-none rounded-lg bg-white"
        />
          </>
        )}

        {step === 'sound' && (
          <div className="mt-6 flex flex-col items-center justify-center space-y-4 rounded-lg border border-white/10 bg-black/40 p-8">
            {isRecording ? (
              <div className="text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-500/20 text-red-500 animate-pulse">
                  🎙️
                </div>
                <p className="mt-3 text-lg font-bold text-red-400">Recording... {timeLeft}s</p>
              </div>
            ) : soundDataUrl ? (
              <div className="w-full text-center space-y-3">
                <p className="text-sm text-emerald-400 font-medium">✓ Sound added successfully!</p>
                <audio src={soundDataUrl} controls className="w-full" />
                <button
                  onClick={() => setSoundDataUrl(null)}
                  className="text-xs text-white/60 hover:text-white underline"
                >
                  Remove sound / Choose another
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 w-full">
                <div className="flex items-center gap-6">
                  <div className="flex flex-col items-center">
                <button
                  onClick={startRecording}
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-500 text-2xl text-neutral-950 transition-transform hover:scale-105"
                >
                  🎙️
                </button>
                    <span className="mt-2 text-xs text-white/70">Record 5s</span>
                  </div>

                  <div className="text-xs text-white/40 font-medium">OR</div>

                  <div className="flex flex-col items-center">
                    <label className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-full bg-blue-600 text-2xl text-white transition-transform hover:scale-105">
                      📁
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </label>
                    <span className="mt-2 text-xs text-white/70">Upload Audio File</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/80 hover:bg-white/10"
          >
            Cancel
          </button>

          {step === 'outline' && (
            <button
              onClick={handleNextToPattern}
              className="rounded-md bg-amber-500 px-5 py-2 text-sm font-medium text-neutral-950 hover:bg-amber-400"
            >
              Next: Pattern
            </button>
          )}

          {step === 'pattern' && (
            <button
              onClick={handleNextToSound}
              className="rounded-md bg-amber-500 px-5 py-2 text-sm font-medium text-neutral-950 hover:bg-amber-400"
            >
              Next: Sound
            </button>
          )}

          {step === 'sound' && (
            <button
              onClick={handleDone}
              disabled={isRecording}
              className={`rounded-md px-5 py-2 text-sm font-medium text-neutral-950 ${
                isRecording
                  ? 'bg-neutral-600 cursor-not-allowed'
                  : 'bg-emerald-500 hover:bg-emerald-400'
              }`}
            >
              Done & Spawn
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
