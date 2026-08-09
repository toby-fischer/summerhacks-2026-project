// app/dashboard/page.tsx
//
// "The Observatory" — a live view of the shared world from above. Reads the
// same `world_assets` table World.tsx writes to, subscribes to the same
// postgres_changes events, and joins the same traveller broadcast channel —
// so every number here is real and updates while you watch it.
'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { createClient } from '@supabase/supabase-js';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  joinTravellerChannel,
  makeSelfId,
  STALE_MS,
  type Traveller,
  type TravellerMap,
} from '../presence';
import {
  bucketByTime,
  buildingCharacter,
  countSince,
  countsByType,
  densityGrid,
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
  rowsSince,
  spatialPoints,
  themeInsight,
  weatherConditionCounts,
  weatherMood,
  withCumulative,
  type WorldAssetRow,
} from './analytics';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

const HOUR_MS = 60 * 60 * 1000;
const MIN15_MS = 15 * 60 * 1000;
const GROWTH_BUCKET_MS = 15 * 60 * 1000;
const TICK_MS = 15_000;
const PULSE_MS = 8_000;

/** Same palette as World.tsx assets / HUD. */
const TYPE_COLORS: Record<string, string> = {
  terrain: '#8fa8c8',
  building: '#c9a86a',
  animal: '#e8935a',
  weather: '#6dd3c8',
  vegetation: '#568544',
  sky_cloud: '#c8d4e0',
  creature: '#b98ee8',
};
const FALLBACK_COLOR = '#9aa4b5';
const typeColor = (t: string) => TYPE_COLORS[t] ?? FALLBACK_COLOR;

const TYPE_LABELS: Record<string, string> = {
  terrain: 'Terrain',
  building: 'Building',
  animal: 'Animal',
  weather: 'Weather',
  vegetation: 'Vegetation',
  sky_cloud: 'Cloud',
  creature: 'Creature',
};
const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;

type TimeRange = 'all' | '6h' | '1h';

const TIME_RANGE_MS: Record<TimeRange, number | null> = {
  all: null,
  '6h': 6 * HOUR_MS,
  '1h': HOUR_MS,
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-3 max-w-xl text-sm text-white/55">{children}</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pt-8">
      <h2 className="mb-3 text-base font-semibold text-white">{title}</h2>
      {children}
    </section>
  );
}

function TypeLegend({
  types,
  counts,
  active,
  onToggle,
}: {
  types: string[];
  counts: Record<string, number>;
  active?: Set<string>;
  onToggle?: (type: string) => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/60">
      {types.map((t) => {
        const on = !active || active.has(t);
        return (
          <button
            key={t}
            type="button"
            disabled={!onToggle}
            onClick={() => onToggle?.(t)}
            className={`inline-flex items-center gap-1.5 ${onToggle ? 'hover:text-white' : ''} ${
              on ? 'text-white/80' : 'text-white/30'
            }`}
          >
            <span className="inline-block h-2 w-2" style={{ background: on ? typeColor(t) : '#444' }} />
            {typeLabel(t)} {counts[t] ?? 0}
          </button>
        );
      })}
    </div>
  );
}

function TimeRangeChips({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (v: TimeRange) => void;
}) {
  const options: { id: TimeRange; label: string }[] = [
    { id: 'all', label: 'all time' },
    { id: '6h', label: 'last 6h' },
    { id: '1h', label: 'last hour' },
  ];
  return (
    <div className="mb-3 flex flex-wrap gap-3 text-sm">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={value === o.id ? 'text-white' : 'text-white/40 hover:text-white/70'}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ThemeBars({ items, color }: { items: { key: string; count: number; label?: string }[]; color: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.key}>
          <div className="mb-1 flex justify-between text-sm text-white/70">
            <span>{i.label ?? i.key}</span>
            <span className="text-white/40">{i.count}</span>
          </div>
          <div className="h-1 w-full bg-white/10">
            <div className="h-full" style={{ width: `${(i.count / max) * 100}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

const GRID = 'rgba(255,255,255,0.08)';
const tickStyle = { fill: 'rgba(255,255,255,0.35)', fontSize: 11 };
const tooltipStyle = {
  contentStyle: {
    background: 'rgba(0,0,0,0.9)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 8,
    fontSize: 12,
    color: '#fff',
  },
  labelStyle: { color: 'rgba(255,255,255,0.55)' },
};

export default function Dashboard() {
  const [rows, setRows] = useState<WorldAssetRow[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'offline'>(
    supabase ? 'connecting' : 'offline',
  );
  const [travellers, setTravellers] = useState<Traveller[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(() => new Set());
  const [mapHiddenTypes, setMapHiddenTypes] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pulseIds, setPulseIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;

    const toRow = (raw: Record<string, unknown>): WorldAssetRow => ({
      id: String(raw.id),
      x: Number(raw.x) || 0,
      z: Number(raw.z) || 0,
      color: typeof raw.color === 'string' ? raw.color : null,
      type: typeof raw.type === 'string' ? raw.type : 'unknown',
      properties: (raw.properties as Record<string, unknown> | null) ?? null,
      created_at: typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString(),
      world: typeof raw.world === 'string' ? raw.world : 'default',
    });

    const markPulse = (id: string) => {
      setPulseIds((prev) => new Set(prev).add(id));
      window.setTimeout(() => {
        setPulseIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, PULSE_MS);
    };

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
          const row = toRow(payload.new as Record<string, unknown>);
          setRows((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            markPulse(row.id);
            return [...prev, row];
          });
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'world_assets' },
        (payload) => {
          const row = toRow(payload.new as Record<string, unknown>);
          setRows((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'world_assets' },
        (payload) => {
          const old = payload.old as { id?: string };
          if (!old?.id) return;
          setRows((prev) => prev.filter((r) => r.id !== String(old.id)));
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
    const map: TravellerMap = new Map();
    const channel = joinTravellerChannel(supabase, selfId, (t) => {
      map.set(t.id, t);
    });

    const timer = window.setInterval(() => {
      const cutoff = performance.now();
      for (const [id, t] of map) {
        if (cutoff - t.seen > STALE_MS) map.delete(id);
      }
      // Outdoor only — interior coords are local to a building.
      setTravellers(
        [...map.values()].filter((t) => !t.interiorId).map((t) => ({ ...t })),
      );
    }, 500);

    return () => {
      window.clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, []);

  const scopedRows = useMemo(() => {
    const windowMs = TIME_RANGE_MS[timeRange];
    if (windowMs === null) return rows;
    return rowsSince(rows, now - windowMs);
  }, [rows, timeRange, now]);

  const types = useMemo(() => [...new Set(scopedRows.map((r) => r.type))].sort(), [scopedRows]);
  const allTypes = useMemo(() => [...new Set(rows.map((r) => r.type))].sort(), [rows]);
  const typeCounts = useMemo(() => countsByType(scopedRows), [scopedRows]);
  const allTypeCounts = useMemo(() => countsByType(rows), [rows]);

  const visibleTypes = useMemo(
    () => types.filter((t) => !hiddenTypes.has(t)),
    [types, hiddenTypes],
  );

  const growthData = useMemo(() => {
    const buckets = withCumulative(bucketByTime(scopedRows, GROWTH_BUCKET_MS));
    return buckets.map((b) => {
      const point: Record<string, number | string> = { start: b.start, label: formatTime(b.start) };
      for (const t of types) point[t] = b.cumulative[t] ?? 0;
      return point;
    });
  }, [scopedRows, types]);

  const activityBuckets = useMemo(() => bucketByTime(scopedRows, HOUR_MS), [scopedRows]);
  const activityData = useMemo(
    () => activityBuckets.map((b) => ({ start: b.start, label: formatTime(b.start), total: b.total })),
    [activityBuckets],
  );
  const peak = useMemo(() => peakBucket(activityBuckets), [activityBuckets]);

  const pieData = useMemo(
    () => types.map((t) => ({ name: typeLabel(t), type: t, value: typeCounts[t] ?? 0 })),
    [types, typeCounts],
  );

  const mapTypes = useMemo(
    () => allTypes.filter((t) => !mapHiddenTypes.has(t)),
    [allTypes, mapHiddenTypes],
  );

  const pointsByType = useMemo(() => {
    const map = new Map<string, { id: string; x: number; z: number }[]>();
    for (const p of spatialPoints(rows)) {
      if (mapHiddenTypes.has(p.type)) continue;
      if (!map.has(p.type)) map.set(p.type, []);
      map.get(p.type)!.push({ id: p.id, x: p.x, z: p.z });
    }
    return map;
  }, [rows, mapHiddenTypes]);

  const densityPoints = useMemo(() => {
    const cells = densityGrid(rows, 40);
    const max = Math.max(1, ...cells.map((c) => c.count));
    return cells.map((c) => ({
      x: c.cx,
      z: c.cz,
      count: c.count,
      r: 6 + (c.count / max) * 22,
    }));
  }, [rows]);

  const travellerPoints = useMemo(
    () => travellers.map((t) => ({ id: t.id, x: t.x, z: t.z, color: t.color })),
    [travellers],
  );

  const swatches = useMemo(() => paletteSwatches(rows), [rows]);
  const feed = useMemo(() => recentFeed(rows, 14, now), [rows, now]);

  const last15 = useMemo(() => countSince(rows, MIN15_MS, now), [rows, now]);
  const lastHour = useMemo(() => countSince(rows, HOUR_MS, now), [rows, now]);

  const pace = useMemo(() => pulse(rows), [rows]);
  const frontier = useMemo(() => frontierRadius(rows), [rows]);
  const hotspot = useMemo(() => hotspotCell(rows), [rows]);
  const rarest = useMemo(() => rarestType(allTypeCounts), [allTypeCounts]);
  const mood = useMemo(() => paletteMood(swatches), [swatches]);
  const skyMood = useMemo(() => weatherMood(rows), [rows]);
  const biggest = useMemo(() => largestBuilding(rows), [rows]);
  const weatherThemes = useMemo(() => weatherConditionCounts(rows), [rows]);
  const buildings = useMemo(() => buildingCharacter(rows), [rows]);
  const skyCloudCount = allTypeCounts.sky_cloud ?? 0;
  const vegetationCount = allTypeCounts.vegetation ?? 0;
  const themesNote = useMemo(
    () => themeInsight(allTypeCounts, weatherThemes, skyCloudCount),
    [allTypeCounts, weatherThemes, skyCloudCount],
  );

  const leadNote = useMemo(() => {
    if (rows.length === 0) {
      return status === 'offline' && !supabase
        ? 'Waiting for live data — connect Supabase to see the shared world here.'
        : 'Nothing has been drawn into this world yet — be the first.';
    }
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
      travellers.length === 0
        ? ' No other travellers online right now.'
        : ` ${travellers.length} other traveller${travellers.length === 1 ? '' : 's'} online right now.`;
    return `${total}${paceNote}${companyNote}`;
  }, [rows.length, pace, travellers.length, status]);

  const rarestNote = rarest
    ? `Rarest type: ${typeLabel(rarest.type).toLowerCase()}, with ${rarest.count} contribution${rarest.count === 1 ? '' : 's'}.`
    : null;

  const frontierNote =
    frontier > 0 ? `Furthest contribution is ${frontier.toFixed(0)}m from the origin (0, 0).` : null;
  const hotspotNote =
    hotspot && hotspot.count > 1
      ? `Densest area: ${hotspot.count} contributions within 30m of (${hotspot.cx.toFixed(0)}, ${hotspot.cz.toFixed(0)}).`
      : null;

  const moodNote = mood
    ? `Palette mood reads ${mood.label} (avg hue ${mood.hue}°)${skyMood ? `; weather mood is ${skyMood.label}` : ''}.`
    : skyMood
      ? `Weather mood is ${skyMood.label}.`
      : null;

  const biggestNote =
    biggest && biggest.width > 0
      ? `Largest building: ${biggest.width.toFixed(0)}m × ${biggest.depth.toFixed(0)}m, ${biggest.height.toFixed(0)}m tall.`
      : null;

  const isLive = status === 'live';

  const toggleType = (set: Set<string>, type: string): Set<string> => {
    const next = new Set(set);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    return next;
  };

  const factsSignature = useMemo(
    () =>
      JSON.stringify({
        totalContributions: rows.length,
        last15Minutes: last15,
        lastHour,
        countsByType: allTypeCounts,
        weatherConditions: weatherThemes,
        skyClouds: skyCloudCount,
        buildingCharacter: buildings
          ? {
              count: buildings.count,
              avgFootprint: Math.round(buildings.avgFootprint),
              avgHeight: Math.round(buildings.avgHeight),
              sizeBands: buildings.bands,
            }
          : null,
        busiestHour: peak ? { count: peak.total, around: formatTime(peak.start) } : null,
        paletteMoodLabel: mood?.label ?? null,
        averageHueDegrees: mood?.hue ?? null,
        weatherMood: skyMood?.label ?? null,
        densestSpot: hotspot,
        frontierRadiusMeters: Math.round(frontier),
        rarestType: rarest,
        largestBuilding: biggest,
        pace: {
          overallMinutesBetween: pace.overallMs ? Math.round(pace.overallMs / 60000) : null,
          recentMinutesBetween: pace.recentMs ? Math.round(pace.recentMs / 60000) : null,
        },
        travellersOnlineNow: travellers.length,
        mostRecentFiveTypes: feed.slice(0, 5).map((f) => f.type),
        topColors: swatches.slice(0, 5).map((s) => ({ color: s.color, count: s.count })),
        themeInsight: themesNote,
      }),
    [
      rows.length,
      last15,
      lastHour,
      allTypeCounts,
      weatherThemes,
      skyCloudCount,
      buildings,
      peak,
      mood,
      skyMood,
      hotspot,
      frontier,
      rarest,
      biggest,
      pace,
      travellers.length,
      feed,
      swatches,
      themesNote,
    ],
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

  const paceLabel = pace.overallMs ? formatDuration(pace.overallMs) : '—';

  return (
    <div className="min-h-screen w-full bg-black text-white">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-black/50 p-4 backdrop-blur">
          <div>
            <div className="flex items-center gap-4">
              <h1 className="text-lg font-semibold text-white">Infinite Terra</h1>
              <span className="text-base text-white/60">observatory</span>
            </div>
            <p className="mt-1 text-sm text-white/70">
              {rows.length} contribution{rows.length === 1 ? '' : 's'} · {lastHour} last hour ·{' '}
              {travellers.length} online
              {isLive ? ' · live' : status === 'offline' ? ' · offline' : ''}
            </p>
          </div>
          <Link
            href="/"
            className="text-base text-white/60 underline decoration-white/25 underline-offset-2 hover:text-white/90"
          >
            ← back to world
          </Link>
        </div>

        <p className="mt-8 max-w-2xl text-base text-white/80">{leadNote}</p>
        <p className="mt-2 text-sm text-white/50">
          {last15} in the last 15 min
          {pace.overallMs ? ` · avg every ${paceLabel}` : ''}
        </p>

        {curatorNote && (
          <p className="mt-6 max-w-2xl border-l-2 border-white/20 pl-4 text-sm text-white/65">
            {curatorNote}
          </p>
        )}

        <div className="mt-4 divide-y divide-white/10">
          <Section title="Growth">
            <TimeRangeChips value={timeRange} onChange={setTimeRange} />
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={growthData}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="label" tick={tickStyle} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={40} />
                  <YAxis tick={tickStyle} axisLine={false} tickLine={false} width={28} />
                  <Tooltip {...tooltipStyle} />
                  {visibleTypes.map((t) => (
                    <Area
                      key={t}
                      type="monotone"
                      dataKey={t}
                      name={typeLabel(t)}
                      stackId="1"
                      stroke={typeColor(t)}
                      fill={typeColor(t)}
                      fillOpacity={0.3}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <TypeLegend
              types={types}
              counts={typeCounts}
              active={new Set(visibleTypes)}
              onToggle={(t) => setHiddenTypes((prev) => toggleType(prev, t))}
            />
          </Section>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-12">
            <Section title="By hour">
              <TimeRangeChips value={timeRange} onChange={setTimeRange} />
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={activityData}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="label" tick={tickStyle} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={30} />
                    <YAxis tick={tickStyle} axisLine={false} tickLine={false} width={24} allowDecimals={false} />
                    <Tooltip {...tooltipStyle} />
                    <Bar dataKey="total" name="Contributions" fill="#8fa8c8" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {peak && (
                <Caption>
                  Peak: {peak.total} around {formatTime(peak.start)}.
                </Caption>
              )}
            </Section>

            <Section title="Mix">
              {pieData.length === 0 ? (
                <p className="text-sm text-white/40">Nothing in this time range yet.</p>
              ) : (
                <ul className="space-y-2">
                  {pieData
                    .filter((d) => !hiddenTypes.has(d.type) && d.value > 0)
                    .map((d) => {
                      const max = Math.max(1, ...pieData.map((p) => p.value));
                      return (
                        <li key={d.type}>
                          <div className="mb-1 flex justify-between text-sm text-white/70">
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className="inline-block h-2 w-2"
                                style={{ background: typeColor(d.type) }}
                              />
                              {d.name}
                            </span>
                            <span className="text-white/40">
                              {d.value}
                              <span className="ml-2 text-white/30">
                                {Math.round((d.value / Math.max(1, scopedRows.length)) * 100)}%
                              </span>
                            </span>
                          </div>
                          <div className="h-1.5 w-full bg-white/10">
                            <div
                              className="h-full"
                              style={{
                                width: `${(d.value / max) * 100}%`,
                                background: typeColor(d.type),
                              }}
                            />
                          </div>
                        </li>
                      );
                    })}
                </ul>
              )}
              <TypeLegend
                types={types}
                counts={typeCounts}
                active={new Set(visibleTypes)}
                onToggle={(t) => setHiddenTypes((prev) => toggleType(prev, t))}
              />
              {rarestNote && <Caption>{rarestNote}</Caption>}
            </Section>
          </div>

          <Section title="Map (world x / z)">
            <TypeLegend
              types={allTypes}
              counts={allTypeCounts}
              active={new Set(mapTypes)}
              onToggle={(t) => setMapHiddenTypes((prev) => toggleType(prev, t))}
            />
            <div className="mt-3 h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID} />
                  <XAxis
                    dataKey="x"
                    type="number"
                    tick={tickStyle}
                    axisLine={{ stroke: GRID }}
                    tickLine={false}
                    domain={['auto', 'auto']}
                  />
                  <YAxis
                    dataKey="z"
                    type="number"
                    tick={tickStyle}
                    axisLine={{ stroke: GRID }}
                    tickLine={false}
                    domain={['auto', 'auto']}
                    width={36}
                  />
                  <Tooltip {...tooltipStyle} cursor={{ stroke: GRID }} />
                  <Scatter
                    name="Density"
                    data={densityPoints}
                    legendType="none"
                    isAnimationActive={false}
                    shape={(props: { cx?: number; cy?: number; payload?: { r?: number } }) => (
                      <circle
                        cx={props.cx ?? 0}
                        cy={props.cy ?? 0}
                        r={props.payload?.r ?? 8}
                        fill="rgba(143,168,200,0.18)"
                      />
                    )}
                  />
                  {mapTypes.map((t) => (
                    <Scatter
                      key={t}
                      name={typeLabel(t)}
                      data={pointsByType.get(t) ?? []}
                      fill={typeColor(t)}
                      cursor="pointer"
                      onClick={(data) => {
                        const payload = data as { id?: string; payload?: { id?: string } };
                        const id = payload.id ?? payload.payload?.id;
                        if (id) setSelectedId(id);
                      }}
                    />
                  ))}
                  <Scatter name="Travellers" data={travellerPoints} fill="#fff" shape="diamond" />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-sm text-white/40">
              discs = density · diamonds = people online · click a point for the log
            </p>
            {(frontierNote || hotspotNote) && (
              <Caption>
                {frontierNote}
                {frontierNote && hotspotNote ? ' ' : ''}
                {hotspotNote}
              </Caption>
            )}
          </Section>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-12">
            <Section title="Themes">
              {weatherThemes.length === 0 && !buildings && skyCloudCount === 0 && vegetationCount === 0 ? (
                <p className="text-sm text-white/40">Nothing themed yet.</p>
              ) : (
                <div className="space-y-5">
                  {weatherThemes.length > 0 && (
                    <div>
                      <p className="mb-2 text-sm text-white/50">weather</p>
                      <ThemeBars
                        items={weatherThemes.map((w) => ({ key: w.key, count: w.count, label: w.key }))}
                        color="#6dd3c8"
                      />
                    </div>
                  )}
                  {buildings && (
                    <div>
                      <p className="mb-2 text-sm text-white/50">
                        buildings · avg {buildings.avgFootprint.toFixed(0)}m² / {buildings.avgHeight.toFixed(0)}m tall
                      </p>
                      <ThemeBars
                        items={buildings.bands.map((b) => ({ key: b.key, count: b.count, label: b.key }))}
                        color="#c9a86a"
                      />
                    </div>
                  )}
                  {vegetationCount > 0 && (
                    <p className="text-sm text-white/70">
                      {vegetationCount} vegetation planting{vegetationCount === 1 ? '' : 's'}
                    </p>
                  )}
                  {skyCloudCount > 0 && (
                    <p className="text-sm text-white/70">
                      {skyCloudCount} drawn cloud{skyCloudCount === 1 ? '' : 's'}
                    </p>
                  )}
                </div>
              )}
              {themesNote && <Caption>{themesNote}</Caption>}
            </Section>

            <Section title="Colors & mood">
              {mood || skyMood ? (
                <div className="space-y-3 text-sm text-white/70">
                  {mood && (
                    <p>
                      palette: <span className="text-white">{mood.label}</span> ({mood.hue}°)
                    </p>
                  )}
                  {skyMood && (
                    <p>
                      weather: <span className="text-white">{skyMood.label}</span> (
                      {skyMood.calmWeight.toFixed(0)} calm / {skyMood.heavyWeight.toFixed(0)} heavy)
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-white/40">No color/weather signal yet.</p>
              )}
              {swatches.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {swatches.map((s) => {
                    const size = 18 + Math.min(28, Math.sqrt(s.count) * 8);
                    return (
                      <div
                        key={s.color}
                        title={`${s.color} ×${s.count}`}
                        style={{ width: size, height: size, background: s.color }}
                      />
                    );
                  })}
                </div>
              )}
              {moodNote && <Caption>{moodNote}</Caption>}
            </Section>
          </div>

          <div className="w-full max-w-xl">
            <Section title="Log">
              {feed.length === 0 ? (
                <p className="text-sm text-white/40">Waiting…</p>
              ) : (
                <ul className="space-y-2">
                  {feed.map((f) => {
                    const pulsed = pulseIds.has(f.id);
                    const selected = selectedId === f.id;
                    return (
                      <li
                        key={f.id}
                        className={`flex flex-wrap items-baseline justify-between gap-x-3 text-sm ${
                          selected ? 'bg-white/10 px-2 py-1' : ''
                        }`}
                      >
                        <span className="text-white/75">
                          <span
                            className="mr-2 inline-block h-2 w-2 align-middle"
                            style={{ background: f.color ?? typeColor(f.type) }}
                          />
                          {typeLabel(f.type)}{' '}
                          <span className="text-white/40">
                            ({f.x.toFixed(0)}, {f.z.toFixed(0)})
                          </span>
                          {pulsed && <span className="ml-2 text-white/90">new</span>}
                        </span>
                        <span className="text-white/40">{f.relative}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {biggestNote && <Caption>{biggestNote}</Caption>}
            </Section>
          </div>
        </div>

        <p className="mt-10 text-sm text-white/40">live world_assets + presence</p>
      </div>
    </div>
  );
}
