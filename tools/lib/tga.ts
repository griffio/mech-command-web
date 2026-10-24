// Minimal Targa decoder covering the variants found in the MC2 data:
// uncompressed / RLE, true-colour (15/16/24/32 bit), grey and colour-mapped.

export interface Rgba {
  width: number;
  height: number;
  /** RGBA8, rows top to bottom. */
  data: Uint8Array;
  /** True when some pixel is not fully opaque. */
  hasAlpha: boolean;
}

export function decodeTga(buf: Buffer): Rgba {
  const idLength = buf[0];
  const colorMapType = buf[1];
  const imageType = buf[2];
  const cmapStart = buf.readUInt16LE(3);
  const cmapLength = buf.readUInt16LE(5);
  const cmapDepth = buf[7];
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const bpp = buf[16];
  const descriptor = buf[17];
  const alphaBits = descriptor & 0x0f;
  const topDown = (descriptor & 0x20) !== 0;
  const rle = imageType >= 9;
  const baseType = rle ? imageType - 8 : imageType;
  if (![1, 2, 3].includes(baseType)) throw new Error(`unsupported TGA image type ${imageType}`);

  let pos = 18 + idLength;
  let palette: Uint8Array | null = null;
  if (colorMapType === 1) {
    const entryBytes = Math.ceil(cmapDepth / 8);
    palette = new Uint8Array((cmapStart + cmapLength) * 4);
    for (let i = 0; i < cmapLength; i++) {
      readPixel(buf, pos + i * entryBytes, cmapDepth, palette, (cmapStart + i) * 4);
    }
    pos += cmapLength * entryBytes;
  }

  const pixelBytes = Math.ceil(bpp / 8);
  const count = width * height;
  const linear = new Uint8Array(count * 4);
  const writePixel = (src: number, dst: number) => {
    if (baseType === 1) {
      const index = pixelBytes === 1 ? buf[src] : buf.readUInt16LE(src);
      linear.set(palette!.subarray(index * 4, index * 4 + 4), dst);
    } else if (baseType === 3) {
      linear[dst] = linear[dst + 1] = linear[dst + 2] = buf[src];
      linear[dst + 3] = pixelBytes > 1 ? buf[src + 1] : 255;
    } else {
      readPixel(buf, src, bpp, linear, dst);
    }
  };

  if (!rle) {
    for (let i = 0; i < count; i++) writePixel(pos + i * pixelBytes, i * 4);
  } else {
    let i = 0;
    while (i < count) {
      const header = buf[pos++];
      const run = (header & 0x7f) + 1;
      if (header & 0x80) {
        for (let k = 0; k < run && i < count; k++, i++) writePixel(pos, i * 4);
        pos += pixelBytes;
      } else {
        for (let k = 0; k < run && i < count; k++, i++, pos += pixelBytes) writePixel(pos, i * 4);
      }
    }
  }

  // Many 32-bit files carry an all-zero alpha channel that means "opaque".
  const usesAlpha = bpp === 32 || alphaBits > 0 || (palette !== null && cmapDepth === 32);
  let anyOpaque = false;
  let anyTransparent = false;
  for (let i = 3; i < linear.length; i += 4) {
    if (linear[i] === 255) anyOpaque = true;
    else anyTransparent = true;
  }
  const hasAlpha = usesAlpha && anyTransparent && anyOpaque;
  if (!hasAlpha) for (let i = 3; i < linear.length; i += 4) linear[i] = 255;

  if (topDown) return { width, height, data: linear, hasAlpha };
  const flipped = new Uint8Array(linear.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    flipped.set(linear.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  }
  return { width, height, data: flipped, hasAlpha };
}

function readPixel(buf: Buffer, src: number, bits: number, out: Uint8Array, dst: number) {
  if (bits === 24 || bits === 32) {
    out[dst] = buf[src + 2];
    out[dst + 1] = buf[src + 1];
    out[dst + 2] = buf[src];
    out[dst + 3] = bits === 32 ? buf[src + 3] : 255;
  } else if (bits === 15 || bits === 16) {
    const v = buf.readUInt16LE(src);
    out[dst] = ((v >> 10) & 0x1f) * 255 / 31;
    out[dst + 1] = ((v >> 5) & 0x1f) * 255 / 31;
    out[dst + 2] = (v & 0x1f) * 255 / 31;
    out[dst + 3] = bits === 16 && !(v & 0x8000) ? 0 : 255;
  } else if (bits === 8) {
    out[dst] = out[dst + 1] = out[dst + 2] = buf[src];
    out[dst + 3] = 255;
  } else {
    throw new Error(`unsupported TGA pixel depth ${bits}`);
  }
}
