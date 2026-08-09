// app/dashboard/page.tsx
//
// "The Observatory" — a live view of the shared world from above. Reads the
// same `world_assets` table World.tsx writes to, subscribes to the same
// postgres_changes INSERT event, and joins the same traveller broadcast
// channel — so every number here is real and updates while you watch it.
'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Fraunces } from 'next/font/google';
import { createClient } from '@supabase/supabase-js';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { joinTravellerChannel, makeSelfId, STALE_MS, type TravellerMap } from '../presence';
import {
  bucketByTime,
  countsByType,
  formatDuration,
  frontierRadius,
  hotspotCell,
  largestBuilding,
  paletteMood,
  paletteSwatches,
  peakBucket,
  pulse,
  rarestType,
  recentFeed,
  spatialPoints,
  withCumulative,
  type WorldAssetRow,
} from './analytics';

const display = Fraunces({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400', '500', '600'],
});

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
// No auth needed here — disable session persistence so this read-only page
// doesn't spawn a second GoTrueClient fighting World.tsx's over the same
// storage key.
const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

const HOUR_MS = 60 * 60 * 1000;
const GROWTH_BUCKET_MS = 15 * 60 * 1000;
const TICK_MS = 15_000;

const PAPER = '#f3ede1';
const INK = 'rgba(243,237,225,0.55)';
const INK_FAINT = 'rgba(243,237,225,0.3)';
const HAIRLINE = 'rgba(243,237,225,0.12)';

const TYPE_COLORS: Record<string, string> = {
  terrain: '#8fa8c8',
  building: '#c9a86a',
  animal: '#e8935a',
  weather: '#6dd3c8',
  creature: '#b98ee8',
};
const FALLBACK_COLOR = '#9aa4b5';
const typeColor = (t: string) => TYPE_COLORS[t] ?? FALLBACK_COLOR;

const TYPE_LABELS: Record<string, string> = {
  terrain: 'Terrain',
  building: 'Building',
  animal: 'Animal',
  weather: 'Weather',
  creature: 'Creature',
};
const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Deterministic sine-blend contour line, so SSR and the client render the same field. */
function contourPath(seed: number, amplitude: number, freq: number, yBase: number, width: number): string {
  const steps = 48;
  let d = `M 0 ${yBase.toFixed(1)}`;
  for (let i = 1; i <= steps; i++) {
    const x = (width / steps) * i;
    const y =
      yBase +
      Math.sin(i * freq + seed) * amplitude +
      Math.sin(i * freq * 0.47 + seed * 1.7) * amplitude * 0.4;
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

const CONTOUR_WIDTH = 1600;
const CONTOUR_LINES = Array.from({ length: 10 }, (_, i) => ({
  d: contourPath(i * 0.9, 16 + (i % 3) * 7, 0.22 + (i % 4) * 0.035, 40 + i * 88, CONTOUR_WIDTH),
  opacity: 0.05 + (i % 3) * 0.02,
}));

/** Faint topographic lines standing in for the generic gradient-blob backdrop. */
function ContourField() {
  return (
    <svg
      className="pointer-events-none fixed inset-0 h-full w-full"
      viewBox={`0 0 ${CONTOUR_WIDTH} 900`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      {CONTOUR_LINES.map((l, i) => (
        <path key={i} d={l.d} fill="none" stroke="#8fa8c8" strokeWidth={1} opacity={l.opacity} />
      ))}
    </svg>
  );
}

/** Plain insight under a chart. */
function Caption({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 max-w-xl text-sm leading-relaxed" style={{ color: INK }}>
      {children}
    </p>
  );
}

function Section({
  index,
  title,
  subtitle,
  children,
}: {
  index: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="pt-6" style={{ borderTop: `1px solid ${HAIRLINE}` }}>
      <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[11px]" style={{ color: INK_FAINT }}>
          {index}
        </span>
        <h2 className={`${display.className} text-lg`} style={{ color: PAPER }}>
          {title}
        </h2>
        {subtitle && (
          <span className="text-xs" style={{ color: INK_FAINT }}>
            — {subtitle}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function TypeLegend({ types, counts }: { types: string[]; counts: Record<string, number> }) {
  return (
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5">
      {types.map((t) => (
        <span key={t} className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color: INK }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: typeColor(t) }} />
          {typeLabel(t)} <span style={{ color: INK_FAINT }}>· {counts[t] ?? 0}</span>
        </span>
      ))}
    </div>
  );
}

const tickStyle = { fill: INK_FAINT, fontSize: 10, fontFamily: 'var(--font-geist-mono)' };
const tooltipStyle = {
  contentStyle: {
    background: 'rgba(9,10,8,0.94)',
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 4,
    fontSize: 12,
    color: PAPER,
  },
  labelStyle: { color: INK },
};

export default function Dashboard() {
  const [rows, setRows] = useState<WorldAssetRow[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'offline'>(
    supabase ? 'connecting' : 'offline',
  );
  const [travellerCount, setTravellerCount] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Keep "N ago" labels and rolling windows fresh even when nothing new arrives.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    supabase
      .from('world_assets')
      .select('*')
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        setRows(data as WorldAssetRow[]);
      });

    const channel = supabase
      .channel('dashboard:world_assets')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'world_assets' },
        (payload) => {
          const row = payload.new as WorldAssetRow;
          setRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [...prev, row]));
        },
      )
      .subscribe((s) => {
        if (s === 'SUBSCRIBED') setStatus('live');
        else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setStatus('offline');
      });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (!supabase) return;
    const selfId = makeSelfId();
    const travellers: TravellerMap = new Map();
    const channel = joinTravellerChannel(supabase, selfId, (t) => {
      travellers.set(t.id, t);
    });

    const timer = window.setInterval(() => {
      const cutoff = performance.now();
      for (const [id, t] of travellers) {
        if (cutoff - t.seen > STALE_MS) travellers.delete(id);
      }
      setTravellerCount(travellers.size);
    }, 1000);

    return () => {
      window.clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, []);

  const types = useMemo(() => [...new Set(rows.map((r) => r.type))].sort(), [rows]);
  const typeCounts = useMemo(() => countsByType(rows), [rows]);

  const growthData = useMemo(() => {
    const buckets = withCumulative(bucketByTime(rows, GROWTH_BUCKET_MS));
    return buckets.map((b) => {
      const point: Record<string, number | string> = { start: b.start, label: formatTime(b.start) };
      for (const t of types) point[t] = b.cumulative[t] ?? 0;
      return point;
    });
  }, [rows, types]);

  const activityBuckets = useMemo(() => bucketByTime(rows, HOUR_MS), [rows]);
  const activityData = useMemo(
    () => activityBuckets.map((b) => ({ start: b.start, label: formatTime(b.start), total: b.total })),
    [activityBuckets],
  );
  const peak = useMemo(() => peakBucket(activityBuckets), [activityBuckets]);

  const pieData = useMemo(
    () => types.map((t) => ({ name: typeLabel(t), type: t, value: typeCounts[t] ?? 0 })),
    [types, typeCounts],
  );

  const pointsByType = useMemo(() => {
    const map = new Map<string, { x: number; z: number }[]>();
    for (const p of spatialPoints(rows)) {
      if (!map.has(p.type)) map.set(p.type, []);
      map.get(p.type)!.push({ x: p.x, z: p.z });
    }
    return map;
  }, [rows]);

  const swatches = useMemo(() => paletteSwatches(rows), [rows]);
  const feed = useMemo(() => recentFeed(rows, 12, now), [rows, now]);

  // Things a person watching the world would notice, not a KPI would show.
  const pace = useMemo(() => pulse(rows), [rows]);
  const frontier = useMemo(() => frontierRadius(rows), [rows]);
  const hotspot = useMemo(() => hotspotCell(rows), [rows]);
  const rarest = useMemo(() => rarestType(typeCounts), [typeCounts]);
  const mood = useMemo(() => paletteMood(swatches), [swatches]);
  const biggest = useMemo(() => largestBuilding(rows), [rows]);

  const leadNote = useMemo(() => {
    if (rows.length === 0) return 'Nothing has been drawn into this world yet — be the first.';
    const total = `${rows.length} contribution${rows.length === 1 ? '' : 's'} total.`;
    let paceNote = '';
    if (pace.overallMs) {
      const overall = formatDuration(pace.overallMs);
      if (pace.recentMs) {
        const ratio = pace.recentMs / pace.overallMs;
        const recent = formatDuration(pace.recentMs);
        if (ratio < 0.65) paceNote = ` New contribution every ${recent} recently, vs. an average of ${overall}.`;
        else if (ratio > 1.6) paceNote = ` Last few contributions were ${recent} apart, slower than the ${overall} average.`;
        else paceNote = ` Averaging one every ${overall}.`;
      } else {
        paceNote = ` Averaging one every ${overall}.`;
      }
    }
    const companyNote =
      travellerCount === 0
        ? ' No other travellers online right now.'
        : ` ${travellerCount} other traveller${travellerCount === 1 ? '' : 's'} online right now.`;
    return `${total}${paceNote}${companyNote}`;
  }, [rows.length, pace, travellerCount]);

  const rarestNote = rarest
    ? `Rarest type: ${typeLabel(rarest.type).toLowerCase()}, with ${rarest.count} contribution${rarest.count === 1 ? '' : 's'}.`
    : null;

  const frontierNote =
    frontier > 0 ? `Furthest contribution is ${frontier.toFixed(0)}m from the origin (0, 0).` : null;
  const hotspotNote =
    hotspot && hotspot.count > 1
      ? `Densest area: ${hotspot.count} contributions within 30m of (${hotspot.cx.toFixed(0)}, ${hotspot.cz.toFixed(0)}).`
      : null;

  const moodNote = mood ? `Average color hue: ${mood.hue}°.` : null;

  const biggestNote =
    biggest && biggest.width > 0
      ? `Largest building: ${biggest.width.toFixed(0)}m × ${biggest.depth.toFixed(0)}m, ${biggest.height.toFixed(0)}m tall.`
      : null;

  const isLive = status === 'live';

  // A compact, non-identifying summary — this is all Gemini ever sees, never
  // the raw table. Changes only when the underlying facts actually change,
  // so the curator's note is event-driven rather than polled on a timer.
  const factsSignature = useMemo(
    () =>
      JSON.stringify({
        totalContributions: rows.length,
        countsByType: typeCounts,
        busiestHour: peak ? { count: peak.total, around: formatTime(peak.start) } : null,
        averageHueDegrees: mood?.hue ?? null,
        densestSpot: hotspot,
        frontierRadiusMeters: Math.round(frontier),
        rarestType: rarest,
        largestBuilding: biggest,
        pace: {
          overallMinutesBetween: pace.overallMs ? Math.round(pace.overallMs / 60000) : null,
          recentMinutesBetween: pace.recentMs ? Math.round(pace.recentMs / 60000) : null,
        },
        travellersOnlineNow: travellerCount,
        mostRecentFiveTypes: feed.slice(0, 5).map((f) => f.type),
        topColors: swatches.slice(0, 5).map((s) => ({ color: s.color, count: s.count })),
      }),
    [rows.length, typeCounts, peak, mood, hotspot, frontier, rarest, biggest, pace, travellerCount, feed, swatches],
  );

  const [curatorNote, setCuratorNote] = useState<string | null>(null);
  useEffect(() => {
    if (rows.length === 0) return;
    let cancelled = false;
    fetch('/api/curator-note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: factsSignature,
    })
      .then((r) => r.json())
      .then((d: { note?: string | null }) => {
        if (!cancelled && d.note) setCuratorNote(d.note);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [factsSignature, rows.length]);

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-[#0a0b09]" style={{ color: PAPER }}>
      <ContourField />
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, #fff 0px, transparent 1px, transparent 3px)',
          mixBlendMode: 'overlay',
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-5xl px-6 py-14">
        <header className="pb-8" style={{ borderBottom: `1px solid ${HAIRLINE}` }}>
          <Link
            href="/"
            className="font-mono text-[10px] uppercase tracking-[0.2em] transition-colors hover:opacity-100"
            style={{ color: INK_FAINT }}
          >
            ← infinite terra
          </Link>
          <h1 className={`${display.className} mt-4 text-4xl sm:text-5xl`} style={{ color: PAPER }}>
            The Observatory
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed" style={{ color: INK }}>
            Live usage data from the shared world
            {isLive && <span style={{ color: INK_FAINT }}> · updating in realtime</span>}.
          </p>
        </header>

        <p className="max-w-2xl pt-9 text-base leading-relaxed sm:text-lg" style={{ color: PAPER }}>
          {leadNote}
        </p>

        {curatorNote && (
          <div className="max-w-2xl py-8" style={{ borderBottom: `1px solid ${HAIRLINE}` }}>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: INK_FAINT }}>
              AI insight
            </p>
            <p className="mt-2 text-sm leading-relaxed sm:text-base" style={{ color: INK }}>
              {curatorNote}
            </p>
          </div>
        )}
        {!curatorNote && <div className="pb-9" style={{ borderBottom: `1px solid ${HAIRLINE}` }} />}

        <div className="space-y-10 py-2">
          <Section index="01" title="Growth" subtitle="cumulative contributions by type, 15-minute steps">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={growthData}>
                  <CartesianGrid stroke={HAIRLINE} vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={tickStyle}
                    axisLine={{ stroke: HAIRLINE }}
                    tickLine={false}
                    minTickGap={40}
                  />
                  <YAxis tick={tickStyle} axisLine={false} tickLine={false} width={28} />
                  <Tooltip {...tooltipStyle} />
                  {types.map((t) => (
                    <Area
                      key={t}
                      type="monotone"
                      dataKey={t}
                      name={typeLabel(t)}
                      stackId="1"
                      stroke={typeColor(t)}
                      fill={typeColor(t)}
                      fillOpacity={0.28}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <TypeLegend types={types} counts={typeCounts} />
          </Section>

          <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
            <Section index="02" title="Peak activity" subtitle="contributions per hour">
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={activityData}>
                    <CartesianGrid stroke={HAIRLINE} vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={tickStyle}
                      axisLine={{ stroke: HAIRLINE }}
                      tickLine={false}
                      minTickGap={30}
                    />
                    <YAxis tick={tickStyle} axisLine={false} tickLine={false} width={24} allowDecimals={false} />
                    <Tooltip {...tooltipStyle} />
                    <Bar dataKey="total" name="Contributions" fill="#8fa8c8" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {peak && (
                <Caption>
                  The busiest single hour saw {peak.total} new thing{peak.total === 1 ? '' : 's'} appear, around{' '}
                  {formatTime(peak.start)}.
                </Caption>
              )}
            </Section>

            <Section index="03" title="Composition" subtitle="share of contributions by type">
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip {...tooltipStyle} />
                    <Pie
                      data={pieData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={44}
                      outerRadius={74}
                      paddingAngle={2}
                      stroke="#0a0b09"
                    >
                      {pieData.map((d) => (
                        <Cell key={d.type} fill={typeColor(d.type)} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <TypeLegend types={types} counts={typeCounts} />
              {rarestNote && <Caption>{rarestNote}</Caption>}
            </Section>
          </div>

          <Section index="04" title="The shared canvas" subtitle="every asset's position, seen from above">
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={HAIRLINE} />
                  <XAxis
                    dataKey="x"
                    type="number"
                    name="x"
                    tick={tickStyle}
                    axisLine={{ stroke: HAIRLINE }}
                    tickLine={false}
                    domain={['auto', 'auto']}
                  />
                  <YAxis
                    dataKey="z"
                    type="number"
                    name="z"
                    tick={tickStyle}
                    axisLine={{ stroke: HAIRLINE }}
                    tickLine={false}
                    domain={['auto', 'auto']}
                    width={36}
                  />
                  <Tooltip {...tooltipStyle} cursor={{ stroke: HAIRLINE }} />
                  {types.map((t) => (
                    <Scatter key={t} name={typeLabel(t)} data={pointsByType.get(t) ?? []} fill={typeColor(t)} />
                  ))}
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <TypeLegend types={types} counts={typeCounts} />
            {(frontierNote || hotspotNote) && (
              <Caption>
                {frontierNote}
                {frontierNote && hotspotNote ? ' ' : ''}
                {hotspotNote}
              </Caption>
            )}
          </Section>

          <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
            <Section index="05" title="Palette" subtitle="every color drawn with, sized by frequency">
              {swatches.length === 0 ? (
                <p className="text-sm" style={{ color: INK_FAINT }}>
                  Nothing drawn yet.
                </p>
              ) : (
                <div className="flex flex-wrap gap-x-5 gap-y-3">
                  {swatches.map((s) => {
                    const size = 20 + Math.min(34, Math.sqrt(s.count) * 9);
                    return (
                      <div key={s.color} className="flex flex-col items-center gap-1.5">
                        <div
                          className="rounded-full"
                          style={{ width: size, height: size, background: s.color, border: `1px solid ${HAIRLINE}` }}
                          title={`used ${s.count} time${s.count === 1 ? '' : 's'}`}
                        />
                        <span className="font-mono text-[9px]" style={{ color: INK_FAINT }}>
                          {s.color.replace('#', '').toUpperCase()}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {moodNote && <Caption>{moodNote}</Caption>}
            </Section>

            <Section index="06" title="Log" subtitle="newest contributions first">
              {feed.length === 0 ? (
                <p className="text-sm" style={{ color: INK_FAINT }}>
                  Waiting for the first contribution…
                </p>
              ) : (
                <ul className="space-y-4 pl-5" style={{ borderLeft: `1px solid ${HAIRLINE}` }}>
                  {feed.map((f) => (
                    <li key={f.id} className="relative">
                      <span
                        className="absolute top-1 h-1.5 w-1.5 rounded-full"
                        style={{ left: '-21.5px', background: f.color ?? typeColor(f.type) }}
                      />
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-sm" style={{ color: INK }}>
                          {typeLabel(f.type)}{' '}
                          <span style={{ color: INK_FAINT }}>
                            at ({f.x.toFixed(0)}, {f.z.toFixed(0)})
                          </span>
                        </span>
                        <span className="font-mono text-[10px]" style={{ color: INK_FAINT }}>
                          {f.relative}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {biggestNote && <Caption>{biggestNote}</Caption>}
            </Section>
          </div>
        </div>

        <footer
          className="mt-12 flex flex-wrap items-center justify-between gap-3 pt-6 text-xs"
          style={{ borderTop: `1px solid ${HAIRLINE}`, color: INK_FAINT }}
        >
          <p style={{ color: INK_FAINT }}>Data from live `world_assets` + presence.</p>
          <Link href="/" className="font-mono uppercase tracking-[0.15em] hover:opacity-80">
            back to the world →
          </Link>
        </footer>
      </div>
    </div>
  );
}
