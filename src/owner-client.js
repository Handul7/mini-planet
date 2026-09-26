import { OWNER_RESOURCE_PATHS, decodeOwnerResource, ownerResourceView } from './owner-data.js';

// This client only talks to the same-origin session host. Hermes/controller
// credentials never enter the browser, and private responses stay in memory.
export function createOwnerClient({ fetchImpl = globalThis.fetch, now = Date.now, onChange = () => {} } = {}) {
  let authenticated = false;
  let expiresAt = null;
  let sessionError = '';
  let epoch = 0;
  let resources = {};
  let sessionController = null;
  let logoutPromise = null;
  let loggingOut = false;
  let logoutUnconfirmed = false;
  const requests = new Map();
  const notify = () => onChange(snapshot());

  function clear(error = '') {
    epoch += 1;
    sessionController?.abort();
    for (const entry of requests.values()) entry.controller.abort();
    requests.clear();
    authenticated = false;
    expiresAt = null;
    sessionError = error;
    resources = {};
    notify();
  }

  async function jsonRequest(path, options = {}) {
    const response = await fetchImpl(path, { ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    const limit = path.startsWith('/owner/') ? 8192 : 1024 * 1024;
    const length = Number(response.headers?.get('content-length'));
    if (Number.isFinite(length) && length > limit) throw new Error('invalid_response');
    const text = await response.text();
    if (text.length > limit) throw new Error('invalid_response');
    let body;
    try { body = JSON.parse(text); } catch { throw new Error('invalid_response'); }
    return { response, body };
  }

  async function session(password) {
    if (logoutPromise) await logoutPromise;
    // A failed DELETE may leave the HttpOnly cookie valid on the server. Only
    // an explicit login or successful logout may clear this in-page lock.
    if (password === undefined && logoutUnconfirmed) return false;
    const version = ++epoch;
    sessionController?.abort();
    for (const entry of requests.values()) entry.controller.abort();
    requests.clear();
    for (const resource of Object.values(resources)) resource.pending = false;
    const controller = new AbortController();
    sessionController = controller;
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const { response, body } = await jsonRequest('/owner/session', password === undefined ? { signal: controller.signal } : {
        signal: controller.signal,
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      });
      if (version !== epoch) return false;
      if (!response.ok || body.authenticated !== true || !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= now()) {
        clear(response.status === 429 ? 'too_many_attempts' : response.status === 401 ? (password === undefined ? '' : 'invalid_password') : 'host_unavailable');
        return false;
      }
      authenticated = true;
      expiresAt = body.expiresAt;
      sessionError = '';
      logoutUnconfirmed = false;
      notify();
      return true;
    } catch {
      if (version === epoch) clear('host_unavailable');
      return false;
    } finally {
      clearTimeout(timer);
      if (sessionController === controller) sessionController = null;
    }
  }

  function view(key) {
    const resource = resources[key];
    const result = ownerResourceView(resource?.response ?? null, now());
    if (resource?.error) {
      return { ...result, state: result.data ? 'stale' : 'error', usable: false, reason: resource.error, pending: !!resource.pending };
    }
    return { ...result, pending: !!resource?.pending };
  }

  function snapshot() {
    return { authenticated, expiresAt, sessionError, loggingOut, logoutUnconfirmed, resources: Object.fromEntries(Object.keys(OWNER_RESOURCE_PATHS).map((key) => [key, view(key)])) };
  }

  async function refresh(key) {
    if (!Object.hasOwn(OWNER_RESOURCE_PATHS, key)) throw new Error('unsupported_resource');
    if (!authenticated) return false;
    if (Date.parse(expiresAt) <= now()) { clear('session_expired'); return false; }
    if (requests.has(key)) return requests.get(key).promise;
    const version = epoch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    resources[key] = { ...resources[key], pending: true };
    const promise = (async () => {
      try {
        const { response, body } = await jsonRequest(OWNER_RESOURCE_PATHS[key], { signal: controller.signal });
        if (version !== epoch) return false;
        if (response.status === 401) { clear('session_expired'); return false; }
        const decoded = decodeOwnerResource(key, body);
        // Failures with last-success data are still valid envelopes. Unstructured
        // proxy errors never replace a previous successful read with an empty list.
        if (!decoded || (!decoded.source && key !== 'status') || (key === 'status' && !decoded.controller)) {
          resources[key] = { ...resources[key], error: response.ok ? 'invalid_response' : 'upstream_unavailable', pending: false };
          return false;
        }
        resources[key] = { response: decoded, error: '', pending: false };
        return response.ok;
      } catch {
        if (version === epoch) resources[key] = { ...resources[key], error: 'connection_failed', pending: false };
        return false;
      } finally {
        clearTimeout(timer);
        if (requests.get(key)?.controller === controller) requests.delete(key);
        if (version === epoch) notify();
      }
    })();
    requests.set(key, { promise, controller });
    notify();
    return promise;
  }

  return {
    checkSession: () => session(),
    login: (password) => session(password),
    logout() {
      if (logoutPromise) return logoutPromise;
      loggingOut = true;
      logoutUnconfirmed = true;
      clear();
      const version = epoch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      logoutPromise = (async () => {
        try {
          const { response, body } = await jsonRequest('/owner/session', { method: 'DELETE', signal: controller.signal });
          if (version === epoch) {
            logoutUnconfirmed = !(response.ok && body.authenticated === false);
            sessionError = logoutUnconfirmed ? 'logout_failed' : '';
          }
        } catch { if (version === epoch) sessionError = 'logout_failed'; }
        finally { clearTimeout(timer); loggingOut = false; logoutPromise = null; notify(); }
      })();
      return logoutPromise;
    },
    refresh,
    async refreshAll() {
      await Promise.allSettled(Object.keys(OWNER_RESOURCE_PATHS).filter((key) => key !== 'status').map(refresh));
      if (authenticated) await refresh('status');
    },
    snapshot,
    tick() {
      if (authenticated && Date.parse(expiresAt) <= now()) clear('session_expired');
      return snapshot();
    },
    dispose: () => clear(),
  };
}
