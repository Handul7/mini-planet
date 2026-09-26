import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { oceanBandBounds, walkSurfaceRoute } from '../src/world/spatial-structure.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const unit = (n) => new THREE.Vector3(...n).normalize();
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const declaration = (name) => {
  const start = source.indexOf(`const ${name} =`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n};', start) + 3);
};

function fixture() {
  // Run the real path builders and movement rules; only rendering is stubbed.
  // The bridge renderer itself is exercised in footbridge-geometry.test.mjs.
  const emptyMesh = () => new THREE.Group();
  const material = () => new THREE.MeshBasicMaterial();
  const context = vm.createContext({ THREE, oceanBandBounds, R: 7.47,
    SEA_BAND_MIN_Y: -0.70, SEA_BAND_MAX_Y: 0.20, PETAL_TONES: [0xffffff],
    waterZones: [], landZones: [], bridgeZones: [], surfaceColliders: [],
    PLAYER_CLEARANCE_RADIUS: 0.026, activeBoatItem: null,
    _playerSurfaceQ: new THREE.Quaternion(), THEME: { world: {} },
    makeFootbridge: emptyMesh, makeCountryRoad: emptyMesh, makeCapMesh: emptyMesh,
    makeLatitudeBand: emptyMesh, makePlazaPavers: emptyMesh, makeStreetPavers: emptyMesh,
    makeSurfaceRibbon: emptyMesh, makeRiver: emptyMesh, makeSeaWaterMat: material,
    makePondWaterMat: material, toonMat: material, terrainRadius: () => 7.47,
    prepareSeasonalGround: (mesh) => mesh, disposeObject() {},
    placeOnSphereFacing() {}, batchStaticMeshTree() {},
  });
  vm.runInContext([
    ...['tangentBasis', 'offsetSurfaceDir', 'propFacing', 'canonicalMapYaw', 'wrappedAngle',
      'normalizePathDirs', 'replacePathPoints', 'migratePaperNeighborhoods', 'splineDirs',
      'slerpDir', 'centroidDir', 'registerWaterZone', 'registerBridgeZone',
      'registerLatitudeWaterBand', 'registerPolyZone', 'registerPolyLandZone',
      'registerPolyWaterZone', 'registerPathZones', 'unregisterZones', 'zoneContains',
      'isInZone', 'isOnBridgeDir', 'isWaterSurfaceDir', 'isInWaterDir',
      'getSurfaceColliders', 'hasSurfaceClearance', 'playerSurfaceAllowed',
      'surfaceStepDirection', 'commitPlayerSurfaceDirection', 'keepTangentAtPlayer',
      'keepPlayerForwardTangent', 'tryMovePlayerOnSurface'].map(fn),
    source.slice(source.indexOf('const MAP_CENTER ='), source.indexOf('const DEFAULT_PLAYER_SPAWN_DIR =')),
    source.slice(source.indexOf('const AGENT_DISTRICT_ANCHORS ='), source.indexOf('const DASHBOARD_VIEW_DIR =')),
    source.slice(source.indexOf('function sphericalRing('), source.indexOf('// Home driveways are terrain')),
    declaration('PROP_DEFS'), declaration('PATH_DEFS'),
    'this.api = { VILLAGE_SIMPLE_LAYOUT, DEFAULT_LAYOUT, PROP_DEFS, PATH_DEFS };',
  ].join('\n'), context);
  const { VILLAGE_SIMPLE_LAYOUT: before, DEFAULT_LAYOUT: layout, PROP_DEFS, PATH_DEFS } = context.api;
  const pathTypes = new Set(['seaRing', 'island', 'sea', 'openWater', 'pond', 'river',
    'road', 'lane', 'deck', 'market', 'breakwater', 'camellia']);
  for (const path of before.filter((p) => p.kind === 'path' && pathTypes.has(p.type))) {
    PATH_DEFS[path.type].build(context.normalizePathDirs(path), path);
  }
  context.surfaceColliders = before.filter((p) => p.kind !== 'path' && PROP_DEFS[p.type]?.collider > 0)
    .map((p) => ({ label: p.ownerKey || p.type,
      dir: p.n ? unit(p.n) : context.mapDir(p.x, p.z),
      radius: PROP_DEFS[p.type].collider * (PROP_DEFS[p.type].baseScale ?? 1) * (p.scale ?? 1),
    }));
  const bridge = layout.find((p) => p.id === 'yul.footbridge');
  assert.ok(bridge);
  const points = context.normalizePathDirs(bridge);
  const curve = context.splineDirs(points, { step: 0.006 }).dirs;
  const addBridge = () => PATH_DEFS.footbridge.build(points, bridge);
  const placePlayer = (dir) => {
    context.playerDir = dir.clone();
    context.playerForward = context.tangentBasis(dir).north.clone();
    context.camDir = context.playerForward.clone();
  };
  const walk = (route) => walkSurfaceRoute(route, {
    getPosition: () => context.playerDir,
    move: (travel, step) => context.tryMovePlayerOnSurface(travel, step),
    allowed: (dir) => context.playerSurfaceAllowed(dir)
      && context.hasSurfaceClearance(dir, context.PLAYER_CLEARANCE_RADIUS),
  });
  return { context, before, layout, bridge, points, curve, addBridge, placePlayer, walk };
}

test('migration adds one bridge without moving any existing object and is idempotent', () => {
  const { context, before, layout } = fixture();
  const input = plain(before), snapshot = plain(before);
  const migrated = context.migrateYulFootbridge(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(plain(migrated.slice(0, -1)), snapshot);
  assert.equal(migrated.length, input.length + 1);
  assert.equal(migrated.filter((p) => p.id === 'yul.footbridge').length, 1);
  assert.deepEqual(plain(migrated), plain(layout));
  assert.equal(context.migrateYulFootbridge(migrated), migrated);
  const custom = plain(migrated);
  custom.at(-1).n[1] = [1, 0, 0];
  assert.equal(context.migrateYulFootbridge(custom), custom);
});

test('migration preserves edited homes and approaches instead of forcing the stock connection', () => {
  const { context, before, points } = fixture();
  const northIndex = before.findIndex((p) => p.type === 'road'
    && context.normalizePathDirs(p).some((dir) => dir.angleTo(points.at(-1)) < 0.003));
  assert.ok(northIndex >= 0);
  const edits = [
    (input) => { input.find((p) => p.ownerKey === 'yul').n = [0, 1, 0]; },
    (input) => { input.find((p) => p.ownerKey === 'yul').yaw += 0.1; },
    (input) => { input.splice(input.findIndex((p) => p.ownerKey === 'yul'), 1); },
    (input) => { input.find((p) => p.id === 'south.garden-loop').n[0] = [0, 1, 0]; },
    (input) => { input.splice(input.findIndex((p) => p.id === 'south.garden-loop'), 1); },
    (input) => { input[northIndex].n[0] = [0, 1, 0]; },
    (input) => { input.splice(northIndex, 1); },
  ];
  for (const edit of edits) {
    const input = plain(before);
    edit(input);
    const snapshot = plain(input);
    assert.equal(context.migrateYulFootbridge(input), input);
    assert.deepEqual(input, snapshot);
  }
});

test('both bridge entrances reach dry land and existing southern and northern paths', () => {
  const { context, before, points } = fixture();
  const south = before.find((p) => p.id === 'south.garden-loop');
  const southCurve = context.splineDirs(context.normalizePathDirs(south), { step: 0.025 }).dirs;
  assert.ok(southCurve.some((p) => p.angleTo(points[0]) < 0.003));
  assert.ok(before.filter((p) => p.type === 'road').some((p) =>
    context.normalizePathDirs(p).some((dir) => dir.angleTo(points.at(-1)) < 0.003)));
  for (const endpoint of [points[0], points.at(-1)]) {
    assert.equal(context.isWaterSurfaceDir(endpoint), false);
    assert.equal(context.hasSurfaceClearance(endpoint, context.PLAYER_CLEARANCE_RADIUS), true);
  }
});

test('only the bridge deck becomes walkable, and deleting it restores the water barrier', () => {
  const { context, curve, addBridge } = fixture();
  const wetBefore = curve.map((dir) => context.isWaterSurfaceDir(dir));
  const blockedBefore = curve.filter((dir) => context.isInWaterDir(dir));
  assert.ok(blockedBefore.length > 30, 'the connection actually crosses sea');
  const built = addBridge();
  assert.ok(built.walkZones.length > 10);
  assert.deepEqual(curve.map((dir) => context.isWaterSurfaceDir(dir)), wetBefore,
    'a walking exception must not turn the sea into terrain');
  assert.ok(curve.every((dir) => !context.isInWaterDir(dir)));
  const middle = curve[Math.floor(curve.length / 2)];
  const nearbySea = [];
  const basis = context.tangentBasis(middle);
  for (let i = 0; i < 16; i++) {
    const tangent = basis.east.clone().multiplyScalar(Math.cos(i * Math.PI / 8))
      .addScaledVector(basis.north, Math.sin(i * Math.PI / 8));
    const candidate = context.offsetSurfaceDir(middle, tangent, 0.16);
    if (context.isWaterSurfaceDir(candidate) && !context.isOnBridgeDir(candidate)) nearbySea.push(candidate);
  }
  assert.ok(nearbySea.length > 0);
  assert.ok(nearbySea.every((dir) => !context.playerSurfaceAllowed(dir)));
  context.unregisterZones(context.bridgeZones, built.walkZones);
  assert.ok(blockedBefore.every((dir) => context.isInWaterDir(dir)));
});

test('the real movement loop crosses the entire bridge both ways without teleporting', () => {
  const { context, curve, addBridge, placePlayer, walk } = fixture();
  addBridge();
  placePlayer(curve[0]);
  const outward = walk(curve);
  assert.equal(outward.pass, true, JSON.stringify(outward));
  assert.ok(outward.steps > 100 && outward.distance * context.R > 10);
  assert.ok(context.playerDir.angleTo(curve.at(-1)) < 0.0021);
  const homeward = walk([...curve].reverse());
  assert.equal(homeward.pass, true, JSON.stringify(homeward));
  assert.ok(homeward.steps > 100);
  assert.ok(context.playerDir.angleTo(curve[0]) < 0.0021);
  assert.ok(Math.abs(context.playerForward.dot(context.playerDir)) < 1e-10);
  assert.ok(Math.abs(context.camDir.dot(context.playerDir)) < 1e-10);
});

test('the same walking route is blocked before the bridge is built', () => {
  const { curve, placePlayer, walk } = fixture();
  placePlayer(curve[0]);
  const result = walk(curve);
  assert.equal(result.pass, false);
  assert.ok(result.steps > 0, 'the existing southern approach can still be walked');
  assert.equal(result.reason, 'target-blocked');
});

test('the deck and rails clear physical obstacles and the decorative cargo ferry', () => {
  const { context, before, curve } = fixture();
  const halfFootprint = 0.65;
  for (const obstacle of context.surfaceColliders) {
    const clearance = Math.min(...curve.map((p) => (p.angleTo(obstacle.dir) - obstacle.radius) * context.R));
    assert.ok(clearance > halfFootprint, `${obstacle.label}: ${clearance}`);
  }
  // The cargo ferry has no player collider, so movement success alone cannot
  // catch a route that visually goes through its hull/wake.
  const ferry = before.find((p) => p.type === 'cargoFerry');
  assert.ok(ferry);
  const ferryDir = ferry.n ? unit(ferry.n) : context.mapDir(ferry.x, ferry.z);
  const ferryClearance = Math.min(...curve.map((p) => p.angleTo(ferryDir) * context.R));
  assert.ok(ferryClearance > 1.92 * (ferry.scale ?? 1) + halfFootprint,
    `cargo ferry clearance: ${ferryClearance}`);
});
