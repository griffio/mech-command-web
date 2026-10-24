# Mech Command Web

A small MechCommander 2-style skirmish for iPad and desktop browsers, reusing
the original game's maps, buildings and mechs. No native code: the original
data is converted offline into glTF, WebP, PNG and JSON.

- **The game** (`index.html`) draws with WebGPU: the FFT sea and physically based
  sky from the dreadnought game, MC2's terrain, buildings, trees and mechs, and
  sun shadows. It needs Safari 26 (iPadOS 26 / macOS 26), or a recent Chrome or Edge.
- **The viewer** (`viewer.html`) is the earlier three.js/WebGL2 version. The game
  sends any browser without WebGPU there automatically.

## Quick start

```bash
npm install
npm run fetch-data       # sparse-clones only what mission mc2_01 needs (~46 MB) into vendor/
npm run convert          # writes public/assets/ (~6 MB)
npm run dev:https        # https://localhost:5173, also on your LAN for an iPad
```

WebGPU only exists in secure contexts, so open the HTTPS address on an iPad and
accept the self-signed certificate once (Show Details → visit this website).
Plain `npm run dev` works on the Mac itself (localhost counts as secure); from
another device over HTTP the game falls back to the viewer.

Options (both scripts): `--mission mc2_05` picks another mission, and
`--extra-mechs atlas,madcat` adds mechs the mission doesn't use (the defaults
are the showcase mechs that patrol near the start).

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

## The game (WebGPU)

Controls: drag to pan, right-drag or two fingers to turn and tilt, scroll or
pinch to zoom, tap a unit to select it, and tap the ground to walk the selected
mech there.

The sea, sky, surf and post-processing come from the dreadnought game; see
`src/sea/README.md` for what was taken and what changed. MC2's land wears its
pre-lit colour map, and the sea shows the sea floor through shallow water. Every
model is one vertex buffer whose vertices name the node they move with, so all
the mechs of one type are a single instanced draw. The sun's shadows fade out as
the camera zooms out (700–1000 m).

**Run sea survey** (top left) measures what the sea, land, buildings, units,
shadows, sky, bloom and resolution each cost per frame. It uses two fixed views:
the opening view, and the whole map zoomed out (mostly sea). It renders several
frames per display refresh, until one interval spans at least six refreshes, so
the 60 fps cap can't hide the cost; each row is a range accurate to about a
sixth. The report is POSTed to `/api/perf` and saved in `perf-reports/`. URL
options: `q=B` for 128² waves instead of 256², `msaa=1`, and `scale=` for a
fixed render scale.

On an iPad Air M2 the opening view costs 3.0–3.5 ms per frame and the whole map
zoomed out 10.0–10.6 ms, against 16.7 ms at 60 fps.

## The viewer (WebGL)

Controls as above. Its panel switches animations, toggles run/patrol, spawns
mechs, hides layers and toggles shadows. Add `?map=<mission>` to the URL of either
page to choose a converted map.

Its **Run perf test** button measures seven scenes (opening view with and without
shadows and at half resolution, the airfield, the whole map, a walking Atlas up
close, 24 extra walking mechs), plus load milestones, WebGL limits and the WebGPU
adapter's features. The report goes to the same `/api/perf` endpoint.

## Layout

| Path | What |
|---|---|
| `tools/fetch-srcdata.ts` | Sparse, blobless checkout of [alariq/mc2srcdata](https://github.com/alariq/mc2srcdata), resolving the files a mission needs |
| `tools/convert.ts` | Mission → `public/assets/maps/<mission>/` and `public/assets/models/` |
| `tools/lib/` | Readers for `.pak`, `.fit`, `.tga`, `.ase` and remote zips, plus the glTF builder |
| `src/sea/` | The WebGPU game (`main.ts`, `app/`, `models/`, `render/`, `sim/`) |
| `src/*.ts` | The three.js viewer; `src/paint.ts` and `src/assets.ts` are shared |
| `vendor/`, `public/assets/` | Downloaded and generated data; git-ignored |

Converted output per mission: `map.json` (terrain size, water, light, camera
start), `elevation.bin` (Float32 heights), `colormap.webp`, `objects.json`
(about 1,000 placed buildings and trees), `units.json` (mission units plus
gesture speeds), and `move.bin` (the 300×300 movement grid).

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
- Headless browsers on an Intel Mac can't stand in for an iPad when timing (they
  render even a near-empty scene at ~15 fps); measure on the device.

## Licence

The engine code these rules come from is GPL v3 (alariq's port) on top of
Microsoft's Shared Source release. The MechCommander 2 art may be used and
redistributed **for non-commercial purposes only**, and the licence grants no rights
to Microsoft's trademarks (see `EULA.txt` in the engine repository). That's why
`vendor/` and `public/assets/` are git-ignored: anyone building this fetches and
converts the data themselves. The `--upscaled` textures are the remaster author's AI
upscales of the same art, so the same non-commercial terms apply.
