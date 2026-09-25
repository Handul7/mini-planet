import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OWNER_RESOURCE_PATHS, OWNER_FRESHNESS_MS, decodeOwnerResource, ownerResourceView } from '../src/owner-data.js';

// Historical, anonymized controller captures. Never substitute these for a live
// request, and never move their timestamps forward to make a preview look live.
const examples = JSON.parse(readFileSync(new URL('./fixtures/controller-actual-anonymized-responses.json', import.meta.url)));
const schema = JSON.parse(readFileSync(new URL('./fixtures/controller-responses.schema.json', import.meta.url)));
const copy = (key) => structuredClone(examples[OWNER_RESOURCE_PATHS[key]]);
const instant = (payload) => Date.parse(payload.observed_at);

test('all six actual controller captures decode without changing their contract or timestamps', () => {
  assert.equal(schema.title, 'Mini Planet route responses');
  assert.equal(Object.keys(examples).length, 6);
  for (const [key, path] of Object.entries(OWNER_RESOURCE_PATHS)) {
    assert.ok(examples[path], path);
    const decoded = decodeOwnerResource(key, examples[path]);
    assert.deepEqual(decoded, examples[path], key);
    assert.notEqual(decoded, examples[path]);
  }
});

test('historical fixture data remains expired today; no invented live observation', () => {
  const now = Date.parse('2026-09-26T00:00:00Z');
  for (const key of Object.keys(OWNER_RESOURCE_PATHS).filter((key) => key !== 'status')) {
    const decoded = decodeOwnerResource(key, copy(key));
    assert.equal(ownerResourceView(decoded, now).state, 'stale');
    assert.equal(ownerResourceView(decoded, now).usable, false);
    assert.deepEqual(ownerResourceView(decoded, now).data, decoded.data);
  }
  const status = ownerResourceView(decodeOwnerResource('status', copy('status')), now);
  assert.equal(status.controllerReachable, true);
  assert.equal(status.state, 'stale');
  assert.equal(status.usable, false);
  assert.equal(status.data.resident.overall_activity, 'unknown');
  assert.equal(status.data.resident.running_board_count, null);
});

test('board is an exact nonarchived inventory, not a claim that residents are idle', () => {
  const payload = copy('board');
  const decoded = decodeOwnerResource('board', payload);
  const current = ownerResourceView(decoded, instant(payload));
  assert.equal(current.state, 'ok');
  assert.equal(current.data.task_count, 116);
  assert.equal(current.data.counts.done, 116);
  assert.equal(current.data.archived_total, null);
  assert.equal(current.data.resident.overall_activity, 'unknown');
  assert.equal(current.data.resident.running_board_count, 0);
  for (const mutate of [
    (p) => { p.data.task_count += 1; },
    (p) => { p.data.tasks.pop(); },
    (p) => { p.data.counts.running += 1; },
    (p) => { p.data.tasks[0].status = 'archived'; },
    (p) => { p.data.tasks[1].id = p.data.tasks[0].id; },
    (p) => { p.data.scope.board = 'team-smoke-20260906'; },
    (p) => { p.data.scope.include_archived = true; },
    (p) => { p.resident.running_board_count = 1; },
    (p) => { p.data.resident.overall_activity = 'idle'; },
    (p) => { p.data.counts.done = '116'; },
  ]) {
    const invalid = copy('board');
    mutate(invalid);
    assert.equal(decodeOwnerResource('board', invalid), null);
  }
});

test('nested unknown fields are dropped, with detached new objects and no API tokens or paths', () => {
  const payload = copy('board');
  payload.token = 'secret';
  payload.data.raw = { session: 'private' };
  payload.data.tasks[0].prompt = 'private prompt';
  payload.data.tasks[0].origin_path = '/private/results';
  const decoded = decodeOwnerResource('board', payload);
  assert.equal(JSON.stringify(decoded).includes('secret'), false);
  assert.equal('prompt' in decoded.data.tasks[0], false);
  assert.equal('origin_path' in decoded.data.tasks[0], false);
  payload.data.tasks[0].title = 'Changed after validation';
  payload.data.counts.done = 999;
  assert.equal(decoded.data.tasks[0].title, '[redacted]');
  assert.equal(decoded.data.counts.done, 116);
});

test('jobs preserve unknown registry entries and enforce response, row and resource profile agreement', () => {
  const decoded = decodeOwnerResource('jobs:jarvis', copy('jobs:jarvis'));
  assert.equal(decoded.data.count, 7);
  assert.equal(decoded.data.jobs.filter((job) => job.error.present).length, 1);
  assert.equal(decoded.data.registry.yul, null);
  assert.equal(decoded.data.registry.argos, null);
  const futureSchedule = decoded.data.jobs[0].next_run_at;
  assert.ok(Date.parse(futureSchedule) > instant(decoded));
  assert.equal(ownerResourceView(decoded, instant(decoded)).state, 'ok');
  assert.equal(decodeOwnerResource('jobs:rodi', copy('jobs:default')), null);
  for (const mutate of [
    (p) => { p.data.jobs[0].profile = 'default'; },
    (p) => { p.data.count = 0; },
    (p) => { p.data.registry.jarvis = 6; },
    (p) => { p.data.jobs[0].error.present = 'false'; },
    (p) => { delete p.data.registry.anne; },
  ]) {
    const invalid = copy('jobs:jarvis');
    mutate(invalid);
    assert.equal(decodeOwnerResource('jobs:jarvis', invalid), null);
  }
});

test('rodi results keep actual execution profile and unavailable files; never fabricate a result file', () => {
  const decoded = decodeOwnerResource('results:rodi', copy('results:rodi'));
  assert.equal(decoded.data.run.profile, 'rodi');
  assert.equal(decoded.data.attachments_status, 'unavailable');
  assert.deepEqual(decoded.data.attachments, []);
  for (const mutate of [
    (p) => { p.data.profile = 'default'; },
    (p) => { p.data.run.profile = 'anne'; },
    (p) => { p.data.attachments = [{ name: 'other resident file' }]; },
    (p) => { p.data.attachments_status = 'available'; },
  ]) {
    const invalid = copy('results:rodi');
    mutate(invalid);
    assert.equal(decodeOwnerResource('results:rodi', invalid), null);
  }
});

test('server expiry wins even before 15 seconds, and cannot be extended past the success TTL', () => {
  const payload = copy('board'), start = instant(payload);
  const decoded = decodeOwnerResource('board', payload);
  assert.equal(OWNER_FRESHNESS_MS, 15000);
  assert.equal(ownerResourceView(decoded, start + 14999).state, 'ok');
  assert.equal(ownerResourceView(decoded, start + 15000).state, 'stale');
  payload.expires_at = new Date(start + 5000).toISOString();
  assert.equal(ownerResourceView(decodeOwnerResource('board', payload), start + 5000).state, 'stale');
  payload.expires_at = new Date(start + 86400000).toISOString();
  assert.equal(ownerResourceView(decodeOwnerResource('board', payload), start + 15000).state, 'stale');
  payload.observed_at = new Date(start + 14900).toISOString();
  assert.equal(ownerResourceView(decodeOwnerResource('board', payload), start + 15000).state, 'stale');
});

test('invalid calendar dates, timezone-free values, missing times and future observations fail closed', () => {
  for (const value of ['2026-02-30T00:00:00Z', '2026-09-25T24:00:00Z', '2026-09-25', '2026-09-25T13:33:42', 'not-a-date']) {
    const invalid = copy('board');
    invalid.observed_at = value;
    assert.equal(decodeOwnerResource('board', invalid), null, value);
  }
  const payload = copy('board'), start = instant(payload);
  assert.equal(ownerResourceView(decodeOwnerResource('board', payload), start - 1).state, 'unknown');
  payload.last_success_at = null;
  assert.equal(ownerResourceView(decodeOwnerResource('board', payload), start).reason, 'missing_freshness');
  payload.last_success_at = new Date(start + 1000).toISOString();
  assert.equal(ownerResourceView(decodeOwnerResource('board', payload), start + 2000).reason, 'invalid_timestamps');
  assert.equal(ownerResourceView(decodeOwnerResource('board', copy('board')), NaN).state, 'unknown');
});

test('future historical task, job and result times are rejected while future schedule predictions remain valid', () => {
  for (const [key, mutate] of [
    ['board', (p, future) => { p.data.tasks[0].completed_at = future; }],
    ['jobs:rodi', (p, future) => { p.data.jobs[0].last_run_at = future; }],
    ['results:rodi', (p, future) => { p.data.run.completed_at = future; }],
  ]) {
    const payload = copy(key);
    mutate(payload, new Date(instant(payload) + 1000).toISOString());
    assert.equal(decodeOwnerResource(key, payload), null);
  }
  assert.ok(decodeOwnerResource('jobs:rodi', copy('jobs:rodi')));
});

test('stale flags and failed refreshes preserve validated cache without claiming current success', () => {
  const stale = copy('board');
  stale.status = 'stale';
  stale.stale = true;
  const staleView = ownerResourceView(decodeOwnerResource('board', stale), instant(stale));
  assert.equal(staleView.state, 'stale');
  assert.equal(staleView.usable, false);
  assert.deepEqual(staleView.data, stale.data);
  const failed = copy('board');
  failed.status = 'error';
  failed.error = 'upstream_unavailable';
  failed.stale = true;
  const failedRefresh = ownerResourceView(decodeOwnerResource('board', failed), instant(failed));
  assert.equal(failedRefresh.state, 'stale');
  assert.equal(failedRefresh.reason, 'upstream_unavailable');
  assert.equal(failedRefresh.usable, false);
  assert.deepEqual(failedRefresh.data, failed.data);
  const futureCache = structuredClone(failed);
  futureCache.last_success_at = new Date(instant(failed) + 1000).toISOString();
  const rejected = ownerResourceView(decodeOwnerResource('board', futureCache), instant(failed));
  assert.equal(rejected.state, 'unknown');
  assert.equal(rejected.data, null);
  const failure = {
    source: 'dashboard', status: 'error', observed_at: failed.observed_at,
    last_success_at: null, expires_at: null, stale: true, error: 'upstream_unavailable', data: null,
  };
  assert.deepEqual(decodeOwnerResource('board', failure), failure);
  assert.deepEqual(decodeOwnerResource('status', failure), failure);
  assert.equal(ownerResourceView(decodeOwnerResource('board', failure), instant(failure)).state, 'error');
  assert.equal(ownerResourceView(null).state, 'unknown');
});

test('authorization failure cannot expose cached data even if a response contains it', () => {
  const failed = copy('board');
  failed.status = 'error';
  failed.error = 'unauthorized';
  failed.stale = true;
  const rejected = ownerResourceView(decodeOwnerResource('board', failed), instant(failed));
  assert.equal(rejected.state, 'error');
  assert.equal(rejected.usable, false);
  assert.equal(rejected.data, null);
});

test('unsupported and all controller boundary errors retain their semantics, especially unauthorized', () => {
  const unsupported = {
    source: 'dashboard', status: 'unsupported', observed_at: copy('board').observed_at,
    last_success_at: null, expires_at: null, stale: false, error: 'files_not_available', data: null, files: null,
  };
  assert.deepEqual(decodeOwnerResource('results:rodi', unsupported), unsupported);
  assert.equal(ownerResourceView(decodeOwnerResource('results:rodi', unsupported), instant(unsupported)).state, 'unsupported');
  for (const error of schema.$defs.boundaryError.properties.error.enum) {
    assert.deepEqual(decodeOwnerResource('board', { error }), { error });
    const state = ownerResourceView(decodeOwnerResource('board', { error }));
    assert.equal(state.state, 'error');
    assert.equal(state.reason, error);
    assert.equal(state.data, null);
  }
  assert.equal(decodeOwnerResource('board', { error: 'unauthorized', data: copy('board').data }), null);
  assert.equal(decodeOwnerResource('board', { error: 'made_up_error' }), null);
});

test('local network and HTTP 401 failures cannot inherit a previous successful snapshot', () => {
  const previous = decodeOwnerResource('board', copy('board'));
  for (const error of ['unauthorized', 'network_error', 'http_401', 'invalid_response']) {
    const state = ownerResourceView({ transportFailure: true, error, data: previous.data });
    assert.equal(state.state, 'transport-error');
    assert.equal(state.reason, error);
    assert.equal(state.usable, false);
    assert.equal(state.data, null);
    assert.equal(state.lastSuccessAt, null);
  }
});

test('status metadata requires all five scoped resources and does not invent unknown counts', () => {
  const payload = copy('status');
  delete payload.resources['jobs:rodi'];
  assert.equal(decodeOwnerResource('status', payload), null);
  const unknown = copy('status');
  for (const key of Object.keys(unknown.resources)) {
    unknown.resources[key] = {
      source: 'dashboard', status: 'unknown', observed_at: null, last_success_at: null,
      expires_at: null, stale: null, last_attempt_at: null, last_error: null,
    };
  }
  const decoded = decodeOwnerResource('status', unknown);
  assert.ok(decoded);
  const status = ownerResourceView(decoded, Date.parse('2026-09-25T14:00:00Z'));
  assert.equal(status.state, 'unknown');
  assert.equal(status.controllerReachable, true);
  assert.equal(status.resources.board.state, 'unknown');
  assert.equal(status.data.resident.running_board_count, null);
});

test('invalid sources, resource keys, arrays and missing contract fields are rejected', () => {
  assert.equal(decodeOwnerResource('__proto__', copy('board')), null);
  assert.equal(decodeOwnerResource('jobs:yul', copy('jobs:rodi')), null);
  for (const payload of [null, [], {}, true, 1, '<html>login</html>']) {
    assert.equal(decodeOwnerResource('board', payload), null);
  }
  const payload = copy('board');
  payload.source = 'hermes-public-bridge';
  assert.equal(decodeOwnerResource('board', payload), null);
  payload.source = 'dashboard';
  delete payload.stale;
  assert.equal(decodeOwnerResource('board', payload), null);
});
