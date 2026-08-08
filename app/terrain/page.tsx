// app/terrain/page.tsx
// POC: draw a ridgeline, walk on it at real scale.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls, Sky, Stars } from '@react-three/drei';
import * as THREE from 'three';

import { heightAt, heightsFromImageData, synthesize, type TerrainData } from '../terrain';

const GRID = 128;
const WORLD = 500;
const MAX_H = 70;

/* ------------------------------------------------------------- terrain --- */

function TerrainMesh({ terrain }: { terrain: TerrainData }) {
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

    const rock = new THREE.Color('#6b7a8f');
    const grass = new THREE.Color('#3f6b4a');
    const snow = new THREE.Color('#e8eef7');
    const sand = new THREE.Color('#7d7357');
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const h = terrain.heights[i] ?? 0;
      pos.setY(i, h);

      // Colour by altitude band, so the landform reads without any texture.
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
    <mesh geometry={geometry} receiveShadow castShadow>
      <meshStandardMaterial vertexColors roughness={0.95} metalness={0} flatShading />
    </mesh>
  );
}

/* ------------------------------------------------------------ controls --- */

function Walker({ terrain }: { terrain: TerrainData }) {
  const { camera } = useThree();
  const move = useRef({ f: false, b: false, l: false, r: false, sprint: false });
  const dir = useRef(new THREE.Vector3());
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));

  // Spawn on the lowest ground near the south edge and look toward the range,
  // so the first frame shows the landscape rather than the inside of a hill.
  useEffect(() => {
    const edge = terrain.scale / 2 - 30;
    let best = { x: 0, z: edge, h: Infinity };
    for (let x = -edge; x <= edge; x += 20) {
      const h = heightAt(terrain, x, edge);
      if (h < best.h) best = { x, z: edge, h };
    }
    camera.position.set(best.x, best.h + 1.8, best.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(-0.05, 0, 0); // yaw 0 == facing -Z, across the range
  }, [terrain, camera]);

  useEffect(() => {
    const set = (code: string, v: boolean) => {
      if (code === 'KeyW' || code === 'ArrowUp') move.current.f = v;
      if (code === 'KeyS' || code === 'ArrowDown') move.current.b = v;
      if (code === 'KeyA' || code === 'ArrowLeft') move.current.l = v;
      if (code === 'KeyD' || code === 'ArrowRight') move.current.r = v;
      if (code === 'ShiftLeft' || code === 'ShiftRight') move.current.sprint = v;
    };
    const down = (e: KeyboardEvent) => set(e.code, true);
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
  }, []);

  useFrame((_, delta) => {
    const m = move.current;
    const speed = (m.sprint ? 46 : 18) * delta;
    const fwd = Number(m.b) - Number(m.f);
    const side = Number(m.r) - Number(m.l);

    if (fwd || side) {
      dir.current.set(side, 0, fwd).normalize().multiplyScalar(speed);
      euler.current.set(0, camera.rotation.y, 0);
      dir.current.applyEuler(euler.current);
      camera.position.add(dir.current);
    }

    // Stick to the surface. Lerped so stepping off a ridge is a fall, not a snap.
    const ground = heightAt(terrain, camera.position.x, camera.position.z) + 1.8;
    camera.position.y += (ground - camera.position.y) * Math.min(1, delta * 12);
  });

  return <PointerLockControls />;
}

/* ---------------------------------------------------------------- page --- */

export default function TerrainPoc() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [terrain, setTerrain] = useState<TerrainData | null>(null);
  const [busy, setBusy] = useState(false);

  // Prime the canvas white; dark strokes become high ground.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
  }, []);

  const paint = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * c.width;
    const y = ((e.clientY - r.top) / r.height) * c.height;

    // Soft round brush: a wide blurred stroke gives the heightmap gradients
    // to work with, where a hard 1px pen would produce a wall.
    const g = ctx.createRadialGradient(x, y, 0, x, y, 26);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 26, 0, Math.PI * 2);
    ctx.fill();
  }, []);

  const clear = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
  }, []);

  const generate = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    setBusy(true);
    // Defer so the button paints its busy state before we block the thread.
    requestAnimationFrame(() => {
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const sketch = heightsFromImageData(img.data, c.width, c.height, GRID);
      setTerrain(synthesize(sketch, { size: GRID, scale: WORLD, maxHeight: MAX_H }));
      setBusy(false);
    });
  }, []);

  return (
    <div className="relative h-screen w-screen bg-neutral-950 text-neutral-100">
      {terrain ? (
        <>
          <Canvas
            shadows
            camera={{ position: [0, 60, 180], fov: 70, near: 0.5, far: 2000 }}
            onCreated={({ scene }) => {
              scene.fog = new THREE.FogExp2('#9fb4cc', 0.0016);
            }}
          >
            <Sky sunPosition={[80, 30, -100]} turbidity={8} rayleigh={2} />
            <Stars radius={400} depth={60} count={800} factor={4} fade />
            <ambientLight intensity={0.55} />
            <directionalLight
              position={[120, 180, -60]}
              intensity={2.1}
              color="#fff2dc"
              castShadow
            />
            <TerrainMesh terrain={terrain} />
            <Walker terrain={terrain} />
          </Canvas>

          <div className="pointer-events-none absolute left-6 top-6 rounded-lg bg-black/55 p-4 backdrop-blur">
            <h1 className="text-lg font-semibold">Your drawing, at scale</h1>
            <p className="mt-1 text-sm text-neutral-300">
              {WORLD}m across · {terrain.stats.max.toFixed(0)}m peak ·{' '}
              {terrain.stats.peaks} summits
            </p>
            <p className="mt-2 text-xs text-neutral-400">
              Click to look · WASD to walk · Shift to run
            </p>
          </div>

          <button
            onClick={() => setTerrain(null)}
            className="absolute right-6 top-6 rounded-md bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
          >
            Draw another
          </button>
        </>
      ) : (
        <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-5 p-8">
          <div className="text-center">
            <h1 className="text-2xl font-semibold">Draw a mountain range</h1>
            <p className="mt-2 text-sm text-neutral-400">
              Sketch a ridgeline — darker and thicker means higher ground. Then walk on it.
            </p>
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
            className="aspect-square w-full max-w-md cursor-crosshair touch-none rounded-lg border border-neutral-700 bg-white"
          />

          <div className="flex gap-3">
            <button
              onClick={clear}
              className="rounded-md border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800"
            >
              Clear
            </button>
            <button
              onClick={generate}
              disabled={busy}
              className="rounded-md bg-emerald-500 px-6 py-2 text-sm font-medium text-neutral-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              {busy ? 'Generating…' : 'Bring it to life'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
