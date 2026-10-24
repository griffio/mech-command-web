// The land: tiled heightfield meshes, one draw per visible tile. Positions are tile-local; the tile's camera-relative origin
// comes from a storage buffer indexed by the instance, so a whole island is a handful of draws and a float32 position never
// has to hold a coordinate in kilometres.
//   Requires common, scene, sky_map, env, noise, haze, shadow, map. Group 2 = tile origins, group 3 = shadow + the map's ground.
const EARTH_R: f32 = 6371000.0;

@group(2) @binding(0) var<storage, read> tiles: array<vec4<f32>>;

struct VIn {
  @location(0) pos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @builtin(instance_index) inst: u32,
};

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) rel: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) world: vec3<f32>,
};

@vertex
fn vs(in: VIn) -> VOut {
  let t = tiles[in.inst * 2u];
  let w = tiles[in.inst * 2u + 1u];
  var rel = vec3<f32>(t.x + in.pos.x, in.pos.y - scene.cam_pos.y, t.z + in.pos.z);
  rel.y -= dot(rel.xz, rel.xz) / (2.0 * EARTH_R);
  var out: VOut;
  out.clip = scene.view_proj * vec4<f32>(rel, 1.0);
  out.rel = rel;
  out.nrm = in.nrm;
  out.world = vec3<f32>(w.x + in.pos.x, in.pos.y, w.y + in.pos.z);
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  // MC2's colour map already holds the sun's shading and the hills' shadows, so the ground shows it as it is, at the
  // brightness flat ground in the sun has now. A fine grain from the baked noise keeps it from going soft up close.
  let p = in.world.xz;
  var col = map_ground(p) * map_light();
  col *= 0.94 + 0.12 * noise_lookup(p * 0.35);
  // Wet sand at the waterline.
  col *= mix(0.72, 1.0, smoothstep(0.0, 1.2, in.world.y));
  // The shadows of buildings, trees and units: the colour map was lit by the sun, so take away the share of the light the
  // sun gave this slope where something stands in its way.
  let n = normalize(in.nrm);
  let sun_light = scene.sun_irr.rgb * (saturate(dot(n, scene.sun_dir.xyz)) / PI);
  let amb_light = scene.ambient.rgb * 1.15;
  let lit = shadow_factor_fast(in.rel, n);
  col *= (amb_light + sun_light * lit) / max(amb_light + sun_light, vec3<f32>(1e-4));
  col = apply_haze(col, in.rel);
  return vec4<f32>(col, 1.0);
}
