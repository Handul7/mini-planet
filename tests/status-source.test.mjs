import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentStatusSource } from '../src/status-source.js';

test('SSE becomes live only after a valid complete snapshot', async () => {
  const originalEventSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      instances.push(this);
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    close() {}
  }
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify({ schemaVersion: 2, agents: { rodi: { state: 'waiting' } } }),
  });

  const states = [];
  const snapshots = [];
  const source = createAgentStatusSource({
    config: { mode: 'sse', snapshotUrl: 'agent-status.json', eventUrl: 'events', pollMs: 300000 },
    onSnapshot: (agents) => snapshots.push(agents),
    onConnectionChange: (state) => states.push(state),
  });
  try {
    assert.equal(instances.length, 1);
    instances[0].onopen();
    assert.equal(states.includes('live'), false);
    await source.refresh();
    assert.equal(states.at(-1), 'polling');

    instances[0].listeners.get('snapshot')({
      data: JSON.stringify({ schemaVersion: 2, agents: { rodi: { state: 'running' } } }),
    });
    assert.equal(states.at(-1), 'live');
    assert.equal(source.diagnostics().streamReady, true);
    assert.equal(snapshots.at(-1).rodi.state, 'running');
  } finally {
    source.stop();
    globalThis.EventSource = originalEventSource;
    globalThis.fetch = originalFetch;
  }
});

test('a visible tab refreshes through the document visibility event', async () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const listeners = new Map();
  let fetchCount = 0;
  globalThis.document = {
    visibilityState: 'hidden',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  globalThis.fetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ schemaVersion: 2, agents: { rodi: { state: 'idle' } } }),
    };
  };

  const source = createAgentStatusSource({
    config: { mode: 'poll', snapshotUrl: 'agent-status.json', pollMs: 300000 },
    onSnapshot: () => {},
  });
  try {
    await source.refresh();
    const beforeVisible = fetchCount;
    assert.equal(typeof listeners.get('visibilitychange'), 'function');
    globalThis.document.visibilityState = 'visible';
    listeners.get('visibilitychange')();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetchCount, beforeVisible + 1);
  } finally {
    source.stop();
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});
