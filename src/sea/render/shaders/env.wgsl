// Environment look-ups for render passes (group 1). Requires common.wgsl and sky_map.wgsl.
@group(1) @binding(0) var sky_view: texture_2d<f32>;
@group(1) @binding(1) var cloud_lut: texture_2d<f32>;
@group(1) @binding(2) var env_samp: sampler;

fn sky_radiance(d: vec3<f32>) -> vec3<f32> {
  return textureSampleLevel(sky_view, env_samp, sky_dir_to_uv(d), 0.0).rgb;
}

// Sky plus clouds (clouds are premultiplied: rgb already includes alpha).
fn env_radiance(d: vec3<f32>) -> vec3<f32> {
  let uv = sky_dir_to_uv(d);
  let sky = textureSampleLevel(sky_view, env_samp, uv, 0.0).rgb;
  let cl = textureSampleLevel(cloud_lut, env_samp, uv, 0.0);
  return sky * (1.0 - cl.a) + cl.rgb;
}
