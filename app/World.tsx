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

import {
  buildPatch,
  encodeSketch,
  heightAt,
  styleFor,
  STYLES,
  SKETCH_GRID,
  PATCH_SCALE,
  type BuiltPatch,
} from './world/terrain';
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

const EYE = 1.8;

interface Patch {
  id: string;
  x: number;
  z: number;
  sketch: string;
  seed: number;
  /** Named style from the picker or the text agent: "icy", "blossom"… */
  style?: string;
}

/* -------------------------------------------------------------- terrain --- */

/**
 * A contributed massif.
 *
 * Heights and colours arrive already finished from buildPatch — the rim
 * falloff is baked in and the shading is style-driven. All this does is push
 * them into a BufferGeometry, so it is safe to re-run and it can never
 * disagree with what heightAt() reports underfoot.
 */
function PatchMesh({ built }: { built: BuiltPatch }) {
  const { terrain, colors, style } = built;

  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(
      terrain.scale,
      terrain.scale,
      terrain.size - 1,
      terrain.size - 1,
    );
    g.rotateX(-Math.PI / 2);

    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, terrain.heights[i] ?? 0);
    }
    pos.needsUpdate = true;

    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, [terrain, colors]);

  // Dispose on unmount — with hundreds of contributions, leaked geometries are
  // what eventually kills the framerate on a phone.
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Volcanic peaks glow; everything else is plain rock. Smooth shading on the
  // soft styles, faceted on the sharp ones.
  const isVolcanic = style.name === 'volcanic';

  return (
    <mesh geometry={geometry} position={[built.x, 0, built.z]} receiveShadow castShadow>
      <meshStandardMaterial
        vertexColors
        roughness={style.name === 'icy' ? 0.55 : 0.93}
        metalness={0}
        flatShading={style.shape.ridged > 0.4}
        emissive={isVolcanic ? new THREE.Color('#ff4a10') : undefined}
        emissiveIntensity={isVolcanic ? 0.35 : 0}
      />
    </mesh>
  );
}

/** Max across overlapping patches, so contributions stack into ridges. */
function groundAt(built: BuiltPatch[], wx: number, wz: number): number {
  let h = 0;
  for (const patch of built) {
    const { terrain } = patch;
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
  built: BuiltPatch[];
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
  const cache = useRef<Map<string, BuiltPatch>>(new Map());
  const built = useMemo(
    () =>
      patches.map((patch) => {
        // Key on style too: re-styling a patch must rebuild it, and a stale
        // entry would otherwise show the old palette forever.
        const key = `${patch.id}:${patch.style ?? 'default'}`;
        let b = cache.current.get(key);
        if (!b) {
          b = buildPatch(patch);
          cache.current.set(key, b);
        }
        return b;
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
        style: typeof props.style === 'string' ? props.style : undefined,
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
    (grid: Float32Array<ArrayBuffer>, x: number, z: number, style?: string) => {
      const sketch = encodeSketch(grid);
      const seed = Math.floor(Math.random() * 1e9);
      const tempId = `temp-${seed}`;

      // Optimistic: the terrain is under your feet immediately, and the write
      // reconciles behind it.
      setPatches((prev) => [...prev, { id: tempId, x, z, sketch, seed, style }]);
      setDrawAt(null);

      if (!supabase) return;

      supabase
        .from('world_assets')
        .insert({
          x,
          z,
          type: 'terrain',
          color: styleFor(style).palette.high,
          properties: { sketch, seed, style },
        })
        .select()
        .then(({ data, error }) => {
          setPatches((prev) => {
            const without = prev.filter((p) => p.id !== tempId);
            if (error || !data?.length) return without; // roll back on failure
            const row = data[0] as Record<string, unknown>;
            const id = String(row.id);

            // Hand the already-synthesized patch to its real id so the insert
            // doesn't cost a second synthesize.
            const tempKey = `${tempId}:${style ?? 'default'}`;
            const realKey = `${id}:${style ?? 'default'}`;
            const existing = cache.current.get(tempKey);
            if (existing) {
              cache.current.set(realKey, { ...existing, id });
              cache.current.delete(tempKey);
            }

            return without.some((p) => p.id === id)
              ? without
              : [...without, { id, x, z, sketch, seed, style }];
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
        {built.map((b) => (
          <PatchMesh key={b.id} built={b} />
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
          onCommit={(grid, style) => commit(grid, drawAt.x, drawAt.z, style)}
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
  onCommit: (grid: Float32Array<ArrayBuffer>, style: string) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [style, setStyle] = useState('default');

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
    onCommit(grid, style);
  }, [onCommit, style]);

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

        {/* Style picker. Each swatch previews its own palette, so the choice
            is legible without having to raise the terrain first. */}
        <div className="mt-4">
          <p className="text-xs font-medium tracking-wide text-white/50 uppercase">Style</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.values(STYLES).map((s) => {
              const active = s.name === style;
              return (
                <button
                  key={s.name}
                  onClick={() => setStyle(s.name)}
                  aria-pressed={active}
                  className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition ${
                    active
                      ? 'border-emerald-400 bg-emerald-400/15 text-white'
                      : 'border-white/15 text-white/70 hover:bg-white/10'
                  }`}
                >
                  <span
                    className="h-3 w-3 rounded-full border border-black/30"
                    style={{
                      background: `linear-gradient(135deg, ${s.palette.mid}, ${s.palette.peak})`,
                    }}
                  />
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>

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
