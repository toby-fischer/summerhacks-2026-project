// app/presence.ts
//
// Live positions of other visitors.
//
// Deliberately Broadcast, not Presence and not postgres_changes:
//   - postgres_changes would mean a DB write per movement. Absurd at 10Hz.
//   - Presence tracks join/leave state; Supabase's own docs warn against
//     calling track() at high frequency, so it's wrong for a moving position.
//   - Broadcast is ephemeral fan-out with no persistence. Exactly this.
//
// See: https://supabase.com/docs/guides/realtime/presence

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

/** ~10Hz. Smooth once interpolated, and well inside Realtime's default limits. */
export const BROADCAST_MS = 100;
/** Drop a traveller after this long without a ping (tab closed, network died). */
export const STALE_MS = 5000;

export interface Traveller {
  id: string;
  x: number;
  /** Ground height — people stand on terrain of different elevations. */
  y: number;
  z: number;
  /** Heading in radians, for orienting the wisp. */
  a: number;
  color: string;
  /** Client clock, only ever compared against itself for staleness. */
  seen: number;
}

export type TravellerMap = Map<string, Traveller>;

/** Stable per-tab identity. Two tabs are two travellers, which is what you want. */
export function makeSelfId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Deterministic pleasant color from an id, so everyone renders you the same hue. */
export function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 85%, 68%)`;
}

export function joinTravellerChannel(
  supabase: SupabaseClient,
  selfId: string,
  onMove: (t: Traveller) => void,
): RealtimeChannel {
  const channel = supabase.channel('terra:travellers', {
    // We render our own position locally; no need to echo it back to ourselves.
    config: { broadcast: { self: false } },
  });

  channel
    .on('broadcast', { event: 'move' }, ({ payload }) => {
      const p = payload as Partial<Traveller>;
      if (!p || typeof p.id !== 'string' || p.id === selfId) return;
      if (typeof p.x !== 'number' || typeof p.z !== 'number') return;
      onMove({
        id: p.id,
        x: p.x,
        y: typeof p.y === 'number' ? p.y : 0,
        z: p.z,
        a: typeof p.a === 'number' ? p.a : 0,
        color: typeof p.color === 'string' ? p.color : colorForId(p.id),
        seen: performance.now(),
      });
    })
    .subscribe();

  return channel;
}

export function sendMove(channel: RealtimeChannel, data: Traveller) {
  // Only broadcast over WebSocket once connected; skip REST fallback during connection
  if (channel.state === 'joined') {
    channel.send({
      type: 'broadcast',
      event: 'move',
      payload: data,
    });
  }
}