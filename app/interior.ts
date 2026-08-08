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

export type RoomRole = 'foyer' | 'office' | 'storage' | 'lounge' | 'stair';

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
  | 'bed';

export interface FurniturePiece {
  kind: FurnitureKind;
  /** Local x, floor-relative y, local z. */
  position: [number, number, number];
  scale: [number, number, number];
  rotation: [number, number, number];
}

export interface BuildingSpec {
  id: string;
  width: number;
  depth: number;
  floors: number;
  style: 0 | 1 | 2;
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

/** One wall run with an optional passable gap in the middle. */
function pushWallRun(
  walls: WallBox[],
  axis: 'x' | 'z',
  p: number,
  spanMin: number,
  spanMax: number,
  gap?: { center: number; half: number },
): void {
  const segments: [number, number][] = [];
  if (!gap) {
    segments.push([spanMin, spanMax]);
  } else {
    if (gap.center - gap.half > spanMin) segments.push([spanMin, gap.center - gap.half]);
    if (gap.center + gap.half < spanMax) segments.push([gap.center + gap.half, spanMax]);
  }
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
 */
function splitRooms(halfW: number, halfD: number, seed: string): { rects: Rect[]; walls: WallBox[] } {
  const full: Rect = { minX: -halfW, maxX: halfW, minZ: -halfD, maxZ: halfD };
  const targetRooms = clamp(Math.round(rectArea(full) / 22), 2, 4);

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
      pushWallRun(walls, 'x', p, r.minZ, r.maxZ, { center: gz, half: DOOR_GAP / 2 });
    } else {
      const p = r.minZ + d * ratio;
      rects.splice(idx, 1, { ...r, maxZ: p }, { ...r, minZ: p });
      const gx = r.minX + 1.4 + gapT * Math.max(0.1, w - 2.8);
      pushWallRun(walls, 'z', p, r.minX, r.maxX, { center: gx, half: DOOR_GAP / 2 });
    }
    iter++;
  }

  return { rects, walls };
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

  const { rects, walls: innerWalls } = splitRooms(halfW, halfD, seed);
  const walls: WallBox[] = [...innerWalls];

  // Exterior perimeter. Only the ground floor has a door gap; upper floors
  // are only reachable via the stairwell. Same gap width the exterior shell
  // carves into its own front wall, so neither side ever has a lip to catch on.
  const doorHalf = spec.doorW / 2 + 0.25;
  pushWallRun(walls, 'z', halfD, -halfW, halfW, floor === 0 ? { center: 0, half: doorHalf } : undefined);
  pushWallRun(walls, 'z', -halfD, -halfW, halfW);
  pushWallRun(walls, 'x', halfW, -halfD, halfD);
  pushWallRun(walls, 'x', -halfW, -halfD, halfD);

  // Stair room: deterministic pick, biased away from whichever room touches
  // the door so the foyer stays open.
  const stairRoomIdx = Math.floor(hash01(seed, 555) * rects.length) % rects.length;
  let foyerRoomIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.minX <= 0.1 && r.maxX >= -0.1) {
      const dist = halfD - r.maxZ;
      if (dist < bestDist) {
        bestDist = dist;
        foyerRoomIdx = i;
      }
    }
  }

  const roles: RoomRole[] = rects.map(() => 'office');
  roles[stairRoomIdx] = 'stair';
  if (foyerRoomIdx !== stairRoomIdx) roles[foyerRoomIdx] = 'foyer';
  for (let i = 0; i < rects.length; i++) {
    if (roles[i] !== 'office') continue;
    const t = hash01(`${seed}-role-${floor}-${i}`, 77);
    roles[i] = t < 0.34 ? 'storage' : t < 0.67 ? 'lounge' : 'office';
  }

  const stairRoom = rects[stairRoomIdx];
  const cellW = Math.min(STAIR_SIZE, stairRoom.maxX - stairRoom.minX - 0.6);
  const cellD = Math.min(STAIR_SIZE, stairRoom.maxZ - stairRoom.minZ - 0.6);
  const stair: StairCell | null =
    spec.floors > 1
      ? {
          cx: (stairRoom.minX + stairRoom.maxX) / 2,
          cz: (stairRoom.minZ + stairRoom.maxZ) / 2,
          halfW: Math.max(0.9, cellW / 2),
          halfD: Math.max(0.9, cellD / 2),
          up: floor < spec.floors - 1,
          down: floor > 0,
        }
      : null;

  const foyerRoom = rects[foyerRoomIdx];
  const entry = { x: 0, z: clamp(halfD - 1.3, foyerRoom.minZ + 0.6, foyerRoom.maxZ - 0.4) };
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
 * Furniture kit per room, themed by the building's exterior style so the
 * inside feels like it belongs to the same building (civic / tower / market).
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
    if (room.role === 'stair') return;
    const roomSeed = `${seed}-${i}`;
    const rot = hash01(roomSeed, 3) > 0.5 ? Math.PI / 2 : 0;

    if (room.role === 'foyer') {
      const cx = (room.minX + room.maxX) / 2;
      const cz = (room.minZ + room.maxZ) / 2;
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
        const [cx, cz] = pointIn(room, roomSeed, 60 + c * 5, 0.6);
        const s = 0.55 + hash01(roomSeed, 65 + c) * 0.35;
        put('crate', [cx, s / 2, cz], [s, s, s], [0, hash01(roomSeed, 70 + c) * Math.PI, 0]);
      }
      return;
    }

    // lounge
    const cx = (room.minX + room.maxX) / 2;
    const cz = (room.minZ + room.maxZ) / 2;
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
  });

  return out;
}
