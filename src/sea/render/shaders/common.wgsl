const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;

// PCG2D integer hash (Jarzynski & Olano). The usual fract-and-dot float hash is nearly linear across
// neighbouring lattice points, which turns value noise into large flat triangular facets.
fn pcg2d(v_in: vec2<u32>) -> vec2<u32> {
  var v = v_in * 1664525u + vec2<u32>(1013904223u);
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> vec2<u32>(16u));
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> vec2<u32>(16u));
  return v;
}

// Uniform [0, 1) from an integer lattice point (p is floored).
fn hash21(p: vec2<f32>) -> f32 {
  let h = pcg2d(bitcast<vec2<u32>>(vec2<i32>(floor(p))));
  return f32(h.x) * (1.0 / 4294967296.0);
}

fn value_noise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p_in: vec2<f32>, octaves: i32) -> f32 {
  var p = p_in;
  var amp = 0.5;
  var sum = 0.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += amp * value_noise(p);
    norm += amp;
    p = vec2<f32>(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8) * 2.02 + vec2<f32>(17.3, 9.1);
    amp *= 0.5;
  }
  return sum / norm;
}

fn luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}
