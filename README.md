# Mech Command Web

A browser (desktop and iPad) viewer for MechCommander 2 maps and mechs, built on
three.js and WebGL2. It is the first step towards a small web skirmish game that
reuses the original assets. No native code: the original data is converted
offline into glTF, WebP, PNG and JSON.

## Quick start

```bash
npm install
npm run fetch-data       # sparse-clones only what mission mc2_01 needs (~46 MB) into vendor/
npm run convert          # writes public/assets/ (~6 MB)
npm run dev              # http://localhost:5173 (also served on your LAN for an iPad)
```

Options (both scripts): `--mission mc2_05` picks another mission, and
`--extra-mechs atlas,madcat` adds mechs the mission doesn't use (the defaults
are shown in the viewer's showcase).

### Upscaled textures

The remaster's author published 4× AI upscales of the terrain colour maps and
model textures as zips on the
[v0.3 release](https://github.com/ThranduilsRing/mc2-opengl-remastered/releases/tag/v0.3-release)
(2.7 GB in total). `--upscaled` downloads only the entries a mission needs, using
HTTP range requests (mc2_01: 39 files, 109 MB, into `vendor/upscaled/`):

```bash
npm run fetch-data -- --upscaled
npm run convert -- --upscaled    # assets grow from ~6 MB to ~8 MB
```

The 5120² colour map is shipped at `--colormap-size 2560` (about 35 MB of GPU
memory with mipmaps, against about 140 MB at full size). Model textures are capped at
`--texture-size 512` and stored as WebP inside the GLBs (`EXT_texture_webp`).

Viewer controls: drag to pan, right-drag or two fingers to rotate, scroll or
pinch to zoom, tap a unit to select it, and tap the ground to walk the selected
mech there. The panel switches animations, toggles run/patrol, spawns mechs,
hides layers and toggles shadows. Add `?map=<mission>` to the URL to choose a
converted map.

Shadows come from a 2048² sun shadow map that follows the view centre and grows
as you zoom out. Buildings, trees and units cast them. The ground stays unlit, and
a transparent shadow-only copy of it shows them. The terrain doesn't cast, because
its own shadows are already baked into the colour map.

## Perf test on a device

1. On the Mac, run `npm run dev` (HTTP) or `npm run dev:https` (HTTPS with a
   self-signed certificate).
2. On the iPad, open the **Network** URL Vite prints (same Wi-Fi). Over HTTPS,
   accept the certificate warning: Show Details → visit this website.
3. Enter a device name, tap **Run perf test**, and leave the iPad alone for about a minute.

The test measures the display refresh rate, then seven scenes for 5 seconds each:

| Scene | Description |
|---|---|
| `start` | opening view |
| `start-no-shadows` | opening view without shadows |
| `start-pixel-ratio-1` | opening view at one render pixel per screen point (the fill-rate check) |
| `airfield` | close over the airfield buildings |
| `overview` | zoomed out over the whole map |
| `mech-close` | following a walking Atlas |
| `crowd-24` | opening view plus 24 extra walking mechs |

The results appear on screen, are POSTed as JSON to `/api/perf`, and are saved in
`perf-reports/` on the Mac. Each scene records fps, median/p95/p99/max frame time,
JavaScript time per frame, draw calls and triangles. The report also includes load
milestones, WebGL limits and compressed-texture formats, and the WebGPU adapter's
features and limits. WebGPU needs a secure context, so that part is only filled in
over HTTPS.

How to read it:
- Low fps with low JS time means the GPU is the limit.
- If `start-pixel-ratio-1` is much faster than `start`, the limit is screen resolution (fill rate).

## Sea experiment (branch `ocean-experiment`)

`sea.html` draws the same map with the WebGPU sea and sky from the dreadnought
game: three FFT wave cascades, foam and glitter, surf along the coast, the sea
floor showing through shallow water, and an atmosphere with clouds. Buildings
and mechs aren't on it yet. See `src/sea/README.md` for where the code comes from.

```bash
npm run dev:https    # then open https://<Mac address>:5173/sea.html (WebGPU needs HTTPS)
```

Its **Run sea survey** button measures what the sea, land, sky, bloom and
resolution each cost per frame. It renders several frames per display refresh
until the GPU saturates, so the 60 fps cap can't hide the cost. The report is
POSTed to the same `/api/perf` endpoint. URL options: `q=B` for 128² waves
instead of 256², `msaa=1`, and `scale=` for a fixed render scale.

## Layout

| Path | What |
|---|---|
| `tools/fetch-srcdata.ts` | Sparse, blobless checkout of [alariq/mc2srcdata](https://github.com/alariq/mc2srcdata), resolving the files a mission needs |
| `tools/convert.ts` | Mission → `public/assets/maps/<mission>/` and `public/assets/models/` |
| `tools/lib/` | Readers for `.pak`, `.fit`, `.tga`, `.ase` and remote zips, plus the glTF builder |
| `src/` | The three.js viewer |
| `vendor/`, `public/assets/` | Downloaded and generated data; git-ignored |

Converted output per mission: `map.json` (terrain size, water, light, camera
start), `elevation.bin` (Float32 heights), `colormap.webp`, `objects.json`
(about 1,000 placed buildings and trees), `units.json` (mission units plus
gesture speeds), and `move.bin` (the 300×300 movement grid, kept for later
pathfinding).

## How the conversion follows the engine

The rules are taken from the C++ in
[mc2-opengl-remastered](https://github.com/ThranduilsRing/mc2-opengl-remastered):

- **Axes.** ASE files and the MC2 world share axes (x east, y north, z up). three.js
  uses `(x, z, -y)`. Model forward is world −y, which becomes +Z in three.js.
  Facing = `(sin r, −cos r)`, so `rotation.y = r`.
- **Terrain** (`mclib/terrain.cpp`, `mapdata.cpp`). 128 world units per vertex,
  centred on the origin, row 0 at the north edge. Quads split their diagonal in a
  checkerboard pattern. The colour map spans `side × 128` units and is pre-lit.
- **Models** (`mclib/tgl.cpp`, `msl.cpp`). Node rest rotations are ignored. Each node sits at
  its `TM_POS` relative to its parent. Face textures are the first N `*BITMAP` entries
  in file order, indexed by `MESH_MTLID`. `SpotLight_*` meshes (night lights) are dropped.
- **Animation.** Each gesture is its own ASE file (`<appearance><Gesture>.ase`).
  Rotation keys are axis/angle deltas, which the engine converts with its own signs and
  accumulates as `q[j] = key[j] · q[j−1]`. Clips are baked to one key per frame at 30 fps.
- **Speed.** Gesture velocities in the mech INI are metres per second, at 5.01 world
  units per metre.
- **Paint** (`mclib/mech3d.cpp`). Texels dominated by red, green or blue are recoloured
  with highlight 1, highlight 2 and the base colour. Player units use the default orange.
- **Water** (`mclib/quad.cpp`). Per-vertex opacity by depth (shallow, middle, deep). In
  mc2_01 deep water is opaque, which hides the seabed in the colour map.

Checks done against mc2_01:
- Every placed object's stored height matches the terrain sampler to within 0.01
  (a mirrored grid misses by 66–91 units at the median).
- Mechs face the way they walk.
- The walk cycle steps forward at the gesture speed.
- It renders in Chrome and in WebKit with iPad emulation, including tap to walk.

## Known gaps

- `alariq/mc2srcdata` has no models for some objects (a few rocks, mech wreck pieces,
  nav markers, infantry, the outhouse). The converter skips them and lists them.
- Vehicles are static, and prop animations (flags, radar) are not converted.
- The original 1280² colour map is blurry close up; use `--upscaled`.
- Not yet measured on a real iPad. Headless WebKit on an Intel Mac renders even a
  near-empty scene at ~15 fps, so it can't stand in for one.

## Licence

The engine code these rules come from is GPL v3 (alariq's port) on top of
Microsoft's Shared Source release. The MechCommander 2 art may be used and
redistributed **for non-commercial purposes only**, and the licence grants no rights
to Microsoft's trademarks (see `EULA.txt` in the engine repository). That's why
`vendor/` and `public/assets/` are git-ignored: anyone building this fetches and
converts the data themselves. The `--upscaled` textures are the remaster author's AI
upscales of the same art, so the same non-commercial terms apply.
