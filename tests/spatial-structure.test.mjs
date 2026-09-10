import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { oceanBandBounds, streetNetworkState, findSurfaceRoute } from '../src/world/spatial-structure.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const context = vm.createContext({ THREE });
vm.runInContext([
  ...['tangentBasis', 'offsetSurfaceDir', 'propFacing', 'canonicalMapYaw', 'wrappedAngle',
    'normalizePathDirs', 'replacePathPoints', 'migratePaperNeighborhoods', 'pathIdentity'].map(fn),
  source.slice(source.indexOf('const MAP_CENTER ='), source.indexOf('const DEFAULT_PLAYER_SPAWN_DIR =')),
  source.slice(source.indexOf('const AGENT_DISTRICT_ANCHORS ='), source.indexOf('const DASHBOARD_VIEW_DIR =')),
  source.slice(source.indexOf('function sphericalRing('), source.indexOf('// Home driveways are terrain')),
  `this.before = migrateVillageBoard(migrateSharedHarbor(migrateRoadJunctions(spreadWorldNeighborhoods([
    ...HARBOR_TERRAIN_LAYOUT, ...HARBOR_DISTRICT_INFRASTRUCTURE, ...HARBOR_FRONT_LAYOUT, ...HARBOR_REAR_LAYOUT]))));`,
].join('\n'), context);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('structure migration preserves six houses, scale, all props except the known ferry gate', () => {
  const before = plain(context.before);
  const result = plain(context.migrateSpatialStructure(before));
  assert.deepEqual(before, plain(context.before));
  for (const prop of before.filter((p) => p.kind !== 'path' && p.type !== 'ferryGate')) {
    assert.ok(result.some((p) => JSON.stringify(p) === JSON.stringify(prop)), prop.type);
  }
  assert.equal(result.filter((p) => p.kind !== 'path').length, before.filter((p) => p.kind !== 'path').length);
  assert.equal(result.filter((p) => p.id?.endsWith('.forecourt')).length, 5);
  assert.equal(result.filter((p) => p.id === 'core.promenade').length, 1);
  assert.deepEqual(plain(context.migrateSpatialStructure(result)), result);
});

test('custom homes, gates and hand-drawn forecourts are not overwritten', () => {
  const before = plain(context.before);
  const house = before.find((p) => p.ownerKey === 'ludwig');
  house.n = [0.1, 0.9, -0.4];
  const gate = before.find((p) => p.type === 'ferryGate');
  gate.n = [0.8, 0.5, 0.2]; delete gate.x; delete gate.z;
  const jarvis = before.find((p) => p.ownerKey === 'jarvis');
  const custom = { kind: 'path', type: 'courtyard', n: [jarvis.n, [-0.8, 0.5, 0.2], [-0.9, 0.4, 0.3]] };
  before.push(custom);
  const result = plain(context.migrateSpatialStructure(before));
  assert.deepEqual(result.find((p) => p.ownerKey === 'ludwig'), house);
  assert.deepEqual(result.find((p) => p.type === 'ferryGate'), gate);
  assert.ok(result.some((p) => JSON.stringify(p) === JSON.stringify(custom)));
  assert.ok(!result.some((p) => ['ludwig.forecourt', 'jarvis.forecourt'].includes(p.id)));
});

test('path IDs are constrained and survive serialization without exposing arbitrary data', () => {
  assert.deepEqual(plain(context.pathIdentity({ id: 'core.promenade', districtId: 'core', html: '<script>' })),
    { id: 'core.promenade', districtId: 'core' });
  assert.deepEqual(plain(context.pathIdentity({ id: '<script>', districtId: 'x'.repeat(65) })), {});
  context.editablePaths = [{ data: { type: 'road', id: 'core.promenade', districtId: 'core', dirs: [new THREE.Vector3(0, 1, 0)] } }];
  context.editables = [];
  context._r4 = (n) => +n.toFixed(4);
  vm.runInContext(fn('serializeLayout'), context);
  assert.deepEqual(plain(context.serializeLayout()), [{ kind: 'path', type: 'road', id: 'core.promenade', districtId: 'core', n: [[0, 1, 0]] }]);
});

test('shoreline is periodic, bounded and retains its mean ocean coverage', () => {
  let width = 0;
  for (let i = 0; i < 512; i++) {
    const angle = i / 512 * Math.PI * 2;
    const a = oceanBandBounds(angle), b = oceanBandBounds(angle + Math.PI * 2);
    assert.ok(Math.abs(a.min - b.min) < 1e-12 && Math.abs(a.max - b.max) < 1e-12);
    assert.ok(a.min > -0.76 && a.min < -0.64 && a.max > 0.13 && a.max < 0.27);
    width += a.max - a.min;
  }
  assert.ok(Math.abs(width / 512 - 0.90) < 1e-10);
});

test('water mesh edge and zone classification use the same contoured boundary', () => {
  const local = vm.createContext({ THREE, oceanBandBounds, terrainRadius: () => 7.47 });
  vm.runInContext([fn('makeLatitudeBand'), fn('zoneContains')].join('\n'), local);
  const mesh = local.makeLatitudeBand(-0.70, 0.20, { contoured: true, material: new THREE.MeshBasicMaterial() });
  const positions = mesh.geometry.getAttribute('position');
  for (const row of [0, 48]) for (let i = 0; i <= 128; i++) {
    const dir = new THREE.Vector3().fromBufferAttribute(positions, row * 129 + i).normalize();
    const bounds = oceanBandBounds(Math.atan2(dir.z, dir.x));
    assert.ok(Math.abs(dir.y - (row ? bounds.max : bounds.min)) < 1e-6);
    const center = new THREE.Vector3(dir.x, (bounds.min + bounds.max) / 2, dir.z).normalize();
    assert.equal(local.zoneContains({ band: { minY: -0.70, maxY: 0.20, contoured: true } }, center), true);
  }
  mesh.geometry.dispose(); mesh.material.dispose();
});

test('street graph detects disconnected saved streets, not only blocked road samples', () => {
  const a = new THREE.Vector3(0, 1, 0), b = new THREE.Vector3(0.1, 1, 0).normalize();
  assert.equal(streetNetworkState([[a, b], [b, new THREE.Vector3(0.2, 1, 0).normalize()]]).connected, true);
  assert.equal(streetNetworkState([[a, b], [a.clone().negate()]]).connected, false);
  assert.equal(streetNetworkState([]).connected, false);
});

test('surface route goes around forbidden land and rejects disconnected water', () => {
  const start = new THREE.Vector3(1, 0, 0), end = new THREE.Vector3(-1, 0, 0);
  const allowed = (p) => p.lengthSq() > 0.99 && p.y < 0.25;
  const route = findSurfaceRoute(start, end, allowed);
  assert.ok(route?.length > 2);
  assert.ok(route.every(allowed));
  assert.ok(route[0].distanceTo(start) < 1e-10 && route.at(-1).distanceTo(end) < 1e-10);
  assert.equal(findSurfaceRoute(start, end, (p) => Math.abs(p.x) > 0.8), null);
});

test('boarding QA checks the actual pier and restores the saved state even after failure', () => {
  const start = source.indexOf('    testHarborJourney()');
  const journey = source.slice(start, source.indexOf('    testBoatLifecycle()', start));
  assert.match(journey, /nearestBoardableBoat\(\) === boat/);
  assert.match(journey, /tryMovePlayerOnSurface/);
  assert.match(journey, /finally/);
  assert.match(journey, /boat\.data\.dir\.copy\(original\.boat\)/);
  assert.match(journey, /stages\.walkHome/);
});

test('composition moves one public space, keeps every home, and creates an independent rose approach', () => {
  const before = plain(context.migrateSpatialStructure(plain(context.before)));
  const result = plain(context.migrateVillageComposition(before));
  const dir = (p) => new THREE.Vector3(...p.n).normalize();
  for (const house of before.filter((p) => p.ownerKey)) {
    assert.deepEqual(result.find((p) => p.ownerKey === house.ownerKey), house);
  }
  const pavilion = result.find((p) => p.type === 'civicPavilion');
  assert.ok(dir(pavilion).angleTo(new THREE.Vector3(0.10, 0.52, -0.85).normalize()) < 1e-6);
  for (const key of ['ludwig', 'anne']) {
    assert.ok(dir(pavilion).angleTo(dir(result.find((p) => p.ownerKey === key))) * 7.47 > 3.5);
  }
  assert.equal(result.find((p) => p.id === 'rose.quiet-garden').type, 'courtyard');
  assert.equal(result.filter((p) => p.id === 'rose.approach').length, 1);
  assert.equal(result.filter((p) => p.kind !== 'path').length, before.filter((p) => p.kind !== 'path').length);
  assert.deepEqual(plain(context.migrateVillageComposition(result)), result);
});

test('composition protects moved public spaces, custom gardens, boats, and occupied destinations', () => {
  const before = plain(context.migrateSpatialStructure(plain(context.before)));
  const pavilion = before.find((p) => p.type === 'civicPavilion');
  pavilion.n = [0.4, 0.8, -0.4];
  const rose = before.find((p) => p.id === 'rose.quiet-garden');
  rose.n[0] = [0.2, 0.95, 0.1];
  const boat = before.find((p) => p.type === 'fishingBoat');
  boat.n = [-0.4, -0.2, 0.9]; delete boat.x; delete boat.z;
  const result = plain(context.migrateVillageComposition(before));
  for (const item of [pavilion, rose, boat]) assert.ok(result.some((p) => JSON.stringify(p) === JSON.stringify(item)));
  assert.ok(!result.some((p) => p.id === 'rose.approach'));
  const blocked = plain(context.migrateSpatialStructure(plain(context.before)));
  blocked.push({ type: 'rock', n: [0.10, 0.52, -0.85] });
  assert.deepEqual(plain(context.migrateVillageComposition(blocked)).find((p) => p.type === 'civicPavilion'),
    blocked.find((p) => p.type === 'civicPavilion'));
});

test('only the reviewed offshore boat and obsolete terrace positions are changed', () => {
  const before = plain(context.migrateSpatialStructure(plain(context.before)));
  const boat = before.find((p) => p.type === 'fishingBoat');
  boat.n = [-0.7627984, -0.4034992, 0.5052989]; delete boat.x; delete boat.z;
  before.push({ type: 'terrace', n: [-0.42039, 0.64069, 0.64249] },
    { type: 'terrace', n: [0.41240, 0.64950, 0.63880] }, { type: 'terrace', n: [0.5, 0.8, 0.3] });
  const result = plain(context.migrateVillageComposition(before));
  assert.equal(result.filter((p) => p.type === 'terrace').length, 1);
  const moved = result.find((p) => p.type === 'fishingBoat');
  assert.equal(moved.scale, boat.scale);
  assert.ok(new THREE.Vector3(...moved.n).angleTo(context.mapDir(-0.28, -0.92)) < 1e-6);
  const customPier = before.filter((p) => p.type !== 'deck');
  assert.deepEqual(plain(context.migrateVillageComposition(customPier)).find((p) => p.type === 'fishingBoat'), boat);
});

test('saved composition is backed up before writing, is one-shot, and fails closed without storage', () => {
  const before = plain(context.migrateSpatialStructure(plain(context.before)));
  const data = new Map();
  const writes = [];
  const local = vm.createContext({ console: { warn() {} },
    migrateVillageComposition: (v) => context.migrateVillageComposition(v),
    LAYOUT_KEY: 'layout', LAYOUT_BACKUP_KEY: 'backup', LAYOUT_SCHEMA_VERSION: 1,
    localStorage: { getItem: (k) => data.get(k) ?? null, setItem(k, v) { writes.push(k); data.set(k, v); } },
  });
  vm.runInContext(fn('migrateSavedComposition'), local);
  const raw = JSON.stringify(before);
  const result = plain(local.migrateSavedComposition(before, raw));
  assert.deepEqual(writes, ['backup', 'layout', 'HandulPlanet_composition_v106']);
  assert.deepEqual(JSON.parse(data.get('backup'))[0].layout, before);
  assert.deepEqual(JSON.parse(data.get('layout')), result);
  assert.deepEqual(plain(local.migrateSavedComposition(before, raw)), before);
  assert.equal(writes.length, 3);
  data.clear();
  local.localStorage.setItem = () => { throw new Error('quota'); };
  assert.deepEqual(plain(local.migrateSavedComposition(before, raw)), before);
});

test('marker failure cannot diverge the rendered composition from its saved layout', () => {
  const before = plain(context.migrateSpatialStructure(plain(context.before)));
  const data = new Map();
  const local = vm.createContext({ console: { warn() {} },
    migrateVillageComposition: (v) => context.migrateVillageComposition(v),
    LAYOUT_KEY: 'layout', LAYOUT_BACKUP_KEY: 'backup', LAYOUT_SCHEMA_VERSION: 1,
    localStorage: { getItem: (k) => data.get(k) ?? null, setItem(k, v) {
      if (k === 'HandulPlanet_composition_v106') throw new Error('quota');
      data.set(k, v);
    } },
  });
  vm.runInContext(fn('migrateSavedComposition'), local);
  const result = plain(local.migrateSavedComposition(before, JSON.stringify(before)));
  assert.deepEqual(result, JSON.parse(data.get('layout')));
  assert.deepEqual(plain(local.migrateSavedComposition(result, JSON.stringify(result))), result);
  assert.equal(JSON.parse(data.get('backup')).length, 1);
});
