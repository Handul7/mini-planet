import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeStickAxis, readGamepadControls } from '../src/input-controls.js';

function pad({ axes = [0, 0, 0, 0], pressed = [] } = {}) {
  return {
    connected: true,
    id: 'Standard Test Pad',
    index: 0,
    axes,
    buttons: Array.from({ length: 16 }, (_, index) => ({ pressed: pressed.includes(index), value: pressed.includes(index) ? 1 : 0 })),
  };
}

test('stick deadzone removes drift and rescales intentional input', () => {
  assert.equal(normalizeStickAxis(0.1), 0);
  assert.equal(normalizeStickAxis(-0.16), 0);
  assert.ok(normalizeStickAxis(0.58) > 0.49);
  assert.equal(normalizeStickAxis(1), 1);
});

test('standard gamepad maps movement, camera, jump, and interaction', () => {
  const controls = readGamepadControls([pad({ axes: [-0.58, -1, 0.4, -0.4], pressed: [0, 2] })]);
  assert.equal(controls.connected, true);
  assert.equal(controls.forward, 1);
  assert.ok(controls.turn > 0.49);
  assert.ok(controls.lookX > 0);
  assert.ok(controls.lookY < 0);
  assert.equal(controls.jump, true);
  assert.equal(controls.interact, true);
});

test('d-pad works and missing pads return a neutral snapshot', () => {
  const controls = readGamepadControls([pad({ pressed: [12, 14] })]);
  assert.equal(controls.forward, 1);
  assert.equal(controls.turn, 1);
  assert.deepEqual(readGamepadControls([]), {
    connected: false,
    forward: 0,
    turn: 0,
    lookX: 0,
    lookY: 0,
    jump: false,
    interact: false,
  });
});
