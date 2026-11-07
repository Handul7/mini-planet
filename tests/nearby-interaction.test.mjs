import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { selectNearbyInteraction } from '../src/nearby-interaction.js';

const candidate = (target, distance) => ({ target, distance });

test('nearest eligible resident or home is selected without changing the input', () => {
  for (const [list, kind] of [['residents', 'resident'], ['homes', 'home']]) {
    const far = {}, near = {}, outside = {};
    const candidates = Object.freeze([
      Object.freeze(candidate(far, 0.15)),
      Object.freeze(candidate(outside, 0.3)),
      Object.freeze(candidate(near, 0.04)),
    ]);
    assert.deepEqual(selectNearbyInteraction({ [list]: candidates }), { kind, target: near });
    assert.equal(candidates[0].target, far);
  }
});

test('the radius excludes its exact boundary and invalid distances but includes zero', () => {
  assert.equal(selectNearbyInteraction(), null);
  for (const list of ['residents', 'homes']) {
    const target = {};
    for (const distance of [0.18, 0.180001, -0.01, NaN, Infinity, -Infinity]) {
      assert.equal(selectNearbyInteraction({ [list]: [candidate(target, distance)] }), null);
    }
    assert.equal(selectNearbyInteraction({ [list]: [candidate(null, 0)] }), null);
    for (const distance of [0, 0.179999]) {
      assert.equal(selectNearbyInteraction({ [list]: [candidate(target, distance)] }).target, target);
    }
  }
});

test('overlapping residents have a stable tie and take priority over a closer door', () => {
  const first = {}, second = {}, home = {};
  const options = {
    residents: [candidate(first, 0.17), candidate(second, 0.17)],
    homes: [candidate(home, 0.01)],
  };
  assert.deepEqual(selectNearbyInteraction(options), { kind: 'resident', target: first });
  assert.deepEqual(selectNearbyInteraction({ ...options, residents: [candidate(first, 0.18)] }),
    { kind: 'home', target: home });
});

test('disembarking wins over boarding, which wins over residents and homes', () => {
  const activeBoat = {}, nearbyBoat = {};
  const options = { activeBoat, nearbyBoat, residents: [candidate({}, 0)], homes: [candidate({}, 0)] };
  assert.deepEqual(selectNearbyInteraction(options), { kind: 'boat-exit', target: activeBoat });
  assert.deepEqual(selectNearbyInteraction({ ...options, activeBoat: null }),
    { kind: 'boat-enter', target: nearbyBoat });
  assert.equal(selectNearbyInteraction({ ...options, blocked: true }), null);
});

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing main.js integration: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing main.js integration boundary: ${endMarker}`);
  return source.slice(start, end);
}
const proximityCode = between('  updateServiceProximity = function () {',
  "  promptEl.addEventListener('click', activateNearbyService)");
const residentHookCode = between('  openNearbyAgent = (agent) => {', '\n\n  function patrolRank(');
const agentCardCode = between('  function openAgentCard(', '  function closeAgentCard(');

class Element {
  constructor() {
    this.attrs = {};
    this.children = [];
    this.disabled = true;
    this.inert = true;
    const classes = new Set();
    this.classList = {
      add: (...values) => values.forEach((value) => classes.add(value)),
      remove: (...values) => values.forEach((value) => classes.delete(value)),
      contains: (value) => classes.has(value),
    };
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text || ''; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  querySelector(selector) { return selector === 'span' ? this.icon : null; }
  matches(selector) { return selector.split(',').some((part) => this.classList.contains(part.trim().slice(1))); }
}

const direction = (angle) => new THREE.Vector3(Math.sin(angle), Math.cos(angle), 0);
function agent(key, angle, doorAngle = null) {
  return {
    key, kor: key === 'rodi' ? '로디' : '자비스',
    npc: { visible: true, userData: { dir: direction(angle) } },
    home: doorAngle === null ? null : { doorDir: direction(doorAngle) },
  };
}

// Execute the actual main.js proximity/activation and resident-opening hooks.
// The renderer and unrelated panel rendering are replaced with small DOM spies.
function harness({ agents = [agent('rodi', 0.1)], owner = false } = {}) {
  const body = new Element(), prompt = new Element(), mobile = new Element();
  mobile.icon = new Element();
  const calls = [];
  let resets = 0;
  const context = vm.createContext({
    selectNearbyInteraction, AGENTS: agents, playerDir: direction(0),
    editMode: false, openFor: null, experienceMode: 'explore', cameraIntro: false,
    intro: { isConnected: false }, activeBoatItem: null, nearbyBoat: null,
    boardOpen: false, roseOpen: false,
    villageBoard: { isOpen: () => context.boardOpen },
    roseStory: { isOpen: () => context.roseOpen },
    document: { body, activeElement: null, createElement: () => new Element() },
    HTMLElement: Element, promptEl: prompt, mobileInteractBtn: mobile,
    nearbyInteraction: null, interactionPromptKey: '',
    homeDoorDir: (home) => home?.doorDir || null,
    nearestBoardableBoat: () => context.nearbyBoat,
    setInteractiveState: (element, visible) => { element.inert = !visible; },
    boardBoat: (target) => { calls.push({ kind: 'board', target }); return true; },
    disembarkBoat: () => { calls.push({ kind: 'disembark' }); return false; },
    openServicePanel: (target) => {
      calls.push({ kind: 'home', target });
      context.openFor = target;
      body.classList.add('service-detail-open');
    },
    OWNER_MODE: owner,
    ownerWorkspace: { open: (options) => {
      calls.push({ kind: 'owner', tab: options.tab, agent: options.agent });
      body.classList.add('owner-panel-open');
    } },
    resetTransientControls: () => { resets++; },
    dashboardStopPatrol() {}, closeServicePanel() {}, closeVisitorPanels() {},
    closeTeamOverview() {}, markVisitorStep() {},
    renderCard: (target) => calls.push({ kind: 'resident', target }),
    cardEl: new Element(), ambientAudio: { playEffect() {} },
    requestAnimationFrame() {},
  });
  vm.runInContext(agentCardCode + '\n' + residentHookCode + '\n' + proximityCode, context);
  return { context, calls, body, prompt, mobile, agents, resets: () => resets,
    update: () => context.updateServiceProximity(), activate: () => context.activateNearbyService() };
}

test('resident proximity opens the existing public card and keeps exploration mode', () => {
  const h = harness();
  h.update();
  assert.equal(h.mobile.disabled, false);
  assert.equal(h.mobile.attrs['aria-label'], '로디에게 말 걸기');
  assert.equal(h.prompt.children.at(-1).textContent, 'F 말 걸기');
  assert.equal(h.activate(), true);
  assert.deepEqual(h.calls, [{ kind: 'resident', target: h.agents[0] }]);
  assert.equal(h.resets(), 1);
  assert.equal(h.context.experienceMode, 'explore');
  assert.equal(h.mobile.disabled, true);
  assert.equal(h.prompt.inert, true);
  assert.equal(h.activate(), false, 'an open card must not reopen on another input source');
});

test('the same resident hook opens owner mode with that resident filter and no public card', () => {
  const h = harness({ owner: true });
  assert.equal(h.activate(), true);
  assert.deepEqual(h.calls, [{ kind: 'owner', tab: 'board', agent: 'rodi' }]);
  assert.equal(h.context.experienceMode, 'explore');
  assert.equal(h.mobile.disabled, true);
  assert.equal(h.activate(), false);
  assert.equal(h.calls.length, 1, 'the owner filter must not be reset by repeated activation');
});

test('activation refreshes a moving target instead of opening the previous frame resident', () => {
  const old = agent('rodi', 0.1), next = agent('jarvis', 0.4);
  const h = harness({ agents: [old, next] });
  h.update();
  assert.equal(h.mobile.attrs['aria-label'], '로디에게 말 걸기');
  old.npc.userData.dir.copy(direction(0.5));
  next.npc.userData.dir.copy(direction(0.08));
  assert.equal(h.activate(), true);
  assert.deepEqual(h.calls, [{ kind: 'resident', target: next }]);
});

test('a vanished resident clears the prompt and cannot be activated from stale state', () => {
  for (const remove of [
    (resident) => { resident.npc.visible = false; },
    (resident) => { resident.npc = null; },
    (resident) => { resident.npc.userData.dir.copy(direction(0.4)); },
  ]) {
    const h = harness(); h.update(); remove(h.agents[0]);
    assert.equal(h.activate(), false);
    assert.equal(h.calls.length, 0);
    assert.equal(h.mobile.disabled, true);
    assert.equal(h.mobile.attrs['aria-label'], '가까운 주민·집·배 이용');
    assert.equal(h.prompt.classList.contains('show'), false);
    assert.equal(h.prompt.inert, true);
    assert.equal(h.prompt.tabIndex, -1);
  }
});

test('door proximity retains the service-panel hook when no resident is in range', () => {
  const resident = agent('rodi', 0.4, 0.1);
  const h = harness({ agents: [resident] });
  h.update();
  assert.equal(h.mobile.attrs['aria-label'], '로디의 집 입장');
  assert.equal(h.prompt.children.at(-1).textContent, 'F 입장');
  assert.equal(h.activate(), true);
  assert.deepEqual(h.calls, [{ kind: 'home', target: resident }]);
  assert.equal(h.resets(), 0, 'house entry must not accidentally run the resident-card hook');
});

test('main integration preserves boat priority and reports a failed disembark', () => {
  const h = harness({ agents: [agent('rodi', 0.05, 0.02)] });
  const boat = {};
  h.context.nearbyBoat = boat;
  h.update();
  assert.equal(h.mobile.attrs['aria-label'], '어선 승선');
  assert.equal(h.activate(), true);
  assert.deepEqual(h.calls, [{ kind: 'board', target: boat }]);
  h.context.activeBoatItem = {};
  assert.equal(h.activate(), false);
  assert.deepEqual(h.calls.at(-1), { kind: 'disembark' });
  assert.equal(h.mobile.attrs['aria-label'], '배에서 내리기');
});

test('all blocking UI and modes clear an old prompt and reject every shared activation path', () => {
  const blockers = [
    (h) => { h.context.editMode = true; },
    (h) => { h.context.openFor = {}; },
    (h) => { h.context.experienceMode = 'dashboard'; },
    (h) => { h.context.cameraIntro = true; },
    (h) => { h.context.intro.isConnected = true; },
    (h) => { h.context.boardOpen = true; },
    (h) => { h.context.roseOpen = true; },
    ...['agent-detail-open', 'service-detail-open', 'team-overview-open', 'owner-panel-open']
      .map((className) => (h) => h.body.classList.add(className)),
  ];
  for (const block of blockers) {
    const h = harness(); h.update();
    h.context.activeBoatItem = {};
    block(h);
    assert.equal(h.activate(), false);
    assert.equal(h.calls.length, 0);
    assert.equal(h.mobile.disabled, true);
    assert.equal(h.prompt.classList.contains('show'), false);
    assert.equal(h.prompt.inert, true);
  }
});
