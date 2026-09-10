import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/ambient-audio.js', import.meta.url), 'utf8');
// Each controller gets isolated browser globals, without mutating the Node process.
const script = new vm.Script(`${source.replace('export function createAmbientAudio', 'function createAmbientAudio')}\ncreateAmbientAudio;`);
const snapshot = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeTarget {
  listeners = new Map();
  attributes = {};
  addEventListener(type, callback, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Map());
    this.listeners.get(type).set(callback, options);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatch(type) {
    for (const [callback, options] of [...(this.listeners.get(type) || [])]) {
      if (options.once) this.removeEventListener(type, callback);
      callback({ type });
    }
  }
  count(type) { return this.listeners.get(type)?.size || 0; }
  setAttribute(name, value) { this.attributes[name] = value; }
}

class FakeParam {
  value = 0;
  events = [];
  record(type, value, time, constant) {
    this.events.push({ type, value, time, constant });
    if (type !== 'cancel') this.value = value;
  }
  cancelScheduledValues(time) { this.record('cancel', null, time); }
  setValueAtTime(value, time) { this.record('set', value, time); }
  setTargetAtTime(value, time, constant) { this.record('target', value, time, constant); }
  exponentialRampToValueAtTime(value, time) { this.record('ramp', value, time); }
}

class FakeNode extends FakeTarget {
  constructor(context, kind) {
    super();
    this.context = context;
    this.kind = kind;
    this.gain = new FakeParam();
    this.frequency = new FakeParam();
    this.Q = new FakeParam();
    this.connections = new Set();
    this.disconnects = 0;
    this.stops = [];
    this.started = false;
    this.ended = false;
  }
  connect(target) { this.connections.add(target); }
  disconnect() { this.connections.clear(); this.disconnects++; }
  start(time = 0) {
    if (this.context.failStart === this.kind) throw new Error('start failed');
    this.started = true;
    this.startAt = time;
  }
  stop(time = this.context.currentTime) { this.stops.push(time); this.stopAt = time; }
  finish() { this.ended = true; this.dispatch('ended'); }
}

function setup(options = {}) {
  const instances = [];
  const document = new FakeTarget();
  const button = new FakeTarget();
  document.hidden = !!options.hidden;
  document.visibilityState = document.hidden ? 'hidden' : 'visible';
  document.show = (visible) => {
    document.hidden = !visible;
    document.visibilityState = visible ? 'visible' : 'hidden';
    document.dispatch('visibilitychange');
  };
  class FakeAudioContext {
    constructor() {
      if (options.failConstructor) throw new Error('constructor failed');
      this.state = options.initialState || 'suspended';
      this.currentTime = 0;
      this.sampleRate = 32;
      this.destination = {};
      this.nodes = [];
      this.buffers = [];
      this.calls = { resume: 0, suspend: 0, close: 0 };
      this.pending = { resume: [...(options.resume || [])], suspend: [], close: [] };
      this.failCreateAt = options.failCreateAt;
      this.failStart = options.failStart;
      instances.push(this);
    }
    create(kind) {
      if (this.nodes.length + 1 === this.failCreateAt) throw new Error('node creation failed');
      const node = new FakeNode(this, kind);
      this.nodes.push(node);
      return node;
    }
    createGain() { return this.create('gain'); }
    createOscillator() { return this.create('oscillator'); }
    createBiquadFilter() { return this.create('filter'); }
    createBufferSource() { return this.create('bufferSource'); }
    createBuffer(channels, size, rate) {
      const data = new Float32Array(size);
      const buffer = { channels, size, rate, getChannelData: () => data };
      this.buffers.push(buffer);
      return buffer;
    }
    operation(name, state) {
      this.calls[name]++;
      const result = this.pending[name].shift();
      if (result?.throws) throw result.throws;
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result?.promise).then(() => {
        if (this.state === 'closed' && name !== 'close') throw new Error('context closed');
        this.state = state;
      });
    }
    resume() { return this.operation('resume', 'running'); }
    suspend() { return this.operation('suspend', 'suspended'); }
    close() { return this.operation('close', 'closed'); }
    advance(seconds, end = true) {
      this.currentTime += seconds;
      if (end) {
        for (const node of this.nodes) {
          if (node.started && !node.ended && node.stopAt <= this.currentTime) node.finish();
        }
      }
    }
    get oscillators() { return this.nodes.filter((node) => node.kind === 'oscillator'); }
    get master() { return this.nodes[0]; }
  }
  const globals = options.noDocument ? {} : { document };
  if (options.supported !== false) {
    globals[options.webkit ? 'webkitAudioContext' : 'AudioContext'] = FakeAudioContext;
  }
  const createAmbientAudio = script.runInNewContext(globals);
  const audio = createAmbientAudio(options.noButton ? {} : { button });
  return { audio, document, button, instances, options, context: () => instances.at(-1) };
}

function agents(state) { return [{ key: 'builder', status: { state } }]; }

test('default mute, update, agent observations, and effects never create a context', async () => {
  const { audio, instances, button, document } = setup();
  for (const api of ['update', 'observeAgentStates', 'setEnabled', 'state', 'playEffect', 'dispose']) {
    assert.equal(typeof audio[api], 'function');
  }
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(button.attributes['aria-label'], '소리 켜기');
  assert.equal(button.disabled, false);
  assert.equal(await audio.setEnabled(false), false);
  audio.update({ elapsed: 1, precip: 0.5 });
  audio.observeAgentStates(agents('working'));
  audio.observeAgentStates(agents('done'));
  for (const name of audio.state().effects.names) assert.equal(audio.playEffect(name), false);
  document.show(false);
  document.show(true);
  await flush();
  assert.equal(instances.length, 0);
  const state = audio.state();
  assert.equal(state.supported, true);
  assert.equal(state.enabled, false);
  assert.equal(state.contextState, 'not-created');
  assert.equal(state.defaultMuted, true);
  assert.equal(state.powerSaving, false);
  assert.ok(state.levels.rain > 0);
  assert.equal(state.effects.activeVoices, 0);
  await audio.dispose();
});

test('unavailable audio is disabled, nonthrowing, and remains context-free', async () => {
  const { audio, button, instances } = setup({ supported: false });
  assert.equal(audio.state().supported, false);
  assert.equal(button.disabled, true);
  assert.equal(await audio.setEnabled(true), false);
  assert.equal(audio.playEffect('confirm'), false);
  button.dispatch('click');
  await flush();
  assert.equal(instances.length, 0);
  assert.equal(audio.state().enabled, false);
  await audio.dispose();
});

test('webkit fallback and absent optional document/button work', async () => {
  const { audio, context } = setup({ webkit: true, noDocument: true, noButton: true });
  assert.equal(await audio.setEnabled(true), true);
  assert.equal(context().calls.resume, 1);
  assert.equal(audio.playEffect('open'), true);
  await audio.dispose();
});

test('all four effects are short, quiet, distinct, and routed through the existing master', async () => {
  const { audio, context, instances } = setup();
  await audio.setEnabled(true);
  const ctx = context();
  assert.deepEqual(snapshot(audio.state().effects.names), ['board', 'land', 'open', 'confirm']);
  const frequencies = [];
  for (const name of audio.state().effects.names) {
    const before = ctx.nodes.length;
    assert.equal(audio.playEffect(name), true);
    const [gain, oscillator] = ctx.nodes.slice(before);
    assert.equal(gain.kind, 'gain');
    assert.equal(oscillator.kind, 'oscillator');
    assert.ok(oscillator.connections.has(gain));
    assert.ok(gain.connections.has(ctx.master));
    assert.ok(!gain.connections.has(ctx.destination));
    assert.ok(oscillator.stopAt - oscillator.startAt <= 0.24);
    assert.ok(gain.gain.events.every((event) => event.value > 0 && event.value <= 0.035));
    frequencies.push(oscillator.frequency.events[0].value);
    assert.equal(audio.state().effects.played[name], 1);
  }
  assert.equal(new Set(frequencies).size, 4);
  assert.equal(instances.length, 1);
  assert.equal(audio.state().effects.activeVoices, 4);
  assert.equal(audio.state().effects.lastEffect, 'confirm');
  assert.ok(ctx.master.connections.has(ctx.destination));
  await audio.dispose();
});

test('unknown names including prototype keys are ignored without allocating nodes', async () => {
  const { audio, context } = setup();
  await audio.setEnabled(true);
  const count = context().nodes.length;
  for (const name of ['oops', '__proto__', 'constructor', 'toString', '', null, {}, Symbol('open')]) {
    assert.equal(audio.playEffect(name), false);
  }
  assert.equal(context().nodes.length, count);
  assert.equal(audio.state().effects.dropped.unknown, 8);
  await audio.dispose();
});

test('debounce is independent per effect, exact-boundary inclusive, and rejected calls do not extend it', async () => {
  const { audio, context } = setup();
  await audio.setEnabled(true);
  const ctx = context();
  assert.equal(audio.playEffect('board'), true);
  const debounce = audio.state().effects.debounceSeconds.board;
  ctx.advance(debounce / 2);
  assert.equal(audio.playEffect('board'), false);
  assert.equal(audio.playEffect('open'), true);
  ctx.advance(debounce / 2);
  assert.equal(audio.playEffect('board'), true);
  assert.equal(audio.state().effects.played.board, 2);
  assert.equal(audio.state().effects.dropped.debounce, 1);
  assert.equal(audio.state().effects.lastPlayedAt.board, debounce);
  await audio.dispose();
});

test('voice cap holds even when ended events are delayed and natural endings release all nodes', async () => {
  const { audio, context } = setup();
  await audio.setEnabled(true);
  const ctx = context();
  for (const name of audio.state().effects.names) audio.playEffect(name);
  const count = ctx.nodes.length;
  ctx.advance(1, false);
  assert.equal(audio.playEffect('board'), false);
  assert.equal(ctx.nodes.length, count);
  assert.equal(audio.state().effects.activeVoices, audio.state().effects.maxVoices);
  assert.equal(audio.state().effects.dropped.voiceLimit, 1);
  const nodes = ctx.nodes.slice(-8);
  ctx.advance(0);
  assert.equal(audio.state().effects.activeVoices, 0);
  for (const node of nodes) {
    assert.equal(node.connections.size, 0);
    assert.equal(node.disconnects, 1);
    assert.equal(node.count('ended'), 0);
  }
  assert.equal(audio.playEffect('board'), true);
  await audio.dispose();
});

test('completion chime preserves initial silence and debounce, sharing the oscillator cap', async () => {
  const { audio, context } = setup();
  await audio.setEnabled(true);
  const ctx = context();
  audio.observeAgentStates(agents('done'));
  assert.equal(ctx.oscillators.length, 0);
  audio.observeAgentStates(agents('working'));
  audio.observeAgentStates(agents('completed'));
  assert.equal(ctx.oscillators.length, 2);
  assert.equal(audio.playEffect('board'), true);
  assert.equal(audio.playEffect('land'), true);
  assert.equal(audio.playEffect('open'), false);
  ctx.advance(1);
  audio.observeAgentStates(agents('working'));
  audio.observeAgentStates(agents('done'));
  assert.equal(ctx.oscillators.length, 4);
  ctx.advance(0.5);
  for (const name of ['board', 'land', 'open']) audio.playEffect(name);
  audio.observeAgentStates(agents('working'));
  audio.observeAgentStates(agents('done'));
  assert.equal(audio.state().effects.activeVoices, 3);
  ctx.advance(1);
  audio.observeAgentStates(agents('working'));
  audio.observeAgentStates(agents('done'));
  assert.equal(audio.state().effects.activeVoices, 2);
  await audio.dispose();
});

test('mute immediately silences and clears both effects and completion voices, reusing the graph on enable', async () => {
  const { audio, context, instances, button } = setup();
  await audio.setEnabled(true);
  const ctx = context();
  audio.observeAgentStates(agents('working'));
  audio.observeAgentStates(agents('done'));
  audio.playEffect('confirm');
  const muting = audio.setEnabled(false);
  assert.equal(audio.state().enabled, false);
  assert.equal(audio.state().effects.activeVoices, 0);
  assert.equal(ctx.master.gain.value, 0);
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(audio.playEffect('open'), false);
  for (const oscillator of ctx.oscillators) {
    assert.equal(oscillator.stops.length, 2);
    assert.equal(oscillator.connections.size, 0);
    assert.equal(oscillator.count('ended'), 0);
  }
  await muting;
  assert.equal(ctx.state, 'suspended');
  assert.equal(audio.state().powerSaving, true);
  await audio.setEnabled(true);
  assert.equal(instances.length, 1);
  assert.equal(ctx.state, 'running');
  assert.equal(audio.state().effects.activeVoices, 0);
  await audio.dispose();
});

test('visibility suspends enabled audio without forgetting opt-in and never resumes a muted tab', async () => {
  const { audio, context, document, button } = setup();
  await audio.setEnabled(true);
  const ctx = context();
  audio.playEffect('open');
  document.show(false);
  assert.equal(ctx.master.gain.value, 0);
  assert.equal(audio.state().effects.activeVoices, 0);
  assert.equal(audio.state().enabled, true);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(audio.playEffect('board'), false);
  await flush();
  assert.equal(ctx.state, 'suspended');
  assert.equal(audio.state().powerSaving, true);
  document.show(true);
  await flush();
  assert.equal(ctx.state, 'running');
  assert.equal(ctx.calls.resume, 2);
  document.show(false);
  await flush();
  await audio.setEnabled(false);
  document.show(true);
  await flush();
  assert.equal(ctx.state, 'suspended');
  assert.equal(ctx.calls.resume, 2);
  await audio.dispose();
});

test('opting in while hidden defers creation until visible; cancelled opt-in never starts audio', async () => {
  const { audio, instances, document } = setup({ hidden: true });
  assert.equal(await audio.setEnabled(true), true);
  assert.equal(instances.length, 0);
  assert.equal(audio.playEffect('open'), false);
  await audio.setEnabled(false);
  document.show(true);
  await flush();
  assert.equal(instances.length, 0);
  document.show(false);
  await audio.setEnabled(true);
  document.show(true);
  await flush();
  assert.equal(instances.length, 1);
  assert.equal(audio.state().audible, true);
  await audio.dispose();
});

test('weather QA fields and throttled layer updates survive mute and resume', async () => {
  const { audio, context, document } = setup();
  audio.update({ elapsed: 0, wind: 0.2, precip: 0, cloud: 0.3, day: 1 });
  assert.deepEqual(snapshot(audio.state().levels), { ocean: 0.045, wind: 0.023, rain: 0 });
  await audio.setEnabled(true);
  const ctx = context();
  const gains = ctx.nodes.filter((node) => node.kind === 'gain').slice(1);
  audio.update({ elapsed: 2, precip: 0.5 });
  assert.ok(gains.every((gain) => gain.gain.events.length === 1));
  audio.update({ elapsed: 2.05, precip: 0.8 });
  assert.ok(gains.every((gain) => gain.gain.events.length === 1));
  document.show(false);
  audio.update({ elapsed: 3 });
  assert.ok(gains.every((gain) => gain.gain.events.length === 1));
  await flush();
  document.show(true);
  await flush();
  audio.update({ elapsed: 0 });
  assert.ok(gains.every((gain) => gain.gain.events.length === 2));
  await audio.dispose();
});

test('latest mute wins a pending resume without any stale gain-up', async () => {
  const pending = deferred();
  const { audio, context, button } = setup({ resume: [pending] });
  const enabling = audio.setEnabled(true);
  await flush();
  const ctx = context();
  assert.equal(ctx.calls.resume, 1);
  assert.equal(audio.playEffect('board'), false);
  const muting = audio.setEnabled(false);
  assert.equal(button.attributes['aria-pressed'], 'false');
  pending.resolve();
  assert.equal(await enabling, false);
  assert.equal(await muting, false);
  assert.equal(ctx.state, 'suspended');
  assert.ok(!ctx.master.gain.events.some((event) => event.value > 0));
  await audio.dispose();
});

test('an old resume rejection cannot disable a newer enable request', async () => {
  const pending = deferred();
  const { audio, context, instances, button } = setup({ resume: [pending] });
  const first = audio.setEnabled(true);
  await flush();
  const second = audio.setEnabled(false);
  const third = audio.setEnabled(true);
  pending.reject(new Error('stale resume failure'));
  await Promise.all([first, second, third]);
  assert.equal(audio.state().enabled, true);
  assert.equal(audio.state().audible, true);
  assert.equal(audio.state().lastError, null);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(context().calls.resume, 2);
  assert.equal(instances.length, 1);
  await audio.dispose();
});

test('a pending suspend completes before the latest enable resumes the same context', async () => {
  const { audio, context } = setup();
  await audio.setEnabled(true);
  const ctx = context();
  const pending = deferred();
  ctx.pending.suspend.push(pending);
  const muting = audio.setEnabled(false);
  await flush();
  const enabling = audio.setEnabled(true);
  assert.equal(audio.playEffect('board'), false);
  assert.equal(ctx.calls.resume, 1);
  pending.resolve();
  await Promise.all([muting, enabling]);
  assert.equal(ctx.calls.resume, 2);
  assert.equal(ctx.state, 'running');
  assert.equal(audio.state().audible, true);
  await audio.dispose();
});

test('stale suspend failure does not undo a newer enable', async () => {
  const { audio, context } = setup();
  await audio.setEnabled(true);
  const pending = deferred();
  context().pending.suspend.push(pending);
  const muting = audio.setEnabled(false);
  await flush();
  const enabling = audio.setEnabled(true);
  pending.reject(new Error('old suspend failed'));
  await Promise.all([muting, enabling]);
  assert.equal(audio.state().audible, true);
  assert.equal(context().calls.close, 0);
  await audio.dispose();
});

test('hide during resume cannot unmute, and visibility changes during suspend reconcile to the latest state', async () => {
  const pending = deferred();
  const { audio, context, document } = setup({ resume: [pending] });
  const enabling = audio.setEnabled(true);
  await flush();
  document.show(false);
  pending.resolve();
  await enabling;
  await flush();
  const ctx = context();
  assert.equal(ctx.state, 'suspended');
  assert.equal(audio.state().enabled, true);
  assert.ok(!ctx.master.gain.events.some((event) => event.value > 0));
  document.show(true);
  await flush();
  const suspend = deferred();
  ctx.pending.suspend.push(suspend);
  document.show(false);
  await flush();
  document.show(true);
  document.show(false);
  document.show(true);
  suspend.resolve();
  await flush();
  assert.equal(ctx.state, 'running');
  assert.equal(audio.state().audible, true);
  assert.equal(ctx.calls.resume, 3);
  await audio.dispose();
});

test('constructor and partial graph failures clean up and permit explicit retry', async () => {
  for (const failure of [{ failConstructor: true }, { failCreateAt: 5 }, { failStart: 'bufferSource' }]) {
    const options = { ...failure };
    const { audio, instances } = setup(options);
    assert.equal(await audio.setEnabled(true), false);
    assert.equal(audio.state().enabled, false);
    assert.equal(audio.state().contextState, 'not-created');
    assert.ok(audio.state().lastError);
    for (const ctx of instances) {
      assert.equal(ctx.state, 'closed');
      assert.ok(ctx.nodes.every((node) => node.connections.size === 0));
    }
    delete options.failConstructor;
    delete options.failCreateAt;
    delete options.failStart;
    assert.equal(await audio.setEnabled(true), true);
    assert.equal(audio.state().lastError, null);
    await audio.dispose();
  }
});

test('current resume failure resets toggle, cleans graph, and does not retry on visibility alone', async () => {
  const options = { resume: [new Error('permission denied')] };
  const { audio, context, button, document, instances } = setup(options);
  assert.equal(await audio.setEnabled(true), false);
  assert.equal(context().state, 'closed');
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(audio.state().lastError, 'permission denied');
  assert.equal(audio.playEffect('confirm'), false);
  document.show(false);
  document.show(true);
  await flush();
  assert.equal(instances.length, 1);
  options.resume = [];
  assert.equal(await audio.setEnabled(true), true);
  assert.equal(instances.length, 2);
  await audio.dispose();
});

test('suspend rejection or synchronous throw fails closed, even if close rejects', async () => {
  for (const failure of [new Error('suspend rejected'), { throws: new Error('suspend threw') }]) {
    const { audio, context } = setup();
    await audio.setEnabled(true);
    const ctx = context();
    ctx.pending.suspend.push(failure);
    ctx.pending.close.push(new Error('close failed'));
    assert.equal(await audio.setEnabled(false), false);
    assert.equal(audio.state().contextState, 'not-created');
    assert.equal(audio.state().audible, false);
    assert.equal(ctx.master.gain.value, 0);
    assert.ok(ctx.nodes.every((node) => node.connections.size === 0));
    assert.equal(ctx.calls.close, 1);
    await audio.dispose();
  }
});

test('failed effect allocation or start cleans partial voices without consuming debounce or disabling ambience', async () => {
  for (const failure of ['allocation', 'start']) {
    const { audio, context } = setup();
    await audio.setEnabled(true);
    const ctx = context();
    const before = ctx.nodes.length;
    if (failure === 'allocation') ctx.failCreateAt = before + 2;
    else ctx.failStart = 'oscillator';
    assert.equal(audio.playEffect('board'), false);
    assert.equal(audio.state().effects.activeVoices, 0);
    assert.equal(audio.state().effects.played.board, 0);
    assert.equal(audio.state().effects.lastPlayedAt.board, null);
    assert.equal(audio.state().effects.dropped.failure, 1);
    assert.equal(audio.state().audible, true);
    assert.ok(ctx.nodes.slice(before).every((node) => node.connections.size === 0 && node.count('ended') === 0));
    ctx.failCreateAt = null;
    ctx.failStart = null;
    assert.equal(audio.playEffect('board'), true);
    await audio.dispose();
  }
});

test('partial two-voice chime failure rolls back every allocated voice', async () => {
  const { audio, context } = setup();
  await audio.setEnabled(true);
  const ctx = context();
  const before = ctx.nodes.length;
  ctx.failCreateAt = before + 4;
  audio.observeAgentStates(agents('working'));
  audio.observeAgentStates(agents('done'));
  assert.equal(audio.state().effects.activeVoices, 0);
  assert.ok(ctx.nodes.slice(before).every((node) => node.connections.size === 0 && node.count('ended') === 0));
  ctx.failCreateAt = null;
  audio.observeAgentStates(agents('working'));
  audio.observeAgentStates(agents('done'));
  assert.equal(audio.state().effects.activeVoices, 2);
  await audio.dispose();
});

test('dispose is idempotent, closes once, removes listeners, and stops and disconnects every node', async () => {
  const { audio, context, document, button, instances } = setup();
  await audio.setEnabled(true);
  audio.playEffect('board');
  const ctx = context();
  assert.equal(document.count('visibilitychange'), 1);
  assert.equal(button.count('click'), 1);
  const disposal = audio.dispose();
  assert.equal(audio.dispose(), disposal);
  assert.equal(audio.state().disposed, true);
  assert.equal(audio.state().enabled, false);
  assert.equal(audio.state().effects.activeVoices, 0);
  assert.equal(document.count('visibilitychange'), 0);
  assert.equal(button.count('click'), 0);
  assert.equal(button.disabled, true);
  assert.ok(ctx.nodes.every((node) => node.connections.size === 0));
  assert.ok(ctx.nodes.filter((node) => node.started).every((node) => node.stops.length > 0));
  await disposal;
  assert.equal(ctx.state, 'closed');
  assert.equal(ctx.calls.close, 1);
  assert.equal(await audio.setEnabled(true), false);
  assert.equal(audio.playEffect('confirm'), false);
  const levels = snapshot(audio.state().levels);
  audio.update({ precip: 1 });
  assert.deepEqual(snapshot(audio.state().levels), levels);
  audio.observeAgentStates(agents('done'));
  document.show(false);
  document.show(true);
  button.dispatch('click');
  await flush();
  assert.equal(instances.length, 1);
});

test('dispose before enable never allocates a context', async () => {
  const { audio, instances } = setup();
  await audio.dispose();
  assert.equal(await audio.setEnabled(true), false);
  assert.equal(instances.length, 0);
});

test('dispose during pending resume closes immediately and stale success or failure cannot resurrect audio', async () => {
  for (const reject of [false, true]) {
    const pending = deferred();
    const { audio, context } = setup({ resume: [pending] });
    const enabling = audio.setEnabled(true);
    await flush();
    const ctx = context();
    await audio.dispose();
    assert.equal(ctx.state, 'closed');
    if (reject) pending.reject(new Error('late failure'));
    else pending.resolve();
    assert.equal(await enabling, false);
    assert.equal(audio.state().disposed, true);
    assert.equal(audio.state().lastError, null);
    assert.ok(!ctx.master.gain.events.some((event) => event.value > 0));
    assert.equal(ctx.calls.close, 1);
  }
});

test('button uses the same robust toggle path, including failed resume and rapid clicks', async () => {
  const pending = deferred();
  const { audio, button, context } = setup({ resume: [pending] });
  button.dispatch('click');
  assert.equal(button.attributes['aria-pressed'], 'true');
  await flush();
  button.dispatch('click');
  button.dispatch('click');
  pending.reject(new Error('stale click failed'));
  await flush();
  assert.equal(audio.state().audible, true);
  button.dispatch('click');
  await flush();
  context().pending.resume.push(new Error('current click failed'));
  button.dispatch('click');
  await flush();
  assert.equal(audio.state().enabled, false);
  assert.equal(button.attributes['aria-pressed'], 'false');
  await audio.dispose();
});

test('state snapshots cannot mutate effect bookkeeping', async () => {
  const { audio } = setup();
  await audio.setEnabled(true);
  audio.playEffect('board');
  const state = audio.state();
  state.effects.played.board = 999;
  state.effects.lastPlayedAt.board = -99;
  state.effects.debounceSeconds.board = 0;
  state.effects.names.length = 0;
  state.effects.dropped.debounce = 999;
  state.levels.ocean = 999;
  assert.equal(audio.playEffect('board'), false);
  assert.equal(audio.state().effects.played.board, 1);
  assert.equal(audio.state().effects.names.length, 4);
  assert.equal(audio.state().effects.dropped.debounce, 1);
  assert.equal(audio.state().levels.ocean, 0);
  await audio.dispose();
});

test('already-running and externally closed contexts are handled without duplicate live graphs', async () => {
  const { audio, context, instances } = setup({ initialState: 'running' });
  assert.equal(await audio.setEnabled(true), true);
  assert.equal(context().calls.resume, 0);
  const old = context();
  old.state = 'closed';
  assert.equal(audio.playEffect('open'), false);
  assert.equal(await audio.setEnabled(true), true);
  assert.equal(instances.length, 2);
  assert.ok(old.nodes.every((node) => node.connections.size === 0));
  await audio.dispose();
});

test('initial trusted click constructs and calls resume synchronously, with the combined sound label', async () => {
  const pending = deferred();
  const { audio, button, context, instances } = setup({ resume: [pending] });
  button.dispatch('click');
  assert.equal(instances.length, 1);
  assert.equal(context().calls.resume, 1);
  assert.equal(button.attributes['aria-label'], '소리 끄기');
  assert.equal(button.title, '소리 끄기');
  pending.resolve();
  await flush();
  assert.equal(audio.state().audible, true);
  await audio.dispose();
});

test('hidden-tab handling is not blocked by a never-settled resume; a late resume is suspended again', async () => {
  const pending = deferred();
  const { audio, context, document } = setup({ resume: [pending] });
  const enabling = audio.setEnabled(true);
  const ctx = context();
  // Some browsers report interrupted rather than suspended during unlock.
  ctx.state = 'interrupted';
  document.show(false);
  await flush();
  assert.equal(ctx.calls.suspend, 1);
  assert.equal(ctx.state, 'suspended');
  assert.equal(await enabling, true);
  assert.equal(audio.state().audible, false);
  pending.resolve();
  await flush();
  assert.equal(ctx.calls.suspend, 2);
  assert.equal(ctx.state, 'suspended');
  assert.equal(ctx.master.gain.value, 0);
  document.show(true);
  await flush();
  assert.equal(audio.state().audible, true);
  await audio.dispose();
});

test('new enable can retry unlock without waiting for the old resume; late rejection stays harmless', async () => {
  const pending = deferred();
  const { audio, context } = setup({ resume: [pending] });
  const first = audio.setEnabled(true);
  const mute = audio.setEnabled(false);
  const latest = audio.setEnabled(true);
  await flush();
  assert.equal(await latest, true);
  assert.equal(context().calls.resume, 2);
  assert.equal(audio.state().audible, true);
  pending.reject(new Error('obsolete unlock failed'));
  await Promise.all([first, mute]);
  await flush();
  assert.equal(audio.state().audible, true);
  assert.equal(audio.state().lastError, null);
  await audio.dispose();
});
