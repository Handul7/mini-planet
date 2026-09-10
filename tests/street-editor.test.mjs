import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const dirs = () => [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.2, 1, 0).normalize()];
function streetContext() {
  const items = [];
  const ctx = vm.createContext({
    editablePaths: items,
    spawnPath(data) {
      const item = { data, isPath: true };
      items.push(item);
      return item;
    },
    removePath(item) { items.splice(items.indexOf(item), 1); },
  });
  vm.runInContext(['samePathRoute', 'spawnEditorPath', 'removeEditorPath'].map(fn).join('\n'), ctx);
  return ctx;
}

test('new roads and lanes include one matching curb while water paths do not', () => {
  const ctx = streetContext();
  for (const type of ['road', 'lane', 'river']) ctx.spawnEditorPath({ type, dirs: dirs() });
  assert.deepEqual(ctx.editablePaths.map((p) => p.data.type), ['road', 'streetEdge', 'lane', 'laneEdge', 'river']);
});

test('coincident paving does not duplicate existing curbs', () => {
  const ctx = streetContext();
  ctx.spawnEditorPath({ type: 'road', dirs: dirs() });
  ctx.spawnEditorPath({ type: 'road', dirs: dirs().reverse() });
  assert.equal(ctx.editablePaths.filter((p) => p.data.type === 'streetEdge').length, 1);
});

test('deleting a street removes its reversed matching curb but preserves a custom nearby edge', () => {
  const ctx = streetContext();
  const road = ctx.spawnEditorPath({ type: 'road', dirs: dirs() });
  ctx.editablePaths[1].data.dirs = dirs().reverse();
  const nearby = ctx.spawnPath({ type: 'streetEdge', dirs: dirs().map((p) => p.clone().add(new THREE.Vector3(0, 0, 0.01)).normalize()) });
  ctx.removeEditorPath(road);
  assert.deepEqual(ctx.editablePaths, [nearby]);
});

test('shared curbs survive until the last coincident street is removed', () => {
  const ctx = streetContext();
  const first = ctx.spawnEditorPath({ type: 'lane', dirs: dirs() });
  const second = ctx.spawnEditorPath({ type: 'lane', dirs: dirs() });
  ctx.removeEditorPath(first);
  assert.equal(ctx.editablePaths.length, 2);
  ctx.removeEditorPath(second);
  assert.equal(ctx.editablePaths.length, 0);
});

test('deleting an independently selected curb does not delete the paving', () => {
  const ctx = streetContext();
  const road = ctx.spawnEditorPath({ type: 'road', dirs: dirs() });
  ctx.removeEditorPath(ctx.editablePaths[1]);
  assert.deepEqual(ctx.editablePaths, [road]);
});

test('empty and differently sampled paths are not paired', () => {
  const ctx = streetContext();
  assert.equal(ctx.samePathRoute([], []), false);
  assert.equal(ctx.samePathRoute(dirs(), [...dirs(), new THREE.Vector3(0, 0, 1)]), false);
});

test('duplicating a road creates the offset paving and matching curb before saving', () => {
  const ctx = streetContext();
  ctx.selectedItem = ctx.spawnEditorPath({ type: 'road', dirs: dirs() });
  ctx.nudgeDir = (d) => d.clone().add(new THREE.Vector3(0, 0, 0.15)).normalize();
  const calls = [];
  ctx.syncCottageExtras = () => calls.push('refresh');
  ctx.selectItem = () => calls.push('select');
  ctx.saveLayout = () => calls.push('save');
  vm.runInContext(`${fn('duplicateSelected')}\nduplicateSelected();`, ctx);
  assert.deepEqual(ctx.editablePaths.map((p) => p.data.type), ['road', 'streetEdge', 'road', 'streetEdge']);
  assert.deepEqual(calls, ['refresh', 'select', 'save']);
  assert.ok(ctx.samePathRoute(ctx.editablePaths[2].data.dirs, ctx.editablePaths[3].data.dirs));
  assert.equal(ctx.samePathRoute(ctx.editablePaths[0].data.dirs, ctx.editablePaths[2].data.dirs), false);
});

test('rotating either home type refreshes its entrance before saving', () => {
  for (const type of ['cottage', 'lighthouse']) {
    const calls = [];
    const ctx = vm.createContext({
      selectedItem: { data: { type, yaw: 0 } }, PROP_DEFS: { [type]: { editableParams: ['yaw'] } },
      applyPropTransform: () => calls.push('transform'), refreshPropCollider: () => calls.push('collider'),
      syncCottageExtras: (t) => calls.push(t), saveLayout: () => calls.push('save'),
    });
    vm.runInContext(`${fn('rotateSelected')}\nrotateSelected(0.2);`, ctx);
    assert.deepEqual(calls, ['transform', 'collider', type, 'save']);
    assert.equal(ctx.selectedItem.data.yaw, 0.2);
  }
});

test('dragging the lighthouse also refreshes its driveway; path dragging is guarded', () => {
  const calls = [];
  const ctx = vm.createContext({
    selectedItem: { data: { type: 'lighthouse', dir: dirs()[0] } },
    HOME_PROP_TYPES: new Set(['cottage', 'lighthouse']), PUBLIC_SPACE_TYPES: new Set(['civicPavilion', 'harborShelter']),
    applyPropTransform: () => calls.push('transform'), refreshPropCollider: () => calls.push('collider'),
    rebuildDrivewaysThrottled: () => calls.push('driveway'), highlightSelected: () => calls.push('highlight'),
  });
  vm.runInContext(fn('moveSelectedTo'), ctx);
  ctx.moveSelectedTo(dirs()[1]);
  assert.deepEqual(calls, ['transform', 'collider', 'driveway', 'highlight']);
  ctx.selectedItem = { isPath: true };
  ctx.moveSelectedTo(dirs()[0]);
  assert.equal(calls.length, 4);
});

test('cancelled touch drawing does not place a point and clears pointer state', () => {
  const ctx = vm.createContext({ drawingType: 'road', drawPointerStart: {}, pendingDrawDir: dirs()[0],
    editDragging: false, camOrbiting: true, addDrawPoint: () => assert.fail('cancel must not draw'),
  });
  vm.runInContext(`${fn('finishEditPointer')}\nfinishEditPointer(true);`, ctx);
  assert.equal(ctx.drawPointerStart, null);
  assert.equal(ctx.pendingDrawDir, null);
  assert.equal(ctx.camOrbiting, false);
});

test('cancelled object drag settles the driveway once, then saves the final position', () => {
  const calls = [];
  const ctx = vm.createContext({ drawingType: null, editDragging: true, camOrbiting: false,
    selectedItem: { data: { type: 'lighthouse' } },
    syncCottageExtras: () => calls.push('settle'), saveLayout: () => calls.push('save'),
  });
  vm.runInContext(`${fn('finishEditPointer')}\nfinishEditPointer(true); finishEditPointer();`, ctx);
  assert.deepEqual(calls, ['settle', 'save']);
  assert.equal(ctx.editDragging, false);
});
