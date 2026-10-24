// MC2's terrain in the dreadnought game's terms: heights in metres about the sea, on a grid centred on the origin
// with row 0 at the north (minimum z), as tools/convert.ts writes it and mclib/mapdata.cpp lays it out.
import type { MapInfo } from '../../assets.ts';
import type { TerrainGrid } from '../sim/terrain/terrain';

/** The map's height samples in metres relative to the mission's water level. */
export function mc2TerrainGrid(info: MapInfo, elevation: Float32Array): TerrainGrid {
  const upm = info.worldUnitsPerMeter;
  const cell = info.worldUnitsPerVertex / upm;
  const origin = -(info.side / 2) * cell;
  return {
    x0: origin,
    z0: origin,
    cell,
    nx: info.side,
    nz: info.side,
    heights: elevation.map((e) => (e - info.water.elevation) / upm),
  };
}

/**
 * The same ground on a grid `factor` times finer, blended bilinearly between the original samples. MC2's 25 m cells
 * give a coastline of straight 25 m runs; the finer grid rounds it, for the land's mesh and for the surf laid along it.
 */
export function upsampleGrid(grid: TerrainGrid, factor: number): TerrainGrid {
  const nx = (grid.nx - 1) * factor + 1;
  const nz = (grid.nz - 1) * factor + 1;
  const heights = new Float32Array(nx * nz);
  const src = grid.heights;
  for (let j = 0; j < nz; j++) {
    const fz = j / factor;
    const iz = Math.min(Math.floor(fz), grid.nz - 2);
    const tz = fz - iz;
    for (let i = 0; i < nx; i++) {
      const fx = i / factor;
      const ix = Math.min(Math.floor(fx), grid.nx - 2);
      const tx = fx - ix;
      const row = iz * grid.nx + ix;
      const a = src[row]! * (1 - tx) + src[row + 1]! * tx;
      const b = src[row + grid.nx]! * (1 - tx) + src[row + grid.nx + 1]! * tx;
      heights[j * nx + i] = a * (1 - tz) + b * tz;
    }
  }
  return { x0: grid.x0, z0: grid.z0, cell: grid.cell / factor, nx, nz, heights };
}
