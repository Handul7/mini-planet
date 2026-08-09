import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateSnapshotFreshness,
  normalizePublicAgentStatus,
  normalizePublicDashboardView,
  selectPublicResultProjection,
} from '../src/public-dashboard.js';
import { normalizeStatusSnapshot } from '../src/status-source.js';

const AGENTS = ['rodi', 'jarvis', 'yul', 'ludwig', 'anne', 'argos'];
const NOW = Date.parse('2026-07-29T12:00:00+09:00');

test('future status schemas fail closed', () => {
  assert.equal(normalizeStatusSnapshot({ schemaVersion: 99, agents: {} }), null);
  assert.equal(normalizeStatusSnapshot({ schemaVersion: 2, agents: [] }), null);
});

test('live tasks and approvals accept only explicitly public text fields', () => {
  const view = normalizePublicDashboardView({
    schemaVersion: 2,
    publicationMode: 'live',
    source: 'hermes-public-bridge',
    sourceGeneratedAt: '2026-07-29T11:59:20+09:00',
    bridgeObservedAt: '2026-07-29T11:59:30+09:00',
    expiresAt: '2026-07-29T12:02:30+09:00',
    isStale: false,
    tasks: [
      { title: 'raw private title', prompt: 'do not publish', ownerAgent: 'rodi' },
      { publicId: 'task-public-1', publicTitle: '공개 승인된 작업', ownerAgent: 'rodi', status: 'running' },
    ],
    approvals: [
      { actionSummary: 'raw approval body', requestedBy: 'rodi' },
      { publicId: 'approval-public-1', publicActionSummary: '공개 승인 요청', requestedByAgent: 'rodi' },
    ],
  }, AGENTS, { now: NOW });

  assert.equal(view.tasks.length, 1);
  assert.equal(view.tasks[0].title, '공개 승인된 작업');
  assert.equal(view.approvals.length, 1);
  assert.equal(view.approvals[0].actionSummary, '공개 승인 요청');
  assert.equal('prompt' in view.tasks[0], false);
});

test('live agent status ignores raw task, blocker, run and cost fields', () => {
  const status = normalizePublicAgentStatus({
    state: '작업 중',
    task: '고객명 포함 원문',
    publicTask: '공개 작업 요약',
    runtime: {
      blocker: '내부 장애 원문',
      publicBlocker: '공개 가능한 대기 사유',
      runId: 'internal-run-42',
      cost: { amount: 99 },
      model: 'exact-private-model',
      modelFamily: 'general-reasoning',
    },
  }, { publicationMode: 'live' });

  assert.equal(status.task, '공개 작업 요약');
  assert.equal(status.blocker, '공개 가능한 대기 사유');
  assert.equal(status.model, 'general-reasoning');
  assert.equal('runId' in status, false);
  assert.equal('cost' in status, false);
});

test('live agent state is constrained to coarse public states', () => {
  assert.equal(normalizePublicAgentStatus({ state: 'running' }, { publicationMode: 'live' }).state, '작업 중');
  assert.equal(normalizePublicAgentStatus({ state: '고객 A 긴급 장애' }, { publicationMode: 'live' }).state, null);
});

test('live results require explicit public projection fields', () => {
  const selected = selectPublicResultProjection({
    result: { title: 'raw internal result' },
    publicResult: { title: '공개 결과' },
    results: [{ title: 'raw history' }],
    publicResults: [{ title: '공개 이력' }],
  }, { publicationMode: 'live' });
  assert.equal(selected.result.title, '공개 결과');
  assert.equal(selected.results[0].title, '공개 이력');
  assert.equal(selectPublicResultProjection({ result: { title: 'raw only' } }, { publicationMode: 'live' }).result, null);
});

test('live snapshots expire when required freshness metadata is missing or old', () => {
  assert.equal(evaluateSnapshotFreshness({ publicationMode: 'live' }, { now: NOW }).isStale, true);
  const stale = evaluateSnapshotFreshness({
    publicationMode: 'live',
    sourceGeneratedAt: '2026-07-29T11:50:00+09:00',
    bridgeObservedAt: '2026-07-29T11:50:10+09:00',
    expiresAt: '2026-07-29T11:53:10+09:00',
    isStale: false,
  }, { now: NOW, ttlMs: 180000 });
  assert.equal(stale.state, 'stale');
  assert.ok(stale.reason);
});

test('curated static snapshots are labeled static instead of live', () => {
  const freshness = evaluateSnapshotFreshness({
    publicationMode: 'static-demo',
    source: 'curated-static',
    generatedAt: '2026-07-17T00:00:00+09:00',
  }, { now: NOW });
  assert.equal(freshness.state, 'static');
  assert.equal(freshness.isStale, false);
});

test('live publication requires schema v2', () => {
  const view = normalizePublicDashboardView({
    schemaVersion: 1,
    publicationMode: 'live',
    sourceGeneratedAt: '2026-07-29T11:59:20+09:00',
    bridgeObservedAt: '2026-07-29T11:59:30+09:00',
    expiresAt: '2026-07-29T12:02:30+09:00',
    isStale: false,
    tasks: [{ title: 'legacy raw title' }],
  }, AGENTS, { now: NOW });
  assert.equal(view.isStale, true);
  assert.equal(view.freshness.reason, 'unsupported-live-schema');
  assert.equal(view.tasks.length, 0);
});

test('task and approval projections are capped', () => {
  const view = normalizePublicDashboardView({
    schemaVersion: 2,
    publicationMode: 'live',
    sourceGeneratedAt: '2026-07-29T11:59:20+09:00',
    bridgeObservedAt: '2026-07-29T11:59:30+09:00',
    expiresAt: '2026-07-29T12:02:30+09:00',
    isStale: false,
    tasks: Array.from({ length: 40 }, (_, index) => ({ publicTitle: `Task ${index}` })),
    approvals: Array.from({ length: 30 }, (_, index) => ({ publicActionSummary: `Approval ${index}` })),
  }, AGENTS, { now: NOW });
  assert.equal(view.tasks.length, 24);
  assert.equal(view.approvals.length, 16);
});
