// app/world/weather/Weather.tsx
//
// The one component World.tsx mounts. Everything the weather pipeline does
// hangs off this.
//
// WHERE THIS GOES: inside <Canvas>, as a sibling of the terrain patches — not
// inside them, and not once per contribution. Weather is the only genuinely
// global pipeline in the project. There is exactly one sky, one fog, and one
// column of rain around the player, no matter how many weather zones exist in
// the database. Contributions don't each draw something; they vote on what the
// single global atmosphere is doing where you happen to be standing.
//
// THE PER-FRAME BUDGET, which is the thing that had to be settled early:
//
//   - Sampling runs at ~10Hz, not 60. Weather changes as fast as you can walk,
//     which is nowhere near frame rate.
//   - Sampling allocates nothing (see blend.ts) — it writes through a ref that
//     was created once at mount.
//   - Between samples, every frame eases the live state toward the target, so
//     10Hz sampling still looks perfectly continuous.
//   - Nothing here ever calls setState. The whole system runs on refs, so
//     React renders this subtree once and then stays out of the way.
//
// Net cost per frame: a handful of float lerps and two uniform writes.

'use client';

import * as React from 'react';
import { useFrame, useThree } from '@react-three/fiber';

import type { Contribution, WeatherPayload } from '../contract';
import { AtmosphereRig } from './Atmosphere';
import { Precipitation } from './Precipitation';
import {
  easeAtmosphere,
  makeAtmosphere,
  sampleInto,
  type WeatherContribution,
} from './blend';

/** How often to re-sample the zone list, in milliseconds. */
const SAMPLE_MS = 100;

export interface WeatherProps {
  /** Every weather contribution in the world. Cheap to pass all of them —
   *  the sampler rejects out-of-range zones on squared distance first. */
  zones: readonly Contribution<WeatherPayload>[];
  /** Scales particle buffers. Drop to ~0.4 for phones. */
  quality?: number;
  /** Pins time of day, 0..1, for the debug scrubber. Null follows the clock. */
  timeOverride?: number | null;
}

export function Weather({ zones, quality = 1, timeOverride = null }: WeatherProps) {
  const { camera } = useThree();

  // Three long-lived Atmosphere objects, allocated once at mount:
  //   target  — what the blend says the weather should be, updated at 10Hz
  //   live    — what's actually on screen, eased toward target every frame
  const target = React.useRef(makeAtmosphere());
  const live = React.useRef(makeAtmosphere());
  const lastSample = React.useRef(0);

  // Scalar refs for the particle system. Precipitation reads these directly
  // rather than taking props, so changing weather never re-renders it.
  const rain = React.useRef(0);
  const snow = React.useRef(0);
  const wind = React.useRef(0);

  // Keeping the array in a ref means the frame loop reads the current zone list
  // without the loop itself being a dependency of anything.
  const zoneRef = React.useRef<readonly WeatherContribution[]>(zones);
  zoneRef.current = zones;

  useFrame((_, delta) => {
    const now = performance.now();

    if (now - lastSample.current >= SAMPLE_MS) {
      lastSample.current = now;
      sampleInto(target.current, zoneRef.current, camera.position.x, camera.position.z);
    }

    const w = easeAtmosphere(live.current, target.current, delta);

    rain.current = w.rain;
    snow.current = w.snow;
    wind.current = w.wind;
  });

  return (
    <>
      <AtmosphereRig state={live} timeOverride={timeOverride} />
      <Precipitation rain={rain} snow={snow} wind={wind} quality={quality} />
    </>
  );
}
