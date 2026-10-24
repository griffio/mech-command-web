// Cloud layer baked into the sky parameterisation, used for ocean reflections and ambient light.
// Requires common, scene, sky_map, clouds.
@group(1) @binding(0) var cloud_out: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(cloud_out);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }
  let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(dims);
  textureStore(cloud_out, id.xy, cloud_sample(sky_uv_to_dir(uv), 3));
}
