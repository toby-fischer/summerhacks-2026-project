// app/world/weather/Lightning.tsx
//
// Storm flashes.
//
// No bolt geometry. A lightning bolt you can look at has to be somewhere
// specific, which means it's either always in front of you (fake) or usually
// behind you (invisible). What actually reads as lightning is the FLASH — the
// entire world going white for two frames and the thunder afterwards.
//
// So this is one hemisphere light that costs nothing while idle and spikes on a
// random schedule. It lights the terrain, the rain and the clouds together,
// which is exactly what a real flash does and what no amount of bolt geometry
// would achieve on its own.
//
// The flash envelope is deliberately not a single fade: real lightning
// stutters, with a bright leader, a dip, and a brighter return stroke. Two
// overlapping decays cost one extra multiply and are most of why it convinces.

'use client';

import * as React from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import type { Atmosphere as AtmosphereState } from './conditions';

export interface LightningProps {
  state: React.RefObject<AtmosphereState>;
}

export function Lightning({ state }: LightningProps) {
  const lightRef = React.useRef<THREE.HemisphereLight>(null);

  // Countdown to the next strike, and how far through the current one we are.
  const nextStrike = React.useRef(2);
  const flash = React.useRef(0);
  const strength = React.useRef(0);

  useFrame((_, delta) => {
    const w = state.current;
    const light = lightRef.current;
    if (!w || !light) return;

    // Only storms (heavy rain + heavy cloud) produce lightning. Ordinary rain
    // stays quiet, so a storm zone feels distinct from a rain zone.
    const stormy = Math.min(1, w.rain * w.cloud * 1.4);

    if (stormy < 0.25) {
      flash.current = 0;
      light.intensity = 0;
      light.visible = false;
      return;
    }
    light.visible = true;

    nextStrike.current -= delta * (0.4 + stormy * 1.6);

    if (nextStrike.current <= 0) {
      // Math.random() is correct here, unlike everywhere else in the project:
      // lightning is transient and camera-local, so there's nothing for two
      // clients to disagree about. Seeding it would mean everyone's storm
      // flashing in lockstep, which looks stranger than it sounds.
      nextStrike.current = 1.6 + Math.random() * 5.5;
      flash.current = 1;
      strength.current = 0.55 + Math.random() * 0.45;
    }

    if (flash.current > 0) {
      flash.current = Math.max(0, flash.current - delta * 3.4);

      const f = flash.current;
      // Leader: fast decay. Return stroke: a second, slower bump behind it.
      const leader = Math.pow(f, 5.0);
      const stroke = Math.pow(Math.max(0, f - 0.18), 2.2) * 0.7;
      light.intensity = (leader + stroke) * 9 * strength.current * stormy;
    } else {
      light.intensity = 0;
    }
  });

  return (
    <hemisphereLight
      ref={lightRef}
      color="#dce8ff"
      groundColor="#8fa4c4"
      intensity={0}
      visible={false}
    />
  );
}
