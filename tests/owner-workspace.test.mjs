import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { aggregateOwnerOverview } from '../src/owner-overview.js';

const source = readFileSync(new URL('../src/owner-workspace.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export function initOwnerWorkspace', 'function initOwnerWorkspace');
const resourceKeys = ['board', 'jobs:default', 'jobs:rodi', 'jobs:jarvis', 'results:rodi'];
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Only DOM operations used by this module are implemented. No layout or browser
// behavior is inferred: these tests exercise controller calls and rendered data.
class EventTargetFixture {
  listeners = new Map();
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, values = {}) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
}

class ElementFixture extends EventTargetFixture {
  constructor(tag, document) {
    super();
    this.tagName = tag.toUpperCase();
    this.document = document;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.id = '';
    this.hidden = false;
    this.scrollTop = 0;
    this._text = '';
    this.classList = {
      add: (name) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(' '); },
      remove: (name) => { this.className = this.className.split(/\s+/).filter((entry) => entry !== name).join(' '); },
    };
  }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  append(...children) {
    for (const child of children) { child.parentElement = this; this.children.push(child); }
  }
  replaceChildren(...children) {
    if (this.children.some((child) => child.contains(this.document.activeElement))) this.document.activeElement = this.document.body;
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._text = '';
    this.append(...children);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
  get isConnected() { return this === this.document.body || !!this.parentElement?.isConnected; }
  focus() { this.document.activeElement = this; }
  remove() {
    if (this.contains(this.document.activeElement)) this.document.activeElement = this.document.body;
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  querySelectorAll(selector) {
    const matches = (element) => selector.startsWith('.')
      ? element.className.split(/\s+/).includes(selector.slice(1))
      : selector === '[data-resource]' ? Object.hasOwn(element.dataset, 'resource')
        : selector.startsWith('#') ? element.id === selector.slice(1) : element.tagName === selector.toUpperCase();
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function documentFixture(hidden) {
  const document = new EventTargetFixture();
  document.hidden = hidden;
  document.createElement = (tag) => new ElementFixture(tag, document);
  document.body = document.createElement('body');
  document.activeElement = document.body;
  document.getElementById = (id) => document.body.querySelector(`#${id}`);
  return document;
}

function signedOut() {
  return {
    authenticated: false, sessionError: null, loggingOut: false,
    resources: Object.fromEntries(resourceKeys.map((key) => [key, { state: 'unknown', usable: false, data: null }])),
  };
}

function freshResources() {
  const view = (data) => ({ state: 'ok', usable: true, data, lastSuccessAt: '2026-09-26T01:00:00Z' });
  return {
    board: view({ tasks: [{ id: 'blocked-1', title: 'Private blocked task', status: 'blocked', assignee: 'rodi' }],
      counts: { running: 0, blocked: 1, review: 0, done: 0 }, task_count: 1 }),
    'jobs:default': view({ count: 0, jobs: [] }),
    'jobs:rodi': view({ count: 0, jobs: [] }),
    'jobs:jarvis': view({ count: 0, jobs: [] }),
    'results:rodi': { state: 'unknown', usable: false, data: null },
  };
}

function setup({ hidden = false } = {}) {
  const document = documentFixture(hidden);
  const timers = new Map();
  const calls = { checkSession: 0, refreshAll: 0, tick: 0, logout: 0, dispose: 0 };
  const changes = [];
  let currentState = signedOut(), onChange, nextTickState = null, timerId = 0;
  const emit = (next) => { currentState = structuredClone(next); onChange(structuredClone(currentState)); };
  const client = {
    snapshot: () => structuredClone(currentState),
    async checkSession() { calls.checkSession++; emit({ ...currentState, authenticated: true }); return true; },
    async refreshAll() { calls.refreshAll++; emit({ ...currentState, resources: freshResources() }); },
    tick() {
      calls.tick++;
      if (nextTickState) { currentState = nextTickState; nextTickState = null; }
      return structuredClone(currentState);
    },
    async logout() { calls.logout++; emit(signedOut()); },
    dispose() { calls.dispose++; emit(signedOut()); },
  };
  const context = vm.createContext({
    document, aggregateOwnerOverview,
    createOwnerClient: (options) => { onChange = options.onChange; return client; },
    setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  const workspace = context.initOwnerWorkspace({ onStateChange: (state) => changes.push(structuredClone(state)) });
  return {
    document, calls, changes, client, workspace, timers, emit,
    panel: document.getElementById('ownerWorkspace'),
    content: document.getElementById('ownerContent'),
    nextTick(state) { nextTickState = structuredClone(state); },
    fireTimer(delay) { for (const timer of [...timers.values()]) if (timer.delay === delay) timer.callback(); },
  };
}

test('initial closed workspace checks the session and collects data without rendering private content', async (t) => {
  const h = setup(); t.after(() => h.workspace.destroy());
  await settle();
  assert.equal(h.calls.checkSession, 1);
  assert.equal(h.calls.refreshAll, 1);
  assert.equal(h.panel.hidden, true);
  assert.equal(h.panel.inert, true);
  assert.equal(h.content.textContent, '');
  assert.equal(h.changes.at(-1).authenticated, true);
  assert.equal(h.changes.at(-1).resources.board.data.tasks[0].id, 'blocked-1');
});

test('15-second collection continues after closing the workspace panel', async (t) => {
  const h = setup(); t.after(() => h.workspace.destroy());
  await settle();
  await h.workspace.open();
  assert.match(h.content.textContent, /Private blocked task/);
  h.workspace.close();
  const before = h.calls.refreshAll;
  h.fireTimer(15000);
  await settle();
  assert.equal(h.calls.refreshAll, before + 1);
  assert.equal(h.panel.hidden, true);
  assert.equal(h.content.textContent, '');
});

test('hidden documents clear displayed data and suspend reads until session recheck on return', async (t) => {
  const h = setup(); t.after(() => h.workspace.destroy());
  await settle(); await h.workspace.open();
  assert.match(h.content.textContent, /Private blocked task/);
  h.document.hidden = true;
  h.document.dispatch('visibilitychange');
  assert.equal(h.content.textContent, '');
  const checks = h.calls.checkSession, reads = h.calls.refreshAll, ticks = h.calls.tick;
  h.fireTimer(15000); h.fireTimer(1000);
  await h.workspace.refresh(); await settle();
  assert.equal(h.calls.checkSession, checks);
  assert.equal(h.calls.refreshAll, reads);
  assert.equal(h.calls.tick, ticks);
  h.document.hidden = false;
  h.document.dispatch('visibilitychange');
  await settle();
  assert.equal(h.calls.checkSession, checks + 1);
  assert.equal(h.calls.refreshAll, reads + 1);
  assert.match(h.content.textContent, /Private blocked task/);
});

test('a workspace created in a hidden document delays the initial session request', async (t) => {
  const h = setup({ hidden: true }); t.after(() => h.workspace.destroy());
  await settle(); h.fireTimer(15000);
  assert.equal(h.calls.checkSession, 0);
  assert.equal(h.calls.refreshAll, 0);
  h.document.hidden = false;
  h.document.dispatch('visibilitychange');
  await settle();
  assert.equal(h.calls.checkSession, 1);
  assert.equal(h.calls.refreshAll, 1);
  assert.equal(h.panel.hidden, true);
});

test('logout clears content, reports signed-out state and prevents further scheduled reads', async (t) => {
  const h = setup(); t.after(() => h.workspace.destroy());
  await settle(); await h.workspace.open();
  const logout = h.panel.querySelectorAll('button').find((element) => element.textContent === '로그아웃');
  assert.ok(logout);
  logout.dispatch('click');
  await settle();
  assert.equal(h.calls.logout, 1);
  assert.equal(h.content.textContent, '');
  assert.equal(h.changes.at(-1).authenticated, false);
  assert.equal(h.changes.at(-1).resources.board.data, null);
  assert.equal(h.panel.querySelector('.owner-body').hidden, true);
  assert.equal(h.panel.querySelector('.owner-login').hidden, false);
  const reads = h.calls.refreshAll;
  h.fireTimer(15000); h.fireTimer(1000);
  await settle();
  assert.equal(h.calls.refreshAll, reads);
  assert.equal(h.changes.at(-1).authenticated, false);
});

test('all four tabs support keyboard navigation with ArrowLeft wrapping to results', async (t) => {
  const h = setup(); t.after(() => h.workspace.destroy());
  await settle(); await h.workspace.open();
  const attention = h.document.getElementById('ownerTab-attention');
  const event = attention.dispatch('keydown', { key: 'ArrowLeft' });
  await settle();
  assert.equal(event.defaultPrevented, true);
  const results = h.document.getElementById('ownerTab-results');
  assert.equal(results.getAttribute('aria-selected'), 'true');
  assert.equal(results.tabIndex, 0);
  assert.equal(h.document.activeElement, results);
  assert.equal(h.content.getAttribute('aria-labelledby'), 'ownerTab-results');
  results.dispatch('keydown', { key: 'ArrowRight' });
  await settle();
  assert.equal(attention.getAttribute('aria-selected'), 'true');
  assert.equal(h.document.activeElement, attention);
  const selected = h.panel.querySelectorAll('button').filter((element) => element.getAttribute('role') === 'tab');
  assert.equal(selected.length, 4);
  assert.equal(selected.filter((element) => element.tabIndex === 0).length, 1);
});

test('freshness ticks move attention records to the stale group without another network read', async (t) => {
  const h = setup(); t.after(() => h.workspace.destroy());
  await settle(); await h.workspace.open();
  assert.match(h.content.textContent, /현재 확인한 항목 1개/);
  assert.equal(h.content.querySelector('.owner-attention-stale'), null);
  const next = h.client.snapshot();
  next.resources.board = { ...next.resources.board, state: 'stale', usable: false, reason: 'expired' };
  h.nextTick(next);
  const reads = h.calls.refreshAll;
  h.fireTimer(1000);
  assert.equal(h.calls.refreshAll, reads);
  assert.match(h.content.textContent, /현재 확인한 항목 0개/);
  const oldRecords = h.content.querySelector('.owner-attention-stale');
  assert.ok(oldRecords);
  assert.match(oldRecords.textContent, /마지막 확인 기록 1개/);
  assert.match(oldRecords.textContent, /Private blocked task/);
  assert.equal(h.changes.at(-1).resources.board.state, 'stale');
});

test('destroy removes timers, event listeners, DOM and late client notifications', async () => {
  const h = setup(); await settle();
  assert.equal(h.timers.size, 2);
  h.workspace.destroy();
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.dispose, 1);
  assert.equal(h.changes.at(-1).authenticated, false, 'external displays receive a final cleared snapshot');
  assert.equal(h.changes.at(-1).resources.board.data, null);
  assert.equal(h.document.getElementById('ownerWorkspace'), null);
  assert.equal(h.document.body.children.length, 0);
  const checks = h.calls.checkSession, changes = h.changes.length;
  h.workspace.destroy();
  h.document.dispatch('visibilitychange');
  h.emit(signedOut());
  await settle();
  assert.equal(h.calls.checkSession, checks);
  assert.equal(h.changes.length, changes);
  assert.equal(h.calls.dispose, 1, 'destroy is idempotent');
  assert.equal(h.document.listeners.get('visibilitychange').size, 0);
  assert.equal(h.document.listeners.get('keydown').size, 0);
});
