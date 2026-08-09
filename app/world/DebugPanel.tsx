// app/world/DebugPanel.tsx
//
// The instrument panel. Press ` (backtick) to open it.
//
// Why this exists: every weather bug so far has been invisible from inside the
// world. "Everything is too dark" turned out to be three zones stacking to a
// blend weight of 4.86 — a number nothing on screen reported, and which took a
// database query and a simulation to recover. The renderer knew it all along.
//
// So this shows the numbers the frame loop is actually using, live: the blended
// atmosphere under your feet, which zones are contributing and how much, and
// what the sun is doing. If the world looks wrong, the reason is on this panel.
//
// Two rules it follows:
//   - Reads the same refs the renderer reads. Never its own copy of anything,
//     because a debug view that computes its own answer can agree with itself
//     while the world is broken.
//   - Costs nothing when closed. The polling interval only runs while open, and
//     nothing here is mounted inside the Canvas, so it can't drop frames.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { Atmosphere, WeatherContribution } from './weather';
import { conditionFor, timeOfDay, daylight, DAY_LENGTH } from './weather';
import type { MinimapSelf } from './Minimap';

/** How often to read the live refs, in ms. 10Hz — readable, not a cost. */
const POLL_MS = 100;

export interface DebugPanelProps {
  /** The live, eased atmosphere the renderer is drawing from. */
  atmosphere: RefObject<Atmosphere>;
  /** Camera position, written every frame by Walker. */
  self: RefObject<MinimapSelf>;
  /** Every weather contribution in the world. */
  zones: readonly WeatherContribution[];
  counts: { patches: number; creatures: number; travellers: number };
  /** Pinned time of day, or null to follow the wall clock. */
  timeOverride: number | null;
  onTimeOverride: (t: number | null) => void;
  /** Jump the camera. Used by the teleport buttons. */
  onTeleport: (x: number, z: number) => void;
  onClose: () => void;
}

/** One labelled 0..1 bar. The bar is the point — numbers alone don't compare. */
function Meter({ label, value, max = 1, warn }: {
  label: string;
  value: number;
  max?: number;
  /** Above this, the bar turns amber — the value is in bug territory. */
  warn?: number;
}) {
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  const hot = warn !== undefined && value > warn;
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] text-white/45">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-[width] duration-100 ${
            hot ? 'bg-amber-400' : 'bg-sky-400'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={`w-10 shrink-0 text-right font-mono text-[10px] tabular-nums ${
          hot ? 'text-amber-300' : 'text-white/70'
        }`}
      >
        {value.toFixed(2)}
      </span>
    </div>
  );
}

export function DebugPanel({
  atmosphere,
  self,
  zones,
  counts,
  timeOverride,
  onTimeOverride,
  onTeleport,
  onClose,
}: DebugPanelProps) {
  // One state object polled at 10Hz rather than per-frame state: the panel is
  // for reading, and re-rendering React 60 times a second to animate a number
  // nobody can read that fast would cost more than everything it reports on.
  const [tick, setTick] = useState(0);
  const frame = useRef({ x: 0, z: 0 });

  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const w = atmosphere.current;
  const pos = self.current ?? { x: 0, z: 0, a: 0 };
  frame.current = { x: pos.x, z: pos.z };

  const t = timeOverride ?? timeOfDay();
  const day = daylight(t);

  // Which zones reach the player, and how hard. This is the number that
  // explained the darkness bug, so it is the headline of the panel.
  const contributing = zones
    .map((z) => {
      const dx = pos.x - z.x;
      const dz = pos.z - z.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const radius = z.payload.radius > 0 ? z.payload.radius : 220;
      if (dist > radius) return null;
      const f = 1 - Math.min(1, dist / radius);
      const smooth = f * f * (3 - 2 * f);
      const weight = smooth * Math.max(0, Math.min(1, z.payload.intensity));
      return { z, dist, weight, clears: conditionFor(z.payload.condition).clears === true };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .sort((a, b) => b.weight - a.weight);

  const stormWeight = contributing
    .filter((c) => !c.clears)
    .reduce((sum, c) => sum + c.weight, 0);
  const clearWeight = contributing
    .filter((c) => c.clears)
    .reduce((sum, c) => sum + c.weight * 1.35, 0);

  const clock = `${String(Math.floor(t * 24)).padStart(2, '0')}:${String(
    Math.floor(((t * 24) % 1) * 60),
  ).padStart(2, '0')}`;

  const teleport = useCallback(
    (x: number, z: number) => () => onTeleport(x, z),
    [onTeleport],
  );

  return (
    <div className="pointer-events-auto absolute left-6 top-32 z-40 max-h-[70vh] w-80 overflow-y-auto rounded-lg border border-white/10 bg-neutral-950/92 p-4 font-sans text-xs text-white/80 backdrop-blur">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Debug</h3>
        <button
          onClick={onClose}
          className="rounded px-2 py-0.5 text-[10px] text-white/40 transition hover:bg-white/10 hover:text-white/80"
        >
          ` close
        </button>
      </div>

      {/* -------- where you are -------- */}
      <div className="mt-3 flex items-center justify-between font-mono text-[10px] text-white/50 tabular-nums">
        <span>
          x {pos.x.toFixed(0)} · z {pos.z.toFixed(0)}
        </span>
        <span>
          {counts.patches} land · {counts.creatures} creat · {counts.travellers} live
        </span>
      </div>

      {/* -------- the blend, which is where the bugs live -------- */}
      <p className="mt-4 text-[10px] font-medium uppercase tracking-wide text-white/40">
        Weather here
      </p>

      <div className="mt-2 space-y-1.5">
        {/* Above ~1.6 the sampler is clamping — that is the state that used to
            black out the world, so it is flagged rather than merely shown. */}
        <Meter label="stack" value={stormWeight} max={4} warn={1.6} />
        {clearWeight > 0 && <Meter label="clearing" value={clearWeight} max={4} />}
        {w && (
          <>
            <Meter label="fog" value={w.fog} warn={0.9} />
            <Meter label="gloom" value={w.gloom} warn={0.9} />
            <Meter label="rain" value={w.rain} />
            <Meter label="snow" value={w.snow} />
            <Meter label="glow" value={w.glow} />
          </>
        )}
      </div>

      {w && (
        <div className="mt-2 flex items-center gap-2">
          <span className="w-16 shrink-0 text-[10px] text-white/45">tint</span>
          <span
            className="h-4 flex-1 rounded border border-white/15"
            style={{
              background: `rgb(${Math.round(w.tint[0] * 255)},${Math.round(
                w.tint[1] * 255,
              )},${Math.round(w.tint[2] * 255)})`,
            }}
          />
        </div>
      )}

      {/* -------- who is contributing -------- */}
      <p className="mt-4 text-[10px] font-medium uppercase tracking-wide text-white/40">
        Zones in range ({contributing.length} of {zones.length})
      </p>
      {contributing.length === 0 ? (
        <p className="mt-1 text-[10px] text-white/35">None — this is baseline clear sky.</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {contributing.slice(0, 8).map((c) => (
            <li
              key={c.z.id}
              className="flex items-center justify-between font-mono text-[10px] tabular-nums"
            >
              <span className={c.clears ? 'text-amber-300' : 'text-white/70'}>
                {c.clears ? '☀ ' : ''}
                {c.z.payload.condition}
              </span>
              <span className="text-white/40">
                {c.dist.toFixed(0)}m · w{c.weight.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* -------- time of day -------- */}
      <p className="mt-4 text-[10px] font-medium uppercase tracking-wide text-white/40">
        Time · {clock} {timeOverride === null ? '(live)' : '(pinned)'}
      </p>
      <input
        type="range"
        min={0}
        max={1}
        step={0.005}
        value={t}
        onChange={(e) => onTimeOverride(Number(e.target.value))}
        className="mt-2 w-full accent-amber-400"
      />
      <div className="mt-1 flex items-center justify-between">
        <div className="flex gap-1">
          {[
            ['dawn', 0.25],
            ['noon', 0.5],
            ['dusk', 0.75],
            ['night', 0.95],
          ].map(([label, v]) => (
            <button
              key={label as string}
              onClick={() => onTimeOverride(v as number)}
              className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/60 transition hover:bg-white/20"
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={() => onTimeOverride(null)}
          className="rounded px-1.5 py-0.5 text-[10px] text-white/40 transition hover:text-white/80"
        >
          unpin
        </button>
      </div>
      <p className="mt-1 font-mono text-[10px] text-white/30 tabular-nums">
        daylight {day.toFixed(2)} · full cycle {DAY_LENGTH}s
      </p>

      {/* -------- getting somewhere fast -------- */}
      <p className="mt-4 text-[10px] font-medium uppercase tracking-wide text-white/40">
        Teleport
      </p>
      <div className="mt-1 flex flex-wrap gap-1">
        <button
          onClick={teleport(0, 40)}
          className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-white/60 transition hover:bg-white/20"
        >
          spawn
        </button>
        {/* Straight to the densest weather, which is where problems show. */}
        {contributing.slice(0, 3).map((c) => (
          <button
            key={c.z.id}
            onClick={teleport(c.z.x, c.z.z)}
            className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-white/60 transition hover:bg-white/20"
          >
            {c.z.payload.condition} centre
          </button>
        ))}
      </div>

      <p className="mt-4 border-t border-white/10 pt-2 text-[10px] leading-relaxed text-white/30">
        Amber means a value is in the range that has caused visible bugs — a
        stack above 1.6 is being clamped by the sampler.
      </p>
    </div>
  );
}
