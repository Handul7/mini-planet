import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const CITIES = {
  seoul: { lat: 37.5665, lon: 126.978 },
  rio: { lat: -22.9068, lon: -43.1729 },
};
const storeUrl = new URL('../src/weather-store.js', import.meta.url);
const modelUrl = new URL('../src/climate-model.js', import.meta.url);
let importUrl = storeUrl.href;
try {
  await access(modelUrl);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // Standalone agent handoff: inject only the missing import, entirely in memory.
  // When the real model is present, the unchanged production module is tested.
  const source = await readFile(storeUrl, 'utf8');
  assert.match(source, /import \{ CITIES \} from '\.\/climate-model\.js';/);
  const fixtureUrl = `data:text/javascript,${encodeURIComponent(`export const CITIES = ${JSON.stringify(CITIES)};`)}`;
  const injected = source.replace("'./climate-model.js'", JSON.stringify(fixtureUrl));
  importUrl = `data:text/javascript;base64,${Buffer.from(injected).toString('base64')}`;
  console.info('# climate-model.js absent: using in-memory CITIES fixture');
}
const { createWeatherStore } = await import(importUrl);

const CACHE_KEY = 'mini-planet:weather:v1';
const HOUR = 60 * 60 * 1000;
const EPOCH = Date.UTC(2026, 8, 12);
const FALLBACK = { current: null, source: 'fallback', updatedAt: null };
const GOOD = {
  temperature_2m: 23.5,
  weather_code: 3,
  wind_speed_10m: 14,
  precipitation: 0.4,
  cloud_cover: 70,
  snowfall: 0,
};
const response = (current = GOOD) => ({ ok: true, json: async () => ({ current }) });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function memoryStorage(value) {
  const values = new Map(value === undefined ? [] : [[CACHE_KEY, value]]);
  const writes = [];
  return {
    values,
    writes,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, next) { writes.push([key, next]); values.set(key, next); },
  };
}

function seed(overrides = {}) {
  return JSON.stringify({
    seoul: { current: GOOD, updatedAt: EPOCH },
    rio: { current: GOOD, updatedAt: EPOCH },
    ...overrides,
  });
}

function makeStore(t, options = {}) {
  const store = createWeatherStore({ now: () => EPOCH, ...options });
  t.after(() => store.dispose());
  return store;
}

test('starts without DOM, timers, network, storage, or invented weather', (t) => {
  let calls = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timer = t.mock.method(globalThis, 'setTimeout');
  const store = makeStore(t, { fetchImpl: () => { calls += 1; } });
  for (const key of ['seoul', 'rio', 'unknown', '__proto__', 'constructor']) {
    assert.deepEqual(store.get(key), FALLBACK);
  }
  assert.equal(calls, 0);
  assert.equal(timer.mock.callCount(), 0);
});

test('deduplicates overlapping refreshes, fetches both cities once, then permits another refresh', async (t) => {
  const calls = [];
  const pending = [deferred(), deferred()];
  const store = makeStore(t, {
    fetchImpl: (url, options) => {
      calls.push({ url: new URL(url), ...options });
      return pending[(calls.length - 1) % 2].promise;
    },
  });
  const first = store.refresh();
  assert.strictEqual(store.refresh(), first);
  await flush();
  assert.equal(calls.length, 2);
  for (const [index, key] of ['seoul', 'rio'].entries()) {
    const { url, signal, cache } = calls[index];
    assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
    assert.equal(Number(url.searchParams.get('latitude')), CITIES[key].lat);
    assert.equal(Number(url.searchParams.get('longitude')), CITIES[key].lon);
    assert.equal(url.searchParams.get('timezone'), 'UTC');
    assert.deepEqual(url.searchParams.get('current').split(','), [
      'temperature_2m', 'weather_code', 'wind_speed_10m', 'precipitation', 'cloud_cover', 'snowfall',
    ]);
    assert.equal(url.searchParams.has('apikey'), false);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(cache, 'no-store');
  }
  pending[0].resolve(response());
  pending[1].resolve(response({ ...GOOD, temperature_2m: 29 }));
  await first;
  assert.deepEqual(store.get('seoul'), { current: GOOD, source: 'live', updatedAt: EPOCH });
  assert.equal(store.get('rio').current.temperature_2m, 29);
  await store.refresh();
  assert.equal(calls.length, 4);
});

test('allSettled updates one city and retains the failed city as cached without changing its timestamp', async (t) => {
  let timestamp = EPOCH;
  let failing = false;
  const storage = memoryStorage();
  const store = makeStore(t, {
    storage,
    now: () => timestamp,
    fetchImpl: async (url) => {
      if (failing && new URL(url).searchParams.get('latitude').startsWith('-')) throw new Error('offline');
      return response({ ...GOOD, temperature_2m: failing ? 25 : 23.5 });
    },
  });
  await store.refresh();
  timestamp += HOUR;
  failing = true;
  await store.refresh();
  assert.equal(store.get('seoul').source, 'live');
  assert.equal(store.get('seoul').updatedAt, timestamp);
  assert.equal(store.get('seoul').current.temperature_2m, 25);
  assert.deepEqual(store.get('rio'), { current: GOOD, source: 'cached', updatedAt: EPOCH });
  assert.equal(storage.writes.length, 2);
  const reloaded = makeStore(t, { storage, now: () => timestamp });
  assert.equal(reloaded.get('seoul').source, 'cached');
  assert.deepEqual(reloaded.get('rio'), store.get('rio'));
});

test('offline and missing-fetch refreshes settle with cached or fallback entries', async (t) => {
  for (const fetchImpl of [async () => { throw new Error('offline'); }, null, () => { throw new Error('sync failure'); }]) {
    const cached = makeStore(t, { storage: memoryStorage(seed()), fetchImpl });
    const empty = makeStore(t, { fetchImpl });
    await cached.refresh();
    await empty.refresh();
    for (const key of ['seoul', 'rio']) {
      assert.deepEqual(cached.get(key), { current: GOOD, source: 'cached', updatedAt: EPOCH });
      assert.deepEqual(empty.get(key), FALLBACK);
    }
  }
});

test('times out uncooperative fetches, clears timers, retains cache, and ignores late responses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const pending = [deferred(), deferred()];
  const signals = [];
  const storage = memoryStorage(seed());
  const store = makeStore(t, {
    storage,
    timeoutMs: 20,
    fetchImpl: (_, { signal }) => { signals.push(signal); return pending[signals.length - 1].promise; },
  });
  const refresh = store.refresh();
  await flush();
  t.mock.timers.tick(19);
  assert.ok(signals.every((signal) => !signal.aborted));
  t.mock.timers.tick(1);
  await refresh;
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(clear.mock.callCount(), 2);
  assert.equal(store.get('seoul').source, 'cached');
  const before = storage.values.get(CACHE_KEY);
  for (const request of pending) request.resolve(response({ ...GOOD, temperature_2m: 50 }));
  await flush();
  assert.equal(storage.values.get(CACHE_KEY), before);
  assert.equal(storage.writes.length, 1);
  assert.equal(store.get('seoul').current.temperature_2m, GOOD.temperature_2m);
});

test('default timeout is 6000ms and covers stalled JSON bodies', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  const body = deferred();
  const store = makeStore(t, {
    fetchImpl: async (_, { signal }) => {
      signals.push(signal);
      return { ok: true, json: () => body.promise };
    },
  });
  const refresh = store.refresh();
  await flush();
  t.mock.timers.tick(5999);
  assert.ok(signals.every((signal) => !signal.aborted));
  t.mock.timers.tick(1);
  await refresh;
  assert.ok(signals.every((signal) => signal.aborted));
  body.resolve({ current: GOOD });
  await flush();
  assert.deepEqual(store.get('seoul'), FALLBACK);
});

test('clears successful request timers and creates no polling timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const timer = t.mock.method(globalThis, 'setTimeout');
  const interval = t.mock.method(globalThis, 'setInterval');
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const signals = [];
  const store = makeStore(t, {
    fetchImpl: async (_, { signal }) => { signals.push(signal); return response(); },
  });
  await store.refresh();
  assert.equal(timer.mock.callCount(), 2);
  assert.equal(clear.mock.callCount(), 2);
  assert.equal(interval.mock.callCount(), 0);
  t.mock.timers.tick(60000);
  assert.ok(signals.every((signal) => !signal.aborted));
  assert.equal(timer.mock.callCount(), 2);
});

test('enforces three-hour expiration on get after idle, including live entries', async (t) => {
  let timestamp = EPOCH;
  const store = makeStore(t, { now: () => timestamp, storage: memoryStorage(seed()), fetchImpl: async () => response() });
  timestamp += 3 * HOUR - 1;
  assert.equal(store.get('seoul').source, 'cached');
  timestamp += 1;
  assert.deepEqual(store.get('seoul'), FALLBACK);
  await store.refresh();
  assert.equal(store.get('seoul').source, 'live');
  timestamp += 3 * HOUR;
  assert.deepEqual(store.get('seoul'), FALLBACK);
});

test('rejects expired, future, nonnumeric, negative, and missing cache timestamps', (t) => {
  for (const updatedAt of [EPOCH - 3 * HOUR, EPOCH + 1, String(EPOCH), -1, null, undefined]) {
    const store = makeStore(t, { storage: memoryStorage(seed({ seoul: { current: GOOD, updatedAt } })) });
    assert.deepEqual(store.get('seoul'), FALLBACK);
    assert.equal(store.get('rio').source, 'cached');
  }
});

test('honors custom maxAge and does not renew expired data on a failed refresh', async (t) => {
  let timestamp = EPOCH;
  const storage = memoryStorage(seed());
  const store = makeStore(t, {
    storage, maxAgeMs: 10, now: () => timestamp,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  timestamp += 10;
  await store.refresh();
  assert.deepEqual(store.get('seoul'), FALLBACK);
  assert.deepEqual(JSON.parse(storage.values.get(CACHE_KEY)), { seoul: null, rio: null });
});

test('default cache timestamps use Date.now, not API time or UTC offsets', async (t) => {
  t.mock.method(Date, 'now', () => EPOCH);
  const store = createWeatherStore({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ current: { ...GOOD, time: '2099-01-01T00:00' }, utc_offset_seconds: 32400 }),
    }),
  });
  t.after(() => store.dispose());
  await store.refresh();
  assert.equal(store.get('seoul').updatedAt, EPOCH);
  assert.deepEqual(store.get('seoul').current, GOOD);
});

test('rejects malformed payloads and HTTP/JSON failures without replacing last good data', async (t) => {
  const badResponses = [
    { ok: false, status: 503, json: async () => ({ current: GOOD }) },
    { ok: true, json: async () => { throw new SyntaxError('broken JSON'); } },
    ...[null, [], {}, { current: null }, { current: [] }, { current: {} }].map((payload) => ({ ok: true, json: async () => payload })),
  ];
  for (const field of Object.keys(GOOD)) {
    for (const invalid of ['1', null, NaN, Infinity, -Infinity, {}, [], true]) {
      badResponses.push(response({ ...GOOD, [field]: invalid }));
    }
    if (field !== 'snowfall') {
      const incomplete = { ...GOOD };
      delete incomplete[field];
      badResponses.push(response(incomplete));
    }
  }
  for (const weather_code of [-1, 4, 50, 99.5, 100]) badResponses.push(response({ ...GOOD, weather_code }));
  for (const bad of badResponses) {
    const store = makeStore(t, { storage: memoryStorage(seed()), fetchImpl: async () => bad });
    await store.refresh();
    assert.deepEqual(store.get('seoul'), { current: GOOD, source: 'cached', updatedAt: EPOCH });
    store.dispose();
  }
  const empty = makeStore(t, { fetchImpl: async () => response({ ...GOOD, temperature_2m: 'hot' }) });
  await empty.refresh();
  assert.deepEqual(empty.get('seoul'), FALLBACK);
});

test('clamps finite measurements, strips extra data, and does not expose mutable entries', async (t) => {
  const storage = memoryStorage(seed({ extra: { current: GOOD, updatedAt: EPOCH } }));
  const input = { ...GOOD, temperature_2m: 90, precipitation: -2, cloud_cover: 500, wind_speed_10m: 900, snowfall: 500, extra: 'ignored' };
  const store = makeStore(t, { storage, fetchImpl: async () => response(input) });
  await store.refresh();
  const expected = { ...GOOD, temperature_2m: 60, precipitation: 0, cloud_cover: 100, wind_speed_10m: 300, snowfall: 100 };
  assert.deepEqual(store.get('seoul').current, expected);
  const exposed = store.get('seoul');
  exposed.current.temperature_2m = 500;
  exposed.updatedAt = 0;
  input.cloud_cover = 0;
  assert.deepEqual(store.get('seoul'), { current: expected, source: 'live', updatedAt: EPOCH });
  assert.deepEqual(store.get('extra'), FALLBACK);
  const cached = JSON.parse(storage.values.get(CACHE_KEY));
  assert.deepEqual(Object.keys(cached), ['seoul', 'rio']);
  assert.deepEqual(Object.keys(cached.seoul), ['current', 'updatedAt']);
  assert.deepEqual(cached.seoul.current, expected);
  assert.ok(storage.values.get(CACHE_KEY).length < 4096);
  assert.ok(storage.writes.every(([key]) => key === CACHE_KEY));
});

test('also clamps lower and upper bounds and accepts missing optional snowfall', async (t) => {
  const store = makeStore(t, {
    fetchImpl: async () => response({ temperature_2m: -100, weather_code: 71, precipitation: 500, cloud_cover: -5, wind_speed_10m: -1 }),
  });
  await store.refresh();
  assert.deepEqual(store.get('seoul').current, {
    temperature_2m: -90, weather_code: 71, precipitation: 200, cloud_cover: 0, wind_speed_10m: 0, snowfall: 0,
  });
});

test('validates stored current data with the same rules as live data', (t) => {
  const storage = memoryStorage(seed({
    seoul: { current: { ...GOOD, weather_code: '3' }, updatedAt: EPOCH },
    rio: { current: { ...GOOD, cloud_cover: 120, extra: 'ignored' }, updatedAt: EPOCH },
  }));
  const store = makeStore(t, { storage });
  assert.deepEqual(store.get('seoul'), FALLBACK);
  assert.deepEqual(store.get('rio').current, { ...GOOD, cloud_cover: 100 });
});

test('swallows corrupt, wrong-shape, oversized cache and storage access failures', async (t) => {
  const throwing = () => { throw new Error('Storage unavailable'); };
  const storages = [
    memoryStorage('{'), memoryStorage('null'), memoryStorage('[]'), memoryStorage('1'),
    memoryStorage(' '.repeat(4097) + seed()),
    { getItem: throwing, setItem: throwing },
    { get getItem() { return throwing(); }, get setItem() { return throwing(); } },
    { getItem: () => seed(), setItem: throwing },
    {},
  ];
  for (const storage of storages) {
    const store = makeStore(t, { storage, fetchImpl: async () => response() });
    await store.refresh();
    assert.equal(store.get('seoul').source, 'live');
    assert.deepEqual(store.get('seoul').current, GOOD);
  }
  const unrelated = memoryStorage();
  unrelated.values.set('mini-planet:weather:v0', seed());
  assert.deepEqual(makeStore(t, { storage: unrelated }).get('seoul'), FALLBACK);
});

test('dispose aborts active requests, settles refresh, blocks late writes, and is terminal/idempotent', async (t) => {
  const pending = [deferred(), deferred()];
  const signals = [];
  const storage = memoryStorage(seed());
  const store = makeStore(t, {
    storage,
    fetchImpl: (_, { signal }) => { signals.push(signal); return pending[signals.length - 1].promise; },
  });
  const refresh = store.refresh();
  await flush();
  store.dispose();
  store.dispose();
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  await refresh;
  for (const request of pending) request.resolve(response({ ...GOOD, temperature_2m: 40 }));
  await flush();
  await store.refresh();
  assert.equal(signals.length, 2);
  assert.equal(storage.writes.length, 0);
  assert.equal(storage.values.get(CACHE_KEY), seed());
  assert.deepEqual(store.get('seoul'), { current: GOOD, source: 'cached', updatedAt: EPOCH });
});

test('dispose prevents startup before the refresh microtask and prevents pending JSON writes', async (t) => {
  let calls = 0;
  const immediate = makeStore(t, { fetchImpl: async () => { calls += 1; return response(); } });
  const queued = immediate.refresh();
  immediate.dispose();
  await queued;
  assert.equal(calls, 0);

  const body = deferred();
  const storage = memoryStorage();
  const store = makeStore(t, { storage, fetchImpl: async () => ({ ok: true, json: () => body.promise }) });
  const refresh = store.refresh();
  await flush();
  store.dispose();
  await refresh;
  body.resolve({ current: GOOD });
  await flush();
  assert.deepEqual(store.get('seoul'), FALLBACK);
  assert.equal(storage.writes.length, 0);
});
