// app/WeatherFX.tsx
//
// Bright daytime sky + fog/lights + player-drawn clouds.
// No ambient weather cloud sheets.
'use client';

import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Sky } from '@react-three/drei';
import * as THREE from 'three';

import {
  blendWeatherAt,
  muteForInterior,
  SUN_POSITION,
  type SkyCloudAsset,
  type WeatherAsset,
  type WeatherField,
} from './weather';

const SKETCH_GRID = 64;

const DEFAULT_FIELD: WeatherField = {
  clear: 1,
  light: 0,
  overcast: 0,
  fog: 0,
  storm: 0,
  fogDensity: 0.0012,
  fogColor: '#c8daf0',
  lightDim: 1,
  cloudCoverage: 0,
  cloudColor: '#f2f6fb',
  cloudLow: 0,
};

function lerpHex(a: string, b: string, t: number): string {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return '#' + ca.lerp(cb, t).getHexString();
}

function decodeSketch(b64: string): Float32Array {
  const bin = atob(b64);
  const out = new Float32Array(SKETCH_GRID * SKETCH_GRID);
  const n = Math.min(bin.length, out.length);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i) / 255;
  return out;
}

export function WeatherSystem({
  assets,
  skyClouds,
  indoors,
}: {
  assets: WeatherAsset[];
  skyClouds: SkyCloudAsset[];
  indoors: boolean;
}) {
  const fieldRef = useRef<WeatherField>({ ...DEFAULT_FIELD });
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const { camera, scene } = useThree();

  useFrame((_, dt) => {
    let next = blendWeatherAt(assets, camera.position.x, camera.position.z);
    if (indoors) next = muteForInterior(next);

    const a = 1 - Math.pow(0.02, dt);
    const s = fieldRef.current;
    s.clear = THREE.MathUtils.lerp(s.clear, next.clear, a);
    s.light = THREE.MathUtils.lerp(s.light, next.light, a);
    s.overcast = THREE.MathUtils.lerp(s.overcast, next.overcast, a);
    s.fog = THREE.MathUtils.lerp(s.fog, next.fog, a);
    s.storm = THREE.MathUtils.lerp(s.storm, next.storm, a);
    s.fogDensity = THREE.MathUtils.lerp(s.fogDensity, next.fogDensity, a);
    s.lightDim = THREE.MathUtils.lerp(s.lightDim, next.lightDim, a);
    s.fogColor = lerpHex(s.fogColor, next.fogColor, a);

    if (!scene.fog || !(scene.fog instanceof THREE.FogExp2)) {
      scene.fog = new THREE.FogExp2(s.fogColor, s.fogDensity);
    } else {
      scene.fog.color.set(s.fogColor);
      scene.fog.density = s.fogDensity;
    }

    if (sunRef.current) {
      sunRef.current.position.set(...SUN_POSITION);
      sunRef.current.intensity = 2.2 * s.lightDim;
      sunRef.current.color.set('#fff6e8');
    }
    if (ambientRef.current) {
      ambientRef.current.intensity = 0.7 * s.lightDim;
    }
  });

  const turbidity = 2 + fieldRef.current.storm * 1.2 + fieldRef.current.fog * 0.6;

  return (
    <>
      <Sky sunPosition={SUN_POSITION} turbidity={turbidity} rayleigh={2.8} mieCoefficient={0.004} />
      <ambientLight ref={ambientRef} intensity={0.7} />
      <directionalLight
        ref={sunRef}
        position={SUN_POSITION}
        intensity={2.2}
        color="#fff6e8"
        castShadow
      />
      {skyClouds.map((c) => (
        <DrawnCloud key={c.id} cloud={c} />
      ))}
    </>
  );
}

function DrawnCloud({ cloud }: { cloud: SkyCloudAsset }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const { camera } = useThree();

  const texture = useMemo(() => {
    const grid = decodeSketch(cloud.sketch);
    const data = new Uint8Array(SKETCH_GRID * SKETCH_GRID * 4);
    for (let i = 0; i < SKETCH_GRID * SKETCH_GRID; i++) {
      const ink = grid[i] ?? 0;
      const a = Math.min(230, Math.round(ink * 230));
      data[i * 4] = 245;
      data[i * 4 + 1] = 248;
      data[i * 4 + 2] = 252;
      data[i * 4 + 3] = a;
    }
    const tex = new THREE.DataTexture(data, SKETCH_GRID, SKETCH_GRID, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.flipY = true;
    return tex;
  }, [cloud.sketch]);

  useFrame(() => {
    if (!meshRef.current) return;
    meshRef.current.lookAt(camera.position);
  });

  return (
    <mesh ref={meshRef} position={[cloud.x, 150, cloud.z]} scale={[100, 62, 1]}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        map={texture}
        transparent
        depthWrite={false}
        side={THREE.DoubleSide}
        opacity={0.9}
      />
    </mesh>
  );
}
