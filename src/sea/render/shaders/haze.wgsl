// Aerial perspective shared by every lit surface: exponential extinction toward the sky colour near the
// horizon in the direction of view. `rel` is the camera-relative position (curvature drop included).
// Requires common, scene, sky_map, env.
fn apply_haze(col: vec3<f32>, rel: vec3<f32>) -> vec3<f32> {
  let dist = length(rel);
  let vis_m = scene.ocean.w * 1000.0;
  let beta = (3.912 / vis_m) * vec3<f32>(0.85, 1.0, 1.18) * scene.atmo.y;
  let tr = exp(-beta * dist);
  let fog = sky_radiance(normalize(vec3<f32>(rel.x, 0.012 * length(rel.xz), rel.z)));
  return col * tr + fog * (1.0 - tr);
}
