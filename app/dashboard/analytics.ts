// app/dashboard/analytics.ts
//
// Pure aggregation over `world_assets` rows. No React, no Supabase client —
// same philosophy as terrain.ts: cheap to test, cheap to reuse, cheap to reason about.

export interface WorldAssetRow {
  id: string;
  x: number;
  z: number;
  color: string | null;
  type: string;
  properties: Record<string, unknown> | null;
  created_at: string;
  world: string;
}

/** Total rows per `type`. */
export function countsByType(rows: WorldAssetRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.type] = (out[r.type] ?? 0) + 1;
  return out;
}

export interface TimeBucket {
  /** Bucket start, ms epoch. */
  start: number;
  counts: Record<string, number>;
  total: number;
}

/**
 * Histogram of contributions into fixed-width buckets spanning the data's
 * own time range (first row's bucket to last row's bucket). Empty buckets
 * are included so a growth chart doesn't lie about gaps.
 */
export function bucketByTime(rows: WorldAssetRow[], bucketMs: number): TimeBucket[] {
  if (rows.length === 0) return [];
  const times = rows.map((r) => new Date(r.created_at).getTime()).filter((t) => Number.isFinite(t));
  if (times.length === 0) return [];
  const min = Math.min(...times);
  const max = Math.max(...times);
  const alignedStart = Math.floor(min / bucketMs) * bucketMs;

  const map = new Map<number, TimeBucket>();
  for (let t = alignedStart; t <= max; t += bucketMs) {
    map.set(t, { start: t, counts: {}, total: 0 });
  }
  for (const row of rows) {
    const t = new Date(row.created_at).getTime();
    if (!Number.isFinite(t)) continue;
    const bucketStart = Math.floor(t / bucketMs) * bucketMs;
    let bucket = map.get(bucketStart);
    if (!bucket) {
      bucket = { start: bucketStart, counts: {}, total: 0 };
      map.set(bucketStart, bucket);
    }
    bucket.counts[row.type] = (bucket.counts[row.type] ?? 0) + 1;
    bucket.total += 1;
  }
  return [...map.values()].sort((a, b) => a.start - b.start);
}

export interface CumulativeBucket extends TimeBucket {
  cumulative: Record<string, number>;
  cumulativeTotal: number;
}

/** Running totals per type, for a stacked "growth over the event" area chart. */
export function withCumulative(buckets: TimeBucket[]): CumulativeBucket[] {
  const running: Record<string, number> = {};
  let runningTotal = 0;
  return buckets.map((b) => {
    for (const [type, n] of Object.entries(b.counts)) {
      running[type] = (running[type] ?? 0) + n;
    }
    runningTotal += b.total;
    return { ...b, cumulative: { ...running }, cumulativeTotal: runningTotal };
  });
}

/** The single busiest bucket, for a "peak activity" stat. */
export function peakBucket(buckets: TimeBucket[]): TimeBucket | null {
  if (buckets.length === 0) return null;
  return buckets.reduce((max, b) => (b.total > max.total ? b : max), buckets[0]);
}

/** Rows created within `windowMs` of `nowMs`. */
export function countSince(rows: WorldAssetRow[], windowMs: number, nowMs = Date.now()): number {
  const cutoff = nowMs - windowMs;
  let n = 0;
  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    if (Number.isFinite(t) && t >= cutoff) n++;
  }
  return n;
}

export interface SpatialPoint {
  id: string;
  x: number;
  z: number;
  type: string;
}

/** Every asset's world-space position, for the top-down map. */
export function spatialPoints(rows: WorldAssetRow[]): SpatialPoint[] {
  return rows
    .filter((r) => Number.isFinite(r.x) && Number.isFinite(r.z))
    .map((r) => ({ id: r.id, x: r.x, z: r.z, type: r.type }));
}

export interface PaletteSwatch {
  color: string;
  count: number;
}

/** Distinct colors people have used, most-used first. */
export function paletteSwatches(rows: WorldAssetRow[]): PaletteSwatch[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (typeof r.color === 'string' && r.color.length > 0) {
      counts.set(r.color, (counts.get(r.color) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((a, b) => b.count - a.count);
}

export function relativeTime(fromMs: number, nowMs = Date.now()): string {
  const diffS = Math.floor(Math.max(0, nowMs - fromMs) / 1000);
  if (diffS < 5) return 'just now';
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export interface FeedItem {
  id: string;
  type: string;
  color: string | null;
  createdAt: string;
  relative: string;
  x: number;
  z: number;
}

/** Newest-first slice for a live activity feed. */
export function recentFeed(rows: WorldAssetRow[], n: number, nowMs = Date.now()): FeedItem[] {
  return [...rows]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, n)
    .map((r) => ({
      id: r.id,
      type: r.type,
      color: r.color,
      createdAt: r.created_at,
      relative: relativeTime(new Date(r.created_at).getTime(), nowMs),
      x: r.x,
      z: r.z,
    }));
}

// ---------------------------------------------------------------- insights ---
//
// The numbers above answer "how much". These answer "what's actually going
// on" — the kind of thing a person watching this world would notice, not a
// KPI tile would show.

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 5) return 'a few seconds';
  if (s < 60) return `${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

export interface Pulse {
  /** Average gap between contributions across the whole event. */
  overallMs: number | null;
  /** Average gap across the most recent few contributions. */
  recentMs: number | null;
}

/** How fast the world is currently being added to, vs. its own average. */
export function pulse(rows: WorldAssetRow[], recentN = 6): Pulse {
  const times = rows
    .map((r) => new Date(r.created_at).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length < 2) return { overallMs: null, recentMs: null };
  const overallMs = (times[times.length - 1] - times[0]) / (times.length - 1);
  const recentSlice = times.slice(-Math.min(recentN, times.length));
  const recentMs =
    recentSlice.length >= 2
      ? (recentSlice[recentSlice.length - 1] - recentSlice[0]) / (recentSlice.length - 1)
      : null;
  return { overallMs, recentMs };
}

/** How far the furthest contribution sits from where the world began (0,0). */
export function frontierRadius(rows: WorldAssetRow[]): number {
  let max = 0;
  for (const r of rows) {
    const d = Math.hypot(r.x, r.z);
    if (Number.isFinite(d) && d > max) max = d;
  }
  return max;
}

export interface Hotspot {
  cx: number;
  cz: number;
  count: number;
}

/** The single most crowded patch of ground, gridded into `cellSize`-unit cells. */
export function hotspotCell(rows: WorldAssetRow[], cellSize = 30): Hotspot | null {
  const cells = new Map<string, Hotspot>();
  for (const r of rows) {
    if (!Number.isFinite(r.x) || !Number.isFinite(r.z)) continue;
    const cellX = Math.floor(r.x / cellSize);
    const cellZ = Math.floor(r.z / cellSize);
    const key = `${cellX}:${cellZ}`;
    const existing = cells.get(key);
    if (existing) existing.count += 1;
    else cells.set(key, { cx: cellX * cellSize + cellSize / 2, cz: cellZ * cellSize + cellSize / 2, count: 1 });
  }
  let best: Hotspot | null = null;
  for (const cell of cells.values()) {
    if (!best || cell.count > best.count) best = cell;
  }
  return best;
}

export interface RareType {
  type: string;
  count: number;
}

/** The least-common type, when there's more than one type to compare against. */
export function rarestType(typeCounts: Record<string, number>): RareType | null {
  const entries = Object.entries(typeCounts);
  if (entries.length < 2) return null;
  let rarest: RareType | null = null;
  for (const [type, count] of entries) {
    if (!rarest || count < rarest.count) rarest = { type, count };
  }
  return rarest;
}

export interface LargestBuilding {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
}

/** The biggest building by footprint, if any exist. */
export function largestBuilding(rows: WorldAssetRow[]): LargestBuilding | null {
  let best: LargestBuilding | null = null;
  let bestArea = 0;
  for (const r of rows) {
    if (r.type !== 'building') continue;
    const p = r.properties ?? {};
    const width = Number(p.width) || 0;
    const depth = Number(p.depth) || 0;
    const height = Number(p.height) || 0;
    const area = width * depth;
    if (area > bestArea) {
      bestArea = area;
      best = { x: r.x, z: r.z, width, depth, height };
    }
  }
  return best;
}

/** Hue (0-360) from a `#rrggbb` string, or null if it doesn't parse. */
function hexToHue(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export interface PaletteMood {
  hue: number;
  label: string;
}

const MOOD_BANDS: { max: number; label: string }[] = [
  { max: 20, label: 'molten' },
  { max: 45, label: 'autumnal' },
  { max: 75, label: 'golden' },
  { max: 165, label: 'mossy' },
  { max: 200, label: 'glacial' },
  { max: 260, label: 'misty' },
  { max: 320, label: 'otherworldly' },
  { max: 361, label: 'molten' },
];

/** The community's average color, expressed as a mood rather than a hex code. */
export function paletteMood(swatches: PaletteSwatch[]): PaletteMood | null {
  let sumSin = 0;
  let sumCos = 0;
  let weight = 0;
  for (const s of swatches) {
    const hue = hexToHue(s.color);
    if (hue === null) continue;
    const rad = (hue * Math.PI) / 180;
    sumSin += Math.sin(rad) * s.count;
    sumCos += Math.cos(rad) * s.count;
    weight += s.count;
  }
  if (weight === 0) return null;
  let hue = (Math.atan2(sumSin / weight, sumCos / weight) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  const band = MOOD_BANDS.find((b) => hue <= b.max) ?? MOOD_BANDS[MOOD_BANDS.length - 1];
  return { hue: Math.round(hue), label: band.label };
}
