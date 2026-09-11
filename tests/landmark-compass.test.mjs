import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceBearing, createLandmarkCompass } from '../src/landmark-compass.js';

const origin = { x: 0, y: 0, z: 1 };
const right = { x: 1, y: 0, z: 0 };
const north = { x: 0, y: 1, z: 0 };
const target = (angle) => ({ x: Math.sin(angle * Math.PI / 180), y: Math.cos(angle * Math.PI / 180), z: 0 });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('surface compass follows cardinal bearings and camera rotation', () => {
  for (const angle of [0, 90, -90, 179]) close(surfaceBearing(origin, right, target(angle)).angle, angle);
  close(surfaceBearing(origin, { x: 0, y: -1, z: 0 }, north).angle, -90);
  close(surfaceBearing({ x: 0, y: 0, z: 8 }, { x: 2, y: 0, z: 5 }, north).angle, 0);
});

test('nearby, antipodal, missing and degenerate directions never invent a bearing', () => {
  assert.equal(surfaceBearing(origin, right, origin).status, 'near');
  assert.equal(surfaceBearing(origin, right, { x: 0, y: 0, z: -1 }).status, 'antipode');
  assert.equal(surfaceBearing(origin, right, null).status, 'missing');
  assert.equal(surfaceBearing(origin, origin, north).status, 'missing');
  assert.equal(surfaceBearing(origin, right, { x: NaN, y: 0, z: 0 }).status, 'missing');
});

function harness() {
  const needles = new Map(['north', 'lighthouse'].map((key) => [key, { hidden: true, values: {},
    style: { setProperty(name, value) { needles.get(key).values[name] = value; } } }]));
  const root = { attrs: {}, querySelector(selector) { return needles.get(selector.match(/"(.*?)"/)[1]); },
    setAttribute(key, value) { this.attrs[key] = value; } };
  return { needles, root, compass: createLandmarkCompass(root) };
}

test('independent landmark markers are throttled and unchanged DOM is not rewritten', () => {
  const h = harness();
  const input = { origin, right, north, lighthouse: target(130) };
  for (let now = 0; now < 1000; now += 10) h.compass.update(now, input);
  assert.equal(h.compass.state().samples, 20);
  assert.equal(h.compass.state().writes, 5);
  close(h.compass.state().bearings.north.angle, 0);
  close(h.compass.state().bearings.lighthouse.angle, 130);
  assert.equal(h.needles.get('north').hidden, false);
});

test('bearing transitions take the short path across the angle wrap', () => {
  const h = harness();
  h.compass.update(0, { origin, right, north: target(179), lighthouse: null });
  h.compass.update(50, { origin, right, north: target(-179), lighthouse: null });
  close(parseFloat(h.needles.get('north').values['--bearing']), 181);
});

test('moving or deleting a lighthouse updates its marker without cached coordinates', () => {
  const h = harness();
  const input = { origin, right, north, lighthouse: target(130) };
  h.compass.update(0, input);
  input.lighthouse = target(-45); h.compass.update(50, input);
  close(h.compass.state().bearings.lighthouse.angle, -45);
  input.lighthouse = null; h.compass.update(100, input);
  assert.equal(h.needles.get('lighthouse').hidden, true);
  assert.match(h.root.attrs['aria-label'], /등대: 위치 없음/);
  input.north = origin; h.compass.update(150, input);
  assert.equal(h.needles.get('north').hidden, true);
  assert.match(h.root.attrs['aria-label'], /장미: 도착 지점/);
});

test('missing compass markup is a safe no-op', () => {
  const compass = createLandmarkCompass(null);
  compass.update(0, { origin, right, north });
  assert.equal(compass.state().samples, 0);
});
