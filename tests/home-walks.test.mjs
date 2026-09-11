import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { walkSurfaceRoute, findStreetRoute } from '../src/world/spatial-structure.js';

const target = new THREE.Vector3(0.5, 1, 0).normalize();
const allowed = (n) => Number.isFinite(n.x + n.y + n.z) && n.y > 0;
function walker(moveOverride) {
  const position = new THREE.Vector3(0, 1, 0);
  let calls = 0;
  return { position, calls: () => calls, getPosition: () => position, allowed,
    move(tangent, step) {
      calls++;
      if (moveOverride) return moveOverride(position);
      position.multiplyScalar(Math.cos(step)).addScaledVector(tangent.normalize(), Math.sin(step)).normalize();
      return true;
    } };
}
test('walking reaches the target using bounded movement steps, not teleportation', () => {
  const state = walker();
  const result = walkSurfaceRoute([target], state);
  assert.equal(result.pass, true);
  assert.ok(state.position.angleTo(target) < 0.002);
  assert.ok(result.steps > 30 && state.calls() === result.steps);
});
test('walking fails for missing routes, blocked movement and no progress', () => {
  assert.equal(walkSurfaceRoute(null, walker()).reason, 'no-route');
  assert.equal(walkSurfaceRoute([target], walker(() => false)).reason, 'movement-blocked');
  assert.equal(walkSurfaceRoute([target], walker(() => true)).reason, 'no-progress');
});
test('walking checks destination and every intermediate position against the live mask', () => {
  assert.equal(walkSurfaceRoute([new THREE.Vector3(0, -1, 0)], walker()).reason, 'target-blocked');
  const state = walker((p) => { p.set(0, -1, 0); return true; });
  assert.equal(walkSurfaceRoute([target], state).reason, 'left-walkable-surface');
});
test('runtime home walks restore state, gate QA, and include lighthouse foot access', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const walks = source.slice(source.indexOf('    testHomeWalks()'), source.indexOf('    testAllHomes()'));
  assert.equal((walks.match(/commitPlayerSurfaceDirection\(/g) || []).length, 1);
  assert.match(walks, /move: tryMovePlayerOnSurface/);
  assert.match(walks, /findStreetRoute\(playerDir, link.end, streets, allowed\)/);
  assert.match(walks, /finally/);
  assert.match(walks, /playerDir.copy\(original.player\)/);
  assert.match(walks, /homes.length === 5/);
  assert.match(source, /&& homeWalks.pass/);
  assert.match(source, /stages.walkToLighthouseDoor = travel\(footRoute\)/);
  assert.match(source, /stages.returnToIslandPier/);
});

test('street routing follows a bent lane instead of cutting its corner across a lawn', () => {
  const point = (x, z) => new THREE.Vector3(x, 1, z).normalize();
  const lane = [];
  for (let i = 0; i <= 10; i++) lane.push(point(i * 0.025, 0));
  for (let i = 1; i <= 10; i++) lane.push(point(0.25, i * 0.025));
  const route = findStreetRoute(lane[0], lane.at(-1), [lane], () => true);
  assert.ok(route.length > 12);
  assert.ok(route.some((n) => n.angleTo(point(0.25, 0)) < 0.04));
  assert.equal(findStreetRoute(point(-0.2, -0.2), lane.at(-1), [lane], () => true), null);
  assert.equal(findStreetRoute(lane[0], lane.at(-1), [lane], (n) => Math.abs(n.x - 0.12) > 0.025), null);
});
test('lighthouse collision covers the solid base without blocking its entrance apron', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const radius = Number(source.match(/const R = ([\d.]+)/)[1]);
  const collider = Number(source.match(/lighthouse: \{[^\n]*collider: ([\d.]+)/)[1]);
  const clearance = Number(source.match(/const PLAYER_CLEARANCE_RADIUS = ([\d.]+)/)[1]);
  for (const scale of [0.7, 0.86, 1]) {
    const solidBaseAngle = Math.atan2(1.22 * scale, radius);
    const entranceAngle = Math.atan2(1.28 * scale, radius) + 0.04;
    assert.ok(collider * scale >= solidBaseAngle, 'tower base must remain solid');
    assert.ok(collider * scale + clearance < entranceAngle, 'entrance apron must be reachable');
  }
});
