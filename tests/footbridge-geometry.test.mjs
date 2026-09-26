import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { mergeGeometries } from '../vendor/three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeFootbridge } from '../src/world/footbridge.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
// Use the production spline, terrain, ribbon, placement and geometry batching.
// Paper-shadow styling is unrelated to placement and needs the live renderer.
const context = vm.createContext({ THREE, mergeGeometries, R: 7.47, TERRAIN_RELIEF: 0.38,
  stabilizePaperShadows() {},
});
vm.runInContext(['tangentBasis', 'offsetSurfaceDir', 'terrainRadius', 'placeOnSphereFacing',
  'slerpDir', 'splineDirs', 'makeSurfaceRibbon', 'collectRuntimeReferences',
  'materialBatchKey', 'geometryBatchKey', 'batchStaticMeshTree'].map(fn).join('\n'), context);

const direction = (angle) => new THREE.Vector3(Math.sin(angle), Math.cos(angle), 0);
function build(points) {
  const before = [];
  let batchCalls = 0;
  const group = makeFootbridge(points, {
    radius: context.R,
    terrainRadius: context.terrainRadius,
    materialFactory: (color) => new THREE.MeshBasicMaterial({ color }),
    splineDirs: context.splineDirs,
    makeSurfaceRibbon: context.makeSurfaceRibbon,
    offsetSurfaceDir: context.offsetSurfaceDir,
    placeOnSphereFacing: context.placeOnSphereFacing,
    batchStaticMeshTree(root) {
      batchCalls++;
      for (const mesh of root.children) {
        before.push({ mesh, position: mesh.position.clone(), scale: mesh.scale.clone() });
      }
      return context.batchStaticMeshTree(root);
    },
  });
  return { group, before, batchCalls };
}

test('a long two-point bridge stays on the terrain instead of cutting a chord through the planet', () => {
  const points = [direction(-0.65), direction(0.65)];
  const { group, before, batchCalls } = build(points);
  const deck = before.find(({ mesh }) => mesh.material.color.getHex() === 0xb48b5e
    && !mesh.geometry.getAttribute('uv')).mesh;
  const positions = deck.geometry.getAttribute('position');
  assert.ok(positions.count > 300);
  for (let i = 0; i < positions.count; i++) {
    const position = new THREE.Vector3().fromBufferAttribute(positions, i);
    assert.ok(Math.abs(position.length() - context.terrainRadius(position) - 0.115) < 1e-6);
  }
  const columns = 11;
  const first = new THREE.Vector3().fromBufferAttribute(positions, 5).normalize();
  const last = new THREE.Vector3().fromBufferAttribute(positions, positions.count - columns + 5).normalize();
  assert.ok(first.distanceTo(points[0]) < 1e-6);
  assert.ok(last.distanceTo(points[1]) < 1e-6);
  const mid = new THREE.Vector3().fromBufferAttribute(positions, Math.floor(positions.count / columns / 2) * columns + 5);
  const chord = points[0].clone().add(points[1]).multiplyScalar((context.R + 0.115) / 2);
  assert.ok(mid.distanceTo(chord) > 1);
  assert.equal(batchCalls, 1);
  assert.ok(group.children.length <= 5);
});

test('rails stay on the two sides, posts follow the terrain, and both entrances remain open', () => {
  const { before } = build([direction(-0.65), direction(0.65)]);
  const boxes = before.filter(({ mesh }) => mesh.geometry.type === 'BoxGeometry');
  assert.ok(boxes.length > 100);
  for (const { position } of boxes) {
    // This path lies in z=0; every raised structure must stay at a side edge.
    assert.ok(Math.abs(position.clone().normalize().z) * context.R > 0.45);
    assert.ok(Math.abs(Math.atan2(position.x, position.y)) < 0.65);
  }
  const posts = boxes.filter(({ scale }) => scale.y === 0.43 && scale.x === 0.065);
  const left = posts.filter(({ position }) => position.z < 0);
  assert.ok(left.length >= 15);
  for (let i = 0; i < left.length; i++) {
    const p = left[i].position;
    assert.ok(Math.abs(p.length() - context.terrainRadius(p) - 0.115 - 0.43 / 2) < 1e-10);
    if (!i) continue;
    const previous = left[i - 1].position;
    const spacing = Math.abs(Math.atan2(p.x, p.y) - Math.atan2(previous.x, previous.y)) * context.R;
    assert.ok(spacing > 0.5 && spacing < 0.7, `${spacing}`);
  }
});

test('curved edited paths preserve their inputs and bound geometry and draw calls', () => {
  const points = Array.from({ length: 120 }, (_, i) =>
    new THREE.Vector3(Math.sin(i * 0.08), Math.cos(i * 0.08), Math.sin(i * 0.23) * 0.3).normalize());
  const originals = points.map((p) => p.toArray());
  const { group, before } = build(points);
  assert.deepEqual(points.map((p) => p.toArray()), originals);
  assert.ok(before.length <= 790, `${before.length} temporary pieces`);
  assert.ok(group.children.length <= 5, `${group.children.length} draw calls`);
  group.traverse((mesh) => {
    if (!mesh.isMesh) return;
    assert.ok(Array.from(mesh.geometry.getAttribute('position').array).every(Number.isFinite));
  });
});

test('an unfinished or zero-length path emits no bridge geometry', () => {
  for (const points of [[], [direction(0)], [direction(0), direction(0)]]) {
    const { group, batchCalls } = build(points);
    assert.equal(group.children.length, 0);
    assert.equal(batchCalls, 0);
  }
});
