import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const functionSource = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const context = vm.createContext({ THREE });
vm.runInContext([
  ...['tangentBasis', 'offsetSurfaceDir', 'propFacing', 'canonicalMapYaw',
    'wrappedAngle', 'normalizePathDirs', 'replacePathPoints', 'migratePaperNeighborhoods']
    .map(functionSource),
  source.slice(source.indexOf('const MAP_CENTER ='), source.indexOf('const DEFAULT_PLAYER_SPAWN_DIR =')),
  source.slice(source.indexOf('const AGENT_DISTRICT_ANCHORS ='), source.indexOf('const DASHBOARD_VIEW_DIR =')),
  source.slice(source.indexOf('function sphericalRing('), source.indexOf('// Home driveways are terrain')),
  'this.api = { migratePaperNeighborhoods, spreadWorldNeighborhoods, migrateRoadJunctions, mapDir, canonicalMapYaw, DEFAULT_LAYOUT, HARBOR_MAIN_STREET_POINTS, HARBOR_HARBOR_AXIS_POINTS };',
].join('\n'), context);
const { migratePaperNeighborhoods: migrate, mapDir, canonicalMapYaw, DEFAULT_LAYOUT } = context.api;
const plain = (value) => JSON.parse(JSON.stringify(value));

function junctionSeed() {
  return [
    { type: 'opsBeacon', x: 0, z: 0.10, scale: 0.68 },
    { type: 'cottage', ownerKey: 'rodi', n: [0, 0.96, 0.28], yaw: Math.PI, scale: 0.64, wall: 0xabcdef },
    ...['road', 'streetEdge'].flatMap((type) => [
      { kind: 'path', type, points: context.api.HARBOR_MAIN_STREET_POINTS },
      { kind: 'path', type, points: context.api.HARBOR_HARBOR_AXIS_POINTS },
    ]),
  ];
}

test('road migration creates four approaches and one ring without changing homes', () => {
  const seed = junctionSeed();
  const before = plain(seed);
  const result = context.api.migrateRoadJunctions(seed);
  assert.deepEqual(plain(seed), before);
  assert.deepEqual(plain(result.filter((p) => p.kind !== 'path')), before.filter((p) => p.kind !== 'path'));
  assert.equal(result.filter((p) => p.type === 'road').length, 5);
  assert.equal(result.filter((p) => p.type === 'streetEdge').length, 5);
  assert.deepEqual(plain(context.api.migrateRoadJunctions(result)), plain(result));
  assert.deepEqual(plain(context.api.migrateRoadJunctions(DEFAULT_LAYOUT)), plain(DEFAULT_LAYOUT));
});

test('road migration preserves custom roads, moved cores and moved homes', () => {
  const changedRoad = plain(junctionSeed());
  changedRoad.find((p) => p.type === 'road').points[0][0] -= 0.1;
  const movedCore = plain(junctionSeed());
  movedCore[0].x = 0.4;
  const movedHome = plain(junctionSeed());
  movedHome[1].n = [0.5, 0.8, 0.3];
  for (const input of [changedRoad, movedCore, movedHome]) {
    assert.deepEqual(plain(context.api.migrateRoadJunctions(input)), input);
  }
});

test('world homes occupy both hemispheres with at least six units between homes', () => {
  const homes = DEFAULT_LAYOUT.filter((p) => p.ownerKey);
  assert.equal(homes.length, 6);
  const front = mapDir(0, 0);
  assert.ok(homes.filter((h) => new THREE.Vector3(...h.n).normalize().dot(front) < 0).length >= 3);
  const positions = homes.map((h) => new THREE.Vector3(...h.n).normalize());
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      assert.ok(positions[i].angleTo(positions[j]) * 7.47 >= 6,
        `${homes[i].ownerKey}/${homes[j].ownerKey}`);
    }
  }
});

test('global redistribution moves owned homes once and keeps appearance and custom props', () => {
  const before = [{ type: 'cottage', ownerKey: 'anne', x: 0.48, z: 0.36, scale: 0.77, wall: 0xabcdef },
    { type: 'bench', x: 0.8, z: 0.3, yaw: 0.2 }];
  const result = context.api.spreadWorldNeighborhoods(before);
  assert.ok(new THREE.Vector3(...result[0].n).z < 0);
  assert.equal(result[0].scale, 0.77);
  assert.equal(result[0].wall, 0xabcdef);
  assert.deepEqual(plain(result[1]), before[1]);
  assert.deepEqual(plain(context.api.spreadWorldNeighborhoods(result)), plain(result));
  assert.deepEqual(plain(context.api.spreadWorldNeighborhoods(DEFAULT_LAYOUT)), plain(DEFAULT_LAYOUT));
});

test('the retired shoreline tree is removed without removing relocated trees', () => {
  const result = context.api.spreadWorldNeighborhoods([
    { type: 'coastPine', n: [0.31, -0.38, -0.87] },
    { type: 'coastPine', n: [0.3, 0.9, -0.1] },
  ]);
  assert.equal(result.filter((p) => p.type === 'coastPine').length, 1);
  assert.deepEqual(plain(result.find((p) => p.type === 'coastPine').n), [0.3, 0.9, -0.1]);
});

test('saved homes move to the new neighborhoods while retaining ownership and appearance', () => {
  const original = [{
    type: 'cottage', ownerKey: 'jarvis', n: mapDir(-0.52, -0.02).toArray(),
    yaw: canonicalMapYaw(-0.52, -0.02, 1.56) + 0.15, scale: 0.72, wall: 0xabcdef,
  }];
  const snapshot = plain(original);
  const [result] = migrate(original);
  assert.ok(new THREE.Vector3(...result.n).angleTo(mapDir(-1.08, 0.04)) < 1e-6);
  assert.ok(Math.abs(result.yaw - canonicalMapYaw(-1.08, 0.04, 1.40) - 0.15) < 1e-6);
  assert.equal(result.ownerKey, 'jarvis');
  assert.equal(result.scale, 0.72);
  assert.equal(result.wall, 0xabcdef);
  assert.deepEqual(original, snapshot);
});

test('migration preserves manually relocated homes, props and edited paths', () => {
  const custom = [
    { type: 'cottage', ownerKey: 'anne', n: mapDir(0.4, 1.5).toArray(), yaw: 0.3 },
    { type: 'netRack', x: -0.8, z: -0.30 },
    { kind: 'path', type: 'lane', points: [[-0.30, -0.10], [-0.70, 0.10], [-0.29, 0.34]] },
  ];
  assert.deepEqual(plain(migrate(custom)), custom);
});

test('default decorative placements are removed and saved lane geometry follows homes', () => {
  const result = migrate([
    { type: 'netRack', n: mapDir(-0.94, -0.32).toArray() },
    { kind: 'path', type: 'lane', n: [[-0.30, -0.10], [-0.30, 0.10], [-0.29, 0.34]]
      .map(([x, z]) => mapDir(x, z).toArray().map((v) => +v.toFixed(4))) },
  ]);
  assert.equal(result.length, 1);
  assert.ok(new THREE.Vector3(...result[0].n[2]).angleTo(mapDir(-0.88, 0.64)) < 1e-6);
  assert.deepEqual(plain(migrate(result)), plain(result));
});

test('the current default layout is unchanged by migration', () => {
  assert.deepEqual(plain(migrate(DEFAULT_LAYOUT)), plain(DEFAULT_LAYOUT));
});

test('paper foundations follow uneven ground and replace geometry when homes move', () => {
  const local = vm.createContext({ THREE, toonMat: (color) => new THREE.MeshToonMaterial({ color }),
    terrainRadius: (dir) => 7.47 + 0.3 * Math.sin(dir.x * 8) });
  vm.runInContext(`${functionSource('conformCottageFoundation')}\nthis.conform = conformCottageFoundation;`, local);
  const root = new THREE.Group();
  root.position.set(0, 7.55, 0);
  root.scale.setScalar(0.6);
  local.conform({ mesh: root });
  const skirt = root.userData.foundationSkirt;
  assert.ok(skirt.isMesh && skirt.material.vertexColors);
  assert.ok([...skirt.geometry.attributes.position.array].every(Number.isFinite));
  const before = skirt.geometry;
  let disposed = false;
  before.addEventListener('dispose', () => { disposed = true; });
  root.position.x += 0.5;
  local.conform({ mesh: root });
  assert.equal(root.children.length, 1);
  assert.equal(disposed, true);
  assert.notEqual(skirt.geometry, before);
});
