// app/World.tsx
'use client';

import React, { useRef, useEffect, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls, Sky } from '@react-three/drei';
import { createClient } from '@supabase/supabase-js';
import * as THREE from 'three';

// Initialize Supabase Client with the publishable key
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
);

interface WorldAsset {
  id: string;
  x: number;
  z: number;
  color: string;
}

// ... rest of app/World.tsx remains the same

function PlayerControls() {
  const { camera } = useThree();
  const moveState = useRef({ forward: false, backward: false, left: false, right: false });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'KeyW' || e.code === 'ArrowUp') moveState.current.forward = true;
      if (e.code === 'KeyS' || e.code === 'ArrowDown') moveState.current.backward = true;
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') moveState.current.left = true;
      if (e.code === 'KeyD' || e.code === 'ArrowRight') moveState.current.right = true;
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyW' || e.code === 'ArrowUp') moveState.current.forward = false;
      if (e.code === 'KeyS' || e.code === 'ArrowDown') moveState.current.backward = false;
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') moveState.current.left = false;
      if (e.code === 'KeyD' || e.code === 'ArrowRight') moveState.current.right = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  useFrame((_, delta) => {
    const speed = 15 * delta;
    const forward = Number(moveState.current.backward) - Number(moveState.current.forward);
    const side = Number(moveState.current.left) - Number(moveState.current.right);

    const dir = new THREE.Vector3(side, 0, forward).normalize().multiplyScalar(speed);
    dir.applyEuler(new THREE.Euler(0, camera.rotation.y, 0, 'YXZ'));

    camera.position.add(dir);
    camera.position.y = 1.7;
  });

  return <PointerLockControls />;
}

function Ground() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
      <planeGeometry args={[1000, 1000]} />
      <meshStandardMaterial color="#2d3748" roughness={0.8} />
    </mesh>
  );
}

function DemoObject({ position, color }: { position: [number, number, number]; color: string }) {
  return (
    <mesh position={position} castShadow>
      <boxGeometry args={[2, 2, 2]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

export default function World() {
  const [assets, setAssets] = useState<WorldAsset[]>([]);

  useEffect(() => {
    // 1. Fetch initial assets on page load
    supabase
      .from('world_assets')
      .select('*')
      .then(({ data, error }) => {
        if (data && !error) setAssets(data as WorldAsset[]);
      });

    // 2. Subscribe to REALTIME insert events from strangers
    const channel = supabase
      .channel('public:world_assets')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'world_assets' },
        (payload) => {
          setAssets((prev) => [...prev, payload.new as WorldAsset]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="relative w-screen h-screen bg-black">
      {/* UI Overlay */}
      <div className="absolute top-4 left-4 z-10 p-4 bg-black/60 text-white rounded-lg backdrop-blur-sm pointer-events-none">
        <h1 className="text-xl font-bold">Infinite World (Realtime)</h1>
        <p className="text-sm opacity-80">Objects in world: {assets.length}</p>
      </div>

      <Canvas shadows camera={{ position: [0, 1.7, 5], fov: 75 }}>
        <Sky sunPosition={[100, 20, 100]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[10, 20, 15]} intensity={1.2} castShadow />

        <PlayerControls />
        <Ground />

        {/* Render dynamic assets from Supabase */}
        {assets.map((asset) => (
          <DemoObject
            key={asset.id}
            position={[asset.x, 1, asset.z]}
            color={asset.color}
          />
        ))}
      </Canvas>
    </div>
  );
}