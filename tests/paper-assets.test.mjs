import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { makePaperHouseShell, makePaperSlab, makePaperRelief, makePaperTierRoof, makePaperTower, makePaperWindowTrim, makePaperDoor } from '../src/world/paper-assets.js';

const materialFactory = (color) => new THREE.MeshToonMaterial({ color });

test('paper asset families batch colored layers into one finite, shadowed mesh', () => {
  const meshes = [
    makePaperHouseShell(materialFactory, { wall: 0xf7f5f0, accent: 0x72c8c5 }),
    makePaperSlab(materialFactory, { width: 2.24, length: 3.74, color: 0x72c8c5 }),
    makePaperRelief(materialFactory, { template: 'stone', color: 0x9ea6aa }),
    makePaperRelief(materialFactory, { template: 'blossom', color: 0xe99591 }),
    makePaperTierRoof(materialFactory, { radius: 0.72, height: 0.62, color: 0x7f79bd }),
    makePaperTower(materialFactory, { bottomRadius: 0.92, topRadius: 0.58, height: 4.3, color: 0xeeeaf2 }),
    makePaperWindowTrim(materialFactory, { accent: 0x72c8c5 }),
    makePaperDoor(materialFactory, { width: 0.82, height: 1.78, color: 0x72c8c5 }),
  ];
  for (const mesh of meshes) {
    assert.ok(mesh.isMesh && mesh.children.length === 0);
    assert.equal(mesh.material.vertexColors, true);
    assert.ok(mesh.castShadow && mesh.receiveShadow);
    assert.equal(mesh.geometry.groups.length, 0);
    for (const name of ['position', 'normal', 'color', 'uv']) {
      assert.ok([...mesh.geometry.attributes[name].array].every(Number.isFinite));
    }
    assert.equal(mesh.geometry.attributes.position.count, mesh.geometry.attributes.color.count);
    assert.ok(mesh.geometry.attributes.position.count < 15000);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});

test('window surrounds leave clear panes on all five windows and batch their trim', () => {
  const mesh = makePaperWindowTrim(materialFactory, { accent: 0x72c8c5 });
  mesh.updateMatrixWorld(true);
  assert.equal(mesh.userData.windowCount, 5);
  const ray = (x, y) => new THREE.Raycaster(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1)).intersectObject(mesh);
  assert.ok(ray(1.32, 1.65).every((hit) => hit.point.z < 0));
  assert.ok(ray(1.12, 1.45).some((hit) => hit.point.z > 1.7));
  assert.equal(mesh.children.length, 0);
});

test('detailed doors retain the exact door size and creased roofs remain one mesh', () => {
  for (const [width, height] of [[0.82, 2.15], [0.80, 1.70]]) {
    const door = makePaperDoor(materialFactory, { width, height, color: 0x52646b });
    door.geometry.computeBoundingBox();
    const size = door.geometry.boundingBox.getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.x - width) < 1e-6);
    assert.ok(Math.abs(size.y - height) < 1e-6);
    assert.ok(size.z < 0.16);
  }
  const plain = makePaperSlab(materialFactory, { width: 2.24, length: 3.74, color: 0x52646b });
  const folded = makePaperSlab(materialFactory, { width: 2.24, length: 3.74, color: 0x52646b, folds: 3 });
  assert.ok(folded.geometry.attributes.position.count > plain.geometry.attributes.position.count);
  assert.equal(folded.children.length, 0);
  assert.equal(folded.geometry.groups.length, 0);
});

test('cottage shell has real window cutouts and an open doorway within the existing footprint', () => {
  const mesh = makePaperHouseShell(materialFactory, { wall: 0xf7f5f0, accent: 0x72c8c5 });
  mesh.updateMatrixWorld(true);
  const cast = (x, y) => new THREE.Raycaster(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1)).intersectObject(mesh);
  assert.ok(cast(1.12, 1.45).every((hit) => hit.point.z < 0), 'front window must be a hole, not a painted rectangle');
  assert.ok(cast(0, 0.9).every((hit) => hit.point.z < 0), 'doorway stays open through every card layer');
  assert.ok(cast(0, 2.12).every((hit) => hit.point.z < 0), 'the enlarged door must not be painted over a wall');
  assert.ok(cast(1.12, 2.1).some((hit) => hit.point.z > 1.5), 'wall above the window is solid');
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox;
  assert.ok(bounds.min.x >= -1.86 && bounds.max.x <= 1.86);
  assert.ok(bounds.min.z >= -1.75 && bounds.max.z <= 1.75);
  assert.equal(mesh.userData.cutWindows, 5);
});

test('paper reliefs and roofs preserve thickness and contain distinct face and edge colors', () => {
  for (const mesh of [
    makePaperRelief(materialFactory, { template: 'hull', color: 0x467688 }),
    makePaperSlab(materialFactory, { width: 2, length: 3, color: 0xe8896b }),
  ]) {
    const colors = mesh.geometry.attributes.color;
    const unique = new Set(Array.from({ length: colors.count }, (_, i) => [colors.getX(i), colors.getY(i), colors.getZ(i)].join(',')));
    assert.ok(unique.size >= 3);
    mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
    assert.ok(size.x > 0 && size.y > 0 && size.z > 0);
    assert.ok(mesh.userData.paperLayers >= 3);
  }
});
