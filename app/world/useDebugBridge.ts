// app/world/useDebugBridge.ts
//
// Pushes the world's live state to /api/debug and executes what comes back.
//
// This is the half that makes the world legible from outside the browser. The
// renderer knows everything — blend weights, the eased atmosphere, where the
// camera is — and until now none of it could leave the tab. Debugging meant
// describing the screen to someone who couldn't see it.
//
// One request per second, carrying a snapshot up and any queued commands down.
// The interval is deliberately slow: this is for a human or an agent reading
// state, and neither needs 10Hz. Nothing here runs inside the frame loop.
//
// DEV ONLY — the hook no-ops in production, and the route it talks to refuses
// there as well, so there are two independent reasons this cannot ship live.

'use client';

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import type { Atmosphere, WeatherContribution } from './weather';
import { conditionFor, timeOfDay, daylight } from './weather';
import type { MinimapSelf } from './Minimap';

/** How often the client reports in. 1Hz is plenty for reading state. */
const REPORT_MS = 1000;

const ENABLED = process.env.NODE_ENV !== 'production';

/** Match weather/blend.ts. Clearing contests the strongest single weather
 *  zone, not the sum — reporting it any other way would have the panel
 *  disagreeing with the sky it is supposed to explain. */
const CLEAR_AUTHORITY = 1.1;
const MIN_CONTEST = 0.35;

export interface DebugBridgeHandlers {
  onTeleport: (x: number, z: number) => void;
  onTime: (t: number | null) => void;
  onWeather: (condition: string, intensity: number, radius: number) => void;
  onClearView: () => void;
}

export interface DebugBridgeState {
  atmosphere: RefObject<Atmosphere>;
  self: RefObject<MinimapSelf>;
  zones: readonly WeatherContribution[];
  counts: { patches: number; creatures: number; travellers: number };
  timeOverride: number | null;
}

export function useDebugBridge(state: DebugBridgeState, handlers: DebugBridgeHandlers) {
  // Kept in a ref so the polling effect never has to be torn down and rebuilt
  // as the world changes underneath it — the interval is created once.
  const latest = useRef({ state, handlers });
  latest.current = { state, handlers };

  useEffect(() => {
    if (!ENABLED) return;
    let cancelled = false;

    const report = async () => {
      const { state: s, handlers: h } = latest.current;
      const w = s.atmosphere.current;
      const pos = s.self.current;
      if (!w || !pos) return;

      // Recompute the blend weights the sampler uses. Same falloff as
      // weather/blend.ts — this is the number that explained the darkness bug,
      // so it is the one thing worth duplicating rather than inferring.
      let stack = 0;
      let clearMax = 0;
      let weatherMax = 0;
      let inRange = 0;
      for (const z of s.zones) {
        const radius = z.payload.radius > 0 ? z.payload.radius : 220;
        const dx = pos.x - z.x;
        const dz = pos.z - z.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > radius) continue;
        inRange++;
        const f = 1 - Math.min(1, dist / radius);
        const weight =
          f * f * (3 - 2 * f) * Math.max(0, Math.min(1, z.payload.intensity));
        if (conditionFor(z.payload.condition).clears) {
          if (weight > clearMax) clearMax = weight;
        } else {
          stack += weight;
          if (weight > weatherMax) weatherMax = weight;
        }
      }

      // How much of the weather actually survives clearing, 0..1 — the single
      // number that explains why the sky looks the way it does.
      const calm =
        clearMax > 0 && weatherMax > 0
          ? Math.max(0, 1 - Math.min(1, (clearMax * CLEAR_AUTHORITY) / Math.max(weatherMax, MIN_CONTEST)))
          : 1;

      const t = s.timeOverride ?? timeOfDay();

      const notes: string[] = [];
      if (stack > 1.6) {
        notes.push(`weather stack ${stack.toFixed(2)} exceeds MAX_WEIGHT — sampler is clamping`);
      }
      if (w.fog > 0.95) notes.push('fog at maximum — visibility is near zero here');
      if (weatherMax > 0 && calm < 0.05) {
        notes.push(
          `weather here is fully cleared (clear ${clearMax.toFixed(2)} vs weather ${weatherMax.toFixed(2)}) — a clear zone is closer than the weather`,
        );
      }
      if (!s.counts.patches) notes.push('no terrain loaded');

      try {
        const res = await fetch('/api/debug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            self: { x: pos.x, z: pos.z, a: pos.a, y: 0 },
            atmosphere: {
              rain: +w.rain.toFixed(3),
              snow: +w.snow.toFixed(3),
              fog: +w.fog.toFixed(3),
              cloud: +w.cloud.toFixed(3),
              gloom: +w.gloom.toFixed(3),
              glow: +w.glow.toFixed(3),
              wind: +w.wind.toFixed(2),
              tint: w.tint.map((v) => +v.toFixed(3)),
            },
            blend: {
              stack: +stack.toFixed(3),
              clearing: +clearMax.toFixed(3),
              weatherMax: +weatherMax.toFixed(3),
              calm: +calm.toFixed(3),
              inRange,
            },
            counts: { ...s.counts, zones: s.zones.length },
            time: { t: +t.toFixed(4), daylight: +daylight(t).toFixed(3), pinned: s.timeOverride !== null },
            notes,
          }),
        });
        if (cancelled || !res.ok) return;

        // Anything queued from outside runs here, on the client, with the
        // handlers the world passed in — the endpoint never touches the scene.
        const { commands } = (await res.json()) as {
          commands?: { action: string; params: Record<string, number | string | null> }[];
        };
        for (const c of commands ?? []) {
          if (cancelled) return;
          const p = c.params ?? {};
          switch (c.action) {
            case 'teleport':
              h.onTeleport(Number(p.x) || 0, Number(p.z) || 0);
              break;
            case 'time':
              h.onTime(p.t === null || p.t === undefined ? null : Number(p.t));
              break;
            case 'weather':
              h.onWeather(
                String(p.condition ?? 'rain'),
                p.intensity === undefined ? 0.85 : Number(p.intensity),
                p.radius === undefined ? 260 : Number(p.radius),
              );
              break;
            case 'clearView':
              h.onClearView();
              break;
            case 'reload':
              window.location.reload();
              break;
          }
        }
      } catch {
        // The dev server going away is not an error worth reporting; the next
        // tick will reconnect on its own.
      }
    };

    const timer = window.setInterval(report, REPORT_MS);
    void report();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
}
