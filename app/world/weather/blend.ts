// app/world/weather/blend.ts
//
// "What is the weather where I'm standing?" — answered every frame, for free.
//
// This is the only genuinely global pipeline, so it gets sampled continuously
// while everything else is drawn once and forgotten. That makes allocation the
// whole design problem: a Vector3 or an object literal per frame is 60 garbage
// objects a second, and on a phone the resulting GC pauses read as stutter in a
// world that is otherwise holding 60fps.
//
// So: nothing in this file allocates after module load. sampleInto() writes
// through a caller-owned Atmosphere, the reducers mutate in place, and the
// falloff maths is scalar. Call it as often as you like.
//
// The blend rule follows the contract's ADDITIVE law. Overlapping weather zones
// accumulate — walk where rain and fog overlap and you get rainy fog, not
// whichever row happened to sort first. Nobody's weather can be erased by
// someone standing on top of it.

import type { Contribution, WeatherPayload } from '../contract';
import { CLEAR, conditionFor, type Atmosphere } from './conditions';

/** A weather contribution with its payload resolved. */
export type WeatherContribution = Contribution<WeatherPayload>;

/**
 * Smooth 0..1 falloff from the centre of a zone to its rim.
 *
 * Deliberately smoothstep and not linear: a linear edge produces a visible
 * crease where fog density stops changing, and you can see exactly where
 * someone's contribution ends. Smoothstep has zero derivative at both ends, so
 * zones dissolve into each other.
 */
function falloff(distSq: number, radius: number): number {
  if (radius <= 0) return 0;
  const t = 1 - Math.min(1, Math.sqrt(distSq) / radius);
  return t * t * (3 - 2 * t);
}

/** Copy `src` into `dst` without allocating. */
export function copyAtmosphere(dst: Atmosphere, src: Atmosphere): Atmosphere {
  dst.rain = src.rain;
  dst.snow = src.snow;
  dst.fog = src.fog;
  dst.cloud = src.cloud;
  dst.wind = src.wind;
  dst.gloom = src.gloom;
  dst.glow = src.glow;
  dst.tint[0] = src.tint[0];
  dst.tint[1] = src.tint[1];
  dst.tint[2] = src.tint[2];
  return dst;
}

/** A fresh Atmosphere at clear-sky defaults. Call this at setup, never in a frame. */
export function makeAtmosphere(): Atmosphere {
  return { ...CLEAR, tint: [...CLEAR.tint] as [number, number, number] };
}

/**
 * Sample the blended weather at a world position, writing into `out`.
 *
 * Returns `out` so it reads like a pure function at the call site, but it is
 * emphatically not one — `out` is mutated. That's the point.
 *
 * How the blend works: each zone in range contributes `intensity * falloff`
 * as a weight. Precipitation and glow ACCUMULATE (two rain zones are wetter
 * than one — additive, per the contract). Tint and gloom are WEIGHTED AVERAGES
 * toward clear sky, because colours don't add: two overlapping grey fogs are
 * still grey, not black.
 */
export function sampleInto(
  out: Atmosphere,
  zones: readonly WeatherContribution[],
  x: number,
  z: number,
): Atmosphere {
  // Start from clear sky. Everything below is a departure from this.
  copyAtmosphere(out, CLEAR);

  if (zones.length === 0) return out;

  // Accumulators for the weighted-average fields. Scalars, so no allocation.
  let weightSum = 0;
  let tintR = 0;
  let tintG = 0;
  let tintB = 0;
  let gloomSum = 0;
  let windSum = 0;
  let cloudSum = 0;

  // Additive fields start at zero and climb; clear sky's baseline is folded
  // back in at the end so an unweathered world still has its faint haze.
  let rain = 0;
  let snow = 0;
  let fog = 0;
  let glow = 0;

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const payload = zone.payload;
    if (!payload) continue;

    const radius = payload.radius > 0 ? payload.radius : 220;

    // Cheap reject first — squared distance, no sqrt, no branching into the
    // preset lookup. With 200 contributions only a handful are ever in range,
    // and this is what makes that cost nothing.
    const dx = x - zone.x;
    const dz = z - zone.z;
    const distSq = dx * dx + dz * dz;
    if (distSq > radius * radius) continue;

    const weight = falloff(distSq, radius) * Math.max(0, Math.min(1, payload.intensity));
    if (weight <= 0) continue;

    const a = conditionFor(payload.condition).atmosphere;

    rain += a.rain * weight;
    snow += a.snow * weight;
    fog += a.fog * weight;
    glow += a.glow * weight;

    tintR += a.tint[0] * weight;
    tintG += a.tint[1] * weight;
    tintB += a.tint[2] * weight;
    gloomSum += a.gloom * weight;
    windSum += a.wind * weight;
    cloudSum += a.cloud * weight;
    weightSum += weight;
  }

  if (weightSum <= 0) return out;

  // Additive, then clamped. Stacking five storms should saturate, not overflow
  // into NaN territory downstream in the shaders.
  out.rain = Math.min(1, rain);
  out.snow = Math.min(1, snow);
  out.fog = Math.min(1, CLEAR.fog + fog);
  out.glow = Math.min(1, CLEAR.glow + glow);

  // Weighted average toward clear sky. `blend` is how far this point is from
  // clear: at the exact centre of one full-intensity zone it's 1, at the rim 0.
  const blend = Math.min(1, weightSum);
  const inv = 1 / weightSum;

  out.tint[0] = CLEAR.tint[0] + (tintR * inv - CLEAR.tint[0]) * blend;
  out.tint[1] = CLEAR.tint[1] + (tintG * inv - CLEAR.tint[1]) * blend;
  out.tint[2] = CLEAR.tint[2] + (tintB * inv - CLEAR.tint[2]) * blend;
  out.gloom = CLEAR.gloom + (gloomSum * inv - CLEAR.gloom) * blend;
  out.wind = CLEAR.wind + (windSum * inv - CLEAR.wind) * blend;
  out.cloud = CLEAR.cloud + (cloudSum * inv - CLEAR.cloud) * blend;

  return out;
}

/**
 * Ease `current` toward `target` in place.
 *
 * Sampling runs at ~10Hz because weather has no business costing a full-rate
 * loop, but stepping the uniforms at 10Hz would visibly stair-step the fog. So
 * the sample sets a target and every frame eases toward it.
 *
 * The rate is framerate-independent — `1 - pow(k, dt)` rather than `k * dt` —
 * so a phone at 30fps and a laptop at 120fps converge at the same wall-clock
 * speed. With `k = 0.06` a walk across a zone boundary takes about a second.
 */
export function easeAtmosphere(
  current: Atmosphere,
  target: Atmosphere,
  delta: number,
  k = 0.06,
): Atmosphere {
  const t = 1 - Math.pow(k, Math.min(delta, 0.1));

  current.rain += (target.rain - current.rain) * t;
  current.snow += (target.snow - current.snow) * t;
  current.fog += (target.fog - current.fog) * t;
  current.cloud += (target.cloud - current.cloud) * t;
  current.wind += (target.wind - current.wind) * t;
  current.gloom += (target.gloom - current.gloom) * t;
  current.glow += (target.glow - current.glow) * t;
  current.tint[0] += (target.tint[0] - current.tint[0]) * t;
  current.tint[1] += (target.tint[1] - current.tint[1]) * t;
  current.tint[2] += (target.tint[2] - current.tint[2]) * t;

  return current;
}

/* ----------------------------------------------------------- day / night --- */

/** Seconds of wall-clock time for one full world day. Four minutes is a demo
 *  compromise: long enough that dusk feels like it arrived, short enough that a
 *  judge standing at the booth sees a sunset without waiting. */
export const DAY_LENGTH = 240;

/**
 * Time of day as 0..1, where 0 is midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset.
 *
 * Derived from the wall clock, not from elapsed session time, so everyone
 * connected sees the same sky at the same moment without syncing anything
 * through Supabase. Two people on a call comparing screens is the demo, and
 * this makes it free.
 */
export function timeOfDay(now = Date.now()): number {
  return ((now / 1000) % DAY_LENGTH) / DAY_LENGTH;
}

/** Sun elevation in radians for a given time of day. Peaks at noon. */
export function sunElevation(t: number): number {
  return Math.sin((t - 0.25) * Math.PI * 2) * (Math.PI / 2);
}

/**
 * How much daylight there is, 0..1, with a soft twilight either side of the
 * horizon. Used to crossfade the sky, stars, and lighting.
 *
 * Smoothstepped rather than clamped so dusk is a gradient and not a switch.
 */
export function daylight(t: number): number {
  const e = Math.sin(sunElevation(t));
  const s = Math.max(0, Math.min(1, (e + 0.22) / 0.44));
  return s * s * (3 - 2 * s);
}
