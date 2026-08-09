// app/world/weather/conditions.ts
//
// Named weather conditions: "rain", "snow", "fog", "storm", "aurora".
//
// Same trick as terrain styles — a condition is a bag of numbers. The text
// agent maps a prompt onto one of these presets, and the renderer reads the
// numbers. The model never emits geometry or colours it invented, so it can
// never emit something that fails to render.
//
// Unlike terrain, weather is NOT baked into a mesh: these numbers are blended
// per-frame against every other weather contribution in range (see blend.ts).
// That means every field here has to be linearly interpolatable — a number or
// an RGB triple, never a string or an enum. Anything that can't be averaged
// with its neighbour doesn't belong in this struct.

/**
 * The blendable state of the atmosphere at one point in the world.
 *
 * Every field is 0..1 unless noted. This is the *only* thing the renderer
 * reads; conditions, agent params and defaults all collapse into one of these
 * before anything is drawn.
 */
export interface Atmosphere {
  /** Falling-rain density. Drives the rain instance count and opacity. */
  rain: number;
  /** Falling-snow density. Rain and snow can coexist — that's sleet. */
  snow: number;
  /** Ground fog thickness. Maps onto FogExp2 density. */
  fog: number;
  /** Cloud cover. Darkens the sky and desaturates the sun. */
  cloud: number;
  /** Wind speed in m/s. Shears precipitation sideways. */
  wind: number;
  /** How much the sun is muted, 0 = full daylight, 1 = overcast gloom. */
  gloom: number;
  /** Fog / horizon colour as linear RGB, 0..1 each. Blended componentwise. */
  tint: [number, number, number];
  /** Bioluminescent glow in the air. The house aesthetic — free at any distance. */
  glow: number;
}

export interface WeatherCondition {
  name: string;
  /** Shown in the UI when a condition is picked. */
  label: string;
  /** What this condition contributes at full intensity. */
  atmosphere: Atmosphere;
  /**
   * Marks a condition that CLEARS weather rather than adding it.
   *
   * Everything else in this file is additive, per the contract: contributions
   * accumulate and nobody's work can be erased. That rule is right for terrain
   * and creatures, which are objects someone made — but applied to weather it
   * produced a world that could only ever get darker, because a "clear" preset
   * whose atmosphere equals the baseline contributes exactly nothing. The
   * button existed and did nothing, and a storm was permanent.
   *
   * So clearing is a first-class operation instead of a preset that happens to
   * be a no-op. It doesn't delete anyone's row — every zone stays in the
   * database and keeps working elsewhere in the world. It just says "here, the
   * sky is calm", and the sampler weighs it against the storms overhead.
   */
  clears?: boolean;
}

/** Clear sky is the world's resting state, and the base every blend starts from. */
export const CLEAR: Atmosphere = {
  rain: 0,
  snow: 0,
  fog: 0.1,
  cloud: 0.18,
  wind: 0.8,
  gloom: 0,
  tint: [0.72, 0.78, 0.86],
  glow: 0.06,
};

/* --------------------------------------------------------------- presets --- */

export const CONDITIONS: Record<string, WeatherCondition> = {
  clear: {
    name: 'clear',
    label: 'Clear the sky',
    // The one condition that subtracts. Its atmosphere IS the baseline, so as
    // an additive contribution it was worth nothing; `clears` is what gives it
    // teeth. See the flag's documentation above.
    atmosphere: { ...CLEAR },
    clears: true,
  },

  rain: {
    name: 'rain',
    label: 'Rain',
    // Heavy fog with a cold blue-grey tint is what actually sells rain — the
    // falling drops alone read as visual noise unless the air behind them is
    // thick and the horizon is close.
    atmosphere: {
      rain: 1,
      snow: 0,
      fog: 0.55,
      cloud: 0.85,
      wind: 4,
      gloom: 0.7,
      tint: [0.34, 0.4, 0.48],
      glow: 0.1,
    },
  },

  snow: {
    name: 'snow',
    label: 'Snow',
    // Low wind so flakes drift rather than streak, and a bright tint: snow
    // scatters light back up, so snowy air is lighter than clear air, not darker.
    atmosphere: {
      rain: 0,
      snow: 1,
      fog: 0.45,
      cloud: 0.75,
      wind: 1.2,
      gloom: 0.45,
      tint: [0.78, 0.83, 0.9],
      glow: 0.14,
    },
  },

  fog: {
    name: 'fog',
    label: 'Fog',
    // No precipitation at all — just a wall of air. The cheapest condition in
    // the set and the most dramatic, because it hides the world's edge.
    atmosphere: {
      rain: 0,
      snow: 0,
      fog: 1,
      cloud: 0.5,
      wind: 0.4,
      gloom: 0.5,
      tint: [0.6, 0.63, 0.66],
      glow: 0.18,
    },
  },

  storm: {
    name: 'storm',
    label: 'Storm',
    // Rain plus hard wind plus near-black sky. Highest gloom in the set, so
    // walking into a storm zone visibly drains the colour out of the terrain.
    atmosphere: {
      rain: 1,
      snow: 0,
      // Thick enough that the horizon is gone and you can only see the terrain
      // immediately around you. This claustrophobia is most of what separates a
      // storm from rain — the drops are almost secondary.
      fog: 0.82,
      cloud: 1,
      wind: 12,
      // Was 1.0, which drained the sun to 28% and left the terrain colourless.
      // A storm should be oppressive, not unlit — at 0.85 the world still has
      // form and colour, it has just lost the sun.
      gloom: 0.85,
      // Was [0.1, 0.12, 0.17] — nearly black before anything blended, so two
      // overlapping storms read as a cave rather than as bad weather. This is
      // still the darkest tint in the set by a wide margin.
      tint: [0.17, 0.2, 0.26],
      glow: 0.12,
    },
  },

  aurora: {
    name: 'aurora',
    label: 'Aurora',
    // The house style. No precipitation, thin cold air, and a strong glow that
    // reads as bioluminescence against the dark palette. Looks best at night,
    // which the day/night cycle will reach on its own.
    atmosphere: {
      rain: 0,
      snow: 0,
      fog: 0.3,
      cloud: 0.12,
      wind: 0.6,
      gloom: 0.3,
      tint: [0.2, 0.55, 0.5],
      glow: 1,
    },
  },

  ash: {
    name: 'ash',
    label: 'Ashfall',
    // Snow's motion with a hot dark palette — pairs with the volcanic terrain
    // style. Reuses the snow particle path entirely, so it costs nothing new.
    atmosphere: {
      rain: 0,
      snow: 0.8,
      fog: 0.6,
      cloud: 0.9,
      wind: 2.5,
      gloom: 0.85,
      tint: [0.3, 0.22, 0.19],
      glow: 0.22,
    },
  },
};

export const DEFAULT_CONDITION = CONDITIONS.clear;

/** Look up a condition by name, falling back rather than throwing — a bad name
 *  from the agent must never break the render. */
export function conditionFor(name?: string): WeatherCondition {
  if (!name) return DEFAULT_CONDITION;
  return CONDITIONS[name.toLowerCase()] ?? DEFAULT_CONDITION;
}

/* ----------------------------------------------------------------- agent --- */

/**
 * The parameter schema this pipeline accepts from the text agent, per the
 * shared contract. Flat and numeric, matching the terrain pipeline's shape.
 */
export const AGENT_PARAM_SCHEMA = {
  condition: {
    type: 'enum',
    values: Object.keys(CONDITIONS),
    description: 'Base weather preset.',
  },
  intensity: {
    type: 'number',
    min: 0,
    max: 1,
    description: 'How strongly this weather applies at its centre.',
  },
  radius: {
    type: 'number',
    min: 40,
    max: 800,
    description: 'Radius of influence in metres.',
  },
} as const;

function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Turn agent params into a stored payload. Every field is optional and every
 * value is clamped, so a malformed response degrades to light rain rather than
 * to a broken world.
 *
 * The fallback matters: per the team plan, a judge pressing the button when the
 * API is down must still get weather.
 */
export function applyAgentParams(params: Record<string, unknown>): {
  condition: string;
  intensity: number;
  radius: number;
} {
  const name = typeof params.condition === 'string' ? params.condition.toLowerCase() : 'rain';
  return {
    condition: name in CONDITIONS ? name : 'rain',
    intensity: clamp(params.intensity, 0, 1, 0.7),
    radius: clamp(params.radius, 40, 800, 220),
  };
}
