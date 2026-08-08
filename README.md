# Infinite Terra

A shared night world you walk through, built from what people draw.

## Run it

```bash
npm install
npm run dev
```

Then open one of these:

| Route | What it is |
|---|---|
| **`/terrain`** | **Sketch → walkable mountains. Start here.** |
| `/` | The shared night world (biomes, realtime, other visitors) |

### `/terrain` — the demo

Go to **http://localhost:3000/terrain**

1. **Draw a ridgeline** on the white canvas. Darker and thicker means higher ground — a squiggle across the middle works fine.
2. Hit **Bring it to life**.
3. **Click** to capture the mouse, then **WASD** to walk and **Shift** to run. **Esc** releases the mouse.

You spawn on the valley floor looking at the range. Walk toward it — the mountains are ~500m across and up to 70m tall, and you can climb them.

No API keys, no external services, nothing to rate-limit. Generation is ~36ms of local math, so it works offline and can't fail during a demo.

**How it works** ([`app/terrain.ts`](app/terrain.ts)): ink density becomes a heightmap, then three passes make it read as landscape instead of a traced line —

1. **Blur** so pen jitter becomes landform, not spiky walls
2. **Fractal detail weighted by altitude** — peaks get rugged, valleys stay walkable
3. **Hydraulic erosion** — 12,000 virtual water droplets carve branching valleys. This is the pass that makes it look real.

Tunable via `synthesize(sketch, { maxHeight, roughness, erosion, seed })`.

### `/` — the shared world

Three biomes discovered by walking: **Verdant Meadow** (spawn), **Fungal Hollow** (north), **Amethyst Reach** (east). Fog, ground colour and lighting crossfade as you cross between them.

- **WASD** walk · **Shift** run · **Space** leave a beacon · **Esc** release mouse
- Other people online show up as glowing wisps, live
- Beacons persist in Supabase and appear for everyone in realtime

Needs Supabase credentials in `.env` (see [`.env.example`](.env.example)). Without them the world still renders — you just lose the shared layer.

## Layout

```
app/
  terrain.ts        sketch → heightmap → erosion  (pure functions, no deps)
  terrain/page.tsx  the draw-and-walk demo
  biomes.ts         deterministic world generation from (x, z)
  Atmosphere.tsx    fog, night sky, biome lighting, fireflies
  Flora.tsx         instanced flora + beacons
  presence.ts       live visitors over Supabase Broadcast
  World.tsx         the shared world
```

## Notes for whoever picks this up

- `terrain.ts` has no React or Three.js imports — it's testable on its own and reusable anywhere.
- Flora and beacons are instanced (one draw call per type). Keep it that way; per-object meshes will not survive a few hundred contributions.
- Live positions go over Supabase **Broadcast**, not `postgres_changes` — position updates at 10Hz must not be database writes.
