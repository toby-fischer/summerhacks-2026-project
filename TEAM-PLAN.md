INFINITE TERRA — Team Plan


WHAT WE'RE BUILDING

One shared 3D world, in the browser, that anyone can walk into. It starts empty. People add to it — draw a mountain range, sketch a creature, describe a building — and what they make becomes part of the world permanently, for everyone.

Think promptable Minecraft. You don't get your own copy; you're adding to the same place everyone else is standing in.


WHY THIS WINS THE TRACK

The hackathon asks for four things. Here's how we hit each:

1. One moment of input — draw or type for 30 seconds. No signup, no explanation.

2. A non-trivial transformation — a scribble becomes eroded 500m terrain; a text prompt becomes a rigged animated creature. This is our technical core.

3. A stranger sees it — deployed and live, with realtime sync. New contributions appear for people already walking around, without a refresh.

4. Better with more people — an empty plain is boring. 200 contributions is a landscape with buildings, animals, weather, and sound. It literally cannot be good alone.


HOW IT WORKS (the whole architecture in one page)

The world is a database table. Every contribution is one row: what kind it is, where it sits, and a small blob of data describing it.

We store recipes, not results. The terrain pipeline stores a 64x64 sketch (~2KB), not the finished heightmap (~64KB). Every browser regenerates identical terrain from that sketch because the math is deterministic. Do this in your pipeline wherever you can — it keeps the database small, sync fast, and makes desync impossible.

Contributions are additive. Nothing ever overwrites anything. Overlapping terrain takes the max height, so two people drawing near each other make a bigger ridge instead of one erasing the other. Objects sit on top of terrain. Sound layers. Nobody's work can ever disappear — that's a deliberate design decision, not a limitation.

Realtime. Supabase pushes new rows to everyone connected. You also see other people walking around as glowing wisps (this already works).

Text prompts go through one shared agent. A single endpoint takes "icy peaks" or "a lonely tower", figures out which pipeline it belongs to, and returns named parameters that pipeline understands. It returns numbers and preset names, never geometry — models are reliable at "icy peaks -> {snowline: 0.6, palette: [...]}" and unreliable at generating meshes.

Fallbacks are mandatory. If the agent is slow or down, your pipeline still works with a random seed. A judge pressing the button must always get something.


THE SHARED CONTRACT — read this before you write anything

There's one file, app/world/contract.ts, that defines the shape of a contribution. Everyone imports it. Nobody forks it.

Key points:

- Your pipeline owns a "payload" field. It's JSON — put whatever you want in it. Nobody else reads inside it, so you can change it freely without breaking anyone.

- If you need a change to the shared part, change it there and tell the team. Don't invent a private shape in your folder.

- It ships helpers you should use: hash() and rng() for deterministic randomness (never Math.random() for anything a second person must see identically), and lodCount() for scaling instance counts by distance.

Each pipeline lives in its own folder. Keep your work self-contained so we can merge without conflicts.


TWO HARD TECHNICAL CONSTRAINTS

1. Vercel free tier kills functions at 5–10 seconds. Anything slower cannot be a normal request. Either raise maxDuration in the route file, or — better — make it async: kick off the work, write to the database when it's done, and let realtime deliver it. Design for this from the start; don't discover it at 3am.

2. Everything must be instanced and LOD'd. One draw call per object type, not per object. Reduce detail with distance. Cap what's visible. A pipeline that looks great with 5 objects and dies at 200 is a pipeline that fails the demo — because the demo is supposed to have 200.


=========================================
THE CHECKLIST
=========================================

Every item is doable by one person alone. Grab what you want. Each says what it's for, what "done" means, and where to look for reference.


FOUNDATION (do these first — everything else depends on them)

[ ] Lock the shared contract
Get app/world/contract.ts and the database table agreed and merged before anyone builds on it. Fifteen minutes now saves a painful merge later.
Done when: everyone has pulled it and nobody's blocked.

[ ] Shared text-prompt agent
One endpoint. Takes free text, decides which pipeline it's for, returns that pipeline's parameters. Use forced JSON-schema tool-use so the output is always valid — no parsing, no repair loops. Model: claude-opus-5. Must include a safety check and must fall back gracefully.
Done when: "icy peaks" and "a small mossy hut" both return sensible, valid params for the right pipeline, and it fails safe when the API is down.
Reference: Anthropic docs on structured outputs / tool use.

[ ] World shell
Loads all contributions on join, subscribes to realtime, renders each kind by handing it to the right pipeline, handles walking and collision with terrain. Mostly exists — needs to become the thing all eight pipelines plug into.
Done when: a new pipeline can be added by registering one renderer, without touching anything else.


THE PIPELINES

[ ] Terrain  (mostly built)
Draw a ridgeline, walk it at 500m scale. Sketch -> heightmap -> blur -> altitude-weighted fractal detail -> hydraulic erosion. The erosion pass is what makes it read as landscape instead of a traced line.
Left to do: text-agent styles (icy / lush / volcanic), better materials, blending where two contributions overlap.
Done when: a stranger's scribble becomes a mountain range they'd screenshot.
Reference: github.com/IceCreamYou/THREE.Terrain for the general approach; ours is already further along on erosion.

[ ] Structures
Buildings people can see from far away and walk up to. Do not generate meshes — build a kit of parts (walls, roofs, windows, doors, trim) and assemble them procedurally. Every result looks intentional because a human designed the pieces.
Done when: 50 buildings render at 60fps, they sit correctly on sloped terrain, and no two look identical.
Reference: github.com/achrefelouafi/BuildingGeneratorThreeJS — ~190 modular parts as one instanced kit. This is the pattern to copy.

[ ] Interiors
Walk inside a structure and there's a real inside. Floorplan generation -> rooms -> furniture placement.
Done when: you can enter a building, walk between rooms, and leave. It doesn't need to be beautiful; it needs to not break the illusion.
Reference: github.com/furnishup/blueprint3d and github.com/amitukind/architect3d — both Three.js interior tools.

[ ] Creatures
Living things that wander, not statues. Rigged, animated, procedurally varied. Traits from a sketch or a prompt drive body proportions.
Done when: creatures visibly move and breathe, 30 on screen holds framerate, and two prompts give recognizably different animals.
Reference: github.com/bunnybones1/threejs-procedural-animal generates a rigged animal mesh ready for procedural animation — the hard part, solved. Also github.com/svartmc/seagull for procedural animation feel.

[ ] Flora
Vegetation that makes terrain feel alive. Scatter driven by terrain slope and altitude plus a text prompt ("cherry blossom", "dead forest").
Done when: hundreds of plants render in one or two draw calls, they follow the terrain surface, and they don't grow on cliffs.
Reference: our terrain pipeline already has slope data; instanced rendering is the whole game here.

[ ] Weather & sky
Global, cheap, and the single biggest atmosphere-per-line-of-code win. Day/night, rain, snow, fog, clouds. Blends between contributions rather than snapping.
Done when: the world visibly changes mood, and it costs nothing at distance.
Reference: github.com/xiaxiangfeng/sky-cloud-3d (physically-based sky + volumetric clouds, one-line integration), github.com/rauschermate/react-weather-effects (rain/snow/fog), github.com/leoawen/volumetric-clouds.

[ ] Paths & rivers
The most collaborative pipeline: paths connect what other people built. Draw or auto-route between contributions; water flows downhill using terrain data.
Done when: a path visibly links two strangers' buildings and follows the terrain surface.

[ ] Sound
Ambient audio zones you hear as you approach. Generative, not sample-based. Zones must stay musically consonant when they overlap — pick a shared key.
Done when: walking across the world changes what you hear, and two overlapping zones don't sound like noise.
Reference: Tone.js as the layer over Web Audio. There's prior art mapping natural language -> DSP parameters, which is exactly our text-prompt pattern applied to sound.


TRACK BONUSES

[ ] Live data dashboard  (TECHNATION track — nearly free for us)
We already generate the data. Show contributions over time, which pipelines are popular, active visitors, a map of the world. Must be real and live — judges will watch it update.
Done when: it updates while someone else contributes, with nothing hardcoded.

[ ] Visual identity with Reve  (Reve track)
Logo, landing page, textures, UI. Judges explicitly mark down generic AI visuals, so this is defensive as well as offensive.
Done when: the project doesn't look like a default template.


SHIP-BLOCKERS — someone must own these

[ ] Performance pass — instancing everywhere, LOD, caps on visible objects. Test with 200+ contributions, not 5.

[ ] Mobile / low-end fallback — judges may open it on a phone.

[ ] Onboarding — a stranger figures out what to do in under 60 seconds with zero explanation. This is 30% of the score.

[ ] Demo backup — a recorded video. If wifi dies during judging, we still have something.


=========================================
WORKING AGREEMENTS
=========================================

- Your folder is yours. Build it how you want. The contract is the only shared surface.

- Deterministic, always. Use hash() / rng() from the contract. If two people see different worlds standing in the same spot, that's the bug that ruins the demo.

- Store recipes, not results. Small payloads, regenerated client-side.

- Instance everything, LOD everything. Assume 200+ contributions.

- Always have a fallback. Agent down, API slow, database unreachable — the world still renders and the button still does something.

- Push early and often. Integration is the risk, not the features.


TWO NOTES ON PRIORITY

The shared contract and the world shell are blockers. Until they're locked, everyone else is building against a moving target — do those first even if they're less fun.

The checklist is deliberately larger than what we'll finish. Pick by what makes the demo land, not by ticking boxes. Weather and flora are the best effort-to-impact ratio if someone wants a quick win.
