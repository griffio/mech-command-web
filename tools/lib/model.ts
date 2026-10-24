// Builds glTF binaries from MC2 ASE shapes, reproducing how the engine
// assembles and animates them (mclib/tgl.cpp, mclib/msl.cpp).
//
// Axes: ASE files share MC2 world axes (x east, y north, z up); the engine's own
// internal swizzle (-x, z, y) cancels out between model and world. three.js is
// y-up, so everything goes through toThree(). A model's forward is world -y,
// which lands on +Z: glTF's forward axis.
//
// Engine hierarchy rules: node rest rotations are ignored, every node sits at
// its TM_POS relative to its parent, and mesh vertices are stored relative to
// their node centre. Animation rotation keys are axis/angle deltas that the
// engine accumulates as q[j] = key[j] * q[j-1].
import { Document, NodeIO, type Material, type Node as GltfNode } from '@gltf-transform/core';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { faceTextureSlot, type AseFile, type AseObject, type Vec3 } from './ase.ts';
import type { SourceData } from './srcdata.ts';
import { decodeTga } from './tga.ts';

type Quat = [number, number, number, number];

export function toThree(v: Vec3): Vec3 {
  return [v[0], v[2], -v[1]];
}

/** A rotation key as the engine converts it, in three.js axes. */
function keyQuat(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [-axis[0] * s, -axis[2] * s, axis[1] * s, Math.cos(angle / 2)];
}

function mulQuat(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + b[3] * a[0] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] + b[3] * a[1] + a[2] * b[0] - a[0] * b[2],
    a[3] * b[2] + b[3] * a[2] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function normalizeQuat(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// ---------------------------------------------------------------------------

export interface TextureImage {
  data: Uint8Array;
  mimeType: 'image/png' | 'image/webp';
  hasAlpha: boolean;
}

export interface TextureOptions {
  /** Checkout of the remaster's 4x textures (tgl/<name>), preferred when present. */
  upscaled?: SourceData | null;
  /** Largest edge to ship. */
  maxSize?: number;
}

/**
 * Decodes tgl/128 textures once and re-encodes them: originals as lossless PNG
 * (they are tiny), 4x upscales as WebP to keep downloads reasonable.
 */
export class TextureLibrary {
  private readonly cache = new Map<string, Promise<TextureImage | null>>();
  readonly missing = new Set<string>();
  upscaledCount = 0;

  constructor(
    private readonly src: SourceData,
    private readonly options: TextureOptions = {},
  ) {}

  get(name: string): Promise<TextureImage | null> {
    const key = name.toLowerCase();
    let entry = this.cache.get(key);
    if (!entry) {
      entry = this.load(name);
      this.cache.set(key, entry);
    }
    return entry;
  }

  private async load(name: string): Promise<TextureImage | null> {
    if (!name) return null;
    const up = this.options.upscaled;
    const upRel = up && [`tgl/${name}`, `tgl/${name}.tga`].find((p) => up.has(p));
    const rel = [`tgl/128/${name}`, `tgl/128/${name}.tga`].find((p) => this.src.has(p));
    if (!upRel && !rel) {
      this.missing.add(name);
      return null;
    }
    const img = decodeTga(upRel ? up!.read(upRel) : this.src.read(rel!));
    let pipeline = sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 4 } });
    const maxSize = this.options.maxSize ?? Infinity;
    if (Math.max(img.width, img.height) > maxSize) pipeline = pipeline.resize(maxSize, maxSize, { fit: 'inside', kernel: 'lanczos3' });
    if (upRel) {
      this.upscaledCount++;
      const webp = await pipeline.webp({ quality: 90, alphaQuality: 100 }).toBuffer();
      return { data: new Uint8Array(webp), mimeType: 'image/webp', hasAlpha: img.hasAlpha };
    }
    const png = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    return { data: new Uint8Array(png), mimeType: 'image/png', hasAlpha: img.hasAlpha };
  }
}

// ---------------------------------------------------------------------------

export interface ModelClip {
  name: string;
  ase: AseFile;
}

export interface ModelInput {
  name: string;
  base: AseFile;
  clips?: ModelClip[];
  /** Bake the rest pose into one node (static props), instead of keeping the hierarchy. */
  flatten: boolean;
}

export interface ModelStats {
  triangles: number;
  vertices: number;
  nodes: number;
  clips: number;
}

export async function buildModel(input: ModelInput, textures: TextureLibrary): Promise<{ glb: Uint8Array; stats: ModelStats }> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(input.name);
  const root = doc.createNode(input.name);
  scene.addChild(root);
  const stats: ModelStats = { triangles: 0, vertices: 0, nodes: 0, clips: 0 };

  const slots = input.base.textures;
  const materials: Material[] = [];
  for (let i = 0; i < Math.max(slots.length, 1); i++) {
    const image = slots[i] ? await textures.get(slots[i]) : null;
    const mat = doc.createMaterial(slots[i] || 'untextured').setMetallicFactor(0).setRoughnessFactor(1);
    if (image) {
      const tex = doc.createTexture(slots[i]).setImage(image.data).setMimeType(image.mimeType);
      if (image.mimeType === 'image/webp' && !doc.getRoot().listExtensionsUsed().length) {
        doc.createExtension(EXTTextureWebP).setRequired(true);
      }
      mat.setBaseColorTexture(tex);
      if (image.hasAlpha) mat.setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true);
    } else {
      mat.setBaseColorFactor([0.6, 0.6, 0.6, 1]);
    }
    materials.push(mat);
  }

  const drawable = (o: AseObject) => o.mesh && o.mesh.faces.length > 0 && !/^spotlight/i.test(o.name);
  const byName = new Map(input.base.objects.map((o) => [o.name, o]));
  const parentOf = (o: AseObject) => (o.parent && byName.has(o.parent) && o.parent !== o.name ? byName.get(o.parent)! : null);

  const makeMesh = (objects: AseObject[], origin: (o: AseObject) => Vec3) => {
    // One primitive per texture slot; vertices are split per (position, uv) pair.
    const groups = new Map<number, { pos: number[]; nrm: number[]; uv: number[]; idx: number[]; seen: Map<string, number> }>();
    for (const o of objects) {
      const mesh = o.mesh!;
      const center = origin(o);
      const normals = mesh.normals ?? computeNormals(mesh.positions, mesh.faces.map((f) => f.v));
      for (const face of mesh.faces) {
        const slot = faceTextureSlot(face, slots.length);
        let g = groups.get(slot);
        if (!g) groups.set(slot, (g = { pos: [], nrm: [], uv: [], idx: [], seen: new Map() }));
        for (let k = 0; k < 3; k++) {
          const pi = face.v[k];
          const ti = face.t ? face.t[k] : -1;
          const key = `${o.name}/${pi}/${ti}`;
          let index = g.seen.get(key);
          if (index === undefined) {
            index = g.pos.length / 3;
            g.seen.set(key, index);
            g.pos.push(...toThree(sub(mesh.positions[pi], center)));
            g.nrm.push(...toThree(normals[pi]));
            const uv = ti >= 0 ? mesh.tverts[ti] : undefined;
            g.uv.push(uv ? uv[0] : 0, uv ? 1 - uv[1] : 0);
          }
          g.idx.push(index);
        }
        stats.triangles++;
      }
    }
    if (!groups.size) return null;
    const gMesh = doc.createMesh();
    for (const [slot, g] of groups) {
      const vertexCount = g.pos.length / 3;
      stats.vertices += vertexCount;
      const accessor = (type: 'VEC3' | 'VEC2' | 'SCALAR', array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>) =>
        doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
      gMesh.addPrimitive(
        doc
          .createPrimitive()
          .setAttribute('POSITION', accessor('VEC3', new Float32Array(g.pos)))
          .setAttribute('NORMAL', accessor('VEC3', new Float32Array(g.nrm)))
          .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(g.uv)))
          .setIndices(accessor('SCALAR', vertexCount > 65535 ? new Uint32Array(g.idx) : new Uint16Array(g.idx)))
          .setMaterial(materials[Math.min(slot, materials.length - 1)]),
      );
    }
    return gMesh;
  };

  if (input.flatten) {
    const mesh = makeMesh(input.base.objects.filter(drawable), () => [0, 0, 0]);
    if (mesh) root.setMesh(mesh);
    stats.nodes = 1;
  } else {
    const nodes = new Map<string, GltfNode>();
    const restTranslation = new Map<string, Vec3>();
    for (const o of input.base.objects) {
      const parent = parentOf(o);
      const t = toThree(parent ? sub(o.pos, parent.pos) : o.pos);
      const node = doc.createNode(o.name).setTranslation(t);
      if (drawable(o)) {
        const mesh = makeMesh([o], (x) => x.pos);
        if (mesh) node.setMesh(mesh.setName(o.name));
      }
      nodes.set(o.name, node);
      restTranslation.set(o.name, t);
    }
    for (const o of input.base.objects) {
      const parent = parentOf(o);
      (parent ? nodes.get(parent.name)! : root).addChild(nodes.get(o.name)!);
    }
    stats.nodes = nodes.size;

    for (const clip of input.clips ?? []) {
      addClip(doc, buffer, clip, input.base.objects, nodes, restTranslation);
      stats.clips++;
    }
  }

  const glb = await new NodeIO().registerExtensions([EXTTextureWebP]).writeBinary(doc);
  return { glb, stats };
}

function addClip(
  doc: Document,
  buffer: ReturnType<Document['createBuffer']>,
  clip: ModelClip,
  objects: AseObject[],
  nodes: Map<string, GltfNode>,
  rest: Map<string, Vec3>,
) {
  const ase = clip.ase;
  const frames = Math.max(1, ase.lastFrame - ase.firstFrame + 1);
  const times = new Float32Array(frames);
  for (let j = 0; j < frames; j++) times[j] = j / ase.frameSpeed;
  const timeAccessor = doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer);
  const startAccessor = doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0])).setBuffer(buffer);
  const anim = doc.createAnimation(clip.name);
  const lowerTracks = new Map([...ase.tracks].map(([k, v]) => [k.toLowerCase(), v]));

  const channel = (node: GltfNode, path: 'translation' | 'rotation', values: number[][]) => {
    const constant = values.every((v) => v.every((x, i) => Math.abs(x - values[0][i]) < 1e-5));
    const output = new Float32Array((constant ? [values[0]] : values).flat());
    const sampler = doc
      .createAnimationSampler()
      .setInput(constant ? startAccessor : timeAccessor)
      .setOutput(doc.createAccessor().setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(output).setBuffer(buffer))
      .setInterpolation('LINEAR');
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
  };

  for (const o of objects) {
    const track = ase.tracks.get(o.name) ?? lowerTracks.get(o.name.toLowerCase());
    if (!track) continue;
    const node = nodes.get(o.name)!;
    const tickOf = (j: number) => (ase.firstFrame + j) * ase.ticksPerFrame;

    if (track.pos?.length) {
      const byTick = new Map(track.pos.map((s) => [s.tick, s.v]));
      let current = rest.get(o.name)!;
      const values: number[][] = [];
      for (let j = 0; j < frames; j++) {
        const sample = byTick.get(tickOf(j));
        if (sample) current = toThree(sample);
        values.push(current);
      }
      channel(node, 'translation', values);
    }

    if (track.rot?.length) {
      const byTick = new Map(track.rot.map((s) => [s.tick, s]));
      let q: Quat = [0, 0, 0, 1];
      const values: number[][] = [];
      for (let j = 0; j < frames; j++) {
        const sample = byTick.get(tickOf(j));
        const key: Quat = sample ? normalizeQuat(keyQuat(sample.axis, sample.angle)) : [0, 0, 0, 1];
        q = j === 0 ? key : normalizeQuat(mulQuat(key, q));
        // Keep consecutive keys in the same hemisphere so LINEAR blending takes the short way.
        if (values.length) {
          const p = values[values.length - 1];
          if (p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
        }
        values.push(q);
      }
      channel(node, 'rotation', values);
    }
  }
}

function computeNormals(positions: Vec3[], faces: Vec3[]): Vec3[] {
  const out = positions.map(() => [0, 0, 0] as Vec3);
  for (const [a, b, c] of faces) {
    const u = sub(positions[b], positions[a]);
    const v = sub(positions[c], positions[a]);
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const i of [a, b, c]) {
      out[i][0] += n[0];
      out[i][1] += n[1];
      out[i][2] += n[2];
    }
  }
  return out.map((n) => {
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / len, n[1] / len, n[2] / len] as Vec3;
  });
}
