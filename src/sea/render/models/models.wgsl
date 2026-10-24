// MC2's buildings, trees, mechs and vehicles. Every model is one vertex buffer whose vertices name the node they
// move with, so a whole lance of one mech type is a single instanced draw: each instance's node matrices (world,
// metres) sit in a storage buffer, and `bases[instance]` is where that instance's first one is.
//   Requires common, scene, sky_map, env, haze, shadow. Group 2 = matrices and bases, group 3 = shadow + material.
const EARTH_R: f32 = 6371000.0;

struct Affine {
  r0: vec4<f32>,
  r1: vec4<f32>,
  r2: vec4<f32>,
};

@group(2) @binding(0) var<storage, read> mats: array<Affine>;
@group(2) @binding(1) var<storage, read> bases: array<u32>;

struct Material {
  color: vec4<f32>,
  params: vec4<f32>,  // x alpha cutoff, y unlit (1) or lit (0), z brightness, w unused
};

@group(3) @binding(2) var<uniform> material: Material;
@group(3) @binding(3) var base_tex: texture_2d<f32>;
@group(3) @binding(4) var base_samp: sampler;

struct VIn {
  @location(0) pos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) node: u32,
  @builtin(instance_index) inst: u32,
};

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) rel: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

@vertex
fn vs(in: VIn) -> VOut {
  let m = mats[bases[in.inst] + in.node];
  let p = vec4<f32>(in.pos, 1.0);
  var rel = vec3<f32>(dot(m.r0, p), dot(m.r1, p), dot(m.r2, p)) - scene.cam_pos.xyz;
  rel.y -= dot(rel.xz, rel.xz) / (2.0 * EARTH_R);
  var out: VOut;
  out.clip = scene.view_proj * vec4<f32>(rel, 1.0);
  out.rel = rel;
  out.nrm = vec3<f32>(dot(m.r0.xyz, in.nrm), dot(m.r1.xyz, in.nrm), dot(m.r2.xyz, in.nrm));
  out.uv = in.uv;
  return out;
}

// MC2 lit its models per vertex with an ambient term and the sun: the same here, at the brightness the land's
// pre-lit colour map is shown at (map.wgsl), with the sun shadowed by whatever stands between.
fn shade(in: VOut, front: bool, albedo: vec3<f32>) -> vec4<f32> {
  var col: vec3<f32>;
  if (material.params.y > 0.5) {
    col = albedo * (scene.sun_irr.rgb / PI) * material.params.z;
  } else {
    var n = normalize(in.nrm);
    if (!front) {
      n = -n;
    }
    let l = scene.sun_dir.xyz;
    let nl = saturate(dot(n, l));
    let lit = shadow_factor(in.rel, n);
    col = albedo * (scene.ambient.rgb * 1.15 + scene.sun_irr.rgb * (nl / PI) * lit) * material.params.z;
  }
  return vec4<f32>(apply_haze(col, in.rel), 1.0);
}

@fragment
fn fs(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  let albedo = textureSample(base_tex, base_samp, in.uv) * material.color;
  return shade(in, front, albedo.rgb);
}

// Leaves, fences and nets cut out of their textures. A separate pipeline: discarding pixels costs a tile-based GPU its
// hidden-surface removal, so only the materials that need it pay for it.
@fragment
fn fs_cutout(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  let albedo = textureSample(base_tex, base_samp, in.uv) * material.color;
  if (albedo.a < material.params.x) {
    discard;
  }
  return shade(in, front, albedo.rgb);
}
