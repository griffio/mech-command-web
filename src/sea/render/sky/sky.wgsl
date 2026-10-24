// Full-screen sky: LUT radiance, sun disc, clouds. Requires common, scene, sky_map, env, clouds.
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) ndc: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[i], 0.0, 1.0);
  o.ndc = p[i];
  return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let dir = normalize(
    scene.cam_fwd.xyz
    + in.ndc.x * scene.cam_right.w * scene.cam_right.xyz
    + in.ndc.y * scene.cam_up.w * scene.cam_up.xyz
  );
  var col = sky_radiance(dir);

  let sun = scene.sun_dir.xyz;
  let sun_r = scene.sun_dir.w;
  var disc = vec3<f32>(0.0);
  if (dot(dir, sun) > 0.0) {
    let ang = length(cross(dir, sun));
    let edge = 1.0 - smoothstep(sun_r * 0.85, sun_r, ang);
    let x = ang / sun_r;
    let limb = 0.55 + 0.45 * sqrt(max(0.0, 1.0 - x * x));
    let omega = PI * sun_r * sun_r;
    disc = min(scene.sun_irr.rgb / omega * limb * edge, vec3<f32>(6000.0));
  }

  let cl = cloud_sample(dir, 5);
  col = (col + disc) * (1.0 - cl.a) + cl.rgb;
  return vec4<f32>(col, 1.0);
}
