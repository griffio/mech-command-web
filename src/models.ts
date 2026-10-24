// Model loading shared by props and units: glTF in, cheap Lambert materials out.
import {
  CanvasTexture,
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
import { paintKey, paintPixels, type PaintScheme } from './paint.ts';

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

export { PLAYER_PAINT, paintFromMission, type PaintScheme } from './paint.ts';

const paintedCache = new Map<string, MeshLambertMaterial>();

/** Returns a copy of `object` whose textures are recoloured with the paint scheme. */
export function paintedClone(object: Object3D, scheme: PaintScheme): Object3D {
  const clone = object.clone(true);
  const key = paintKey(scheme);
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
  paintPixels(pixels.data, scheme);
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
