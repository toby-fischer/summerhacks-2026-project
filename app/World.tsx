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
import Link from 'next/link';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls } from '@react-three/drei';
import { createClient } from '@supabase/supabase-js';
import type { RealtimeChannel } from '@supabase/supabase-js';
import * as THREE from 'three';

import {
  buildingFromImageData,
  classifyBuildingType,
  CULTURE_STYLES,
  MAX_FLOOR_BANDS,
  type BuildingData,
  type BuildingType,
  type CultureStyle,
} from './building';
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
import {
  normalizeCondition,
  type WeatherAsset,
} from './weather';
import { Weather, type Atmosphere } from './world/weather';
import { Minimap, type MinimapSelf } from './world/Minimap';
import type { Contribution, WeatherPayload } from './world/contract';
import {
  createVegetationPatches,
  VegetationLayer,
  VegetationPanel,
  type VegetationPatch,
} from './vegetation';

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

/** Stable empty list, so going indoors doesn't hand Weather a new array every
 *  render and defeat its memoisation. */
const EMPTY_ZONES: Contribution<WeatherPayload>[] = [];
const PROXIMITY_AUDIO_DISTANCE = 50; // Max distance in meters to hear animal
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
  path?: { x: number; z: number }[] | null;
  speed?: number; // Add this line
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
  roofFrac: number;
  floorProfile: { widthFrac: number; offsetFrac: number }[];
}

const FLAT_FLOOR_PROFILE: { widthFrac: number; offsetFrac: number }[] = Array.from(
  { length: MAX_FLOOR_BANDS },
  () => ({ widthFrac: 1, offsetFrac: 0 }),
);

function sanitizeFloorProfile(v: unknown): { widthFrac: number; offsetFrac: number }[] {
  if (!Array.isArray(v) || v.length === 0) return FLAT_FLOOR_PROFILE;
  const out = v.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const widthFrac = Number(e.widthFrac);
    const offsetFrac = Number(e.offsetFrac);
    return {
      widthFrac: Number.isFinite(widthFrac) ? clamp(widthFrac, 0.4, 1.2) : 1,
      offsetFrac: Number.isFinite(offsetFrac) ? clamp(offsetFrac, -0.4, 0.4) : 0,
    };
  });
  while (out.length < MAX_FLOOR_BANDS) out.push({ widthFrac: 1, offsetFrac: 0 });
  return out;
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

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
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
      terrain.heights[i] = h;

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
): { center: number; nw: number; ne: number; sw: number; se: number; frontMid: number } {
  const halfW = width / 2;
  const halfD = depth / 2;
  return {
    center: groundAt(built, cx, cz),
    nw: groundAt(built, cx - halfW, cz + halfD),
    ne: groundAt(built, cx + halfW, cz + halfD),
    sw: groundAt(built, cx - halfW, cz - halfD),
    se: groundAt(built, cx + halfW, cz - halfD),
    // The door sits at (cx, cz + halfD) — sampled directly so the threshold
    // always lines up with the ground right in front of it, not just the
    // footprint's corners.
    frontMid: groundAt(built, cx, cz + halfD),
  };
}

type PartKind = 'foundation' | 'wall' | 'trim' | 'roof' | 'window' | 'door' | 'accent' | 'awning' | 'porch' | 'balcony';
interface PartTransform {
  kind: PartKind;
  style: 0 | 1 | 2;
  culture: CultureStyle;
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
/** Enterable garage bay carved into a side wall — house type only. */
interface GarageBay {
  side: 'west' | 'east';
  /** Offset from the building center along z, in world units. */
  centerZ: number;
  halfW: number;
  doorH: number;
}

interface BuildingLayout {
  cx: number;
  cz: number;
  width: number;
  depth: number;
  floors: number;
  floorH: number;
  bodyH: number;
  style: 0 | 1 | 2;
  cultureStyle: CultureStyle;
  buildingType: BuildingType;
  garage: GarageBay | null;
  doorW: number;
  doorH: number;
  floorY: number;
  profile: { center: number; nw: number; ne: number; sw: number; se: number; frontMid: number };
  /**
   * Per-floor width and horizontal center offset (world units), index 0 =
   * ground floor. Ground floor always equals `width`/offset 0 — collision,
   * the door, the garage, and terrain flattening all key off that and must
   * stay put. Floors above it taper/shift to follow the sketch's silhouette
   * (see floorProfile on BuildingAsset), so a tapering or lopsided drawing
   * actually shows up as a stepped/offset building instead of a plain box.
   */
  floorWidths: number[];
  floorOffsetX: number[];
}

/** Deterministic per-building cultural/architectural flavor (roof grammar + palette). */
function hashCultureStyle(id: string): CultureStyle {
  const idx = Math.floor(hash01(id, 401) * CULTURE_STYLES.length) % CULTURE_STYLES.length;
  return CULTURE_STYLES[idx];
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
  const cultureStyle = hashCultureStyle(building.id);
  const buildingType = classifyBuildingType(floors, width, depth, building.coverage, building.roofFrac);
  const profile = sampleFootprintGround(built, cx, cz, width, depth);
  // Floor height is pinned to the *front* edge (the door side, nw/ne/frontMid)
  // rather than the highest corner overall. Basing it on the highest corner
  // anywhere on the footprint (including the back) meant a building whose
  // back happened to touch higher ground — a hillside behind it — got
  // lifted along with that corner, stranding the entrance above the actual
  // ground in front of it, unreachable on foot. The back can instead sit
  // partly embedded into a rising slope; the walk-up to the door matters
  // more than the back wall's exact grade.
  const floorY = Math.max(profile.nw, profile.ne, profile.frontMid);
  const doorW = Math.min(style === 2 ? 2.1 : 1.7, width * (style === 1 ? 0.18 : 0.24));
  const doorH = Math.min(style === 1 ? 2.6 : 2.3, floorH * (style === 1 ? 0.94 : 0.86));

  let garage: GarageBay | null = null;
  const baysXCount = Math.round(width / 1.8);
  if (buildingType === 'house' && baysXCount >= 4 && hash01(building.id, 301) > 0.4) {
    const side: 'west' | 'east' = hash01(building.id, 302) > 0.5 ? 'east' : 'west';
    const halfWGarage = Math.min(1.6, width * 0.16);
    const halfD = depth / 2;
    const centerZ = clamp(
      halfD - halfWGarage - 0.6,
      -halfD + halfWGarage + 0.3,
      halfD - halfWGarage - 0.3,
    );
    garage = { side, centerZ, halfW: halfWGarage, doorH: Math.min(2.1, floorH * 0.82) };
  }

  // Map the sketch's bottom-to-top band profile onto this building's actual
  // floor count. Ground floor is pinned to the bay-quantized footprint
  // (garage/door/collision/terrain all depend on it); floors above sample
  // the profile and taper/shift relative to it, clamped so they never drift
  // far enough to look structurally implausible or poke outside the plinth.
  const profileBands = building.floorProfile.length ? building.floorProfile : FLAT_FLOOR_PROFILE;
  const floorWidths: number[] = [width];
  const floorOffsetX: number[] = [0];
  for (let f = 1; f < floors; f++) {
    const bandIdx =
      floors > 1
        ? Math.min(profileBands.length - 1, Math.round((f / (floors - 1)) * (profileBands.length - 1)))
        : 0;
    const band = profileBands[bandIdx];
    const w = clamp(width * band.widthFrac, width * 0.5, width * 1.08);
    const maxOffset = Math.max(0, (width - w) / 2);
    const offset = clamp(band.offsetFrac * width * 0.5, -maxOffset, maxOffset);
    floorWidths.push(w);
    floorOffsetX.push(offset);
  }

  return {
    cx,
    cz,
    width,
    depth,
    floors,
    floorH,
    bodyH,
    style,
    cultureStyle,
    buildingType,
    garage,
    doorW,
    doorH,
    floorY,
    profile,
    floorWidths,
    floorOffsetX,
  };
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
  const out: Footprint[] = [];

  // Side (east/west) walls — plain full-depth slabs, unless this is a house
  // with a garage bay carved into this particular side, in which case the
  // wall splits around the garage-door gap exactly like the front door does.
  const pushSideWall = (side: 'west' | 'east') => {
    const x = side === 'west' ? layout.cx - halfW + EXTERIOR_WALL_T / 2 : layout.cx + halfW - EXTERIOR_WALL_T / 2;
    const minZ = layout.cz - halfD;
    const maxZ = layout.cz + halfD;
    if (layout.garage && layout.garage.side === side) {
      const gapCenter = layout.cz + layout.garage.centerZ;
      const gapHalf = layout.garage.halfW;
      const a = gapCenter - gapHalf;
      const b = gapCenter + gapHalf;
      if (a - minZ > 0.15) out.push({ cx: x, cz: (minZ + a) / 2, width: EXTERIOR_WALL_T, depth: a - minZ });
      if (maxZ - b > 0.15) out.push({ cx: x, cz: (b + maxZ) / 2, width: EXTERIOR_WALL_T, depth: maxZ - b });
    } else {
      out.push({ cx: x, cz: layout.cz, width: EXTERIOR_WALL_T, depth: layout.depth });
    }
  };
  pushSideWall('west');
  pushSideWall('east');
  out.push({ cx: layout.cx, cz: layout.cz - halfD + EXTERIOR_WALL_T / 2, width: layout.width, depth: EXTERIOR_WALL_T });

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
  const {
    cx,
    cz,
    width,
    depth,
    floors,
    floorH,
    bodyH,
    style,
    buildingType,
    garage,
    doorW,
    doorH,
    floorY,
    profile,
    floorWidths,
    floorOffsetX,
  } = layout;

  // Human-designed module dimensions. Buildings are assembled from these only.
  const bayW = 1.8;
  const wallT = 0.24;
  const trimT = 0.18;
  const trimH = 0.2;

  const baysX = Math.round(width / bayW);
  const baysZ = Math.round(depth / bayW);

  // Walls extend downward past floorY as a skirt to cover minor unevenness
  // under them, but capped — the corner posts below already bridge any real
  // slope down to each corner's actual ground height with thin per-corner
  // pillars. Without the cap, a building spawned where one corner lands on
  // a steep slope (a mountainside, say) would stretch its entire wall face
  // — a single flat box, not just a corner — down to match, ballooning into
  // a giant wedge instead of a normal building on stilts.
  const sideSlope = Math.min(floorY - Math.min(profile.nw, profile.ne, profile.sw, profile.se), floorH * 1.2);
  // The skirt must stay pinned to the same top (floorY + bodyH) as the roof
  // — otherwise the symmetric box centered at floorY + bodyH/2 pushes the
  // top past the roof base too, and the wall visibly pokes through a thin
  // pitched roof slab (it was only hidden before inside the old solid
  // stepped-roof box).
  const centerY = floorY + bodyH / 2 - sideSlope / 2;
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
    parts.push({ kind, style, culture: layout.cultureStyle, position, scale, rotation });
  };

  const parts: PartTransform[] = [];
  const halfW = width / 2;
  const halfD = depth / 2;

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

  // Per-floor extents: ground floor is pinned to the exact footprint used by
  // collision/door/garage/terrain (offset 0, full width). Floors above taper
  // and/or shift in x to follow the sketch's floorProfile, so a drawing that
  // narrows or leans toward the top actually shows up as a stepped/offset
  // silhouette instead of a uniform box stacked straight up.
  const floorHalfW = (f: number) => floorWidths[f] / 2;
  const floorCx = (f: number) => cx + floorOffsetX[f];
  const floorBottomY = (f: number) => (f === 0 ? floorY - sideSlope : floorY + f * floorH);
  const floorTopY = (f: number) => floorY + (f + 1) * floorH;

  // Wall slabs per floor — split around the garage-door gap on whichever
  // side/floor has one (ground floor only), exactly like the front door.
  for (let f = 0; f < floors; f++) {
    const hw = floorHalfW(f);
    const fcx = floorCx(f);
    const bottom = floorBottomY(f);
    const top = floorTopY(f);
    const h = top - bottom;
    const cy = bottom + h / 2;

    const sideWallSlab = (side: 'west' | 'east') => {
      const x = side === 'west' ? fcx - hw + wallT / 2 : fcx + hw - wallT / 2;
      if (garage && garage.side === side && f === 0) {
        const gapCenter = cz + garage.centerZ;
        const gapHalf = garage.halfW;
        const a = gapCenter - gapHalf;
        const b = gapCenter + gapHalf;
        const minZ = cz - halfD;
        const maxZ = cz + halfD;
        if (a - minZ > 0.15) put('wall', [x, cy, (minZ + a) / 2], [wallT, h, a - minZ]);
        if (maxZ - b > 0.15) put('wall', [x, cy, (b + maxZ) / 2], [wallT, h, maxZ - b]);
        const garageDoorH = garage.doorH;
        put('door', [x + (side === 'west' ? -0.01 : 0.01), floorY + garageDoorH / 2, gapCenter], [0.06, garageDoorH, gapHalf * 2], [0, Math.PI / 2, 0]);
      } else {
        put('wall', [x, cy, cz], [wallT, h, depth]);
      }
    };
    sideWallSlab('west');
    sideWallSlab('east');
    put('wall', [fcx, cy, cz - halfD + wallT / 2], [hw * 2, h, wallT]);
    put('wall', [fcx, cy, cz + halfD - wallT / 2], [hw * 2, h, wallT]);
  }

  // Floor trims — sit at each floor line, sized to whichever floor is above.
  for (let f = 1; f <= floors; f++) {
    if (f % styleCfg.trimEvery !== 0) continue;
    const y = floorY + f * floorH;
    const hw = f < floors ? floorHalfW(f) : floorHalfW(floors - 1);
    const fcx = f < floors ? floorCx(f) : floorCx(floors - 1);
    put('trim', [fcx, y, cz], [hw * 2 + trimT, trimH, depth + trimT]);
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
    const hw = floorHalfW(f);
    const fcx = floorCx(f);
    const baysXf = Math.max(1, Math.round((hw * 2) / bayW));
    for (let i = 0; i < baysXf; i++) {
      const x = fcx - hw + bayW * (i + 0.5);
      const frontOpen = i === Math.floor(baysXf / 2) && f === 0;
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
      const onGarageWest = garage && garage.side === 'west' && f === 0 && Math.abs(z - (cz + garage.centerZ)) < garage.halfW + bayW * 0.4;
      const onGarageEast = garage && garage.side === 'east' && f === 0 && Math.abs(z - (cz + garage.centerZ)) < garage.halfW + bayW * 0.4;
      if (!onGarageWest && hash01(`${building.id}-l-${f}-z-${i}`, 29) > styleCfg.windowBias + 0.16) {
        put('window', [fcx - hw - 0.012, wy, z], [0.04, windowH, windowW]);
      }
      if (!onGarageEast && hash01(`${building.id}-r-${f}-z-${i}`, 43) > styleCfg.windowBias + 0.16) {
        put('window', [fcx + hw + 0.012, wy, z], [0.04, windowH, windowW]);
      }
      // Apartment balconies: a slab + rail posts jutting off alternating
      // upper-floor bays on the front face, so towers don't read as sealed boxes.
      if (
        buildingType === 'apartment' &&
        f > 0 &&
        i % 2 === 0 &&
        hash01(`${building.id}-bal-${f}-${i}`, 71) > 0.45
      ) {
        const bz = cz - halfD + bayW * (i + 0.5);
        const by = floorY + f * floorH - 0.08;
        put('balcony', [fcx + hw + 0.35, by, bz], [0.7, 0.1, bayW * 0.82]);
        put('accent', [fcx + hw + 0.66, by + 0.42, bz - bayW * 0.36], [0.06, 0.85, 0.06]);
        put('accent', [fcx + hw + 0.66, by + 0.42, bz + bayW * 0.36], [0.06, 0.85, 0.06]);
      }
    }
  }

  // Roof + entry massing genuinely differs per architectural type instead of
  // just re-skinning the same stepped box.
  const ramp = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z: number,
    d: number,
    thickness: number,
  ) => {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const angle = Math.atan2(y1 - y0, x1 - x0);
    put('roof', [(x0 + x1) / 2, (y0 + y1) / 2, z], [length, thickness, d], [0, 0, angle]);
  };

  const topY = floorY + bodyH;
  const topHalfW = floorHalfW(floors - 1);
  const topCx = floorCx(floors - 1);
  const culture = layout.cultureStyle;
  const flatRoofCulture = culture === 'adobe' || culture === 'modern';

  if ((buildingType === 'house' || buildingType === 'bungalow' || buildingType === 'mansion') && !flatRoofCulture) {
    // Pitched gable roof: two ramps sloping up from the side eaves to a
    // shared ridge line running along z, plus a ridge cap to hide the seam.
    // Culture-specific tweaks (pitch, overhang, extra tiers) layer on top of
    // the same ramp primitive rather than needing new geometry per style.
    const isJapanese = culture === 'japanese';
    const isTudor = culture === 'tudor';
    const isMediterranean = culture === 'mediterranean';
    const overhang = isJapanese ? 0.62 : isMediterranean ? 0.2 : 0.32;
    const pitchScale = culture === 'nordic' || isTudor ? 0.82 : isMediterranean ? 0.42 : buildingType === 'mansion' ? 0.5 : 0.62;
    const ridgeRise = topHalfW * pitchScale;
    const roofThickness = 0.24;
    const roofTiers = isJapanese ? 3 : 1;
    for (let t = 0; t < roofTiers; t++) {
      const tf = (t + 1) / roofTiers;
      const tierTop = topY + ridgeRise * tf - (roofTiers > 1 ? t * 0.05 : 0);
      const tierBase = t === 0 ? topY : topY + ridgeRise * ((t - 0.15) / roofTiers);
      const tierHalfW = topHalfW * (1 - t * 0.22);
      const tierOverhang = overhang * (1 - t * 0.3);
      ramp(topCx + tierHalfW + tierOverhang, tierBase, topCx, tierTop, cz, depth + tierOverhang * 2, roofThickness);
      ramp(topCx - tierHalfW - tierOverhang, tierBase, topCx, tierTop, cz, depth + tierOverhang * 2, roofThickness);
    }
    put('trim', [topCx, topY + ridgeRise, cz], [0.3, 0.18, depth + overhang * 2]);
    if (isTudor) {
      // Half-timber accent bands crossing the upper-floor walls.
      for (let f = 1; f < floors; f++) {
        const hw = floorHalfW(f);
        const fcx = floorCx(f);
        const y = floorY + f * floorH + floorH * 0.5;
        put('accent', [fcx, y, cz + halfD + 0.02], [hw * 2 * 0.86, 0.12, 0.03]);
        put('accent', [fcx - hw * 0.4, y, cz + halfD + 0.02], [0.12, floorH * 0.7, 0.03], [0, 0, Math.PI / 5]);
        put('accent', [fcx + hw * 0.4, y, cz + halfD + 0.02], [0.12, floorH * 0.7, 0.03], [0, 0, -Math.PI / 5]);
      }
    }

    // Entry porch: a small roofed overhang on columns in front of the door.
    const porchDepth = buildingType === 'mansion' ? 2.4 : 1.5;
    const porchW = buildingType === 'mansion' ? width * 0.62 : Math.min(width * 0.5, doorW + 1.6);
    const porchH = doorH + 0.5;
    const porchZ = cz + halfD + porchDepth / 2;
    put('porch', [cx, floorY + porchH + 0.06, porchZ], [porchW, 0.16, porchDepth]);
    const columnCount = culture === 'colonial' ? Math.max(4, buildingType === 'mansion' ? 6 : 4) : buildingType === 'mansion' ? 4 : 2;
    for (let i = 0; i < columnCount; i++) {
      const t = columnCount === 2 ? (i === 0 ? 0.08 : 0.92) : 0.06 + (i / (columnCount - 1)) * 0.88;
      const px = cx - porchW / 2 + porchW * t;
      const pz = cz + halfD + porchDepth - 0.15;
      put('accent', [px, floorY + porchH / 2, pz], [0.2, porchH, 0.2]);
    }

    if (buildingType === 'mansion') {
      // A small stepped cupola on the ridge for a grander silhouette, plus
      // an extra trim band the smaller house/bungalow types skip.
      let capW = width * 0.3;
      let capD = depth * 0.3;
      for (let i = 0; i < 2; i++) {
        const rh = 0.36;
        put('roof', [topCx, topY + ridgeRise + rh / 2 + i * rh * 0.98, cz], [capW, rh, capD]);
        capW *= 0.8;
        capD *= 0.8;
      }
      put('trim', [cx, floorY + bodyH * 0.5, cz], [width + trimT, trimH, depth + trimT]);
    }
  } else if (flatRoofCulture && buildingType !== 'apartment' && buildingType !== 'tower') {
    // Adobe/modern force a flat roof with a parapet lip even on a
    // structurally pitched-roof type — the culture's material grammar wins.
    const parapetH = culture === 'adobe' ? 0.42 : 0.26;
    put('roof', [topCx, topY + 0.06, cz], [topHalfW * 2 + 0.16, 0.12, depth + 0.16]);
    put('trim', [topCx, topY + parapetH / 2, cz - halfD], [topHalfW * 2 + 0.2, parapetH, wallT]);
    put('trim', [topCx, topY + parapetH / 2, cz + halfD], [topHalfW * 2 + 0.2, parapetH, wallT]);
    put('trim', [topCx - topHalfW, topY + parapetH / 2, cz], [wallT, parapetH, depth + 0.2]);
    put('trim', [topCx + topHalfW, topY + parapetH / 2, cz], [wallT, parapetH, depth + 0.2]);
    if (culture === 'modern') {
      put('accent', [cx, topY + 0.02, cz + halfD + 0.02], [width * 0.9, 0.04, 0.02]);
    }
  } else {
    // Flat / stepped roof — apartment/tower massing, or the palette-only
    // fallback for flat-roof cultures on an apartment/tower structure.
    const roofSteps = styleCfg.roofSteps;
    let roofW = topHalfW * 2 * 0.96;
    let roofD = depth * 0.96;
    for (let i = 0; i < roofSteps; i++) {
      const rh = style === 1 ? 0.28 : style === 2 ? 0.4 : 0.34;
      const ry = topY + rh / 2 + i * (rh * 0.98);
      put('roof', [topCx, ry, cz], [roofW, rh, roofD]);
      roofW *= styleCfg.roofShrink;
      roofD *= styleCfg.roofShrink;
    }
    if (style !== 2) {
      put(
        'accent',
        [topCx, topY + roofSteps * 0.34 + 0.18, cz],
        [Math.max(0.35, roofW * 0.56), 0.28 + style * 0.08, Math.max(0.35, roofD * 0.56)],
      );
    }
  }

  return parts;
}

function InstancedKitMesh({
  parts,
  kind,
  culture,
  color,
  emissive,
  roughness,
  metalness,
  transparent = false,
  opacity = 1,
}: {
  parts: PartTransform[];
  kind: PartKind;
  culture: CultureStyle;
  color: string;
  emissive?: string;
  roughness?: number;
  metalness?: number;
  transparent?: boolean;
  opacity?: number;
}) {
  const filtered = useMemo(
    () => parts.filter((p) => p.kind === kind && p.culture === culture),
    [parts, kind, culture],
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

interface CulturePalette {
  culture: CultureStyle;
  foundation: string;
  wall: string;
  wallEm: string;
  trim: string;
  roof: string;
  roofEm: string;
  window: string;
  windowEm: string;
  door: string;
  doorEm: string;
  accent: string;
  awning: string;
  porch: string;
  balcony: string;
}

/** Exterior material grammar per cultural style — the palette axis of CultureStyle. */
const CULTURE_PALETTES: CulturePalette[] = [
  {
    culture: 'mediterranean',
    foundation: '#c7b79a',
    wall: '#e8ddc4',
    wallEm: '#4a3f2a',
    trim: '#d9c9a3',
    roof: '#b5562f',
    roofEm: '#5c2311',
    window: '#9fc2c9',
    windowEm: '#6fd0e0',
    door: '#5b7a5e',
    doorEm: '#1f2f1f',
    accent: '#c9b48a',
    awning: '#cf7a48',
    porch: '#d9c9a3',
    balcony: '#c7b79a',
  },
  {
    culture: 'nordic',
    foundation: '#4c4640',
    wall: '#d7cdb8',
    wallEm: '#2c2820',
    trim: '#8b7a63',
    roof: '#2e3436',
    roofEm: '#131718',
    window: '#a9c7d6',
    windowEm: '#8fd0ff',
    door: '#7c3f34',
    doorEm: '#2c1310',
    accent: '#5c5347',
    awning: '#8b7a63',
    porch: '#8b7a63',
    balcony: '#d7cdb8',
  },
  {
    culture: 'japanese',
    foundation: '#3c3733',
    wall: '#e4ddce',
    wallEm: '#2a251e',
    trim: '#2f2822',
    roof: '#33302e',
    roofEm: '#171514',
    window: '#e9e4d2',
    windowEm: '#f2d78c',
    door: '#8a2f24',
    doorEm: '#380f0a',
    accent: '#2f2822',
    awning: '#5a4c3c',
    porch: '#4a3f33',
    balcony: '#3c3733',
  },
  {
    culture: 'colonial',
    foundation: '#8b8578',
    wall: '#f1eee4',
    wallEm: '#3a382f',
    trim: '#e7e2d2',
    roof: '#3f4a52',
    roofEm: '#1a2124',
    window: '#a7c4cf',
    windowEm: '#7fd4f0',
    door: '#7a2f2c',
    doorEm: '#2f1110',
    accent: '#e7e2d2',
    awning: '#7a2f2c',
    porch: '#e7e2d2',
    balcony: '#f1eee4',
  },
  {
    culture: 'tudor',
    foundation: '#5a4a3a',
    wall: '#e6ddc8',
    wallEm: '#3a3122',
    trim: '#2b2118',
    roof: '#3a2620',
    roofEm: '#180f0c',
    window: '#c9d4b0',
    windowEm: '#e8c96e',
    door: '#2b2118',
    doorEm: '#100b07',
    accent: '#2b2118',
    awning: '#4a3d2e',
    porch: '#5a4a3a',
    balcony: '#e6ddc8',
  },
  {
    culture: 'adobe',
    foundation: '#a97b52',
    wall: '#d9a56f',
    wallEm: '#4a2f18',
    trim: '#c98f5b',
    roof: '#c98f5b',
    roofEm: '#5c3b1e',
    window: '#7d97a0',
    windowEm: '#8fd0ff',
    door: '#4f7a6e',
    doorEm: '#193029',
    accent: '#a97b52',
    awning: '#c98f5b',
    porch: '#a97b52',
    balcony: '#c98f5b',
  },
  {
    culture: 'modern',
    foundation: '#3d3f42',
    wall: '#c9cbce',
    wallEm: '#232527',
    trim: '#4d4f52',
    roof: '#26282a',
    roofEm: '#0f1011',
    window: '#8fb8cc',
    windowEm: '#bfe8ff',
    door: '#26282a',
    doorEm: '#0f1011',
    accent: '#4d4f52',
    awning: '#4d4f52',
    porch: '#c9cbce',
    balcony: '#3d3f42',
  },
];

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
      {CULTURE_PALETTES.map((p) => (
        <React.Fragment key={`culture-${p.culture}`}>
          <InstancedKitMesh parts={parts} kind="foundation" culture={p.culture} color={p.foundation} roughness={0.96} metalness={0} />
          <InstancedKitMesh parts={parts} kind="wall" culture={p.culture} color={p.wall} emissive={p.wallEm} roughness={0.9} metalness={0.03} />
          <InstancedKitMesh parts={parts} kind="trim" culture={p.culture} color={p.trim} roughness={0.84} metalness={0.02} />
          <InstancedKitMesh parts={parts} kind="roof" culture={p.culture} color={p.roof} emissive={p.roofEm} roughness={0.82} metalness={0.04} />
          <InstancedKitMesh parts={parts} kind="window" culture={p.culture} color={p.window} emissive={p.windowEm} roughness={0.2} metalness={0.06} />
          <InstancedKitMesh parts={parts} kind="door" culture={p.culture} color={p.door} emissive={p.doorEm} roughness={0.75} metalness={0.02} />
          <InstancedKitMesh parts={parts} kind="accent" culture={p.culture} color={p.accent} emissive={p.wallEm} roughness={0.86} metalness={0.03} />
          <InstancedKitMesh parts={parts} kind="awning" culture={p.culture} color={p.awning} emissive={p.roofEm} roughness={0.64} metalness={0.02} />
          <InstancedKitMesh parts={parts} kind="porch" culture={p.culture} color={p.porch} roughness={0.86} metalness={0.02} />
          <InstancedKitMesh parts={parts} kind="balcony" culture={p.culture} color={p.balcony} roughness={0.8} metalness={0.03} />
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
    buildingType: layout.buildingType,
    garage: layout.garage ? { side: layout.garage.side, centerZ: layout.garage.centerZ, halfW: layout.garage.halfW } : null,
    doorW: layout.doorW,
    doorH: layout.doorH,
  };
}

/** Same door/wall palette the exterior shell paints itself with, kept in sync. */
const CULTURE_DOOR: Record<CultureStyle, { color: string; emissive: string; frame: string }> = {
  mediterranean: { color: '#5b7a5e', emissive: '#1f2f1f', frame: '#8a7250' },
  nordic: { color: '#7c3f34', emissive: '#2c1310', frame: '#4c4640' },
  japanese: { color: '#8a2f24', emissive: '#380f0a', frame: '#2f2822' },
  colonial: { color: '#7a2f2c', emissive: '#2f1110', frame: '#e7e2d2' },
  tudor: { color: '#2b2118', emissive: '#100b07', frame: '#2b2118' },
  adobe: { color: '#4f7a6e', emissive: '#193029', frame: '#a97b52' },
  modern: { color: '#26282a', emissive: '#0f1011', frame: '#4d4f52' },
};

const CULTURE_INTERIOR_PALETTE: Record<
  CultureStyle,
  { floor: string; wall: string; ceiling: string; trim: string; glow: string }
> = {
  mediterranean: { floor: '#b58a5e', wall: '#ede2c9', ceiling: '#d9c9a3', trim: '#5b7a5e', glow: '#ffd9a0' },
  nordic: { floor: '#877a68', wall: '#e2dbc9', ceiling: '#c9bfa9', trim: '#7c3f34', glow: '#bfe0ff' },
  japanese: { floor: '#6b5a48', wall: '#ece5d4', ceiling: '#d8cfba', trim: '#8a2f24', glow: '#ffe3ad' },
  colonial: { floor: '#8f8672', wall: '#f1eee4', ceiling: '#e7e2d2', trim: '#7a2f2c', glow: '#dfe9ea' },
  tudor: { floor: '#5a4a3a', wall: '#e6ddc8', ceiling: '#d3c6a8', trim: '#2b2118', glow: '#ffdca0' },
  adobe: { floor: '#a97b52', wall: '#e0bb8c', ceiling: '#cf9f6c', trim: '#4f7a6e', glow: '#ffcf9e' },
  modern: { floor: '#9a9ea1', wall: '#e7e9eb', ceiling: '#d3d6d9', trim: '#26282a', glow: '#bfe8ff' },
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
  sofa: '#7a6a8f',
  tv: '#20242c',
  counter: '#8a8a86',
  stove: '#4a4c52',
  sink: '#c7cdd4',
  toilet: '#dfe4e8',
  wardrobe: '#5f4d38',
  diningTable: '#6b4f38',
  car: '#a33f3f',
};

/** Per-role floor finish so rooms read as different spaces, not one big box. */
const ROOM_FLOOR_TINT: Record<RoomRole, number> = {
  foyer: 1.08,
  office: 0.96,
  storage: 0.74,
  lounge: 1.14,
  stair: 0.86,
  living: 1.12,
  kitchen: 0.9,
  bedroom: 1.02,
  bathroom: 1.2,
  dining: 1.06,
  hall: 0.92,
  garage: 0.7,
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
}: {
  building: BuildingAsset;
  layout: BuildingLayout;
  floor: number;
  floorplan: Floorplan;
  furniture: FurniturePiece[];
}) {
  const origin = interiorOrigin(layout, floor);
  const doorInfo = CULTURE_DOOR[layout.cultureStyle];
  const palette = CULTURE_INTERIOR_PALETTE[layout.cultureStyle];

  // Stairwell shafts punch through the floor slab (descending) and/or the
  // ceiling slab (ascending) instead of the stairs visually clipping through
  // a solid plate.
  const stairHole = useMemo<RectBox | null>(() => {
    const s = floorplan.stair;
    if (!s) return null;
    // Elongate the depth multiplier to provide headroom approach clearance
    return { cx: s.cx, cz: s.cz, halfW: s.halfW * 1.05, halfD: s.halfD * 1.6 };
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

/**
 * Carves a flat pad (plus a walk-up apron out the front, toward the door)
 * into the terrain under every building, blending back to natural terrain
 * at the edges.
 *
 * Building floor height only ever samples a handful of points right at the
 * footprint (see buildingLayout's floorY). On genuinely rugged terrain —
 * the side of a mountain, say — the ground a couple of metres away from
 * those sample points can differ by many metres, so the building (and its
 * exactly-level floor) ends up perched above a cliff with no walkable path
 * to the door at all. Flattening a small lot under and in front of every
 * building guarantees a level pad and a walkable approach regardless of
 * what the surrounding terrain looks like — the same trick real building
 * sites use (grading), just automatic.
 */
/**
 * Returns a new `built` list with every building's pad carved flat.
 *
 * Clones (rather than mutates in place) whichever patch a building actually
 * touches, and writes the clone back into `cache` — so the patch gets a
 * fresh terrain object reference the first time it's flattened. PatchMesh
 * memoizes its geometry on that reference; mutating the old object in place
 * would update collision/ground-height instantly (heightAt reads the array
 * directly) but leave the *visible* mesh stale whenever a building is added
 * after its patch already rendered, which is the common case (terrain
 * usually exists before someone draws a building on top of it).
 */
function flattenBuildingPads(
  built: { patch: Patch; terrain: TerrainData }[],
  buildings: BuildingAsset[],
  cache: Map<string, TerrainData>,
  done: Set<string>,
): { patch: Patch; terrain: TerrainData }[] {
  const out = built.map((e) => ({ ...e }));
  const clonedThisPass = new Set<string>();

  for (const building of buildings) {
    const { cx, cz, width, depth } = footprintFor(building);
    const halfW = width / 2;
    const halfD = depth / 2;

    // Same rule buildingLayout uses for floorY, sampled from the terrain as
    // it stood before this building's own flattening — so the pad matches
    // the floor height the building will actually render at.
    const frontMid = groundAt(built, cx, cz + halfD);
    const nw = groundAt(built, cx - halfW, cz + halfD);
    const ne = groundAt(built, cx + halfW, cz + halfD);
    const floorY = Math.max(nw, ne, frontMid);

    const padHalfW = halfW + 1.2;
    const padHalfD = halfD + 1.2;
    const apronDepth = 8; // flat walkway straight out from the door
    const blend = 4; // radius over which the pad fades back to natural terrain

    for (const entry of out) {
      const key = `${building.id}:${entry.patch.id}`;
      if (done.has(key)) continue;

      const half = entry.terrain.scale / 2;
      const zoneHalfD = padHalfD + apronDepth + blend;
      const zoneHalfW = padHalfW + blend;
      // Quick reject: does this building's flatten zone even reach this patch?
      if (Math.abs(cx - entry.patch.x) - zoneHalfW > half || Math.abs(cz - entry.patch.z) - zoneHalfD > half) {
        continue;
      }
      done.add(key);

      if (!clonedThisPass.has(entry.patch.id)) {
        const cloned: TerrainData = { ...entry.terrain, heights: Float32Array.from(entry.terrain.heights) };
        entry.terrain = cloned;
        cache.set(entry.patch.id, cloned);
        clonedThisPass.add(entry.patch.id);
      }

      const { patch, terrain } = entry;
      const size = terrain.size;
      const scale = terrain.scale;
      for (let iy = 0; iy < size; iy++) {
        const lz = -half + (iy / (size - 1)) * scale;
        const wz = patch.z + lz;
        const dz = wz - cz;
        for (let ix = 0; ix < size; ix++) {
          const lx = -half + (ix / (size - 1)) * scale;
          const wx = patch.x + lx;
          const dx = wx - cx;

          const inPad = Math.abs(dx) <= padHalfW && Math.abs(dz) <= padHalfD;
          const inApron = Math.abs(dx) <= padHalfW && dz > padHalfD && dz <= padHalfD + apronDepth;
          const idx = iy * size + ix;
          if (inPad || inApron) {
            terrain.heights[idx] = floorY;
            continue;
          }

          const beyondX = Math.max(0, Math.abs(dx) - padHalfW);
          const beyondZ =
            dz > padHalfD + apronDepth
              ? dz - (padHalfD + apronDepth)
              : Math.max(0, Math.abs(dz) - padHalfD);
          const dist = Math.hypot(beyondX, beyondZ);
          if (dist < blend) {
            const t = dist / blend;
            terrain.heights[idx] = floorY + (terrain.heights[idx] - floorY) * t;
          }
        }
      }
    }
  }

  return out;
}

interface Footprint {
  cx: number;
  cz: number;
  width: number;
  depth: number;
}

function AnimalMesh({
  animal,
  built,
}: {
  animal: AnimalData;
  built: { patch: Patch; terrain: TerrainData }[];
}) {
  const { camera } = useThree();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const meshRef = useRef<THREE.Mesh>(null);

  const pathIndex = useRef(0);
  const pathProgress = useRef(0);

  useEffect(() => {
    if (!animal.soundDataUrl) return;
    const audio = new Audio(animal.soundDataUrl);
    audio.loop = true;
    audioRef.current = audio;

    return () => {
      audio.pause();
      audioRef.current = null;
    };
  }, [animal.soundDataUrl]);

  useFrame((_, delta) => {
    const currentX = meshRef.current ? meshRef.current.position.x : animal.x;
    const currentZ = meshRef.current ? meshRef.current.position.z : animal.z;

    if (audioRef.current) {
      const distance = Math.hypot(camera.position.x - currentX, camera.position.z - currentZ);
      const inRange = distance <= PROXIMITY_AUDIO_DISTANCE;

      if (inRange) {
        const volume = Math.max(0, 1 - distance / PROXIMITY_AUDIO_DISTANCE);
        audioRef.current.volume = volume;
        if (audioRef.current.paused) {
          audioRef.current.play().catch(() => {});
        }
      } else {
        if (!audioRef.current.paused) {
          audioRef.current.pause();
        }
      }
    }

    if (meshRef.current && animal.path && animal.path.length > 1) {
      const speed = animal.speed ?? 4.0; // Use dynamic speed here
      let currIdx = pathIndex.current;
      const p1 = animal.path[currIdx];
      const p2 = animal.path[(currIdx + 1) % animal.path.length];

      const diffX = p2.x - p1.x;
      const diffZ = p2.z - p1.z;
      const dist = Math.hypot(diffX, diffZ);

      if (dist > 0.001) {
        let progress = pathProgress.current + (speed * delta) / dist;
        while (progress >= 1.0) {
          progress -= 1.0;
          currIdx = (currIdx + 1) % animal.path.length;
        }

        pathProgress.current = progress;
        pathIndex.current = currIdx;

        const currentP1 = animal.path[currIdx];
        const currentP2 = animal.path[(currIdx + 1) % animal.path.length];

        const nx = THREE.MathUtils.lerp(currentP1.x, currentP2.x, progress);
        const nz = THREE.MathUtils.lerp(currentP1.z, currentP2.z, progress);

        meshRef.current.position.x = nx;
        meshRef.current.position.z = nz;

        const targetRotation = Math.atan2(currentP2.x - currentP1.x, currentP2.z - currentP1.z);
        let rotDiff = targetRotation - meshRef.current.rotation.y;
        while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
        while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
        meshRef.current.rotation.y += rotDiff * Math.min(1, delta * 5);
      } else {
        // FIX: If the distance is negligible (e.g., player stood still), 
        // skip immediately to the next point so the loop doesn't freeze.
        pathIndex.current = (currIdx + 1) % animal.path.length;
        pathProgress.current = 0;
      }

      meshRef.current.position.y = groundAt(built, currentX, currentZ) + height / 2;
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
      p0: [number, number, number], p1: [number, number, number],
      p2: [number, number, number], p3: [number, number, number],
      norm: [number, number, number],
      uv0: [number, number], uv1: [number, number],
      uv2: [number, number], uv3: [number, number],
    ) => {
      positions.push(...p0, ...p1, ...p2, ...p3);
      normals.push(...norm, ...norm, ...norm, ...norm);
      uvs.push(...uv0, ...uv1, ...uv2, ...uv3);
      indices.push(vertCount, vertCount + 1, vertCount + 2, vertCount, vertCount + 2, vertCount + 3);
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

        addQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [uMin, vMin], [uMax, vMin], [uMax, vMax], [uMin, vMax]);
        addQuad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [uMax, vMin], [uMin, vMin], [uMin, vMax], [uMax, vMax]);
        if (!isSolid(x - 1, y)) addQuad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], [uMin, vMin], [uMin, vMin], [uMin, vMax], [uMin, vMax]);
        if (!isSolid(x + 1, y)) addQuad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], [uMax, vMin], [uMax, vMin], [uMax, vMax], [uMax, vMax]);
        if (!isSolid(x, y - 1)) addQuad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], [uMin, vMax], [uMax, vMax], [uMax, vMax], [uMin, vMax]);
        if (!isSolid(x, y + 1)) addQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], [uMin, vMin], [uMax, vMin], [uMax, vMin], [uMin, vMin]);
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
      if (geom.boundingBox) meshHeight = geom.boundingBox.max.y - geom.boundingBox.min.y;
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
      ref={meshRef}
      geometry={geometry}
      position={[animal.x, groundAt(built, animal.x, animal.z) + height / 2, animal.z]}
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

/* ------------------------------------------------------------ path record --- */

function PathRecorder({
  isRecording,
  onComplete,
}: {
  isRecording: boolean;
  onComplete: (path: { x: number; z: number }[]) => void;
}) {
  const { camera } = useThree();
  const path = useRef<{ x: number; z: number }[]>([]);
  const timeAcc = useRef(0);
  const totalTime = useRef(0);

  useFrame((_, delta) => {
    if (!isRecording) return;

    totalTime.current += delta;
    timeAcc.current += delta;

    if (timeAcc.current > 0.1) {
      path.current.push({ x: camera.position.x, z: camera.position.z });
      timeAcc.current = 0;
    }

    if (totalTime.current >= 5.0) {
      path.current.push({ x: camera.position.x, z: camera.position.z });
      onComplete([...path.current]);
      path.current = [];
      timeAcc.current = 0;
      totalTime.current = 0;
    }
  });

  useEffect(() => {
    if (!isRecording) {
      path.current = [];
      timeAcc.current = 0;
      totalTime.current = 0;
    }
  }, [isRecording]);

  return null;
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
  onOpenVegetation,
  isModalOpen,
  mapSelf,
}: {
  mapSelf: React.RefObject<MinimapSelf>;
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
  onOpenVegetation: (x: number, z: number) => void;
  isModalOpen: boolean;
}) {
  const { camera } = useThree();
  const move = useRef({ f: false, b: false, l: false, r: false, sprint: false });
  const dir = useRef(new THREE.Vector3());
  const lastSend = useRef(0);
  const locked = useRef(false);
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
      if (locked.current) {
        if (e.code === 'KeyE' && !interiorRef.current) {
          e.preventDefault();
          document.exitPointerLock();
          const [x, z] = forwardSpawn(SKETCH_SPAWN_DISTANCE);
          onOpenDraw(x, z);
        } else if (e.code === 'KeyR' && !interiorRef.current) {
          e.preventDefault();
          document.exitPointerLock();
          const [x, z] = forwardSpawn(SKETCH_SPAWN_DISTANCE);
          onOpenAnimalDraw(x, z);
        } else if (e.code === 'KeyF' && !interiorRef.current) {
          e.preventDefault();
          document.exitPointerLock();
          const [x, z] = forwardSpawn(SKETCH_SPAWN_DISTANCE);
          onOpenVegetation(x, z);
        }
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
  }, [camera, onOpenDraw, onOpenAnimalDraw, onOpenVegetation, isModalOpen]);

  useFrame((_, delta) => {
    // Before the modal guard: the map should keep showing where you are while
    // a draw panel is open, and mutating in place costs nothing.
    mapSelf.current.x = camera.position.x;
    mapSelf.current.z = camera.position.z;
    mapSelf.current.a = camera.rotation.y;

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
    // Clear stale state on floor switch or initial stair entry
    if (
      !stairRef.current ||
      stairRef.current.buildingId !== building.id ||
      stairRef.current.enteredFloor !== interior.floor
    ) {
      const enteringFromSouth = lz >= stair.cz;
      let direction: 'ascend' | 'descend' | null = null;
      
      if (enteringFromSouth && stair.up) direction = 'ascend';
      else if (!enteringFromSouth && stair.down) direction = 'descend';
      else if (stair.up) direction = 'ascend';
      else if (stair.down) direction = 'descend';

      if (direction) {
        stairRef.current = {
          buildingId: building.id,
          enteredFloor: interior.floor,
          enteredZ: lz,
          dir: direction,
        };
      }
    }

    if (stairRef.current) {
      const s = stairRef.current;
      const stairLength = stair.halfD * 2;
      const southEdge = stair.cz + stair.halfD;
      const northEdge = stair.cz - stair.halfD;

      if (s.dir === 'ascend' && stair.up) {
        // Ascending: fixed south-to-north span progress
        const t = clamp((southEdge - lz) / stairLength, 0, 1);
        worldGroundY = INTERIOR_Y_BASE + interior.floor * INTERIOR_FLOOR_H + t * INTERIOR_FLOOR_H;
        
        if (t >= 0.85) {
          stairRef.current = null;
          onInteriorChange({ buildingId: building.id, floor: interior.floor + 1 });
        }
      } else if (s.dir === 'descend' && stair.down) {
        // Descending: fixed north-to-south span progress
        const t = clamp((lz - northEdge) / stairLength, 0, 1);
        worldGroundY = INTERIOR_Y_BASE + interior.floor * INTERIOR_FLOOR_H - t * INTERIOR_FLOOR_H;
        
        if (t >= 0.85) {
          stairRef.current = null;
          onInteriorChange({ buildingId: building.id, floor: interior.floor - 1 });
        }
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
  const [buildings, setBuildings] = useState<BuildingAsset[]>([]);
  const [animals, setAnimals] = useState<AnimalData[]>([]);
  const [weathers, setWeathers] = useState<WeatherAsset[]>([]);
  // The same weather rows, parsed for the new atmosphere system.
  //
  // Kept separate from `weathers` rather than derived from it because
  // normalizeCondition collapses the vocabulary on the way in — 'rain' becomes
  // 'overcast' and 'snow' becomes 'light', which is lossless for the five
  // legacy conditions and lossy for everything else. Parsing the row a second
  // time is cheaper than teaching the old contract about the new one.
  const [zones, setZones] = useState<Contribution<WeatherPayload>[]>([]);
  /** Live atmosphere, for the minimap and anything else that wants to read it. */
  const atmosphereRef = useRef<Atmosphere | null>(null);
  /** Camera position for the minimap, mutated in place so it never re-renders. */
  const mapSelf = useRef<MinimapSelf>({ x: 0, z: 40, a: 0 });

  // Particle budget. A judge's phone gets a much smaller buffer — the sky and
  // fog carry most of the atmosphere anyway, and they cost the same either way.
  const quality = useMemo(() => {
    if (typeof navigator === 'undefined') return 1;
    const coarse =
      typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    return coarse || navigator.hardwareConcurrency <= 4 ? 0.35 : 1;
  }, []);
  const [travellers, setTravellers] = useState<Traveller[]>([]);
  const [drawAt, setDrawAt] = useState<{ x: number; z: number } | null>(null);
  const [animalDrawAt, setAnimalDrawAt] = useState<{ x: number; z: number } | null>(null);
  const [vegetationAt, setVegetationAt] = useState<{ x: number; z: number } | null>(null);
  const [vegetationPatches, setVegetationPatches] = useState<VegetationPatch[]>([]);
  const [interior, setInterior] = useState<ActiveInterior | null>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'offline'>(
    supabase ? 'connecting' : 'offline',
  );

  const [isRecordingPath, setIsRecordingPath] = useState(false);
  const [recordedPath, setRecordedPath] = useState<{ x: number; z: number }[] | null>(null);

  const selfId = useMemo(makeSelfId, []);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const travellerMap = useRef<Map<string, Traveller>>(new Map());

  // Synthesis is the expensive step, so it happens once per patch and is
  // cached by id — not on every render or frame.
  const cache = useRef<Map<string, TerrainData>>(new Map());
  // Tracks which (building, patch) pads have already been carved flat, so
  // re-renders don't re-scan every terrain grid for every building already
  // handled — flattening a patch's heights in place is a one-time fix-up.
  const flattenedPads = useRef<Set<string>>(new Set());
  const built = useMemo(() => {
    const list = patches.map((patch) => {
      let terrain = cache.current.get(patch.id);
      if (!terrain) {
        terrain = terrainFor(patch);
        cache.current.set(patch.id, terrain);
      }
      return { patch, terrain };
    });
    return flattenBuildingPads(list, buildings, cache.current, flattenedPads.current);
  }, [patches, buildings]);
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
        roofFrac: Number(props.roofFrac) || 0,
        floorProfile: sanitizeFloorProfile(props.floorProfile),
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
        path: Array.isArray(props.path) ? (props.path as { x: number; z: number }[]) : null,
        speed: typeof props.speed === 'number' ? props.speed : undefined, // Add this line
      };
    };
    // Same row, read for the new atmosphere system. This one keeps the
    // condition exactly as it was written, so 'rain' stays rain.
    const toZone = (r: Record<string, unknown>): Contribution<WeatherPayload> | null => {
      if (r.type !== 'weather') return null;
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const condition = typeof props.condition === 'string' ? props.condition : null;
      if (!condition) return null;
      return {
        id: String(r.id),
        kind: 'weather',
        x: Number(r.x) || 0,
        z: Number(r.z) || 0,
        rotation: 0,
        author: String(r.author ?? ''),
        created_at: String(r.created_at ?? ''),
        payload: {
          condition,
          intensity: typeof props.intensity === 'number' ? props.intensity : 0.85,
          radius: typeof props.radius === 'number' ? props.radius : 260,
        },
      };
    };

    const toWeather = (r: Record<string, unknown>): WeatherAsset | null => {
      if (r.type !== 'weather') return null;
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const condition = normalizeCondition(props.condition);
      if (!condition) return null;
      return {
        id: String(r.id),
        x: Number(r.x) || 0,
        z: Number(r.z) || 0,
        condition,
        intensity: typeof props.intensity === 'number' ? props.intensity : 0.85,
        radius: typeof props.radius === 'number' ? props.radius : 260,
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
        setWeathers((prev) => {
          const byId = new Map(prev.map((w) => [w.id, w]));
          for (const row of data) {
            const w = toWeather(row as Record<string, unknown>);
            if (w) byId.set(w.id, w);
          }
          return [...byId.values()];
        });
        setZones((prev) => {
          const byId = new Map(prev.map((z) => [z.id, z]));
          for (const row of data) {
            const z = toZone(row as Record<string, unknown>);
            if (z) byId.set(z.id, z);
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
          const w = toWeather(row);
          if (w) {
            setWeathers((prev) => (prev.some((q) => q.id === w.id) ? prev : [...prev, w]));
          }
          const z = toZone(row);
          if (z) {
            setZones((prev) => (prev.some((q) => q.id === z.id) ? prev : [...prev, z]));
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
            if (error || !data?.length) return without;
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
      roofFrac: draft.building.roofFrac,
      floorProfile: draft.building.floorProfile,
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
          roofFrac: draft.building.roofFrac,
          floorProfile: draft.building.floorProfile,
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
            roofFrac: Number(props.roofFrac) || optimistic.roofFrac,
            floorProfile: props.floorProfile ? sanitizeFloorProfile(props.floorProfile) : optimistic.floorProfile,
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
      path: { x: number; z: number }[] | null,
      speed: number, // Add speed parameter
      x: number,
      z: number,
    ) => {
      const outlineSketch = encodeColorSketch(outlineGrid);
      const patternSketch = encodeColorSketch(patternGrid);
      const tempId = `temp-animal-${Math.random() * 1e9}`;

      // Add speed to local state
      setAnimals((prev) => [...prev, { id: tempId, x, z, outlineSketch, patternSketch, soundDataUrl, path, speed }]);
      setAnimalDrawAt(null);
      setIsRecordingPath(false);
      setRecordedPath(null);

      if (!supabase) return;

      // Add speed to database properties
      supabase
        .from('world_assets')
        .insert({ x, z, type: 'animal', properties: { outlineSketch, patternSketch, soundDataUrl, path, speed } })
        .select()
        .then(({ data, error }) => {
          setAnimals((prev) => {
            const without = prev.filter((a) => a.id !== tempId);
            if (error || !data?.length) return without;
            const row = data[0] as Record<string, unknown>;
            const id = String(row.id);
            return without.some((a) => a.id === id)
              ? without
              : [...without, { id, x, z, outlineSketch, patternSketch, soundDataUrl, path, speed }];
          });
        });
    },
    [],
  );

  const plantVegetation = useCallback(
    (selection: string, x: number, z: number) => {
      if (!selection.trim()) return;
      const next = createVegetationPatches(
        (wx, wz) => groundAt(built, wx, wz),
        x,
        z,
        selection.trim(),
      );
      setVegetationPatches((prev) => [...prev, ...next]);
      setVegetationAt(null);
    },
    [built],
  );

  const label =
    status === 'live'
      ? `${travellers.length} traveller${travellers.length === 1 ? '' : 's'} nearby`
      : status === 'connecting'
        ? 'connecting…'
        : 'offline — solo world';

  const isModalOpen = drawAt !== null || vegetationAt !== null || (animalDrawAt !== null && !isRecordingPath);

  // Flattened for the minimap, which wants plain numbers rather than the
  // contribution envelope.
  const mapZones = useMemo(
    () =>
      zones.map((z) => ({
        id: z.id,
        x: z.x,
        z: z.z,
        radius: z.payload.radius,
        condition: z.payload.condition,
      })),
    [zones],
  );

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black select-none">
      <Canvas
        shadows={{ type: THREE.PCFShadowMap }}
        dpr={[1, 2]}
        camera={{ position: [0, EYE, 40], fov: 72, near: 0.5, far: 3000 }}
      >
        {/* Weather owns scene.fog — it drives density and colour from the
            blended atmosphere, so a static FogExp2 set here would be
            overwritten on the first frame anyway. Indoors the zone list is
            emptied rather than the system unmounted, so stepping outside eases
            back into the weather instead of snapping. */}
        <Weather
          zones={interior !== null ? EMPTY_ZONES : zones}
          quality={quality}
          expose={atmosphereRef}
        />

        <Plain />
        {built.map(({ patch, terrain }) => (
          <PatchMesh key={patch.id} patch={patch} terrain={terrain} />
        ))}
        <BuildingKit layouts={buildingLayouts} />

        {animals.map((a) => (
          <AnimalMesh key={a.id} animal={a} built={built} />
        ))}
        <VegetationLayer patches={vegetationPatches} />
        {activeInterior && (
          <InteriorScene
            building={activeInterior.building}
            layout={activeInterior.layout}
            floor={interior!.floor}
            floorplan={activeInterior.floorplan}
            furniture={activeInterior.furniture}
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

        <PathRecorder
          isRecording={isRecordingPath}
          onComplete={(path) => {
            setIsRecordingPath(false);
            setRecordedPath(path);
          }}
        />

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
          onOpenAnimalDraw={(x, z) => {
            setAnimalDrawAt({ x, z });
            setRecordedPath(null);
            setIsRecordingPath(false);
          }}
          onOpenVegetation={(x, z) => setVegetationAt({ x, z })}
          isModalOpen={isModalOpen}
          mapSelf={mapSelf}
        />
      </Canvas>

      {/* Hidden indoors — the map draws the outdoor world, and inside a
          building the arrow would wander a landscape you cannot see. */}
      {interior === null && (
        <div className="absolute right-6 top-6">
          <Minimap
            half={1000}
            patches={built.map(({ patch }) => ({ id: patch.id, x: patch.x, z: patch.z }))}
            zones={mapZones}
            travellers={travellers}
            self={mapSelf}
          />
        </div>
      )}

      <div className="pointer-events-none absolute left-6 top-6 rounded-lg bg-black/50 p-4 backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-lg font-semibold text-white">Infinite Terra</h1>
          <Link
            href="/dashboard"
            className="pointer-events-auto text-base text-white/60 underline decoration-white/25 underline-offset-2 hover:text-white/90"
          >
            observatory ↗
          </Link>
        </div>
        <p className="mt-1 text-sm text-white/70">
          {patches.length} landform{patches.length === 1 ? '' : 's'} · {buildings.length}{' '}
          building{buildings.length === 1 ? '' : 's'} · {animals.length} animal
          {animals.length === 1 ? '' : 's'} · {vegetationPatches.length} plant patch
          {vegetationPatches.length === 1 ? '' : 'es'} · {label}
        </p>
      </div>

      <div className="pointer-events-none absolute bottom-6 left-6 space-y-1.5 text-base text-white/60">
        <p>
          <span className="text-white/85">Click</span> to look ·{' '}
          <span className="text-white/85">WASD</span> to walk ·{' '}
          <span className="text-white/85">Shift</span> to run
        </p>
        {interior ? (
          <p>Floor {interior.floor + 1} — find the stairwell to change floors, or walk back out the door</p>
        ) : (
          <p>
            <span className="text-white/85">E</span> terrain/buildings ·{' '}
            <span className="text-white/85">R</span> animal ·{' '}
            <span className="text-white/85">F</span> plant vegetation ·{' '}
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
          isRecordingPath={isRecordingPath}
          onStartPathRecord={() => setIsRecordingPath(true)}
          recordedPath={recordedPath}
          onCancel={() => {
            setAnimalDrawAt(null);
            setIsRecordingPath(false);
          }}
          onCommit={(outlineGrid, patternGrid, soundDataUrl, path, speed) =>
            commitAnimal(outlineGrid, patternGrid, soundDataUrl, path, speed, animalDrawAt.x, animalDrawAt.z)
          }
        />
      )}

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
  const [color, setColor] = useState('#000000');
  const [markerSize, setMarkerSize] = useState(28);

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
      // where a hard 1px pen produces a wall. Stroke color feeds the same
      // luminance-to-height formula in submit(), so darker picks raise more.
      const g = ctx.createRadialGradient(x, y, 0, x, y, markerSize);
      g.addColorStop(0, hexToRgba(color, 0.9));
      g.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, markerSize, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // Building mode uses a tighter, fixed brush so silhouette proportions stay true.
    ctx.fillStyle = 'rgba(0,0,0,0.96)';
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
  }, [mode, color, markerSize]);

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

        {mode === 'terrain' ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
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
        ) : null}

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
  isRecordingPath,
  onStartPathRecord,
  recordedPath,
}: {
  onCommit: (
    outlineGrid: Uint8Array,
    patternGrid: Uint8Array,
    soundDataUrl: string | null,
    path: { x: number; z: number }[] | null,
    speed: number, // Add speed to prop type
  ) => void;
  onCancel: () => void;
  isRecordingPath?: boolean;
  onStartPathRecord?: () => void;
  recordedPath?: { x: number; z: number }[] | null;
}) {
  const [step, setStep] = useState<'outline' | 'pattern' | 'sound' | 'path'>('outline');
  const [speed, setSpeed] = useState(4.0);
  const [outlineGrid, setOutlineGrid] = useState<Uint8Array | null>(null);
  const [patternGrid, setPatternGrid] = useState<Uint8Array | null>(null);

  // Audio recording states
  const [isRecording, setIsRecording] = useState(false);
  const [timeLeft, setTimeLeft] = useState(5);
  const [soundDataUrl, setSoundDataUrl] = useState<string | null>(null);
  const [pathTimeLeft, setPathTimeLeft] = useState(5);

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
  }, []);

  useEffect(() => {
    if (isRecordingPath) {
      setPathTimeLeft(5);
      const timer = setInterval(() => {
        setPathTimeLeft((prev) => prev - 1);
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [isRecordingPath]);

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

  const handleNextToPath = () => {
    setStep('path');
  };

  const handleStartPathRecord = () => {
    if (onStartPathRecord) {
      onStartPathRecord();
      const canvas = document.querySelector('canvas');
      if (canvas) canvas.requestPointerLock();
    }
  };

  const handleDone = () => {
    if (!outlineGrid || !patternGrid) return;
    onCommit(outlineGrid, patternGrid, soundDataUrl, recordedPath || null, speed);
  };

  if (isRecordingPath) {
    return (
      <div className="pointer-events-none absolute inset-0 z-50 flex items-start justify-center pt-24">
        <div className="rounded-full bg-red-500/90 px-6 py-3 text-lg font-bold text-white shadow-lg animate-pulse">
          ≡ƒö┤ Recording Path... {pathTimeLeft > 0 ? pathTimeLeft : 0}s
        </div>
      </div>
    );
  }

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
          {step === 'path' && '4. Record Animal Path'}
        </h2>
        <p className="mt-1 text-sm text-white/60">
          {step === 'outline' && 'Sketch the profile silhouette of your creature.'}
          {step === 'pattern' && 'Paint spots, stripes, or skin details onto the form.'}
          {step === 'sound' && 'Record a 5-second sound or upload an audio file for your animal.'}
          {step === 'path' && 'Walk a route for 5 seconds that your animal will endlessly patrol.'}
        </p>

        {(step === 'outline' || step === 'pattern') && (
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
                  ≡ƒÄÖ∩╕Å
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
                      ≡ƒÄÖ∩╕Å
                    </button>
                    <span className="mt-2 text-xs text-white/70">Record 5s</span>
                  </div>

                  <div className="text-xs text-white/40 font-medium">OR</div>

                  <div className="flex flex-col items-center">
                    <label className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-full bg-blue-600 text-2xl text-white transition-transform hover:scale-105">
                      ≡ƒôü
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </label>
                    <span className="mt-2 text-xs text-white/70">Upload Audio</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'path' && (
          <div className="mt-6 flex flex-col items-center justify-center space-y-4 rounded-lg border border-white/10 bg-black/40 p-8">
            {recordedPath ? (
              <div className="text-center space-y-3 w-full">
                <p className="text-sm text-emerald-400 font-medium">
                  ✓ Path recorded ({recordedPath.length} points)
                </p>
                
                {/* Speed Slider Added Here */}
                <div className="mt-4 flex flex-col items-center space-y-2 rounded-md bg-white/5 p-4 w-full">
                  <div className="flex w-full justify-between px-1 text-xs text-white/70">
                    <span>Turtle</span>
                    <span className="font-semibold text-white">{speed.toFixed(1)}x</span>
                    <span>Cheetah</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="15.0"
                    step="0.5"
                    value={speed}
                    onChange={(e) => setSpeed(parseFloat(e.target.value))}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-emerald-500"
                  />
                </div>

                <button
                  onClick={handleStartPathRecord}
                  className="mt-2 text-xs text-white/60 hover:text-white underline"
                >
                  Re-record path
                </button>
              </div>
            ) : (
              <div className="text-center">
                <button
                  onClick={handleStartPathRecord}
                  className="flex h-16 items-center justify-center rounded-full bg-blue-500 px-8 text-white font-bold transition-transform hover:scale-105 shadow-lg"
                >
                  ≡ƒÜ╢ Walk 5s Path
                </button>
                <p className="mt-3 text-xs text-white/70">Panel will vanish while you walk.</p>
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
              onClick={handleNextToPath}
              disabled={isRecording}
              className={`rounded-md px-5 py-2 text-sm font-medium text-neutral-950 ${
                isRecording
                  ? 'bg-neutral-600 cursor-not-allowed'
                  : 'bg-amber-500 hover:bg-amber-400'
              }`}
            >
              Next: Path
            </button>
          )}

          {step === 'path' && (
            <button
              onClick={handleDone}
              className="rounded-md bg-emerald-500 px-5 py-2 text-sm font-medium text-neutral-950 hover:bg-emerald-400 shadow-lg"
            >
              Done & Spawn
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
