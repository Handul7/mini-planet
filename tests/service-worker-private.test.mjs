import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const origin = 'https://planet.example';

function request(path, { headers = {}, mode = 'cors', method = 'GET' } = {}) {
  return { url: new URL(path, origin).href, headers: new Headers(headers), mode, method };
}

function createWorker({ scope = '/', network = async () => new Response('network') } = {}) {
  const listeners = new Map();
  const buckets = new Map();
  const cacheCalls = [];
  const fetchCalls = [];
  let claimed = false;
  let networkHandler = network;
  const keyOf = (req) => `${req.url}\n${req.headers.get('Authorization') || ''}`;
  const bucket = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name);
  };
  const cacheFor = (name) => ({
    async keys() {
      cacheCalls.push(['keys', name]);
      return [...bucket(name).values()].map((entry) => entry.request);
    },
    async delete(req) {
      cacheCalls.push(['delete-entry', name, req.url]);
      return bucket(name).delete(keyOf(req));
    },
    async put(req, response) {
      cacheCalls.push(['put', name, req.url]);
      bucket(name).set(keyOf(req), { request: req, response: response.clone() });
    },
    async addAll() {},
  });
  const context = vm.createContext({
    URL,
    self: {
      location: { origin },
      registration: { scope: new URL(scope, origin).href },
      addEventListener(type, listener) { listeners.set(type, listener); },
      clients: { async claim() { claimed = true; } },
      async skipWaiting() {},
    },
    caches: {
      async keys() {
        cacheCalls.push(['storage-keys']);
        return [...buckets.keys()];
      },
      async open(name) {
        cacheCalls.push(['open', name]);
        bucket(name);
        return cacheFor(name);
      },
      async delete(name) {
        cacheCalls.push(['delete-cache', name]);
        return buckets.delete(name);
      },
      async match(req) {
        cacheCalls.push(['match', req.url]);
        for (const entries of buckets.values()) {
          const entry = entries.get(keyOf(req));
          if (entry) return entry.response.clone();
        }
        return undefined;
      },
    },
    async fetch(req, options) {
      fetchCalls.push({ request: req, options });
      return networkHandler(req, options);
    },
  });
  vm.runInContext(source, context, { filename: 'sw.js' });
  return {
    cacheName: vm.runInContext('CACHE', context),
    buckets,
    cacheCalls,
    fetchCalls,
    setNetwork(handler) { networkHandler = handler; },
    seed(name, req, body) {
      bucket(name).set(keyOf(req), { request: req, response: new Response(body) });
    },
    has(name, req) { return buckets.get(name)?.has(keyOf(req)) || false; },
    dispatch(req) {
      let response;
      listeners.get('fetch')({ request: req, respondWith(value) { response = value; } });
      return response;
    },
    async activate() {
      let completion;
      listeners.get('activate')({ waitUntil(value) { completion = value; } });
      await completion;
      return claimed;
    },
  };
}

test('private API, owner and authentication GETs never read or write an existing cache', async () => {
  const worker = createWorker();
  const paths = ['/api', '/api/v1/status', '/api/v1/jobs?profile=rodi', '/owner',
    '/owner/session', '/auth/callback', '/login', '/logout', '/session', '/%61pi/v1/board'];
  for (const path of paths) {
    const req = request(path);
    worker.seed('handul-planet-v119', req, 'old private response');
    const response = await worker.dispatch(req);
    assert.equal(await response.text(), 'network', path);
  }
  assert.equal(worker.fetchCalls.length, paths.length);
  assert.ok(worker.fetchCalls.every((call) => call.options?.cache === 'no-store'));
  assert.deepEqual(worker.cacheCalls, []);
});

test('Authorization GETs bypass all caches even for a normally cached file or another origin', async () => {
  const worker = createWorker();
  for (const path of ['/assets/example.png', 'https://private.example/data']) {
    const req = request(path, { headers: { authorization: 'Bearer test-only' } });
    worker.seed(worker.cacheName, req, 'cached authenticated response');
    assert.equal(await (await worker.dispatch(req)).text(), 'network');
  }
  assert.deepEqual(worker.cacheCalls, []);
  assert.ok(worker.fetchCalls.every((call) => call.options.cache === 'no-store'));
});

test('private paths below the service worker deployment scope also bypass caches', async () => {
  const worker = createWorker({ scope: '/mini-planet/' });
  for (const path of ['/mini-planet/api/v1/board', '/mini-planet/owner/session', '/mini-planet/auth/login']) {
    assert.equal(await (await worker.dispatch(request(path))).text(), 'network');
  }
  assert.deepEqual(worker.cacheCalls, []);
});

test('a private network failure cannot fall back to an old successful response', async () => {
  const worker = createWorker({ network: async () => { throw new TypeError('offline'); } });
  const req = request('/api/v1/board');
  worker.seed('handul-planet-v119', req, 'sensitive previous board');
  await assert.rejects(worker.dispatch(req), /offline/);
  assert.deepEqual(worker.cacheCalls, []);
});

test('activation purges private entries from current app cache and deletes only older app caches', async () => {
  const worker = createWorker();
  assert.notEqual(worker.cacheName, 'handul-planet-v119');
  const privateApi = request('/api/v1/board');
  const privateOwner = request('/owner/session');
  const authenticated = request('/otherwise-public.json', { headers: { Authorization: 'Bearer test-only' } });
  const publicAsset = request('/assets/example.png');
  for (const name of ['handul-planet-v119', worker.cacheName, 'other-app-v1']) {
    for (const req of [privateApi, privateOwner, authenticated, publicAsset]) worker.seed(name, req, 'saved');
  }
  assert.equal(await worker.activate(), true);
  assert.equal(worker.buckets.has('handul-planet-v119'), false);
  for (const req of [privateApi, privateOwner, authenticated]) assert.equal(worker.has(worker.cacheName, req), false);
  assert.equal(worker.has(worker.cacheName, publicAsset), true);
  for (const req of [privateApi, privateOwner, authenticated, publicAsset]) assert.equal(worker.has('other-app-v1', req), true);
});

test('public source and root HTML stay network-first with their offline fallback', async () => {
  const worker = createWorker();
  for (const req of [request('/src/main.js?v=119'), request('/', { mode: 'navigate' })]) {
    worker.seed(worker.cacheName, req, 'previous shell');
    worker.setNetwork(async () => new Response('new shell'));
    assert.equal(await (await worker.dispatch(req)).text(), 'new shell');
    // Public writes intentionally happen in the background, as in the worker.
    await new Promise((resolve) => setImmediate(resolve));
    worker.setNetwork(async () => { throw new TypeError('offline'); });
    assert.equal(await (await worker.dispatch(req)).text(), 'new shell');
  }
});

test('public immutable assets stay cache-first and public status snapshots remain unhandled', async () => {
  const worker = createWorker();
  const asset = request('/assets/example.png');
  worker.seed(worker.cacheName, asset, 'cached image');
  assert.equal(await (await worker.dispatch(asset)).text(), 'cached image');
  assert.equal(worker.fetchCalls.length, 0);
  for (const path of ['/agent-status.json', '/agent-results.json', '/src/main.js?dev=1']) {
    assert.equal(worker.dispatch(request(path)), undefined);
  }
  assert.equal(worker.dispatch(request('/api/v1/board', { method: 'POST' })), undefined);
});
