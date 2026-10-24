// 2x2 box downsample of one mip level of a texture array into the next.
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) {
    return;
  }
  let layer = i32(gid.z);
  let s = vec2<i32>(gid.xy) * 2;
  let v = textureLoad(src, s, layer, 0)
    + textureLoad(src, s + vec2<i32>(1, 0), layer, 0)
    + textureLoad(src, s + vec2<i32>(0, 1), layer, 0)
    + textureLoad(src, s + vec2<i32>(1, 1), layer, 0);
  textureStore(dst, vec2<i32>(gid.xy), layer, v * 0.25);
}
