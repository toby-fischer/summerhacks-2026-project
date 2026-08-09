// app/weather.ts
//
// Pure blend over weather contributions. Mood is light cloudy sky + fog —
// kept soft so the scene stays bright. Legacy DB values (rain/snow) map in.

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

/** Fixed bright daytime sun — no night cycle washing the sky gray. */
export const SUN_POSITION: [number, number, number] = [90, 110, -100];

const BASE: WeatherField = {
  clear: 1,
  light: 0,
  overcast: 0,
  fog: 0,
  storm: 0,
  fogDensity: 0.0012,
  fogColor: '#c8daf0',
  lightDim: 1,
  cloudCoverage: 0.04,
  cloudColor: '#f2f6fb',
  cloudLow: 0.1,
};

function bucket(condition: WeatherCondition): keyof Pick<
  WeatherField,
  'clear' | 'light' | 'overcast' | 'fog' | 'storm'
> {
  return condition;
}

/**
 * Distance-weighted blend of nearby weather cells at world (x, z).
 * Outside all radii → calm bright day. Soft caps so weather never grays out the sky.
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
    0.35,
    0.04 + lightN * 0.14 + overcastN * 0.22 + stormN * 0.28 + fogN * 0.16,
  );
  const cloudLow = Math.min(0.3, lightN * 0.06 + overcastN * 0.12 + stormN * 0.16 + fogN * 0.22);
  const foggy = Math.min(1, fogN * 0.45 + stormN * 0.12 + overcastN * 0.06);
  const fogDensity = 0.0012 + foggy * 0.0012 + stormN * 0.0005;
  const lightDim = Math.max(
    0.9,
    1 - stormN * 0.08 - fogN * 0.05 - overcastN * 0.03 - lightN * 0.015,
  );

  let fogColor = '#c8daf0';
  if (stormN > 0.4) fogColor = '#b4c4d4';
  else if (fogN > 0.4) fogColor = '#c0ccd8';
  else if (overcastN > 0.35) fogColor = '#c4d2e2';

  let cloudColor = '#f5f8fc';
  if (stormN > overcastN && stormN > fogN) cloudColor = '#d8e0ea';
  else if (fogN > overcastN) cloudColor = '#e4eaf0';
  else if (overcastN > lightN) cloudColor = '#e8eef6';
  else if (lightN > clearN) cloudColor = '#eef3f9';

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

export function muteForInterior(field: WeatherField): WeatherField {
  return {
    ...field,
    fogDensity: Math.min(field.fogDensity, 0.002),
    cloudCoverage: field.cloudCoverage * 0.2,
    lightDim: Math.max(field.lightDim, 0.85),
  };
}

/** Player-drawn cloud blob in the sky. */
export interface SkyCloudAsset {
  id: string;
  x: number;
  z: number;
  sketch: string;
}
