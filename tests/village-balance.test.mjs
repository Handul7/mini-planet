import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const context = vm.createContext({ THREE });
vm.runInContext([
  ...['tangentBasis', 'offsetSurfaceDir', 'propFacing', 'canonicalMapYaw', 'wrappedAngle',
    'normalizePathDirs', 'replacePathPoints', 'migratePaperNeighborhoods', 'normalizePropData'].map(fn),
  source.slice(source.indexOf('const MAP_CENTER ='), source.indexOf('const DEFAULT_PLAYER_SPAWN_DIR =')),
  source.slice(source.indexOf('const AGENT_DISTRICT_ANCHORS ='), source.indexOf('const DASHBOARD_VIEW_DIR =')),
  source.slice(source.indexOf('function sphericalRing('), source.indexOf('// Home driveways are terrain')),
  'this.before = VILLAGE_BALANCE_BASE; this.after = DEFAULT_LAYOUT;',
].join('\n'), context);
const plain = (value) => JSON.parse(JSON.stringify(value));
const seed = () => plain(context.before);
const migrate = context.migrateVillageBalance;
const dir = (p) => p.n ? new THREE.Vector3(...p.n).normalize() : context.mapDir(p.x, p.z);
const points = (layout) => layout.filter(p => p.kind !== 'path');
const home = (layout, key) => layout.find(p => p.ownerKey === key);
const pockets = ['west.walk-garden', 'east.walk-garden'];

test('balance is immutable, idempotent and limited to two extra planting groups', () => {
  const before = seed(), snapshot = plain(before), after = plain(migrate(before));
  assert.deepEqual(before, snapshot);
  assert.deepEqual(plain(migrate(after)), after);
  assert.equal(points(before).length, 29);
  assert.equal(points(after).length, 31);
  assert.equal(after.filter(p => p.type === 'paperGrove').length, 5);
  assert.deepEqual(new Set(points(after).map(p => p.type)), new Set(points(before).map(p => p.type)));
  for (const id of pockets) assert.equal(after.filter(p => p.id === id).length, 1);
});

test('houses, public facilities, boats, roads and existing terrain stay unchanged', () => {
  const before = seed(), after = plain(migrate(before));
  for (const p of before) {
    if (['coastPine', 'marketStall', 'paperGrove'].includes(p.type)) continue;
    assert.ok(after.some(a => JSON.stringify(a) === JSON.stringify(p)), p.ownerKey || p.id || p.type);
  }
  assert.equal(after.filter(p => p.kind === 'path').length - before.filter(p => p.kind === 'path').length, 2);
});

test('harbor dressing spreads east and southern planting occupies both sides of the loop', () => {
  const before = seed(), after = plain(migrate(before));
  const stall = layout => layout.find(p => p.type === 'marketStall');
  assert.ok(dir(stall(before)).x < -0.2);
  assert.ok(dir(stall(after)).x > 0.45);
  assert.ok(dir(stall(after)).y > 0.25);
  const southern = after.filter(p => p.type === 'paperGrove' && dir(p).y < -0.7);
  assert.equal(southern.length, 3);
  assert.equal(southern.filter(p => dir(p).z < 0).length, 1);
  assert.equal(southern.filter(p => dir(p).z > 0).length, 2);
  const pine = after.find(p => p.type === 'coastPine');
  assert.ok(dir(pine).x < -0.7);
  assert.ok(dir(pine).angleTo(dir(home(after, 'ludwig'))) > 0.35);
});

test('side greenery has road clearance and protects the rose clearing and every home', () => {
  const after = plain(migrate(seed()));
  for (const sign of [-1, 1]) {
    const grove = after.find(p => p.type === 'paperGrove' && dir(p).x * sign > 0.9);
    assert.ok(grove, `side ${sign}`);
    assert.ok(dir(grove).y > 0.3);
    assert.ok(dir(grove).angleTo(new THREE.Vector3(0, 1, 0)) > 0.8);
    for (const h of after.filter(p => p.ownerKey)) assert.ok(dir(grove).angleTo(dir(h)) > 0.4);
  }
  for (const id of pockets) assert.equal(after.find(p => p.id === id).n.length, 7);
});

test('moved, rotated, resized and recolored props are never restored to stock positions', () => {
  for (const change of [
    p => { p.n = [0.1, 0.4, 0.9]; delete p.x; delete p.z; },
    p => { p.yaw = 1.25; }, p => { p.scale = 1.4; }, p => { p.color = 0x123456; },
  ]) {
    const before = seed(), stall = before.find(p => p.type === 'marketStall');
    change(stall);
    assert.deepEqual(plain(migrate(before).find(p => p.type === 'marketStall')), stall);
  }
  const removed = seed().filter(p => p.type !== 'coastPine');
  assert.equal(migrate(removed).filter(p => p.type === 'coastPine').length, 0);
});

test('custom props, large gardens and edited neighborhood roads suppress automatic planting', () => {
  const east = new THREE.Vector3(0.93, 0.36, -0.08).normalize();
  for (const change of [
    layout => layout.push({ type: 'bench', n: east.toArray() }),
    layout => layout.push({ kind: 'path', type: 'grass', n: plain(context.sphericalRing(east.toArray(), 0.35, 8)) }),
    layout => { home(layout, 'yul').n = [0.7, 0.6, 0.3]; },
    layout => {
      const lane = layout.find(p => p.type === 'lane' && context.normalizePathDirs(p).some(n => n.angleTo(east) < 0.42));
      lane.n[0][1] += 0.04;
    },
  ]) {
    const before = seed(); change(before);
    const snapshot = plain(before), after = plain(migrate(before));
    assert.deepEqual(before, snapshot);
    assert.ok(!after.some(p => p.id === 'east.walk-garden'));
    for (const p of before.filter(p => p.type === 'bench')) assert.ok(after.some(a => JSON.stringify(a) === JSON.stringify(p)));
  }
});

test('rounded saved coordinates match the reviewed seed without duplicate planting', () => {
  const saved = seed().map(p => {
    if (p.kind === 'path') return { ...p, n: context.normalizePathDirs(p).map(d => d.toArray().map(n => +n.toFixed(4))), points: undefined };
    const normalized = context.normalizePropData(p);
    const result = { ...normalized, n: normalized.dir.toArray().map(n => +n.toFixed(4)), yaw: +normalized.yaw.toFixed(4) };
    delete result.dir;
    return result;
  });
  const result = plain(migrate(saved));
  assert.equal(points(result).length, 31);
  assert.ok(dir(result.find(p => p.type === 'marketStall')).x > 0.45);
  assert.deepEqual(plain(migrate(result)), result);
});

test('saved balance uses the existing backup-before-write migration gate', () => {
  assert.match(fn('loadSavedLayout'), /migrateSavedComposition\(clean, JSON\.stringify\(clean\), '116', migrateVillageBalance\)/);
  const storage = new Map(), events = [];
  const before = seed();
  const local = vm.createContext({ migrateVillageBalance: migrate, migrateVillageComposition: migrate,
    LAYOUT_BACKUP_KEY: 'backup', LAYOUT_KEY: 'layout', LAYOUT_SCHEMA_VERSION: 1,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem(k, v) { events.push(k); storage.set(k, v); } }, console });
  vm.runInContext(fn('migrateSavedComposition'), local);
  const after = local.migrateSavedComposition(before, JSON.stringify(before), '116', migrate);
  assert.deepEqual(events, ['backup', 'layout', 'HandulPlanet_composition_v116']);
  assert.deepEqual(JSON.parse(storage.get('backup'))[0].layout, before);
  assert.deepEqual(plain(local.migrateSavedComposition(after, JSON.stringify(after), '116', migrate)), plain(after));
  assert.equal(events.length, 3);
});
