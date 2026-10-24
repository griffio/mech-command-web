// Textures from pictures, with their mip chains made on the CPU (WebGPU has no mipmap generation of its own).

/** Upload a picture with every mip level made by halving it on a canvas. */
export function uploadWithMips(device: GPUDevice, label: string, image: ImageBitmap | OffscreenCanvas, format: GPUTextureFormat): GPUTexture {
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
