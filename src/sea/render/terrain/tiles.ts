import type { Terrain } from '../../sim/terrain/terrain';

/** Cells along a tile's edge at the finest level of detail. */
export const TILE_CELLS = 64;
/** Strides (in cells) of the three levels of detail. */
export const LOD_STRIDES = [1, 2, 4] as const;
/** Floats per vertex: position (tile-local x, height, tile-local z) and normal. */
export const TERRAIN_FLOATS_PER_VERTEX = 6;
/** How far the skirts that hide the cracks between levels of detail hang below the surface, metres. */
const SKIRT = 60;

export interface TileLod {
  /** First index and index count in the shared index buffer, and the vertex the indices count from. */
  first: number;
  count: number;
  baseVertex: number;
}

export interface TerrainTile {
  /** World position of the tile's minimum corner. */
  x0: number;
  z0: number;
  /** Centre and bounding radius, metres, for culling and choosing the detail. */
  cx: number;
  cz: number;
  radius: number;
  lods: TileLod[];
}

export interface TerrainMesh {
  vertices: Float32Array;
  indices: Uint32Array;
  tiles: TerrainTile[];
}

/**
 * Cut the heightfield into square tiles, each a grid of vertices at three strides, with the land's normals and a skirt round
 * the edge. A tile that lies wholly under the sea is left out: the ocean covers it.
 */
export function buildTerrainMesh(terrain: Terrain): TerrainMesh {
  const verts: number[] = [];
  const idx: number[] = [];
  const tiles: TerrainTile[] = [];
  const cells = TILE_CELLS;
  const span = cells * terrain.cell;
  const tx = Math.ceil((terrain.nx - 1) / cells);
  const tz = Math.ceil((terrain.nz - 1) / cells);

  for (let jz = 0; jz < tz; jz++) {
    for (let jx = 0; jx < tx; jx++) {
      const x0 = terrain.x0 + jx * span;
      const z0 = terrain.z0 + jz * span;
      // Is there land in this tile (or the rim of it, so the shore is drawn)?
      let top = Number.NEGATIVE_INFINITY;
      let bottom = Number.POSITIVE_INFINITY;
      for (let iz = 0; iz <= cells; iz += 2) {
        for (let ix = 0; ix <= cells; ix += 2) {
          const h = terrain.heightAt(x0 + ix * terrain.cell, z0 + iz * terrain.cell);
          if (h > top) top = h;
          if (h < bottom) bottom = h;
        }
      }
      if (top < -0.5) continue;

      const lods: TileLod[] = [];
      for (const stride of LOD_STRIDES) {
        const n = cells / stride;
        const baseVertex = verts.length / TERRAIN_FLOATS_PER_VERTEX;
        const first = idx.length;
        const step = stride * terrain.cell;
        const at = (i: number, j: number) => baseVertex + j * (n + 1) + i;
        for (let j = 0; j <= n; j++) {
          for (let i = 0; i <= n; i++) {
            const x = x0 + i * step;
            const z = z0 + j * step;
            const h = terrain.heightAt(x, z);
            const hx = terrain.heightAt(x + step, z) - terrain.heightAt(x - step, z);
            const hz = terrain.heightAt(x, z + step) - terrain.heightAt(x, z - step);
            const l = Math.hypot(hx, 2 * step, hz);
            verts.push(i * step, h, j * step, -hx / l, (2 * step) / l, -hz / l);
          }
        }
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const a = at(i, j);
            const b = at(i + 1, j);
            const c = at(i, j + 1);
            const d = at(i + 1, j + 1);
            idx.push(a - baseVertex, c - baseVertex, b - baseVertex, b - baseVertex, c - baseVertex, d - baseVertex);
          }
        }
        // Skirts: a second ring of vertices hung below the rim, joined to it.
        const skirtBase = verts.length / TERRAIN_FLOATS_PER_VERTEX;
        const edges: [number, number][] = [];
        for (let i = 0; i <= n; i++) edges.push([i, 0]);
        for (let j = 1; j <= n; j++) edges.push([n, j]);
        for (let i = n - 1; i >= 0; i--) edges.push([i, n]);
        for (let j = n - 1; j >= 1; j--) edges.push([0, j]);
        for (const [i, j] of edges) {
          const o = (at(i, j) - baseVertex) * TERRAIN_FLOATS_PER_VERTEX;
          const vi = baseVertex * TERRAIN_FLOATS_PER_VERTEX + o;
          verts.push(verts[vi]!, verts[vi + 1]! - SKIRT, verts[vi + 2]!, verts[vi + 3]!, verts[vi + 4]!, verts[vi + 5]!);
        }
        const m = edges.length;
        for (let k = 0; k < m; k++) {
          const [i0, j0] = edges[k]!;
          const [i1, j1] = edges[(k + 1) % m]!;
          const top0 = at(i0, j0) - baseVertex;
          const top1 = at(i1, j1) - baseVertex;
          const low0 = skirtBase + k - baseVertex;
          const low1 = skirtBase + ((k + 1) % m) - baseVertex;
          idx.push(top0, low0, top1, top1, low0, low1);
        }
        lods.push({ first, count: idx.length - first, baseVertex });
      }
      const cx = x0 + span / 2;
      const cz = z0 + span / 2;
      tiles.push({ x0, z0, cx, cz, radius: Math.hypot(span / 2, span / 2, (top - bottom) / 2) + 10, lods });
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx), tiles };
}

/** Which level of detail a tile is drawn at, from its distance to the camera (metres to the nearest of its centre and the camera). */
export function lodForDistance(distance: number, radius: number): number {
  const d = Math.max(distance - radius * 0.7, 0);
  return d < 2400 ? 0 : d < 6500 ? 1 : 2;
}
