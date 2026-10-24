/** Concatenate WGSL chunks into one module source. */
export function joinWgsl(...parts: string[]): string {
  return parts.join('\n');
}

/**
 * Compile WGSL and throw with line-numbered messages if it fails. Line numbers refer to the concatenated
 * source, which is printed alongside so errors in shared chunks are easy to find.
 */
export async function createModule(device: GPUDevice, label: string, ...parts: string[]): Promise<GPUShaderModule> {
  const code = joinWgsl(...parts);
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) {
    const lines = code.split('\n');
    const text = errors
      .map((m) => `  ${label}:${m.lineNum}:${m.linePos} ${m.message}\n      > ${(lines[m.lineNum - 1] ?? '').trim()}`)
      .join('\n');
    throw new Error(`WGSL compile failed\n${text}`);
  }
  return module;
}

export function makeBuffer(device: GPUDevice, label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
  return device.createBuffer({ label, size, usage });
}

export function makeBufferWith(
  device: GPUDevice,
  label: string,
  data: Float32Array | Uint32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({ label, size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  return buffer;
}
