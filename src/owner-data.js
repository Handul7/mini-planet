// Private controller contract. Deliberately independent of public-dashboard v2,
// browser APIs and transport. Fixtures are historical examples, never live data.
export const OWNER_RESOURCE_PATHS = Object.freeze({
  status: '/api/v1/status',
  board: '/api/v1/board',
  'jobs:default': '/api/v1/jobs?profile=default',
  'jobs:rodi': '/api/v1/jobs?profile=rodi',
  'jobs:jarvis': '/api/v1/jobs?profile=jarvis',
  'results:rodi': '/api/v1/results/rodi',
});

export const OWNER_FRESHNESS_MS = 15000;
const RESOURCE_KEYS = Object.keys(OWNER_RESOURCE_PATHS).filter((key) => key !== 'status');
const PROFILES = ['default', 'rodi', 'jarvis', 'yul', 'ludwig', 'anne', 'argos'];
const TASK_STATES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'];
const BOUNDARY_ERRORS = new Set([
  'invalid_host', 'invalid_origin', 'request_body_not_allowed', 'invalid_content_length',
  'unauthorized', 'method_not_allowed', 'ambiguous_url', 'query_not_allowed',
  'invalid_query', 'unsupported_profile', 'not_found',
]);

function assert(condition) {
  if (!condition) throw new TypeError('Invalid owner controller response');
}

function record(value) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}

function text(value, { nullable = false, nonempty = false, max = 100000 } = {}) {
  if (nullable && value === null) return null;
  assert(typeof value === 'string' && value.length <= max && (!nonempty || value.trim().length > 0));
  return value;
}

function count(value, nullable = false) {
  if (nullable && value === null) return null;
  assert(Number.isSafeInteger(value) && value >= 0);
  return value;
}

function bool(value) {
  assert(typeof value === 'boolean');
  return value;
}

// Date.parse alone accepts normalized dates such as February 30. Check calendar
// components first, preserving the controller's microsecond ISO timestamps.
function timestamp(value, nullable = true) {
  if (nullable && value === null) return null;
  assert(typeof value === 'string' && value.length <= 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  assert(match);
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  assert(m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]);
  assert(Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60);
  if (zone !== 'Z') assert(Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4)) < 60);
  assert(Number.isFinite(Date.parse(value)));
  return value;
}

function resident(value) {
  const input = record(value);
  assert(input.overall_activity === 'unknown');
  return { overall_activity: 'unknown', running_board_count: count(input.running_board_count, true) };
}

function array(value) {
  assert(Array.isArray(value) && value.length <= 10000);
  return value;
}

function uniqueIds(rows) {
  assert(new Set(rows.map((row) => row.id)).size === rows.length);
}

function boardData(value, outerResident) {
  const input = record(value), scope = record(input.scope), sourceCounts = record(input.counts);
  assert(scope.board === 'default' && scope.include_archived === false && input.archived_total === null);
  const counts = Object.fromEntries(TASK_STATES.map((key) => [key, count(sourceCounts[key])]));
  const tasks = array(input.tasks).map((value) => {
    const row = record(value);
    assert(TASK_STATES.includes(row.status));
    return {
      id: text(row.id, { nonempty: true, max: 512 }),
      title: text(row.title, { nonempty: true }), status: row.status,
      assignee: text(row.assignee, { nullable: true, nonempty: true, max: 512 }),
      created_at: timestamp(row.created_at), started_at: timestamp(row.started_at),
      completed_at: timestamp(row.completed_at),
    };
  });
  uniqueIds(tasks);
  const taskCount = count(input.task_count);
  assert(taskCount === tasks.length);
  const actual = Object.fromEntries(TASK_STATES.map((state) => [state, 0]));
  for (const task of tasks) actual[task.status] += 1;
  assert(TASK_STATES.every((state) => counts[state] === actual[state]));
  const currentResident = resident(input.resident);
  assert(currentResident.running_board_count === outerResident.running_board_count);
  assert(currentResident.running_board_count === null || currentResident.running_board_count === counts.running);
  return {
    scope: { board: 'default', include_archived: false }, counts, task_count: taskCount,
    archived_total: null, tasks, resident: currentResident,
  };
}

function jobsData(value, expectedProfile) {
  const input = record(value);
  assert(input.profile === expectedProfile);
  const jobs = array(input.jobs).map((value) => {
    const row = record(value);
    assert(row.profile === expectedProfile);
    return {
      id: text(row.id, { nonempty: true, max: 512 }), profile: expectedProfile,
      enabled: bool(row.enabled), schedule_display: text(row.schedule_display, { nullable: true }),
      last_run_at: timestamp(row.last_run_at), next_run_at: timestamp(row.next_run_at),
      last_status: text(row.last_status, { nullable: true }),
      error: { present: bool(record(row.error).present) },
    };
  });
  uniqueIds(jobs);
  const jobCount = count(input.count);
  assert(jobCount === jobs.length);
  const sourceRegistry = record(input.registry);
  const registry = Object.fromEntries(PROFILES.map((profile) => [profile, count(sourceRegistry[profile], true)]));
  assert(registry[expectedProfile] === null || registry[expectedProfile] === jobCount);
  return { profile: expectedProfile, count: jobCount, jobs, registry };
}

function resultsData(value) {
  const input = record(value), run = record(input.run);
  assert(input.profile === 'rodi' && run.profile === 'rodi');
  assert(input.attachments_status === 'unavailable' && array(input.attachments).length === 0);
  return {
    profile: 'rodi', task_status: text(input.task_status, { nullable: true }),
    latest_summary: text(input.latest_summary, { nullable: true }),
    run: {
      profile: 'rodi', status: text(run.status, { nullable: true }),
      summary: text(run.summary, { nullable: true }),
      started_at: timestamp(run.started_at), completed_at: timestamp(run.completed_at),
    },
    attachments: [], attachments_status: 'unavailable',
  };
}

function envelopeMeta(input) {
  assert(input.source === 'dashboard');
  assert(['ok', 'stale', 'error', 'unsupported'].includes(input.status));
  return {
    source: 'dashboard', status: input.status, observed_at: timestamp(input.observed_at, false),
    last_success_at: timestamp(input.last_success_at), expires_at: timestamp(input.expires_at),
    stale: bool(input.stale), error: text(input.error, { nullable: true }),
  };
}

function statusResource(value) {
  const input = record(value);
  assert(input.source === 'dashboard' && ['unknown', 'ok', 'stale', 'error'].includes(input.status));
  return {
    source: 'dashboard', status: input.status,
    observed_at: timestamp(input.observed_at), last_success_at: timestamp(input.last_success_at),
    expires_at: timestamp(input.expires_at), stale: input.stale === null ? null : bool(input.stale),
    last_attempt_at: timestamp(input.last_attempt_at), last_error: text(input.last_error, { nullable: true }),
  };
}

function statusResponse(input) {
  const controller = record(input.controller), resources = record(input.resources);
  assert(controller.reachable === true && controller.status === 'ok');
  const upstream = text(controller.upstream, { nonempty: true, max: 100 });
  const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(upstream);
  assert(match && Number(match[1]) > 0 && Number(match[1]) <= 65535);
  return {
    controller: {
      reachable: true, status: 'ok', upstream,
      instance_id: text(controller.instance_id, { nonempty: true, max: 512 }),
    },
    resident: resident(input.resident),
    resources: Object.fromEntries(RESOURCE_KEYS.map((key) => [key, statusResource(resources[key])])),
  };
}

function validateHistoricalTimes(resourceKey, data, observedAt) {
  const observedMs = Date.parse(observedAt);
  let values;
  if (resourceKey === 'board') {
    values = data.tasks.flatMap((task) => [task.created_at, task.started_at, task.completed_at]);
  } else if (resourceKey.startsWith('jobs:')) {
    // next_run_at is a prediction and is expected to be in the future.
    values = data.jobs.map((job) => job.last_run_at);
  } else values = [data.run.started_at, data.run.completed_at];
  assert(values.every((value) => value === null || Date.parse(value) <= observedMs));
}

/** Return a detached allowlisted controller response, or null on invalid input.
 * Boundary errors remain errors, including a JSON unauthorized body (HTTP 401).
 * This function does not infer provenance or rewrite timestamps for demo data.
 */
export function decodeOwnerResource(resourceKey, payload) {
  try {
    assert(Object.hasOwn(OWNER_RESOURCE_PATHS, resourceKey));
    const input = record(payload);
    if (Object.keys(input).length === 1 && BOUNDARY_ERRORS.has(input.error)) return { error: input.error };
    if (resourceKey === 'status' && input.controller !== undefined) return statusResponse(input);
    const result = envelopeMeta(input);
    if (result.status === 'unsupported') {
      assert(result.last_success_at === null && result.expires_at === null && result.stale === false);
      assert(typeof result.error === 'string' && input.data === null && input.files === null);
      return { ...result, data: null, files: null };
    }
    if (input.data === null) {
      assert(result.status === 'error' && result.last_success_at === null && result.expires_at === null);
      assert(result.stale === true && typeof result.error === 'string');
      return { ...result, data: null };
    }
    assert(resourceKey !== 'status');
    if (resourceKey === 'board') {
      result.resident = resident(input.resident);
      result.data = boardData(input.data, result.resident);
    } else if (resourceKey.startsWith('jobs:')) {
      result.data = jobsData(input.data, resourceKey.slice(5));
    } else result.data = resultsData(input.data);
    validateHistoricalTimes(resourceKey, result.data, result.observed_at);
    return result;
  } catch (_) {
    return null;
  }
}

function view(state, reason, input = null) {
  return {
    state, usable: state === 'ok', data: ['ok', 'stale'].includes(state) ? (input?.data ?? null) : null,
    reason, observedAt: input?.observed_at ?? null,
    lastSuccessAt: input?.last_success_at ?? null, expiresAt: input?.expires_at ?? null,
  };
}

/** Evaluate decoded data against the current clock. Valid cached data remains
 * available with state=stale and usable=false; it is never a current success.
 * For local failures pass {transportFailure:true,error} (no implicit cache).
 * Status response connectivity is separate from each resource's freshness; its
 * top-level state describes the least-ready resource, not the agent's activity.
 */
export function ownerResourceView(resource, now = Date.now()) {
  if (!resource) return view('unknown', 'not_observed');
  if (resource.transportFailure === true) {
    return view('transport-error', typeof resource.error === 'string' ? resource.error.slice(0, 200) : 'transport_failure');
  }
  if (!Number.isFinite(now)) return view('unknown', 'invalid_clock');
  if (resource.controller && resource.resources) {
    const resources = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, ownerResourceView(resource.resources[key], now)]));
    const states = Object.values(resources).map((item) => item.state);
    const state = ['error', 'unknown', 'stale'].find((candidate) => states.includes(candidate)) || 'ok';
    return { ...view(state, state === 'ok' ? null : 'resource_not_current'), controllerReachable: true, resources, data: resource };
  }
  if (BOUNDARY_ERRORS.has(resource.error) && !resource.source) return view('error', resource.error);
  const input = resource;
  let observed, succeeded, expires, attempt;
  try {
    assert(input.source === 'dashboard');
    observed = timestamp(input.observed_at);
    succeeded = timestamp(input.last_success_at);
    expires = timestamp(input.expires_at);
    attempt = input.last_attempt_at === undefined ? null : timestamp(input.last_attempt_at);
  } catch (_) { return view('unknown', 'invalid_timestamps'); }
  if ([observed, succeeded, attempt].some((value) => value !== null && Date.parse(value) > now)) {
    return view('unknown', 'future_timestamp', input);
  }
  if (input.status === 'unsupported') return view('unsupported', input.error, input);
  if (input.status === 'error' && (input.data == null || BOUNDARY_ERRORS.has(input.error))) {
    return view('error', input.error ?? input.last_error ?? 'upstream_error', input);
  }
  if (input.status === 'unknown') return view('unknown', 'not_observed', input);
  if (!observed || !succeeded || !expires) return view('unknown', 'missing_freshness', input);
  const observedMs = Date.parse(observed), successMs = Date.parse(succeeded), expiryMs = Date.parse(expires);
  if (successMs > observedMs || expiryMs <= successMs) return view('unknown', 'invalid_timestamps', input);
  // The schema permits a failed refresh to carry its last validated data. Keep
  // that cache visibly expired; authorization/boundary errors above never do.
  if (input.status === 'error') return view('stale', input.error ?? 'upstream_error', input);
  if (input.status === 'stale' || input.stale === true) return view('stale', 'source_stale', input);
  // Never extend the server deadline. Cap unusually long TTLs at the contract's
  // 15 seconds, measured from actual upstream success, not a retry observation.
  if (now >= Math.min(expiryMs, successMs + OWNER_FRESHNESS_MS)) return view('stale', 'expired', input);
  if (input.status !== 'ok' || input.stale !== false || (input.error ?? input.last_error) != null) {
    return view('unknown', 'inconsistent_status', input);
  }
  return view('ok', null, input);
}
