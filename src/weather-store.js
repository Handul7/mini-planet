import { CITIES } from './climate-model.js?v=114';

const CACHE_KEY = 'mini-planet:weather:v1';
const CITY_KEYS = ['seoul', 'rio'];
const DEFAULT_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_CACHE_CHARS = 4096;
const CURRENT_FIELDS = [
  'temperature_2m', 'weather_code', 'wind_speed_10m',
  'precipitation', 'cloud_cover', 'snowfall',
];
const RANGES = {
  temperature_2m: [-90, 60],
  wind_speed_10m: [0, 300],
  precipitation: [0, 200],
  cloud_cover: [0, 100],
  snowfall: [0, 100],
};
const WEATHER_CODES = new Set([
  0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65,
  66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99,
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateCurrent(value) {
  if (!isRecord(value) || !WEATHER_CODES.has(value.weather_code)) return null;
  const current = { weather_code: value.weather_code };
  for (const [field, [min, max]] of Object.entries(RANGES)) {
    // Older snapshots may omit snowfall; supplied values must still be numeric.
    const number = field === 'snowfall' && !Object.hasOwn(value, field) ? 0 : value[field];
    if (typeof number !== 'number' || !Number.isFinite(number)) return null;
    current[field] = Math.max(min, Math.min(max, number));
  }
  return current;
}

/**
 * Two-city, on-demand weather cache. `now` is an injectable wall clock (Date.now
 * in production), never the sky's development time shift or the API's time.
 * Storage holds only { seoul: { current, updatedAt } | null, rio: ... }.
 */
export function createWeatherStore({
  fetchImpl = globalThis.fetch,
  storage,
  now = Date.now,
  timeoutMs = 6000,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? Math.min(timeoutMs, 60000) : 6000;
  const maxAge = Number.isFinite(maxAgeMs) && maxAgeMs >= 0
    ? maxAgeMs : DEFAULT_MAX_AGE_MS;
  const entries = new Map();
  const controllers = new Set();
  let inFlight = null;
  let disposed = false;

  function isFresh(updatedAt, timestamp = now()) {
    return Number.isFinite(updatedAt) && updatedAt >= 0
      && Number.isFinite(timestamp) && timestamp >= updatedAt
      && timestamp - updatedAt < maxAge;
  }

  try {
    const raw = storage?.getItem(CACHE_KEY);
    if (typeof raw === 'string' && raw.length <= MAX_CACHE_CHARS) {
      const cached = JSON.parse(raw);
      const timestamp = now();
      if (isRecord(cached)) {
        for (const key of CITY_KEYS) {
          const entry = Object.hasOwn(cached, key) ? cached[key] : null;
          const current = isRecord(entry) && validateCurrent(entry.current);
          if (current && isFresh(entry.updatedAt, timestamp)) {
            entries.set(key, { current, updatedAt: entry.updatedAt, source: 'cached' });
          }
        }
      }
    }
  } catch (_) {
    // Private browsing, corrupt JSON, and unavailable storage are nonfatal.
  }

  function get(key) {
    const entry = entries.get(key);
    if (!entry || !isFresh(entry.updatedAt)) {
      entries.delete(key);
      return { current: null, source: 'fallback', updatedAt: null };
    }
    return { current: { ...entry.current }, source: entry.source, updatedAt: entry.updatedAt };
  }

  function persist() {
    try {
      const cached = {};
      for (const key of CITY_KEYS) {
        const { current, updatedAt } = get(key);
        cached[key] = current ? { current, updatedAt } : null;
      }
      storage?.setItem(CACHE_KEY, JSON.stringify(cached));
    } catch (_) {
      // A storage quota/access failure must not discard live in-memory weather.
    }
  }

  async function fetchCity(key) {
    const controller = new AbortController();
    const { signal } = controller;
    controllers.add(controller);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Weather request aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const city = CITIES[key];
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({
        latitude: city.lat,
        longitude: city.lon,
        current: CURRENT_FIELDS.join(','),
        timezone: 'UTC',
      }).toString();
      // Race the entire body read as well as fetch: abort alone is not enough
      // for transports/stubs that ignore the signal or never finish JSON.
      const request = (async () => {
        const response = await fetchImpl(url.href, { signal, cache: 'no-store' });
        if (signal.aborted) throw new Error('Weather request aborted');
        if (!response?.ok) throw new Error(`Weather HTTP ${response?.status}`);
        const payload = await response.json();
        if (signal.aborted) throw new Error('Weather request aborted');
        const current = isRecord(payload) && validateCurrent(payload.current);
        if (!current) throw new Error('Invalid current weather');
        return { current, updatedAt: now(), source: 'live' };
      })();
      return await Promise.race([request, aborted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      controllers.delete(controller);
    }
  }

  function refresh() {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    // Defer transport startup so overlapping calls share this exact promise.
    inFlight = Promise.resolve().then(() => {
      if (disposed) return [];
      return Promise.allSettled(CITY_KEYS.map(fetchCity));
    }).then((results) => {
      if (disposed) return;
      results.forEach((result, index) => {
        const key = CITY_KEYS[index];
        if (result.status === 'fulfilled') {
          entries.set(key, result.value);
        } else {
          const entry = entries.get(key);
          if (entry) entry.source = 'cached';
        }
      });
      persist();
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }

  return { get, refresh, dispose };
}
