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
const context = vm.createContext({ THREE, PETAL_TONES: [0xffffff], R: 7.47, PLAYER_CLEARANCE_RADIUS: 0.026 });
const propStart = source.indexOf('const PROP_DEFS =');
vm.runInContext([
  ...['tangentBasis', 'offsetSurfaceDir', 'propFacing', 'canonicalMapYaw', 'wrappedAngle',
    'normalizePathDirs', 'replacePathPoints', 'migratePaperNeighborhoods', 'splineDirs', 'slerpDir', 'roadClearanceState'].map(fn),
  source.slice(source.indexOf('const MAP_CENTER ='), source.indexOf('const DEFAULT_PLAYER_SPAWN_DIR =')),
  source.slice(source.indexOf('const AGENT_DISTRICT_ANCHORS ='), source.indexOf('const DASHBOARD_VIEW_DIR =')),
  source.slice(source.indexOf('function sphericalRing('), source.indexOf('// Home driveways are terrain')),
  source.slice(propStart, source.indexOf('\n};', propStart) + 3),
  'this.api = { DEFAULT_LAYOUT, PROP_DEFS, mapDir, normalizePathDirs, splineDirs, roadClearanceState, HARBOR_MAIN_STREET_POINTS, HARBOR_HARBOR_AXIS_POINTS };',
].join('\n'), context);
const api = context.api;
const paths = (layout) => layout.filter((p) => p.kind === 'path' && ['road', 'lane'].includes(p.type))
  .map((p) => ({ data: { type: p.type, dirs: api.normalizePathDirs(p) } }));
const colliders = api.DEFAULT_LAYOUT.filter((p) => p.kind !== 'path' && api.PROP_DEFS[p.type]?.collider > 0).map((p) => ({
  label: p.ownerKey || p.type,
  dir: p.n ? new THREE.Vector3(...p.n).normalize() : api.mapDir(p.x, p.z),
  radius: api.PROP_DEFS[p.type].collider * (api.PROP_DEFS[p.type].baseScale ?? 1) * (p.scale ?? 1),
}));

function audit(layout, water = () => false, obstacles = colliders) {
  context.editablePaths = paths(layout);
  context.getSurfaceColliders = () => obstacles;
  context.isWaterSurfaceDir = water;
  return api.roadClearanceState();
}

test('new road clearance gate detects the formerly blocked intersection and Rodi approach', () => {
  const original = api.DEFAULT_LAYOUT.filter((p) => !['road', 'streetEdge'].includes(p.type));
  original.push({ kind: 'path', type: 'road', points: api.HARBOR_MAIN_STREET_POINTS },
    { kind: 'path', type: 'road', points: api.HARBOR_HARBOR_AXIS_POINTS });
  const legacyColliders = colliders.map((p) => p.label === 'rodi'
    ? { ...p, dir: new THREE.Vector3(0, 0.96, 0.28).normalize() } : p);
  const result = audit(original, () => false, legacyColliders);
  assert.equal(result.pass, false);
  assert.ok(result.issues.some((p) => p.obstacle === 'opsBeacon'));
  assert.ok(result.issues.some((p) => p.obstacle === 'rodi'));
});

test('all default road centers and walkable shoulders clear the prop colliders', () => {
  const result = audit(api.DEFAULT_LAYOUT);
  assert.equal(result.pass, true);
  assert.equal(result.paths, 12);
  assert.ok(result.samples > 1500);
  assert.equal(result.blockedSamples, 0);
  assert.equal(result.segments.filter((s) => s.closed).length, 2);
});

test('water on a road fails the gate even when every collider is clear', () => {
  const result = audit(api.DEFAULT_LAYOUT, () => true);
  assert.equal(result.pass, false);
  assert.equal(result.blockedSamples, 0);
  assert.equal(result.wetSamples, result.samples);
});

test('the mainland road graph stays connected while the lighthouse remains boat-accessed', () => {
  const all = paths(api.DEFAULT_LAYOUT).map((p) => api.splineDirs(p.data.dirs, { step: 0.012 }).dirs);
  const main = all.filter((dirs) => dirs.some((d) => d.y > 0));
  assert.equal(all.length - main.length, 3);
  const connected = new Set([0]);
  for (let round = 0; round < main.length; round++) {
    for (const i of connected) for (let j = 0; j < main.length; j++) {
      if (connected.has(j)) continue;
      if (main[i].some((a) => main[j].some((b) => a.dot(b) > Math.cos(0.02)))) connected.add(j);
    }
  }
  assert.equal(connected.size, main.length);
});

test('newly drawn roads refresh their dependents before saving', () => {
  const calls = [];
  const local = vm.createContext({ drawingType: 'road', drawPoints: [1, 2], PATH_DEFS: { road: {} },
    cancelDrawing: () => calls.push('cancel'), spawnEditorPath: () => (calls.push('spawn'), {}),
    syncCottageExtras: (type) => calls.push(`rebuild:${type}`), saveLayout: () => calls.push('save'),
  });
  vm.runInContext(`${fn('finishDrawing')}\nfinishDrawing();`, local);
  assert.deepEqual(calls, ['cancel', 'spawn', 'rebuild:road', 'save']);
});

test('street and house edits regenerate dependents but unrelated props do not', () => {
  let rebuilds = 0;
  const local = vm.createContext({ HOME_PROP_TYPES: new Set(['cottage', 'lighthouse']), PUBLIC_SPACE_TYPES: new Set(['civicPavilion', 'harborShelter']), rebuildDriveways: () => rebuilds++ });
  vm.runInContext(`${fn('syncCottageExtras')}\nthis.sync = syncCottageExtras;`, local);
  for (const type of ['cottage', 'road', 'lane', 'streetEdge', 'laneEdge', 'deck', 'market']) local.sync(type);
  assert.equal(rebuilds, 7);
  local.sync('flower');
  assert.equal(rebuilds, 7);
});
