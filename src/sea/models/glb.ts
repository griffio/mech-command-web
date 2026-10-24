// Reader for the glTF binaries tools/convert.ts writes: a node tree with rest translations and rotations, meshes
// of triangles with positions, normals and one UV set, one base-colour texture per material (PNG or WebP), and
// animation clips of linear translation and rotation keys. Not a general glTF loader: nothing else is needed.

export interface ModelNode {
  name: string;
  /** Index of the parent node, or -1 for a root. Parents always come before their children. */
  parent: number;
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface ModelMaterial {
  name: string;
  image: Blob | null;
  color: [number, number, number, number];
  /** Alpha below this is cut away; null for opaque materials. */
  alphaCutoff: number | null;
  doubleSided: boolean;
}

export interface ModelPrimitive {
  /** The node the vertices belong to (they move with it). */
  node: number;
  material: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface ModelTrack {
  node: number;
  path: 'translation' | 'rotation';
  times: Float32Array;
  /** 3 floats per key for translation, 4 (x, y, z, w) for rotation. */
  values: Float32Array;
}

export interface ModelClip {
  name: string;
  duration: number;
  tracks: ModelTrack[];
}

export interface ModelData {
  name: string;
  nodes: ModelNode[];
  materials: ModelMaterial[];
  primitives: ModelPrimitive[];
  clips: Map<string, ModelClip>;
}

interface Gltf {
  scenes: { nodes: number[] }[];
  nodes: { name?: string; translation?: number[]; rotation?: number[]; scale?: number[]; children?: number[]; mesh?: number }[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number; material?: number }[] }[];
  materials?: {
    name?: string;
    alphaMode?: string;
    alphaCutoff?: number;
    doubleSided?: boolean;
    pbrMetallicRoughness?: { baseColorTexture?: { index: number }; baseColorFactor?: number[] };
  }[];
  textures?: { source?: number; extensions?: { EXT_texture_webp?: { source: number } } }[];
  images?: { bufferView: number; mimeType: string }[];
  accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[];
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
  animations?: {
    name?: string;
    channels: { sampler: number; target: { node: number; path: string } }[];
    samplers: { input: number; output: number; interpolation?: string }[];
  }[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export function parseGlb(buffer: ArrayBuffer, name: string): ModelData {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${name}: not a GLB file`);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as Gltf;
  const binStart = 20 + jsonLength + 8;

  const accessor = (index: number): Float32Array | Uint32Array => {
    const a = json.accessors[index]!;
    const bv = json.bufferViews[a.bufferView]!;
    const n = a.count * COMPONENTS[a.type]!;
    const offset = binStart + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const comps = COMPONENTS[a.type]!;
    if (bv.byteStride && bv.byteStride !== comps * 4) {
      // Interleaved vertex attributes (the glTF writer packs position, normal and UV together): read element by element.
      if (a.componentType !== 5126) throw new Error(`${name}: interleaved component type ${a.componentType} is not supported`);
      const out = new Float32Array(n);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < comps; c++) out[i * comps + c] = view.getFloat32(offset + i * bv.byteStride + c * 4, true);
      return out;
    }
    switch (a.componentType) {
      case 5126:
        return new Float32Array(buffer.slice(offset, offset + n * 4));
      case 5125:
        return new Uint32Array(buffer.slice(offset, offset + n * 4));
      case 5123:
        return Uint32Array.from(new Uint16Array(buffer.slice(offset, offset + n * 2)));
      default:
        throw new Error(`${name}: unsupported component type ${a.componentType}`);
    }
  };

  // Order the nodes so that parents come first, from the scene roots down.
  const order: number[] = [];
  const parentOf = new Map<number, number>();
  const visit = (n: number, parent: number) => {
    parentOf.set(n, parent);
    order.push(n);
    for (const c of json.nodes[n]!.children ?? []) visit(c, n);
  };
  for (const root of json.scenes[0]!.nodes) visit(root, -1);
  const newIndex = new Map(order.map((n, i) => [n, i]));
  const nodes: ModelNode[] = order.map((n) => {
    const src = json.nodes[n]!;
    const parent = parentOf.get(n)!;
    return {
      name: src.name ?? `node${n}`,
      parent: parent < 0 ? -1 : newIndex.get(parent)!,
      translation: (src.translation as [number, number, number]) ?? [0, 0, 0],
      rotation: (src.rotation as [number, number, number, number]) ?? [0, 0, 0, 1],
      scale: (src.scale as [number, number, number]) ?? [1, 1, 1],
    };
  });

  const materials: ModelMaterial[] = (json.materials ?? []).map((m) => {
    const texIndex = m.pbrMetallicRoughness?.baseColorTexture?.index;
    const tex = texIndex === undefined ? undefined : json.textures?.[texIndex];
    const imageIndex = tex?.extensions?.EXT_texture_webp?.source ?? tex?.source;
    let image: Blob | null = null;
    if (imageIndex !== undefined) {
      const img = json.images![imageIndex]!;
      const bv = json.bufferViews[img.bufferView]!;
      const start = binStart + (bv.byteOffset ?? 0);
      image = new Blob([buffer.slice(start, start + bv.byteLength)], { type: img.mimeType });
    }
    return {
      name: m.name ?? 'material',
      image,
      color: (m.pbrMetallicRoughness?.baseColorFactor as [number, number, number, number]) ?? [1, 1, 1, 1],
      alphaCutoff: m.alphaMode === 'MASK' ? (m.alphaCutoff ?? 0.5) : null,
      doubleSided: m.doubleSided ?? false,
    };
  });

  const primitives: ModelPrimitive[] = [];
  order.forEach((n, i) => {
    const meshIndex = json.nodes[n]!.mesh;
    if (meshIndex === undefined) return;
    for (const p of json.meshes[meshIndex]!.primitives) {
      const positions = accessor(p.attributes.POSITION!) as Float32Array;
      const count = positions.length / 3;
      primitives.push({
        node: i,
        material: p.material ?? 0,
        positions,
        normals: p.attributes.NORMAL !== undefined ? (accessor(p.attributes.NORMAL) as Float32Array) : new Float32Array(count * 3),
        uvs: p.attributes.TEXCOORD_0 !== undefined ? (accessor(p.attributes.TEXCOORD_0) as Float32Array) : new Float32Array(count * 2),
        indices: p.indices !== undefined ? (accessor(p.indices) as Uint32Array) : Uint32Array.from({ length: count }, (_, k) => k),
      });
    }
  });

  const clips = new Map<string, ModelClip>();
  for (const anim of json.animations ?? []) {
    let duration = 0;
    const tracks: ModelTrack[] = [];
    for (const ch of anim.channels) {
      if (ch.target.path !== 'translation' && ch.target.path !== 'rotation') continue;
      const sampler = anim.samplers[ch.sampler]!;
      const times = accessor(sampler.input) as Float32Array;
      duration = Math.max(duration, times[times.length - 1] ?? 0);
      tracks.push({ node: newIndex.get(ch.target.node)!, path: ch.target.path, times, values: accessor(sampler.output) as Float32Array });
    }
    clips.set(anim.name ?? `clip${clips.size}`, { name: anim.name ?? '', duration, tracks });
  }

  return { name, nodes, materials, primitives, clips };
}
