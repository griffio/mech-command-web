// Turn the inverse-FFT output into the textures the surface samples:
//   disp  (rgba16f): x = choppy dx, y = height, z = choppy dz, w = persistent foam
//   deriv (rgba16f): x = dh/dx, y = dh/dz, z = |slope|^2 (kept so mips can recover slope variance), w = foam
//   (foam is duplicated here so the surface shader needs one texture fetch per cascade instead of two)
// Requires ocean_sim.wgsl.
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> fft_data: array<vec2<f32>>;
@group(0) @binding(2) var prev_disp: texture_2d_array<f32>;
@group(0) @binding(3) var disp_out: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var deriv_out: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = u32(sim.b.x);
  if (gid.x >= n || gid.y >= n) {
    return;
  }
  let c = gid.z;
  let nn = n * n;
  let idx = gid.y * n + gid.x;

  // The spectrum is centred (k = 0 at index n/2), which after an unnormalised inverse DFT leaves a
  // checkerboard sign of (-1)^(x+z) to undo.
  let sgn = select(1.0, -1.0, ((gid.x + gid.y) & 1u) == 1u);
  let base = c * 4u;
  let f0 = fft_data[(base + 0u) * nn + idx] * sgn;
  let f1 = fft_data[(base + 1u) * nn + idx] * sgn;
  let f2 = fft_data[(base + 2u) * nn + idx] * sgn;
  let f3 = fft_data[(base + 3u) * nn + idx] * sgn;

  let chop = sim.a.z;
  let height = f0.x;
  let dx = f0.y * chop;
  let dz = f1.x * chop;
  let sx = f1.y;
  let sz = f2.x;
  let jxx = f2.y;
  let jzz = f3.x;
  let jxz = f3.y;

  // Jacobian of the horizontal displacement map; it drops below ~1 where the surface folds (whitecaps).
  let jac = (1.0 + chop * jxx) * (1.0 + chop * jzz) - chop * chop * jxz * jxz;
  let foam_now = saturate((sim.b.z - jac) * sim.foam[c]);
  let prev = textureLoad(prev_disp, vec2<i32>(gid.xy), i32(c), 0).w;
  let foam = max(prev * sim.a.w, foam_now);

  let p = vec2<i32>(gid.xy);
  textureStore(disp_out, p, i32(c), vec4<f32>(dx, height, dz, foam));
  textureStore(deriv_out, p, i32(c), vec4<f32>(sx, sz, sx * sx + sz * sz, foam));
}
