// Sky-view LUT: in-scattered radiance for a viewer at sea level, per world direction (azimuth, elevation).
// Recomputed whenever the sun moves. Requires common, scene, sky_map, atmo_lib.
@group(1) @binding(0) var trans_tex: texture_2d<f32>;
@group(1) @binding(1) var ms_tex: texture_2d<f32>;
@group(1) @binding(2) var lut_samp: sampler;
@group(1) @binding(3) var sky_out: texture_storage_2d<rgba16float, write>;

fn sample_trans(r: f32, mu: f32) -> vec3<f32> {
  return textureSampleLevel(trans_tex, lut_samp, trans_uv(r, mu), 0.0).rgb;
}

fn sample_ms(r: f32, mu_s: f32) -> vec3<f32> {
  let uv = vec2<f32>(clamp(mu_s * 0.5 + 0.5, 0.0, 1.0), clamp((r - R_BOT) / (R_TOP - R_BOT), 0.0, 1.0));
  return textureSampleLevel(ms_tex, lut_samp, uv, 0.0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(sky_out);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(dims);
  let dir = sky_uv_to_dir(uv);
  let sun = scene.sun_dir.xyz;

  let p0 = vec3<f32>(0.0, R_BOT + 0.001, 0.0);
  let t_max = ray_sphere_far(p0, dir, R_TOP);
  let c = dot(dir, sun);
  let ph_r = rayleigh_phase(c);
  let ph_m = mie_phase(c);

  var lum = vec3<f32>(0.0);
  var thr = vec3<f32>(1.0);
  let steps = 40;
  for (var i = 0; i < steps; i++) {
    let f0 = f32(i) / f32(steps);
    let f1 = f32(i + 1) / f32(steps);
    let t0 = t_max * f0 * f0;
    let t1 = t_max * f1 * f1;
    let dt = t1 - t0;
    let p = p0 + dir * (0.5 * (t0 + t1));
    let rr = length(p);
    let up = p / rr;
    let med = medium_at(rr - R_BOT);
    let step_t = exp(-med.ext * dt);

    let mu_s = dot(up, sun);
    let lit = select(1.0, 0.0, ground_distance(p, sun) > 0.0);
    let sun_light = lit * sample_trans(rr, mu_s);
    let src = sun_light * (med.ray * ph_r + vec3<f32>(med.mie * ph_m)) + sample_ms(rr, mu_s) * med.scat;

    let ext_safe = max(med.ext, vec3<f32>(1e-9));
    lum += thr * (src - src * step_t) / ext_safe;
    thr *= step_t;
  }
  textureStore(sky_out, id.xy, vec4<f32>(lum, 1.0));
}
