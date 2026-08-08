// app/world/Minimap.tsx
//
// The world, from above, in a corner.
//
// This is onboarding disguised as navigation. A judge spawns onto an empty
// plain and the world reads as unbuilt until they happen to walk at something.
// The map answers "is there anything here?" before they take a step: a scatter
// of other people's mountains, with a "you are here" arrow that is obviously
// somewhere else. That contrast — dots over there, me over here — is what says
// "strangers made these, go look, then make one".
//
// Drawn to a 2D canvas rather than a second R3F <View>. The data is already
// x/z points in a known 2000m square, so the map is a handful of affine
// transforms; a second camera would re-render the whole scene every frame for
// a 200px square where terrain silhouettes wouldn't be legible anyway. This
// costs one canvas blit per frame at a capped rate and no scene traversal.

'use client';

import React, { useEffect, useRef } from 'react';
import type * as THREE from 'three';

import { styleFor, PATCH_SCALE } from './terrain';
import { conditionFor } from './weather';
import type { Traveller } from '../presence';

/** On-screen size of the map, in CSS pixels. */
const SIZE = 184;

/**
 * Map redraw rate, in Hz.
 *
 * The map is a glance target, not an instrument — nobody perceives a 15Hz
 * cursor as laggy at this size, and it keeps the 2D context off the critical
 * path on a phone that is already spending its budget on terrain. Decoupled
 * from useFrame on purpose: the map must keep working while the pointer is
 * unlocked and the panels are open.
 */
const FPS = 15;

export interface MinimapPoint {
  id: string;
  x: number;
  z: number;
  /** Terrain style name, for the palette. Undefined = default highlands. */
  style?: string;
}

export interface MinimapZone {
  id: string;
  x: number;
  z: number;
  radius: number;
  condition: string;
}

/**
 * Live camera state, read per-draw.
 *
 * A ref rather than props: the camera moves every frame and the map is mounted
 * outside the Canvas, so routing position through React state would re-render
 * the whole page at 60fps to move one triangle two pixels.
 */
export interface MinimapSelf {
  x: number;
  z: number;
  /** Heading in radians — camera.rotation.y. */
  a: number;
}

function rgb(t: readonly [number, number, number], alpha: number): string {
  return `rgba(${Math.round(t[0] * 255)}, ${Math.round(t[1] * 255)}, ${Math.round(t[2] * 255)}, ${alpha})`;
}

export function Minimap({
  half,
  patches,
  zones,
  travellers,
  self,
}: {
  /** WORLD_HALF — the map spans -half..+half on both axes. */
  half: number;
  patches: MinimapPoint[];
  zones: MinimapZone[];
  travellers: Traveller[];
  self: React.RefObject<MinimapSelf>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Latest data, read by the draw loop. The loop is started once and never
  // torn down on data change — restarting a rAF chain every time a traveller
  // moves would be its own performance problem.
  const data = useRef({ patches, zones, travellers, half });
  data.current = { patches, zones, travellers, half };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Render at device resolution so the arrow and rings aren't soft on a
    // retina laptop or a phone, then work in CSS pixels for the rest.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx.scale(dpr, dpr);

    let raf = 0;
    let last = 0;
    const interval = 1000 / FPS;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < interval) return;
      last = now;

      const { patches: ps, zones: zs, travellers: ts, half: h } = data.current;
      const me = self.current;

      // World metres -> map pixels. One scalar does both axes because the
      // world is square; +z is south, which is down on the map, so z maps
      // straight through with no flip.
      const k = SIZE / (h * 2);
      const px = (wx: number) => (wx + h) * k;
      const pz = (wz: number) => (wz + h) * k;

      ctx.clearRect(0, 0, SIZE, SIZE);

      // Ground. Matches the plain's colour, dimmed — the map should read as
      // the same world seen from above, not as a separate UI surface.
      ctx.fillStyle = 'rgba(28, 32, 24, 0.82)';
      ctx.fillRect(0, 0, SIZE, SIZE);

      // Weather first, underneath everything: it is atmosphere over the land,
      // and drawing it on top would veil the terrain it sits above.
      for (const z of zs) {
        const tint = conditionFor(z.condition).atmosphere.tint;
        const r = z.radius * k;
        const cx = px(z.x);
        const cy = pz(z.z);
        // Radial falloff rather than a flat disc, mirroring how the zone
        // actually blends in the world — a hard edge would imply a boundary
        // that isn't there.
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(r, 1));
        g.addColorStop(0, rgb(tint, 0.5));
        g.addColorStop(1, rgb(tint, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(r, 1), 0, Math.PI * 2);
        ctx.fill();
      }

      // Terrain. Drawn at true footprint size (PATCH_SCALE metres) rather than
      // as a fixed dot, so the map shows how much of the world is actually
      // built on — clusters read as a mountain range, which is the point.
      const rTerrain = Math.max(2.5, (PATCH_SCALE / 2) * k);
      for (const p of ps) {
        const palette = styleFor(p.style).palette;
        const cx = px(p.x);
        const cy = pz(p.z);
        ctx.fillStyle = palette.mid;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(cx, cy, rTerrain, 0, Math.PI * 2);
        ctx.fill();
        // Bright core at the summit colour: overlapping patches stack their
        // cores into a visibly denser ridge, matching the max-height blend.
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = palette.peak;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1.4, rTerrain * 0.22), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Other people, in their own broadcast colour — same hue as their wisp,
      // so a dot on the map and a glow on the horizon are recognizably one
      // person. Haloed, because a 3px dot on mixed terrain is easy to miss.
      for (const t of ts) {
        const cx = px(t.x);
        const cy = pz(t.z);
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = t.color;
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = t.color;
        ctx.beginPath();
        ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // You. An arrow, not a dot — heading is half of what makes a map
      // actionable ("the mountains are behind me").
      if (me) {
        const cx = px(me.x);
        const cy = pz(me.z);
        ctx.save();
        ctx.translate(cx, cy);
        // camera.rotation.y is 0 looking down -z (north/up here) and grows
        // counter-clockwise; canvas rotation grows clockwise. Negating maps
        // one to the other, so the arrow points where the camera looks.
        ctx.rotate(-me.a);
        ctx.beginPath();
        ctx.moveTo(0, -7);
        ctx.lineTo(4.6, 5.5);
        ctx.lineTo(0, 3);
        ctx.lineTo(-4.6, 5.5);
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.stroke();
        ctx.restore();
      }

      // World edge, last, so nothing overlaps the frame.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [self]);

  const built = patches.length;

  return (
    <div className="pointer-events-none absolute top-6 right-6 select-none">
      <div className="overflow-hidden rounded-lg border border-white/10 bg-black/40 backdrop-blur">
        <canvas
          ref={canvasRef}
          style={{ width: SIZE, height: SIZE }}
          className="block"
        />
      </div>
      {/* The caption is the actual onboarding line. "12 landforms" reads as a
          stat; naming them as other people's work is what makes the map an
          invitation rather than a legend. */}
      <p className="mt-1.5 text-right text-[11px] text-white/45">
        {built === 0 ? (
          <span className="text-emerald-300/80">Empty world — press E to build</span>
        ) : (
          <>
            {built} landform{built === 1 ? '' : 's'} ·{' '}
            <span className="text-white/70">press E to add yours</span>
          </>
        )}
      </p>
    </div>
  );
}
