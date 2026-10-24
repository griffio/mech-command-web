// Multiple-scattering LUT (Hillaire 2020): per (sun zenith, altitude), the sky's second-and-higher-order
// scattering as an isotropic source, summed as a geometric series. One workgroup per texel, one thread per
// sample direction. Requires common.wgsl and atmo_lib.wgsl.
@group(0) @binding(0) var trans_tex: texture_2d<f32>;
@group(0) @binding(1) var lut_samp: sampler;
@group(0) @binding(2) var ms_out: texture_storage_2d<rgba16float, write>;

const ISO: f32 = 0.07957747154594767; // 1 / (4 pi)

var<workgroup> ms_shared: array<vec3<f32>, 64>;
var<workgroup> l_shared: array<vec3<f32>, 64>;

fn sample_trans(r: f32, mu: f32) -> vec3<f32> {
  return textureSampleLevel(trans_tex, lut_samp, trans_uv(r, mu), 0.0).rgb;
}

@compute @workgroup_size(1, 1, 64)
fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let uv = (vec2<f32>(id.xy) + 0.5) / 32.0;
  let mu_sun = uv.x * 2.0 - 1.0;
  let sun = vec3<f32>(sqrt(max(0.0, 1.0 - mu_sun * mu_sun)), mu_sun, 0.0);
  let r = R_BOT + uv.y * (R_TOP - R_BOT);
  let p0 = vec3<f32>(0.0, r, 0.0);

  // 8 x 8 area-uniform directions over the sphere.
  let a = (f32(li / 8u) + 0.5) / 8.0;
  let b = (f32(li % 8u) + 0.5) / 8.0;
  let theta = TAU * a;
  let cos_phi = 1.0 - 2.0 * b;
  let sin_phi = sqrt(max(0.0, 1.0 - cos_phi * cos_phi));
  let dir = vec3<f32>(sin_phi * cos(theta), cos_phi, sin_phi * sin(theta));

  let tg = ground_distance(p0, dir);
  let hit = tg > 0.0;
  let t_max = select(ray_sphere_far(p0, dir, R_TOP), tg, hit);

  var lum = vec3<f32>(0.0);
  var ms = vec3<f32>(0.0);
  var thr = vec3<f32>(1.0);
  let steps = 20;
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
    let s_l = lit * sample_trans(rr, mu_s) * med.scat * ISO;
    let ext_safe = max(med.ext, vec3<f32>(1e-9));
    lum += thr * (s_l - s_l * step_t) / ext_safe;
    ms += thr * (med.scat - med.scat * step_t) / ext_safe;
    thr *= step_t;
  }
  if (hit) {
    let pg = p0 + dir * tg;
    let mu_g = dot(normalize(pg), sun);
    lum += thr * sample_trans(R_BOT, mu_g) * saturate(mu_g) * GROUND_ALBEDO / PI;
  }

  ms_shared[li] = ms;
  l_shared[li] = lum;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s = s >> 1u) {
    if (li < s) {
      ms_shared[li] += ms_shared[li + s];
      l_shared[li] += l_shared[li + s];
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    let f_ms = ms_shared[0] / 64.0;
    let first = l_shared[0] / 64.0;
    textureStore(ms_out, id.xy, vec4<f32>(first / (vec3<f32>(1.0) - f_ms), 1.0));
  }
}
