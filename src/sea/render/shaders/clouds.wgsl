// Single stylised cloud layer. Requires common.wgsl, scene.wgsl and noise.wgsl (baked tileable noise).
// Returns premultiplied radiance (rgb) and opacity (a). Self-shadowing is faked by sampling the density a
// step toward the sun; the silver lining comes from a forward-scattering phase lobe.
fn fbm_tex(p_in: vec2<f32>, octaves: i32) -> f32 {
  var p = p_in;
  var amp = 0.5;
  var sum = 0.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += amp * noise_lookup(p);
    norm += amp;
    p = vec2<f32>(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8) * 2.02 + vec2<f32>(17.3, 9.1);
    amp *= 0.5;
  }
  return sum / norm;
}

fn cloud_sample(dir: vec3<f32>, octaves: i32) -> vec4<f32> {
  if (dir.y < 0.012) {
    return vec4<f32>(0.0);
  }
  let alt = scene.cloud.y;
  let t = max(alt - scene.cam_pos.y, 1.0) / dir.y;
  let p = dir.xz * t + scene.cloud.zw;
  let uv = p * (1.0 / 6500.0);

  let thr = 1.0 - scene.cloud.x;
  let n0 = fbm_tex(uv, octaves);
  let dens = smoothstep(thr, thr + 0.22, n0);
  if (dens <= 0.002) {
    return vec4<f32>(0.0);
  }

  let sun = scene.sun_dir.xyz;
  let toward = sun.xz / max(sun.y, 0.1) * 0.06;
  let n1 = fbm_tex(uv + toward, max(octaves - 2, 2));
  let d1 = smoothstep(thr, thr + 0.22, n1);

  let shade = exp(-3.6 * mix(dens, d1, 0.65));
  let cos_sv = dot(dir, sun);
  let g = 0.55;
  let hg = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * cos_sv, 1.5));
  let phase = 0.3 + 1.7 * hg;

  let sunlit = scene.cloud_sun.rgb * shade * phase;
  let amb = scene.ambient.rgb * (0.9 + 0.6 * (1.0 - dens));
  let albedo = 0.9;
  let rgb = albedo * (sunlit + amb);

  let horizon = smoothstep(0.012, 0.16, dir.y);
  let alpha = saturate(dens * 1.15) * horizon;
  return vec4<f32>(rgb * alpha, alpha);
}
