// app/World.tsx
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls } from '@react-three/drei';
import { createClient } from '@supabase/supabase-js';
import type { RealtimeChannel } from '@supabase/supabase-js';
import * as THREE from 'three';

import { BIOMES, sampleBiome, type BiomeId } from './biomes';
import { BiomeAtmosphere, Fireflies, NightSky } from './Atmosphere';
import { Beacon, Crystals, GrassTufts, Mushrooms } from './Flora';
import {
  BROADCAST_MS,
  STALE_MS,
  colorForId,
  joinTravellerChannel,
  makeSelfId,
  sendMove,
  type Traveller,
} from './presence';

// Only available once .env is filled in; without them the world still renders,
// just without anything shared.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

interface WorldAsset {
  id: string;
  x: number;
  z: number;
  color: string;
}

const EYE_HEIGHT = 1.7;
const WALK_SPEED = 9;
const SPRINT_SPEED = 17;

function PlayerControls({
  onPlace,
  travellerChannel,
  selfId,
}: {
  onPlace: (x: number, z: number) => void;
  travellerChannel: React.RefObject<RealtimeChannel | null>;
  selfId: string;
}) {
  const { camera } = useThree();
  const move = useRef({ f: false, b: false, l: false, r: false, sprint: false });
  const locked = useRef(false);

  // Hoisted: allocating these per frame churned the GC ~120 objects/sec.
  const dir = useRef(new THREE.Vector3());
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  const bob = useRef(0);
  const lastSend = useRef(0);

  useEffect(() => {
    const set = (code: string, v: boolean) => {
      switch (code) {
        case 'KeyW':
        case 'ArrowUp':
          move.current.f = v;
          break;
        case 'KeyS':
        case 'ArrowDown':
          move.current.b = v;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          move.current.l = v;
          break;
        case 'KeyD':
        case 'ArrowRight':
          move.current.r = v;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          move.current.sprint = v;
          break;
      }
    };

    const down = (e: KeyboardEvent) => {
      set(e.code, true);
      // Space plants a beacon where you stand.
      if (e.code === 'Space' && locked.current) {
        e.preventDefault();
        onPlace(camera.position.x, camera.position.z);
      }
    };
    const up = (e: KeyboardEvent) => set(e.code, false);
    // Releasing pointer lock must clear held keys, or you drift forever.
    const blur = () => (move.current = { f: false, b: false, l: false, r: false, sprint: false });

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [camera, onPlace]);

  useFrame((_, delta) => {
    const m = move.current;
    const speed = (m.sprint ? SPRINT_SPEED : WALK_SPEED) * delta;

    // Three.js looks down -Z, so forward is negative. Strafe is (right - left):
    // the original had this reversed, which sent you left when pressing D.
    const forward = Number(m.b) - Number(m.f);
    const side = Number(m.r) - Number(m.l);

    if (forward !== 0 || side !== 0) {
      dir.current.set(side, 0, forward).normalize().multiplyScalar(speed);
      euler.current.set(0, camera.rotation.y, 0);
      dir.current.applyEuler(euler.current);
      camera.position.add(dir.current);

      // Subtle head bob sells the walking; faster and deeper when sprinting.
      bob.current += delta * (m.sprint ? 14 : 9);
    }

    camera.position.y = EYE_HEIGHT + Math.sin(bob.current) * 0.045;

    // Throttled position broadcast (see presence.ts for why Broadcast).
    const now = performance.now();
    const ch = travellerChannel.current;
    if (ch && now - lastSend.current > BROADCAST_MS) {
      lastSend.current = now;
      sendMove(ch, {
        id: selfId,
        x: camera.position.x,
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

function Ground({ matRef }: { matRef: React.RefObject<THREE.MeshStandardMaterial | null> }) {
  const { camera } = useThree();
  const mesh = useRef<THREE.Mesh>(null);

  // The plane follows the player, so the world has no edge to walk off.
  // Fog hides the far rim, so a moving finite plane reads as infinite ground.
  useFrame(() => {
    if (mesh.current) mesh.current.position.set(camera.position.x, 0, camera.position.z);
  });

  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[600, 600]} />
      <meshStandardMaterial ref={matRef} color="#0b1a20" roughness={0.95} metalness={0} />
    </mesh>
  );
}

/** Other visitors, as drifting wisps of light. */
function Travellers({ travellers }: { travellers: Traveller[] }) {
  return (
    <>
      {travellers.map((t) => (
        <Wisp key={t.id} traveller={t} />
      ))}
    </>
  );
}

function Wisp({ traveller }: { traveller: Traveller }) {
  const group = useRef<THREE.Group>(null);
  const target = useRef(new THREE.Vector3(traveller.x, 0, traveller.z));

  // Broadcasts land at ~10Hz; interpolating between them turns discrete hops
  // into smooth motion at whatever framerate we happen to be running.
  useFrame((state, delta) => {
    if (!group.current) return;
    target.current.set(traveller.x, 0, traveller.z);
    group.current.position.lerp(target.current, 1 - Math.pow(0.002, delta));
    group.current.position.y = 1.2 + Math.sin(state.clock.elapsedTime * 2) * 0.15;
  });

  return (
    <group ref={group}>
      <mesh>
        <sphereGeometry args={[0.32, 14, 12]} />
        <meshStandardMaterial
          color={traveller.color}
          emissive={traveller.color}
          emissiveIntensity={3}
          toneMapped={false}
        />
      </mesh>
      {/* BackSide halo — same fake-bloom trick as Beacon. */}
      <mesh>
        <sphereGeometry args={[0.85, 18, 14]} />
        <meshBasicMaterial
          color={traveller.color}
          transparent
          opacity={0.12}
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <pointLight color={traveller.color} intensity={5} distance={11} decay={2} />
    </group>
  );
}

/** Re-centering fireflies, tinted by the biome the player currently occupies. */
function BiomeFireflies({ biome }: { biome: BiomeId }) {
  return <Fireflies color={BIOMES[biome].motes} count={90} />;
}

export default function World() {
  const [assets, setAssets] = useState<WorldAsset[]>([]);
  const [biome, setBiome] = useState<BiomeId>('meadow');
  const [travellers, setTravellers] = useState<Traveller[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'offline'>(
    supabase ? 'connecting' : 'offline',
  );

  const selfId = useMemo(makeSelfId, []);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const travellerMap = useRef<Map<string, Traveller>>(new Map());
  const groundMat = useRef<THREE.MeshStandardMaterial>(null);

  // World assets: initial fetch + realtime inserts.
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    supabase
      .from('world_assets')
      .select('*')
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        // Merge rather than replace: an INSERT can land before this resolves,
        // and dedupe by id keeps that from double-rendering.
        setAssets((prev) => {
          const byId = new Map(prev.map((a) => [a.id, a]));
          for (const row of data as WorldAsset[]) byId.set(row.id, row);
          return [...byId.values()];
        });
      });

    const channel = supabase
      .channel('public:world_assets')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'world_assets' },
        (payload) => {
          const row = payload.new as WorldAsset;
          setAssets((prev) => (prev.some((a) => a.id === row.id) ? prev : [...prev, row]));
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'world_assets' },
        (payload) => {
          const old = payload.old as Partial<WorldAsset>;
          if (old?.id) setAssets((prev) => prev.filter((a) => a.id !== old.id));
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

  // Traveller presence.
  useEffect(() => {
    if (!supabase) return;

    const channel = joinTravellerChannel(supabase, selfId, (t) => {
      travellerMap.current.set(t.id, t);
    });
    channelRef.current = channel;

    // One timer drives both eviction and re-render, so React updates at 5Hz
    // instead of on every inbound broadcast.
    const timer = window.setInterval(() => {
      const now = performance.now();
      let changed = false;
      for (const [id, t] of travellerMap.current) {
        if (now - t.seen > STALE_MS) {
          travellerMap.current.delete(id);
          changed = true;
        }
      }
      const next = [...travellerMap.current.values()];
      setTravellers((prev) =>
        changed || prev.length !== next.length || next.some((t, i) => prev[i]?.id !== t.id)
          ? next
          : prev.map((p) => travellerMap.current.get(p.id) ?? p),
      );
    }, 200);

    return () => {
      window.clearInterval(timer);
      channelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [selfId]);

  const placeBeacon = useCallback((x: number, z: number) => {
    const { dominant } = sampleBiome(x, z);
    const color = BIOMES[dominant].beacon;

    // Optimistic: show it immediately with a temporary id, then reconcile.
    // A beacon that lags 300ms behind the keypress feels broken.
    const tempId = `temp-${Math.random().toString(36).slice(2)}`;
    const optimistic: WorldAsset = { id: tempId, x, z, color };
    setAssets((prev) => [...prev, optimistic]);

    if (!supabase) return;

    supabase
      .from('world_assets')
      .insert({ x, z, color })
      .select()
      .then(({ data, error }) => {
        setAssets((prev) => {
          const without = prev.filter((a) => a.id !== tempId);
          // Roll back on failure so the world never shows a beacon that
          // nobody else can see.
          if (error || !data?.length) return without;
          const row = data[0] as WorldAsset;
          return without.some((a) => a.id === row.id) ? without : [...without, row];
        });
      });
  }, []);

  const current = BIOMES[biome];

  return (
    <div className="relative w-screen h-screen bg-black overflow-hidden select-none">
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: [0, EYE_HEIGHT, 8], fov: 72, near: 0.1, far: 400 }}
        onCreated={({ scene, gl }) => {
          scene.fog = new THREE.FogExp2('#050b14', 0.018);
          scene.background = new THREE.Color('#050b14');
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.15;
        }}
      >
        <NightSky />
        <BiomeAtmosphere groundRef={groundMat} onBiomeChange={setBiome} />

        <PlayerControls
          onPlace={placeBeacon}
          travellerChannel={channelRef}
          selfId={selfId}
        />
        <Ground matRef={groundMat} />

        <GrassTufts />
        <Mushrooms />
        <Crystals />
        <BiomeFireflies biome={biome} />

        <Travellers travellers={travellers} />

        {assets.map((asset, i) => (
          <Beacon
            key={asset.id}
            position={[asset.x, 1.1, asset.z]}
            color={asset.color}
            index={i}
          />
        ))}
      </Canvas>

      <Hud
        biome={current.name}
        accent={current.beacon}
        beacons={assets.length}
        travellers={travellers.length}
        status={status}
      />
    </div>
  );
}

function Hud({
  biome,
  accent,
  beacons,
  travellers,
  status,
}: {
  biome: string;
  accent: string;
  beacons: number;
  travellers: number;
  status: 'connecting' | 'live' | 'offline';
}) {
  const label =
    status === 'live'
      ? `${travellers} traveller${travellers === 1 ? '' : 's'} nearby`
      : status === 'connecting'
        ? 'connecting…'
        : 'offline — solo world';

  return (
    <>
      {/* Vignette. Pure CSS, and it darkens the frame edges the way the fog
          darkens distance — the two together sell the enclosure. */}
      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,0.55) 100%)',
        }}
      />

      {/* Crosshair */}
      <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
        <div className="h-1 w-1 rounded-full bg-white/50" />
      </div>

      <div className="pointer-events-none absolute left-6 top-6 z-20">
        <h1
          className="text-2xl font-semibold tracking-tight transition-colors duration-1000"
          style={{ color: accent, textShadow: `0 0 24px ${accent}66` }}
        >
          {biome}
        </h1>
        <p className="mt-1 text-sm text-white/55">
          {beacons} beacon{beacons === 1 ? '' : 's'} · {label}
        </p>
      </div>

      <div className="pointer-events-none absolute bottom-6 left-6 z-20 space-y-1 text-xs text-white/40">
        <p>
          <span className="text-white/70">Click</span> to look ·{' '}
          <span className="text-white/70">WASD</span> to walk ·{' '}
          <span className="text-white/70">Shift</span> to run
        </p>
        <p>
          <span className="text-white/70">Space</span> to leave a beacon ·{' '}
          <span className="text-white/70">Esc</span> to release
        </p>
        <p className="pt-1 text-white/25">
          Walk north for the Hollow · east for the Reach
        </p>
      </div>
    </>
  );
}
