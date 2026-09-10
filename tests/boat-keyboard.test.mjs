import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf("  addEventListener('keydown',", source.indexOf("promptEl.addEventListener('click', activateNearbyService)"));
assert.ok(start >= 0);
const handler = source.slice(start, source.indexOf('\n  });', start) + 6);

function setup({ aboard = false, nearby = true, editingText = false } = {}) {
  let calls = 0;
  const context = vm.createContext({
    activeBoatItem: aboard ? {} : null, nearBoat: nearby ? {} : null,
    isUiInteractionTarget: () => editingText,
    activateNearbyService: () => calls++, closeServicePanel: () => {},
    addEventListener: (_type, callback) => { context.keydown = callback; },
  });
  vm.runInContext(handler, context);
  return { press: (event) => context.keydown({ key: 'f', code: 'KeyF', ...event }), count: () => calls };
}

test('F, Korean rieul and IME Process/KeyF activate boat boarding and disembarking', () => {
  for (const state of [{ nearby: true }, { aboard: true, nearby: false }]) {
    const controls = setup(state);
    for (const event of [{ key: 'f' }, { key: 'F' }, { key: '\u3139', code: '' },
      { key: 'Process', code: 'KeyF', isComposing: true }]) controls.press(event);
    assert.equal(controls.count(), 4);
  }
});

test('unrelated keys and IME keys outside boat context do not activate', () => {
  const controls = setup();
  controls.press({ key: '\u3141', code: 'KeyA' });
  assert.equal(controls.count(), 0);
  const noBoat = setup({ nearby: false });
  noBoat.press({ key: '\u3139' });
  noBoat.press({ key: 'Process', code: 'KeyF' });
  assert.equal(noBoat.count(), 0);
  noBoat.press({ key: 'f' });
  assert.equal(noBoat.count(), 1);
});

test('holding a key, browser shortcuts and typing in UI never toggle the boat', () => {
  const controls = setup();
  for (const flag of ['repeat', 'ctrlKey', 'metaKey', 'altKey']) controls.press({ key: '\u3139', [flag]: true });
  assert.equal(controls.count(), 0);
  const textControls = setup({ editingText: true });
  textControls.press({ key: '\u3139' });
  textControls.press({ key: 'Process', isComposing: true });
  assert.equal(textControls.count(), 0);
});

test('visible boat shortcut labels remain F', () => {
  assert.ok(source.includes("hint.textContent = activeBoatItem ? 'F 하선' : 'F 승선'"));
});
