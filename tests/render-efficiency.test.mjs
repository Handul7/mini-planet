import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createVisibilityLoop, createElementSizeCache } from '../src/render-efficiency.js';

function harness() {
  const page = new EventTarget();
  page.hidden = false;
  const queue = new Map();
  const calls = [];
  let id = 0, blocked = false, pauses = 0;
  const loop = createVisibilityLoop({ document: page, frame: (...args) => calls.push(args),
    requestFrame: (fn) => { queue.set(++id, fn); return id; }, cancelFrame: (id) => queue.delete(id),
    blocked: () => blocked, onPause: () => pauses++,
  });
  return { loop, calls, queue,
    step(now) { for (const [id, fn] of [...queue]) { queue.delete(id); fn(now); } },
    hide(value) { page.hidden = value; page.dispatchEvent(new Event('visibilitychange')); },
    block(value) { blocked = value; loop.refresh(); },
    pauses: () => pauses,
  };
}

test('one frame is scheduled, dt is bounded and hidden time is not simulated', () => {
  const h = harness(); h.loop.start(); h.loop.start();
  assert.equal(h.queue.size, 1);
  h.step(100); h.step(116); h.step(500);
  assert.equal(h.calls[1][0], 0.016);
  assert.equal(h.calls[2][0], 0.05);
  h.hide(true);
  assert.equal(h.queue.size, 0);
  assert.equal(h.loop.state().paused, true);
  const elapsed = h.calls.at(-1)[1];
  h.step(10000);
  assert.equal(h.calls.length, 3);
  h.hide(false); h.hide(false);
  assert.equal(h.queue.size, 1);
  h.step(20000);
  assert.equal(h.calls.at(-1)[0], 0);
  assert.equal(h.calls.at(-1)[1], elapsed);
  h.loop.dispose(); assert.equal(h.queue.size, 0);
  h.hide(false); assert.equal(h.queue.size, 0);
});

test('lost graphics context and initially hidden pages schedule no GPU work', () => {
  const h = harness(); h.hide(true); h.loop.start();
  assert.equal(h.queue.size, 0);
  h.hide(false); h.step(100);
  h.block(true); assert.equal(h.queue.size, 0);
  h.block(false); h.step(1000);
  assert.equal(h.calls.at(-1)[0], 0);
  assert.ok(h.pauses() > 0);
  h.loop.dispose();
});

test('stable labels reuse measurements and changes invalidate dimensions', () => {
  let callback, unobserved = 0, disconnected = false;
  class Observer {
    constructor(fn) { callback = fn; }
    observe() {}
    unobserve() { unobserved++; }
    disconnect() { disconnected = true; }
  }
  const cache = createElementSizeCache({ Observer });
  const element = { textContent: 'Rodi', className: 'label', offsetWidth: 80, offsetHeight: 24 };
  for (let i = 0; i < 60; i++) cache.measure(element, i * 16);
  assert.deepEqual(cache.state(), { reads: 1, hits: 59, tracked: 1 });
  callback([{ target: element, borderBoxSize: [{ inlineSize: 92, blockSize: 26 }] }]);
  assert.equal(cache.measure(element, 950).width, 92);
  callback([{ target: element, borderBoxSize: [{ inlineSize: 0, blockSize: 0 }] }]);
  assert.equal(cache.measure(element, 960).width, 92);
  element.textContent = 'Long updated task'; element.offsetWidth = 160;
  assert.equal(cache.measure(element, 970).width, 160);
  element.className = 'label bubble'; element.offsetHeight = 48;
  assert.equal(cache.measure(element, 980).height, 48);
  cache.measure(element, 2000);
  assert.equal(cache.state().reads, 4);
  cache.remove(element); assert.equal(unobserved, 1);
  assert.equal(cache.state().tracked, 0);
  cache.dispose(); assert.equal(disconnected, true);
});

test('label cache has a bounded fallback without ResizeObserver', () => {
  const cache = createElementSizeCache({ Observer: null });
  const element = { textContent: 'x', offsetWidth: 60, offsetHeight: 20 };
  cache.measure(element, 0); element.offsetWidth = 100;
  assert.equal(cache.measure(element, 900).width, 60);
  assert.equal(cache.measure(element, 1000).width, 100);
});

test('circular zone broad phase matches the original angular test', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const start = source.indexOf('function zoneContains(');
  const fn = source.slice(start, source.indexOf('\n}', start) + 2);
  const ctx = vm.createContext({ Math });
  vm.runInContext(`${fn}; this.check = zoneContains`, ctx);
  for (const radius of [0, 0.05, 0.2, 1.5, Math.PI, 4]) {
    for (const extra of [-0.1, 0, 0.01, 0.3]) {
      for (let i = 0; i <= 100; i++) {
        const dot = Math.cos(i / 100 * Math.PI);
        assert.equal(ctx.check({ radius, dir: {} }, { dot: () => dot }, extra),
          Math.acos(dot) <= radius + extra);
      }
    }
  }
});

test('main keeps projection per frame but batches size reads before style writes', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('labelSizeCache.measure(') < source.indexOf('label.element.style.opacity = candidate.opacity'));
  assert.match(source, /if \(!root.visible\) continue;/);
  assert.doesNotMatch(source, /requestAnimationFrame\(animate\)/);
});
