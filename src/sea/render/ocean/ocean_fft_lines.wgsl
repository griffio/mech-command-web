// Shared-memory FFT: one workgroup transforms one whole line (row or column) of one job, all log2(n) Stockham
// radix-2 stages inside workgroup memory, so global memory is read once and written once per axis. Two
// dispatches (rows, then columns) replace 2*log2(n) separate passes.
//
// Dispatch (n, jobs). Supports n = 64, 128 or 256 (workgroup memory holds 256 complex values twice).
// `inverse` flips the twiddle sign; no scaling is applied.
struct Params {
  n: u32,
  vertical: u32,
  inverse: u32,
  pad: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2<f32>>;

var<workgroup> buf_a: array<vec2<f32>, 256>;
var<workgroup> buf_b: array<vec2<f32>, 256>;

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn addr(job: u32, line: u32, i: u32) -> u32 {
  let base = job * p.n * p.n;
  if (p.vertical == 1u) {
    return base + i * p.n + line;
  }
  return base + line * p.n + i;
}

@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let n = p.n;
  let hn = n / 2u;
  let line = wid.x;
  let job = wid.y;
  let active_thread = li < hn;
  let dir = select(-1.0, 1.0, p.inverse == 1u);

  if (active_thread) {
    buf_a[li] = src[addr(job, line, li)];
    buf_a[li + hn] = src[addr(job, line, li + hn)];
  }
  workgroupBarrier();

  var in_a = true;
  for (var ns = 1u; ns < n; ns = ns << 1u) {
    if (active_thread) {
      let k = li % ns;
      let angle = dir * 3.14159265358979 * f32(k) / f32(ns);
      let w = vec2<f32>(cos(angle), sin(angle));
      let d = (li / ns) * ns * 2u + k;
      if (in_a) {
        let v0 = buf_a[li];
        let v1 = cmul(buf_a[li + hn], w);
        buf_b[d] = v0 + v1;
        buf_b[d + ns] = v0 - v1;
      } else {
        let v0 = buf_b[li];
        let v1 = cmul(buf_b[li + hn], w);
        buf_a[d] = v0 + v1;
        buf_a[d + ns] = v0 - v1;
      }
    }
    workgroupBarrier();
    in_a = !in_a;
  }

  if (active_thread) {
    if (in_a) {
      dst[addr(job, line, li)] = buf_a[li];
      dst[addr(job, line, li + hn)] = buf_a[li + hn];
    } else {
      dst[addr(job, line, li)] = buf_b[li];
      dst[addr(job, line, li + hn)] = buf_b[li + hn];
    }
  }
}
