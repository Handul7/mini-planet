import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const extract = (name) => {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};

test('door projection tracks edited parents without updating decorative descendants', () => {
  const ctx = vm.createContext({});
  vm.runInContext(extract('homeDoorDir'), ctx);
  const parent = new THREE.Group(), mesh = new THREE.Group();
  parent.add(mesh);
  mesh.userData.doorOffset = new THREE.Vector3(0, 0, 1.28);
  const home = { mesh, dir: new THREE.Vector3(0, 1, 0) };
  let descendantUpdates = 0;
  for (let i = 0; i < 100; i++) {
    const child = new THREE.Group();
    const original = child.updateMatrixWorld;
    child.updateMatrixWorld = function (...args) { descendantUpdates++; return original.apply(this, args); };
    mesh.add(child);
  }
  for (let i = 0; i < 60; i++) {
    parent.position.set(i / 10, 4, 1); parent.rotation.y = i / 20;
    mesh.scale.setScalar(0.7 + i / 100); mesh.rotation.x = i / 50;
    const current = ctx.homeDoorDir(home);
    mesh.updateMatrixWorld(true);
    const reference = mesh.localToWorld(mesh.userData.doorOffset.clone()).normalize();
    assert.ok(current.distanceTo(reference) < 1e-10);
  }
  assert.equal(descendantUpdates, 6000, 'only the reference path traverses 100 descendants per call');
  assert.equal(ctx.homeDoorDir(null), null);
});

test('one clearance scan preserves the former recovery predicates', () => {
  const colliders = [{ dir: new THREE.Vector3(0, 1, 0), radius: 0.17 },
    { dir: new THREE.Vector3(1, 0, 0), radius: 0.08 }];
  const ctx = vm.createContext({ getSurfaceColliders: () => colliders });
  vm.runInContext(extract('hasSurfaceClearance') + '\n' + extract('surfaceColliderClearance'), ctx);
  for (let i = 0; i < 1000; i++) {
    const dir = new THREE.Vector3(Math.sin(i * 0.7), Math.cos(i * 0.43), Math.sin(i * 0.17)).normalize();
    assert.equal(ctx.hasSurfaceClearance(dir, 0.026), ctx.surfaceColliderClearance(dir) >= 0.026);
  }
  const recovery = source.slice(source.indexOf('  const playerClearance ='), source.indexOf('  let needsRecovery ='));
  assert.equal((recovery.match(/surfaceColliderClearance\(/g) || []).length, 1);
  assert.doesNotMatch(recovery, /hasSurfaceClearance\(/);
});

test('label obstacles reuse DOM references and hidden decoration skips visual work only', () => {
  assert.doesNotMatch(extract('addLabelUiObstacles'), /querySelector/);
  const ambient = extract('updateAmbientScene');
  assert.match(ambient, /if \(!marker.parent\?\.visible\) continue/);
  assert.match(ambient, /if \(poleRose.visible\)/);
  assert.match(source, /updateNPCs\(dt\);/);
});
