# The WebGPU game

The MC2 map on the sea and sky of the dreadnought game ("Fall of Shot",
github.com/griffio/dreadnought-game). Served as `index.html`; browsers without
WebGPU are sent to the three.js viewer (`viewer.html`). WebGPU needs a secure
context, so open it over `npm run dev:https` from another device.

## Where the code comes from

Copied from dreadnought-game at commit `5a27af7`, keeping its layout:
`math/`, `platform/`, `sim/` (rng, ocean spectrum and waves, terrain, surf, wake
geometry) and `render/` (camera, GPU timer, render scale, scene block, ocean,
sky, post, terrain, wake ribbons, shared shaders, the shadow map).

Changed here:

| File | Change |
|---|---|
| `render/sea-renderer.ts` | Ships, gunnery effects and particles removed; `setMap()`, MC2's models and a sun shadow map framed on the camera's target added |
| `render/ocean/ocean-surface.ts`, `ocean_surface.wgsl` | Group 3 also carries the map's ground; the sea floor shows through shallow water |
| `render/terrain/terrain-renderer.ts`, `terrain.wgsl` | The land wears MC2's pre-lit colour map instead of procedural scrub and rock, and receives the models' shadows |
| `sim/terrain/surf.ts` | Surf width, strength and phase are a `SurfStyle`; MC2 uses a narrow band breaking in step along the coast |
| `app/perf-survey.ts` | Steps for the sea, land, sky, MC2's models and shadows; measured from fixed camera views; repeats stretch each interval to six refreshes, and each cost is reported as a range; deltas against the nearest baseline in the same view |
| `render/gpu-timer.ts` | An unused constructor field dropped (this project's lint settings) |

New:
- `render/map/`: the map's ground on the GPU (heights, colour map with mipmaps, detail texture).
- `render/models/`: MC2's buildings, trees, mechs and vehicles. Every model is one vertex buffer whose
  vertices name the node they move with, and each instance's node matrices sit in one storage buffer, so all
  the mechs of a type are one instanced draw per material. Cut-out materials (leaves, fences) get their own
  pipeline, because discarding pixels costs a tile-based GPU its hidden-surface removal. The converter only gives a
  face the cut-out material where its texture area actually shows see-through texels, so most of a building stays
  solid. They cast into the sun's shadow map, and the land, the sea and the models receive it. The shadows fade out
  as the camera zooms out (700 to 1000 m), and trees, fences and nets stop casting beyond 45 times their size.
- `render/fx/`: `particles.ts`/`.wgsl` copied from dreadnought (flashes, sparks, smoke, fire), `beams.ts`/`.wgsl` for
  laser and PPC fire, and `combat-effects.ts`, the MC2-scale presets built from them.
- `models/`: a reader for the converter's GLB files and an animator for their clips (no three.js on this page).
- `app/world.ts`: the mission's placements, units walking as in the three.js viewer, tap picking, the
  selection ring, move and attack orders.
- `sim/combat.ts`: MC2's combat rules; `app/battle.ts`: targets, fire, damage and wrecks on those rules (see
  Gameplay below); `app/unit-bars.ts`: health bars over the units, and a job's progress (a truck building).
- `sim/move-grid.ts`: routes over MC2's movement map, one per way of moving (mechs wade the shallows, hovercraft cross
  water, ground units keep to land and fords), with connected regions to tell what can't be reached on foot.
- `app/match.ts`: Advance and Secure on a scenario (`scenarios/*.json`): capture points, tickets, bases that
  reinforce and refit, fog of war, infantry digging in, and the AI commander. `app/squads.ts`: squads (formation
  moves, attacks, strength). `app/airlift.ts`: the Karnov flying infantry, on its own landing and take-off clips.
  `app/suppression.ts`: fire landing near units suppresses them (worse aim) and pins soldiers down; its numbers.
  `app/support.ts`: artillery and air strikes called in on a spot: readiness, the marker and ring, the fighter's
  bombing run, and the bursts (the damage is `Battle.bombard`, on MC2's rule).
  `app/logistics.ts`: supply trucks and the forward bases they build, supply, and the services bases give.
  `app/match-hud.ts`: the ticket and point bar, the squad cards, and squad letters over the field.
  `app/sound.ts`: MC2's radio, Betty and interface sounds through Web Audio, queued by MC2's radio rules.
  `app/callouts.ts`: what the squads and Betty say, and the notices, as orders are given and the match goes.
  `app/notice.ts`: the line under the top bar (refusals, alerts, what to tap next). `app/battle-sounds.ts`: weapons,
  impacts and explosions, by distance and side from the camera's view. `app/music.ts`: MC2's tunes by the state of
  the match. `app/mc2-map.ts`: MC2 heights in metres and a bilinear upsample. `app/orbit-controls.ts`:
  the RTS camera with touch. `main.ts`.
- `../paint.ts` (shared with the three.js viewer): MC2's team paint.

## Units

MC2 world units become metres at 5.01 units a metre, heights are relative to
the mission's water elevation, and the axes are the dreadnought game's: x east,
y up, z south. The sun comes from the mission's light direction, so the sky
agrees with the shadows baked into the colour map.

## Gameplay

The player's lance (the mission's Werewolf and two Bushwackers, plus an Atlas
and a Mad Cat) against the mission's vehicles and mechs. Tap the ground to move
the selection, an enemy to attack it.

Combat follows the original code, with its data exported by the converter to
`combat.json` (weapons from `compbas.csv`, each mech's armour, structure,
loadout and crit slots from its stats CSV, vehicles from their object files,
pilots' gunnery from `missions/warriors/*.fit`):

- Every quarter second each unit picks a target: the one it was ordered to
  attack, else the nearest enemy its side can see (225 m, the ground blocks the
  view) within 275 m. The player's mechs hold where they are unless ordered to
  attack.
- Attack movement, as MC2's (`MechWarrior` movement update, `Mover::calcMoveGoal`,
  `Mover::calcFireRanges`): a unit wants the range point (20, 45, 100 or 160 m,
  gamesys `OptimalRangePoints`) where its working, loaded weapons do the most
  damage a second. Once a second, more than a terrain vertex (25.6 m) off that,
  or out of sight of its target, it walks to a spot on a ring at that range
  about the target: near it, off its squadmates' spots, and (this project's
  addition) one it can see the target from. Enemy units at range step round the
  ring every few seconds (MC2's `keepMoving`, calmer; not those whose guns face
  only ahead), and stop to fight what they meet within reach on a move. A unit
  standing with a target turns to face it once it's more than 25° off its front
  (45° for infantry; gamesys `FireArc`), or with no turret or torso to turn, 10°,
  so its guns bear. A side the AI commands follows these enemy rules, so a match
  the AI plays against itself (a test) is a fair one.
  Units keep 8.5 m apart (soldiers 3 m), shuffling apart when they crowd.
- Every loaded weapon that is in its range band (short 0-60 m, medium 30-120,
  long 60-180, give or take 12 m), in sight (LRMs may use a teammate's), and
  within 12.5° of where the torso or turret points fires. A mech's torso turns
  120° either way.
- A shot hits when d100 is under the pilot's gunnery (5-95%); nothing else
  changes the odds. Missile racks roll once and do their damage once; a Streak
  that would miss doesn't launch.
- Mechs: the hit location comes from the arc the shot came from; damage goes
  through armour, then structure (with a chance of critical hits: the engine,
  the cockpit, weapons, ammunition that explodes), then on inward. The centre
  torso, the head, both legs, the engine or the cockpit gone, or six pilot
  wounds, and the mech is destroyed. Vehicles die when any side's structure
  goes. There is no heat: the original compiles it out.

An Atlas (gunnery 40) takes a median 64 s to destroy a Werewolf from 90 m, as
in a simulation of the original rules.

