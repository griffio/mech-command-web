# Sea experiment (WebGPU)

The MC2 map on the sea and sky of the dreadnought game ("Fall of Shot",
github.com/griffio/dreadnought-game). Served as `sea.html`; the three.js
viewer (`index.html`) is untouched. WebGPU needs a secure context, so open it
over `npm run dev:https` from another device.

## Where the code comes from

Copied from dreadnought-game at commit `5a27af7`, keeping its layout:
`math/`, `platform/`, `sim/` (rng, ocean spectrum and waves, terrain, surf, wake
geometry) and `render/` (camera, GPU timer, render scale, scene block, ocean,
sky, post, terrain, wake ribbons, shared shaders, the shadow map).

Changed here:

| File | Change |
|---|---|
| `render/sea-renderer.ts` | Ships, gunnery effects, particles and the ship shadow pass removed; `setMap()` added |
| `render/ocean/ocean-surface.ts`, `ocean_surface.wgsl` | Group 3 also carries the map's ground; the sea floor shows through shallow water |
| `render/terrain/terrain-renderer.ts`, `terrain.wgsl` | The land wears MC2's pre-lit colour map instead of procedural scrub and rock |
| `sim/terrain/surf.ts` | Surf width, strength and phase are a `SurfStyle`; MC2 uses a narrow band breaking in step along the coast |
| `app/perf-survey.ts` | Steps for the sea, land and sky only; deltas against the nearest baseline |
| `render/gpu-timer.ts` | An unused constructor field dropped (this project's lint settings) |

New: `render/map/` (the map's ground on the GPU: heights, colour map with
mipmaps, detail texture), `app/mc2-map.ts` (MC2 heights in metres, and a
bilinear upsample), `app/orbit-controls.ts` (RTS camera with touch) and
`main.ts`.

## Units

MC2 world units become metres at 5.01 units a metre, heights are relative to
the mission's water elevation, and the axes are the dreadnought game's: x east,
y up, z south. The sun comes from the mission's light direction, so the sky
agrees with the shadows baked into the colour map.
