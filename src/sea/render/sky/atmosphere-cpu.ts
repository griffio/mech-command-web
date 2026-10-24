import { degToRad, type Vec3 } from '../../math/vec3';

/**
 * CPU mirror of the atmosphere model in atmo_lib.wgsl (Hillaire 2020 parameters, units in km).
 * The GPU builds LUTs from it; the CPU only needs sunlight colour at the surface and at cloud height,
 * so no GPU readback is required.
 */
export const R_BOTTOM = 6360;
export const R_TOP = 6460;

const RAYLEIGH_SCATTER: Vec3 = [0.005802, 0.013558, 0.0331];
const MIE_EXTINCTION = 0.00444;
const OZONE_ABSORB: Vec3 = [0.00065, 0.001881, 0.000085];

function extinctionAt(heightKm: number): Vec3 {
  const h = Math.max(heightKm, 0);
  const rayleigh = Math.exp(-h / 8);
  const mie = Math.exp(-h / 1.2);
  const ozone = Math.max(0, 1 - Math.abs(h - 25) / 15);
  return [
    RAYLEIGH_SCATTER[0] * rayleigh + MIE_EXTINCTION * mie + OZONE_ABSORB[0] * ozone,
    RAYLEIGH_SCATTER[1] * rayleigh + MIE_EXTINCTION * mie + OZONE_ABSORB[1] * ozone,
    RAYLEIGH_SCATTER[2] * rayleigh + MIE_EXTINCTION * mie + OZONE_ABSORB[2] * ozone,
  ];
}

/**
 * Transmittance from radius `r` (km from planet centre) along a direction with cosine `mu` to the top of
 * the atmosphere. Zero when the ray runs into the planet.
 */
export function transmittanceToTop(r: number, mu: number): Vec3 {
  const b = r * mu;
  const c = r * r - R_BOTTOM * R_BOTTOM;
  const disc = b * b - c;
  if (disc > 0 && -b - Math.sqrt(disc) > 0) return [0, 0, 0];

  const tMax = -b + Math.sqrt(Math.max(b * b - (r * r - R_TOP * R_TOP), 0));
  const steps = 64;
  const dt = tMax / steps;
  const sinZ = Math.sqrt(Math.max(0, 1 - mu * mu));
  let tau0 = 0;
  let tau1 = 0;
  let tau2 = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const px = sinZ * t;
    const py = r + mu * t;
    const ext = extinctionAt(Math.hypot(px, py) - R_BOTTOM);
    tau0 += ext[0] * dt;
    tau1 += ext[1] * dt;
    tau2 += ext[2] * dt;
  }
  return [Math.exp(-tau0), Math.exp(-tau1), Math.exp(-tau2)];
}

/** Sunlight (unit irradiance outside the atmosphere) reaching `altitudeMetres` for a given sun elevation. */
export function sunlightAt(altitudeMetres: number, sunElevationDeg: number): Vec3 {
  const r = R_BOTTOM + altitudeMetres / 1000 + 0.001;
  return transmittanceToTop(r, Math.sin(degToRad(sunElevationDeg)));
}

/**
 * Scene exposure multiplier by sun elevation. Daylight needs little; twilight is thousands of times dimmer
 * so the eye (and this curve) opens up. Piecewise-linear in stops, tuned by eye against the renders.
 */
const EXPOSURE_STOPS: readonly (readonly [number, number])[] = [
  [-14, 8.5],
  [-9, 7],
  [-5, 4.6],
  [-2, 2.8],
  [0, 1.7],
  [3, 0.9],
  [10, 0.3],
  [30, 0],
  [90, 0],
];

export function exposureStops(sunElevationDeg: number): number {
  const e = Math.min(Math.max(sunElevationDeg, EXPOSURE_STOPS[0]![0]), 90);
  for (let i = 1; i < EXPOSURE_STOPS.length; i++) {
    const [e1, v1] = EXPOSURE_STOPS[i]!;
    const [e0, v0] = EXPOSURE_STOPS[i - 1]!;
    if (e <= e1) return v0 + ((v1 - v0) * (e - e0)) / (e1 - e0);
  }
  return 0;
}
