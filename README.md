# Infinite Terra

One shared landscape. Draw a ridgeline, and it becomes real mountains everyone can walk on.

## Run it

```bash
npm install
npm run dev
```

Open **http://localhost:3000**

- **Click** to capture the mouse, **WASD** to walk, **Shift** to run, **Esc** to release
- **E** opens the sketch panel:
  - **Terrain mode**: draw a ridgeline, hit **Raise it**
  - **Building mode**: draw a 2D building mass, hit **Build it**
- Mountains or buildings appear where you're standing, and sync to everyone in realtime
- Other people online show up as glowing wisps

Needs Supabase credentials in `.env` (see [`.env.example`](.env.example)). Without them the world still runs — you just lose the shared layer.

## How it works

**Sketch → terrain** ([`app/terrain.ts`](app/terrain.ts)). Ink density becomes a heightmap, then three passes turn a drawing into landscape instead of a traced line:

1. **Blur** so pen jitter becomes landform, not spiky walls
2. **Fractal detail weighted by altitude** — peaks get rugged, valleys stay walkable
3. **Hydraulic erosion** — 12,000 virtual water droplets carve branching valleys. This is the pass that makes it look real.

~36ms of local math. No API keys, no external services, nothing to rate-limit — it works offline and can't fail during a demo.

**What gets stored.** The 64×64 *sketch* (~2KB of base64 in `properties`), not the heightmap (~64KB). Every client re-runs `synthesize()` and lands on identical terrain because the pipeline is deterministic. Cheap to store, cheap to sync, impossible to desync.

**Live positions** go over Supabase **Broadcast**, not `postgres_changes` — 10Hz position updates must not be database writes.

```
app/
  terrain.ts    sketch → heightmap → erosion   (pure functions, no React/Three deps)
  World.tsx     the shared world, draw panel, realtime
  presence.ts   live visitors over Broadcast
  page.tsx
```

## Data

Terrain rows live in `world_assets` with `type='terrain'`:

| column | |
|---|---|
| `x`, `z` | where the massif sits |
| `properties.sketch` | base64 of the 64×64 grid |
| `properties.seed` | so erosion is reproducible |

Building rows use `type='building'`:

| column | |
|---|---|
| `x`, `z` | where the building sits |
| `properties.width` | world-space width in meters |
| `properties.depth` | world-space depth in meters |
| `properties.height` | world-space height in meters |
| `properties.coverage`, `properties.meanInk` | sketch metrics for tuning |

Vegetation rows use `type='vegetation'`:

| column | |
|---|---|
| `x`, `z` | planting center |
| `properties.selection` | plant type or biome key |
| `properties.seed` | so the forest regenerates identically |

`terrain.ts` imports nothing — it's testable on its own and reusable anywhere.
