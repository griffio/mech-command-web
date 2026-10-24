// Per-frame scene uniform. Layout must match SLOT in src/render/scene-block.ts (25 vec4 slots).
struct Scene {
  view_proj: mat4x4<f32>,
  cam_right: vec4<f32>,       // xyz right, w = tan(fovY/2) * aspect
  cam_up: vec4<f32>,          // xyz up, w = tan(fovY/2)
  cam_fwd: vec4<f32>,         // xyz forward, w = near
  cam_pos: vec4<f32>,         // xyz world position (m), w = looped time (s)
  sun_dir: vec4<f32>,         // xyz toward the sun, w = angular radius (rad)
  sun_irr: vec4<f32>,         // rgb sunlight at sea level (perpendicular), w = exposure
  screen: vec4<f32>,          // width, height, 1/width, 1/height
  ocean: vec4<f32>,           // x choppiness, y significant wave height, z unused, w visibility (km)
  ocean2: vec4<f32>,
  cascade: array<vec4<f32>, 3>, // x 1/length, y camUV.x, z camUV.y, w texel size (m)
  cloud: vec4<f32>,           // x coverage, y altitude (m), z wind offset x, w wind offset z
  cloud_sun: vec4<f32>,       // rgb sunlight colour at cloud altitude
  atmo: vec4<f32>,            // x sun elevation sine, y haze multiplier
  shadow_vp: mat4x4<f32>,     // camera-relative world -> sun-shadow clip space (orthographic)
  shadow: vec4<f32>,          // x enabled, y texel size (uv), z normal offset (m), w depth bias
  ambient: vec4<f32>,         // GPU-written: cosine-weighted mean sky radiance
};

@group(0) @binding(0) var<uniform> scene: Scene;
