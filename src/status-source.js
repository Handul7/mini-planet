const DEFAULTS = {
  mode: 'poll',
  snapshotUrl: 'agent-status.json',
  eventUrl: '',
  pollMs: 60000,
  reconnectMs: 15000,
  requestTimeoutMs: 8000,
  maxSnapshotChars: 262144,
};

const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2]);

function safeInterval(value, fallback, min = 5000, max = 300000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSnapshotMeta(payload, schemaVersion, fallbackSource) {
  return {
    schemaVersion,
    publicationMode: typeof payload.publicationMode === 'string' ? payload.publicationMode : null,
    generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
    sourceGeneratedAt: typeof payload.sourceGeneratedAt === 'string'
      ? payload.sourceGeneratedAt
      : (typeof payload.generatedAt === 'string' ? payload.generatedAt : null),
    bridgeObservedAt: typeof payload.bridgeObservedAt === 'string' ? payload.bridgeObservedAt : null,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
    isStale: typeof payload.isStale === 'boolean' ? payload.isStale : null,
    source: typeof payload.source === 'string' ? payload.source : fallbackSource,
    provenance: isRecord(payload.provenance) ? payload.provenance : null,
    team: isRecord(payload.team) ? payload.team : null,
    runtime: isRecord(payload.runtime) ? payload.runtime : null,
    tasks: Array.isArray(payload.tasks) ? payload.tasks.filter(isRecord).slice(0, 100) : [],
    approvals: Array.isArray(payload.approvals) ? payload.approvals.filter(isRecord).slice(0, 50) : [],
  };
}

/**
 * Accept both the original top-level agent map and the versioned bridge
 * envelope. Keeping this pure makes the transport contract easy to test on
 * the Mac mini without starting Three.js or a browser.
 */
export function normalizeStatusSnapshot(payload) {
  if (!isRecord(payload)) return null;
  if (Object.prototype.hasOwnProperty.call(payload, 'agents') && !isRecord(payload.agents)) return null;
  if (isRecord(payload.agents)) {
    const schemaVersion = Number.isInteger(payload.schemaVersion) ? payload.schemaVersion : 1;
    if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) return null;
    return {
      agents: payload.agents,
      meta: normalizeSnapshotMeta(payload, schemaVersion, null),
    };
  }
  return { agents: payload, meta: normalizeSnapshotMeta({}, 0, 'legacy') };
}

function sameOriginEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (typeof location === 'undefined') return value.trim();
  try {
    const url = new URL(value.trim(), location.href);
    return url.origin === location.origin ? url.href : null;
  } catch (_) {
    return null;
  }
}

async function readJsonWithLimit(response, maxChars) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxChars) throw new Error('snapshot too large');
  const text = await response.text();
  if (text.length > maxChars) throw new Error('snapshot too large');
  return JSON.parse(text);
}

/**
 * Public status transport boundary for Mini Planet.
 *
 * The browser consumes only a sanitized same-origin snapshot/SSE endpoint; it
 * never receives the Hermes API bearer key. SSE payloads are complete
 * snapshots and may be sent as default `message` events or named `snapshot`
 * events. A dropped stream falls back to polling while reconnecting.
 */
export function createAgentStatusSource({ config = {}, onSnapshot, onConnectionChange = () => {} }) {
  const options = { ...DEFAULTS, ...config };
  options.pollMs = safeInterval(options.pollMs, DEFAULTS.pollMs);
  options.reconnectMs = safeInterval(options.reconnectMs, DEFAULTS.reconnectMs);
  options.requestTimeoutMs = safeInterval(options.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 1000, 30000);
  options.maxSnapshotChars = safeInterval(options.maxSnapshotChars, DEFAULTS.maxSnapshotChars, 4096, 1048576);
  options.snapshotUrl = sameOriginEndpoint(options.snapshotUrl);
  options.eventUrl = sameOriginEndpoint(options.eventUrl);

  let stopped = false;
  let pollTimer = null;
  let reconnectTimer = null;
  let events = null;
  let eventReady = false;
  let connectionState = '';
  let inFlight = null;
  let lastSuccessAt = null;
  let consecutiveFailures = 0;

  const emit = (state) => {
    if (stopped || state === connectionState) return;
    connectionState = state;
    onConnectionChange(state);
  };
  const deliver = (payload) => {
    const normalized = normalizeStatusSnapshot(payload);
    if (!stopped && normalized) onSnapshot?.(normalized.agents, normalized.meta);
    return !!normalized;
  };

  async function pollOnce() {
    if (inFlight) return inFlight;
    if (!connectionState || connectionState === 'offline') emit('loading');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
    inFlight = (async () => {
      try {
        if (!options.snapshotUrl) throw new Error('unsafe status endpoint');
        const response = await fetch(options.snapshotUrl, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        if (!deliver(await readJsonWithLimit(response, options.maxSnapshotChars))) throw new Error('invalid status snapshot');
        lastSuccessAt = new Date().toISOString();
        consecutiveFailures = 0;
        emit(eventReady ? 'live' : 'polling');
        return true;
      } catch (_) {
        consecutiveFailures += 1;
        emit('offline');
        return false;
      } finally {
        clearTimeout(timeout);
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPolling() {
    if (stopped || pollTimer) return;
    pollOnce();
    pollTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') pollOnce();
    }, options.pollMs);
  }

  function scheduleEventRetry() {
    if (stopped || options.mode !== 'sse' || !options.eventUrl || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startEvents();
    }, options.reconnectMs);
  }

  function startEvents() {
    if (stopped || events) return;
    if (options.mode !== 'sse' || !options.eventUrl || typeof EventSource === 'undefined') {
      startPolling();
      return;
    }
    emit('loading');
    try {
      events = new EventSource(options.eventUrl);
      startPolling();
      events.onopen = () => {
        eventReady = false;
        // An open socket is not proof of a healthy bridge. Keep polling until
        // the first complete, valid snapshot arrives on the stream.
        startPolling();
        if (!lastSuccessAt) emit('loading');
      };
      const onEvent = (event) => {
        try {
          if (event.data.length > options.maxSnapshotChars) return;
          if (deliver(JSON.parse(event.data))) {
            eventReady = true;
            lastSuccessAt = new Date().toISOString();
            consecutiveFailures = 0;
            stopPolling();
            emit('live');
          }
        } catch (_) { /* ignore malformed or non-snapshot events */ }
      };
      events.onmessage = onEvent;
      events.addEventListener('snapshot', onEvent);
      events.onerror = () => {
        events?.close();
        events = null;
        eventReady = false;
        startPolling();
        scheduleEventRetry();
      };
    } catch (_) {
      events = null;
      startPolling();
      scheduleEventRetry();
    }
  }

  const onlineTarget = typeof globalThis.addEventListener === 'function' ? globalThis : null;
  const visibilityTarget = typeof document !== 'undefined'
    && typeof document.addEventListener === 'function'
    ? document
    : null;
  const onOnline = () => { if (!stopped) pollOnce(); };
  const onVisible = () => {
    if (!stopped && (typeof document === 'undefined' || document.visibilityState === 'visible')) pollOnce();
  };
  onlineTarget?.addEventListener('online', onOnline);
  visibilityTarget?.addEventListener('visibilitychange', onVisible);
  startEvents();

  return {
    refresh: pollOnce,
    diagnostics() {
      return { connectionState, lastSuccessAt, consecutiveFailures, streamReady: eventReady };
    },
    stop() {
      stopped = true;
      stopPolling();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      events?.close();
      events = null;
      eventReady = false;
      onlineTarget?.removeEventListener('online', onOnline);
      visibilityTarget?.removeEventListener('visibilitychange', onVisible);
    },
  };
}
