import type { Rng } from '../rng';

/**
 * JONSWAP ocean spectrum on a periodic tile, generated on the CPU and shared by the GPU renderer (initial
 * spectrum buffers) and, later, ship buoyancy (dominant modes). One source of truth keeps ships riding the
 * waves you can see.
 *
 * Conventions (they must match the compute shaders):
 *  - height h(x,t) = sum_k  h~(k,t) e^{+i k.x}, an unnormalised inverse DFT, so no 1/N^2 factor.
 *  - h~(k,t) = h0(k) e^{-i w t} + conj(h0(-k)) e^{+i w t}.  The first term is a wave travelling along +k.
 *  - spectrum index (ix, iz) <-> k = ((ix - n/2) dk, (iz - n/2) dk), x fastest.
 */

export const GRAVITY = 9.81;
const TAU = Math.PI * 2;

export interface SpectrumParams {
  /** Wind speed at 10 m, m/s. */
  windSpeed: number;
  /** Direction the waves travel, radians in the (x, z) plane (atan2(z, x)). */
  waveDirRad: number;
  /** Fetch, metres. */
  fetchM: number;
  /** JONSWAP peak enhancement (3.3 typical). */
  gamma: number;
}

export interface CascadeBand {
  lengthM: number;
  /** Modes with kMin <= |k| < kMax belong to this cascade; bands are disjoint, so energy adds correctly. */
  kMin: number;
  kMax: number;
}

export interface WaveMode {
  kx: number;
  kz: number;
  /** Height amplitude, metres. */
  amplitude: number;
  phase: number;
  /** Quantised angular frequency (loops every 2*pi/w0 seconds). */
  omega: number;
}

/** Waves travel toward a compass heading (0 = north = -z, 90 = east = +x). */
export function compassToWaveDir(headingDeg: number): number {
  const h = (headingDeg * Math.PI) / 180;
  return Math.atan2(-Math.cos(h), Math.sin(h));
}

/** Split the wavenumber range across cascades just below each cascade's Nyquist limit. */
export function cascadeBands(n: number, lengths: readonly number[]): CascadeBand[] {
  const bands: CascadeBand[] = [];
  let kMin = 0;
  lengths.forEach((lengthM, i) => {
    const nyquist = (Math.PI * n) / lengthM;
    const kMax = i === lengths.length - 1 ? 0.95 * nyquist : 0.85 * nyquist;
    bands.push({ lengthM, kMin, kMax });
    kMin = kMax;
  });
  return bands;
}

/** The wind the spectrum is built for: a dead calm would divide by zero and fill the sea with NaN, so it is at least a breath. */
function windOf(p: SpectrumParams): number {
  return Math.max(p.windSpeed, 0.5);
}

export function peakOmega(p: SpectrumParams): number {
  const u = windOf(p);
  const fetchLimited = 22 * Math.cbrt((GRAVITY * GRAVITY) / (u * p.fetchM));
  const fullyDeveloped = (0.855 * GRAVITY) / u;
  return Math.max(fetchLimited, fullyDeveloped);
}

/** JONSWAP S(w), m^2 s / rad. */
export function jonswapOmega(omega: number, p: SpectrumParams): number {
  const wp = peakOmega(p);
  const u = windOf(p);
  const alpha = 0.076 * Math.pow((u * u) / (p.fetchM * GRAVITY), 0.22);
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((omega - wp) ** 2) / (2 * sigma * sigma * wp * wp));
  return (
    alpha * GRAVITY * GRAVITY * omega ** -5 * Math.exp(-1.25 * (wp / omega) ** 4) * Math.pow(p.gamma, r)
  );
}

/** S(k) per unit wavenumber for deep water (w = sqrt(g k)), with mild damping of the shortest ripples. */
export function spectrumK(k: number, p: SpectrumParams): number {
  const omega = Math.sqrt(GRAVITY * k);
  const dOmegaDk = GRAVITY / (2 * omega);
  return jonswapOmega(omega, p) * dOmegaDk * Math.exp(-((k * 0.012) ** 2));
}

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function lgamma(z: number): number {
  const x = z - 1;
  let a = LANCZOS[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (x + i);
  return 0.5 * Math.log(TAU) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Directional spreading cos^{2s}(theta/2), normalised to integrate to 1 over the circle. */
export function spreading(theta: number, s: number): number {
  let t = theta % TAU;
  if (t > Math.PI) t -= TAU;
  if (t < -Math.PI) t += TAU;
  const norm = 2 * Math.sqrt(Math.PI) * Math.exp(lgamma(s + 0.5) - lgamma(s + 1));
  return Math.pow(Math.max(Math.cos(t / 2), 0), 2 * s) / norm;
}

function spreadExponent(k: number, kPeak: number): number {
  return Math.min(Math.max(14 * Math.pow(kPeak / k, 0.8), 2), 24);
}

/** Per-mode 2D energy density times dk^2: E|h~(k,t)|^2 for the mode at wavevector (kx, kz). */
function modeVariance(kx: number, kz: number, dk: number, p: SpectrumParams, kPeak: number): number {
  const k = Math.hypot(kx, kz);
  const theta = Math.atan2(kz, kx) - p.waveDirRad;
  const e2d = (spectrumK(k, p) * spreading(theta, spreadExponent(k, kPeak))) / k;
  return e2d * dk * dk;
}

/**
 * Random initial spectrum h0 for one cascade as interleaved (re, im) pairs, n*n entries.
 * Random numbers are drawn for every index so changing the wind keeps the same underlying noise.
 */
export function generateH0(n: number, band: CascadeBand, p: SpectrumParams, rng: Rng): Float32Array {
  const dk = TAU / band.lengthM;
  const kPeak = peakOmega(p) ** 2 / GRAVITY;
  const h0 = new Float32Array(n * n * 2);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const gr = rng.gaussian();
      const gi = rng.gaussian();
      // Row/column 0 are the unpaired Nyquist modes; leaving them out keeps the field exactly real.
      if (ix === 0 || iz === 0) continue;
      const kx = (ix - n / 2) * dk;
      const kz = (iz - n / 2) * dk;
      const k = Math.hypot(kx, kz);
      if (k < band.kMin || k >= band.kMax || k === 0) continue;
      // h0 = (xi_r + i xi_i)/sqrt2 * a with a^2 = E|h~|^2 / 2  =>  amplitude factor sqrt(variance)/2.
      const amp = Math.sqrt(modeVariance(kx, kz, dk, p, kPeak)) / 2;
      const i = (iz * n + ix) * 2;
      h0[i] = gr * amp;
      h0[i + 1] = gi * amp;
    }
  }
  return h0;
}

/** Pack h0 with conj(h0(-k)) alongside, the layout the evolve shader reads: (h0.re, h0.im, hm.re, hm.im). */
export function packSpectrum(h0: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * n * 4);
  for (let iz = 1; iz < n; iz++) {
    for (let ix = 1; ix < n; ix++) {
      const i = (iz * n + ix) * 2;
      const m = ((n - iz) * n + (n - ix)) * 2;
      const o = (iz * n + ix) * 4;
      out[o] = h0[i]!;
      out[o + 1] = h0[i + 1]!;
      out[o + 2] = h0[m]!;
      out[o + 3] = -h0[m + 1]!;
    }
  }
  return out;
}

/** Expected height variance contributed by a band (analytic sum, no randomness). */
export function expectedVariance(n: number, band: CascadeBand, p: SpectrumParams): number {
  const dk = TAU / band.lengthM;
  const kPeak = peakOmega(p) ** 2 / GRAVITY;
  let sum = 0;
  for (let iz = 1; iz < n; iz++) {
    for (let ix = 1; ix < n; ix++) {
      const kx = (ix - n / 2) * dk;
      const kz = (iz - n / 2) * dk;
      const k = Math.hypot(kx, kz);
      if (k < band.kMin || k >= band.kMax || k === 0) continue;
      sum += modeVariance(kx, kz, dk, p, kPeak);
    }
  }
  return sum;
}

/** Angular frequency snapped to a multiple of w0 so the whole field loops every 2*pi/w0 seconds. */
export function omegaQuantised(k: number, w0: number): number {
  return Math.floor(Math.sqrt(GRAVITY * k) / w0) * w0;
}

/**
 * The `count` strongest travelling waves of a cascade. Summing them reproduces the long-wave part of the
 * GPU field exactly, so ships can sample heights on the CPU without any GPU readback.
 */
export function dominantModes(
  h0: Float32Array,
  n: number,
  band: CascadeBand,
  w0: number,
  count: number,
): WaveMode[] {
  const dk = TAU / band.lengthM;
  const all: WaveMode[] = [];
  for (let iz = 1; iz < n; iz++) {
    for (let ix = 1; ix < n; ix++) {
      const i = (iz * n + ix) * 2;
      const re = h0[i]!;
      const im = h0[i + 1]!;
      const amplitude = 2 * Math.hypot(re, im);
      if (amplitude === 0) continue;
      const kx = (ix - n / 2) * dk;
      const kz = (iz - n / 2) * dk;
      all.push({
        kx,
        kz,
        amplitude,
        phase: Math.atan2(im, re),
        omega: omegaQuantised(Math.hypot(kx, kz), w0),
      });
    }
  }
  all.sort((a, b) => b.amplitude - a.amplitude);
  return all.slice(0, count);
}

/** Height at (x, z) and time t from a set of travelling-wave modes. */
export function heightFromModes(modes: readonly WaveMode[], x: number, z: number, t: number): number {
  let h = 0;
  for (const m of modes) h += m.amplitude * Math.cos(m.kx * x + m.kz * z - m.omega * t + m.phase);
  return h;
}
