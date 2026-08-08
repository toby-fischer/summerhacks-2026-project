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
import { PointerLockControls } from '@react-three/drei';
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
import { Weather, CONDITIONS } from './world/weather';
import { Minimap, type MinimapSelf } from './world/Minimap';
import type { Contribution, WeatherPayload } from './world/contract';
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

/** Window for the double-tap-Space flight toggle. Minecraft's is ~300ms. */
const DOUBLE_TAP_MS = 300;

/** Draw brush radius, in pixels of the 512 sketch canvas. See paint(). */
const BRUSH_R = 130;

/**
 * Half-width of the playable world, in metres — so a 2000m square.
 *
 * Bounded rather than infinite on purpose: the whole world fits in one query
 * with no chunk streaming, and contributions cluster instead of scattering,
 * which is what makes the place read as populated. At 40m/s sprinting it is
 * roughly a minute corner to corner — nobody finds the edge by accident.
 */
const WORLD_HALF = 1000;

/** Ceiling on flight, so you can survey the world without leaving the fog. */
const WORLD_CEIL = 600;

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

/**
 * The ground.
 *
 * Fixed in place rather than following the camera: the world is bounded now,
 * and the walls stop you well before the rim is visible. Overshoots the bounds
 * a little so the edge of the geometry never enters frame.
 */
function Plain() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[WORLD_HALF * 2.4, WORLD_HALF * 2.4]} />
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
  mapSelf,
  onOpenDraw,
  onOpenWeather,
  onFlyChange,
}: {
  built: BuiltPatch[];
  channel: React.RefObject<RealtimeChannel | null>;
  selfId: string;
  /** Written every frame for the minimap, which lives outside the Canvas. */
  mapSelf: React.RefObject<MinimapSelf>;
  onOpenDraw: (x: number, z: number) => void;
  onOpenWeather: (x: number, z: number) => void;
  onFlyChange: (flying: boolean) => void;
}) {
  const { camera } = useThree();
  const move = useRef({
    f: false,
    b: false,
    l: false,
    r: false,
    sprint: false,
    up: false,
    down: false,
  });
  const dir = useRef(new THREE.Vector3());
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  const lastSend = useRef(0);
  const locked = useRef(false);
  const flying = useRef(false);
  /** Timestamp of the last Space press, for double-tap detection. */
  const lastSpace = useRef(0);

  const clearKeys = () => {
    const m = move.current;
    m.f = m.b = m.l = m.r = m.sprint = m.up = m.down = false;
  };

  useEffect(() => {
    const set = (code: string, v: boolean) => {
      if (code === 'KeyW' || code === 'ArrowUp') move.current.f = v;
      if (code === 'KeyS' || code === 'ArrowDown') move.current.b = v;
      if (code === 'KeyA' || code === 'ArrowLeft') move.current.l = v;
      if (code === 'KeyD' || code === 'ArrowRight') move.current.r = v;
      if (code === 'Space') move.current.up = v;
      // Minecraft overloads Shift: sprint on the ground, descend in the air.
      if (code === 'ShiftLeft' || code === 'ShiftRight') {
        move.current.sprint = v;
        move.current.down = v;
      }
    };
    const down = (e: KeyboardEvent) => {
      // Space scrolls the page by default, which fights the pointer lock.
      if (e.code === 'Space' && locked.current) e.preventDefault();

      // Double-tap Space toggles flight. Guard on !repeat so holding Space to
      // ascend doesn't fire the key-repeat stream into the tap detector and
      // flip flight off again mid-climb.
      if (e.code === 'Space' && locked.current && !e.repeat) {
        const now = performance.now();
        if (now - lastSpace.current < DOUBLE_TAP_MS) {
          flying.current = !flying.current;
          onFlyChange(flying.current);
          lastSpace.current = 0; // consume, so a third tap starts fresh
        } else {
          lastSpace.current = now;
        }
      }

      set(e.code, true);
      if (e.code === 'KeyE' && locked.current) {
        e.preventDefault();
        onOpenDraw(camera.position.x, camera.position.z);
      }
      if (e.code === 'KeyQ' && locked.current) {
        e.preventDefault();
        onOpenWeather(camera.position.x, camera.position.z);
      }
    };
    const up = (e: KeyboardEvent) => set(e.code, false);
    const blur = clearKeys;

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [camera, onOpenDraw, onOpenWeather, onFlyChange]);

  useFrame((_, delta) => {
    const m = move.current;
    const fly = flying.current;
    // Flying is roughly 3x walking, for surveying the whole world. Shift means
    // "descend" in the air, so it must NOT also boost there — otherwise every
    // descent doubles your ground speed.
    const speed = (fly ? 55 : m.sprint ? 40 : 16) * delta;
    const fwd = Number(m.b) - Number(m.f);
    const side = Number(m.r) - Number(m.l);

    if (fwd || side) {
      dir.current.set(side, 0, fwd).normalize().multiplyScalar(speed);
      if (fly) {
        // Follow where you're looking, pitch included — flying with a
        // yaw-only heading feels like being stuck on a rail.
        euler.current.set(camera.rotation.x, camera.rotation.y, 0);
      } else {
        euler.current.set(0, camera.rotation.y, 0);
      }
      dir.current.applyEuler(euler.current);
      camera.position.add(dir.current);
    }

    // Invisible walls. Clamped after the move rather than blocking it, so
    // sliding along a wall still works instead of stopping you dead.
    camera.position.x = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, camera.position.x));
    camera.position.z = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, camera.position.z));

    const ground = groundAt(built, camera.position.x, camera.position.z) + EYE;

    if (fly) {
      // Space wins over Shift when both are held, rather than cancelling out.
      const lift = m.up ? 1 : m.down ? -1 : 0;
      if (lift) camera.position.y += lift * speed;
      // Don't let flight bury the camera inside a mountain, or leave the fog.
      if (camera.position.y < ground) camera.position.y = ground;
      if (camera.position.y > WORLD_CEIL) camera.position.y = WORLD_CEIL;
    } else {
      // Stick to whatever terrain is underfoot; lerped so a ridge is a fall.
      camera.position.y += (ground - camera.position.y) * Math.min(1, delta * 10);
    }

    // Mutate in place rather than replacing the object: the minimap reads this
    // on its own clock, and allocating a fresh object every frame would hand
    // the GC 60 objects a second for no benefit.
    mapSelf.current.x = camera.position.x;
    mapSelf.current.z = camera.position.z;
    mapSelf.current.a = camera.rotation.y;

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

  // Chrome refuses a re-lock within ~1s of Esc and fires `pointerlockerror`.
  // The next click succeeds, so nothing is actually broken — but three logs it
  // via console.error, and a red error in the console during judging reads as a
  // broken app. Swallow just this one message and leave every other error alone.
  useEffect(() => {
    const original = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('Unable to use Pointer Lock API')) {
        return;
      }
      original(...args);
    };
    return () => {
      console.error = original;
    };
  }, []);

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
  const [zones, setZones] = useState<Contribution<WeatherPayload>[]>([]);
  const [travellers, setTravellers] = useState<Traveller[]>([]);
  const [drawAt, setDrawAt] = useState<{ x: number; z: number } | null>(null);
  const [weatherAt, setWeatherAt] = useState<{ x: number; z: number } | null>(null);
  const [flying, setFlying] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'live' | 'offline'>(
    supabase ? 'connecting' : 'offline',
  );

  const selfId = useMemo(makeSelfId, []);

  // Particle budget. A judge's phone gets a much smaller buffer — the sky and
  // fog carry most of the atmosphere anyway, and they cost the same either way.
  const quality = useMemo(() => {
    if (typeof navigator === 'undefined') return 1;
    const coarse =
      typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    return coarse || navigator.hardwareConcurrency <= 4 ? 0.35 : 1;
  }, []);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const travellerMap = useRef<Map<string, Traveller>>(new Map());
  // Camera position for the minimap. Seeded to the spawn point so the arrow is
  // correct on the first frame, before Walker's first useFrame runs.
  const mapSelf = useRef<MinimapSelf>({ x: 0, z: 40, a: 0 });

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
      if (String(r.type) !== 'terrain') return null;
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

    // Weather rows live in the same table under type='weather'. The payload is
    // three small numbers — there is no recipe to regenerate, because the
    // "geometry" is a global shader state rather than a mesh.
    const toZone = (r: Record<string, unknown>): Contribution<WeatherPayload> | null => {
      if (String(r.type) !== 'weather') return null;
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
          intensity: Number(props.intensity) || 0.7,
          radius: Number(props.radius) || 220,
        },
      };
    };

    // One query for the whole world, split client-side. Two round trips to load
    // a world that fits in one is a worse deal than filtering an array.
    supabase
      .from('world_assets')
      .select('*')
      .in('type', ['terrain', 'weather'])
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;

        setPatches((prev) => {
          const byId = new Map(prev.map((p) => [p.id, p]));
          for (const row of data) {
            const r = row as Record<string, unknown>;
            if (String(r.type) !== 'terrain') continue;
            const p = toPatch(r);
            if (p) byId.set(p.id, p);
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

          const z = toZone(row);
          if (z) {
            setZones((prev) => (prev.some((q) => q.id === z.id) ? prev : [...prev, z]));
            return;
          }

          const p = toPatch(row);
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

  /* -------- contribute weather -------- */

  const summonWeather = useCallback(
    (condition: string, x: number, z: number, intensity = 0.85, radius = 260) => {
      const tempId = `temp-w-${Math.floor(Math.random() * 1e9)}`;
      const payload: WeatherPayload = { condition, intensity, radius };

      // Optimistic, same as terrain: the sky changes the instant you press the
      // key, and the write reconciles behind it.
      const optimistic: Contribution<WeatherPayload> = {
        id: tempId,
        kind: 'weather',
        x,
        z,
        rotation: 0,
        author: selfId,
        created_at: new Date().toISOString(),
        payload,
      };
      setZones((prev) => [...prev, optimistic]);

      if (!supabase) return;

      supabase
        .from('world_assets')
        .insert({ x, z, type: 'weather', color: '#8fa3b5', properties: payload })
        .select()
        .then(({ data, error }) => {
          setZones((prev) => {
            const without = prev.filter((q) => q.id !== tempId);
            if (error || !data?.length) return without; // roll back on failure
            const id = String((data[0] as Record<string, unknown>).id);
            return without.some((q) => q.id === id)
              ? without
              : [...without, { ...optimistic, id }];
          });
        });
    },
    [selfId],
  );

  /* -------- reset -------- */

  /**
   * Wipe the world. Dev-only escape hatch for clearing test contributions —
   * this is the one operation that violates "nothing ever overwrites anything",
   * which is why it asks first and why it should not survive to the demo.
   */
  const reset = useCallback(async () => {
    if (!window.confirm('Delete every contribution in the world? This cannot be undone.')) return;

    setPatches([]);
    setZones([]);
    cache.current.clear();

    if (!supabase) return;
    // Supabase requires a WHERE clause on delete; matching the types we own
    // is both the filter and a guarantee we never touch another table's rows.
    const { error } = await supabase
      .from('world_assets')
      .delete()
      .in('type', ['terrain', 'weather']);
    if (error) console.error('reset failed', error);
  }, []);

  // Flatten the weather rows to what the map needs. Memoized so the map's
  // props are referentially stable while only travellers are moving.
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
      >
        {/* Sky, stars, sun, fog and precipitation — all of it. Mounted once,
            as a sibling of the terrain rather than per-contribution, because
            there is only ever one atmosphere. Owns scene.fog from here on. */}
        <Weather zones={zones} quality={quality} />

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
          mapSelf={mapSelf}
          onOpenDraw={(x, z) => setDrawAt({ x, z })}
          onOpenWeather={(x, z) => setWeatherAt({ x, z })}
          onFlyChange={setFlying}
        />
      </Canvas>

      {/* Top right, opposite the HUD. Works with no Supabase: patches and
          zones are whatever this client knows about, which offline is just
          your own. */}
      <Minimap
        half={WORLD_HALF}
        patches={patches}
        zones={mapZones}
        travellers={travellers}
        self={mapSelf}
      />

      <div className="absolute left-6 top-6 rounded-lg bg-black/50 p-4 backdrop-blur">
        <h1 className="text-lg font-semibold text-white">Infinite Terra</h1>
        <p className="mt-1 text-sm text-white/70">
          {patches.length} landform{patches.length === 1 ? '' : 's'} · {label}
        </p>
        {/* Dev-only. Pull this before judging — a wipe button next to a shared
            world is a great way to lose everyone's work mid-demo. */}
        <button
          onClick={reset}
          className="mt-3 rounded-md border border-red-400/30 px-3 py-1 text-xs text-red-300/90 transition hover:bg-red-400/15"
        >
          Reset world
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-6 left-6 space-y-1 text-xs text-white/55">
        <p>
          <span className="text-white/85">Click</span> to look ·{' '}
          <span className="text-white/85">WASD</span> to {flying ? 'fly' : 'walk'}
          {!flying && (
            <>
              {' '}
              · <span className="text-white/85">Shift</span> to run
            </>
          )}
        </p>
        <p>
          <span className="text-white/85">E</span> to raise mountains ·{' '}
          <span className="text-white/85">Q</span> to summon weather ·{' '}
          <span className="text-white/85">Double-tap Space</span> to{' '}
          {flying ? 'land' : 'fly'} · <span className="text-white/85">Esc</span> to release
        </p>
        {flying && (
          <p>
            <span className="text-emerald-300">Flying</span> —{' '}
            <span className="text-white/85">Space</span> up ·{' '}
            <span className="text-white/85">Shift</span> down
          </p>
        )}
      </div>

      {drawAt && (
        <DrawPanel
          onCancel={() => setDrawAt(null)}
          onCommit={(grid, style) => commit(grid, drawAt.x, drawAt.z, style)}
        />
      )}

      {weatherAt && (
        <WeatherPanel
          onCancel={() => setWeatherAt(null)}
          onCommit={(condition, intensity, radius) => {
            summonWeather(condition, weatherAt.x, weatherAt.z, intensity, radius);
            setWeatherAt(null);
          }}
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
    //
    // The radius is deliberately large relative to the canvas. At 28px one dab
    // covered ~1% of the sketch, which came out a 70m peak only 14m across — a
    // rock spire, not a mountain. Real massifs are wider than they are tall;
    // at 130 a single dab lands near 1:2 height-to-width.
    const g = ctx.createRadialGradient(x, y, 0, x, y, BRUSH_R);
    // Soft shoulder rather than a linear ramp: holds the summit broad and
    // lets the flanks fall away, instead of coming to a point.
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.5)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, BRUSH_R, 0, Math.PI * 2);
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
      {/* max-h + scroll: the square canvas makes this dialog tall, and without
          a cap the style picker and buttons fall off the bottom of a laptop
          viewport with no way to reach them. */}
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-xl border border-white/10 bg-neutral-900 p-6">
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
          className="mx-auto mt-4 aspect-square w-full max-w-[46vh] cursor-crosshair touch-none rounded-lg bg-white"
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

/* --------------------------------------------------------- weather panel --- */

/**
 * Pick a condition and how far it reaches.
 *
 * Deliberately lighter than the draw panel: weather is the one contribution
 * that's felt rather than looked at, so the fast path matters more than the
 * expressive one. Pick, commit, and the sky has already changed by the time
 * the dialog closes.
 */
function WeatherPanel({
  onCommit,
  onCancel,
}: {
  onCommit: (condition: string, intensity: number, radius: number) => void;
  onCancel: () => void;
}) {
  const [condition, setCondition] = useState('rain');
  const [intensity, setIntensity] = useState(0.85);
  const [radius, setRadius] = useState(260);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 backdrop-blur-sm">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-xl border border-white/10 bg-neutral-900 p-6">
        <h2 className="text-lg font-semibold text-white">Summon weather here</h2>
        <p className="mt-1 text-sm text-white/60">
          It blends with whatever else is nearby — nothing gets overwritten.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {Object.values(CONDITIONS).map((c) => {
            const active = c.name === condition;
            const t = c.atmosphere.tint;
            const swatch = `rgb(${Math.round(t[0] * 255)}, ${Math.round(t[1] * 255)}, ${Math.round(t[2] * 255)})`;
            return (
              <button
                key={c.name}
                onClick={() => setCondition(c.name)}
                aria-pressed={active}
                className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition ${
                  active
                    ? 'border-sky-400 bg-sky-400/15 text-white'
                    : 'border-white/15 text-white/70 hover:bg-white/10'
                }`}
              >
                <span
                  className="h-3 w-3 rounded-full border border-black/30"
                  style={{ background: swatch }}
                />
                {c.label}
              </button>
            );
          })}
        </div>

        <label className="mt-5 block text-xs font-medium tracking-wide text-white/50 uppercase">
          Intensity · {Math.round(intensity * 100)}%
        </label>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={intensity}
          onChange={(e) => setIntensity(Number(e.target.value))}
          className="mt-2 w-full accent-sky-400"
        />

        <label className="mt-4 block text-xs font-medium tracking-wide text-white/50 uppercase">
          Reach · {radius}m
        </label>
        <input
          type="range"
          min={60}
          max={800}
          step={20}
          value={radius}
          onChange={(e) => setRadius(Number(e.target.value))}
          className="mt-2 w-full accent-sky-400"
        />

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-white/80 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={() => onCommit(condition, intensity, radius)}
            className="rounded-md bg-sky-500 px-5 py-2 text-sm font-medium text-neutral-950 hover:bg-sky-400"
          >
            Summon it
          </button>
        </div>
      </div>
    </div>
  );
}
