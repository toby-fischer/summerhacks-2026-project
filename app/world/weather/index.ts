// app/world/weather/index.ts
//
// The weather pipeline's public surface. Import from '@/app/world/weather',
// not from the files inside — that keeps the internals free to move.
//
//   conditions.ts      named presets + the text-agent schema (no React/Three)
//   blend.ts           sampling, easing, day/night maths (no React/Three)
//   Atmosphere.tsx     sky, stars, lights, fog — composes the three below
//   Celestial.tsx      the sun and moon discs
//   Lightning.tsx      storm flashes
//   Precipitation.tsx  camera-relative rain and snow
//   Weather.tsx        the one component World.tsx mounts
//
// conditions.ts and blend.ts are pure — no React, no Three — so the agent
// route and any test can import them on the server without pulling in a
// renderer, the same way terrain/pipeline.ts stays importable.

export { Weather, type WeatherProps } from './Weather';

export {
  CONDITIONS,
  DEFAULT_CONDITION,
  CLEAR,
  conditionFor,
  applyAgentParams,
  AGENT_PARAM_SCHEMA,
  type Atmosphere,
  type WeatherCondition,
} from './conditions';

export {
  sampleInto,
  easeAtmosphere,
  makeAtmosphere,
  copyAtmosphere,
  timeOfDay,
  sunElevation,
  daylight,
  DAY_LENGTH,
  type WeatherContribution,
} from './blend';

export { AtmosphereRig, type AtmosphereProps } from './Atmosphere';
export { Precipitation, type PrecipitationProps } from './Precipitation';
export { Celestial, type CelestialProps } from './Celestial';
export { Lightning, type LightningProps } from './Lightning';
