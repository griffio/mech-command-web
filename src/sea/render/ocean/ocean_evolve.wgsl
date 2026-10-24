// Advance the spectrum to time t and emit the frequency-domain fields to be inverse-transformed.
//   h~(k,t) = h0 e^{-iwt} + conj(h0(-k)) e^{+iwt}        (travelling toward +k)
// Real fields are packed two per complex FFT (A + iB inverse-transforms to a + ib):
//   job 0: height + i*Dx     job 1: Dz + i*dh/dx     job 2: dh/dz + i*dDx/dx     job 3: dDz/dz + i*dDx/dz
// with D = i (k/|k|) h~ (choppy horizontal displacement), dh/dx = i kx h~, dDx/dx = -(kx^2/|k|) h~, etc.
// Requires ocean_sim.wgsl.
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> spectrum: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> fft_data: array<vec2<f32>>;

const G: f32 = 9.81;
const TAU: f32 = 6.28318530717959;

fn times_i(v: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(-v.y, v.x);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = u32(sim.b.x);
  if (gid.x >= n || gid.y >= n) {
    return;
  }
  let c = gid.z;
  let nn = n * n;
  let idx = gid.y * n + gid.x;

  let dk = TAU / sim.lengths[c];
  let kx = (f32(gid.x) - f32(n) * 0.5) * dk;
  let kz = (f32(gid.y) - f32(n) * 0.5) * dk;
  let kl = sqrt(kx * kx + kz * kz);

  let s = spectrum[c * nn + idx];
  var h = vec2<f32>(0.0);
  var dx = 0.0;
  var dz = 0.0;
  if (kl > 1e-6) {
    let w = floor(sqrt(G * kl) / sim.a.y) * sim.a.y;
    let ph = w * sim.a.x;
    let e = vec2<f32>(cos(ph), -sin(ph));
    h = cmul(s.xy, e) + cmul(s.zw, vec2<f32>(e.x, -e.y));
    dx = kx / kl;
    dz = kz / kl;
  }

  let ih = times_i(h);
  let disp_x = dx * ih;
  let disp_z = dz * ih;
  let slope_x = kx * ih;
  let slope_z = kz * ih;
  let jxx = -(kx * dx) * h;
  let jzz = -(kz * dz) * h;
  let jxz = -(kx * dz) * h;

  let base = c * 4u;
  fft_data[(base + 0u) * nn + idx] = h + times_i(disp_x);
  fft_data[(base + 1u) * nn + idx] = disp_z + times_i(slope_x);
  fft_data[(base + 2u) * nn + idx] = slope_z + times_i(jxx);
  fft_data[(base + 3u) * nn + idx] = jzz + times_i(jxz);
}
