// Transmittance LUT: optical-depth integral from every (radius, zenith angle) to the top of the atmosphere.
// Requires common.wgsl and atmo_lib.wgsl.
@group(0) @binding(0) var trans_out: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(trans_out);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(dims);

  let hh = sqrt(R_TOP * R_TOP - R_BOT * R_BOT);
  let rho = hh * uv.y;
  let r = sqrt(rho * rho + R_BOT * R_BOT);
  let d_min = R_TOP - r;
  let d_max = rho + hh;
  let d = d_min + uv.x * (d_max - d_min);
  var mu = 1.0;
  if (d > 0.0) {
    mu = (hh * hh - rho * rho - d * d) / (2.0 * r * d);
  }
  mu = clamp(mu, -1.0, 1.0);

  let p0 = vec3<f32>(0.0, r, 0.0);
  let dir = vec3<f32>(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  let t_max = ray_sphere_far(p0, dir, R_TOP);

  var tau = vec3<f32>(0.0);
  let steps = 48;
  let dt = t_max / f32(steps);
  for (var i = 0; i < steps; i++) {
    let p = p0 + dir * ((f32(i) + 0.5) * dt);
    tau += medium_at(length(p) - R_BOT).ext * dt;
  }
  textureStore(trans_out, id.xy, vec4<f32>(exp(-tau), 1.0));
}
