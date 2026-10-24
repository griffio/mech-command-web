// The MC2 map's ground, shared by the sea and the land: its heights, its pre-lit colour map and its detail
// texture. Lives in group 3 from binding 2 (the sea's shadow map has bindings 0 and 1 of the same group).
//   Requires scene.

struct MapParams {
  origin: vec2<f32>,      // world x, z of the north-west height sample (metres)
  inv_extent: f32,        // 1 / (side * cell): the colour map spans side * cell metres
  cell: f32,              // metres between height samples
  side: f32,              // height samples per side
  detail_tiling: f32,     // detail texture repeats across the colour map
  detail_strength: f32,
  open_depth: f32,        // depth of the sea floor beyond the map (metres, positive)
  gain: f32,              // brightness the pre-lit colour map is shown at, relative to map_light()
  clarity: f32,           // metres of water that hide the sea floor to 1/e
  _pad: vec2<f32>,
};

@group(3) @binding(2) var<uniform> map_params: MapParams;
@group(3) @binding(3) var map_height: texture_2d<f32>;
@group(3) @binding(4) var map_color: texture_2d<f32>;
@group(3) @binding(5) var map_detail: texture_2d<f32>;
@group(3) @binding(6) var map_samp: sampler;

/** Ground height (metres, negative under the sea) at a world x, z: bilinear between the height samples. */
fn map_height_at(world: vec2<f32>) -> f32 {
  let f = (world - map_params.origin) / map_params.cell;
  let last = map_params.side - 1.0;
  if (f.x < 0.0 || f.y < 0.0 || f.x > last || f.y > last) {
    return -map_params.open_depth;
  }
  let i = vec2<i32>(min(floor(f), vec2<f32>(last - 1.0)));
  let t = f - vec2<f32>(i);
  let a = textureLoad(map_height, i, 0).r;
  let b = textureLoad(map_height, i + vec2<i32>(1, 0), 0).r;
  let c = textureLoad(map_height, i + vec2<i32>(0, 1), 0).r;
  let d = textureLoad(map_height, i + vec2<i32>(1, 1), 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

/**
 * The colour map at a world x, z, linear, with the detail texture laid over it. The colour map is pre-lit: MC2
 * baked the sun's shading and shadows into it, so it is used as the light leaving the ground, not as an albedo.
 * It samples with implicit derivatives: call it from uniform control flow.
 */
fn map_ground(world: vec2<f32>) -> vec3<f32> {
  let uv = (world - map_params.origin) * map_params.inv_extent;
  var col = textureSample(map_color, map_samp, uv).rgb;
  let detail = textureSample(map_detail, map_samp, uv * map_params.detail_tiling).rgb;
  col *= mix(vec3<f32>(1.0), detail * 2.0, map_params.detail_strength);
  return col;
}

/** The brightness the baked colour map is shown at: what flat ground facing the sun would receive now. */
fn map_light() -> vec3<f32> {
  return (scene.ambient.rgb * 1.15 + scene.sun_irr.rgb * (max(scene.sun_dir.y, 0.0) / PI)) * map_params.gain;
}
