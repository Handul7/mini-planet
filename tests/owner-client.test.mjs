import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOwnerClient } from '../src/owner-client.js';
import { OWNER_RESOURCE_PATHS } from '../src/owner-data.js';

const examples = JSON.parse(readFileSync(new URL('./fixtures/controller-actual-anonymized-responses.json', import.meta.url)));
const capturedAt = Date.parse(examples['/api/v1/board'].observed_at);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function setup() {
  let time = capturedAt;
  let route = (path) => json(examples[path]);
  const calls = [];
  const client = createOwnerClient({
    now: () => time,
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      if (path === '/owner/session') {
        if (options.method === 'DELETE') return json({ authenticated: false });
        return json({ authenticated: true, expiresAt: new Date(capturedAt + 3600000).toISOString() });
      }
      return route(path, options);
    },
  });
  return { client, calls, time: (value) => { time = value; }, route: (value) => { route = value; } };
}

test('uses only same-origin allowed reads, with credentials and no cache, and status last', async () => {
  const { client, calls } = setup();
  assert.equal(await client.login('test-only-password'), true);
  await client.refreshAll();
  assert.equal(client.snapshot().resources.board.data.task_count, 116);
  assert.equal(calls[0].path, '/owner/session');
  assert.deepEqual(JSON.parse(calls[0].options.body), { password: 'test-only-password' });
  assert.deepEqual(calls.slice(1).map((call) => call.path).sort(), Object.values(OWNER_RESOURCE_PATHS).sort());
  assert.equal(calls.at(-1).path, '/api/v1/status');
  for (const { path, options } of calls) {
    assert.equal(path.startsWith('/'), true);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers?.Authorization, undefined);
    if (path.startsWith('/api/')) assert.equal(options.body, undefined);
  }
  await assert.rejects(client.refresh('jobs:anne'), /unsupported_resource/);
  client.dispose();
});

test('first failure is unknown data, but a later network failure preserves marked stale data', async () => {
  const h = setup();
  await h.client.checkSession();
  h.route(() => { throw new Error('network'); });
  await h.client.refresh('board');
  assert.equal(h.client.snapshot().resources.board.state, 'error');
  assert.equal(h.client.snapshot().resources.board.data, null);
  h.route((path) => json(examples[path]));
  await h.client.refresh('board');
  assert.equal(h.client.snapshot().resources.board.state, 'ok');
  h.route(() => { throw new Error('network'); });
  await h.client.refresh('board');
  const stale = h.client.snapshot().resources.board;
  assert.equal(stale.state, 'stale');
  assert.equal(stale.usable, false);
  assert.equal(stale.data.task_count, 116);
  h.client.dispose();
});

test('historical captures expire without erasing the previous successful record', async () => {
  const h = setup();
  await h.client.checkSession(); await h.client.refresh('board');
  h.time(capturedAt + 15001);
  const stale = h.client.tick().resources.board;
  assert.equal(stale.state, 'stale');
  assert.equal(stale.data.counts.done, 116);
  assert.equal(stale.usable, false);
  h.client.dispose();
});

test('status read does not refresh any board or jobs observations', async () => {
  const h = setup();
  await h.client.checkSession(); await h.client.refresh('status');
  assert.equal(h.client.snapshot().resources.board.state, 'unknown');
  assert.equal(h.client.snapshot().resources.board.data, null);
  assert.equal(h.calls.length, 2);
  h.client.dispose();
});

test('malformed and boundary errors never replace last-success data with empty records', async () => {
  const h = setup();
  await h.client.checkSession(); await h.client.refresh('board');
  for (const response of [() => json({ data: { tasks: [], task_count: 0 } }), () => json({ error: 'controller_unavailable' }, 502), () => new Response('<html>unavailable</html>')]) {
    h.route(response); await h.client.refresh('board');
    assert.equal(h.client.snapshot().resources.board.state, 'stale');
    assert.equal(h.client.snapshot().resources.board.data.task_count, 116);
  }
  h.client.dispose();
});

test('a valid first-failure envelope remains an error rather than zero tasks', async () => {
  const h = setup(); await h.client.checkSession();
  h.route(() => json({ source: 'dashboard', status: 'error', observed_at: new Date(capturedAt).toISOString(), last_success_at: null, expires_at: null, stale: true, error: 'upstream_unavailable', data: null }, 503));
  await h.client.refresh('board');
  assert.equal(h.client.snapshot().resources.board.state, 'error');
  assert.equal(h.client.snapshot().resources.board.data, null);
  assert.equal(h.client.snapshot().resources.board.reason, 'upstream_unavailable');
  h.client.dispose();
});

test('401 clears every private record and prevents a concurrent old response restoring it', async () => {
  const h = setup(); await h.client.checkSession(); await h.client.refresh('board');
  const waiting = deferred();
  h.route((path) => path.includes('jobs') ? waiting.promise : json({ error: 'authentication_required' }, 401));
  const pending = h.client.refresh('jobs:rodi');
  await h.client.refresh('board');
  waiting.resolve(json(examples['/api/v1/jobs?profile=rodi'])); await pending;
  const state = h.client.snapshot();
  assert.equal(state.authenticated, false);
  assert.equal(state.sessionError, 'session_expired');
  for (const view of Object.values(state.resources)) assert.equal(view.data, null);
  h.client.dispose();
});

test('logout immediately clears data and ignores an in-flight response', async () => {
  const h = setup(); await h.client.checkSession(); await h.client.refresh('board');
  const waiting = deferred(); h.route(() => waiting.promise);
  const pending = h.client.refresh('board');
  await h.client.logout();
  waiting.resolve(json(examples['/api/v1/board'])); await pending;
  assert.equal(h.client.snapshot().authenticated, false);
  assert.equal(h.client.snapshot().resources.board.data, null);
  assert.equal(h.calls.at(-1).options.method, 'DELETE');
  h.client.dispose();
});

test('session recheck cancels obsolete requests and allows a fresh request for the same resource', async () => {
  const h = setup(); await h.client.checkSession();
  const waiting = deferred(); h.route(() => waiting.promise);
  const pending = h.client.refresh('board');
  await h.client.checkSession();
  h.route((path) => json(examples[path]));
  await h.client.refresh('board');
  waiting.resolve(json({ error: 'controller_unavailable' }, 502)); await pending;
  assert.equal(h.client.snapshot().resources.board.state, 'ok');
  assert.equal(h.client.snapshot().resources.board.pending, false);
  h.client.dispose();
});

test('session expiry clears private memory without waiting for another API request', async () => {
  const h = setup(); await h.client.checkSession(); await h.client.refreshAll();
  h.time(capturedAt + 3600000);
  assert.equal(h.client.tick().authenticated, false);
  for (const view of Object.values(h.client.snapshot().resources)) assert.equal(view.data, null);
  h.client.dispose();
});

test('failed login and a failed logout have clear states without retained data', async () => {
  const client = createOwnerClient({ fetchImpl: async () => json({ authenticated: false }, 401) });
  assert.equal(await client.login('wrong-test-password'), false);
  assert.equal(client.snapshot().sessionError, 'invalid_password');
  await client.logout();
  assert.equal(client.snapshot().sessionError, 'logout_failed');
  assert.equal(client.snapshot().authenticated, false);
  client.dispose();
});

test('re-login waits for the cookie-clearing logout response', async () => {
  const waiting = deferred();
  const methods = [];
  const client = createOwnerClient({ now: () => capturedAt, fetchImpl: async (path, options) => {
    methods.push(options.method);
    if (options.method === 'DELETE') return waiting.promise;
    return json({ authenticated: true, expiresAt: new Date(capturedAt + 3600000).toISOString() });
  } });
  await client.login('test');
  const logout = client.logout();
  const login = client.login('test');
  assert.equal(client.snapshot().loggingOut, true);
  assert.deepEqual(methods, ['POST', 'DELETE']);
  waiting.resolve(json({ authenticated: false }));
  await logout; await login;
  assert.deepEqual(methods, ['POST', 'DELETE', 'POST']);
  assert.equal(client.snapshot().authenticated, true);
  assert.equal(client.snapshot().loggingOut, false);
  client.dispose();
});

test('unconfirmed logout cannot silently restore a surviving cookie session', async () => {
  let failDelete = true, wrongPassword = false;
  const methods = [];
  const client = createOwnerClient({ now: () => capturedAt, fetchImpl: async (_, options) => {
    methods.push(options.method || 'GET');
    if (options.method === 'DELETE') {
      if (failDelete) throw new Error('offline');
      return json({ authenticated: false });
    }
    if (options.method === 'POST' && wrongPassword) return json({ authenticated: false }, 401);
    return json({ authenticated: true, expiresAt: new Date(capturedAt + 3600000).toISOString() });
  } });
  await client.checkSession(); await client.logout();
  const count = methods.length;
  assert.equal(await client.checkSession(), false);
  assert.equal(methods.length, count, 'tab resume must not even send the stale cookie');
  assert.equal(client.snapshot().logoutUnconfirmed, true);
  wrongPassword = true;
  assert.equal(await client.login('wrong'), false);
  assert.equal(await client.checkSession(), false);
  assert.equal(client.snapshot().logoutUnconfirmed, true);
  failDelete = false;
  await client.logout();
  assert.equal(client.snapshot().logoutUnconfirmed, false);
  client.dispose();
});

test('explicit successful login can unlock an unconfirmed logout, but malformed success cannot', async () => {
  const client = createOwnerClient({ now: () => capturedAt, fetchImpl: async (_, options) => {
    if (options.method === 'DELETE') return json({ authenticated: true });
    return json({ authenticated: true, expiresAt: new Date(capturedAt + 3600000).toISOString() });
  } });
  await client.login('test'); await client.logout();
  assert.equal(client.snapshot().sessionError, 'logout_failed');
  assert.equal(await client.checkSession(), false);
  await client.login('test');
  assert.equal(client.snapshot().authenticated, true);
  assert.equal(client.snapshot().logoutUnconfirmed, false);
  client.dispose();
});
