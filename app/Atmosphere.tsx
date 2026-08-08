// app/Atmosphere.tsx
'use client';

import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Stars, Sparkles } from '@react-three/drei';
import * as THREE from 'three';

import { blendColor, blendDensity, sampleBiome, type BiomeId } from './biomes';

/**
 * Drives fog, ground tint and fill light from the biome under the camera.
 *
 * All of it runs on refs and mutates colors in place. Doing this through React
 * state would re-render the tree every frame; here the scene graph is stable
 * and only the GPU-facing values change.
 */
export function BiomeAtmosphere({
  groundRef,
  onBiomeChange,
}: {
  groundRef: React.RefObject<THREE.MeshStandardMaterial | null>;
  onBiomeChange: (id: BiomeId) => void;
}) {
  const { scene, camera } = useThree();
  const fillRef = useRef<THREE.PointLight>(null);

  const fogColor = useRef(new THREE.Color('#050b14'));
  const targetFog = useRef(new THREE.Color());
  const targetGround = useRef(new THREE.Color());
  const targetLight = useRef(new THREE.Color());
  const lastBiome = useRef<BiomeId | null>(null);

  useFrame((_, delta) => {
    const { weights, dominant } = sampleBiome(camera.position.x, camera.position.z);

    // Ease toward the target so crossing a border is a slow bleed, not a cut.
    // Frame-rate independent: same feel at 30fps and 144fps.
    const t = 1 - Math.pow(0.001, delta);

    blendColor(weights, 'fog', targetFog.current);
    fogColor.current.lerp(targetFog.current, t);

    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.color.copy(fogColor.current);
      fog.density = THREE.MathUtils.lerp(fog.density, blendDensity(weights), t);
    }
    // Background matches fog so the horizon dissolves instead of ending on a seam.
    if (scene.background instanceof THREE.Color) {
      scene.background.copy(fogColor.current);
    }

    if (groundRef.current) {
      blendColor(weights, 'ground', targetGround.current);
      groundRef.current.color.lerp(targetGround.current, t);
    }

    if (fillRef.current) {
      blendColor(weights, 'light', targetLight.current);
      fillRef.current.color.lerp(targetLight.current, t);
      // Follow the player so the fill always lights the visible area.
      fillRef.current.position.set(camera.position.x, 12, camera.position.z);
    }

    if (dominant !== lastBiome.current) {
      lastBiome.current = dominant;
      onBiomeChange(dominant);
    }
  });

  return (
    <>
      {/* Low ambient: enough to read shapes, dark enough that emissives dominate. */}
      <ambientLight intensity={0.4} color="#5b7fa6" />
      {/* Cold moonlight from a fixed angle gives forms a consistent silhouette. */}
      <directionalLight position={[40, 60, -20]} intensity={0.9} color="#93b8ff" />
      {/* Wide, soft fill that travels with the player so the ground immediately
          underfoot always reads as terrain instead of void. */}
      <pointLight ref={fillRef} intensity={55} distance={110} decay={1.6} />
    </>
  );
}

/** Night sky. `fade` keeps stars from poking through the fog at the horizon. */
export function NightSky() {
  return (
    <Stars radius={320} depth={80} count={2600} factor={5} saturation={0.4} fade speed={0.4} />
  );
}

/**
 * Fireflies. drei's Sparkles is a GPU shader — the motes animate in the vertex
 * stage, so thousands cost roughly one draw call and no per-frame JS.
 *
 * The field is re-centered on the player each frame, which makes a small fixed
 * number of motes read as an endless world full of them.
 */
export function Fireflies({ color, count = 90 }: { color: string; count?: number }) {
  const group = useRef<THREE.Group>(null);
  const { camera } = useThree();

  useFrame(() => {
    if (!group.current) return;
    // Quantized so motes don't slide with the camera and betray the trick.
    group.current.position.set(
      Math.round(camera.position.x / 12) * 12,
      0,
      Math.round(camera.position.z / 12) * 12,
    );
  });

  return (
    <group ref={group}>
      <Sparkles
        count={count}
        scale={[70, 14, 70]}
        position={[0, 6, 0]}
        size={5}
        speed={0.28}
        noise={0.5}
        opacity={0.85}
        color={color}
      />
    </group>
  );
}
