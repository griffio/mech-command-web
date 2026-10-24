// Beams: laser and PPC fire, drawn as quads from muzzle to target that turn to face the camera, with a soft bright core,
// blended additively. Positions are camera-relative. Requires common, scene.

struct Inst {
  @location(0) a: vec4<f32>,      // start (camera-relative), w = width (m)
  @location(1) b: vec4<f32>,      // end (camera-relative), w = brightness
  @location(2) color: vec4<f32>,  // linear colour, w = core sharpness
};

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) across: f32,
  @location(1) color: vec3<f32>,
  @location(2) core: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, inst: Inst) -> VOut {
  // Two triangles: t runs along the beam, s across it.
  var ts = array<vec2<f32>, 6>(
    vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  let c = ts[vi];
  let along = inst.b.xyz - inst.a.xyz;
  let p = inst.a.xyz + along * c.x;
  let axis = normalize(along);
  // Widen it across the line of sight (the camera sits at the origin of camera-relative space).
  var side = cross(axis, normalize(p));
  if (dot(side, side) < 1e-8) {
    side = cross(axis, vec3<f32>(0.0, 1.0, 0.0));
  }
  side = normalize(side);
  var out: VOut;
  out.clip = scene.view_proj * vec4<f32>(p + side * (inst.a.w * 0.5 * c.y), 1.0);
  out.across = c.y;
  // As bright as sunlit white at brightness 1, so beams sit in the scene's exposure whatever the time of day.
  out.color = inst.color.rgb * inst.b.w * (scene.sun_irr.g / PI);
  out.core = inst.color.w;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let d = abs(in.across);
  // A white-hot core inside a coloured glow that falls off to nothing at the edge.
  let glow = (1.0 - d) * (1.0 - d);
  let core = exp(-d * d * in.core);
  let col = in.color * glow + vec3<f32>(core) * length(in.color) * 0.6;
  return vec4<f32>(col, 0.0);
}
