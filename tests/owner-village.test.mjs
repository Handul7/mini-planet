import test from 'node:test';
import assert from 'node:assert/strict';
import { projectOwnerVillage } from '../src/owner-village.js';

const snapshot = {
  authenticated: true,
  resources: { board: { state: 'ok', usable: true, lastSuccessAt: '2026-09-26T00:00:00Z', data: { tasks: [
    { assignee: 'rodi', status: 'running' }, { assignee: 'rodi', status: 'blocked' },
    { assignee: 'jarvis', status: 'review' }, { assignee: 'rodi', status: 'done' },
    { assignee: null, status: 'running' },
  ] } } },
};

test('resident chips count only assigned board records without inferring online activity', () => {
  const result = projectOwnerVillage(snapshot, ['rodi', 'jarvis', 'yul']);
  assert.equal(result.state, 'current');
  assert.equal(result.residents.rodi.label, '보드 진행 1 · 확인 1');
  assert.equal(result.residents.jarvis.label, '보드 진행 0 · 확인 1');
  assert.equal(result.residents.yul.label, '보드 진행 0 · 확인 0');
  assert.match(result.residents.yul.detail, /전체 활동은 미확인/);
});

test('expired board records never appear as current resident counts', () => {
  const stale = structuredClone(snapshot);
  stale.resources.board.state = 'stale'; stale.resources.board.usable = false;
  const result = projectOwnerVillage(stale, ['rodi']);
  assert.equal(result.state, 'unavailable');
  assert.equal(result.residents.rodi.label, '보드 미확인');
  assert.equal(result.residents.rodi.needsAttention, false);
  assert.equal(result.lastSuccessAt, snapshot.resources.board.lastSuccessAt);
});

test('hidden and signed-out views remove private observations from the projection', () => {
  for (const result of [projectOwnerVillage(snapshot, ['rodi'], { hidden: true }), projectOwnerVillage({ ...snapshot, authenticated: false }, ['rodi'])]) {
    assert.equal(result.state, 'locked');
    assert.equal(result.lastSuccessAt, null);
    assert.equal(result.residents.rodi.label, '로그인 후 확인');
    assert.equal(result.residents.rodi.detail, '');
  }
});
