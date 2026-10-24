// Ocean surface: a camera-centred polar grid (1 m rings near the ship, geometric rings out to the horizon)
// displaced by three FFT cascades. Requires common, scene, sky_map, env, haze, shadow, map. Group 2 = wave textures.
@group(2) @binding(0) var disp_tex: texture_2d_array<f32>;
@group(2) @binding(1) var deriv_tex: texture_2d_array<f32>;
@group(2) @binding(2) var ocean_samp: sampler;

const GRID_SEGS: u32 = 384u;
const NEAR_RINGS: u32 = 64u;
const NEAR_R0: f32 = 2.0;
const FAR_GROWTH: f32 = 1.0235;
const EARTH_R: f32 = 6371000.0;
const BODY_ALBEDO = vec3<f32>(0.018, 0.075, 0.105);

fn ring_radius(i: u32) -> f32 {
  if (i < NEAR_RINGS) {
    return NEAR_R0 + f32(i);
  }
  return (NEAR_R0 + f32(NEAR_RINGS)) * pow(FAR_GROWTH, f32(i - NEAR_RINGS));
}

fn grid_spacing(r: f32) -> f32 {
  return max(1.0, r * 0.0235);
}

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) rel: vec3<f32>,     // camera-relative displaced position
  @location(1) p0: vec2<f32>,      // camera-relative undisplaced xz (where the textures are sampled)
  @location(2) height: f32,
};

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> VsOut {
  let ring = vid / GRID_SEGS;
  let seg = vid % GRID_SEGS;
  let r = ring_radius(ring);
  let a = f32(seg) * (TAU / f32(GRID_SEGS));
  let p0 = vec2<f32>(cos(a), sin(a)) * r;
  let spacing = grid_spacing(r);

  // Displacement is low-passed by mip level according to the local vertex spacing, so geometry never tries
  // to carry waves the mesh cannot represent; finer detail lives in the per-pixel normals.
  var disp = vec3<f32>(0.0);
  for (var c = 0u; c < 3u; c++) {
    let cc = scene.cascade[c];
    let uv = p0 * cc.x + cc.yz;
    let lod = max(log2(2.0 * spacing / cc.w), 0.0);
    disp += textureSampleLevel(disp_tex, ocean_samp, uv, c, lod).xyz;
  }

  let drop = dot(p0, p0) / (2.0 * EARTH_R);
  let rel = vec3<f32>(p0.x + disp.x, disp.y - scene.cam_pos.y - drop, p0.y + disp.z);

  var out: VsOut;
  out.pos = scene.view_proj * vec4<f32>(rel, 1.0);
  out.rel = rel;
  out.p0 = p0;
  out.height = disp.y;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  var slope = vec2<f32>(0.0);
  var variance = 0.0;
  var foam = 0.0;
  for (var c = 0u; c < 3u; c++) {
    let cc = scene.cascade[c];
    let uv = in.p0 * cc.x + cc.yz;
    let d = textureSample(deriv_tex, ocean_samp, uv, c);
    slope += d.xy;
    // E[s^2] - |E[s]|^2 from the mip chain: slope energy the pixel footprint can no longer resolve.
    variance += max(d.z - dot(d.xy, d.xy), 0.0);
    foam = max(foam, d.w);
  }

  let dist = length(in.rel);
  let v = -in.rel / max(dist, 1e-3);
  let n = normalize(vec3<f32>(-slope.x, 1.0, -slope.y));
  let nv = max(dot(n, v), 0.02);
  let alpha2 = 0.0004 + variance;
  let alpha = sqrt(alpha2);

  let f0 = 0.02;
  let fres = f0 + (max(1.0 - alpha, f0) - f0) * pow(1.0 - nv, 5.0);

  var refl = reflect(-v, n);
  refl.y = abs(refl.y);
  let sky = env_radiance(normalize(refl));

  let l = scene.sun_dir.xyz;
  let sun_irr = scene.sun_irr.rgb;
  let ambient = scene.ambient.rgb;

  // Sun glitter: GGX with the sun's angular size folded into the roughness.
  let h = normalize(l + v);
  let nl = max(dot(n, l), 0.0);
  let nh = max(dot(n, h), 0.0);
  let vh = max(dot(v, h), 0.0);
  let sun_r = scene.sun_dir.w;
  let a2 = alpha2 + sun_r * sun_r;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let ndf = a2 / (PI * dd * dd);
  let gv = nl * sqrt(nv * nv * (1.0 - a2) + a2);
  let gl = nv * sqrt(nl * nl * (1.0 - a2) + a2);
  let vis = 0.5 / max(gv + gl, 1e-4);
  let fh = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
  let sun_shadow = shadow_factor_fast(in.rel, n);
  let spec = sun_irr * (ndf * vis * fh * nl) * sun_shadow;

  // Water body: dark teal lit by sky and sun, with light scattered through thin crests when backlit.
  let body_light = ambient + sun_irr * max(l.y, 0.0) * sun_shadow / PI;
  let crest = saturate(in.height * 0.35 / max(scene.ocean.y, 0.5) + 0.35);
  let back = pow(saturate(dot(-v, l)), 4.0);
  let sss = vec3<f32>(0.015, 0.11, 0.085) * sun_irr * crest * (0.1 + back) * saturate(l.y * 3.0) * sun_shadow;
  var water = BODY_ALBEDO * body_light + sss;

  // The sea floor through shallow water: MC2's maps are islands on sandy shelves. The floor's pre-lit colour map is
  // reddened away by the water above it and veiled by the water body, so deep water hides it, as the original's did.
  let world = scene.cam_pos.xz + in.p0;
  let floor_col = map_ground(world) * map_light();
  let depth = max(in.height - map_height_at(world), 0.0);
  let clarity = max(map_params.clarity, 0.1);
  let absorb = exp(-depth * vec3<f32>(0.30, 0.075, 0.055) * (3.5 / clarity));
  let veil = 1.0 - exp(-depth / clarity);
  water = mix(floor_col * absorb, water, veil);

  water = water * (1.0 - fres) + sky * fres;

  // Foam: persistent coverage from the Jacobian, broken up into lace with noise.
  // Foam. Noise is the baked tileable texture sampled at a multiple of 32 lattice cells per wave tile, so it stays
  // seamless as a tile UV wraps by exactly 1.0 while the camera moves (a hash would jump every tile).
  let cc2 = scene.cascade[2];
  let nuv2 = in.p0 * cc2.x + cc2.yz;
  var foam_cov = 0.0;
  if (foam > 0.04) {
    let nz = 0.5 * noise_lookup(nuv2 * 64.0) + 0.3 * noise_lookup(nuv2 * 128.0) + 0.2 * noise_lookup(nuv2 * 256.0);
    foam_cov = smoothstep(0.34, 0.68, foam + (nz - 0.5) * 0.7);
  }

  // Aerated water reads slightly blue-green where the foam is thin.
  let foam_tint = mix(vec3<f32>(0.80, 0.93, 0.95), vec3<f32>(0.93, 0.96, 0.98), foam_cov);
  let foam_col = foam_tint * (ambient + sun_irr * saturate(l.y) * sun_shadow / PI) * 0.85;
  var col = mix(water, foam_col, foam_cov * 0.92);
  col += spec * (1.0 - foam_cov);

  col = apply_haze(col, in.rel);

  return vec4<f32>(col, 1.0);
}
