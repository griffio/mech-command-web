// Sun shadow lookup (group 3): one orthographic depth map framed on the player ship. Requires scene.
@group(3) @binding(0) var shadow_map: texture_depth_2d;
@group(3) @binding(1) var shadow_samp: sampler_comparison;

// Shadow-map coordinates: xy = uv, z = biased depth, w = 1 when inside the map.
fn shadow_coords(rel: vec3<f32>, n: vec3<f32>) -> vec4<f32> {
  if (scene.shadow.x < 0.5) {
    return vec4<f32>(0.0);
  }
  let nl = saturate(dot(n, scene.sun_dir.xyz));
  let offset = n * (scene.shadow.z * (1.0 - nl) + 0.04);
  let lp = scene.shadow_vp * vec4<f32>(rel + offset, 1.0);
  let uv = vec2<f32>(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
  let inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 && lp.z <= 1.0 && lp.z >= 0.0;
  return vec4<f32>(uv, lp.z - scene.shadow.w, select(0.0, 1.0, inside));
}

// 1 = fully lit, 0 = fully shadowed. 3x3 PCF: for ships, where the pixels are few and the edges matter.
fn shadow_factor(rel: vec3<f32>, n: vec3<f32>) -> f32 {
  let c = shadow_coords(rel, n);
  if (c.w < 0.5) {
    return 1.0;
  }
  let t = scene.shadow.y;
  var lit = 0.0;
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      lit += textureSampleCompareLevel(shadow_map, shadow_samp, c.xy + vec2<f32>(f32(i), f32(j)) * t, c.z);
    }
  }
  return lit / 9.0;
}

// Four bilinear-compare taps: the sea covers many more pixels than the ship, and water does not need crisp edges.
fn shadow_factor_fast(rel: vec3<f32>, n: vec3<f32>) -> f32 {
  let c = shadow_coords(rel, n);
  if (c.w < 0.5) {
    return 1.0;
  }
  let t = scene.shadow.y * 0.75;
  var lit = textureSampleCompareLevel(shadow_map, shadow_samp, c.xy + vec2<f32>(-t, -t), c.z);
  lit += textureSampleCompareLevel(shadow_map, shadow_samp, c.xy + vec2<f32>(t, -t), c.z);
  lit += textureSampleCompareLevel(shadow_map, shadow_samp, c.xy + vec2<f32>(-t, t), c.z);
  lit += textureSampleCompareLevel(shadow_map, shadow_samp, c.xy + vec2<f32>(t, t), c.z);
  return lit * 0.25;
}
