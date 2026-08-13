const ACTIVE_STATE = /작업|진행|실행|검증|리뷰|승인\s*대기|running|active|verifying/i;
const QUIET_STATE = /대기|휴식|완료|오프라인|상태\s*미확인|idle|waiting|complete|offline|unknown/i;

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim()))];
}

function normalizeHealth(value) {
  const health = typeof value === 'string' ? value.toLowerCase() : '';
  return ['healthy', 'degraded', 'error', 'offline', 'unknown'].includes(health)
    ? health
    : 'unknown';
}

/**
 * Build one conservative fleet view for the 3D beacon, compact HUD, and team
 * panel. A missing or expired live record never inherits a cheerful default.
 */
export function summarizeFleet({
  agents = [],
  reportedAgentKeys = [],
  publicationMode = 'static-demo',
  connectionState = 'loading',
  isStale = false,
  approvalCount = 0,
} = {}) {
  const reported = new Set(uniqueStrings(reportedAgentKeys));
  const live = publicationMode === 'live';
  const rows = (Array.isArray(agents) ? agents : []).map((agent) => {
    const key = typeof agent?.key === 'string' ? agent.key : '';
    const state = typeof agent?.state === 'string' ? agent.state : '';
    const task = typeof agent?.task === 'string' ? agent.task : '';
    const health = normalizeHealth(agent?.health);
    const wasReported = reported.has(key);
    const missing = live && !wasReported;
    let linkState = 'ready';
    if (!live) linkState = 'demo';
    else if (isStale) linkState = 'stale';
    else if (missing) linkState = 'missing';
    else if (health === 'error') linkState = 'error';
    else if (health === 'offline') linkState = 'offline';
    else if (health === 'degraded' || health === 'unknown') linkState = 'degraded';
    else linkState = 'online';
    const active = !missing && !isStale && ACTIVE_STATE.test(state) && !QUIET_STATE.test(state);
    return {
      key,
      name: agent?.name || key,
      kor: agent?.kor || agent?.name || key,
      role: agent?.role || '',
      color: agent?.color || null,
      state: state || (missing ? '상태 누락' : '상태 미확인'),
      task,
      updatedAt: agent?.updatedAt || null,
      health,
      reported: wasReported,
      missing,
      active,
      linkState,
    };
  });

  const expected = rows.length;
  const linked = live
    ? rows.filter((row) => row.reported && !['missing', 'stale', 'offline'].includes(row.linkState)).length
    : expected;
  const missing = rows.filter((row) => row.missing).map((row) => row.key);
  const active = rows.filter((row) => row.active).length;

  let state = 'healthy';
  if (!live) state = 'demo';
  else if (isStale) state = 'stale';
  else if (connectionState === 'offline') state = 'offline';
  else if (missing.length) state = 'incomplete';
  else if (rows.some((row) => row.linkState === 'error')) state = 'error';
  else if (rows.some((row) => row.linkState === 'degraded')) state = 'degraded';
  else if (connectionState === 'loading') state = 'loading';

  const stateLabel = ({
    demo: 'DEMO', healthy: 'ONLINE', loading: 'CONNECT', stale: 'STALE',
    offline: 'OFFLINE', incomplete: 'PARTIAL', error: 'ERROR', degraded: 'CHECK',
  })[state] || 'CHECK';

  return {
    expected,
    linked,
    active,
    approvalCount: Math.max(0, Number(approvalCount) || 0),
    missing,
    rows,
    state,
    stateLabel,
    coverageLabel: live ? `${linked}/${expected}` : `${expected}/${expected}`,
  };
}

function normalizedVector(value) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((part) => !Number.isFinite(part))) return null;
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length < 0.5 || length > 2) return null;
  return value.map((part) => part / length);
}

function surfaceDistance(a, b, planetRadius) {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot) * planetRadius;
}

const HOME_VIEW_CLEARANCE = 3.5;
const HOME_APPROACH_CLEARANCE = 0.42;

function interpolateDirection(a, b, t) {
  const out = [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const length = Math.hypot(out[0], out[1], out[2]);
  return length > 0 ? out.map((part) => part / length) : a;
}

/**
 * Audit release-critical layout invariants without depending on Three.js.
 * Entries are point props shaped as
 * { type, ownerKey, n:[x,y,z], radius, doorN?, approachN? }.
 * `radius` is an angular radius, matching the runtime's spherical colliders.
 */
export function auditLayout({
  entries = [],
  expectedOwners = [],
  requiredTypes = ['opsBeacon'],
  planetRadius = 7.47,
  maxEntries = 400,
} = {}) {
  const points = (Array.isArray(entries) ? entries : []).slice(0, maxEntries).map((entry, index) => ({
    index,
    type: typeof entry?.type === 'string' ? entry.type : '',
    ownerKey: typeof entry?.ownerKey === 'string' ? entry.ownerKey : '',
    n: normalizedVector(entry?.n),
    radius: Number.isFinite(entry?.radius) ? Math.max(0, entry.radius) : 0,
    doorN: normalizedVector(entry?.doorN),
    approachN: normalizedVector(entry?.approachN),
  }));
  const errors = [];
  const warnings = [];
  const owners = uniqueStrings(expectedOwners);
  const ownerCounts = new Map();
  for (const point of points) {
    if (point.ownerKey) ownerCounts.set(point.ownerKey, (ownerCounts.get(point.ownerKey) || 0) + 1);
  }
  const missingOwners = owners.filter((owner) => !ownerCounts.has(owner));
  const duplicateOwners = owners.filter((owner) => (ownerCounts.get(owner) || 0) > 1);
  const unknownOwners = [...ownerCounts.keys()].filter((owner) => !owners.includes(owner));
  if (missingOwners.length) errors.push(`담당 집 누락: ${missingOwners.join(', ')}`);
  if (duplicateOwners.length) errors.push(`담당 집 중복: ${duplicateOwners.join(', ')}`);
  if (unknownOwners.length) warnings.push(`알 수 없는 집 소유자: ${unknownOwners.join(', ')}`);

  for (const type of uniqueStrings(requiredTypes)) {
    const count = points.filter((point) => point.type === type).length;
    if (count === 0) errors.push(`필수 오브젝트 누락: ${type}`);
    else if (count > 1) warnings.push(`필수 오브젝트 중복: ${type} ${count}개`);
  }

  const overlaps = [];
  const collidable = points.filter((point) => point.n && point.radius > 0);
  for (let i = 0; i < collidable.length; i++) {
    for (let j = i + 1; j < collidable.length; j++) {
      const a = collidable[i];
      const b = collidable[j];
      const required = Math.max(0.12, (a.radius + b.radius) * planetRadius * 0.72);
      const distance = surfaceDistance(a.n, b.n, planetRadius);
      if (distance >= required) continue;
      overlaps.push({ a: a.index, b: b.index, aType: a.type, bType: b.type, distance, required });
    }
  }
  if (overlaps.length) warnings.push(`이동 충돌 가능 배치: ${overlaps.length}쌍`);
  const homeClearance = [];
  const homes = points.filter((point) => point.n && point.ownerKey);
  for (let i = 0; i < homes.length; i++) {
    for (let j = i + 1; j < homes.length; j++) {
      const distance = surfaceDistance(homes[i].n, homes[j].n, planetRadius);
      if (distance >= HOME_VIEW_CLEARANCE) continue;
      homeClearance.push({
        a: homes[i].ownerKey,
        b: homes[j].ownerKey,
        distance,
        required: HOME_VIEW_CLEARANCE,
      });
    }
  }
  if (homeClearance.length) warnings.push(`집 사이 시야 여백 부족: ${homeClearance.length}쌍`);
  const doorObstructions = [];
  for (const home of homes) {
    if (!home.doorN || !home.approachN) continue;
    const samples = [0, 0.34, 0.67, 1].map((t) => interpolateDirection(home.doorN, home.approachN, t));
    for (const obstacle of collidable) {
      if (obstacle.index === home.index) continue;
      const required = obstacle.radius * planetRadius + HOME_APPROACH_CLEARANCE;
      const distance = Math.min(...samples.map((sample) => surfaceDistance(sample, obstacle.n, planetRadius)));
      if (distance >= required) continue;
      doorObstructions.push({
        owner: home.ownerKey,
        obstacle: obstacle.index,
        obstacleType: obstacle.type,
        distance,
        required,
      });
    }
  }
  if (doorObstructions.length) warnings.push(`집 진입로 방해 오브젝트: ${doorObstructions.length}개`);
  if ((Array.isArray(entries) ? entries.length : 0) > maxEntries) errors.push(`오브젝트 제한 초과: ${entries.length}/${maxEntries}`);

  const score = Math.max(0, 100 - errors.length * 24 - warnings.length * 7
    - Math.min(20, overlaps.length * 2) - Math.min(12, homeClearance.length * 3)
    - Math.min(15, doorObstructions.length * 3));
  const status = errors.length ? 'blocked' : warnings.length ? 'review' : 'ready';
  return {
    status,
    score,
    errors,
    warnings,
    overlaps,
    homeClearance,
    doorObstructions,
    missingOwners,
    duplicateOwners,
    objectCount: points.length,
  };
}
