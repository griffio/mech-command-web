// Sky look-up parameterisation: u = world azimuth, v = sqrt(elevation / 90 deg), so texel density is
// highest at the horizon where reflections and haze live. Only the upper hemisphere is stored.
fn sky_uv_to_dir(uv: vec2<f32>) -> vec3<f32> {
  let az = (uv.x - 0.5) * TAU;
  let el = uv.y * uv.y * (0.5 * PI);
  let ce = cos(el);
  return vec3<f32>(ce * cos(az), sin(el), ce * sin(az));
}

fn sky_dir_to_uv(d: vec3<f32>) -> vec2<f32> {
  let el = asin(clamp(d.y, 0.0, 1.0));
  let az = atan2(d.z, d.x);
  return vec2<f32>(az / TAU + 0.5, sqrt(el / (0.5 * PI)));
}
