// Baked tileable value noise (group 1, bindings 3-4): one texture fetch per octave instead of several hashes.
// 32 lattice cells span the texture and it repeats, so a coordinate that wraps by a whole texture is seamless.
// `p` is in lattice units; to stay seamless when a wave-tile UV wraps by 1.0, scale that UV by a multiple of 32.
@group(1) @binding(3) var noise_tex: texture_2d<f32>;
@group(1) @binding(4) var noise_samp: sampler;

fn noise_lookup(p: vec2<f32>) -> f32 {
  return textureSampleLevel(noise_tex, noise_samp, p * (1.0 / 32.0), 0.0).r;
}
