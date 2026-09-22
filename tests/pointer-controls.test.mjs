import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrbitGesture, bindVirtualJoystick, wheelPixels } from '../src/input-controls.js';

const pointer = (pointerId, clientX, clientY, pointerType = 'touch', button = 0) =>
  ({ pointerId, clientX, clientY, pointerType, button });

test('orbit ignores contacts outside the canvas and non-primary mouse buttons', () => {
  const gesture = createOrbitGesture();
  assert.equal(gesture.begin(pointer(1, 0, 0, 'mouse', 2)), false);
  assert.equal(gesture.move(pointer(9, 50, 70)), null);
  assert.equal(gesture.begin(pointer(1, 10, 20, 'mouse')), true);
  assert.deepEqual(gesture.move(pointer(1, 25, 10, 'mouse')), { dx: 15, dy: -10, zoom: 0 });
  gesture.end(pointer(9));
  assert.equal(gesture.pointers.size, 1);
  gesture.end(pointer(1));
  assert.equal(gesture.move(pointer(1, 100, 100)), null);
});

test('pinch is exclusive of orbit and resumes without jumping after one finger lifts', () => {
  const gesture = createOrbitGesture();
  gesture.begin(pointer(1, 0, 0));
  gesture.begin(pointer(2, 100, 0));
  assert.deepEqual(gesture.move(pointer(2, 120, 0)), { dx: 0, dy: 0, zoom: -0.6 });
  assert.equal(gesture.move(pointer(99, 300, 300)), null);
  gesture.end(pointer(1));
  assert.deepEqual(gesture.move(pointer(2, 125, 10)), { dx: 5, dy: 10, zoom: 0 });
  gesture.reset();
  assert.equal(gesture.pointers.size, 0);
});

test('third finger pauses pinch and ending it establishes a fresh baseline', () => {
  const gesture = createOrbitGesture();
  gesture.begin(pointer(1, 0, 0));
  gesture.begin(pointer(2, 100, 0));
  gesture.begin(pointer(3, 40, 80));
  assert.deepEqual(gesture.move(pointer(2, 110, 0)), { dx: 0, dy: 0, zoom: 0 });
  gesture.end(pointer(3));
  assert.deepEqual(gesture.move(pointer(2, 120, 0)), { dx: 0, dy: 0, zoom: -0.3 });
});

function joystickFixture() {
  const stick = new EventTarget(), knob = { offsetWidth: 46, style: {} };
  const events = new EventTarget(), page = new EventTarget(), vector = { x: 0, y: 0 };
  let captured = null, enabled = true;
  stick.getBoundingClientRect = () => ({ left: 14, top: 500, width: 104, height: 104 });
  stick.setPointerCapture = id => { captured = id; };
  stick.hasPointerCapture = id => captured === id;
  stick.releasePointerCapture = () => { captured = null; };
  const controls = bindVirtualJoystick({ stick, knob, vector, events, page, enabled: () => enabled });
  const fire = (name, id = 1, x = 66, y = 552, button = 0) => {
    const event = new Event(name);
    Object.assign(event, pointer(id, x, y, 'touch', button));
    stick.dispatchEvent(event);
  };
  return { stick, knob, vector, events, page, controls, fire, disable() { enabled = false; } };
}

test('joystick tracks one finger, normalizes diagonal motion, and stays inside its ring', () => {
  const fixture = joystickFixture();
  fixture.fire('pointerdown', 1, 66, 525);
  assert.equal(fixture.vector.y, -1);
  fixture.fire('pointerdown', 2, 90, 570);
  fixture.fire('pointermove', 2, 90, 570);
  fixture.fire('pointerup', 2);
  assert.equal(fixture.vector.y, -1);
  fixture.fire('pointermove', 1, 200, 350);
  assert.ok(Math.abs(Math.hypot(fixture.vector.x, fixture.vector.y) - 1) < 1e-10);
  fixture.fire('pointermove', 1, 66, 525);
  assert.equal(fixture.knob.style.transform, 'translate(0px, -27px)');
  fixture.fire('pointerup');
  assert.deepEqual(fixture.vector, { x: 0, y: 0 });
  assert.equal(fixture.knob.style.transform, '');
});

for (const kind of ['pointercancel', 'lostpointercapture', 'blur', 'resize', 'visibilitychange']) {
  test(`joystick clears movement on ${kind} and does not resume from stale moves`, () => {
    const fixture = joystickFixture();
    fixture.fire('pointerdown', 1, 66, 525);
    if (kind === 'visibilitychange') {
      fixture.page.hidden = true;
      fixture.page.dispatchEvent(new Event(kind));
    } else if (kind === 'blur' || kind === 'resize') fixture.events.dispatchEvent(new Event(kind));
    else fixture.fire(kind);
    fixture.fire('pointermove', 1, 66, 500);
    assert.deepEqual(fixture.vector, { x: 0, y: 0 });
    assert.equal(fixture.knob.style.transform, '');
  });
}

test('disabled/disposed joysticks and failed capture cannot leave movement held', () => {
  const fixture = joystickFixture();
  fixture.stick.setPointerCapture = () => { throw new Error('detached pointer'); };
  fixture.fire('pointerdown', 1, 66, 525);
  assert.deepEqual(fixture.vector, { x: 0, y: 0 });
  fixture.disable();
  fixture.fire('pointerdown');
  fixture.controls.dispose();
  fixture.fire('pointerdown', 1, 66, 525);
  assert.deepEqual(fixture.vector, { x: 0, y: 0 });
});

test('Windows/Firefox line wheels and pixel trackpads have equivalent bounded zoom', () => {
  assert.equal(wheelPixels({ deltaY: 3, deltaMode: 1 }), 48);
  assert.equal(wheelPixels({ deltaY: 48, deltaMode: 0 }), 48);
  assert.equal(wheelPixels({ deltaY: -1, deltaMode: 2 }, 900), -240);
  assert.equal(wheelPixels({ deltaY: 10000, deltaMode: 0 }), 240);
  assert.equal(wheelPixels({ deltaY: NaN }), 0);
});
