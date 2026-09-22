import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/performance.js', import.meta.url), 'utf8');

function setup(qualityOverride = '', { dpr = 2, width = 1280, cores = 8, memory = 0, coarse = false } = {}) {
  let now = 0, size = [width, 800], ratio = 1, resets = 0;
  const listeners = {};
  const ctx = vm.createContext({
    window: { devicePixelRatio: dpr, matchMedia: () => ({ matches: coarse }) },
    navigator: { hardwareConcurrency: cores, deviceMemory: memory }, innerWidth: width,
    document: { body: { dataset: {} }, hidden: false, addEventListener: (name, fn) => { listeners[name] = fn; } },
    performance: { now: () => now },
  });
  vm.runInContext(source.replace('export function', 'function'), ctx);
  const bloom = { enabled: true, strength: 0.1, sizes: [], setSize(w, h) { this.sizes.push([w, h]); } };
  const renderer = {
    info: { render: { calls: 10, triangles: 100 }, reset() { resets++; } }, shadowMap: {},
    setPixelRatio(value) { this.pixelRatio = value; }, setSize(w, h) { this.size = [w, h]; },
  };
  const composer = {
    setPixelRatio(value) { ratio = value; this.setSize(...size); },
    setSize(w, h) { size = [w, h]; bloom.setSize(w * ratio, h * ratio); },
  };
  const governor = ctx.createPerformanceGovernor({ renderer, composer, bloom, qualityOverride });
  return { governor, bloom, renderer, ctx, listeners, resets: () => resets,
    advance(step, count) { for (let i = 0; i < count; i++) { now += step; governor.sample(now); } } };
}

test('performance quality skips bloom and keeps all five mip levels nonzero after resize', () => {
  const { governor, bloom, renderer } = setup('low');
  assert.equal(governor.state().tier, 'performance');
  assert.equal(bloom.enabled, false);
  assert.equal(bloom.strength, 0);
  assert.deepEqual(bloom.sizes.at(-1), [32, 32]);
  governor.resize(390, 844);
  assert.deepEqual(bloom.sizes.at(-1), [32, 32]);
  assert.equal(renderer.pixelRatio, 1);
});

test('touch-first devices start conservatively without reducing ordinary desktop quality', () => {
  assert.equal(setup('', { dpr: 1, cores: 16 }).governor.state().tier, 'high');
  assert.equal(setup('', { dpr: 1, cores: 8, coarse: true }).governor.state().tier, 'balanced');
  assert.equal(setup('', { dpr: 3, cores: 4, coarse: true }).governor.state().tier, 'performance');
  assert.equal(setup('', { cores: 8, memory: 2, coarse: true }).governor.state().tier, 'performance');
  assert.equal(setup('high', { cores: 4, coarse: true }).governor.state().tier, 'high');
});

test('sustained very slow rendering reduces quality while long suspension gaps are ignored', () => {
  const slow = setup('', { dpr: 1, cores: 16 });
  slow.advance(160, 200);
  assert.equal(slow.governor.state().tier, 'performance');
  const paused = setup('', { dpr: 1, cores: 16 });
  paused.advance(5000, 100);
  assert.equal(paused.governor.state().tier, 'high');
  assert.equal(paused.governor.state().samples, 0);
});

test('balanced bloom is lower resolution and high quality fully restores it', () => {
  const { governor, bloom, renderer } = setup('balanced');
  assert.deepEqual(bloom.sizes.at(-1), [1123, 702]);
  assert.equal(bloom.enabled, true);
  governor.setTier('performance');
  governor.resize(1000, 600);
  governor.setTier('high');
  assert.deepEqual(bloom.sizes.at(-1), [1600, 960]);
  assert.equal(bloom.strength, 0.1);
  assert.equal(renderer.shadowMap.autoUpdate, true);
});

test('invalid quality names cannot resolve Object prototype entries', () => {
  const { governor } = setup('constructor');
  assert.equal(governor.state().tier, 'balanced');
  assert.equal(governor.state().locked, false);
  for (const name of ['constructor', 'toString', '__proto__', 'unknown']) {
    governor.setTier(name);
    assert.equal(governor.state().tier, 'balanced');
    assert.equal(governor.state().locked, false);
  }
});

test('automatic quality reduces sustained load, recovers slowly, and honors manual locks', () => {
  const auto = setup('', { dpr: 1, cores: 16 });
  auto.advance(30, 350);
  assert.equal(auto.governor.state().tier, 'balanced');
  auto.advance(30, 300);
  assert.equal(auto.governor.state().tier, 'performance');
  auto.advance(16.67, 400);
  assert.equal(auto.governor.state().tier, 'performance');
  auto.advance(16.67, 2300);
  assert.equal(auto.governor.state().tier, 'high');
  auto.governor.setTier('balanced');
  auto.advance(30, 1000);
  assert.equal(auto.governor.state().tier, 'balanced');
});

test('resizing across screens and hidden tabs keeps shadow and sampling budgets bounded', () => {
  const state = setup('performance');
  state.ctx.window.devicePixelRatio = 1;
  state.governor.resize(800, 600);
  assert.equal(state.governor.state().nativePixelRatio, 1);
  const skyProfiles = [];
  state.governor.attachSkySystem({ setPerformanceProfile: p => skyProfiles.push(p) });
  assert.equal(skyProfiles.at(-1).rainSegments, 300);
  for (let i = 0; i < 60; i++) state.governor.beforeRender(1 / 60);
  assert.equal(state.resets(), 60);
  state.advance(16.67, 60);
  const samples = state.governor.state().samples;
  state.ctx.document.hidden = true;
  state.listeners.visibilitychange();
  state.advance(30, 1000);
  assert.equal(state.governor.state().samples, samples);
});
