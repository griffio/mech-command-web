import type { Terrain } from '../../sim/terrain/terrain';
import type { Camera } from '../camera';
import { createModule } from '../gpu-util';
import common from '../shaders/common.wgsl?raw';
import env from '../shaders/env.wgsl?raw';
import haze from '../shaders/haze.wgsl?raw';
import noiseChunk from '../shaders/noise.wgsl?raw';
import scene from '../shaders/scene.wgsl?raw';
import skyMap from '../shaders/sky_map.wgsl?raw';
import mapWgsl from '../map/map.wgsl?raw';
import type { MapGround } from '../map/map-ground';
import shadowChunk from '../shaders/shadow.wgsl?raw';
import type { ShadowMap } from '../ships/shadow-map';
import terrainWgsl from './terrain.wgsl?raw';
import { buildTerrainMesh, lodForDistance, TERRAIN_FLOATS_PER_VERTEX, type TerrainMesh, type TerrainTile } from './tiles';

export interface TerrainRendererOptions {
  device: GPUDevice;
  /** The sun's shadow map, which the land receives the buildings' and units' shadows from. */
  shadow: ShadowMap;
  sceneBuffer: GPUBuffer;
  skyView: GPUTexture;
  envSampler: GPUSampler;
  noiseView: GPUTextureView;
  noiseSampler: GPUSampler;
  colorFormat: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  sampleCount: number;
}

interface Drawn {
  tile: TerrainTile;
  lod: number;
  slot: number;
}

/**
 * Land: the heightfield as tiles at three levels of detail, drawn after the sea so that the shore is where the two meet.
 * MC2's land wears its pre-lit colour map (see map.wgsl) instead of the dreadnought game's procedural scrub and rock.
 */
export class TerrainRenderer {
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private tileBuffer: GPUBuffer | null = null;
  private tileGroup: GPUBindGroup | null = null;
  private groundGroup: GPUBindGroup | null = null;
  private mesh: TerrainMesh | null = null;
  private tileData = new Float32Array(0);
  private readonly drawn: Drawn[] = [];
  /** Tiles drawn in the last frame and the triangles they hold (for the debug line). */
  tilesDrawn = 0;
  trianglesDrawn = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly sceneGroup: GPUBindGroup,
    private readonly envGroup: GPUBindGroup,
    private readonly shadow: ShadowMap,
  ) {}

  static async create(opts: TerrainRendererOptions): Promise<TerrainRenderer> {
    const { device } = opts;
    const module = await createModule(device, 'terrain', common, scene, skyMap, env, noiseChunk, haze, shadowChunk, mapWgsl, terrainWgsl);
    const pipeline = device.createRenderPipeline({
      label: 'terrain',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: TERRAIN_FLOATS_PER_VERTEX * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: opts.colorFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: opts.depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: opts.sampleCount },
    });
    const sceneGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: opts.sceneBuffer } }],
    });
    const envGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: opts.skyView.createView() },
        { binding: 2, resource: opts.envSampler },
        { binding: 3, resource: opts.noiseView },
        { binding: 4, resource: opts.noiseSampler },
      ],
    });
    return new TerrainRenderer(device, pipeline, sceneGroup, envGroup, opts.shadow);
  }

  /** Build the meshes for a terrain and upload them (or clear them with null). */
  setTerrain(terrain: Terrain | null): void {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.tileBuffer?.destroy();
    this.vertexBuffer = this.indexBuffer = this.tileBuffer = null;
    this.tileGroup = null;
    this.mesh = null;
    this.drawn.length = 0;
    if (!terrain) return;
    const mesh = buildTerrainMesh(terrain);
    this.mesh = mesh;
    const { device } = this;
    this.vertexBuffer = device.createBuffer({ label: 'terrain-vertices', size: mesh.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuffer, 0, mesh.vertices);
    this.indexBuffer = device.createBuffer({ label: 'terrain-indices', size: mesh.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices);
    // Two vec4 per tile: its camera-relative origin and its world origin.
    this.tileData = new Float32Array(mesh.tiles.length * 8);
    this.tileBuffer = device.createBuffer({ label: 'terrain-tiles', size: this.tileData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.tileGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(2),
      entries: [{ binding: 0, resource: { buffer: this.tileBuffer } }],
    });
  }

  /** The colour map and detail texture the land is drawn with (group 3, see map.wgsl). */
  setMap(map: MapGround): void {
    this.groundGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(3),
      entries: [{ binding: 0, resource: this.shadow.view }, { binding: 1, resource: this.shadow.sampler }, ...map.entries(false)],
    });
  }

  get tileCount(): number {
    return this.mesh?.tiles.length ?? 0;
  }

  /** Choose the tiles in view and their detail, and upload where each one is relative to the camera. Call once a frame. */
  update(camera: Camera): void {
    this.drawn.length = 0;
    this.tilesDrawn = 0;
    this.trianglesDrawn = 0;
    const mesh = this.mesh;
    if (!mesh || !this.tileBuffer) return;
    const [cx, cy, cz] = camera.position;
    const tanY = camera.tanHalfFovY;
    const tanX = tanY * camera.aspect;
    const f = camera.forward;
    const r = camera.right;
    const u = camera.up;
    const secX = Math.sqrt(1 + tanX * tanX);
    const secY = Math.sqrt(1 + tanY * tanY);
    let slot = 0;
    for (const tile of mesh.tiles) {
      const dx = tile.cx - cx;
      const dz = tile.cz - cz;
      // Heights vary, so test the sphere about the tile's middle at the camera's height.
      const dy = -cy;
      const depth = dx * f[0] + dy * f[1] + dz * f[2];
      if (depth < -tile.radius) continue;
      if (Math.abs(dx * r[0] + dy * r[1] + dz * r[2]) > depth * tanX + tile.radius * secX) continue;
      if (Math.abs(dx * u[0] + dy * u[1] + dz * u[2]) > Math.max(depth, 0) * tanY + tile.radius * secY + 400) continue;
      const lod = lodForDistance(Math.hypot(dx, dz), tile.radius);
      const o = slot * 8;
      this.tileData[o] = tile.x0 - cx;
      this.tileData[o + 1] = 0;
      this.tileData[o + 2] = tile.z0 - cz;
      this.tileData[o + 3] = 0;
      this.tileData[o + 4] = tile.x0;
      this.tileData[o + 5] = tile.z0;
      this.tileData[o + 6] = 0;
      this.tileData[o + 7] = 0;
      this.drawn.push({ tile, lod, slot });
      this.trianglesDrawn += tile.lods[lod]!.count / 3;
      slot++;
    }
    this.tilesDrawn = slot;
    if (slot > 0) this.device.queue.writeBuffer(this.tileBuffer, 0, this.tileData, 0, slot * 8);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.drawn.length === 0 || !this.vertexBuffer || !this.indexBuffer || !this.tileGroup || !this.groundGroup) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.sceneGroup);
    pass.setBindGroup(1, this.envGroup);
    pass.setBindGroup(2, this.tileGroup);
    pass.setBindGroup(3, this.groundGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    for (const d of this.drawn) {
      const lod = d.tile.lods[d.lod]!;
      pass.drawIndexed(lod.count, 1, lod.first, lod.baseVertex, d.slot);
    }
  }
}
