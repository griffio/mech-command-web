// Static map objects (buildings, trees, fences...) drawn as one InstancedMesh per
// model material: about a hundred draw calls for the whole map.
import { Euler, Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import { worldToThree, type ObjectsFile } from './assets.ts';
import { loadModel } from './models.ts';

/** `groundAt(x, y)` gives the terrain height at an MC2 world position. */
export async function createProps(objects: ObjectsFile, groundAt: (x: number, y: number) => number): Promise<Group> {
  const group = new Group();
  group.name = 'props';

  const byModel = new Map<number, ObjectsFile['instances']>();
  for (const inst of objects.instances) {
    const list = byModel.get(inst[0]) ?? [];
    list.push(inst);
    byModel.set(inst[0], list);
  }

  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);
  const euler = new Euler();
  const matrix = new Matrix4();

  await Promise.all(
    [...byModel].map(async ([modelIndex, instances]) => {
      const gltf = await loadModel(objects.models[modelIndex]);
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
        const mesh = new InstancedMesh(geometry, o.material, instances.length);
        mesh.name = objects.models[modelIndex];
        mesh.castShadow = mesh.receiveShadow = true;
        instances.forEach(([, x, y, , rot], i) => {
          worldToThree(x, y, groundAt(x, y), position);
          rotation.setFromEuler(euler.set(0, (rot * Math.PI) / 180, 0));
          mesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
        });
        mesh.computeBoundingSphere();
        group.add(mesh);
      });
    }),
  );
  return group;
}
