// The models drawn into the sun's shadow map: the same matrices as models.wgsl, projected by the scene's shadow
// matrix (camera-relative world to the sun's orthographic clip space). Requires scene.
//   Group 1 = matrices and bases, group 2 = material (for the cut-out variant only).
const EARTH_R: f32 = 6371000.0;

struct Affine {
  r0: vec4<f32>,
  r1: vec4<f32>,
  r2: vec4<f32>,
};

@group(1) @binding(0) var<storage, read> mats: array<Affine>;
@group(1) @binding(1) var<storage, read> bases: array<u32>;

struct Material {
  color: vec4<f32>,
  params: vec4<f32>,
};

@group(2) @binding(2) var<uniform> material: Material;
@group(2) @binding(3) var base_tex: texture_2d<f32>;
@group(2) @binding(4) var base_samp: sampler;

struct VIn {
  @location(0) pos: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) node: u32,
  @builtin(instance_index) inst: u32,
};

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(in: VIn) -> VOut {
  let m = mats[bases[in.inst] + in.node];
  let p = vec4<f32>(in.pos, 1.0);
  var rel = vec3<f32>(dot(m.r0, p), dot(m.r1, p), dot(m.r2, p)) - scene.cam_pos.xyz;
  rel.y -= dot(rel.xz, rel.xz) / (2.0 * EARTH_R);
  var out: VOut;
  out.clip = scene.shadow_vp * vec4<f32>(rel, 1.0);
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_cutout(in: VOut) {
  if (textureSample(base_tex, base_samp, in.uv).a * material.color.a < material.params.x) {
    discard;
  }
}
