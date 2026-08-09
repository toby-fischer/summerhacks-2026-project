// app/WeatherFX.tsx
//
// Sky / fog / lights + different cloudy decks. No rain or snow particles.
'use client';

import { useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Sky, Stars } from '@react-three/drei';
import * as THREE from 'three';

import {
  blendWeatherAt,
  daylightFactor,
  muteForInterior,
  sunPositionFromTime,
  type WeatherAsset,
  type WeatherField,
} from './weather';

const DEFAULT_FIELD: WeatherField = {
  clear: 1,
  light: 0,
  overcast: 0,
  fog: 0,
  storm: 0,
  fogDensity: 0.0022,
  fogColor: '#b9c6d6',
  lightDim: 1,
  cloudCoverage: 0.12,
  cloudColor: '#e4eaf2',
  cloudLow: 0.15,
};

function lerpHex(a: string, b: string, t: number): string {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return '#' + ca.lerp(cb, t).getHexString();
}

/**
 * Root weather system: samples the blend at the camera, drives fog/sky/lights
 * and cloudy decks. Drop this once inside the Canvas.
 */
export function WeatherSystem({
  assets,
  indoors,
}: {
  assets: WeatherAsset[];
  indoors: boolean;
}) {
  const fieldRef = useRef<WeatherField>({ ...DEFAULT_FIELD });
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const { camera, scene } = useThree();
  const [sunPos, setSunPos] = useState<[number, number, number]>([90, 25, -120]);
  const frame = useRef(0);

  useFrame((state, dt) => {
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
    s.cloudCoverage = THREE.MathUtils.lerp(s.cloudCoverage, next.cloudCoverage, a);
    s.cloudLow = THREE.MathUtils.lerp(s.cloudLow, next.cloudLow, a);
    s.fogColor = lerpHex(s.fogColor, next.fogColor, a);
    s.cloudColor = lerpHex(s.cloudColor, next.cloudColor, a);

    const sun = sunPositionFromTime(state.clock.elapsedTime);
    frame.current += 1;
    if (frame.current % 12 === 0) setSunPos([sun[0], sun[1], sun[2]]);

    const day = daylightFactor(sun[1]);
    if (!scene.fog || !(scene.fog instanceof THREE.FogExp2)) {
      scene.fog = new THREE.FogExp2(s.fogColor, s.fogDensity);
    } else {
      scene.fog.color.set(s.fogColor);
      scene.fog.density = s.fogDensity;
    }

    if (sunRef.current) {
      sunRef.current.position.set(sun[0], Math.max(12, Math.abs(sun[1]) < 8 ? 12 : sun[1]), sun[2]);
      sunRef.current.intensity = (0.35 + day * 1.65) * s.lightDim;
      sunRef.current.color.set(day > 0.35 ? '#fff3e2' : '#b8c4dc');
    }
    if (ambientRef.current) {
      ambientRef.current.intensity = (0.22 + day * 0.38) * s.lightDim;
    }
  });

  const day = daylightFactor(sunPos[1]);
  const turbidity = 4 + fieldRef.current.storm * 6 + fieldRef.current.fog * 3 + (1 - day) * 2;
  const showStars = day < 0.5;

  return (
    <>
      <Sky sunPosition={sunPos} turbidity={turbidity} rayleigh={1.2 + day * 1.4} />
      {showStars && (
        <Stars radius={500} depth={70} count={700} factor={3 + (1 - day) * 3} fade speed={0.4} />
      )}
      <ambientLight ref={ambientRef} intensity={0.6} />
      <directionalLight
        ref={sunRef}
        position={[120, 190, -70]}
        intensity={2.0}
        color="#fff3e2"
        castShadow
      />
      <CheapClouds fieldRef={fieldRef} />
    </>
  );
}

function CheapClouds({ fieldRef }: { fieldRef: React.MutableRefObject<WeatherField> }) {
  const group = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const mats = useRef<THREE.MeshBasicMaterial[]>([]);

  // More sheets so overcast / storm can read as a full deck, not eight blotches.
  const planes = useMemo(() => {
    const list: { pos: [number, number, number]; scale: [number, number, number]; speed: number }[] = [];
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2 + (i % 3) * 0.2;
      const r = 120 + (i % 5) * 70;
      list.push({
        pos: [Math.cos(ang) * r, 0, Math.sin(ang) * r],
        scale: [160 + (i % 4) * 50, 1, 80 + (i % 3) * 35],
        speed: 1.5 + (i % 5),
      });
    }
    return list;
  }, []);

  useFrame((state, dt) => {
    if (!group.current) return;
    const f = fieldRef.current;
    const cov = f.cloudCoverage;
    const baseY = 160 - f.cloudLow * 95; // fog/storm sit lower
    group.current.position.set(camera.position.x, 0, camera.position.z);
    group.current.visible = cov > 0.04;

    for (let i = 0; i < group.current.children.length; i++) {
      const child = group.current.children[i] as THREE.Mesh;
      const spd = planes[i]?.speed ?? 2;
      child.position.y = baseY + (i % 4) * (18 - f.cloudLow * 8);
      child.position.x += Math.sin(state.clock.elapsedTime * 0.05 + i) * spd * dt * 0.15;
      child.position.z += Math.cos(state.clock.elapsedTime * 0.04 + i) * spd * dt * 0.12;
      const m = mats.current[i];
      if (m) {
        m.color.set(f.cloudColor);
        m.opacity = Math.min(0.82, 0.12 + cov * 0.75);
      }
    }
  });

  return (
    <group ref={group}>
      {planes.map((p, i) => (
        <mesh key={i} position={p.pos} scale={p.scale} rotation={[-Math.PI / 2.35, 0, i * 0.25]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            ref={(m) => {
              if (m) mats.current[i] = m;
            }}
            color="#e4eaf2"
            transparent
            opacity={0.2}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}
