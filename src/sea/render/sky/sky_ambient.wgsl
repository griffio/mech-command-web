// Cosine-weighted mean sky radiance over the upper hemisphere: what a white Lambertian surface facing up
// would reflect from the sky (times albedo). One 64-thread workgroup; the result stays on the GPU.
// Requires common, sky_map, env (group 1 bindings 0-2).
@group(1) @binding(3) var<storage, read_write> ambient_out: array<vec4<f32>>;

var<workgroup> amb_shared: array<vec3<f32>, 64>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(local_invocation_index) li: u32) {
  let u1 = (f32(li) + 0.5) / 64.0;
  let phi = f32(li) * 2.39996323;
  let rad = sqrt(u1);
  let dir = vec3<f32>(rad * cos(phi), sqrt(1.0 - u1), rad * sin(phi));
  amb_shared[li] = env_radiance(dir);
  workgroupBarrier();
  for (var s = 32u; s > 0u; s = s >> 1u) {
    if (li < s) {
      amb_shared[li] += amb_shared[li + s];
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    ambient_out[0] = vec4<f32>(amb_shared[0] / 64.0, 1.0);
  }
}
