const DEFAULTS = {
  mode: 'poll',
  snapshotUrl: 'agent-status.json',
  eventUrl: '',
  pollMs: 60000,
  reconnectMs: 15000,
  requestTimeoutMs: 8000,
};

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
    generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
    source: typeof payload.source === 'string' ? payload.source : fallbackSource,
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
  if (isRecord(payload.agents)) {
    const schemaVersion = Number.isInteger(payload.schemaVersion) ? payload.schemaVersion : 1;
    return {
      agents: payload.agents,
      meta: normalizeSnapshotMeta(payload, schemaVersion, null),
    };
  }
  return { agents: payload, meta: normalizeSnapshotMeta({}, 0, 'legacy') };
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

  let stopped = false;
  let pollTimer = null;
  let reconnectTimer = null;
  let events = null;
  let connectionState = '';
  let inFlight = null;

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
        const response = await fetch(options.snapshotUrl, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        if (!deliver(await response.json())) throw new Error('invalid status snapshot');
        emit(events ? 'live' : 'polling');
        return true;
      } catch (_) {
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
    pollTimer = setInterval(pollOnce, options.pollMs);
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
      events.onopen = () => {
        stopPolling();
        emit('live');
      };
      const onEvent = (event) => {
        try {
          if (deliver(JSON.parse(event.data))) emit('live');
        } catch (_) { /* ignore malformed or non-snapshot events */ }
      };
      events.onmessage = onEvent;
      events.addEventListener('snapshot', onEvent);
      events.onerror = () => {
        events?.close();
        events = null;
        startPolling();
        scheduleEventRetry();
      };
    } catch (_) {
      events = null;
      startPolling();
      scheduleEventRetry();
    }
  }

  startEvents();

  return {
    refresh: pollOnce,
    stop() {
      stopped = true;
      stopPolling();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      events?.close();
      events = null;
    },
  };
}
