// Parameters shared by the ocean compute passes.
struct Sim {
  a: vec4<f32>,        // x looped time (s), y w0 (base angular frequency), z choppiness, w foam decay per frame
  lengths: vec4<f32>,  // tile length (m) per cascade
  foam: vec4<f32>,     // foam gain per cascade
  b: vec4<f32>,        // x n, y cascades, z foam bias (Jacobian threshold)
};

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}
