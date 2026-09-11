import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { segmentOccludedBySphere } from '../src/world/spatial-structure.js';
import { makeStreetPavers, makePlazaPavers } from '../src/world/village-paving.js';

const radius = 7.47;
const materialFactory = (color) => new THREE.MeshBasicMaterial({ color });
const terrainRadius = () => radius;
function tangentBasis(center) {
  const reference = Math.abs(center.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const east = reference.cross(center).normalize();
  return { east, north: center.clone().cross(east).normalize() };
}
const options = { radius, terrainRadius, materialFactory, tangentBasis };
function validatePaving(mesh, lift) {
  const positions = mesh.geometry.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  assert.ok(mesh.userData.paving.tiles > 0);
  assert.equal(positions.count, mesh.userData.paving.tiles * 24);
  for (let i = 0; i < positions.count; i += 3) {
    a.fromBufferAttribute(positions, i); b.fromBufferAttribute(positions, i + 1); c.fromBufferAttribute(positions, i + 2);
    for (const p of [a, b, c]) assert.ok(Math.abs(p.length() - radius - lift) < 1e-5);
    assert.ok(b.sub(a).cross(c.sub(a)).dot(a) > 0, 'all top faces point out of the planet');
  }
  assert.equal(mesh.castShadow, false);
  assert.equal(mesh.receiveShadow, false);
  assert.equal(mesh.material.vertexColors, true);
}

test('plaza paving is outward-facing, surface-conforming and bounded on both hemispheres', () => {
  for (const center of [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0)]) {
    const { east, north } = tangentBasis(center);
    const rim = [[-2, -2], [2, -2], [2, 2], [-2, 2]].map(([x, z]) => center.clone()
      .addScaledVector(east, x / radius).addScaledVector(north, z / radius).normalize());
    const mesh = makePlazaPavers(center, rim, options);
    validatePaving(mesh, 0.163);
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i).normalize();
      assert.ok(Math.abs(p.dot(east) / p.dot(center) * radius) < 2);
      assert.ok(Math.abs(p.dot(north) / p.dot(center) * radius) < 2);
    }
    assert.deepEqual(Array.from(makePlazaPavers(center, rim, options).geometry.attributes.position.array),
      Array.from(mesh.geometry.attributes.position.array));
    assert.ok(makePlazaPavers(center, rim, { ...options, cell: -1 }).userData.paving.tiles <= 420);
  }
});

test('paving handles empty, short and excessively long paths without unbounded detail', () => {
  const splineDirs = (points) => ({ dirs: points });
  const args = { ...options, splineDirs };
  for (const points of [[], [new THREE.Vector3(0, 1, 0)],
    [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.001, 1, 0).normalize()]]) {
    assert.equal(makeStreetPavers(points, args).userData.paving.tiles, 0);
  }
  const points = Array.from({ length: 30 }, (_, i) => new THREE.Vector3(Math.sin(i * 0.025), Math.cos(i * 0.025), 0));
  validatePaving(makeStreetPavers(points, args), 0.162);
  assert.equal(makeStreetPavers(points, { ...args, radius: 1000 }).userData.paving.tiles, 0);
  assert.equal(makePlazaPavers(new THREE.Vector3(0, 1, 0), [], options).userData.paving.tiles, 0);
});

test('near-camera landmark visibility uses the actual sphere, not only a hemisphere dot product', () => {
  const from = new THREE.Vector3(0, 2, 10);
  const hidden = new THREE.Vector3(0, 8, 0);
  assert.ok(from.clone().normalize().dot(hidden.clone().normalize()) > 0.015);
  assert.equal(segmentOccludedBySphere(from, hidden, radius - 0.08), true);
  assert.equal(segmentOccludedBySphere(from, new THREE.Vector3(0, 2, 8), radius - 0.08), false);
  assert.equal(segmentOccludedBySphere(from, from, radius), false);
  assert.equal(segmentOccludedBySphere(new THREE.Vector3(-2, 1, 0), new THREE.Vector3(2, 1, 0), 1), false);
});

test('default exploration camera keeps the visitor small enough to see the village street', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const number = (name) => Number(source.match(new RegExp(`const ${name} = ([\\d.]+)`))[1]);
  for (const [prefix, aspect] of [['', 1280 / 900], ['MOBILE_', 390 / 844]]) {
    const distance = number(`${prefix}EXPLORE_CAM_DIST`), pitch = number(`${prefix}EXPLORE_CAM_PITCH`);
    const camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 1000);
    camera.position.set(0, radius + Math.sin(pitch) * distance, -Math.cos(pitch) * distance);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, radius + number('CHARACTER_WORLD_SCALE') * 0.6, 0.45);
    camera.updateMatrixWorld();
    const foot = new THREE.Vector3(0, radius, 0).project(camera);
    const head = new THREE.Vector3(0, radius + 1.35 * number('CHARACTER_WORLD_SCALE'), 0).project(camera);
    assert.ok(head.y - foot.y < 0.3, 'visitor occupies less than 15% of viewport height');
    const street = new THREE.Vector3(0, Math.cos(0.28), Math.sin(0.28)).multiplyScalar(radius + 0.16).project(camera);
    assert.ok(Math.abs(street.x) < 1 && Math.abs(street.y) < 0.8, 'street ahead stays inside the frame');
  }
  assert.match(source, /camera\.lookAt\(exploreLookTarget\(\)\)/);
  assert.match(source, /&& window\.devPlanet\.worldScaleState\(\)\.pass/);
});
