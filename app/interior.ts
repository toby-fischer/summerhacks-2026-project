// app/interior.ts
//
// Building interiors: footprint -> rooms -> furniture.
//
// Same philosophy as terrain.ts and building.ts: pure functions of the
// building's id (and floor number), so every client — and every player who
// walks in behind someone else — generates byte-identical rooms, walls,
// stairs and furniture. Nothing here touches the database; interiors are a
// recipe (a building id) not a result.
//
// Room layout is deliberately generated once per building (seeded only by
// id, not floor) so every floor shares the same rectangle split. That's
// what lets a stairwell line up into one straight vertical shaft without
// per-floor bookkeeping — floor N's stair cell sits at the exact same local
// x/z as floor N+1's.
//
// Room *roles* (and therefore furniture) depend on the building's
// architectural type: a house gets a living room/kitchen/bedrooms, a
// mansion gets more of everything, an apartment tower gets a corridor of
// separate units, and the fallback "tower" type keeps the original
// generic office-building feel.

import type { BuildingType } from './building';

export type RoomRole =
  | 'foyer'
  | 'office'
  | 'storage'
  | 'lounge'
  | 'stair'
  | 'living'
  | 'kitchen'
  | 'bedroom'
  | 'bathroom'
  | 'dining'
  | 'hall'
  | 'garage';

export interface Room {
  role: RoomRole;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Axis-aligned collision box in the building's local (center-origin) space. */
export interface WallBox {
  cx: number;
  cz: number;
  halfW: number;
  halfD: number;
}

export interface StairCell {
  cx: number;
  cz: number;
  halfW: number;
  halfD: number;
  /** Can be climbed from this floor to floor + 1. */
  up: boolean;
  /** Can be descended from this floor to floor - 1. */
  down: boolean;
}

export interface Floorplan {
  floor: number;
  floors: number;
  /** Interior usable half-extents, inside the exterior walls. */
  halfW: number;
  halfD: number;
  wallHeight: number;
  rooms: Room[];
  walls: WallBox[];
  stair: StairCell | null;
  /** Local point just inside the door — where a player lands on entry. */
  entry: { x: number; z: number };
  /** Local point of the door gap itself, for exit proximity checks. */
  doorway: { x: number; z: number };
}

export type FurnitureKind =
  | 'rug'
  | 'desk'
  | 'chair'
  | 'shelf'
  | 'crate'
  | 'table'
  | 'lamp'
  | 'bed'
  | 'sofa'
  | 'tv'
  | 'counter'
  | 'stove'
  | 'sink'
  | 'toilet'
  | 'wardrobe'
  | 'diningTable'
  | 'car';

export interface FurniturePiece {
  kind: FurnitureKind;
  /** Local x, floor-relative y, local z. */
  position: [number, number, number];
  scale: [number, number, number];
  rotation: [number, number, number];
}

/** Enterable garage bay carved into a side wall — house type only, ground floor. */
export interface GarageSpec {
  side: 'west' | 'east';
  /** Offset from the building center along z. */
  centerZ: number;
  halfW: number;
}

export interface BuildingSpec {
  id: string;
  width: number;
  depth: number;
  floors: number;
  style: 0 | 1 | 2;
  buildingType: BuildingType;
  garage: GarageSpec | null;
  /** Must match the exterior door width/height so the two shells line up exactly. */
  doorW: number;
  doorH: number;
}

const WALL_T = 0.24;
const DOOR_GAP = 1.8;
const STAIR_SIZE = 2.6;
export const INTERIOR_WALL_H = 2.9;

function hash01(seed: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function rectArea(r: Rect): number {
  return (r.maxX - r.minX) * (r.maxZ - r.minZ);
}

/** One wall run with zero or more passable gaps cut into it. */
function pushWallRun(
  walls: WallBox[],
  axis: 'x' | 'z',
  p: number,
  spanMin: number,
  spanMax: number,
  gaps?: { center: number; half: number }[],
): void {
  const sorted = (gaps ?? []).slice().sort((a, b) => a.center - b.center);
  const segments: [number, number][] = [];
  let cursor = spanMin;
  for (const g of sorted) {
    const a = clamp(g.center - g.half, spanMin, spanMax);
    const b = clamp(g.center + g.half, spanMin, spanMax);
    if (a > cursor) segments.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < spanMax) segments.push([cursor, spanMax]);
  for (const [a, b] of segments) {
    if (b - a < 0.15) continue;
    const mid = (a + b) / 2;
    const half = (b - a) / 2;
    if (axis === 'x') walls.push({ cx: p, cz: mid, halfW: WALL_T / 2, halfD: half });
    else walls.push({ cx: mid, cz: p, halfW: half, halfD: WALL_T / 2 });
  }
}

/**
 * Iterative BSP: repeatedly split whichever room is currently largest along
 * its longer axis, leaving a doorway gap in the new partition wall. Stops
 * once there are enough rooms or rooms get too small to usefully split.
 *
 * `minRooms`/`maxRooms`/`areaDivisor` let callers bias room count by
 * architectural type — a mansion wants more, smaller rooms than a bungalow.
 */
function splitRooms(
  halfW: number,
  halfD: number,
  seed: string,
  minRooms = 2,
  maxRooms = 4,
  areaDivisor = 22,
): { rects: Rect[]; walls: WallBox[] } {
  const full: Rect = { minX: -halfW, maxX: halfW, minZ: -halfD, maxZ: halfD };
  const targetRooms = clamp(Math.round(rectArea(full) / areaDivisor), minRooms, maxRooms);

  const rects: Rect[] = [full];
  const walls: WallBox[] = [];

  let iter = 0;
  while (rects.length < targetRooms) {
    let idx = 0;
    let best = -1;
    for (let i = 0; i < rects.length; i++) {
      const a = rectArea(rects[i]);
      if (a > best) {
        best = a;
        idx = i;
      }
    }
    const r = rects[idx];
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    if (Math.min(w, d) < 3.2) break; // would produce a sliver room

    const splitOnX = w >= d;
    const ratio = 0.38 + hash01(seed, 1000 + iter) * 0.24;
    const gapT = hash01(seed, 2000 + iter);

    if (splitOnX) {
      const p = r.minX + w * ratio;
      rects.splice(idx, 1, { ...r, maxX: p }, { ...r, minX: p });
      const gz = r.minZ + 1.4 + gapT * Math.max(0.1, d - 2.8);
      pushWallRun(walls, 'x', p, r.minZ, r.maxZ, [{ center: gz, half: DOOR_GAP / 2 }]);
    } else {
      const p = r.minZ + d * ratio;
      rects.splice(idx, 1, { ...r, maxZ: p }, { ...r, minZ: p });
      const gx = r.minX + 1.4 + gapT * Math.max(0.1, w - 2.8);
      pushWallRun(walls, 'z', p, r.minX, r.maxX, [{ center: gx, half: DOOR_GAP / 2 }]);
    }
    iter++;
  }

  return { rects, walls };
}

/**
 * Assigns a RoomRole to every rect produced by splitRooms, branching on the
 * building's architectural type so a house doesn't feel like a tiny office.
 */
function assignRoles(
  type: BuildingType,
  floor: number,
  floors: number,
  rects: Rect[],
  stairRoomIdx: number,
  nearDoorIdx: number,
  seed: string,
): RoomRole[] {
  const roles: RoomRole[] = new Array(rects.length).fill('office');
  const hasStair = floors > 1;
  if (hasStair) roles[stairRoomIdx] = 'stair';

  const order: number[] = [];
  for (let i = 0; i < rects.length; i++) {
    if (hasStair && i === stairRoomIdx) continue;
    order.push(i);
  }
  order.sort((a, b) => (a === nearDoorIdx ? -1 : b === nearDoorIdx ? 1 : 0));

  if (type === 'house' || type === 'bungalow') {
    const list: RoomRole[] = floor === 0 ? ['living', 'kitchen', 'bedroom', 'bathroom', 'dining'] : ['bedroom', 'bedroom', 'bathroom', 'office'];
    order.forEach((idx, i) => {
      roles[idx] = list[Math.min(i, list.length - 1)];
    });
  } else if (type === 'mansion') {
    const list: RoomRole[] = floor === 0 ? ['foyer', 'dining', 'living', 'kitchen', 'bathroom', 'office'] : ['bedroom', 'bedroom', 'bedroom', 'bathroom', 'lounge', 'office'];
    order.forEach((idx, i) => {
      roles[idx] = list[Math.min(i, list.length - 1)];
    });
  } else {
    // tower, and apartment ground floor: the original generic office feel.
    if (order.length > 0) roles[nearDoorIdx] = 'foyer';
    for (const idx of order) {
      if (idx === nearDoorIdx) continue;
      const t = hash01(`${seed}-role-${floor}-${idx}`, 77);
      roles[idx] = t < 0.34 ? 'storage' : t < 0.67 ? 'lounge' : 'office';
    }
  }

  return roles;
}

/**
 * Build one floor's rooms, walls and stairwell.
 *
 * Room geometry is identical on every floor (seeded by id only) so the
 * stairwell always lines up; only role assignment and furniture vary per
 * floor, so a five-storey building doesn't feel like the same room repeated.
 */
export function generateFloorplan(spec: BuildingSpec, floor: number): Floorplan {
  const halfW = Math.max(2.4, spec.width / 2 - WALL_T);
  const halfD = Math.max(2.4, spec.depth / 2 - WALL_T);
  const seed = spec.id;
  const type = spec.buildingType;

  // Apartment towers reached via the stairwell get a dedicated
  // corridor-and-units layout instead of the generic room-splitting BSP.
  if (type === 'apartment' && floor > 0) {
    return generateApartmentFloor(spec, floor, halfW, halfD);
  }

  const [minRooms, maxRooms, areaDivisor] =
    type === 'mansion' ? [5, 7, 15] : type === 'house' || type === 'bungalow' ? [2, 4, 16] : [2, 4, 22];
  const { rects, walls: innerWalls } = splitRooms(halfW, halfD, seed, minRooms, maxRooms, areaDivisor);
  const walls: WallBox[] = [...innerWalls];

  // Exterior perimeter. Only the ground floor has a door gap; upper floors
  // are only reachable via the stairwell. Same gap width the exterior shell
  // carves into its own front wall, so neither side ever has a lip to catch on.
  const doorHalf = spec.doorW / 2 + 0.25;
  pushWallRun(walls, 'z', halfD, -halfW, halfW, floor === 0 ? [{ center: 0, half: doorHalf }] : undefined);
  pushWallRun(walls, 'z', -halfD, -halfW, halfW);

  // A house's garage gets a second exterior gap, on whichever side wall the
  // exterior shell put the garage door — same coordinates, same width.
  const garage = spec.garage;
  const eastGap = garage && garage.side === 'east' && floor === 0 ? [{ center: garage.centerZ, half: garage.halfW + 0.1 }] : undefined;
  const westGap = garage && garage.side === 'west' && floor === 0 ? [{ center: garage.centerZ, half: garage.halfW + 0.1 }] : undefined;
  pushWallRun(walls, 'x', halfW, -halfD, halfD, eastGap);
  pushWallRun(walls, 'x', -halfW, -halfD, halfD, westGap);

  // Stair room: deterministic pick, biased away from whichever room touches
  // the door so the foyer/living room stays open.
  const stairRoomIdx = Math.floor(hash01(seed, 555) * rects.length) % rects.length;
  let nearDoorIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.minX <= 0.1 && r.maxX >= -0.1) {
      const dist = halfD - r.maxZ;
      if (dist < bestDist) {
        bestDist = dist;
        nearDoorIdx = i;
      }
    }
  }

  const roles = assignRoles(type, floor, spec.floors, rects, stairRoomIdx, nearDoorIdx, seed);

  // Garage room override: whichever room actually touches the garage's wall
  // gap becomes the garage, car and all, so the exterior door leads somewhere.
  if (floor === 0 && garage) {
    const gz = garage.centerZ;
    let bestIdx = -1;
    let bestGarageDist = Infinity;
    for (let i = 0; i < rects.length; i++) {
      if (spec.floors > 1 && i === stairRoomIdx) continue;
      const r = rects[i];
      const touchesWall = garage.side === 'west' ? r.minX <= -halfW + 0.2 : r.maxX >= halfW - 0.2;
      if (!touchesWall) continue;
      if (gz < r.minZ - 0.6 || gz > r.maxZ + 0.6) continue;
      const dist = Math.abs((r.minZ + r.maxZ) / 2 - gz);
      if (dist < bestGarageDist) {
        bestGarageDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) roles[bestIdx] = 'garage';
  }

  const stairRoom = rects[stairRoomIdx];
  const roomW = stairRoom.maxX - stairRoom.minX;
  const roomD = stairRoom.maxZ - stairRoom.minZ;

  // Push the stair cell against the back wall (minZ) to concentrate
  // all remaining room space at the front (maxZ) for approach clearance.
  const marginBack = 0.3;
  const marginFront = 1.2;

  const cellW = Math.min(STAIR_SIZE, roomW - 0.6);
  const cellD = Math.min(STAIR_SIZE, roomD - marginBack - marginFront);

  const stair: StairCell | null =
    spec.floors > 1
      ? {
          cx: (stairRoom.minX + stairRoom.maxX) / 2,
          cz: stairRoom.minZ + marginBack + (cellD / 2),
          halfW: Math.max(0.9, cellW / 2),
          halfD: Math.max(0.9, cellD / 2),
          up: floor < spec.floors - 1,
          down: floor > 0,
        }
      : null;

  const nearDoorRoom = rects[nearDoorIdx];
  const entry = { x: 0, z: clamp(halfD - 1.3, nearDoorRoom.minZ + 0.6, nearDoorRoom.maxZ - 0.4) };
  const doorway = { x: 0, z: halfD };

  return {
    floor,
    floors: spec.floors,
    halfW,
    halfD,
    wallHeight: INTERIOR_WALL_H,
    rooms: rects.map((r, i) => ({ role: roles[i], ...r })),
    walls,
    stair,
    entry,
    doorway,
  };
}

/**
 * Apartment floor above ground: a central corridor running the depth of the
 * building with a stairwell at one end, and up to three unit cells peeled
 * off either side. Wide units split into a corridor-facing living room plus
 * a bedroom at the back; narrow ones stay a single studio.
 */
function generateApartmentFloor(spec: BuildingSpec, floor: number, halfW: number, halfD: number): Floorplan {
  const corridorHalf = 1.0;
  const walls: WallBox[] = [];
  const rooms: Room[] = [];

  pushWallRun(walls, 'z', halfD, -halfW, halfW);
  pushWallRun(walls, 'z', -halfD, -halfW, halfW);
  pushWallRun(walls, 'x', halfW, -halfD, halfD);
  pushWallRun(walls, 'x', -halfW, -halfD, halfD);

  const stairHalf = STAIR_SIZE / 2;
  const stairCz = clamp(halfD - stairHalf - 0.3, -halfD + stairHalf, halfD - stairHalf);

  const buildSide = (side: 'west' | 'east') => {
    const blockMinX = side === 'west' ? -halfW : corridorHalf;
    const blockMaxX = side === 'west' ? -corridorHalf : halfW;
    const blockW = blockMaxX - blockMinX;
    if (blockW < 1.2) return; // footprint too narrow on this side for units

    const unitCount = clamp(Math.round((halfD * 2) / 4.6), 1, 3);
    const unitDepth = (halfD * 2) / unitCount;
    const corridorGaps: { center: number; half: number }[] = [];

    for (let u = 0; u < unitCount; u++) {
      const zMin = -halfD + u * unitDepth;
      const zMax = zMin + unitDepth;
      const zMid = (zMin + zMax) / 2;
      corridorGaps.push({ center: zMid, half: 0.85 });

      if (blockW >= 5.0) {
        // Split into a corridor-facing living room + a bedroom at the back.
        const splitX = side === 'west' ? blockMinX + blockW * 0.42 : blockMinX + blockW * 0.58;
        pushWallRun(walls, 'x', splitX, zMin, zMax, [{ center: zMid, half: 0.75 }]);
        const livingRect =
          side === 'west'
            ? { minX: splitX, maxX: blockMaxX, minZ: zMin, maxZ: zMax }
            : { minX: blockMinX, maxX: splitX, minZ: zMin, maxZ: zMax };
        const bedroomRect =
          side === 'west'
            ? { minX: blockMinX, maxX: splitX, minZ: zMin, maxZ: zMax }
            : { minX: splitX, maxX: blockMaxX, minZ: zMin, maxZ: zMax };
        rooms.push({ role: 'living', ...livingRect });
        rooms.push({ role: 'bedroom', ...bedroomRect });
      } else {
        rooms.push({ role: 'living', minX: blockMinX, maxX: blockMaxX, minZ: zMin, maxZ: zMax });
      }

      if (u > 0) {
        // Partition between neighbouring units — no gap, they're separate homes.
        pushWallRun(walls, 'z', zMin, blockMinX, blockMaxX);
      }
    }

    pushWallRun(walls, 'x', side === 'west' ? -corridorHalf : corridorHalf, -halfD, halfD, corridorGaps);
  };

  buildSide('west');
  buildSide('east');

  rooms.push({ role: 'hall', minX: -corridorHalf, maxX: corridorHalf, minZ: -halfD, maxZ: halfD });

  const stair: StairCell = {
    cx: 0,
    cz: stairCz,
    halfW: stairHalf,
    halfD: stairHalf,
    up: floor < spec.floors - 1,
    down: floor > 0,
  };

  return {
    floor,
    floors: spec.floors,
    halfW,
    halfD,
    wallHeight: INTERIOR_WALL_H,
    rooms,
    walls,
    stair,
    entry: { x: 0, z: stairCz },
    doorway: { x: 0, z: halfD },
  };
}

/** Axis-aligned rectangle, center + half-extents (matches WallBox shape). */
export interface RectBox {
  cx: number;
  cz: number;
  halfW: number;
  halfD: number;
}

function rectFrom(minX: number, maxX: number, minZ: number, maxZ: number): RectBox {
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, halfW: (maxX - minX) / 2, halfD: (maxZ - minZ) / 2 };
}

/**
 * Tiles a centered rectangle into up to 4 boxes that cover it minus a hole —
 * used to punch the stairwell shaft through a floor or ceiling slab instead
 * of rendering one solid plate that the stairs visually clip through.
 */
export function rectMinusHole(halfW: number, halfD: number, hole: RectBox | null): RectBox[] {
  if (!hole) return [{ cx: 0, cz: 0, halfW, halfD }];
  const minX = -halfW;
  const maxX = halfW;
  const minZ = -halfD;
  const maxZ = halfD;
  const hMinX = clamp(hole.cx - hole.halfW, minX, maxX);
  const hMaxX = clamp(hole.cx + hole.halfW, minX, maxX);
  const hMinZ = clamp(hole.cz - hole.halfD, minZ, maxZ);
  const hMaxZ = clamp(hole.cz + hole.halfD, minZ, maxZ);
  const out: RectBox[] = [];
  if (hMinZ - minZ > 0.05) out.push(rectFrom(minX, maxX, minZ, hMinZ));
  if (maxZ - hMaxZ > 0.05) out.push(rectFrom(minX, maxX, hMaxZ, maxZ));
  if (hMinX - minX > 0.05) out.push(rectFrom(minX, hMinX, hMinZ, hMaxZ));
  if (maxX - hMaxX > 0.05) out.push(rectFrom(hMaxX, maxX, hMinZ, hMaxZ));
  return out;
}

/** Deterministic point inside a room, inset from its walls. */
function pointIn(room: Room, seed: string, salt: number, margin = 0.7): [number, number] {
  const w = Math.max(0.1, room.maxX - room.minX - margin * 2);
  const d = Math.max(0.1, room.maxZ - room.minZ - margin * 2);
  const x = room.minX + margin + hash01(seed, salt) * w;
  const z = room.minZ + margin + hash01(seed, salt + 1) * d;
  return [x, z];
}

/**
 * Furniture kit per room, keyed off each room's *role* (which already
 * reflects the building's architectural type) plus the exterior style for
 * cosmetic variation, so a mansion's dining room looks different from an
 * office's break room, and two houses don't furnish identically.
 */
export function generateFurniture(floorplan: Floorplan, style: 0 | 1 | 2, buildingId: string): FurniturePiece[] {
  const out: FurniturePiece[] = [];
  const seed = `${buildingId}-furn-${floorplan.floor}`;

  const put = (
    kind: FurnitureKind,
    position: [number, number, number],
    scale: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0],
  ) => out.push({ kind, position, scale, rotation });

  floorplan.rooms.forEach((room, i) => {
    if (room.role === 'stair' || room.role === 'hall') return;
    const roomSeed = `${seed}-${i}`;
    const rot = hash01(roomSeed, 3) > 0.5 ? Math.PI / 2 : 0;
    const cx = (room.minX + room.maxX) / 2;
    const cz = (room.minZ + room.maxZ) / 2;

    if (room.role === 'foyer') {
      put('rug', [cx, 0.02, cz], [Math.min(2.6, room.maxX - room.minX - 0.8), 0.04, Math.min(2.2, room.maxZ - room.minZ - 0.8)]);
      put('lamp', [room.minX + 0.6, 1.0, room.minZ + 0.6], [0.22, 2.0, 0.22]);
      return;
    }

    if (room.role === 'office') {
      const [dx, dz] = pointIn(room, roomSeed, 11);
      put('desk', [dx, 0.42, dz], [1.3, 0.84, 0.7], [0, rot, 0]);
      put('chair', [dx, 0.4, dz + (rot ? 0 : 0.55)], [0.45, 0.8, 0.45], [0, rot, 0]);
      if (hash01(roomSeed, 21) > 0.4) {
        const [sx, sz] = pointIn(room, roomSeed, 31);
        put('shelf', [sx, 0.9, sz], [1.0, 1.8, 0.35], [0, hash01(roomSeed, 41) > 0.5 ? Math.PI / 2 : 0, 0]);
      }
      return;
    }

    if (room.role === 'storage') {
      const count = 2 + Math.floor(hash01(roomSeed, 51) * 3);
      for (let c = 0; c < count; c++) {
        const [px, pz] = pointIn(room, roomSeed, 60 + c * 5, 0.6);
        const s = 0.55 + hash01(roomSeed, 65 + c) * 0.35;
        put('crate', [px, s / 2, pz], [s, s, s], [0, hash01(roomSeed, 70 + c) * Math.PI, 0]);
      }
      return;
    }

    if (room.role === 'lounge') {
      put('table', [cx, 0.4, cz], [1.1, 0.06, 1.1]);
      const seats = 2 + Math.floor(hash01(roomSeed, 81) * 2);
      for (let s = 0; s < seats; s++) {
        const a = (s / seats) * Math.PI * 2 + hash01(roomSeed, 90 + s);
        put(
          style === 2 ? 'crate' : 'chair',
          [cx + Math.cos(a) * 0.85, 0.38, cz + Math.sin(a) * 0.85],
          [0.42, 0.76, 0.42],
          [0, a, 0],
        );
      }
      if (style === 1 && hash01(roomSeed, 95) > 0.5) {
        const [bx, bz] = pointIn(room, roomSeed, 101, 0.8);
        put('bed', [bx, 0.28, bz], [1.0, 0.5, 2.0], [0, hash01(roomSeed, 111) > 0.5 ? Math.PI / 2 : 0, 0]);
      }
      return;
    }

    if (room.role === 'living') {
      const w = room.maxX - room.minX;
      const d = room.maxZ - room.minZ;
      put('rug', [cx, 0.02, cz], [Math.min(2.4, w - 0.8), 0.04, Math.min(2.0, d - 0.8)]);
      const sofaRot = w >= d ? Math.PI / 2 : 0;
      const [sx, sz] = pointIn(room, roomSeed, 12, 0.9);
      put('sofa', [sx, 0.38, sz], [1.8, 0.76, 0.8], [0, sofaRot, 0]);
      put('tv', [sx + (sofaRot ? 0 : 1.3), 0.6, sz + (sofaRot ? 1.3 : 0)], [0.06, 0.7, 1.2], [0, sofaRot, 0]);
      return;
    }

    if (room.role === 'kitchen') {
      put('counter', [room.minX + 0.4, 0.45, cz], [0.5, 0.9, room.maxZ - room.minZ - 1.0], [0, 0, 0]);
      put('stove', [room.minX + 0.4, 0.46, room.minZ + 0.7], [0.5, 0.86, 0.5]);
      put('shelf', [room.maxX - 0.35, 1.1, room.minZ + 0.6], [0.35, 1.4, 0.8], [0, Math.PI / 2, 0]);
      return;
    }

    if (room.role === 'bedroom') {
      const [bx, bz] = pointIn(room, roomSeed, 21, 0.7);
      put('bed', [bx, 0.28, bz], [1.3, 0.5, 2.0], [0, hash01(roomSeed, 31) > 0.5 ? Math.PI / 2 : 0, 0]);
      put('wardrobe', [room.minX + 0.4, 0.85, room.maxZ - 0.4], [0.7, 1.7, 0.5]);
      return;
    }

    if (room.role === 'bathroom') {
      put('sink', [room.minX + 0.35, 0.42, room.minZ + 0.4], [0.5, 0.84, 0.4]);
      put('toilet', [room.maxX - 0.35, 0.24, room.maxZ - 0.4], [0.42, 0.48, 0.42]);
      return;
    }

    if (room.role === 'dining') {
      put('diningTable', [cx, 0.4, cz], [1.5, 0.06, 0.9]);
      const seats = 4;
      for (let s = 0; s < seats; s++) {
        const along = s < 2 ? -0.6 : 0.6;
        const across = s % 2 === 0 ? -0.55 : 0.55;
        put('chair', [cx + along, 0.38, cz + across], [0.42, 0.76, 0.42], [0, s % 2 === 0 ? Math.PI / 2 : -Math.PI / 2, 0]);
      }
      return;
    }

    if (room.role === 'garage') {
      put('car', [cx, 0.42, cz], [1.7, 0.84, 3.6], [0, hash01(roomSeed, 141) > 0.5 ? Math.PI / 2 : 0, 0]);
      put('shelf', [room.maxX - 0.35, 0.9, room.minZ + 0.5], [0.35, 1.8, 0.7], [0, Math.PI / 2, 0]);
      return;
    }
  });

  return out;
}
