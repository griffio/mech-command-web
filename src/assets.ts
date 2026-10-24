// Types and loaders for the files written by tools/convert.ts.
import { Vector3 } from 'three';

export interface ImageRef {
  file: string;
  width: number;
  height: number;
}

export interface MapInfo {
  name: string;
  /** Terrain vertices per side; row 0 is the north edge. */
  side: number;
  worldUnitsPerVertex: number;
  worldUnitsPerMeter: number;
  elevation: { file: string; min: number; max: number };
  colormap: ImageRef;
  detail: (ImageRef & { tiling: number }) | null;
  water: {
    elevation: number;
    alphaDepth: number;
    /** Opacity for shallow, middle and deep water. */
    alpha: [number, number, number];
    texture: (ImageRef & { tiling: number }) | null;
  };
  light: { sun: [number, number, number]; color: [number, number, number]; ambient: [number, number, number] };
  camera: { x: number; y: number; rotation: number };
  /** MC2's movement map: width x height cells of Uint32 flags (mclib/move.h), 3 to a terrain tile. */
  move: { file: string; width: number; height: number } | null;
}

export interface ObjectsFile {
  models: string[];
  /** [model index, x, y, z, rotation degrees, team] in MC2 world units. */
  instances: [number, number, number, number, number, number][];
}

export interface ClipInfo {
  frames: number;
  fps: number;
  /** Gesture speed in metres per second. */
  startVelocity: number;
  endVelocity: number;
}

export interface MechInfo {
  model: string;
  clips: Record<string, ClipInfo>;
}

export interface UnitPlacement {
  model: string;
  kind: 'mech' | 'vehicle';
  name: string;
  csv: string;
  x: number;
  y: number;
  rotation: number;
  team: number;
  player: boolean;
  /** Base, highlight 1, highlight 2. */
  colors: [string, string, string];
}

export interface UnitsFile {
  mechs: Record<string, MechInfo>;
  units: UnitPlacement[];
  showcase: string[];
}

export const ASSET_ROOT = `${import.meta.env.BASE_URL}assets/`;

export async function loadJson<T>(path: string): Promise<T> {
  const res = await fetch(ASSET_ROOT + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function loadBinary(path: string): Promise<ArrayBuffer> {
  const res = await fetch(ASSET_ROOT + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** MC2 world axes (x east, y north, z up) to three.js axes (y up, north = -z). */
export function worldToThree(x: number, y: number, z: number, target = new Vector3()): Vector3 {
  return target.set(x, z, -y);
}
