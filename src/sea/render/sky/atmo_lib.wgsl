// Atmosphere model (Hillaire 2020 parameters). Units: kilometres. Y is up and the planet centre is at
// (0, 0, 0), so a viewer at sea level sits at (0, R_BOT, 0). Requires common.wgsl.
const R_BOT: f32 = 6360.0;
const R_TOP: f32 = 6460.0;
const RAYLEIGH_S = vec3<f32>(0.005802, 0.013558, 0.0331);
const MIE_S: f32 = 0.003996;
const MIE_E: f32 = 0.00444;
const OZONE_A = vec3<f32>(0.00065, 0.001881, 0.000085);
const MIE_G: f32 = 0.8;
const GROUND_ALBEDO: f32 = 0.1;

struct Medium {
  ray: vec3<f32>,   // Rayleigh scattering
  mie: f32,         // Mie scattering
  scat: vec3<f32>,  // total scattering
  ext: vec3<f32>,   // total extinction
};

fn medium_at(h_km: f32) -> Medium {
  let h = max(h_km, 0.0);
  let dr = exp(-h / 8.0);
  let dm = exp(-h / 1.2);
  let dz = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  var m: Medium;
  m.ray = RAYLEIGH_S * dr;
  m.mie = MIE_S * dm;
  m.scat = m.ray + vec3<f32>(m.mie);
  m.ext = m.ray + vec3<f32>(MIE_E * dm) + OZONE_A * dz;
  return m;
}

// Distance along d from p (inside the sphere of radius rad) to the sphere.
fn ray_sphere_far(p: vec3<f32>, d: vec3<f32>, rad: f32) -> f32 {
  let b = dot(p, d);
  let c = dot(p, p) - rad * rad;
  return -b + sqrt(max(b * b - c, 0.0));
}

// Distance to the planet surface, or -1 when the ray misses it.
fn ground_distance(p: vec3<f32>, d: vec3<f32>) -> f32 {
  let b = dot(p, d);
  let c = dot(p, p) - R_BOT * R_BOT;
  let disc = b * b - c;
  if (disc <= 0.0) {
    return -1.0;
  }
  let t0 = -b - sqrt(disc);
  return select(-1.0, t0, t0 > 0.0);
}

fn rayleigh_phase(c: f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + c * c);
}

// Cornette-Shanks. c is the cosine between the view ray and the direction to the sun, so forward scattering
// peaks when looking at the sun.
fn mie_phase(c: f32) -> f32 {
  let g = MIE_G;
  let k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + c * c) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
}

// Transmittance LUT parameterisation (Bruneton/Hillaire): u = distance to the top, v = horizon-relative radius.
fn trans_uv(r: f32, mu: f32) -> vec2<f32> {
  let hh = sqrt(R_TOP * R_TOP - R_BOT * R_BOT);
  let rho = sqrt(max(0.0, r * r - R_BOT * R_BOT));
  let disc = r * r * (mu * mu - 1.0) + R_TOP * R_TOP;
  let d = max(0.0, -r * mu + sqrt(max(0.0, disc)));
  let d_min = R_TOP - r;
  let d_max = rho + hh;
  return vec2<f32>((d - d_min) / (d_max - d_min), rho / hh);
}
