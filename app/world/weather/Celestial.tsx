// app/world/weather/Celestial.tsx
//
// The sun and the moon — the things you can actually point at.
//
// Until now the sky had a directional light moving on an arc but nothing to
// see, which is why the world read as "lit from somewhere" rather than as a
// time of day. A visible disc is what makes the cycle legible: you look up,
// you see where the sun is, and you know it's afternoon.
//
// Both are billboarded quads, not spheres. A sphere at this distance is a
// couple of hundred wasted triangles that renders to the same handful of
// pixels, and it has to be lit. A quad with a radial-gradient shader is two
// triangles, needs no lighting, and gives a soft limb that a sphere can't do
// without a bloom pass we're not paying for.

'use client';

import * as React from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import type { Atmosphere as AtmosphereState } from './conditions';
import { sunElevation, timeOfDay } from './blend';

/** How far out the discs sit. Inside the camera's far plane (3000), well
 *  outside anything anyone can build. */
const DISTANCE = 1400;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Bright core, soft falloff, and a wide faint halo.
 *
 * The halo is the part that sells it — a hard-edged disc looks like a sticker,
 * while a disc bleeding light into the sky around it looks like it's the thing
 * lighting the world. `uGlow` widens it in clear air and chokes it under cloud,
 * so an overcast sun is a dim smudge rather than a bright dot behind grey.
 */
const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHaloColor;
  uniform float uOpacity;
  uniform float uGlow;

  varying vec2 vUv;

  void main() {
    float d = length(vUv - 0.5) * 2.0;
    if (d > 1.0) discard;

    // Core: flat and bright out to ~0.32, then a quick soft edge.
    float core = 1.0 - smoothstep(0.30, 0.42, d);
    // Halo: wide, faint, falls off all the way to the quad's rim.
    float halo = pow(max(0.0, 1.0 - d), 2.6) * uGlow;

    vec3 color = mix(uHaloColor, uColor, core);
    float a = clamp(core + halo * 0.55, 0.0, 1.0) * uOpacity;
    if (a < 0.004) discard;

    gl_FragColor = vec4(color, a);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface CelestialProps {
  state: React.RefObject<AtmosphereState>;
  timeOverride?: number | null;
}

/**
 * Sun and moon on the same arc, half a day apart.
 *
 * Positions are recomputed from the same sunElevation() the lighting uses, so
 * the disc can never drift out of agreement with where the shadows say the sun
 * is — a mismatch there is the kind of thing that looks subtly broken without
 * anyone being able to say why.
 */
export function Celestial({ state, timeOverride = null }: CelestialProps) {
  const sunRef = React.useRef<THREE.Mesh>(null);
  const moonRef = React.useRef<THREE.Mesh>(null);

  const sunUniforms = React.useMemo(
    () => ({
      uColor: { value: new THREE.Color('#fff6de') },
      uHaloColor: { value: new THREE.Color('#ffd9a0') },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
    }),
    [],
  );

  const moonUniforms = React.useMemo(
    () => ({
      uColor: { value: new THREE.Color('#eaf0ff') },
      uHaloColor: { value: new THREE.Color('#9fb6e0') },
      uOpacity: { value: 1 },
      uGlow: { value: 0.7 },
    }),
    [],
  );

  const scratch = React.useMemo(() => ({ dir: new THREE.Vector3() }), []);

  useFrame(({ camera }) => {
    const w = state.current;
    if (!w) return;

    const t = timeOverride ?? timeOfDay();
    const elevation = sunElevation(t);
    const azimuth = t * Math.PI * 2;

    const cosE = Math.cos(elevation);
    scratch.dir.set(Math.cos(azimuth) * cosE, Math.sin(elevation), Math.sin(azimuth) * cosE);

    // Both discs ride with the camera, so they stay put on the horizon as you
    // walk instead of sliding past like distant scenery. This is what makes
    // them read as sky rather than as very large objects in the world.
    if (sunRef.current) {
      sunRef.current.position.copy(camera.position).addScaledVector(scratch.dir, DISTANCE);
      sunRef.current.lookAt(camera.position);

      // Fade out below the horizon rather than letting it clip through terrain.
      const above = THREE.MathUtils.smoothstep(scratch.dir.y, -0.12, 0.06);
      // Cloud and fog swallow it.
      const clarity = (1 - w.cloud * 0.75) * (1 - w.fog * 0.55);
      sunUniforms.uOpacity.value = above * clarity;
      sunRef.current.visible = sunUniforms.uOpacity.value > 0.01;

      // Low sun goes orange and swells; high sun is small, white and fierce.
      const low = 1 - THREE.MathUtils.clamp(scratch.dir.y * 3.2, 0, 1);
      sunUniforms.uColor.value.setRGB(1, 0.96 - low * 0.22, 0.88 - low * 0.44);
      sunUniforms.uHaloColor.value.setRGB(1, 0.82 - low * 0.2, 0.6 - low * 0.3);
      sunUniforms.uGlow.value = (0.7 + low * 1.5) * clarity;
      const scale = 62 + low * 34;
      sunRef.current.scale.setScalar(scale);
    }

    // Moon is opposite the sun on the same arc.
    if (moonRef.current) {
      scratch.dir.negate();
      moonRef.current.position.copy(camera.position).addScaledVector(scratch.dir, DISTANCE);
      moonRef.current.lookAt(camera.position);

      const above = THREE.MathUtils.smoothstep(scratch.dir.y, -0.12, 0.06);
      const clarity = (1 - w.cloud * 0.8) * (1 - w.fog * 0.6);
      moonUniforms.uOpacity.value = above * clarity * 0.95;
      moonRef.current.visible = moonUniforms.uOpacity.value > 0.01;
      moonRef.current.scale.setScalar(46);
    }
  });

  return (
    <>
      {/* depthWrite off + renderOrder -1: these are the furthest things in the
          scene and must never occlude terrain, however far out they sit. */}
      <mesh ref={sunRef} frustumCulled={false} renderOrder={-1}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial
          uniforms={sunUniforms}
          vertexShader={VERT}
          fragmentShader={FRAG}
          transparent
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      <mesh ref={moonRef} frustumCulled={false} renderOrder={-1}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial
          uniforms={moonUniforms}
          vertexShader={VERT}
          fragmentShader={FRAG}
          transparent
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
    </>
  );
}
