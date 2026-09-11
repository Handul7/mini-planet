import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/build/three.module.min.js';

import {
  makeCottageArchitecture,
  makeHedgeLine,
  makeQuayRail,
  makeStreetEdges,
  splitBoundaryRuns,
} from '../src/world/harbor-kit.js';

const material = () => new THREE.MeshBasicMaterial({ color: 0xffffff });
const directions = [
  new THREE.Vector3(-0.12, 0.72, 0.68).normalize(),
  new THREE.Vector3(0, 0.72, 0.69).normalize(),
  new THREE.Vector3(0.12, 0.72, 0.68).normalize(),
];
const splineDirs = (points) => ({ dirs: points.map((point) => point.clone()) });
const terrainRadius = () => 7.47;

test('all five cottages have distinct architecture silhouettes', () => {
  const common = {
    wallMaterial: material(), roofMaterial: material(), edgeMaterial: material(), glassMaterial: material(),
  };
  const profiles = [
    makeCottageArchitecture({ ...common, ownerKey: 'rodi' }),
    makeCottageArchitecture({ ...common, ownerKey: 'jarvis' }),
    makeCottageArchitecture({ ...common, ownerKey: 'anne' }),
    makeCottageArchitecture({ ...common, ownerKey: 'yul' }),
    makeCottageArchitecture({ ...common, ownerKey: 'ludwig' }),
  ];
  assert.deepEqual(
    profiles.map((group) => group.userData.architectureProfile),
    ['signal-house', 'memory-control-house', 'green-gables-atelier', 'resonance-sawtooth-workshop', 'moon-vault-library'],
  );
  const bounds = profiles.map((group) => {
    group.traverse((mesh) => {
      if (!mesh.isMesh) return;
      assert.ok(mesh.geometry.attributes.position.count > 0);
      assert.ok(Array.from(mesh.geometry.attributes.position.array).every(Number.isFinite));
    });
    return new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3()).toArray();
  });
  assert.equal(new Set(bounds.map((b) => b.map((n) => n.toFixed(2)).join(','))).size, 5);
});

test('curb openings split geometry instead of drawing across an entrance', () => {
  const points = Array.from({length: 9}, (_, i) => new THREE.Vector3((i - 4) * 0.04, 1, 0).normalize());
  const runs = splitBoundaryRuns(points, (dir) => Math.abs(dir.x) < 0.025);
  assert.equal(runs.length, 2);
  assert.ok(runs[0].every((p) => p.x < 0));
  assert.ok(runs[1].every((p) => p.x > 0));
  assert.deepEqual(splitBoundaryRuns(points, () => true), []);
  assert.equal(splitBoundaryRuns(points, () => false).length, 1);
});

test('fully open boundaries emit no leftover curb geometry', () => {
  const edges = makeStreetEdges(directions, { radius: 7.47, roadWidth: 0.9, splineDirs,
    materialFactory: material, isOpening: () => true,
    makeSurfaceRibbon: () => { throw Error('an open boundary must not create a ribbon'); },
  });
  assert.equal(edges.children.length, 0);
});

test('street boundaries merge both sides into two material batches', () => {
  const makeSurfaceRibbon = (_points, { material: ribbonMaterial }) =>
    new THREE.Mesh(new THREE.PlaneGeometry(1, 0.1, 2, 1), ribbonMaterial);
  const edges = makeStreetEdges(directions, {
    radius: 7.47,
    roadWidth: 0.9,
    splineDirs,
    makeSurfaceRibbon,
    materialFactory: material,
  });
  assert.equal(edges.children.length, 2);
  assert.equal(edges.userData.districtRole, 'street-boundary');
  assert.ok(edges.children.every((child) => child.geometry.attributes.position.count > 0));
});

test('hedges and quay rails batch repeated street infrastructure', () => {
  const hedge = makeHedgeLine(directions, {
    radius: 7.47, terrainRadius, splineDirs, materialFactory: material,
  });
  const rail = makeQuayRail(directions, {
    radius: 7.47, terrainRadius, splineDirs, materialFactory: material,
  });
  assert.equal(hedge.isInstancedMesh, true);
  assert.equal(hedge.count, directions.length);
  assert.equal(rail.children.length, 2);
  assert.equal(rail.userData.districtRole, 'quay-rail');
});
