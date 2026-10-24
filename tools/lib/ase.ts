// Parser for 3ds Max ASCII Scene Export (.ase) files as used by MC2.
//
// The engine (mclib/tgl.cpp, mclib/msl.cpp) only reads a small part of the
// format; this keeps to the same subset and the same interpretation.

export type Vec3 = [number, number, number];

interface AseNode {
  key: string;
  args: string[];
  children: AseNode[] | null;
}

export interface AseFace {
  v: Vec3;
  t: Vec3 | null;
  mtl: number;
}

export interface AseMesh {
  /** World-space positions in ASE axes. */
  positions: Vec3[];
  faces: AseFace[];
  tverts: [number, number][];
  /** Per-position normal, averaged over every face corner like the engine does. */
  normals: Vec3[] | null;
}

export interface AseObject {
  name: string;
  parent: string | null;
  kind: 'geom' | 'helper';
  /** NODE_TM TM_POS: the node centre in world space. */
  pos: Vec3;
  mesh: AseMesh | null;
}

export interface AseTrack {
  pos: { tick: number; v: Vec3 }[] | null;
  /** Max writes rotation keys as axis + angle, each relative to the previous key. */
  rot: { tick: number; axis: Vec3; angle: number }[] | null;
}

export interface AseFile {
  firstFrame: number;
  lastFrame: number;
  frameSpeed: number;
  ticksPerFrame: number;
  objects: AseObject[];
  /** Texture slots in engine order: the first N *BITMAP entries, N from the material list. */
  textures: string[];
  tracks: Map<string, AseTrack>;
}

export function parseAse(text: string): AseFile {
  const root = parseTree(text);
  const scene = find(root, 'SCENE')?.children ?? [];
  const sceneNum = (key: string, fallback: number) => num(find(scene, key)?.args[0], fallback);

  const objects: AseObject[] = [];
  for (const node of root) {
    if (node.key !== 'GEOMOBJECT' && node.key !== 'HELPEROBJECT') continue;
    const body = node.children ?? [];
    const tm = find(body, 'NODE_TM')?.children ?? [];
    const meshNode = find(body, 'MESH');
    objects.push({
      name: str(find(body, 'NODE_NAME')?.args[0]),
      parent: find(body, 'NODE_PARENT') ? str(find(body, 'NODE_PARENT')!.args[0]) : null,
      kind: node.key === 'GEOMOBJECT' ? 'geom' : 'helper',
      pos: vec3(find(tm, 'TM_POS')?.args ?? [], 0),
      mesh: meshNode?.children ? parseMesh(meshNode.children) : null,
    });
  }

  const tracks = new Map<string, AseTrack>();
  walk(root, (node) => {
    if (node.key !== 'TM_ANIMATION' || !node.children) return;
    const name = str(find(node.children, 'NODE_NAME')?.args[0]);
    const posTrack = find(node.children, 'CONTROL_POS_TRACK')?.children;
    const rotTrack = find(node.children, 'CONTROL_ROT_TRACK')?.children;
    tracks.set(name, {
      pos: posTrack
        ? posTrack.filter((s) => s.key === 'CONTROL_POS_SAMPLE').map((s) => ({ tick: num(s.args[0]), v: vec3(s.args, 1) }))
        : null,
      rot: rotTrack
        ? rotTrack
            .filter((s) => s.key === 'CONTROL_ROT_SAMPLE')
            .map((s) => ({ tick: num(s.args[0]), axis: vec3(s.args, 1), angle: num(s.args[4]) }))
        : null,
    });
  });

  return {
    firstFrame: sceneNum('SCENE_FIRSTFRAME', 0),
    lastFrame: sceneNum('SCENE_LASTFRAME', 0),
    frameSpeed: sceneNum('SCENE_FRAMESPEED', 30),
    ticksPerFrame: sceneNum('SCENE_TICKSPERFRAME', 160),
    objects,
    textures: textureSlots(root),
    tracks,
  };
}

/** Texture slot index the engine uses for a face (mclib/tgl.cpp). */
export function faceTextureSlot(face: AseFace, slotCount: number): number {
  if (slotCount <= 1) return 0;
  return Math.max(0, Math.min(face.mtl, slotCount - 1));
}

function textureSlots(root: AseNode[]): string[] {
  // Standard materials take one slot, Multi materials one per sub-material.
  const materials = find(root, 'MATERIAL_LIST')?.children?.filter((n) => n.key === 'MATERIAL') ?? [];
  let count = 0;
  for (const m of materials) {
    const cls = str(find(m.children ?? [], 'MATERIAL_CLASS')?.args[0]);
    if (cls.includes('Multi')) count += num(find(m.children ?? [], 'NUMSUBMTLS')?.args[0]);
    else count += 1;
  }
  // The engine then takes the first `count` *BITMAP entries in file order.
  const bitmaps: string[] = [];
  walk(root, (n) => {
    if (n.key === 'BITMAP') bitmaps.push(str(n.args[0]));
  });
  const slots: string[] = [];
  for (let i = 0; i < count; i++) slots.push(baseName(bitmaps[i] ?? ''));
  return slots;
}

function parseMesh(mesh: AseNode[]): AseMesh {
  const positions: Vec3[] = [];
  for (const v of find(mesh, 'MESH_VERTEX_LIST')?.children ?? []) {
    if (v.key === 'MESH_VERTEX') positions[num(v.args[0])] = vec3(v.args, 1);
  }

  const faces: AseFace[] = [];
  for (const f of find(mesh, 'MESH_FACE_LIST')?.children ?? []) {
    if (f.key === 'MESH_FACE') {
      faces[parseInt(f.args[0], 10)] = { v: faceCorners(f.args), t: null, mtl: 0 };
    } else if (f.key === 'MESH_MTLID' && faces.length) {
      // MESH_MTLID sits on the MESH_FACE line, so it parses as the next sibling.
      faces[faces.length - 1].mtl = num(f.args[0]);
    }
  }

  const tverts: [number, number][] = [];
  for (const t of find(mesh, 'MESH_TVERTLIST')?.children ?? []) {
    if (t.key === 'MESH_TVERT') tverts[num(t.args[0])] = [num(t.args[1]), num(t.args[2])];
  }
  for (const t of find(mesh, 'MESH_TFACELIST')?.children ?? []) {
    if (t.key === 'MESH_TFACE' && faces[num(t.args[0])]) faces[num(t.args[0])].t = vec3(t.args, 1);
  }

  let normals: Vec3[] | null = null;
  const normalList = find(mesh, 'MESH_NORMALS')?.children;
  if (normalList) {
    normals = positions.map(() => [0, 0, 0] as Vec3);
    for (const n of normalList) {
      if (n.key !== 'MESH_VERTEXNORMAL') continue;
      const acc = normals[num(n.args[0])];
      if (!acc) continue;
      const v = vec3(n.args, 1);
      acc[0] += v[0];
      acc[1] += v[1];
      acc[2] += v[2];
    }
    for (const n of normals) {
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      n[0] /= len;
      n[1] /= len;
      n[2] /= len;
    }
  }

  return { positions, faces: faces.filter(Boolean), tverts, normals };
}

function faceCorners(args: string[]): Vec3 {
  const corner = (label: string) => {
    const i = args.findIndex((a) => a.startsWith(label));
    if (i < 0) throw new Error(`MESH_FACE missing ${label}`);
    const inline = args[i].slice(label.length);
    return parseInt(inline || args[i + 1], 10);
  };
  return [corner('A:'), corner('B:'), corner('C:')];
}

// ---------------------------------------------------------------------------
// Tokenizer and tree: `*KEY arg arg ... { children }`.

const KEY = 0;
const WORD = 1;
const OPEN = 2;
const CLOSE = 3;

function parseTree(text: string): AseNode[] {
  const kinds: number[] = [];
  const values: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c <= 32) {
      i++;
    } else if (c === 123 /* { */ || c === 125 /* } */) {
      kinds.push(c === 123 ? OPEN : CLOSE);
      values.push('');
      i++;
    } else if (c === 34 /* " */) {
      const end = text.indexOf('"', i + 1);
      const stop = end < 0 ? n : end;
      kinds.push(WORD);
      values.push(text.slice(i + 1, stop));
      i = stop + 1;
    } else {
      const start = i;
      while (i < n && text.charCodeAt(i) > 32) i++;
      const word = text.slice(start, i);
      if (c === 42 /* * */) {
        kinds.push(KEY);
        values.push(word.slice(1));
      } else {
        kinds.push(WORD);
        values.push(word);
      }
    }
  }

  let pos = 0;
  const block = (): AseNode[] => {
    const out: AseNode[] = [];
    while (pos < kinds.length) {
      const kind = kinds[pos];
      if (kind === CLOSE) return out;
      if (kind !== KEY) {
        pos++;
        continue;
      }
      const node: AseNode = { key: values[pos++], args: [], children: null };
      while (pos < kinds.length && kinds[pos] === WORD) node.args.push(values[pos++]);
      if (kinds[pos] === OPEN) {
        pos++;
        node.children = block();
        pos++; // closing brace
      }
      out.push(node);
    }
    return out;
  };
  return block();
}

function find(nodes: AseNode[], key: string): AseNode | undefined {
  return nodes.find((n) => n.key === key);
}

function walk(nodes: AseNode[], visit: (n: AseNode) => void) {
  for (const n of nodes) {
    visit(n);
    if (n.children) walk(n.children, visit);
  }
}

function num(s: string | undefined, fallback = 0): number {
  const v = s === undefined ? NaN : parseFloat(s);
  return Number.isFinite(v) ? v : fallback;
}

function str(s: string | undefined): string {
  return s ?? '';
}

function vec3(args: string[], offset: number): Vec3 {
  return [num(args[offset]), num(args[offset + 1]), num(args[offset + 2])];
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}
