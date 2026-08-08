#!/usr/bin/env node
// scripts/world.mjs
//
// Read and drive the running world from a terminal.
//
//   node scripts/world.mjs                     one snapshot
//   node scripts/world.mjs watch               live, until Ctrl-C
//   node scripts/world.mjs goto 20 -38         teleport
//   node scripts/world.mjs time noon           pin the clock (or: dawn/dusk/night/live)
//   node scripts/world.mjs weather storm        summon at the player
//   node scripts/world.mjs weather clear 1 400  ...with intensity and radius
//   node scripts/world.mjs rows                what is actually in the database
//   node scripts/world.mjs reload
//
// The world reports its state once a second, so a command lands within about
// that long. `watch` prints a line whenever something changes rather than on a
// timer, which makes cause and effect legible: run a command in one terminal
// and see the world respond in the other.

const BASE = process.env.WORLD_URL || 'http://localhost:3000';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

async function get() {
  const res = await fetch(`${BASE}/api/debug`);
  if (!res.ok) throw new Error(`GET /api/debug -> ${res.status}`);
  return res.json();
}

async function send(command, params = {}) {
  const res = await fetch(`${BASE}/api/debug`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, params }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `POST -> ${res.status}`);
  return body;
}

/** A 0..1 value as a short bar, so a column of them is scannable. */
function bar(v, width = 10, warn = Infinity) {
  const n = Math.max(0, Math.min(1, v));
  const filled = Math.round(n * width);
  const s = '█'.repeat(filled) + c.dim('·'.repeat(width - filled));
  return v > warn ? c.amber(s) : s;
}

function render(d) {
  if (!d.connected) {
    console.log(c.red('● no client connected'), c.dim(d.hint ?? `last seen ${d.ageMs}ms ago`));
    console.log(c.dim(`  open ${BASE} in a browser`));
    return;
  }

  const a = d.atmosphere;
  const t = d.time;
  const hh = String(Math.floor(t.t * 24)).padStart(2, '0');
  const mm = String(Math.floor(((t.t * 24) % 1) * 60)).padStart(2, '0');

  console.log(
    c.green('● live'),
    c.dim(`${d.ageMs}ms`),
    ' ',
    c.bold(`x ${d.self.x.toFixed(0)} z ${d.self.z.toFixed(0)}`),
    c.dim('·'),
    `${hh}:${mm}${t.pinned ? c.amber(' pinned') : ''}`,
    c.dim(`daylight ${t.daylight.toFixed(2)}`),
  );

  console.log(
    c.dim('  world  '),
    `${d.counts.patches} land · ${d.counts.creatures} creatures · ${d.counts.zones} zones · ${d.counts.travellers} live`,
  );

  const stack = d.blend.stack;
  console.log(
    c.dim('  stack  '),
    bar(stack / 4, 10, 0.4),
    stack > 1.6 ? c.amber(stack.toFixed(2) + ' CLAMPED') : stack.toFixed(2),
    c.dim(`(${d.blend.inRange} zones in range)`),
    d.blend.clearing > 0 ? c.cyan(`clearing ${d.blend.clearing.toFixed(2)}`) : '',
  );

  const rows = [
    ['fog', a.fog, 0.9],
    ['gloom', a.gloom, 0.9],
    ['rain', a.rain],
    ['snow', a.snow],
    ['glow', a.glow],
  ];
  for (const [label, v, warn] of rows) {
    if (v < 0.005 && label !== 'fog') continue; // hide what isn't happening
    console.log(c.dim(`  ${label.padEnd(7)}`), bar(v, 10, warn ?? Infinity), v.toFixed(2));
  }

  const [r, g, b] = a.tint.map((v) => Math.round(v * 255));
  const lum = (0.2126 * a.tint[0] + 0.7152 * a.tint[1] + 0.0722 * a.tint[2]).toFixed(3);
  console.log(
    c.dim('  tint   '),
    `\x1b[48;2;${r};${g};${b}m      \x1b[0m`,
    c.dim(`rgb(${r},${g},${b}) luminance ${lum}`),
  );

  for (const note of d.notes ?? []) console.log(' ', c.amber('! ' + note));
}

/** Only the fields worth reacting to — so `watch` prints on change, not on tick. */
const fingerprint = (d) =>
  !d.connected
    ? 'off'
    : JSON.stringify([
        d.self.x.toFixed(0),
        d.self.z.toFixed(0),
        d.blend,
        d.atmosphere,
        d.counts,
        d.time.pinned,
        Math.floor(d.time.t * 96),
        d.notes,
      ]);

const TIMES = { dawn: 0.25, noon: 0.5, dusk: 0.75, night: 0.95, midnight: 0 };

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  try {
    switch (cmd) {
      case undefined:
      case 'status':
        render(await get());
        break;

      case 'watch': {
        console.log(c.dim(`watching ${BASE} — Ctrl-C to stop\n`));
        let last = '';
        for (;;) {
          const d = await get().catch(() => ({ connected: false, hint: 'dev server unreachable' }));
          const fp = fingerprint(d);
          if (fp !== last) {
            last = fp;
            console.log(c.dim(new Date().toLocaleTimeString()));
            render(d);
            console.log();
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      case 'goto': {
        const x = Number(args[0]);
        const z = Number(args[1]);
        if (!Number.isFinite(x) || !Number.isFinite(z)) {
          console.error('usage: goto <x> <z>');
          process.exit(1);
        }
        await send('teleport', { x, z });
        console.log(c.green(`→ teleporting to ${x}, ${z}`));
        break;
      }

      case 'time': {
        const arg = (args[0] ?? '').toLowerCase();
        if (arg === 'live' || arg === 'unpin') {
          await send('time', { t: null });
          console.log(c.green('→ clock unpinned'));
        } else {
          const t = arg in TIMES ? TIMES[arg] : Number(arg);
          if (!Number.isFinite(t)) {
            console.error(`usage: time <${Object.keys(TIMES).join('|')}|0..1|live>`);
            process.exit(1);
          }
          await send('time', { t });
          console.log(c.green(`→ clock pinned to ${arg}`));
        }
        break;
      }

      case 'weather': {
        const condition = args[0] ?? 'rain';
        const intensity = args[1] === undefined ? 0.85 : Number(args[1]);
        const radius = args[2] === undefined ? 260 : Number(args[2]);
        await send('weather', { condition, intensity, radius });
        console.log(c.green(`→ ${condition} at the player (${intensity}, ${radius}m)`));
        break;
      }

      case 'clearview':
        await send('clearView');
        console.log(c.green('→ cleared the local view (reload restores it)'));
        break;

      case 'reload':
        await send('reload');
        console.log(c.green('→ reloading the browser'));
        break;

      case 'rows': {
        // Straight to the database, so this works even with no browser open.
        const fs = await import('node:fs');
        const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
        const pick = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
        const url = pick('NEXT_PUBLIC_SUPABASE_URL');
        const key = pick('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
        const world = process.env.NEXT_PUBLIC_WORLD || 'main';
        const res = await fetch(`${url}/rest/v1/world_assets?select=type,world,created_at`, {
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
        const rows = await res.json();
        const byWorld = {};
        for (const r of rows) {
          byWorld[r.world] ??= {};
          byWorld[r.world][r.type] = (byWorld[r.world][r.type] ?? 0) + 1;
        }
        console.log(c.bold(`${rows.length} rows`), c.dim(`(this client reads world='${world}')`));
        for (const [w, types] of Object.entries(byWorld)) {
          const mine = w === world;
          console.log(
            ' ',
            mine ? c.green(w) : c.dim(w),
            Object.entries(types)
              .map(([t, n]) => `${t} ${n}`)
              .join(' · '),
          );
        }
        // Anything a pipeline writes but this client never reads.
        const known = new Set(['terrain', 'weather', 'creature']);
        const orphans = [...new Set(rows.filter((r) => r.world === world && !known.has(r.type)).map((r) => r.type))];
        if (orphans.length) {
          console.log(c.amber(`  ! invisible to this client: ${orphans.join(', ')}`));
        }
        break;
      }

      default:
        console.log(`usage: node scripts/world.mjs <command>

  status              one snapshot (default)
  watch               live, prints on change
  goto <x> <z>        teleport the camera
  time <when>         dawn|noon|dusk|night|0..1|live
  weather <c> [i] [r] summon at the player
  clearview           hide contributions locally
  reload              reload the browser
  rows                what is in the database`);
    }
  } catch (err) {
    console.error(c.red('✗'), err.message);
    if (err.message.includes('fetch failed')) {
      console.error(c.dim(`  is the dev server running at ${BASE}?`));
    }
    process.exit(1);
  }
}

main();
