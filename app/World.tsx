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

interface Patch {
  id: string;
  x: number;
  z: number;
  sketch: string;
  seed: number;
}

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

/* ------------------------------------------------------------- controls --- */

function Walker({
  built,
  channel,
  selfId,
  onOpenDraw,
}: {
  built: { patch: Patch; terrain: TerrainData }[];
  channel: React.RefObject<RealtimeChannel | null>;
  selfId: string;
  onOpenDraw: (x: number, z: number) => void;
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
        onOpenDraw(camera.position.x, camera.position.z);
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
  }, [camera, onOpenDraw]);

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
  const [drawAt, setDrawAt] = useState<{ x: number; z: number } | null>(null);
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
  const commit = useCallback(
    (grid: Float32Array<ArrayBuffer>, x: number, z: number) => {
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
    },
    [],
  );

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

        <Walker
          built={built}
          channel={channelRef}
          selfId={selfId}
          onOpenDraw={(x, z) => setDrawAt({ x, z })}
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
          <span className="text-white/85">E</span> to raise mountains here ·{' '}
          <span className="text-white/85">Esc</span> to release
        </p>
      </div>

      {drawAt && (
        <DrawPanel
          onCancel={() => setDrawAt(null)}
          onCommit={(grid) => commit(grid, drawAt.x, drawAt.z)}
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
  onCommit: (grid: Float32Array<ArrayBuffer>) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 512, 512);
  }, []);

  const paint = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * c.width;
    const y = ((e.clientY - r.top) / r.height) * c.height;

    // Soft wide brush: gradients give the heightmap slopes to work with,
    // where a hard 1px pen produces a wall.
    const g = ctx.createRadialGradient(x, y, 0, x, y, 28);
    g.addColorStop(0, 'rgba(0,0,0,0.9)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 28, 0, Math.PI * 2);
    ctx.fill();
  }, []);

  const submit = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const img = ctx.getImageData(0, 0, c.width, c.height);

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
              (0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]) / 255;
            acc += 1 - lum; // dark ink = high ground
            n++;
          }
        }
        grid[gy * SKETCH_GRID + gx] = n ? acc / n : 0;
      }
    }
    onCommit(grid);
  }, [onCommit]);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-neutral-900 p-6">
        <h2 className="text-lg font-semibold text-white">Raise mountains here</h2>
        <p className="mt-1 text-sm text-white/60">
          Draw a ridgeline — darker and thicker means higher ground.
        </p>

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
