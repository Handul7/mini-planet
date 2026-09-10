import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { auditLayout } from '../src/release-quality.js';

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const report = await readFile(new URL('../docs/world-art-direction-improvement-report.md', import.meta.url), 'utf8');
const agentsConfig = JSON.parse(await readFile(new URL('../config/agents.json', import.meta.url), 'utf8'));
const frontStart = mainSource.indexOf('const HARBOR_FRONT_LAYOUT = [');
const rearStart = mainSource.indexOf('const HARBOR_REAR_LAYOUT = [');
const defaultLayoutStart = mainSource.indexOf('const WORLD_HOME_SITES =');
const terrainStart = mainSource.indexOf('const HARBOR_TERRAIN_LAYOUT = [');
const frontLayout = mainSource.slice(frontStart, rearStart);
const rearLayout = mainSource.slice(rearStart, defaultLayoutStart);
const terrainLayout = mainSource.slice(terrainStart, frontStart);

function mapDirection(x, z) {
  const centerLength = Math.hypot(0, 0.58, 0.82);
  const center = [0, 0.58 / centerLength, 0.82 / centerLength];
  const east = [1, 0, 0];
  const north = [0, center[2], -center[1]];
  const value = center.map((part, index) => part + east[index] * x + north[index] * z);
  const length = Math.hypot(...value);
  return value.map((part) => part / length);
}

test('world art-direction report records the release composition contract', () => {
  assert.match(report, /관제 광장/);
  assert.match(report, /주거 (?:초승달|반원)/);
  assert.match(report, /작업 항구/);
  assert.match(report, /100점/);
});

test('default village uses a readable lane hierarchy and working-harbor props', () => {
  assert.ok(terrainStart >= 0 && frontStart > terrainStart && rearStart > frontStart);
  assert.equal((terrainLayout.match(/type: 'lane'/g) || []).length, 3);
  assert.equal((terrainLayout.match(/type: 'road'/g) || []).length, 2);
  assert.ok((terrainLayout.match(/type: 'deck'/g) || []).length >= 3);
  for (const type of ['wayfinder', 'harborCrane', 'marketStall']) {
    assert.match(frontLayout, new RegExp(`type: '${type}'`));
  }
  assert.doesNotMatch(frontLayout, /type: '(?:busStop|utilityPole)'/);
});

test('default layout avoids duplicate agent workstation props', () => {
  assert.doesNotMatch(frontLayout, /type: 'agentStation'/);
  for (const key of agentsConfig.agents.filter((agent) => agent.key !== 'argos').map((agent) => agent.key)) {
    assert.match(mainSource, new RegExp(`${key}: Object\\.freeze\\(\\[`));
  }
});

test('legacy home seeds retain six distinct owners before global redistribution', () => {
  const homes = [...frontLayout.matchAll(
    /type: 'cottage', ownerKey: '([^']+)',\s+x: (-?\d+(?:\.\d+)?), z: (-?\d+(?:\.\d+)?)/g,
  )].map((match) => ({
    type: 'cottage',
    ownerKey: match[1],
    n: mapDirection(Number(match[2]), Number(match[3])),
    radius: 0,
  }));
  assert.equal(homes.length, 5);
  const audit = auditLayout({
    entries: [
      ...homes,
      { type: 'lighthouse', ownerKey: 'argos', n: [0, -0.505, -0.863], radius: 0 },
      { type: 'opsBeacon', n: [0, 1, 0], radius: 0 },
      { type: 'wayfinder', n: [1, 0, 0], radius: 0 },
      { type: 'harborCrane', n: [-1, 0, 0], radius: 0 },
    ],
    expectedOwners: agentsConfig.agents.map((agent) => agent.key),
    requiredTypes: ['opsBeacon', 'wayfinder', 'harborCrane'],
  });
  assert.equal(audit.status, 'ready');
  assert.equal(audit.score, 100);
});

test('art-direction props remain code-native and editable', () => {
  for (const factory of [
    'makeStreetLamp', 'makeWayfinder', 'makeAgentStation', 'makeHarborCrane',
    'makeDockBollard', 'makeCargoCluster', 'makeCivicPavilion', 'makeClockKiosk',
    'makeRepairShed', 'makeResultBoard', 'makeFerryGate', 'makePlanterCluster',
  ]) {
    assert.match(mainSource, new RegExp(`function ${factory}\\(`));
  }
  assert.match(mainSource, /const LAYOUT_KEY = 'HandulPlanet_layout_harbor_v27'/);
  assert.match(mainSource, /'HandulPlanet_layout_harbor_v21'/);
  assert.match(mainSource, /'HandulPlanet_layout_harbor_v20'/);
  assert.match(mainSource, /'HandulPlanet_layout_harbor_v19'/);
  assert.match(mainSource, /function migrateOpenWorldDistrict\(layout\)/);
  assert.match(mainSource, /d\.agentKey = e\.agentKey/);
});

test('connected harbor districts use expanded land and shared landmarks', () => {
  assert.ok((terrainLayout.match(/type: 'island'/g) || []).length >= 5);
  assert.ok((terrainLayout.match(/type: 'deck'/g) || []).length >= 4);
  for (const type of ['civicPavilion', 'clockKiosk', 'repairShed', 'resultBoard', 'ferryGate']) {
    assert.match(frontLayout, new RegExp(`type: '${type}'`));
  }
  for (const key of ['rodi', 'jarvis', 'yul', 'ludwig', 'anne']) {
    assert.match(mainSource, new RegExp(`${key}: Object\\.freeze\\(\\[`));
  }
});

test('advanced world structure tools are backed up before editing', () => {
  assert.match(mainSource, /const STRUCTURAL_PATH_TYPES = new Set\(\[/);
  for (const type of ['island', 'sea', 'deck', 'market', 'breakwater', 'wave', 'camellia']) {
    assert.match(mainSource, new RegExp(`['"]${type}['"]`));
  }
  assert.match(mainSource, /backupCurrentLayout\('before-world-structure'\)/);
});

test('exploration starts clear and includes player recovery contracts', () => {
  assert.match(mainSource, /const DEFAULT_PLAYER_SPAWN_DIR = mapDir\(0, -0\.18\)/);
  assert.match(mainSource, /function tryMovePlayerOnSurface\(/);
  assert.match(mainSource, /function recoverPlayerToSafeSurface\(/);
  assert.match(mainSource, /playerEscapeOptionCount\(/);
  assert.match(mainSource, /spawnN: DEFAULT_PLAYER_SPAWN_DIR\.toArray\(\)/);
  assert.match(mainSource, /const EXPLORE_CAM_DIST = 4\.3/);
});

test('legacy neighborhood seeds retain their migration coordinates', () => {
  const homes = [...frontLayout.matchAll(
    /type: 'cottage', ownerKey: '([^']+)',\s+x: (-?\d+(?:\.\d+)?), z: (-?\d+(?:\.\d+)?)/g,
  )].map((match) => ({ key: match[1], x: Number(match[2]), z: Number(match[3]) }));
  const xs = homes.map((home) => home.x);
  const zs = homes.map((home) => home.z);
  assert.ok(Math.max(...xs) - Math.min(...xs) >= 2.4);
  assert.ok(Math.max(...zs) - Math.min(...zs) >= 1.0);
  for (let i = 0; i < homes.length; i++) {
    for (let j = i + 1; j < homes.length; j++) {
      const a = mapDirection(homes[i].x, homes[i].z);
      const b = mapDirection(homes[j].x, homes[j].z);
      const distance = Math.acos(Math.min(1, a.reduce((sum, v, k) => sum + v * b[k], 0))) * 7.47;
      assert.ok(distance >= 3.3, `${homes[i].key}/${homes[j].key}: ${distance}`);
    }
  }
  assert.equal((frontLayout.match(/type: 'streetLamp'/g) || []).length, 1);
  assert.doesNotMatch(frontLayout, /type: 'convexMirror'/);
});

test('district release adds boundaries, courtyards and distinct architecture profiles', () => {
  for (const type of ['streetEdge', 'laneEdge', 'hedge', 'quayRail', 'courtyard']) {
    assert.match(terrainLayout, new RegExp(`type: '${type}'`));
  }
  assert.match(mainSource, /makeCottageArchitecture\(/);
  assert.match(mainSource, /architectureProfiles/);
  assert.match(mainSource, /worldScaleState\(\)/);
});

test('agent focus camera follows the globe instead of crossing its center', () => {
  assert.match(mainSource, /function moveCameraAroundPlanet\(target, alpha\)/);
  assert.match(mainSource, /_focusArcRotation\.setFromUnitVectors/);
  assert.match(mainSource, /_focusTransitLookTarget/);
  assert.match(mainSource, /destinationVisibility/);
  assert.match(mainSource, /planetClearance/);
});

test('release roads and homes keep a human-readable scale hierarchy', () => {
  assert.match(mainSource, /width: 0\.98, color: 0x99968f/);
  assert.match(mainSource, /width: 0\.90, color: THEME\.world\.roadAsphalt/);
  assert.match(mainSource, /width: 0\.78, color: 0x9ca18e/);
  assert.match(mainSource, /width: 0\.70, color: 0xc5c8b0/);
  const homeScales = [...frontLayout.matchAll(
    /type: 'cottage', ownerKey: '[^']+',[^\n]+scale: (\d+(?:\.\d+)?)/g,
  )].map((match) => Number(match[1]));
  assert.equal(homeScales.length, 5);
  assert.ok(Math.min(...homeScales) >= 0.62);
  assert.equal((terrainLayout.match(/type: 'grass'/g) || []).length, 1);
  assert.equal((terrainLayout.match(/type: 'wave'/g) || []).length, 4);
  assert.doesNotMatch(terrainLayout, /\[-0\.24, 0\.08\].+\[-0\.24, 0\.08\]/s);
});

test('default world keeps the point-prop silhouette budget restrained', () => {
  const pointProps = (frontLayout.match(/\{ type: '/g) || []).length
    + (rearLayout.match(/\{ type: '/g) || []).length;
  assert.ok(pointProps >= 20);
  assert.ok(pointProps <= 25);
  assert.doesNotMatch(frontLayout, /type: '(?:cargoCluster|dockBollard|vendingMachine|planterCluster|tetrapod|netRack)'/);
});

test('home approaches connect actual doors to the nearest street', () => {
  assert.match(mainSource, /function nearestStreetConnection\(home, doorDir\)/);
  assert.match(mainSource, /const start = homeDoorDir\(it\)/);
  assert.match(mainSource, /const streetTypes = PUBLIC_SPACE_TYPES\.has\(home\.data\.type\) \? \['road', 'lane', 'market', 'deck'\] : \['road', 'lane'\]/);
  assert.match(mainSource, /homeStreetAccessState\(\)/);
  assert.match(mainSource, /dataset\.qaHomeStreetAccess/);
  assert.match(mainSource, /homeStreetAccess\.pass/);
});

test('planet scale and ocean coverage stay within the compact release target', () => {
  assert.match(mainSource, /const R = 7\.47/);
  assert.match(mainSource, /const SEA_BAND_MIN_Y = -0\.70/);
  assert.match(mainSource, /const SEA_BAND_MAX_Y = 0\.20/);
  assert.match(mainSource, /function terrainCoverageSummary\(sampleCount = 4096\)/);
  assert.match(mainSource, /coverage\.waterPercent >= 34/);
  assert.match(mainSource, /coverage\.waterPercent <= 44/);
  assert.match(mainSource, /planet:\s+0x86a47b/);
  assert.match(mainSource, /emissive: THEME\.world\.landDeep/);
});

test('water is blocked on foot and navigable only while aboard a boat', () => {
  assert.match(mainSource, /function playerSurfaceAllowed\(dir, aboard = !!activeBoatItem\)/);
  assert.match(mainSource, /return aboard \? isWaterSurfaceDir\(dir\) : !isInWaterDir\(dir\)/);
  assert.match(mainSource, /function boardBoat\(item\)/);
  assert.match(mainSource, /function disembarkBoat\(/);
  assert.match(mainSource, /const SAIL = 0\.62/);
  assert.match(mainSource, /waterAccess\.pass/);
  assert.match(mainSource, /testBoatLifecycle\(\)/);
  assert.match(mainSource, /dataset\.qaBoatLifecycle/);
  assert.match(mainSource, /boatLifecycle\.pass/);
  assert.match(mainSource, /type: 'fishingBoat',[^\n]+scale: 1\.30/);
  assert.match(mainSource, /type: 'channelBeacon'/);
  assert.match(mainSource, /type: 'cargoFerry'/);
  assert.match(mainSource, /marineEnvironmentState\(\)/);
  assert.match(mainSource, /dataset\.qaMarineEnvironment/);
  assert.match(mainSource, /marineEnvironment\.pass/);
  assert.match(mainSource, /type: 'vendingMachine'/);
  assert.match(mainSource, /function makeConvexMirror\(/);
});
