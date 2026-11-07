import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateOwnerOverview } from '../src/owner-overview.js';
import { OWNER_RESOURCE_PATHS, decodeOwnerResource, ownerResourceView } from '../src/owner-data.js';

const observedAt = '2026-09-26T01:00:00Z';
const task = (id, status) => ({ id, title: `Task ${id}`, status, assignee: 'rodi' });
const job = (id, profile, error = true, lastStatus = null) => ({
  id, profile, last_status: lastStatus, error: { present: error },
});
const current = (data) => ({
  state: 'ok', usable: true, data, lastSuccessAt: observedAt, pending: false,
});
const stale = (data) => ({
  state: 'stale', usable: false, data, lastSuccessAt: observedAt, reason: 'expired',
});
const snapshot = (resources) => ({ authenticated: true, resources });
const completeResources = () => ({
  board: current({ tasks: [] }),
  'jobs:default': current({ jobs: [] }),
  'jobs:rodi': current({ jobs: [] }),
  'jobs:jarvis': current({ jobs: [] }),
});

test('signed-out snapshots discard residual private rows and resource metadata', () => {
  const residual = {
    board: current({ tasks: [task('private-task', 'blocked')] }),
    'jobs:rodi': stale({ jobs: [job('private-job', 'rodi')] }),
  };
  const expected = {
    authenticated: false, currentItems: [], staleItems: [], resources: [], attentionComplete: false,
  };
  assert.deepEqual(aggregateOwnerOverview({ authenticated: false, resources: residual }), expected);
  assert.deepEqual(aggregateOwnerOverview({ resources: residual }), expected);
  assert.deepEqual(aggregateOwnerOverview(null), expected);
});

test('attention uses blocked/review tasks and explicit job errors, not last-status guesses', () => {
  const input = snapshot({
    ...completeResources(),
    board: current({ tasks: [
      task('blocked', 'blocked'), task('review', 'review'),
      task('running', 'running'), task('done', 'done'), task('todo', 'todo'),
    ] }),
    'jobs:rodi': current({ jobs: [
      job('explicit-error', 'rodi', true, 'success'),
      job('status-only-error', 'rodi', false, 'error'),
      job('status-only-failed', 'rodi', false, 'failed'),
      { id: 'missing-error-flag', profile: 'rodi', last_status: 'error' },
    ] }),
  });
  const before = structuredClone(input);
  const overview = aggregateOwnerOverview(input);
  assert.deepEqual(overview.currentItems.map((item) => [item.kind, item.id]), [
    ['task', 'blocked'], ['task', 'review'], ['job', 'explicit-error'],
  ]);
  assert.equal(overview.attentionComplete, true);
  assert.deepEqual(overview.staleItems, []);
  assert.deepEqual(overview.currentItems[1].task, input.resources.board.data.tasks[1]);
  assert.deepEqual(overview.currentItems[2].job, input.resources['jobs:rodi'].data.jobs[0]);
  assert.deepEqual(input, before, 'aggregation must not rewrite source records');
});

test('duplicate IDs collapse within a resource but remain distinct across profiles and board', () => {
  const overview = aggregateOwnerOverview(snapshot({
    board: current({ tasks: [task('shared', 'review'), task('shared', 'review')] }),
    'jobs:default': current({ jobs: [job('shared', 'default'), job('shared', 'default')] }),
    'jobs:rodi': current({ jobs: [job('shared', 'rodi')] }),
    'jobs:jarvis': current({ jobs: [job('shared', 'jarvis')] }),
  }));
  assert.deepEqual(overview.currentItems.map((item) => item.resourceKey), [
    'board', 'jobs:default', 'jobs:rodi', 'jobs:jarvis',
  ]);
  assert.equal(new Set(overview.currentItems.map((item) => item.key)).size, 4);
  assert.ok(overview.currentItems.every((item) => item.id === 'shared'));
});

test('stale attention stays separate from current attention and preserves evidence time', () => {
  const oldTime = '2026-09-25T01:00:00Z';
  const overview = aggregateOwnerOverview(snapshot({
    ...completeResources(),
    board: current({ tasks: [task('review-now', 'review')] }),
    'jobs:jarvis': {
      ...stale({ jobs: [job('old-error', 'jarvis')] }), lastSuccessAt: oldTime,
      pending: true, reason: 'upstream_unavailable',
    },
  }));
  assert.deepEqual(overview.currentItems.map((item) => item.id), ['review-now']);
  assert.deepEqual(overview.staleItems.map((item) => item.id), ['old-error']);
  assert.equal(overview.currentItems[0].freshness, 'current');
  assert.equal(overview.staleItems[0].freshness, 'stale');
  assert.equal(overview.staleItems[0].lastSuccessAt, oldTime);
  assert.equal(overview.attentionComplete, false);
  const resource = overview.resources.find((entry) => entry.key === 'jobs:jarvis');
  assert.equal(resource.state, 'stale');
  assert.equal(resource.reason, 'upstream_unavailable');
  assert.equal(resource.pending, true);
});

test('unknown, failed and unusable resources cannot promote residual payloads to attention', () => {
  for (const viewState of [
    { state: 'unknown', usable: false },
    { state: 'error', usable: false },
    { state: 'unsupported', usable: false },
    { state: 'ok', usable: false },
  ]) {
    const overview = aggregateOwnerOverview(snapshot({
      ...completeResources(),
      board: { ...current({ tasks: [task('cached-block', 'blocked')] }), ...viewState },
      'jobs:rodi': { ...current({ jobs: [job('cached-error', 'rodi')] }), ...viewState },
    }));
    assert.deepEqual(overview.currentItems, [], viewState.state);
    assert.deepEqual(overview.staleItems, [], viewState.state);
    assert.equal(overview.attentionComplete, false, viewState.state);
  }
});

test('partial collection cannot claim an authoritative empty attention list', () => {
  for (const resources of [
    {},
    { board: current({ tasks: [] }) },
    { ...completeResources(), 'jobs:jarvis': { state: 'unknown', pending: true } },
    { ...completeResources(), 'jobs:jarvis': { ...current(null) } },
    { ...completeResources(), 'jobs:jarvis': stale({ jobs: [] }) },
  ]) {
    const overview = aggregateOwnerOverview(snapshot(resources));
    assert.deepEqual(overview.currentItems, []);
    assert.deepEqual(overview.staleItems, []);
    assert.equal(overview.attentionComplete, false);
  }
  const complete = aggregateOwnerOverview(snapshot(completeResources()));
  assert.equal(complete.attentionComplete, true, 'result summaries are not attention collection inputs');
  assert.equal(complete.resources.find((resource) => resource.key === 'results:rodi').state, 'unknown');
});

test('result summaries and missing row identities cannot invent attention items', () => {
  const overview = aggregateOwnerOverview(snapshot({
    ...completeResources(),
    board: current({ tasks: [task('', 'blocked'), task(undefined, 'review')] }),
    'jobs:rodi': current({ jobs: [job('', 'rodi'), job(undefined, 'rodi')] }),
    'results:rodi': current({
      task_status: 'blocked', run: { status: 'error' },
      jobs: [job('result-shaped-job', 'rodi')], tasks: [task('result-shaped-task', 'review')],
    }),
  }));
  assert.deepEqual(overview.currentItems, []);
  assert.deepEqual(overview.staleItems, []);
});

test('historical controller captures remain stale while retaining explicit schedule error evidence', () => {
  const examples = JSON.parse(readFileSync(new URL('./fixtures/controller-actual-anonymized-responses.json', import.meta.url)));
  const now = Date.parse('2026-09-26T00:00:00Z');
  const resources = Object.fromEntries(Object.entries(OWNER_RESOURCE_PATHS)
    .filter(([key]) => key !== 'status')
    .map(([key, path]) => {
      const decoded = decodeOwnerResource(key, examples[path]);
      assert.ok(decoded, `${key} capture must pass the real boundary decoder`);
      return [key, ownerResourceView(decoded, now)];
    }));
  const overview = aggregateOwnerOverview(snapshot(resources));
  assert.deepEqual(overview.currentItems, []);
  assert.equal(overview.attentionComplete, false);
  assert.ok(overview.resources.every((resource) => resource.state === 'stale'));
  const capturedErrors = resources['jobs:jarvis'].data.jobs.filter((row) => row.error.present);
  assert.equal(capturedErrors.length, 1, 'the historical fixture contains one explicit jarvis job error');
  assert.equal(overview.staleItems.length, 1);
  assert.deepEqual(overview.staleItems[0].job, capturedErrors[0]);
  assert.equal(overview.staleItems[0].resourceKey, 'jobs:jarvis');
  assert.equal(overview.staleItems[0].lastSuccessAt, examples[OWNER_RESOURCE_PATHS['jobs:jarvis']].last_success_at);
  assert.ok(Date.parse(overview.staleItems[0].lastSuccessAt) < now);
});
