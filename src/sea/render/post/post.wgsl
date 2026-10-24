// Post-processing: dual-filter bloom and the final tone-map composite. Shared bind group layout:
//   0 uniform Post, 1 source texture, 2 sampler, 3 bloom texture (composite only).
struct Post {
  params: vec4<f32>,  // x exposure, y bloom strength, z bloom input clamp, w unused
  texel: vec4<f32>,   // xy = 1 / source size
};

@group(0) @binding(0) var<uniform> post: Post;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var bloom_tex: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4<f32>(p[i], 0.0, 1.0);
  o.uv = vec2<f32>(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}

fn luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// First bloom level: apply exposure, clamp, and Karis-average the four taps so single hot pixels
// (sun glitter) cannot flicker the whole bloom.
@fragment
fn fs_down_first(in: VOut) -> @location(0) vec4<f32> {
  let o = post.texel.xy;
  let e = post.params.x;
  let cmax = vec3<f32>(post.params.z);
  let a = min(textureSample(src, samp, in.uv + vec2<f32>(-o.x, -o.y)).rgb * e, cmax);
  let b = min(textureSample(src, samp, in.uv + vec2<f32>(o.x, -o.y)).rgb * e, cmax);
  let c = min(textureSample(src, samp, in.uv + vec2<f32>(-o.x, o.y)).rgb * e, cmax);
  let d = min(textureSample(src, samp, in.uv + vec2<f32>(o.x, o.y)).rgb * e, cmax);
  let wa = 1.0 / (1.0 + luma(a));
  let wb = 1.0 / (1.0 + luma(b));
  let wc = 1.0 / (1.0 + luma(c));
  let wd = 1.0 / (1.0 + luma(d));
  return vec4<f32>((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), 1.0);
}

@fragment
fn fs_down(in: VOut) -> @location(0) vec4<f32> {
  let o = post.texel.xy;
  let s = textureSample(src, samp, in.uv + vec2<f32>(-o.x, -o.y)).rgb
    + textureSample(src, samp, in.uv + vec2<f32>(o.x, -o.y)).rgb
    + textureSample(src, samp, in.uv + vec2<f32>(-o.x, o.y)).rgb
    + textureSample(src, samp, in.uv + vec2<f32>(o.x, o.y)).rgb;
  return vec4<f32>(s * 0.25, 1.0);
}

// Tent upsample, added onto the next-larger level by blending.
@fragment
fn fs_up(in: VOut) -> @location(0) vec4<f32> {
  let o = post.texel.xy;
  var s = textureSample(src, samp, in.uv).rgb * 4.0;
  s += textureSample(src, samp, in.uv + vec2<f32>(-o.x, 0.0)).rgb * 2.0;
  s += textureSample(src, samp, in.uv + vec2<f32>(o.x, 0.0)).rgb * 2.0;
  s += textureSample(src, samp, in.uv + vec2<f32>(0.0, -o.y)).rgb * 2.0;
  s += textureSample(src, samp, in.uv + vec2<f32>(0.0, o.y)).rgb * 2.0;
  s += textureSample(src, samp, in.uv + vec2<f32>(-o.x, -o.y)).rgb;
  s += textureSample(src, samp, in.uv + vec2<f32>(o.x, -o.y)).rgb;
  s += textureSample(src, samp, in.uv + vec2<f32>(-o.x, o.y)).rgb;
  s += textureSample(src, samp, in.uv + vec2<f32>(o.x, o.y)).rgb;
  return vec4<f32>(s * (1.0 / 16.0), 1.0);
}

// AgX (Troy Sobotka's filmic view transform, polynomial approximation as popularised by three.js).
// Matrices are written as columns.
const SRGB_TO_REC2020 = mat3x3<f32>(
  vec3<f32>(0.6274, 0.0691, 0.0164),
  vec3<f32>(0.3293, 0.9195, 0.0880),
  vec3<f32>(0.0433, 0.0113, 0.8956),
);
const REC2020_TO_SRGB = mat3x3<f32>(
  vec3<f32>(1.6605, -0.1246, -0.0182),
  vec3<f32>(-0.5876, 1.1329, -0.1006),
  vec3<f32>(-0.0728, -0.0083, 1.1187),
);
const AGX_INSET = mat3x3<f32>(
  vec3<f32>(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3<f32>(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3<f32>(0.0482516061458583, 0.101439036467562, 0.811302368396859),
);
const AGX_OUTSET = mat3x3<f32>(
  vec3<f32>(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3<f32>(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3<f32>(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405),
);
const AGX_MIN_EV: f32 = -12.47393;
const AGX_MAX_EV: f32 = 4.026069;

fn agx_contrast(x: vec3<f32>) -> vec3<f32> {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn agx(color_in: vec3<f32>) -> vec3<f32> {
  var c = AGX_INSET * (SRGB_TO_REC2020 * color_in);
  c = max(c, vec3<f32>(1e-10));
  c = log2(c);
  c = (c - vec3<f32>(AGX_MIN_EV)) / (AGX_MAX_EV - AGX_MIN_EV);
  c = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
  c = agx_contrast(c);
  c = AGX_OUTSET * c;
  c = pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2));
  c = REC2020_TO_SRGB * c;
  return clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn srgb_encode(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

@fragment
fn fs_composite(in: VOut) -> @location(0) vec4<f32> {
  let hdr = textureSample(src, samp, in.uv).rgb * post.params.x;
  let bloom = textureSample(bloom_tex, samp, in.uv).rgb;
  var c = hdr + bloom * post.params.y;

  let q = in.uv - vec2<f32>(0.5);
  c *= 1.0 - 0.28 * dot(q, q);

  var out_c = srgb_encode(agx(c));
  // Interleaved gradient noise dither hides banding in smooth sky gradients.
  let n = fract(52.9829189 * fract(dot(in.pos.xy, vec2<f32>(0.06711056, 0.00583715))));
  out_c += vec3<f32>((n - 0.5) / 255.0);
  return vec4<f32>(out_c, 1.0);
}
