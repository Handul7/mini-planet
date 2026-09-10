import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { makePaperPublicSpace } from '../src/world/public-spaces.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const context = vm.createContext({ THREE });
vm.runInContext([
  ...['tangentBasis', 'offsetSurfaceDir', 'propFacing', 'canonicalMapYaw', 'normalizePathDirs'].map(fn),
  source.slice(source.indexOf('const MAP_CENTER ='), source.indexOf('const DEFAULT_PLAYER_SPAWN_DIR =')),
  source.slice(source.indexOf('const AGENT_DISTRICT_ANCHORS ='), source.indexOf('const DASHBOARD_VIEW_DIR =')),
  source.slice(source.indexOf('function sphericalRing('), source.indexOf('// Home driveways are terrain')),
  'this.api = { DEFAULT_LAYOUT, migrateSharedHarbor, sphericalRing, lighthouseIsletOutline, HARBOR_REAR_LIGHTHOUSE_DIR, mapDir };',
].join('\n'), context);
const api = context.api;
const plain = (x) => JSON.parse(JSON.stringify(x));

for (const kind of ['garden', 'harbor']) {
  test(`${kind} shelter uses finite paper geometry with an open entrance and a small draw budget`, () => {
    const mesh = makePaperPublicSpace((color) => new THREE.MeshToonMaterial({ color }), kind);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    assert.ok(box.max.y > 2 && box.max.y < 2.5);
    assert.ok(box.max.x - box.min.x < 3.1);
    assert.equal(mesh.userData.publicSpaceKind, kind);
    assert.equal(mesh.userData.doorOffset.z, 1.03);
    let meshes = 0;
    mesh.traverse((node) => {
      assert.equal(!!node.isLight, false);
      if (!node.isMesh) return;
      meshes++;
      assert.ok([...node.geometry.attributes.position.array].every(Number.isFinite));
    });
    assert.ok(meshes <= 5);
  });
}

test('default harbor has exactly two shared shelters and no additional private homes', () => {
  assert.equal(api.DEFAULT_LAYOUT.filter((p) => ['civicPavilion', 'harborShelter'].includes(p.type)).length, 2);
  assert.equal(api.DEFAULT_LAYOUT.filter((p) => p.ownerKey).length, 6);
  assert.equal(api.DEFAULT_LAYOUT.filter((p) => p.type === 'openWater').length, 1);
  assert.deepEqual(plain(api.migrateSharedHarbor(api.DEFAULT_LAYOUT)), plain(api.DEFAULT_LAYOUT));
});

function oldCape() {
  return [
    { type: 'lighthouse', ownerKey: 'argos', n: api.HARBOR_REAR_LIGHTHOUSE_DIR.toArray(), yaw: Math.PI, scale: 0.86 },
    { kind: 'path', type: 'island', n: api.sphericalRing([0, -0.578, -0.816], 0.46, 20, Math.PI / 20) },
  ];
}

test('cape migration preserves the lighthouse and adds surrounding water plus a pier once', () => {
  const input = oldCape();
  const before = plain(input);
  const result = api.migrateSharedHarbor(input);
  assert.deepEqual(plain(input), before);
  assert.deepEqual(plain(result[0]), before[0]);
  assert.equal(result.filter((p) => p.type === 'deck').length, 1);
  assert.equal(result.filter((p) => p.type === 'openWater').length, 1);
  assert.deepEqual(plain(result[1].n), plain(api.lighthouseIsletOutline()));
  assert.deepEqual(plain(api.migrateSharedHarbor(result)), plain(result));
});

test('moved lighthouse and edited coastline are not reshaped', () => {
  const moved = oldCape();
  moved[0].n = [0.5, -0.5, -0.707];
  const edited = oldCape();
  edited[1].n = api.sphericalRing([0, -0.578, -0.816], 0.50, 20, Math.PI / 20);
  for (const layout of [moved, edited]) {
    const result = api.migrateSharedHarbor(layout);
    assert.deepEqual(plain(result.slice(0, 2)), plain(layout));
    assert.equal(result.some((p) => p.type === 'openWater'), false);
  }
});

test('occupied harbor space and custom shelters are preserved', () => {
  const marker = { type: 'tree', n: api.mapDir(-0.62, -0.20).toArray(), scale: 1.3 };
  assert.deepEqual(plain(api.migrateSharedHarbor([marker])), [marker]);
  const existing = { type: 'harborShelter', n: [0, 1, 0], scale: 1.2 };
  assert.deepEqual(plain(api.migrateSharedHarbor([existing])), [existing]);
});

test('custom shoreline objects prevent the cape from being flooded by migration', () => {
  const layout = oldCape();
  const point = api.sphericalRing(api.HARBOR_REAR_LIGHTHOUSE_DIR.toArray(), 0.40, 20)[0];
  layout.push({ type: 'bench', n: point, scale: 1 });
  const result = api.migrateSharedHarbor(layout);
  assert.equal(result.some((p) => p.type === 'openWater'), false);
  assert.deepEqual(plain(result.slice(0, 3)), plain(layout));
});

test('boat grows by twelve percent without rewriting per-item user scale', () => {
  const registry = source.slice(source.indexOf('const PROP_DEFS ='), source.indexOf('\n};', source.indexOf('const PROP_DEFS =')) + 3);
  const local = vm.createContext({ PETAL_TONES: [0xffffff] });
  vm.runInContext(`${registry}\nthis.boat = PROP_DEFS.fishingBoat;`, local);
  assert.equal(local.boat.baseScale, 1.12);
  const custom = { type: 'fishingBoat', n: [0, 0, 1], scale: 0.8 };
  assert.equal(api.migrateSharedHarbor([custom])[0].scale, 0.8);
});

test('public entrances may connect to a pier while private homes keep street connections', () => {
  const p = api.mapDir(0, 0), end = api.mapDir(0, 0.15);
  const local = vm.createContext({ THREE, PUBLIC_SPACE_TYPES: new Set(['harborShelter']),
    propFacing: () => end.clone().sub(p),
    editablePaths: [{ data: { type: 'deck', dirs: [p, end] } }],
    splineDirs: (dirs) => ({ dirs }),
  });
  vm.runInContext(fn('nearestStreetConnection'), local);
  assert.equal(local.nearestStreetConnection({ data: { type: 'cottage', dir: p } }, p), null);
  assert.equal(local.nearestStreetConnection({ data: { type: 'harborShelter', dir: p } }, p).type, 'deck');
});
