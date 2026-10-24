// Wake foam drawn as alpha-blended ribbons lying on the water. Vertices are (x, z) in metres relative to the
// camera, across (-1..1), foam strength, and a kind (1 = faint Kelvin line). The vertex shader rides the same wave
// displacement as the ocean mesh so the foam follows the swell; the fragment shader breaks it into lace with the
// baked noise texture. Only the pixels the wake covers are shaded: there is no wake map and no ocean-shader cost.
// Requires common, scene, sky_map, env, noise, haze. Group 2 = wave textures (disp, sampler).
@group(2) @binding(0) var disp_tex: texture_2d_array<f32>;
@group(2) @binding(2) var wave_samp: sampler;

const EARTH_R: f32 = 6371000.0;
/** Lifts the foam above the displaced surface so it is not buried between the ocean mesh's vertices. */
const LIFT: f32 = 0.28;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) across: f32,
  @location(1) foam: f32,
  @location(2) kind: f32,
  @location(3) p0: vec2<f32>,
  @location(4) rel: vec3<f32>,
};

@vertex
fn vs(@location(0) v: vec4<f32>, @location(1) kind: f32) -> VOut {
  let p0 = v.xy;
  let spacing = max(1.0, length(p0) * 0.0235);
  var disp = vec3<f32>(0.0);
  for (var c = 0u; c < 3u; c++) {
    let cc = scene.cascade[c];
    let uv = p0 * cc.x + cc.yz;
    let lod = max(log2(2.0 * spacing / cc.w), 0.0);
    disp += textureSampleLevel(disp_tex, wave_samp, uv, c, lod).xyz;
  }
  let drop = dot(p0, p0) / (2.0 * EARTH_R);
  let rel = vec3<f32>(p0.x + disp.x, disp.y - scene.cam_pos.y - drop + LIFT, p0.y + disp.z);

  var out: VOut;
  out.pos = scene.view_proj * vec4<f32>(rel, 1.0);
  out.across = v.z;
  out.foam = v.w;
  out.kind = kind;
  out.p0 = p0;
  out.rel = rel;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let cc1 = scene.cascade[1];
  let cc2 = scene.cascade[2];
  let nuv1 = in.p0 * cc1.x + cc1.yz;
  let nuv2 = in.p0 * cc2.x + cc2.yz;

  // Patches at a few metres, lace at under a metre. Multiples of 32 lattice cells per wave tile keep the noise
  // seamless as the tile UV wraps while the camera moves.
  let big = 0.6 * noise_lookup(nuv1 * 32.0) + 0.4 * noise_lookup(nuv2 * 32.0);
  let fine = noise_lookup(nuv2 * 64.0);
  // Ragged edges: the noise pushes the ribbon boundary in and out instead of a clean curve.
  let a = in.across + (big - 0.5) * 0.55;
  let profile = smoothstep(0.0, 0.75, 1.0 - a * a);
  let density = in.foam * profile * (0.55 + 0.7 * big) * 0.8 + (fine - 0.5) * 0.2;
  let coverage = smoothstep(0.16, 0.6, density) * mix(0.95, 0.5, in.kind);
  if (coverage < 0.01) {
    discard;
  }

  // Lit like the sea's own foam, lifted a little so a wake stays readable at dusk.
  let l = scene.sun_dir.xyz;
  let lit = scene.ambient.rgb * 1.5 + scene.sun_irr.rgb * saturate(l.y) / PI;
  let tint = mix(vec3<f32>(0.80, 0.93, 0.95), vec3<f32>(0.95, 0.97, 0.99), coverage);
  let col = apply_haze(tint * lit * 0.9, in.rel);
  return vec4<f32>(col, coverage);
}
