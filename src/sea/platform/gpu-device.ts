export type QualityTier = 'A' | 'B' | 'C';

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  adapterInfo: GPUAdapterInfo;
  features: ReadonlySet<string>;
  canvasFormat: GPUTextureFormat;
  /** Validation/out-of-memory errors seen so far (also on window.__gpuErrors for e2e checks). */
  errors: string[];
}

export type GpuInitFailure = 'insecure-context' | 'unsupported' | 'no-adapter' | 'device-failed';

export type GpuInitResult =
  | { ok: true; gpu: GpuContext }
  | { ok: false; reason: GpuInitFailure; message: string };

/** Nice-to-haves. Requested only if the adapter offers them; the renderer must not depend on any. */
const OPTIONAL_FEATURES: GPUFeatureName[] = [
  'timestamp-query',
  'shader-f16',
  'float32-filterable',
  'rg11b10ufloat-renderable',
  'indirect-first-instance',
  'texture-compression-astc',
  'texture-compression-bc',
];

declare global {
  interface Window {
    __gpuErrors?: string[];
  }
}

export async function initGpu(onDeviceLost?: (reason: string) => void): Promise<GpuInitResult> {
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: 'insecure-context',
      message: 'WebGPU needs a secure context. Open the page over HTTPS (or localhost).',
    };
  }
  if (!('gpu' in navigator)) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'This browser has no WebGPU. Use Safari 26 / iPadOS 26, or a recent Chrome or Edge.',
    };
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    return { ok: false, reason: 'no-adapter', message: 'No suitable GPU adapter was found.' };
  }

  const requiredFeatures = OPTIONAL_FEATURES.filter((f) => adapter.features.has(f));
  let device: GPUDevice;
  try {
    // Default limits on purpose: the renderer is designed to run inside them on every target.
    device = await adapter.requestDevice({ requiredFeatures });
  } catch (err) {
    return { ok: false, reason: 'device-failed', message: `Could not create a GPU device: ${String(err)}` };
  }

  const errors: string[] = [];
  window.__gpuErrors = errors;
  device.addEventListener('uncapturederror', (e) => {
    const msg = (e as GPUUncapturedErrorEvent).error.message;
    errors.push(msg);
    console.error('[webgpu]', msg);
  });
  void device.lost.then((info) => onDeviceLost?.(`${info.reason}: ${info.message}`));

  return {
    ok: true,
    gpu: {
      adapter,
      device,
      adapterInfo: adapter.info,
      features: new Set<string>(device.features as unknown as Set<string>),
      canvasFormat: navigator.gpu.getPreferredCanvasFormat(),
      errors,
    },
  };
}

/**
 * Provisional tier thresholds on the per-frame ocean-FFT benchmark (milliseconds, pipelined).
 * These are placeholders until the probe has run on real target iPads; then they get replaced with measured values.
 */
export const TIER_A_MAX_FFT_MS = 2.5;
export const TIER_B_MAX_FFT_MS = 5;

export function tierFromFftMs(ms: number): QualityTier {
  if (ms <= TIER_A_MAX_FFT_MS) return 'A';
  if (ms <= TIER_B_MAX_FFT_MS) return 'B';
  return 'C';
}

export function limitsToRecord(limits: GPUSupportedLimits): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key in limits) {
    const value = (limits as unknown as Record<string, unknown>)[key];
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}
