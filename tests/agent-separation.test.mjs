import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { createAgentSeparation } from '../src/agent-separation.js';

const radius = 7.47, minDistance = 2.2, hardDistance = 1.1;
const create = () => createAgentSeparation({ radius, minDistance, hardDistance });
const character = (dir) => ({ userData: { dir } });
const direction = (x, y, z) => new THREE.Vector3(x, y, z).normalize();

// Keep the previous allocation-heavy math as an independent behavior oracle.
function reference(dir, neighbors, exclude, player, hard = false) {
  const here = dir.clone().multiplyScalar(radius), away = new THREE.Vector3();
  for (const oDir of neighbors.filter(o => o !== exclude).map(o => o.userData.dir).concat([player])) {
    const other = oDir.clone().multiplyScalar(radius);
    const distance = here.distanceTo(other), limit = hard ? hardDistance : minDistance;
    if (distance >= limit || distance <= 1e-4) continue;
    const tangent = here.clone().sub(other).normalize();
    tangent.sub(dir.clone().multiplyScalar(tangent.dot(dir)));
    if (!hard) away.add(tangent.multiplyScalar((minDistance - distance) / minDistance));
    else if (tangent.lengthSq() > 1e-6) {
      const axis = new THREE.Vector3().crossVectors(dir, tangent.normalize()).normalize();
      dir.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, (hardDistance - distance) / radius)).normalize();
      here.copy(dir.clone().multiplyScalar(radius));
    }
  }
  return hard ? dir : away;
}

test('reusable separation matches the previous math across crowded and polar positions', () => {
  const separation = create();
  for (let i = 0; i < 1600; i++) {
    const center = direction(Math.sin(i * 0.4), Math.cos(i * 0.13), Math.sin(i * 0.17));
    const dirs = Array.from({ length: 6 }, (_, n) => center.clone().add(new THREE.Vector3(
      Math.sin(i + n) * 0.15, Math.cos(i * 0.6 + n) * 0.15, Math.sin(i * 0.7 - n) * 0.15,
    )).normalize());
    const neighbors = dirs.map(character), self = neighbors[i % neighbors.length];
    const player = center.clone();
    const original = self.userData.dir.clone();
    const snapshots = dirs.map(dir => dir.clone());
    assert.ok(separation.steer(original, neighbors, self, player).distanceTo(reference(original, neighbors, self, player)) < 1e-12);
    const expected = reference(original.clone(), neighbors, self, player, true);
    const actual = original.clone();
    separation.resolve(actual, neighbors, self, player);
    assert.ok(actual.distanceTo(expected) < 1e-12);
    assert.ok(Math.abs(actual.length() - 1) < 1e-12);
    dirs.forEach((dir, n) => assert.ok(dir.equals(snapshots[n])));
  }
});

test('separation reuses the output vector and handles coincident or opposite directions', () => {
  const separation = create(), north = direction(0, 1, 0), south = direction(0, -1, 0);
  const self = character(north);
  const result = separation.steer(north, [self], self, north);
  assert.equal(result.lengthSq(), 0);
  assert.equal(separation.steer(north, [self], self, south), result);
  separation.resolve(north, [self], self, north);
  assert.deepEqual(north.toArray(), [0, 1, 0]);
  separation.resolve(north, [], null, south);
  assert.deepEqual(north.toArray(), [0, 1, 0]);
});

test('steady-state separation does not clone vectors or allocate neighbor lists', () => {
  const separation = create(), self = character(direction(0, 1, 0));
  const neighbors = [self, character(direction(0.08, 1, 0.03))];
  const player = direction(-0.06, 1, 0.02);
  neighbors.filter = neighbors.map = () => { throw new Error('temporary neighbor list'); };
  for (const c of neighbors) c.userData.dir.clone = () => { throw new Error('vector clone'); };
  player.clone = () => { throw new Error('player clone'); };
  for (let i = 0; i < 1000; i++) {
    separation.steer(self.userData.dir, neighbors, self, player);
    separation.resolve(self.userData.dir, neighbors, self, player);
  }
  assert.ok(Number.isFinite(self.userData.dir.length()));
});
