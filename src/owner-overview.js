// A read-only projection of validated owner resources. These are observed board
// and schedule records, never a claim about a resident's overall activity.
const ATTENTION_RESOURCES = ['board', 'jobs:default', 'jobs:rodi', 'jobs:jarvis'];
const RESOURCE_KEYS = [...ATTENTION_RESOURCES, 'results:rodi'];

export function aggregateOwnerOverview(snapshot) {
  if (!snapshot?.authenticated) {
    return { authenticated: false, currentItems: [], staleItems: [], resources: [], attentionComplete: false };
  }
  const currentItems = [], staleItems = [];
  const resources = RESOURCE_KEYS.map((key) => {
    const view = snapshot.resources?.[key];
    return {
      key, state: view?.state || 'unknown', reason: view?.reason || null,
      pending: !!view?.pending, lastSuccessAt: view?.lastSuccessAt || null,
      hasData: !!view?.data,
    };
  });
  const seen = new Set();
  for (const resourceKey of ATTENTION_RESOURCES) {
    const view = snapshot.resources?.[resourceKey];
    const current = view?.state === 'ok' && view.usable === true;
    if (!current && view?.state !== 'stale') continue;
    const rows = resourceKey === 'board' ? view.data?.tasks : view.data?.jobs;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id) continue;
      const task = resourceKey === 'board';
      if (task ? !['blocked', 'review'].includes(row.status) : row.error?.present !== true) continue;
      const key = JSON.stringify([resourceKey, row.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      const item = {
        key, resourceKey, id: row.id, kind: task ? 'task' : 'job',
        freshness: current ? 'current' : 'stale', lastSuccessAt: view.lastSuccessAt || null,
        ...(task ? { task: row } : { job: row }),
      };
      (current ? currentItems : staleItems).push(item);
    }
  }
  // Resource order and original row order stay stable across renders. No
  // missing timestamp, review state or error flag is treated as an approval.
  return {
    authenticated: true, currentItems, staleItems, resources,
    attentionComplete: ATTENTION_RESOURCES.every((key) => {
      const view = snapshot.resources?.[key];
      return view?.state === 'ok' && view.usable === true && !!view.data;
    }),
  };
}
