// MC2's models on the GPU: buildings, trees, mechs and vehicles (see models.wgsl). One vertex buffer per model, one
// texture per material (repainted per team for units), and one storage buffer holding the node matrices of every
// instance. Each frame the instances in view (and, separately, those that can cast into the shadow map) are listed,
// and every model draws its visible instances with one instanced draw per material.
import { paintKey, paintPixels, type PaintScheme } from '../../../paint.ts';
import type { Camera } from '../camera';
import { createModule } from '../gpu-util';
import type { ModelData } from '../../models/glb';
import { AFFINE_FLOATS, restPose } from '../../models/pose';
import common from '../shaders/common.wgsl?raw';
import env from '../shaders/env.wgsl?raw';
import haze from '../shaders/haze.wgsl?raw';
import scene from '../shaders/scene.wgsl?raw';
import shadowChunk from '../shaders/shadow.wgsl?raw';
import skyMap from '../shaders/sky_map.wgsl?raw';
import { SHADOW_FORMAT, type ShadowMap } from '../ships/shadow-map';
import { uploadWithMips } from '../texture-upload';
import modelsWgsl from './models.wgsl?raw';
import shadowWgsl from './models_shadow.wgsl?raw';

export interface ModelRendererOptions {
  device: GPUDevice;
  sceneBuffer: GPUBuffer;
  skyView: GPUTexture;
  envSampler: GPUSampler;
  shadow: ShadowMap;
  colorFormat: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  sampleCount: number;
}

export interface ModelOptions {
  /** World size of one model unit (MC2 models are in MC2 units: 1 / 5.01 m). */
  scale: number;
  /** Team colours for the paint masks in the textures (mechs and vehicles). */
  paint?: PaintScheme;
  /** Shown at a constant brightness, not lit by the sun (markers). */
  unlit?: boolean;
  /** Brightness, matched to the land's pre-lit colour map. */
  gain: number;
}

/** pos (3), normal (3), uv (2), node (u32). */
const VERTEX_BYTES = 36;
const MATERIAL_BYTES = 32;
const INITIAL_MATRICES = 4096;
/**
 * Models drawn only with cut-out materials (trees, fences, nets) cast shadows only while the camera is within this
 * many times their radius: further off their shadows are a few pixels, and each one drawn costs the shadow pass a
 * discarding shader.
 */
const FOLIAGE_CASTER_RANGE = 45;

interface Geometry {
  vertices: GPUBuffer;
  indices: GPUBuffer;
  /** Index range per material. */
  ranges: { first: number; count: number }[];
  nodeCount: number;
  /** Bounding radius about the model origin, model units. */
  radius: number;
}

interface GpuMaterial {
  first: number;
  count: number;
  cutout: boolean;
  doubleSided: boolean;
  group: GPUBindGroup;
  /** The shadow pass's cut-out material (null for opaque ones, which need no fragment shader there). */
  shadowGroup: GPUBindGroup | null;
}

export class GpuModel {
  readonly instances: ModelInstance[] = [];
  /** This frame's slots in the bases buffer: the instances in view, then those casting into the shadow map. */
  mainFirst = 0;
  mainCount = 0;
  shadowFirst = 0;
  shadowCount = 0;

  constructor(
    readonly name: string,
    readonly geometry: Geometry,
    readonly materials: GpuMaterial[],
    /** World size of a model unit. */
    readonly scale: number,
  ) {}

  get nodeCount(): number {
    return this.geometry.nodeCount;
  }

  /** Drawn only with cut-out materials: trees, fences, nets. */
  get foliage(): boolean {
    return this.materials.length > 0 && this.materials.every((m) => m.cutout);
  }

  /** Bounding radius in world metres. */
  get radius(): number {
    return this.geometry.radius * this.scale;
  }
}

/** One placed copy of a model: its node matrices (world, metres) are written by whoever owns it. */
export class ModelInstance {
  visible = true;
  /** World centre and radius for culling (metres); the owner keeps them current. */
  readonly center: [number, number, number] = [0, 0, 0];
  radius: number;

  constructor(
    readonly model: GpuModel,
    /** Index of the first matrix in the renderer's buffer. */
    readonly base: number,
    /** The instance's node matrices, AFFINE_FLOATS each. */
    readonly matrices: Float32Array,
  ) {
    this.radius = model.radius;
  }
}

export class ModelRenderer {
  readonly models: GpuModel[] = [];
  /** Instances drawn and casting shadows last frame (for the debug line). */
  drawnInstances = 0;
  shadowInstances = 0;

  private matrixData = new Float32Array(INITIAL_MATRICES * AFFINE_FLOATS);
  private matrixCount = 0;
  private matrixBuffer: GPUBuffer;
  private baseData = new Uint32Array(1024);
  private baseBuffer: GPUBuffer;
  private matrixGroup!: GPUBindGroup;
  private readonly geometries = new Map<ModelData, Geometry>();
  private readonly cache = new Map<string, Promise<GpuModel>>();
  private readonly white: GPUTexture;

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: { opaque: GPURenderPipeline; opaqueTwoSided: GPURenderPipeline; cutout: GPURenderPipeline },
    private readonly shadowPipelines: { opaque: GPURenderPipeline; cutout: GPURenderPipeline },
    private readonly layouts: { matrix: GPUBindGroupLayout; material: GPUBindGroupLayout; shadowMaterial: GPUBindGroupLayout },
    private readonly sceneGroup: GPUBindGroup,
    private readonly envGroup: GPUBindGroup,
    private readonly shadow: ShadowMap,
    private readonly sampler: GPUSampler,
  ) {
    this.matrixBuffer = this.makeMatrixBuffer();
    this.baseBuffer = this.makeBaseBuffer();
    this.rebuildGroups();
    this.white = device.createTexture({ label: 'model-white', size: [1, 1], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
  }

  static async create(opts: ModelRendererOptions): Promise<ModelRenderer> {
    const { device } = opts;
    const module = await createModule(device, 'models', common, scene, skyMap, env, haze, shadowChunk, modelsWgsl);
    const shadowModule = await createModule(device, 'models-shadow', common, scene, shadowWgsl);
    const vertex = (m: GPUShaderModule, withNormals: boolean): GPUVertexState => ({
      module: m,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: VERTEX_BYTES,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            ...(withNormals ? [{ shaderLocation: 1, offset: 12, format: 'float32x3' } as GPUVertexAttribute] : []),
            { shaderLocation: 2, offset: 24, format: 'float32x2' },
            { shaderLocation: 3, offset: 32, format: 'uint32' },
          ],
        },
      ],
    });
    // Explicit layouts: pipelines made with layout 'auto' each get their own, incompatible bind group layouts, and the
    // three main pipelines (solid, two-sided, cut-out) must share the scene, sky and matrix groups.
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const F = GPUShaderStage.FRAGMENT;
    const V = GPUShaderStage.VERTEX;
    const sceneLayout = device.createBindGroupLayout({ label: 'models-scene', entries: [{ binding: 0, visibility: VF, buffer: {} }] });
    const envLayout = device.createBindGroupLayout({
      label: 'models-env',
      entries: [
        { binding: 0, visibility: F, texture: {} },
        { binding: 2, visibility: F, sampler: {} },
      ],
    });
    const matrixLayout = device.createBindGroupLayout({
      label: 'models-matrices',
      entries: [
        { binding: 0, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
      ],
    });
    const materialEntries: GPUBindGroupLayoutEntry[] = [
      { binding: 2, visibility: F, buffer: {} },
      { binding: 3, visibility: F, texture: {} },
      { binding: 4, visibility: F, sampler: {} },
    ];
    const materialLayout = device.createBindGroupLayout({
      label: 'models-material',
      entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: F, sampler: { type: 'comparison' } },
        ...materialEntries,
      ],
    });
    const shadowMaterialLayout = device.createBindGroupLayout({ label: 'models-shadow-material', entries: materialEntries });
    const mainLayout = device.createPipelineLayout({ bindGroupLayouts: [sceneLayout, envLayout, matrixLayout, materialLayout] });

    const main = (label: string, entryPoint: string, cullMode: GPUCullMode) =>
      device.createRenderPipeline({
        label,
        layout: mainLayout,
        vertex: vertex(module, true),
        fragment: { module, entryPoint, targets: [{ format: opts.colorFormat }] },
        primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
        depthStencil: { format: opts.depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: opts.sampleCount },
      });
    const pipelines = { opaque: main('models', 'fs', 'back'), opaqueTwoSided: main('models-two-sided', 'fs', 'none'), cutout: main('models-cutout', 'fs_cutout', 'none') };
    const shadowPipeline = (label: string, cutout: boolean) =>
      device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: cutout ? [sceneLayout, matrixLayout, shadowMaterialLayout] : [sceneLayout, matrixLayout] }),
        vertex: vertex(shadowModule, false),
        fragment: cutout ? { module: shadowModule, entryPoint: 'fs_cutout', targets: [] } : undefined,
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      });
    const shadowPipelines = { opaque: shadowPipeline('models-shadow', false), cutout: shadowPipeline('models-shadow-cutout', true) };

    const sceneGroup = device.createBindGroup({ layout: sceneLayout, entries: [{ binding: 0, resource: { buffer: opts.sceneBuffer } }] });
    const envGroup = device.createBindGroup({
      layout: envLayout,
      entries: [
        { binding: 0, resource: opts.skyView.createView() },
        { binding: 2, resource: opts.envSampler },
      ],
    });
    const layouts = { matrix: matrixLayout, material: materialLayout, shadowMaterial: shadowMaterialLayout };
    const sampler = device.createSampler({
      label: 'model-texture',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 8,
    });
    return new ModelRenderer(device, pipelines, shadowPipelines, layouts, sceneGroup, envGroup, opts.shadow, sampler);
  }

  /** The GPU copy of a model with these options (made once and shared). */
  addModel(data: ModelData, opts: ModelOptions): Promise<GpuModel> {
    const key = `${data.name}|${opts.scale}|${opts.paint ? paintKey(opts.paint) : ''}|${opts.unlit ? 1 : 0}|${opts.gain}`;
    let entry = this.cache.get(key);
    if (!entry) {
      entry = this.build(data, opts);
      this.cache.set(key, entry);
    }
    return entry;
  }

  addInstance(model: GpuModel): ModelInstance {
    const base = this.matrixCount;
    this.matrixCount += model.nodeCount;
    if (this.matrixCount * AFFINE_FLOATS > this.matrixData.length) {
      const grown = new Float32Array(Math.max(this.matrixData.length * 2, this.matrixCount * AFFINE_FLOATS));
      grown.set(this.matrixData);
      this.matrixData = grown;
      // Every instance's view must move to the new array.
      for (const m of this.models) for (const inst of m.instances) (inst as { matrices: Float32Array }).matrices = this.view(inst.base, m.nodeCount);
      this.matrixBuffer.destroy();
      this.matrixBuffer = this.makeMatrixBuffer();
      this.rebuildGroups();
    }
    const inst = new ModelInstance(model, base, this.view(base, model.nodeCount));
    model.instances.push(inst);
    return inst;
  }

  /** Take an instance off the map (its matrix slots are not reused). */
  removeInstance(inst: ModelInstance): void {
    const list = inst.model.instances;
    const i = list.indexOf(inst);
    if (i >= 0) list.splice(i, 1);
  }

  /**
   * List the instances in the camera's view, and those within `shadowReach` metres of the shadow map's focus (they may
   * cast into it), then upload the matrices and lists.
   */
  update(camera: Camera, shadowFocus: { x: number; z: number; reach: number } | null, drawUnits = true, drawProps = true): void {
    const [cx, cy, cz] = camera.position;
    const tanY = camera.tanHalfFovY;
    const tanX = tanY * camera.aspect;
    const f = camera.forward;
    const r = camera.right;
    const u = camera.up;
    const secX = Math.sqrt(1 + tanX * tanX);
    const secY = Math.sqrt(1 + tanY * tanY);
    const total = this.models.reduce((n, m) => n + m.instances.length, 0);
    if (total * 2 > this.baseData.length) {
      this.baseData = new Uint32Array(Math.max(total * 2, this.baseData.length * 2));
      this.baseBuffer.destroy();
      this.baseBuffer = this.makeBaseBuffer();
      this.rebuildGroups();
    }
    let slot = 0;
    this.drawnInstances = 0;
    this.shadowInstances = 0;
    for (const model of this.models) {
      model.mainFirst = slot;
      const show = model.nodeCount > 1 ? drawUnits : drawProps;
      if (show) {
        for (const inst of model.instances) {
          if (!inst.visible) continue;
          const dx = inst.center[0] - cx;
          const dy = inst.center[1] - cy;
          const dz = inst.center[2] - cz;
          const depth = dx * f[0] + dy * f[1] + dz * f[2];
          if (depth < -inst.radius) continue;
          if (Math.abs(dx * r[0] + dy * r[1] + dz * r[2]) > depth * tanX + inst.radius * secX) continue;
          if (Math.abs(dx * u[0] + dy * u[1] + dz * u[2]) > depth * tanY + inst.radius * secY) continue;
          this.baseData[slot++] = inst.base;
        }
      }
      model.mainCount = slot - model.mainFirst;
      this.drawnInstances += model.mainCount;
    }
    for (const model of this.models) {
      model.shadowFirst = slot;
      const show = model.nodeCount > 1 ? drawUnits : drawProps;
      if (shadowFocus && show) {
        const foliage = model.foliage;
        for (const inst of model.instances) {
          if (!inst.visible) continue;
          const reach = shadowFocus.reach + inst.radius;
          if (Math.abs(inst.center[0] - shadowFocus.x) > reach || Math.abs(inst.center[2] - shadowFocus.z) > reach) continue;
          if (foliage) {
            const range = inst.radius * FOLIAGE_CASTER_RANGE;
            const dx = inst.center[0] - cx;
            const dy = inst.center[1] - cy;
            const dz = inst.center[2] - cz;
            if (dx * dx + dy * dy + dz * dz > range * range) continue;
          }
          this.baseData[slot++] = inst.base;
        }
      }
      model.shadowCount = slot - model.shadowFirst;
      this.shadowInstances += model.shadowCount;
    }
    if (slot > 0) this.device.queue.writeBuffer(this.baseBuffer, 0, this.baseData, 0, slot);
    if (this.matrixCount > 0) this.device.queue.writeBuffer(this.matrixBuffer, 0, this.matrixData, 0, this.matrixCount * AFFINE_FLOATS);
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setBindGroup(0, this.sceneGroup);
    pass.setBindGroup(1, this.envGroup);
    pass.setBindGroup(2, this.matrixGroup);
    // Solid materials first, then the cut-out ones, so the hidden-surface removal sees the solids before any discard.
    for (const cutoutPass of [false, true]) {
      for (const model of this.models) {
        if (model.mainCount === 0) continue;
        pass.setVertexBuffer(0, model.geometry.vertices);
        pass.setIndexBuffer(model.geometry.indices, 'uint32');
        for (const mat of model.materials) {
          if (mat.cutout !== cutoutPass) continue;
          pass.setPipeline(mat.cutout ? this.pipelines.cutout : mat.doubleSided ? this.pipelines.opaqueTwoSided : this.pipelines.opaque);
          pass.setBindGroup(3, mat.group);
          pass.drawIndexed(mat.count, model.mainCount, mat.first, 0, model.mainFirst);
        }
      }
    }
  }

  drawShadow(pass: GPURenderPassEncoder): void {
    for (const cutoutPass of [false, true]) {
      pass.setPipeline(cutoutPass ? this.shadowPipelines.cutout : this.shadowPipelines.opaque);
      pass.setBindGroup(0, this.sceneGroup);
      pass.setBindGroup(1, this.matrixGroup);
      for (const model of this.models) {
        if (model.shadowCount === 0) continue;
        pass.setVertexBuffer(0, model.geometry.vertices);
        pass.setIndexBuffer(model.geometry.indices, 'uint32');
        for (const mat of model.materials) {
          if (mat.cutout !== cutoutPass) continue;
          if (mat.shadowGroup) pass.setBindGroup(2, mat.shadowGroup);
          pass.drawIndexed(mat.count, model.shadowCount, mat.first, 0, model.shadowFirst);
        }
      }
    }
  }

  private async build(data: ModelData, opts: ModelOptions): Promise<GpuModel> {
    const geometry = this.geometry(data);
    const { device } = this;
    const materials = await Promise.all(
      data.materials.map(async (m, i): Promise<GpuMaterial> => {
        const texture = m.image ? await this.texture(m.image, `${data.name}:${m.name}`, opts.paint) : this.white;
        const params = device.createBuffer({ label: `${data.name}:${m.name}`, size: MATERIAL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(params, 0, new Float32Array([...m.color, m.alphaCutoff ?? 0, opts.unlit ? 1 : 0, opts.gain, 0]));
        const cutout = m.alphaCutoff !== null;
        const materialEntries: GPUBindGroupEntry[] = [
          { binding: 2, resource: { buffer: params } },
          { binding: 3, resource: texture.createView() },
          { binding: 4, resource: this.sampler },
        ];
        return {
          ...geometry.ranges[i]!,
          cutout,
          doubleSided: m.doubleSided,
          group: device.createBindGroup({
            layout: this.layouts.material,
            entries: [{ binding: 0, resource: this.shadow.view }, { binding: 1, resource: this.shadow.sampler }, ...materialEntries],
          }),
          shadowGroup: cutout ? device.createBindGroup({ layout: this.layouts.shadowMaterial, entries: materialEntries }) : null,
        };
      }),
    );
    const model = new GpuModel(data.name, geometry, materials.filter((m) => m.count > 0), opts.scale);
    this.models.push(model);
    return model;
  }

  /** One vertex and index buffer per model, the primitives grouped by material. */
  private geometry(data: ModelData): Geometry {
    const existing = this.geometries.get(data);
    if (existing) return existing;
    const vertexCount = data.primitives.reduce((n, p) => n + p.positions.length / 3, 0);
    const bytes = new ArrayBuffer(Math.max(vertexCount, 1) * VERTEX_BYTES);
    const f32 = new Float32Array(bytes);
    const u32 = new Uint32Array(bytes);
    const indices: number[] = [];
    const ranges = data.materials.map(() => ({ first: 0, count: 0 }));
    let radius = 0;
    let v = 0;
    const byMaterial = data.materials.map((_, i) => data.primitives.filter((p) => p.material === i));
    byMaterial.forEach((prims, mi) => {
      ranges[mi]!.first = indices.length;
      for (const p of prims) {
        const n = p.positions.length / 3;
        for (let k = 0; k < n; k++) {
          const o = (v + k) * 9;
          f32.set(p.positions.subarray(k * 3, k * 3 + 3), o);
          f32.set(p.normals.subarray(k * 3, k * 3 + 3), o + 3);
          f32.set(p.uvs.subarray(k * 2, k * 2 + 2), o + 6);
          u32[o + 8] = p.node;
        }
        for (const idx of p.indices) indices.push(idx + v);
        v += n;
      }
      ranges[mi]!.count = indices.length - ranges[mi]!.first;
    });
    // Bounding radius of the rest pose about the model origin.
    const pose = restPose(data);
    for (const p of data.primitives) {
      const m = pose.subarray(p.node * AFFINE_FLOATS, p.node * AFFINE_FLOATS + AFFINE_FLOATS);
      for (let k = 0; k < p.positions.length; k += 3) {
        const x = p.positions[k]!;
        const y = p.positions[k + 1]!;
        const z = p.positions[k + 2]!;
        radius = Math.max(
          radius,
          Math.hypot(m[0]! * x + m[1]! * y + m[2]! * z + m[3]!, m[4]! * x + m[5]! * y + m[6]! * z + m[7]!, m[8]! * x + m[9]! * y + m[10]! * z + m[11]!),
        );
      }
    }
    const vertices = this.device.createBuffer({ label: `${data.name}-vertices`, size: bytes.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(vertices, 0, bytes);
    const indexData = new Uint32Array(Math.max(indices.length, 1));
    indexData.set(indices);
    const indexBuffer = this.device.createBuffer({ label: `${data.name}-indices`, size: indexData.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(indexBuffer, 0, indexData);
    // Animation swings parts beyond the rest pose: a margin keeps a striding mech from being culled at the frame's edge.
    const geometry: Geometry = { vertices, indices: indexBuffer, ranges, nodeCount: data.nodes.length, radius: radius * (data.nodes.length > 1 ? 1.3 : 1.02) };
    this.geometries.set(data, geometry);
    return geometry;
  }

  private async texture(image: Blob, label: string, paint?: PaintScheme): Promise<GPUTexture> {
    const bitmap = await createImageBitmap(image, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    if (!paint) return uploadWithMips(this.device, label, bitmap, 'rgba8unorm-srgb');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bitmap, 0, 0);
    const pixels = g.getImageData(0, 0, bitmap.width, bitmap.height);
    paintPixels(pixels.data, paint);
    g.putImageData(pixels, 0, 0);
    return uploadWithMips(this.device, label, canvas, 'rgba8unorm-srgb');
  }

  private view(base: number, count: number): Float32Array {
    return this.matrixData.subarray(base * AFFINE_FLOATS, (base + count) * AFFINE_FLOATS);
  }

  private makeMatrixBuffer(): GPUBuffer {
    return this.device.createBuffer({ label: 'model-matrices', size: this.matrixData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private makeBaseBuffer(): GPUBuffer {
    return this.device.createBuffer({ label: 'model-bases', size: this.baseData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private rebuildGroups(): void {
    this.matrixGroup = this.device.createBindGroup({
      layout: this.layouts.matrix,
      entries: [
        { binding: 0, resource: { buffer: this.matrixBuffer } },
        { binding: 1, resource: { buffer: this.baseBuffer } },
      ],
    });
  }
}
