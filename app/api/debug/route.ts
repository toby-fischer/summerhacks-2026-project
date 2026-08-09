// app/api/debug/route.ts
//
// The bridge between the running world and whoever is debugging it from
// outside the browser — a terminal, a script, or an agent.
//
// Why it exists: every bug this project has hit was invisible from the outside.
// "Everything is too dark" was three weather zones stacking to a blend weight
// of 4.86, a number that existed only inside the frame loop. Recovering it took
// a database query plus a simulation of the blend, and the simulation could
// have been wrong. The browser knew the answer the whole time and had no way to
// say so.
//
// So the client POSTs its live state here, and anything can GET it. The server
// holds it in memory only: this is a debugging aid, not a feature, and state
// that survives a restart would go stale and start lying.
//
// The other direction matters too. GET /api/debug/command lets an outside
// process queue an action — jump somewhere, pin the clock, summon weather —
// which the client picks up on its next poll. That is what makes the world
// controllable rather than merely observable.
//
// DEV ONLY. Every handler refuses in production, because an endpoint that
// reports world state and accepts commands is not something to ship.

import { NextResponse } from 'next/server';

/** Refuse outside development. This endpoint is a workshop tool. */
const ENABLED = process.env.NODE_ENV !== 'production';

/** Drop reports older than this — a stale snapshot is worse than none. */
const STALE_MS = 10_000;

export interface DebugSnapshot {
  /** performance.now()-independent wall clock, set by the server on arrival. */
  at: number;
  /** Camera position and heading. */
  self: { x: number; z: number; a: number; y: number };
  /** The live, eased atmosphere the renderer is actually drawing from. */
  atmosphere: Record<string, number | number[]>;
  /** Blend weights at the player, which is where the darkness bugs live. */
  blend: { stack: number; clearing: number; inRange: number };
  counts: { patches: number; creatures: number; zones: number; travellers: number };
  time: { t: number; daylight: number; pinned: boolean };
  /** Whatever the client wants to flag — errors, warnings, notes. */
  notes: string[];
}

/**
 * One queued instruction for the client.
 *
 * Deliberately a tiny vocabulary of named actions rather than anything
 * evaluable: this endpoint exists to make debugging legible, and a command
 * channel that can run arbitrary code in the page is a different thing with
 * very different risks.
 */
export interface DebugCommand {
  id: number;
  action: 'teleport' | 'time' | 'weather' | 'clearView' | 'reload';
  params: Record<string, number | string | null>;
}

// Module scope persists across requests within one dev server process, which
// is all this needs. Restarting `next dev` clears it, correctly.
const store: { snapshot: DebugSnapshot | null; queue: DebugCommand[]; nextId: number } = {
  snapshot: null,
  queue: [],
  nextId: 1,
};

function disabled() {
  return NextResponse.json({ error: 'debug endpoint is disabled' }, { status: 404 });
}

/** GET /api/debug — the latest snapshot the client pushed. */
export async function GET() {
  if (!ENABLED) return disabled();

  const snap = store.snapshot;
  if (!snap) {
    return NextResponse.json({
      connected: false,
      hint: 'No client has reported yet. Open the world in a browser.',
    });
  }

  const age = Date.now() - snap.at;
  return NextResponse.json({
    connected: age < STALE_MS,
    ageMs: age,
    ...snap,
    pending: store.queue.length,
  });
}

/**
 * POST /api/debug — the client reporting in, or an outside caller queueing a
 * command. Distinguished by the body: a `command` key means the latter.
 */
export async function POST(request: Request) {
  if (!ENABLED) return disabled();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected JSON' }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;

  // -------- queue a command --------
  if (typeof payload.command === 'string') {
    const action = payload.command as DebugCommand['action'];
    const allowed: DebugCommand['action'][] = [
      'teleport',
      'time',
      'weather',
      'clearView',
      'reload',
    ];
    if (!allowed.includes(action)) {
      return NextResponse.json(
        { error: `unknown command '${action}'`, allowed },
        { status: 400 },
      );
    }
    const command: DebugCommand = {
      id: store.nextId++,
      action,
      params: (payload.params ?? {}) as DebugCommand['params'],
    };
    store.queue.push(command);
    return NextResponse.json({ queued: command });
  }

  // -------- a client snapshot --------
  store.snapshot = { ...(payload as unknown as DebugSnapshot), at: Date.now() };

  // Hand back anything queued and clear it, so each command runs once.
  const commands = store.queue;
  store.queue = [];
  return NextResponse.json({ ok: true, commands });
}

/** DELETE /api/debug — drop the snapshot and any queued commands. */
export async function DELETE() {
  if (!ENABLED) return disabled();
  store.snapshot = null;
  store.queue = [];
  return NextResponse.json({ ok: true });
}
