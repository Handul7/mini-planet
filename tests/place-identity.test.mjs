import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { makeIslandMooring, makePaperGrove, makeWindLookout } from '../src/world/island-places.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const context = vm.createContext({ THREE });
const expression = source.split('const WORLD_DISTRICT_LAYOUT = ')[1].split(';')[0];
vm.runInContext([
  ...['tangentBasis', 'offsetSurfaceDir', 'propFacing', 'canonicalMapYaw', 'wrappedAngle',
    'normalizePathDirs', 'replacePathPoints', 'migratePaperNeighborhoods'].map(fn),
  source.slice(source.indexOf('const MAP_CENTER ='), source.indexOf('const DEFAULT_PLAYER_SPAWN_DIR =')),
  source.slice(source.indexOf('const AGENT_DISTRICT_ANCHORS ='), source.indexOf('const DASHBOARD_VIEW_DIR =')),
  source.slice(source.indexOf('function sphericalRing('), source.indexOf('// Home driveways are terrain')),
  `this.before = ${expression.slice('migratePlaceIdentity('.length, -1)};`,
  'this.api = { migratePlaceIdentity, migrateVillageFrontage, WORLD_DISTRICT_LAYOUT, DEFAULT_LAYOUT, mapDir };',
].join('\n'), context);
const plain = (value) => JSON.parse(JSON.stringify(value));
const migrate = context.api.migratePlaceIdentity;
const seed = () => plain(context.before);
const home = (layout, key) => layout.find((p) => p.ownerKey === key);

test('place migration is immutable and repeatable, with more space beside the rose', () => {
  const before = seed(), snapshot = plain(before), after = migrate(before);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(plain(migrate(after)), plain(after));
  const distance = (layout) => new THREE.Vector3(...home(layout, 'rodi').n).normalize()
    .angleTo(new THREE.Vector3(0, 1, 0)) * 7.47;
  assert.ok(distance(after) > distance(before) + 1.5);
  assert.ok(distance(after) > 3.7);
  for (const key of ['jarvis', 'yul', 'ludwig', 'argos']) assert.deepEqual(plain(home(after, key)), home(before, key));
  assert.equal(home(after, 'anne').roof, 0x3e785b);
  assert.deepEqual(plain(home(after, 'anne').n), home(before, 'anne').n);
  assert.deepEqual(plain(after.filter((p) => p.kind === 'path' && ['sea', 'island', 'openWater'].includes(p.type))),
    before.filter((p) => p.kind === 'path' && ['sea', 'island', 'openWater'].includes(p.type)));
});

test('hand-moved homes, custom roof colors and edited courtyard vertices survive', () => {
  const before = seed();
  home(before, 'rodi').n = [0.4, 0.85, 0.33];
  home(before, 'anne').roof = 0xabcdef;
  const court = before.find((p) => p.id === 'rodi.forecourt');
  court.n[0][0] += 0.03;
  const snapshot = plain(before), after = migrate(before);
  assert.deepEqual(plain(home(after, 'rodi')), home(snapshot, 'rodi'));
  assert.equal(home(after, 'anne').roof, 0xabcdef);
  assert.deepEqual(plain(after.find((p) => p.id === court.id)), snapshot.find((p) => p.id === court.id));
  const stationary = seed();
  stationary.find((p) => p.id === 'rodi.forecourt').n[0][0] += 0.03;
  assert.deepEqual(plain(migrate(stationary).find((p) => p.id === court.id)), stationary.find((p) => p.id === court.id));
  const rotated = seed();
  home(rotated, 'rodi').yaw = 0.7;
  assert.deepEqual(plain(home(migrate(rotated), 'rodi')), home(rotated, 'rodi'));
});

test('occupied sites are not overwritten, and custom lighthouse piers are preserved', () => {
  const before = seed();
  const custom = [{ type: 'bench', n: [0.26, 0.87, 0.4] }, { type: 'bench', n: [0, -1, 0.07] }];
  before.push(...custom);
  const after = migrate(before);
  assert.deepEqual(plain(home(after, 'rodi')), home(before, 'rodi'));
  assert.ok(!after.some((p) => p.id === 'south.garden-loop'));
  for (const p of custom) assert.ok(after.some((a) => JSON.stringify(a) === JSON.stringify(p)));
  const customPier = seed().filter((p) => p.type !== 'deck');
  assert.ok(!migrate(customPier).some((p) => p.id === 'argos.pier-head'));
  const painted = seed();
  painted.push({ kind: 'path', type: 'courtyard', n: [[0, -1, 0], [0.1, -1, 0], [0, -1, 0.1]] });
  assert.ok(!migrate(painted).some((p) => p.id === 'south.garden-loop'));
});

test('south garden and pier extension are added once with a deliberately small prop budget', () => {
  const after = migrate(seed());
  for (const id of ['argos.pier-head', 'south.landing', 'south.arrival', 'south.garden-loop']) {
    assert.equal(after.filter((p) => p.id === id).length, 1);
  }
  assert.equal(after.filter((p) => p.type === 'paperGrove').length, 3);
  assert.equal(after.filter((p) => p.type === 'windLookout').length, 1);
  assert.equal(after.filter((p) => p.type === 'islandMooring').length, 2);
  assert.equal(after.filter((p) => p.kind !== 'path').length - seed().filter((p) => p.kind !== 'path').length, 6);
});

test('new paper assets have finite geometry and a physically open boarding center', () => {
  const material = (color) => new THREE.MeshBasicMaterial({ color });
  const assets = [makeIslandMooring(material), makePaperGrove(material), makeWindLookout(material)];
  for (const asset of assets) {
    asset.traverse((mesh) => {
      if (!mesh.isMesh) return;
      assert.ok(Array.from(mesh.geometry.attributes.position.array).every(Number.isFinite));
    });
    const size = new THREE.Box3().setFromObject(asset).getSize(new THREE.Vector3());
    assert.ok(size.x > 0.5 && size.y > 0.5 && size.z > 0.1);
  }
  for (const child of assets[0].children) {
    const box = new THREE.Box3().setFromObject(child);
    assert.ok(box.max.x < -0.3 || box.min.x > 0.3);
  }
});

test('village frontages bring two homes toward the plaza without changing the rear world', () => {
  const before = plain(context.api.WORLD_DISTRICT_LAYOUT), snapshot = plain(before);
  const after = context.api.migrateVillageFrontage(before);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(plain(context.api.migrateVillageFrontage(after)), plain(after));
  const center = context.api.mapDir(0, 0.1);
  for (const key of ['jarvis', 'yul']) {
    const distance = (layout) => new THREE.Vector3(...home(layout, key).n).normalize().angleTo(center) * 7.47;
    assert.ok(distance(after) < 5.2);
    assert.ok(distance(before) - distance(after) > 3);
    assert.equal(home(after, key).roof, home(before, key).roof);
  }
  for (const key of ['rodi', 'anne', 'ludwig', 'argos']) assert.deepEqual(plain(home(after, key)), home(before, key));
  assert.equal(after.filter((p) => ['clockKiosk', 'repairShed'].includes(p.type)).length, 0);
  assert.equal(before.length - after.length, 2);
  assert.deepEqual(plain(after.filter((p) => p.districtId === 'south')), before.filter((p) => p.districtId === 'south'));
});

test('village migration preserves edited homes, streets, lots and occupied sites', () => {
  for (const edit of [
    (layout) => { home(layout, 'jarvis').n = [-0.9, 0.4, 0.2]; },
    (layout) => { home(layout, 'jarvis').yaw = 0.4; },
    (layout) => { layout.find((p) => p.id === 'jarvis.forecourt').n[0][0] += 0.03; },
    (layout) => { layout.find((p) => p.type === 'road').n[0][0] += 0.03; },
    (layout) => { layout.push({ type: 'bench', n: [-0.62, 0.6, 0.505] }); },
  ]) {
    const before = plain(context.api.WORLD_DISTRICT_LAYOUT);
    edit(before);
    const after = context.api.migrateVillageFrontage(before);
    assert.deepEqual(plain(home(after, 'jarvis')), home(before, 'jarvis'));
    assert.deepEqual(plain(after.find((p) => p.type === 'clockKiosk')), before.find((p) => p.type === 'clockKiosk'));
  }
});

test('rose scale and collision footprint shrink together while north remains fixed', () => {
  assert.match(source, /const ROSE_LANDMARK_SCALE = 0\.60;/);
  assert.match(source, /g\.scale\.setScalar\(ROSE_LANDMARK_SCALE\)/);
  assert.match(source, /registerSurfaceCollider\(NORTH_POLE, 0\.78 \* ROSE_LANDMARK_SCALE \/ R/);
  assert.match(source, /placeOnSphere\(g, NORTH_POLE, 0\)/);
});
