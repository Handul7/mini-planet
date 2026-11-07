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
  'this.before = VILLAGE_BALANCED_LAYOUT; this.after = VILLAGE_SIMPLE_LAYOUT;',
].join('\n'), context);
const plain = (value) => JSON.parse(JSON.stringify(value));
const seed = () => plain(context.before);
const migrate = context.migrateVillageSimplicity;
const grounds = ['west.walk-garden', 'east.walk-garden'];
const grove = (layout, sign = 1) => layout.find(p => p.type === 'paperGrove' && p.n[0] * sign > 0.9);

test('simplicity removes only two stock groves and two grass patches, without mutation', () => {
  const before = seed(), snapshot = plain(before), after = plain(migrate(before));
  assert.deepEqual(before, snapshot);
  assert.equal(before.length - after.length, 4);
  assert.equal(after.filter(p => p.kind !== 'path').length, 29);
  assert.equal(after.filter(p => p.type === 'paperGrove').length, 3);
  assert.ok(!after.some(p => grounds.includes(p.id)));
  assert.deepEqual(after, plain(context.after));
  assert.deepEqual(plain(migrate(after)), after);
  for (const p of after) assert.ok(before.some(b => JSON.stringify(b) === JSON.stringify(p)));
});

test('homes, roads, public spaces, southern groves and harbor redistribution remain intact', () => {
  const before = seed(), after = plain(migrate(before));
  const retained = before.filter(p => !grounds.includes(p.id) && p !== grove(before) && p !== grove(before, -1));
  assert.deepEqual(after, retained);
  assert.ok(after.find(p => p.type === 'marketStall').n[0] > 0.45);
  assert.equal(after.filter(p => p.type === 'paperGrove' && p.n[2] < 0).length, 1);
});

test('moving, rotating, resizing or recoloring a grove preserves its entire garden', () => {
  for (const change of [
    p => { p.n = [0.7, 0.5, -0.4]; }, p => { p.yaw += 0.02; },
    p => { p.scale += 0.01; }, p => { p.color = 0xabcdef; },
    p => { p.ownerKey = 'custom'; },
  ]) {
    const before = seed(), tree = grove(before);
    change(tree);
    const after = plain(migrate(before));
    assert.ok(after.some(p => p.id === 'east.walk-garden'));
    assert.ok(after.some(p => JSON.stringify(p) === JSON.stringify(tree)));
    assert.ok(!after.some(p => p.id === 'west.walk-garden'));
  }
});

test('edited ground shape, type or identity protects the associated grove', () => {
  for (const change of [
    p => { p.n[0][1] += 0.01; }, p => { p.type = 'sand'; },
    p => { p.id = 'my-garden'; }, p => { p.districtId = 'custom'; },
  ]) {
    const before = seed(), ground = before.find(p => p.id === 'east.walk-garden');
    change(ground);
    const after = plain(migrate(before));
    assert.ok(grove(after));
    assert.ok(after.some(p => JSON.stringify(p) === JSON.stringify(ground)));
  }
});

test('missing or duplicated stock pieces are preserved rather than guessed', () => {
  for (const type of ['ground', 'grove']) {
    for (const duplicate of [false, true]) {
      const before = seed();
      const target = type === 'ground' ? before.find(p => p.id === 'east.walk-garden') : grove(before);
      if (duplicate) before.push(plain(target));
      else before.splice(before.indexOf(target), 1);
      const after = plain(migrate(before));
      assert.equal(before.length - after.length, 2, 'only the untouched western pair is removed');
    }
  }
});

test('four-decimal saved positions and default metadata are recognized', () => {
  const before = seed().map(p => {
    if (p.kind === 'path') return { ...p, n: context.normalizePathDirs(p).map(d => d.toArray().map(n => +n.toFixed(4))) };
    const normalized = context.normalizePropData(p);
    const result = { ...normalized, n: normalized.dir.toArray().map(n => +n.toFixed(4)), yaw: +normalized.yaw.toFixed(4) };
    delete result.dir;
    return result;
  });
  const after = plain(migrate(before));
  assert.equal(before.length - after.length, 4);
  assert.equal(after.filter(p => p.kind !== 'path').length, 29);
  assert.deepEqual(plain(migrate(after)), after);
});

test('unrelated custom planting and custom paths are unchanged', () => {
  const before = seed();
  const custom = [
    { type: 'paperGrove', n: [0, 0.8, -0.6], scale: 0.8 },
    { kind: 'path', type: 'grass', id: 'custom-garden', n: [[0, 1, 0], [0.1, 0.9, 0], [0, 0.9, 0.1]] },
  ];
  before.push(...custom);
  const after = plain(migrate(before));
  for (const p of custom) assert.ok(after.some(a => JSON.stringify(a) === JSON.stringify(p)));
});

test('v117 saves through the existing backup-before-write gate and runs only once', () => {
  assert.match(fn('loadSavedLayout'), /migrateSavedComposition\(clean, JSON\.stringify\(clean\), '117', migrateVillageSimplicity\)/);
  const storage = new Map(), events = [];
  const local = vm.createContext({ migrateVillageComposition: migrate,
    LAYOUT_BACKUP_KEY: 'backup', LAYOUT_KEY: 'layout', LAYOUT_SCHEMA_VERSION: 1,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem(k, v) { events.push(k); storage.set(k, v); } }, console });
  vm.runInContext(fn('migrateSavedComposition'), local);
  const before = seed();
  const after = local.migrateSavedComposition(before, JSON.stringify(before), '117', migrate);
  assert.deepEqual(events, ['backup', 'layout', 'HandulPlanet_composition_v117']);
  assert.deepEqual(JSON.parse(storage.get('backup'))[0].layout, before);
  assert.deepEqual(plain(local.migrateSavedComposition(after, JSON.stringify(after), '117', migrate)), plain(after));
  assert.equal(events.length, 3);
});
