import { Rng } from '../rng';
import { cascadeBands, compassToWaveDir, dominantModes, generateH0, heightFromModes, type SpectrumParams, type WaveMode } from './spectrum';

/**
 * The long waves a ship floats on, as the game and the headless harnesses both have them: the dominant modes of the sea's largest
 * cascade, from the same spectrum, the same seed and the same grid as the GPU field, so that a fight measured without a renderer
 * rolls and pitches the guns exactly as the game does.
 */
export interface WaveSpec {
  /** Wind speed at 10 m (m/s). */
  windSpeed: number;
  /** Compass heading the waves travel toward. */
  waveHeadingDeg: number;
  fetchKm: number;
  seed: number;
}

/** The sea the game opens on (the Sea & Sky panel's defaults). */
export const DEFAULT_WAVE_SPEC: WaveSpec = { windSpeed: 11, waveHeadingDeg: 70, fetchKm: 120, seed: 7 };

/** The ocean's time loops every this many seconds (its wave frequencies are quantised to the loop). */
export const OCEAN_LOOP_SECONDS = 300;
/** The three cascades' tile lengths, metres; the first carries the waves that move a ship. */
export const CASCADE_LENGTHS: readonly number[] = [600, 121, 25.3];
/** The grid the game's sea is computed on at full quality; the buoyancy modes are taken from it. */
export const BUOYANCY_GRID = 256;
const W0 = (2 * Math.PI) / OCEAN_LOOP_SECONDS;
/**
 * Only waves long enough to move a ship (wavelength over this) matter for buoyancy, and only the strongest of them: the 128 strongest
 * carry 84% of the sea's energy on the default sea (256 carry 95%), and every ship, in the game and in the harnesses, fits its hull to
 * them sixty times a second.
 */
const MIN_WAVELENGTH_M = 25;
const MODE_COUNT = 128;

export function spectrumParams(spec: WaveSpec): SpectrumParams {
  return { windSpeed: spec.windSpeed, waveDirRad: compassToWaveDir(spec.waveHeadingDeg), fetchM: spec.fetchKm * 1000, gamma: 3.3 };
}

/** The seed of cascade `c`'s spectrum, as the GPU field draws it. */
export function cascadeSeed(seed: number, c: number): number {
  return seed * 7919 + c * 104729 + 1;
}

/** The buoyancy modes of a sea: the strongest long waves of the first cascade's spectrum `h0` (as `generateH0` gives it). */
export function buoyancyModesOf(h0: Float32Array, n: number, lengths: readonly number[]): WaveMode[] {
  const band = cascadeBands(n, lengths)[0]!;
  return dominantModes(h0, n, band, W0, 6000)
    .filter((m) => Math.hypot(m.kx, m.kz) < (2 * Math.PI) / MIN_WAVELENGTH_M)
    .slice(0, MODE_COUNT);
}

/** The buoyancy modes of a sea from its spec alone (no GPU): what the game's sea would float a ship on. */
export function buoyancyModes(spec: WaveSpec, n = BUOYANCY_GRID, lengths: readonly number[] = CASCADE_LENGTHS): WaveMode[] {
  const band = cascadeBands(n, lengths)[0]!;
  const h0 = generateH0(n, band, spectrumParams(spec), new Rng(cascadeSeed(spec.seed, 0)));
  return buoyancyModesOf(h0, n, lengths);
}

/** Water height under a point at a time, from a fixed set of modes. */
export class WaveField {
  private static readonly cache = new Map<string, WaveField>();

  constructor(readonly modes: readonly WaveMode[]) {}

  /** The field of a sea spec, kept once made: the spectrum is 65 thousand numbers and the harnesses build many fights. */
  static fromSpec(spec: WaveSpec = DEFAULT_WAVE_SPEC): WaveField {
    const key = `${spec.windSpeed}|${spec.waveHeadingDeg}|${spec.fetchKm}|${spec.seed}`;
    let field = WaveField.cache.get(key);
    if (!field) {
      field = new WaveField(buoyancyModes(spec));
      WaveField.cache.set(key, field);
    }
    return field;
  }

  /** Flat calm: no waves at all (the harnesses' old water). */
  static flat(): WaveField {
    return new WaveField([]);
  }

  heightAt(x: number, z: number, t: number): number {
    return heightFromModes(this.modes, x, z, t);
  }
}

/** A source of buoyancy modes that may change (the game's sea is re-seeded from the Sea & Sky panel). */
export interface WaveModes {
  readonly modes: readonly WaveMode[];
}

/**
 * The plane fitted to the water under a hull, mode by mode. `fitWaterPlane` samples the water on an 8 x 6 mid-point grid under the
 * hull and fits h = h0 + a x + b z by least squares; because that grid is symmetric about the hull's centre, each travelling wave's
 * part in the fit is its cosine at the centre times a kernel that depends only on the wave vector seen from the hull (its heading),
 * so the whole fit is one cosine and one sine per mode instead of forty-eight. The kernels are kept between calls and remade when
 * the heading has moved, which it does slowly.
 */
export class HullPlaneFit {
  private k0 = new Float64Array(0);
  private kx = new Float64Array(0);
  private kz = new Float64Array(0);
  private forModes: readonly WaveMode[] | null = null;
  private forHeadingDeg = Number.NaN;
  private readonly sx: number;
  private readonly sz: number;
  /** Σ x² and Σ z² over the grid, the least-squares denominators (as fitWaterPlane has them). */
  private readonly sxx: number;
  private readonly szz: number;

  constructor(
    readonly length: number,
    readonly beam: number,
  ) {
    this.sx = (0.9 * length) / ROWS;
    this.sz = beam / COLS;
    this.sxx = COLS * 2 * this.sx * this.sx * SUM_SQ_X;
    this.szz = ROWS * 2 * this.sz * this.sz * SUM_SQ_Z;
  }

  /** The water plane under the hull at (px, pz) on `headingDeg` at time `t` (same values as fitWaterPlane with these modes). */
  planeAt(waves: WaveModes, px: number, pz: number, headingDeg: number, t: number): { height: number; slopeX: number; slopeZ: number } {
    const modes = waves.modes;
    if (modes !== this.forModes || Math.abs(headingDeg - this.forHeadingDeg) > KERNEL_HEADING_DEG) this.remake(modes, headingDeg);
    let sum0 = 0;
    let sumX = 0;
    let sumZ = 0;
    for (let i = 0; i < modes.length; i++) {
      const m = modes[i]!;
      const theta = m.kx * px + m.kz * pz - m.omega * t + m.phase;
      const c = m.amplitude * Math.cos(theta);
      const s = m.amplitude * Math.sin(theta);
      sum0 += c * this.k0[i]!;
      sumX -= s * this.kx[i]!;
      sumZ -= s * this.kz[i]!;
    }
    return { height: sum0 / (ROWS * COLS), slopeX: sumX / this.sxx, slopeZ: sumZ / this.szz };
  }

  private remake(modes: readonly WaveMode[], headingDeg: number): void {
    if (this.k0.length !== modes.length) {
      this.k0 = new Float64Array(modes.length);
      this.kx = new Float64Array(modes.length);
      this.kz = new Float64Array(modes.length);
    }
    const h = (headingDeg * Math.PI) / 180;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const rx = Math.cos(h);
    const rz = Math.sin(h);
    for (let i = 0; i < modes.length; i++) {
      const m = modes[i]!;
      // The wave vector along and across the hull, as phase advance per grid step.
      const [gx, hx] = gridSums(( m.kx * fx + m.kz * fz) * this.sx, ROWS / 2, SUM_SQ_X);
      const [gz, hz] = gridSums((m.kx * rx + m.kz * rz) * this.sz, COLS / 2, SUM_SQ_Z);
      const cx = 2 * gx;
      const cz = 2 * gz;
      this.k0[i] = cx * cz;
      this.kx[i] = 2 * this.sx * hx * cz;
      this.kz[i] = cx * 2 * this.sz * hz;
    }
    this.forModes = modes;
    this.forHeadingDeg = headingDeg;
  }
}

const ROWS = 8;
const COLS = 6;
/** Σ (m + ½)² for m below half the rows (4) and half the columns (3). */
const SUM_SQ_X = 21;
const SUM_SQ_Z = 8.75;
/** The kernels are remade when the heading has moved this far. */
const KERNEL_HEADING_DEG = 0.2;

/**
 * For the half-grid of N points at (m + ½) u, m = 0..N-1: Σ cos((m + ½) u) = sin(N u) / (2 sin(u / 2)) and
 * Σ (m + ½) sin((m + ½) u), its negative derivative, in closed form; the series near u = 0 and the direct sum near a multiple of 2π.
 */
function gridSums(u: number, n: number, sumSq: number): [number, number] {
  const au = Math.abs(u);
  if (au < 1e-3) return [n - (u * u * sumSq) / 2, u * sumSq];
  const half = u / 2;
  const s = Math.sin(half);
  if (Math.abs(s) < 1e-6) {
    let g = 0;
    let hh = 0;
    for (let m = 0; m < n; m++) {
      const p = (m + 0.5) * u;
      g += Math.cos(p);
      hh += (m + 0.5) * Math.sin(p);
    }
    return [g, hh];
  }
  const c = Math.cos(half);
  const sn = Math.sin(n * u);
  const cn = Math.cos(n * u);
  return [sn / (2 * s), (sn * c - 2 * n * cn * s) / (4 * s * s)];
}
