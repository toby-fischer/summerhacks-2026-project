// app/world/weather/Atmosphere.tsx
//
// Sky, sun, stars, fog and light — the global half of the weather pipeline.
//
// Everything here is driven by two numbers: time of day, and the blended
// Atmosphere sampled at the player's feet. No geometry is created per
// contribution, so this half costs the same whether the world holds one
// weather zone or four hundred.
//
// THE PREETHAM PROBLEM, and why the sky is handled the way it is:
//
// drei's <Sky> wraps three's Sky, which implements Preetham's "A Practical
// Analytic Model for Daylight". The word doing the work there is *daylight*.
// The model has no night term at all — push the sun below the horizon and it
// doesn't go black, it goes muddy grey-brown, because it's still computing
// scattered sunlight for an atmosphere that no longer has any. On a project
// whose whole look is dark and bioluminescent, that murk is the single worst
// thing that could be on screen.
//
// So the sky is a crossfade, not a simulation: Preetham handles the half of the
// cycle it's good at, and below the horizon it fades out entirely and hands off
// to a dark gradient plus stars. The seam is hidden inside twilight, where the
// eye already expects the colour to be changing fast.

'use client';

import * as React from 'react';
import { Sky, Stars } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { Sky as SkyImpl } from 'three-stdlib';
import * as THREE from 'three';

import type { Atmosphere as AtmosphereState } from './conditions';
import { daylight, sunElevation, timeOfDay } from './blend';
import { Celestial } from './Celestial';
import { Lightning } from './Lightning';

/** Where the sun sits on its arc. Radius is arbitrary — only direction matters. */
const SUN_DISTANCE = 400;

/** Night sky colour. Deep blue-black rather than pure black, so the horizon
 *  still separates from the terrain silhouette. */
const NIGHT_SKY = new THREE.Color('#05070f');

export interface AtmosphereProps {
  /** Live blended weather. Mutated in place by the sampler; read, never set. */
  state: React.RefObject<AtmosphereState>;
  /** Overrides the wall clock, for the debug scrubber. */
  timeOverride?: number | null;
}

/**
 * Drives sky, lights and fog from the blended weather and the time of day.
 *
 * Every per-frame write here goes straight into a three object — no setState,
 * so this component renders once and then never again while the world is live.
 */
export function AtmosphereRig({ state, timeOverride = null }: AtmosphereProps) {
  const { scene } = useThree();

  const skyRef = React.useRef<SkyImpl>(null);
  const starsRef = React.useRef<THREE.Points>(null);
  const sunRef = React.useRef<THREE.DirectionalLight>(null);
  const ambientRef = React.useRef<THREE.AmbientLight>(null);
  const hemiRef = React.useRef<THREE.HemisphereLight>(null);

  // Scratch objects, allocated once. Everything below mutates these.
  const scratch = React.useMemo(
    () => ({
      sun: new THREE.Vector3(),
      fogColor: new THREE.Color(),
      tint: new THREE.Color(),
      sunColor: new THREE.Color(),
      sky: new THREE.Color(),
    }),
    [],
  );

  // The world's fog. Owned here rather than in World.tsx's onCreated, because
  // from now on its colour and density are weather outputs, not constants.
  const fog = React.useMemo(() => new THREE.FogExp2('#b9c6d6', 0.0022), []);

  React.useEffect(() => {
    const previous = scene.fog;
    scene.fog = fog;
    return () => {
      scene.fog = previous;
    };
  }, [scene, fog]);

  useFrame(() => {
    const w = state.current;
    if (!w) return;

    const t = timeOverride ?? timeOfDay();
    const elevation = sunElevation(t);
    const day = daylight(t);

    // Sun on its arc. Azimuth drifts with time so shadows sweep across the
    // terrain rather than merely lengthening in place.
    const azimuth = t * Math.PI * 2;
    scratch.sun.set(
      Math.cos(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.sin(azimuth) * Math.cos(elevation),
    );

    scratch.tint.setRGB(w.tint[0], w.tint[1], w.tint[2]);

    /* -------- sky -------- */

    const sky = skyRef.current;

    if (sky?.material) {
      const u = sky.material.uniforms;
      if (u?.sunPosition) {
        u.sunPosition.value.copy(scratch.sun).multiplyScalar(SUN_DISTANCE);
      }
      // Overcast weather is high turbidity and low rayleigh — that's what turns
      // a blue sky white-grey. Driving the model's own parameters keeps the sky
      // physically coherent instead of tinting it after the fact.
      if (u?.turbidity) u.turbidity.value = 2 + w.cloud * 14;
      if (u?.rayleigh) u.rayleigh.value = 0.6 + (1 - w.gloom) * 2.6;
      if (u?.mieCoefficient) u.mieCoefficient.value = 0.005 + w.fog * 0.02;
      if (u?.mieDirectionalG) u.mieDirectionalG.value = 0.8;

      // The handoff. Fade Preetham out as the sun sets so its nightless model
      // never gets to draw the night.
      sky.visible = day > 0.01;
      sky.material.transparent = true;
      sky.material.opacity = day;
      sky.material.depthWrite = false;
    }

    /* -------- background behind the sky -------- */

    // Whatever the sky doesn't cover shows through to here. At night that's
    // everything, which is exactly how the dark sky gets drawn.
    //
    // The gloom term was `1 - gloom * 0.6`, which under a storm pulled the
    // daytime sky 60% of the way to night — that, more than the sun, is what
    // made bad weather look like a power cut. At 0.35 an overcast sky is
    // heavy and grey while still reading unmistakably as daytime.
    scratch.sky.copy(NIGHT_SKY).lerp(scratch.tint, day * 0.55 * (1 - w.gloom * 0.35));
    // Bioluminescent air lifts the night sky slightly toward the weather tint.
    if (w.glow > 0.01) {
      scratch.sky.lerp(scratch.tint, w.glow * 0.22 * (1 - day));
    }
    if (scene.background instanceof THREE.Color) {
      scene.background.copy(scratch.sky);
    } else {
      scene.background = scratch.sky.clone();
    }

    /* -------- stars -------- */

    if (starsRef.current) {
      const material = starsRef.current.material as THREE.Material;
      // Cloud and fog occlude stars; that's what makes a storm at night read as
      // genuinely closed-in rather than just dark.
      const clarity = (1 - day) * (1 - w.cloud * 0.8) * (1 - w.fog * 0.5);
      starsRef.current.visible = clarity > 0.02;
      material.transparent = true;
      material.opacity = Math.max(0, clarity);
    }

    /* -------- light -------- */

    // Sun colour warms as it approaches the horizon. Nothing sells a sunset
    // more cheaply than the terrain itself turning orange.
    const horizon = 1 - Math.min(1, Math.abs(Math.sin(elevation)) * 2.2);
    scratch.sunColor.setRGB(1, 0.95 - horizon * 0.32, 0.86 - horizon * 0.5);
    // Gloom desaturates toward the weather tint — under a storm the key light
    // is grey daylight, not a yellow sun.
    scratch.sunColor.lerp(scratch.tint, w.gloom * 0.75);

    if (sunRef.current) {
      sunRef.current.position.copy(scratch.sun).multiplyScalar(220);
      sunRef.current.color.copy(scratch.sunColor);
      // Gloom takes at most half the key light. It used to take 72%, which
      // combined with a near-black storm tint to leave the terrain unreadable
      // — the world went dark rather than overcast. Losing the sun should
      // flatten the light, not switch it off.
      sunRef.current.intensity = day * 2.1 * (1 - w.gloom * 0.5);
      // Shadow work is wasted once the sun is down or the sky is closed over.
      sunRef.current.castShadow = day > 0.15 && w.cloud < 0.85;
    }

    if (ambientRef.current) {
      // Never fully dark: glow keeps a bioluminescent floor under the night so
      // the terrain stays readable when the sun is gone.
      ambientRef.current.intensity = 0.16 + day * 0.5 + w.glow * 0.3;
      ambientRef.current.color.copy(scratch.tint).lerp(NIGHT_SKY, (1 - day) * 0.5);
    }

    if (hemiRef.current) {
      hemiRef.current.intensity = 0.2 + day * 0.45 + w.glow * 0.25;
      hemiRef.current.color.copy(scratch.sky);
    }

    /* -------- fog -------- */

    // Fog colour tracks the sky, so the horizon dissolves into it instead of
    // ending in a visible band. This is the single most important line for
    // making the 3000m plain look infinite.
    scratch.fogColor.copy(scratch.tint).lerp(scratch.sky, 0.55 - day * 0.25);
    fog.color.copy(scratch.fogColor);

    // Exponential, so the number is small and the curve does the work.
    // 0.0016 is the clear-sky baseline; heavy fog is ~10x that.
    fog.density = 0.0016 + w.fog * 0.014 + w.rain * 0.004 + w.snow * 0.003;
  });

  return (
    <>
      {/* distance under the camera's far plane (3000) so it always draws. */}
      <Sky ref={skyRef} distance={2000} sunPosition={[100, 40, -120]} turbidity={7} rayleigh={2.4} />

      {/* drei forwards its Points ref, which is what the crossfade above writes
          opacity to as the sun comes up. */}
      <Stars
        ref={starsRef}
        radius={420}
        depth={80}
        count={1100}
        factor={4.5}
        saturation={0}
        fade
        speed={0.4}
      />

      <Celestial state={state} timeOverride={timeOverride} />
      <Lightning state={state} />

      <ambientLight ref={ambientRef} intensity={0.6} />
      <hemisphereLight ref={hemiRef} groundColor="#2b2f26" intensity={0.4} />
      <directionalLight
        ref={sunRef}
        position={[120, 190, -70]}
        intensity={2}
        color="#fff3e2"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-far={600}
        shadow-camera-left={-220}
        shadow-camera-right={220}
        shadow-camera-top={220}
        shadow-camera-bottom={-220}
      />
    </>
  );
}
