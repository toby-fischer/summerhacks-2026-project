// app/weather.ts
//
// Pure blend over weather contributions. Mood is cloudy sky + fog/light —
// no precipitation. Legacy DB values (rain/snow) map into cloudy types.

export type WeatherCondition = 'clear' | 'light' | 'overcast' | 'storm' | 'fog';

export interface WeatherAsset {
  id: string;
  x: number;
  z: number;
  condition: WeatherCondition;
  /** 0..1 */
  intensity: number;
  /** Falloff radius in world meters. */
  radius: number;
}

export const WEATHER_CONDITIONS: WeatherCondition[] = ['clear', 'light', 'overcast', 'storm', 'fog'];

export const WEATHER_LABELS: Record<WeatherCondition, string> = {
  clear: 'clear',
  light: 'light clouds',
  overcast: 'overcast',
  storm: 'storm clouds',
  fog: 'fog bank',
};

/** Normalize DB / UI condition strings into our cloudy set. */
export function normalizeCondition(v: unknown): WeatherCondition | null {
  if (typeof v !== 'string') return null;
  if (v === 'rain') return 'overcast';
  if (v === 'snow') return 'light';
  if ((WEATHER_CONDITIONS as string[]).includes(v)) return v as WeatherCondition;
  return null;
}

export function isWeatherCondition(v: unknown): v is WeatherCondition {
  return normalizeCondition(v) !== null;
}

/** Smooth falloff: 1 at center, 0 at / beyond radius. */
function falloff(dist: number, radius: number): number {
  if (radius <= 0) return 0;
  const t = dist / radius;
  if (t >= 1) return 0;
  const x = 1 - t;
  return x * x * (3 - 2 * x);
}

export interface WeatherField {
  clear: number;
  light: number;
  overcast: number;
  fog: number;
  storm: number;
  fogDensity: number;
  fogColor: string;
  lightDim: number;
  /** 0..1 cloud opacity / coverage. */
  cloudCoverage: number;
  /** Cloud sheet tint. */
  cloudColor: string;
  /** How low the cloud deck sits (0 high/wispy, 1 low/heavy). */
  cloudLow: number;
}

const BASE: WeatherField = {
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

function bucket(condition: WeatherCondition): keyof Pick<
  WeatherField,
  'clear' | 'light' | 'overcast' | 'fog' | 'storm'
> {
  return condition;
}

/**
 * Distance-weighted blend of nearby weather cells at world (x, z).
 * Outside all radii → calm default day field.
 */
export function blendWeatherAt(assets: WeatherAsset[], x: number, z: number): WeatherField {
  const acc = { clear: 0, light: 0, overcast: 0, fog: 0, storm: 0 };
  let weightSum = 0;

  for (const a of assets) {
    const dist = Math.hypot(a.x - x, a.z - z);
    const w = a.intensity * falloff(dist, a.radius);
    if (w <= 1e-4) continue;
    weightSum += w;
    acc[bucket(a.condition)] += w;
  }

  if (weightSum < 1e-4) return { ...BASE };

  const clearN = acc.clear / weightSum;
  const lightN = acc.light / weightSum;
  const overcastN = acc.overcast / weightSum;
  const fogN = acc.fog / weightSum;
  const stormN = acc.storm / weightSum;

  const cloudCoverage = Math.min(
    1,
    0.08 + lightN * 0.35 + overcastN * 0.7 + stormN * 0.9 + fogN * 0.55,
  );
  const cloudLow = Math.min(1, lightN * 0.2 + overcastN * 0.45 + stormN * 0.55 + fogN * 0.95);
  const foggy = Math.min(1, fogN + stormN * 0.4 + overcastN * 0.2);
  const fogDensity = 0.0022 + foggy * 0.007 + stormN * 0.0035;
  const lightDim = Math.max(
    0.25,
    1 - stormN * 0.55 - fogN * 0.3 - overcastN * 0.18 - lightN * 0.06,
  );

  let fogColor = '#b9c6d6';
  if (stormN > 0.35) fogColor = '#6a7380';
  else if (fogN > 0.35) fogColor = '#a8b0b8';
  else if (overcastN > 0.3) fogColor = '#9aa8b8';
  else if (lightN > 0.3) fogColor = '#c8d2de';

  let cloudColor = '#e4eaf2';
  if (stormN > overcastN && stormN > fogN) cloudColor = '#6e7684';
  else if (fogN > overcastN) cloudColor = '#b4bcc4';
  else if (overcastN > lightN) cloudColor = '#9aa6b4';
  else if (lightN > clearN) cloudColor = '#dce4ee';

  return {
    clear: clearN,
    light: lightN,
    overcast: overcastN,
    fog: fogN,
    storm: stormN,
    fogDensity,
    fogColor,
    lightDim,
    cloudCoverage,
    cloudColor,
    cloudLow,
  };
}

/** Full day cycle length in seconds (real time). */
export const DAY_CYCLE_SEC = 10 * 60;

export function sunPositionFromTime(elapsedSec: number): [number, number, number] {
  const phase = ((elapsedSec / DAY_CYCLE_SEC) % 1 + 1) % 1;
  const angle = phase * Math.PI * 2 - Math.PI / 2;
  const y = Math.sin(angle);
  const xz = Math.cos(angle);
  return [xz * 90, Math.max(-40, y * 120), -xz * 40 - 80];
}

export function daylightFactor(sunY: number): number {
  const t = (sunY + 15) / 80;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

export function muteForInterior(field: WeatherField): WeatherField {
  return {
    ...field,
    fogDensity: Math.min(field.fogDensity, 0.003),
    cloudCoverage: field.cloudCoverage * 0.25,
    lightDim: Math.max(field.lightDim, 0.7),
  };
}
