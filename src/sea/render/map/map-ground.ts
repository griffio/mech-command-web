// GPU resources for the MC2 map's ground (see map.wgsl): heights in metres, the pre-lit colour map with
// mipmaps, the detail texture, and their parameters. The sea reads them to show the sea floor through
// shallow water; the land draws the colour map.

export interface MapGroundOptions {
  /** side x side heights in metres above the sea (negative is the sea floor), row 0 at the north (minimum z). */
  heights: Float32Array;
  side: number;
  /** Metres between height samples. */
  cell: number;
  /** World x and z of height sample (0, 0), metres. */
  x0: number;
  z0: number;
  colormap: ImageBitmap;
  detail: ImageBitmap | null;
  detailTiling: number;
}

export interface MapLook {
  /** How strongly the detail texture modulates the colour map, 0..1. */
  detailStrength: number;
  /** Brightness of the pre-lit colour map. */
  gain: number;
  /** Metres of water that dim the sea floor to 1/e. */
  clarity: number;
}

export const DEFAULT_MAP_LOOK: MapLook = { detailStrength: 0.6, gain: 1.35, clarity: 3.5 };

const PARAM_FLOATS = 12;
const OPEN_DEPTH_M = 40;

export class MapGround {
  readonly params: GPUBuffer;
  readonly heightView: GPUTextureView;
  readonly colorView: GPUTextureView;
  readonly detailView: GPUTextureView;
  readonly sampler: GPUSampler;
  private readonly values = new Float32Array(PARAM_FLOATS);

  private constructor(
    private readonly device: GPUDevice,
    textures: { height: GPUTexture; color: GPUTexture; detail: GPUTexture },
    base: Omit<MapGroundOptions, 'heights' | 'colormap' | 'detail'>,
    look: MapLook,
  ) {
    this.heightView = textures.height.createView();
    this.colorView = textures.color.createView();
    this.detailView = textures.detail.createView();
    this.sampler = device.createSampler({
      label: 'map',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 8,
    });
    this.params = device.createBuffer({ label: 'map-params', size: PARAM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const v = this.values;
    v[0] = base.x0;
    v[1] = base.z0;
    v[2] = 1 / (base.side * base.cell);
    v[3] = base.cell;
    v[4] = base.side;
    v[5] = base.detailTiling;
    v[7] = OPEN_DEPTH_M;
    this.setLook(look);
  }

  static create(device: GPUDevice, opts: MapGroundOptions, look: MapLook = DEFAULT_MAP_LOOK): MapGround {
    const height = device.createTexture({
      label: 'map-height',
      size: [opts.side, opts.side],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: height }, opts.heights, { bytesPerRow: opts.side * 4 }, [opts.side, opts.side]);
    const color = uploadWithMips(device, 'map-color', opts.colormap, 'rgba8unorm-srgb');
    const detail = opts.detail ? uploadWithMips(device, 'map-detail', opts.detail, 'rgba8unorm') : solid(device, 'map-detail', 128);
    const { heights: _h, colormap: _c, detail: _d, ...base } = opts;
    return new MapGround(device, { height, color, detail }, base, look);
  }

  /** A map with no ground at all: open sea everywhere (what the sea draws before a map is set). */
  static empty(device: GPUDevice): MapGround {
    const height = device.createTexture({ label: 'map-height-empty', size: [2, 2], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: height }, new Float32Array(4).fill(-OPEN_DEPTH_M), { bytesPerRow: 8 }, [2, 2]);
    return new MapGround(
      device,
      { height, color: solid(device, 'map-color-empty', 0), detail: solid(device, 'map-detail-empty', 128) },
      { side: 2, cell: 1, x0: 1e7, z0: 1e7, detailTiling: 1 },
      DEFAULT_MAP_LOOK,
    );
  }

  setLook(look: MapLook): void {
    this.values[6] = look.detailStrength;
    this.values[8] = look.gain;
    this.values[9] = look.clarity;
    this.device.queue.writeBuffer(this.params, 0, this.values);
  }

  /**
   * Bind group entries for group 3 from binding 2 (see map.wgsl). Pipelines with layout 'auto' only have the bindings
   * their shader uses, so a shader that never reads the heights (the land's) must leave them out.
   */
  entries(withHeights = true): GPUBindGroupEntry[] {
    return [
      { binding: 2, resource: { buffer: this.params } },
      ...(withHeights ? [{ binding: 3, resource: this.heightView }] : []),
      { binding: 4, resource: this.colorView },
      { binding: 5, resource: this.detailView },
      { binding: 6, resource: this.sampler },
    ];
  }
}

/** Upload a picture with every mip level made by halving it on a canvas. */
function uploadWithMips(device: GPUDevice, label: string, image: ImageBitmap, format: GPUTextureFormat): GPUTexture {
  const size = Math.max(image.width, image.height);
  const mips = Math.floor(Math.log2(size)) + 1;
  const texture = device.createTexture({
    label,
    size: [image.width, image.height],
    format,
    mipLevelCount: mips,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: image }, { texture, mipLevel: 0 }, [image.width, image.height]);
  let previous: ImageBitmap | OffscreenCanvas = image;
  for (let level = 1; level < mips; level++) {
    const w = Math.max(image.width >> level, 1);
    const h = Math.max(image.height >> level, 1);
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(previous, 0, 0, w, h);
    device.queue.copyExternalImageToTexture({ source: canvas }, { texture, mipLevel: level }, [w, h]);
    previous = canvas;
  }
  return texture;
}

/** A 1x1 texture of one grey `value` (128 is the detail texture's neutral). */
function solid(device: GPUDevice, label: string, value: number): GPUTexture {
  const texture = device.createTexture({ label, size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture }, new Uint8Array([value, value, value, 255]), { bytesPerRow: 4 }, [1, 1]);
  return texture;
}
