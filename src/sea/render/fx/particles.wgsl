// Billboard particles: gun smoke, spray, fire and tracers. One instanced quad each, premultiplied-alpha blended and
// depth-tested (not written), drawn after the ships. Instances are camera-relative, so a 30 km range loses no precision.
//   kind 0: a lit puff (smoke, spray, mist) with noise-ragged edges.
//   kind 1: a glow (flash, fire, sparks, tracer). Its colour is what ends up on screen after exposure, so a muzzle
//           flash is just as bright at noon as at dusk, and is allowed to exceed 1 to feed the bloom.
//   kind 2: a film (an oil slick): a ragged patch lying flat on the water, dark, with a faint rainbow sheen.
// Requires common, scene, sky_map, env, noise, haze. Group 1 = sky, sampler, noise.
const EARTH_R: f32 = 6371000.0;

struct Inst {
  @location(0) pos_size: vec4<f32>, // xyz camera-relative centre, w diameter (m)
  @location(1) color: vec4<f32>,    // rgb colour, a opacity (puff) or intensity (glow)
  @location(2) misc: vec4<f32>,     // x rotation, y kind, z seed
};

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) @interpolate(flat) kind: f32,
  @location(3) @interpolate(flat) seed: f32,
  // Aerial perspective is worked out once per puff, at its centre: a billboard is small beside the distance to it, and
  // this keeps the sky lookup out of the fragment shader, where a screen of overlapping smoke would pay for it per pixel.
  @location(4) @interpolate(flat) haze_tr: vec3<f32>,
  @location(5) @interpolate(flat) haze_add: vec3<f32>,
};

const CORNERS = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, inst: Inst) -> VOut {
  let corner = CORNERS[vi];
  var c = inst.pos_size.xyz;
  c.y -= dot(c.xz, c.xz) / (2.0 * EARTH_R);
  let dist = max(length(c), 1.0);

  // Never smaller than a couple of pixels, so distant bursts and shells stay visible.
  let metres_per_px = dist * 2.0 * scene.cam_up.w / scene.screen.y;
  let glow = inst.misc.y > 0.5 && inst.misc.y < 1.5;
  let film = inst.misc.y > 1.5;
  let min_px = select(2.0, 3.0, glow);
  let size = max(inst.pos_size.w, metres_per_px * min_px);

  let cs = cos(inst.misc.x);
  let sn = sin(inst.misc.x);
  let rc = vec2<f32>(corner.x * cs - corner.y * sn, corner.x * sn + corner.y * cs);
  // A film lies on the water; everything else faces the camera.
  let on_water = vec3<f32>(rc.x, 0.0, rc.y) * (size * 0.5);
  let world = c + select((scene.cam_right.xyz * rc.x + scene.cam_up.xyz * rc.y) * (size * 0.5), on_water, film);

  var out: VOut;
  out.pos = scene.view_proj * vec4<f32>(world, 1.0);
  out.uv = rc;
  // Puffs very close to the camera fade out rather than filling the screen; glows keep their strength.
  // A puff that would cover most of the screen fades out and is then dropped: it is mostly overdraw and hides everything.
  let cover = size / (metres_per_px * scene.screen.y);
  let near_fade = select(smoothstep(4.0, 40.0, dist) * (1.0 - smoothstep(0.5, 1.1, cover)), 1.0, glow);
  out.color = vec4<f32>(inst.color.rgb, inst.color.a * near_fade);
  if (near_fade <= 0.0) {
    out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  }
  out.kind = inst.misc.y;
  out.seed = inst.misc.z;
  let vis_m = scene.ocean.w * 1000.0;
  let beta = (3.912 / vis_m) * vec3<f32>(0.85, 1.0, 1.18) * scene.atmo.y;
  let tr = exp(-beta * length(c));
  let fog = sky_radiance(normalize(vec3<f32>(c.x, 0.012 * length(c.xz), c.z)));
  out.haze_tr = tr;
  out.haze_add = fog * (1.0 - tr);
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let r2 = dot(in.uv, in.uv);
  if (r2 > 1.0) {
    discard;
  }
  if (in.kind > 1.5) {
    // The slick: a disc whose edge the noise has torn, translucent, nearly black, with the sky's colours showing faintly in it.
    let rr = sqrt(r2);
    let sdf = vec2<f32>(in.seed * 9.1, in.seed * 4.7);
    let f1 = noise_lookup(in.uv * 1.6 + sdf);
    let f2 = noise_lookup(in.uv * 4.1 + sdf.yx + vec2<f32>(3.0, 8.0));
    let edge_f = (1.0 - rr) + (f1 - 0.5) * 0.9 + (f2 - 0.5) * 0.35;
    let af = smoothstep(0.0, 0.35, edge_f) * in.color.a * (0.6 + 0.4 * f2);
    if (af < 0.004) {
      discard;
    }
    let sheen = 0.5 + 0.5 * cos(6.2831853 * (vec3<f32>(0.0, 0.33, 0.67) + f1 * 1.5 + in.seed));
    let cf = (in.color.rgb + sheen * scene.ambient.rgb * 0.22) * in.haze_tr + in.haze_add;
    return vec4<f32>(cf * af, af);
  }
  if (in.kind > 0.5) {
    // Hot core inside a soft halo; additive (alpha 0 in premultiplied blending).
    let halo = exp(-r2 * 4.0);
    let core = exp(-r2 * 16.0);
    let e = in.color.rgb * in.color.a * (halo * 0.7 + core * 1.6) / scene.sun_irr.w;
    return vec4<f32>(e, 0.0);
  }

  let r = sqrt(r2);
  let sd = vec2<f32>(in.seed * 11.7, in.seed * 5.3);
  let n1 = noise_lookup(in.uv * 2.4 + sd);
  let n2 = noise_lookup(in.uv * 5.3 + sd.yx + vec2<f32>(7.0, 3.0));
  // The silhouette: a disc whose edge is pushed in and out by the noise, so every puff has its own ragged outline.
  let edge = (1.0 - r) + (n1 - 0.5) * 0.8 + (n2 - 0.5) * 0.3;
  let a = smoothstep(0.0, 0.5, edge) * in.color.a * (0.55 + 0.45 * n1);
  if (a < 0.004) {
    discard;
  }

  // A fake sphere normal for shading: brighter on the sunward side, never black on the other.
  let z = sqrt(max(1.0 - r2, 0.0));
  let nrm = normalize(scene.cam_right.xyz * in.uv.x + scene.cam_up.xyz * in.uv.y - scene.cam_fwd.xyz * z);
  let sun = scene.sun_dir.xyz;
  let wrap = saturate(dot(nrm, sun) * 0.5 + 0.5);
  let lit = scene.ambient.rgb * 1.6 + scene.sun_irr.rgb * (0.2 + 0.8 * wrap) * saturate(sun.y * 3.0 + 0.1) / PI;
  let col = in.color.rgb * lit * in.haze_tr + in.haze_add;
  return vec4<f32>(col * a, a);
}
