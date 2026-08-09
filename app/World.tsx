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
const PROXIMITY_AUDIO_DISTANCE = 50; // Max distance in meters to hear animal

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
}

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

/* ---------------------------------------------------------------- animal --- */

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
      const speed = 4.0;
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
  const elapsedTime = useRef(0);

  useFrame((state, delta) => {
    if (!group.current) return;
    elapsedTime.current += delta;
    
    target.current.set(traveller.x, traveller.y ?? 0, traveller.z);
    group.current.position.lerp(target.current, 1 - Math.pow(0.002, delta));
    group.current.position.y += Math.sin(elapsedTime.current * 2) * 0.05;
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
  channel,
  selfId,
  onOpenDraw,
  onOpenAnimalDraw,
  isModalOpen,
}: {
  built: { patch: Patch; terrain: TerrainData }[];
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
  const locked = useRef(false);

  // Force exit pointer lock whenever the draw modal opens
  useEffect(() => {
    if (isModalOpen) {
      document.exitPointerLock();
    }
  }, [isModalOpen]);

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
      if (locked.current) {
        if (e.code === 'KeyE') {
          e.preventDefault();
          document.exitPointerLock();
          onOpenDraw(camera.position.x, camera.position.z);
        } else if (e.code === 'KeyR') {
          e.preventDefault();
          document.exitPointerLock();
          onOpenAnimalDraw(camera.position.x, camera.position.z);
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
  }, [camera, onOpenDraw, onOpenAnimalDraw, isModalOpen]);

  useFrame((_, delta) => {
    if (isModalOpen) return;

    const m = move.current;
    const speed = (m.sprint ? 40 : 16) * delta;
    const fwd = Number(m.b) - Number(m.f);
    const side = Number(m.r) - Number(m.l);

    if (fwd || side) {
      dir.current.set(side, 0, fwd).applyQuaternion(camera.quaternion);
      dir.current.y = 0;
      if (dir.current.lengthSq() > 0) {
        dir.current.normalize().multiplyScalar(speed);
        camera.position.add(dir.current);
      }
    }

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
        seen: now,
      });
    }
  });

  // Completely unmount PointerLockControls while drawing so pointer clicks do not re-trigger lock
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
  const [animals, setAnimals] = useState<AnimalData[]>([]);
  const [travellers, setTravellers] = useState<Traveller[]>([]);
  const [drawAt, setDrawAt] = useState<{ x: number; z: number } | null>(null);
  const [animalDrawAt, setAnimalDrawAt] = useState<{ x: number; z: number } | null>(null);
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

    const toAnimal = (r: Record<string, unknown>): AnimalData | null => {
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
      };
    };

    supabase
      .from('world_assets')
      .select('*')
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        
        const nextPatches: Patch[] = [];
        const nextAnimals: AnimalData[] = [];

        for (const row of data) {
          if (row.type === 'terrain') {
            const p = toPatch(row as Record<string, unknown>);
            if (p) nextPatches.push(p);
          } else if (row.type === 'animal') {
            const a = toAnimal(row as Record<string, unknown>);
            if (a) nextAnimals.push(a);
          }
        }

        setPatches(nextPatches);
        setAnimals(nextAnimals);
      });

    const channel = supabase
      .channel('public:world_assets')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'world_assets' },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          if (row.type === 'terrain') {
            const p = toPatch(row);
            if (p) setPatches((prev) => (prev.some((q) => q.id === p.id) ? prev : [...prev, p]));
          } else if (row.type === 'animal') {
            const a = toAnimal(row);
            if (a) setAnimals((prev) => (prev.some((q) => q.id === a.id) ? prev : [...prev, a]));
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

  /* -------- contribute terrain -------- */
  const commit = useCallback(
    (grid: Float32Array, x: number, z: number) => {
      const sketch = encodeSketch(grid);
      const seed = Math.floor(Math.random() * 1e9);
      const tempId = `temp-${seed}`;

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
    },
    [],
  );

  /* -------- contribute animal -------- */
  const commitAnimal = useCallback(
    (
      outlineGrid: Uint8Array,
      patternGrid: Uint8Array,
      soundDataUrl: string | null,
      path: { x: number; z: number }[] | null,
      x: number,
      z: number,
    ) => {
      const outlineSketch = encodeColorSketch(outlineGrid);
      const patternSketch = encodeColorSketch(patternGrid);
      const tempId = `temp-animal-${Math.random() * 1e9}`;

      setAnimals((prev) => [...prev, { id: tempId, x, z, outlineSketch, patternSketch, soundDataUrl, path }]);
      setAnimalDrawAt(null);
      setIsRecordingPath(false);
      setRecordedPath(null);

      if (!supabase) return;

      supabase
        .from('world_assets')
        .insert({ x, z, type: 'animal', properties: { outlineSketch, patternSketch, soundDataUrl, path } })
        .select()
        .then(({ data, error }) => {
          setAnimals((prev) => {
            const without = prev.filter((a) => a.id !== tempId);
            if (error || !data?.length) return without;
            const row = data[0] as Record<string, unknown>;
            const id = String(row.id);
            return without.some((a) => a.id === id)
              ? without
              : [...without, { id, x, z, outlineSketch, patternSketch, soundDataUrl, path }];
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

  const isModalOpen = drawAt !== null || (animalDrawAt !== null && !isRecordingPath);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black select-none">
      <Canvas
        shadows={{ type: THREE.PCFShadowMap }}
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

        {animals.map((a) => (
          <AnimalMesh key={a.id} animal={a} built={built} />
        ))}

        {travellers.map((t) => (
          <Wisp key={t.id} traveller={t} />
        ))}

        <PathRecorder
          isRecording={isRecordingPath}
          onComplete={(path) => {
            setIsRecordingPath(false);
            setRecordedPath(path);
          }}
        />

        <Walker
          built={built}
          channel={channelRef}
          selfId={selfId}
          onOpenDraw={(x, z) => setDrawAt({ x, z })}
          onOpenAnimalDraw={(x, z) => {
            setAnimalDrawAt({ x, z });
            setRecordedPath(null);
            setIsRecordingPath(false);
          }}
          isModalOpen={isModalOpen}
        />
      </Canvas>

      <div className="pointer-events-none absolute left-6 top-6 rounded-lg bg-black/50 p-4 backdrop-blur">
        <h1 className="text-lg font-semibold text-white">Infinite Terra</h1>
        <p className="mt-1 text-sm text-white/70">
          {patches.length} landform{patches.length === 1 ? '' : 's'} · {animals.length} animal{animals.length === 1 ? '' : 's'} · {label}
        </p>
      </div>

      <div className="pointer-events-none absolute bottom-6 left-6 space-y-1 text-xs text-white/55">
        <p>
          <span className="text-white/85">Click</span> to look ·{' '}
          <span className="text-white/85">WASD</span> to walk ·{' '}
          <span className="text-white/85">Shift</span> to run
        </p>
        <p>
          <span className="text-white/85">E</span> to raise mountains ·{' '}
          <span className="text-white/85">R</span> to create animal ·{' '}
          <span className="text-white/85">Esc</span> to release
        </p>
      </div>

      {drawAt && (
        <DrawPanel
          onCancel={() => setDrawAt(null)}
          onCommit={(grid) => commit(grid, drawAt.x, drawAt.z)}
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
          onCommit={(outlineGrid, patternGrid, soundDataUrl, path) =>
            commitAnimal(outlineGrid, patternGrid, soundDataUrl, path, animalDrawAt.x, animalDrawAt.z)
          }
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ draw panel --- */

export function DrawPanel({
  onCommit,
  onCancel,
}: {
  onCommit: (grid: Float32Array) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  const [color, setColor] = useState('#000000');
  const [markerSize, setMarkerSize] = useState(16);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 512, 512);
  }, []);

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

    // Draw a point immediately for single taps
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

  const submit = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const img = ctx.getImageData(0, 0, c.width, c.height);

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
              (0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]) / 255;
            acc += 1 - lum;
            n++;
          }
        }
        grid[gy * SKETCH_GRID + gx] = n ? acc / n : 0;
      }
    }
    onCommit(grid);
  }, [onCommit]);

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-neutral-900 p-6">
        <h2 className="text-lg font-semibold text-white">Raise mountains here</h2>
        <p className="mt-1 text-sm text-white/60">
          Draw a ridgeline — darker strokes create higher ground.
        </p>

        {/* Toolbar: Colors and Marker Sizes */}
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

        <div className="mt-4 flex justify-end gap-3">
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
            Raise it
          </button>
        </div>
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
  ) => void;
  onCancel: () => void;
  isRecordingPath?: boolean;
  onStartPathRecord?: () => void;
  recordedPath?: { x: number; z: number }[] | null;
}) {
  const [step, setStep] = useState<'outline' | 'pattern' | 'sound' | 'path'>('outline');
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
    onCommit(outlineGrid, patternGrid, soundDataUrl, recordedPath || null);
  };

  if (isRecordingPath) {
    return (
      <div className="pointer-events-none absolute inset-0 z-50 flex items-start justify-center pt-24">
        <div className="rounded-full bg-red-500/90 px-6 py-3 text-lg font-bold text-white shadow-lg animate-pulse">
          🔴 Recording Path... {pathTimeLeft > 0 ? pathTimeLeft : 0}s
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
              <div className="text-center space-y-3">
                <p className="text-sm text-emerald-400 font-medium">
                  ✓ Path recorded ({recordedPath.length} points)
                </p>
                <button
                  onClick={handleStartPathRecord}
                  className="text-xs text-white/60 hover:text-white underline"
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
                  🚶 Walk 5s Path
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