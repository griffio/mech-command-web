// Terrain heightfield, colour map and water, matching mclib/terrain.cpp,
// mclib/mapdata.cpp and mclib/quad.cpp.
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  RepeatWrapping,
  ShadowMaterial,
  type Texture,
} from 'three';
import type { MapInfo } from './assets.ts';

export class Terrain {
  readonly side: number;
  readonly spacing: number;
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  /**
   * The ground is unlit (its lighting is baked into the colour map), so it can't
   * receive shadows itself. This transparent copy draws only the shadows cast by
   * buildings, trees and units on top of it. The terrain never casts: its own
   * shadows are already in the colour map.
   */
  readonly shadowLayer: Mesh<BufferGeometry, ShadowMaterial>;
  readonly water: Mesh<BufferGeometry, MeshBasicMaterial> | null = null;
  readonly detailStrength = { value: 0.6 };
  private readonly half: number;

  constructor(
    readonly info: MapInfo,
    readonly elevation: Float32Array,
    textures: { colormap: Texture; detail: Texture | null; water: Texture | null },
  ) {
    this.side = info.side;
    this.spacing = info.worldUnitsPerVertex;
    this.half = info.side / 2;
    this.mesh = this.buildGround(textures.colormap, textures.detail);
    this.shadowLayer = new Mesh(
      this.mesh.geometry,
      new ShadowMaterial({ opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
    );
    this.shadowLayer.name = 'terrain-shadows';
    this.shadowLayer.receiveShadow = true;
    this.shadowLayer.renderOrder = 0.5; // after the ground, before the water
    if (textures.water) this.water = this.buildWater(textures.water);
  }

  /** Ground height at MC2 world (x, y), using the engine's alternating quad split. */
  heightAt(x: number, y: number): number {
    const fc = Math.min(Math.max(x / this.spacing + this.half, 0), this.side - 1.0001);
    const fr = Math.min(Math.max(this.half - y / this.spacing, 0), this.side - 1.0001);
    const c = Math.floor(fc);
    const r = Math.floor(fr);
    const fx = fc - c;
    const fy = fr - r;
    const tl = this.h(r, c);
    const tr = this.h(r, c + 1);
    const bl = this.h(r + 1, c);
    const br = this.h(r + 1, c + 1);
    if (((r + c) & 1) === 0) {
      // Diagonal from top-left to bottom-right.
      return fx >= fy ? tl + (tr - tl) * fx + (br - tr) * fy : tl + (bl - tl) * fy + (br - bl) * fx;
    }
    // Diagonal from top-right to bottom-left.
    return fx + fy <= 1 ? tl + (tr - tl) * fx + (bl - tl) * fy : br + (bl - br) * (1 - fx) + (tr - br) * (1 - fy);
  }

  /** Ground height under a three.js (x, z) position. */
  heightAtThree(x: number, z: number): number {
    return this.heightAt(x, -z);
  }

  isUnderwater(x: number, y: number): boolean {
    return this.heightAt(x, y) < this.info.water.elevation;
  }

  update(dt: number) {
    const map = this.water?.material.map;
    if (map) {
      map.offset.x = (map.offset.x + dt * 0.01) % 1;
      map.offset.y = (map.offset.y + dt * 0.006) % 1;
    }
  }

  private h(r: number, c: number): number {
    return this.elevation[r * this.side + c];
  }

  /** Vertex (r, c) sits at world x = (c - side/2) * 128, y = (side/2 - r) * 128. */
  private gridPositions(height: (r: number, c: number) => number): Float32Array {
    const { side, spacing, half } = this;
    const pos = new Float32Array(side * side * 3);
    for (let r = 0; r < side; r++) {
      for (let c = 0; c < side; c++) {
        const i = (r * side + c) * 3;
        pos[i] = (c - half) * spacing;
        pos[i + 1] = height(r, c);
        pos[i + 2] = (r - half) * spacing; // three z = -world y
      }
    }
    return pos;
  }

  /** Two counter-clockwise (seen from above) triangles per quad, split like the engine. */
  private quadIndices(include: (r: number, c: number) => boolean): Uint32Array {
    const { side } = this;
    const idx: number[] = [];
    for (let r = 0; r < side - 1; r++) {
      for (let c = 0; c < side - 1; c++) {
        if (!include(r, c)) continue;
        const tl = r * side + c;
        const tr = tl + 1;
        const bl = tl + side;
        const br = bl + 1;
        if (((r + c) & 1) === 0) idx.push(tl, bl, br, tl, br, tr);
        else idx.push(tl, bl, tr, tr, bl, br);
      }
    }
    return new Uint32Array(idx);
  }

  private uvs(scale: number): Float32Array {
    const { side } = this;
    const uv = new Float32Array(side * side * 2);
    for (let r = 0; r < side; r++) {
      for (let c = 0; c < side; c++) {
        // The colour map spans side * 128 world units, so the last vertex is at 0.99.
        uv[(r * side + c) * 2] = (c / side) * scale;
        uv[(r * side + c) * 2 + 1] = 1 - (r / side) * scale;
      }
    }
    return uv;
  }

  private buildGround(colormap: Texture, detail: Texture | null) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.gridPositions((r, c) => this.h(r, c)), 3));
    geometry.setAttribute('uv', new BufferAttribute(this.uvs(1), 2));
    geometry.setIndex(new BufferAttribute(this.quadIndices(() => true), 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    // The colour map is pre-lit (baked shadows), so the ground is unlit.
    const material = new MeshBasicMaterial({ map: colormap });
    if (detail && this.info.detail) {
      detail.wrapS = detail.wrapT = RepeatWrapping;
      const tiling = this.info.detail.tiling;
      material.onBeforeCompile = (shader) => {
        shader.uniforms.detailMap = { value: detail };
        shader.uniforms.detailStrength = this.detailStrength;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;\nuniform float detailStrength;')
          .replace(
            '#include <map_fragment>',
            `#include <map_fragment>
            vec3 detailColor = texture2D(detailMap, vMapUv * ${tiling.toFixed(1)}).rgb;
            diffuseColor.rgb *= mix(vec3(1.0), detailColor * 2.0, detailStrength);`,
          );
      };
    }
    const mesh = new Mesh(geometry, material);
    mesh.name = 'terrain';
    return mesh;
  }

  private buildWater(texture: Texture) {
    const { side } = this;
    const { elevation: level, alphaDepth, alpha } = this.info.water;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.gridPositions(() => level), 3));
    geometry.setAttribute('uv', new BufferAttribute(this.uvs(this.info.water.texture?.tiling ?? 48), 2));

    // Per-vertex opacity by depth below the surface (mclib/quad.cpp).
    const colors = new Float32Array(side * side * 4);
    for (let i = 0; i < side * side; i++) {
      const e = this.elevation[i];
      const a = e >= level - alphaDepth ? alpha[0] : e <= level - alphaDepth * 3 ? alpha[2] : alpha[1];
      colors.set([1, 1, 1, a], i * 4);
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 4));
    const wet = (r: number, c: number) => this.h(r, c) < level;
    geometry.setIndex(
      new BufferAttribute(this.quadIndices((r, c) => wet(r, c) || wet(r, c + 1) || wet(r + 1, c) || wet(r + 1, c + 1)), 1),
    );
    geometry.computeBoundingSphere();

    texture.wrapS = texture.wrapT = RepeatWrapping;
    const material = new MeshBasicMaterial({ map: texture, vertexColors: true, transparent: true, depthWrite: false });
    const mesh = new Mesh(geometry, material);
    mesh.name = 'water';
    mesh.renderOrder = 1;
    return mesh;
  }
}
