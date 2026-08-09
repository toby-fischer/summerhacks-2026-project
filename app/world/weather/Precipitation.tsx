// app/world/weather/Precipitation.tsx
//
// Rain and snow, as one draw call each, at a cost that does not depend on the
// size of the world or the number of contributions in it.
//
// The technique is the one from Peter Adams' "Cheap, Beautiful Rain in
// Three.js" (Antaeus AR), reimplemented here:
//
//   1. The particle volume is a CYLINDER CENTRED ON THE CAMERA, not the world.
//      You can only ever see weather near you, so simulating it anywhere else
//      is wasted work. This is what makes 200 contributions free — the count is
//      fixed no matter how many weather zones exist, because you are always
//      inside exactly one cylinder.
//
//   2. Drops RECYCLE IN THE VERTEX SHADER via mod() on elapsed time. Nothing is
//      respawned on the CPU, no attribute is rewritten per frame, and the JS
//      side does no per-particle work at all — it sets two uniforms.
//
//   3. Intensity scales the DRAW RANGE, not the buffer. Turning rain down
//      draws fewer of the same instances rather than rebuilding anything, so
//      intensity is free to animate continuously.
//
// The one non-obvious detail, also from Adams: points don't foreshorten. Look
// straight up in naive rain and the drops stay long vertical streaks, which is
// exactly wrong — you should be looking along their length. The vertex shader
// squashes each drop by the camera's pitch to fix it.

'use client';

import * as React from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

/** Radius of the simulated column, metres. Past this, fog hides everything. */
const RADIUS = 34;
/** Height of the column. Drops wrap within it. */
const HEIGHT = 46;

/** Buffer sizes. Intensity scales the *draw range* down from these. */
const RAIN_MAX = 6000;
const SNOW_MAX = 3500;

/**
 * Deterministic point cloud in a cylinder, plus a per-particle speed and phase.
 *
 * Uses the shared rng() rather than Math.random() as a matter of house rule.
 * Precipitation is camera-relative so nobody can actually see that yours
 * matches theirs — but the rule exists so nobody has to check, and following it
 * here costs nothing.
 */
function makeParticles(count: number, seed: number, rand: () => number) {
  const position = new Float32Array(count * 3);
  const attrs = new Float32Array(count * 3); // speed, phase, size

  for (let i = 0; i < count; i++) {
    // sqrt() on the radius keeps the disk uniformly dense. Without it every
    // drop crowds the centre and the rim looks empty.
    const r = Math.sqrt(rand()) * RADIUS;
    const theta = rand() * Math.PI * 2;

    position[i * 3] = Math.cos(theta) * r;
    position[i * 3 + 1] = rand() * HEIGHT;
    position[i * 3 + 2] = Math.sin(theta) * r;

    attrs[i * 3] = 0.7 + rand() * 0.6; // speed multiplier
    attrs[i * 3 + 1] = rand(); // phase, decorrelates the fall
    attrs[i * 3 + 2] = 0.6 + rand() * 0.8; // size
  }

  return { position, attrs };
}

/* ------------------------------------------------------------------ rain --- */

const RAIN_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uHeight;
  uniform float uFall;
  uniform float uWind;
  uniform float uPitch;
  uniform float uSize;
  uniform float uPixelRatio;

  attribute vec3 aAttr; // speed, phase, size

  varying float vFade;

  void main() {
    float speed = aAttr.x;
    float phase = aAttr.y;

    vec3 p = position;

    // The recycle. Total fall distance mod column height wraps each drop back
    // to the top the instant it passes the bottom — no CPU respawn, and the
    // column is seamless because every drop is somewhere different in the cycle.
    float fallen = (uTime * uFall * speed) + phase * uHeight;
    p.y = uHeight - mod(fallen, uHeight);

    // Wind shear. Drops lean into the wind and the lean scales with how far
    // they've fallen, so the sheet reads as slanted rather than merely offset.
    p.x += uWind * (uHeight - p.y) * 0.06;

    // Fade at the very top so recycled drops materialise instead of popping.
    vFade = smoothstep(uHeight, uHeight * 0.82, p.y);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // Foreshortening (Adams). Points always face the camera, so a drop viewed
    // end-on would still draw as a full-length streak. uPitch goes to 1 when
    // the camera looks straight up or down; squash the sprite to match.
    float squash = mix(1.0, 0.22, uPitch);
    gl_PointSize = uSize * aAttr.z * squash * uPixelRatio * (28.0 / -mv.z);
  }
`;

const RAIN_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vFade;

  void main() {
    // Elongate the point sprite into a streak: squeeze x hard, leave y alone.
    vec2 uv = gl_PointCoord - 0.5;
    uv.x *= 6.0;

    float d = length(uv);
    if (d > 0.5) discard;

    // Hard bright core with a narrow soft edge. A wide falloff turns every drop
    // into grey mush that disappears against dark terrain — the streak has to
    // stay near-white down its middle to read at all.
    float a = (1.0 - smoothstep(0.06, 0.42, d)) * uOpacity * vFade;
    if (a < 0.01) discard;

    gl_FragColor = vec4(uColor, a);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ snow --- */

const SNOW_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uHeight;
  uniform float uFall;
  uniform float uWind;
  uniform float uSize;
  uniform float uPixelRatio;

  attribute vec3 aAttr;

  varying float vFade;
  varying float vSpin;

  void main() {
    float speed = aAttr.x;
    float phase = aAttr.y;

    vec3 p = position;

    float fallen = (uTime * uFall * speed) + phase * uHeight;
    p.y = uHeight - mod(fallen, uHeight);

    // Flakes wander. Two sines at unrelated frequencies, offset per particle,
    // so no two follow the same path and the drift never visibly loops.
    float t = uTime * 0.5 + phase * 32.0;
    p.x += sin(t) * 1.4 + uWind * (uHeight - p.y) * 0.05;
    p.z += cos(t * 0.77) * 1.4;

    vFade = smoothstep(uHeight, uHeight * 0.82, p.y);
    vSpin = t;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * aAttr.z * uPixelRatio * (34.0 / -mv.z);
  }
`;

const SNOW_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vFade;
  varying float vSpin;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;

    // Round core with a soft halo — cheaper than a texture and it stays crisp
    // at any resolution, which matters on a high-DPI phone.
    float core = 1.0 - smoothstep(0.0, 0.42, d);
    float a = core * uOpacity * vFade;
    if (a < 0.01) discard;

    gl_FragColor = vec4(uColor, a);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------- component --- */

export interface PrecipitationProps {
  /** Live rain density 0..1. Read from a ref each frame, never from state. */
  rain: React.RefObject<number>;
  /** Live snow density 0..1. */
  snow: React.RefObject<number>;
  /** Live wind speed in m/s. */
  wind: React.RefObject<number>;
  /** Tint applied to precipitation so it reads against the current sky. */
  color?: THREE.ColorRepresentation;
  /** Scales both buffers. Drop to ~0.4 on a phone. */
  quality?: number;
}

/**
 * One Points cloud for rain, one for snow, both following the camera.
 *
 * Reads its inputs through refs rather than props-as-state: the blend runs at
 * 10Hz and eases every frame, and pushing that through React would re-render
 * the tree sixty times a second to change two floats.
 */
export function Precipitation({
  rain,
  snow,
  wind,
  color = '#cfe4ff',
  quality = 1,
}: PrecipitationProps) {
  const { camera, gl } = useThree();

  const rainRef = React.useRef<THREE.Points>(null);
  const snowRef = React.useRef<THREE.Points>(null);

  const rainCount = Math.max(64, Math.floor(RAIN_MAX * quality));
  const snowCount = Math.max(64, Math.floor(SNOW_MAX * quality));

  // Both clouds are built once. Nothing here reruns while the world is live.
  const rainGeo = React.useMemo(() => {
    // Local seeded RNG — see makeParticles.
    let s = 0x5eed >>> 0;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const { position, attrs } = makeParticles(rainCount, 0x5eed, rand);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('aAttr', new THREE.BufferAttribute(attrs, 3));
    // The cylinder rides with the camera, so a bounding sphere computed from
    // local coords would be wrong the moment you walk. Frustum culling is
    // disabled below; this just keeps three from computing a useless one.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), RADIUS * 2);
    return g;
  }, [rainCount]);

  const snowGeo = React.useMemo(() => {
    let s = 0xb17e >>> 0;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const { position, attrs } = makeParticles(snowCount, 0xb17e, rand);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('aAttr', new THREE.BufferAttribute(attrs, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), RADIUS * 2);
    return g;
  }, [snowCount]);

  React.useEffect(() => () => rainGeo.dispose(), [rainGeo]);
  React.useEffect(() => () => snowGeo.dispose(), [snowGeo]);

  const pixelRatio = Math.min(gl.getPixelRatio(), 2);

  const rainUniforms = React.useMemo(
    () => ({
      uTime: { value: 0 },
      uHeight: { value: HEIGHT },
      uFall: { value: 26 },
      uWind: { value: 0 },
      uPitch: { value: 0 },
      uSize: { value: 9 },
      uPixelRatio: { value: pixelRatio },
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0 },
    }),
    [color, pixelRatio],
  );

  const snowUniforms = React.useMemo(
    () => ({
      uTime: { value: 0 },
      uHeight: { value: HEIGHT },
      uFall: { value: 3.4 },
      uWind: { value: 0 },
      uSize: { value: 5.0 },
      uPixelRatio: { value: pixelRatio },
      uColor: { value: new THREE.Color('#ffffff') },
      uOpacity: { value: 0 },
    }),
    [pixelRatio],
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const r = rain.current ?? 0;
    const s = snow.current ?? 0;
    const w = wind.current ?? 0;

    // How far off horizontal the camera is looking, 0..1. Feeds foreshortening.
    const pitch = Math.min(1, Math.abs(camera.rotation.x) / (Math.PI / 2));

    if (rainRef.current) {
      const active = r > 0.01;
      rainRef.current.visible = active;
      if (active) {
        // Follow the camera in XZ only. Keeping the column's base at world y=0
        // means drops fall past you correctly whether you're in a valley or on
        // a peak; following y as well would drag the whole column up a mountain
        // and the rain would start below your feet.
        rainRef.current.position.set(camera.position.x, 0, camera.position.z);

        rainUniforms.uTime.value = t;
        rainUniforms.uWind.value = w;
        rainUniforms.uPitch.value = pitch;
        // Near-opaque at full intensity. Rain you can see through is rain you
        // can't see; the fog behind it is what provides the depth, not the
        // transparency of individual drops.
        rainUniforms.uOpacity.value = 0.95 * r;
        // Intensity as draw range: fewer of the same drops, no reallocation.
        rainGeo.setDrawRange(0, Math.floor(rainCount * r));
      }
    }

    if (snowRef.current) {
      const active = s > 0.01;
      snowRef.current.visible = active;
      if (active) {
        snowRef.current.position.set(camera.position.x, 0, camera.position.z);

        snowUniforms.uTime.value = t;
        snowUniforms.uWind.value = w;
        snowUniforms.uOpacity.value = 0.85 * s;
        snowGeo.setDrawRange(0, Math.floor(snowCount * s));
      }
    }
  });

  return (
    <>
      {/* frustumCulled off: the geometry's local bounds don't describe where it
          actually is once it's tracking the camera, so three's culling test
          would flicker the whole sheet in and out as you turn. */}
      <points ref={rainRef} geometry={rainGeo} frustumCulled={false} renderOrder={2}>
        <shaderMaterial
          uniforms={rainUniforms}
          vertexShader={RAIN_VERT}
          fragmentShader={RAIN_FRAG}
          transparent
          depthWrite={false}
          blending={THREE.NormalBlending}
        />
      </points>

      <points ref={snowRef} geometry={snowGeo} frustumCulled={false} renderOrder={2}>
        <shaderMaterial
          uniforms={snowUniforms}
          vertexShader={SNOW_VERT}
          fragmentShader={SNOW_FRAG}
          transparent
          depthWrite={false}
          blending={THREE.NormalBlending}
        />
      </points>
    </>
  );
}
