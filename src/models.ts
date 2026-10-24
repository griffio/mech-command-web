// Model loading shared by props and units: glTF in, cheap Lambert materials out.
import {
  CanvasTexture,
  Color,
  Material,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
  type Object3D,
  type Texture,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { ASSET_ROOT } from './assets.ts';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<GLTF>>();

export function loadModel(path: string): Promise<GLTF> {
  let entry = cache.get(path);
  if (!entry) {
    entry = loader.loadAsync(ASSET_ROOT + path).then((gltf) => {
      gltf.scene.traverse((o) => {
        if (o instanceof Mesh) o.material = toLambert(o.material);
      });
      return gltf;
    });
    cache.set(path, entry);
  }
  return entry;
}

const lambertCache = new WeakMap<Material, MeshLambertMaterial>();

/** MC2 shades with per-vertex Lambert lighting; the glTF PBR material is overkill on an iPad. */
function toLambert(source: Material): MeshLambertMaterial {
  if (source instanceof MeshLambertMaterial) return source;
  let out = lambertCache.get(source);
  if (!out) {
    const std = source as MeshStandardMaterial;
    out = new MeshLambertMaterial({
      name: std.name,
      map: std.map,
      color: std.color,
      alphaTest: std.alphaTest,
      side: std.side,
    });
    lambertCache.set(source, out);
  }
  return out;
}

export interface PaintScheme {
  /** Texels that are mostly red, green or blue take these colours (mclib/mech3d.cpp). */
  red: string;
  green: string;
  blue: string;
}

export const PLAYER_PAINT: PaintScheme = { red: '#ff7e00', green: '#ff7e00', blue: '#ff7e00' }; // code/prefs.cpp defaults

/** Mission colours are [base, highlight1, highlight2]; code/mission.cpp passes (hl1, hl2, base). */
export function paintFromMission(colors: [string, string, string]): PaintScheme {
  return { red: colors[1], green: colors[2], blue: colors[0] };
}

const paintedCache = new Map<string, MeshLambertMaterial>();

/** Returns a copy of `object` whose textures are recoloured with the paint scheme. */
export function paintedClone(object: Object3D, scheme: PaintScheme): Object3D {
  const clone = object.clone(true);
  const key = `${scheme.red}/${scheme.green}/${scheme.blue}`;
  clone.traverse((o) => {
    if (!(o instanceof Mesh) || !(o.material instanceof MeshLambertMaterial) || !o.material.map) return;
    const source = o.material;
    const cacheKey = `${source.uuid}/${key}`;
    let painted = paintedCache.get(cacheKey);
    if (!painted) {
      painted = source.clone();
      painted.map = paintTexture(source.map!, scheme);
      paintedCache.set(cacheKey, painted);
    }
    o.material = painted;
  });
  return clone;
}

function paintTexture(source: Texture, scheme: PaintScheme): Texture {
  const image = source.image as CanvasImageSource & { width: number; height: number };
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = pixels.data;
  const slots = [scheme.red, scheme.green, scheme.blue].map((c) => new Color(c).getHex());

  // Same rule as Mech3DAppearance::resetPaintScheme: a channel at least 3x the
  // others is a paint mask; its strength sets the shade, the ratio sets the blend.
  const MIN_DOMINANT = 16;
  const RATIO = 3;
  const RATIO_MARGIN = 1.5;
  for (let i = 0; i < d.length; i += 4) {
    const rgb = [d[i], d[i + 1], d[i + 2]];
    let slot = -1;
    for (let s = 0; s < 3; s++) {
      const a = rgb[(s + 1) % 3];
      const b = rgb[(s + 2) % 3];
      if (rgb[s] >= MIN_DOMINANT && rgb[s] >= RATIO * a && rgb[s] >= RATIO * b) {
        slot = s;
        break;
      }
    }
    if (slot < 0) continue;
    const dominant = rgb[slot];
    const other = Math.max(rgb[(slot + 1) % 3], rgb[(slot + 2) % 3]);
    const dn = dominant / 255;
    const shade = 1 - (1 - dn) * (1 - dn);
    const mix = Math.min(1, Math.max(0, (dominant / (other + 1) - RATIO) / (RATIO * (RATIO_MARGIN - 1))));
    if (mix <= 0) continue;
    const tint = slots[slot];
    const tr = ((tint >> 16) & 255) * shade;
    const tg = ((tint >> 8) & 255) * shade;
    const tb = (tint & 255) * shade;
    d[i] = tr * mix + rgb[0] * (1 - mix);
    d[i + 1] = tg * mix + rgb[1] * (1 - mix);
    d[i + 2] = tb * mix + rgb[2] * (1 - mix);
  }
  ctx.putImageData(pixels, 0, 0);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = source.flipY;
  texture.wrapS = source.wrapS;
  texture.wrapT = source.wrapT;
  texture.magFilter = source.magFilter;
  texture.minFilter = source.minFilter;
  texture.anisotropy = source.anisotropy;
  return texture;
}
