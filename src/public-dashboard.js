const TASK_STATUSES = [
  'queued', 'running', 'blocked', 'waiting_approval',
  'verifying', 'completed', 'failed', 'cancelled',
];
const APPROVAL_STATES = ['not_required', 'pending', 'approved', 'rejected'];
const HEALTH_STATES = ['healthy', 'degraded', 'error', 'offline', 'unknown'];
const VERIFICATION_STATES = ['unverified', 'pending', 'verified', 'failed', 'not_applicable'];
const PUBLICATION_MODES = ['static-demo', 'live'];
const LIVE_AGENT_STATE_MAP = {
  idle: '대기 중',
  queued: '대기 중',
  working: '작업 중',
  running: '작업 중',
  review: '검증 중',
  verifying: '검증 중',
  blocked: '차단됨',
  completed: '완료',
  failed: '오류',
  error: '오류',
  offline: '오프라인',
  unknown: '상태 미확인',
};
const LIVE_AGENT_STATES = new Set(Object.values(LIVE_AGENT_STATE_MAP));

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function isPublicRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function cleanPublicText(value, max) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

function normalizeEnum(value, allowed) {
  const normalized = cleanPublicText(value, 32)?.toLowerCase() || null;
  return normalized && allowed.includes(normalized) ? normalized : null;
}

function normalizeTimestamp(value) {
  const text = cleanPublicText(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function normalizeRiskLevel(value) {
  const risk = cleanPublicText(value, 2)?.toUpperCase() || null;
  return ['L1', 'L2', 'L3', 'L4'].includes(risk) ? risk : null;
}

function normalizeAgentKey(value, allowedAgents) {
  const key = cleanPublicText(value, 40);
  return key && allowedAgents.has(key) ? key : null;
}

function normalizePublicId(value) {
  const id = cleanPublicText(value, 120);
  return id && /^[a-z0-9][a-z0-9._:-]*$/i.test(id) ? id : null;
}

function normalizeAgentState(value, live) {
  const state = cleanPublicText(value, 16);
  if (!state || !live) return state;
  return LIVE_AGENT_STATE_MAP[state.toLowerCase()] || (LIVE_AGENT_STATES.has(state) ? state : null);
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizePublicId).filter(Boolean).slice(0, 20);
}

export function normalizePublicTask(value, allowedAgentKeys = [], { allowLegacyFields = false } = {}) {
  if (!isPublicRecord(value)) return null;
  const allowedAgents = new Set(allowedAgentKeys);
  const title = cleanPublicText(
    value.publicTitle ?? (allowLegacyFields ? value.title : null),
    100,
  );
  if (!title) return null;
  return {
    id: normalizePublicId(value.publicId ?? (allowLegacyFields ? value.id : null)) || '',
    title,
    ownerAgent: normalizeAgentKey(value.ownerAgent, allowedAgents),
    requester: normalizeAgentKey(value.requesterAgent ?? value.requester, allowedAgents),
    status: normalizeEnum(value.status, TASK_STATUSES) || 'queued',
    parentIds: normalizeIdList(value.publicParentIds ?? (allowLegacyFields ? value.parentIds ?? value.parents : null)),
    dependencyIds: normalizeIdList(value.publicDependencyIds ?? (allowLegacyFields ? value.dependencyIds ?? value.dependencies : null)),
    riskLevel: normalizeRiskLevel(value.riskLevel),
    approvalState: normalizeEnum(value.approvalState, APPROVAL_STATES),
    verifier: normalizeAgentKey(value.verifierAgent ?? value.verifier, allowedAgents),
    progress: Number.isFinite(value.progress) ? clamp(value.progress, 0, 1) : null,
    updatedAt: normalizeTimestamp(value.updatedAt),
    verificationState: normalizeEnum(value.verificationState, VERIFICATION_STATES),
    verifiedAt: normalizeTimestamp(value.verifiedAt),
    evidenceDigest: cleanPublicText(value.evidenceDigest, 128),
  };
}

export function normalizePublicApproval(value, allowedAgentKeys = [], { allowLegacyFields = false } = {}) {
  if (!isPublicRecord(value)) return null;
  const allowedAgents = new Set(allowedAgentKeys);
  const actionSummary = cleanPublicText(
    value.publicActionSummary ?? (allowLegacyFields ? value.actionSummary ?? value.action_summary : null),
    140,
  );
  if (!actionSummary) return null;
  return {
    id: normalizePublicId(value.publicId ?? (allowLegacyFields ? value.id : null)) || '',
    taskId: normalizePublicId(value.publicTaskId ?? (allowLegacyFields ? value.taskId ?? value.task_id : null)),
    requestedBy: normalizeAgentKey(value.requestedByAgent ?? value.requestedBy, allowedAgents),
    riskLevel: normalizeRiskLevel(value.riskLevel) || 'L4',
    status: normalizeEnum(value.status, ['pending', 'approved', 'rejected', 'cancelled']) || 'pending',
    actionSummary,
    impactSummary: cleanPublicText(
      value.publicImpactSummary ?? (allowLegacyFields ? value.impactSummary ?? value.impact_summary : null),
      180,
    ),
    rollbackSummary: cleanPublicText(
      value.publicRollbackSummary ?? (allowLegacyFields ? value.rollbackSummary ?? value.rollback_summary : null),
      180,
    ),
    requestedAt: normalizeTimestamp(value.requestedAt),
  };
}

export function evaluateSnapshotFreshness(meta = {}, {
  now = Date.now(),
  ttlMs = 180000,
  maxFutureSkewMs = 300000,
} = {}) {
  const publicationMode = normalizeEnum(meta.publicationMode, PUBLICATION_MODES)
    || (meta.source === 'curated-static' ? 'static-demo' : 'live');
  const sourceGeneratedAt = normalizeTimestamp(meta.sourceGeneratedAt ?? meta.generatedAt);
  const bridgeObservedAt = normalizeTimestamp(meta.bridgeObservedAt);
  const expiresAt = normalizeTimestamp(meta.expiresAt);

  if (publicationMode === 'static-demo') {
    return {
      state: 'static',
      isStale: false,
      reason: 'static-demo',
      sourceGeneratedAt,
      bridgeObservedAt: null,
      expiresAt: null,
    };
  }

  let reason = '';
  const sourceTime = sourceGeneratedAt ? Date.parse(sourceGeneratedAt) : NaN;
  const observedTime = bridgeObservedAt ? Date.parse(bridgeObservedAt) : NaN;
  const expiryTime = expiresAt ? Date.parse(expiresAt) : NaN;
  if (meta.isStale === true) reason = 'source-marked-stale';
  else if (!sourceGeneratedAt || !bridgeObservedAt || !expiresAt || typeof meta.isStale !== 'boolean') reason = 'missing-freshness-metadata';
  else if (sourceTime > now + maxFutureSkewMs || observedTime > now + maxFutureSkewMs) reason = 'future-timestamp';
  else if (expiryTime <= now) reason = 'expired';
  else if (now - sourceTime > ttlMs || now - observedTime > ttlMs) reason = 'ttl-exceeded';

  return {
    state: reason ? 'stale' : 'fresh',
    isStale: !!reason,
    reason,
    sourceGeneratedAt,
    bridgeObservedAt,
    expiresAt,
  };
}

export function normalizePublicDashboardView(meta = {}, allowedAgentKeys = [], freshnessOptions = {}) {
  const team = isPublicRecord(meta.team) ? meta.team : {};
  const runtime = isPublicRecord(meta.runtime) ? meta.runtime : {};
  const schemaVersion = Number.isInteger(meta.schemaVersion) ? meta.schemaVersion : 0;
  const publicationMode = normalizeEnum(meta.publicationMode, PUBLICATION_MODES)
    || (meta.source === 'curated-static' ? 'static-demo' : 'live');
  const allowLegacyFields = publicationMode === 'static-demo';
  let freshness = evaluateSnapshotFreshness({ ...meta, publicationMode }, freshnessOptions);
  if (publicationMode === 'live' && schemaVersion !== 2) {
    freshness = { ...freshness, state: 'stale', isStale: true, reason: 'unsupported-live-schema' };
  }
  return {
    schemaVersion,
    publicationMode,
    generatedAt: freshness.sourceGeneratedAt,
    sourceGeneratedAt: freshness.sourceGeneratedAt,
    bridgeObservedAt: freshness.bridgeObservedAt,
    expiresAt: freshness.expiresAt,
    isStale: freshness.isStale,
    freshness,
    source: cleanPublicText(meta.source, 40) || (schemaVersion > 0 ? 'bridge' : 'legacy'),
    verificationState: normalizeEnum(meta.provenance?.verificationState, VERIFICATION_STATES),
    evidenceDigest: cleanPublicText(meta.provenance?.evidenceDigest, 128),
    teamHealth: normalizeEnum(team.health ?? runtime.health, HEALTH_STATES),
    tasks: (Array.isArray(meta.tasks) ? meta.tasks : [])
      .map((task) => normalizePublicTask(task, allowedAgentKeys, { allowLegacyFields }))
      .filter(Boolean)
      .slice(0, 24),
    approvals: (Array.isArray(meta.approvals) ? meta.approvals : [])
      .map((approval) => normalizePublicApproval(approval, allowedAgentKeys, { allowLegacyFields }))
      .filter(Boolean)
      .slice(0, 16),
  };
}

export function normalizePublicAgentStatus(value, { publicationMode = 'static-demo' } = {}) {
  if (!isPublicRecord(value)) return null;
  const runtime = isPublicRecord(value.runtime) ? value.runtime : value;
  const live = publicationMode === 'live';
  return {
    state: normalizeAgentState(value.state, live),
    task: cleanPublicText(value.publicTask ?? (!live ? value.task : null), 80),
    updatedAt: normalizeTimestamp(value.updatedAt),
    progress: Number.isFinite(value.progress) ? clamp(value.progress, 0, 1) : null,
    publicTaskId: normalizePublicId(runtime.publicTaskId ?? (!live ? runtime.currentTaskId : null)),
    health: normalizeEnum(runtime.health, HEALTH_STATES),
    model: cleanPublicText(runtime.modelFamily ?? (!live ? runtime.model : null), 80),
    provider: cleanPublicText(runtime.providerAlias ?? (!live ? runtime.provider : null), 40),
    blocker: cleanPublicText(runtime.publicBlocker ?? (!live ? runtime.blocker : null), 160),
    approvalState: normalizeEnum(runtime.approvalState, APPROVAL_STATES),
    riskLevel: normalizeRiskLevel(runtime.riskLevel),
    lastActivityAt: normalizeTimestamp(runtime.lastActivityAt) || normalizeTimestamp(value.updatedAt),
    verificationState: normalizeEnum(runtime.verificationState, VERIFICATION_STATES),
    verifiedAt: normalizeTimestamp(runtime.verifiedAt),
    evidenceDigest: cleanPublicText(runtime.evidenceDigest, 128),
  };
}

export function selectPublicResultProjection(value, { publicationMode = 'static-demo' } = {}) {
  if (!isPublicRecord(value)) return { result: null, results: [] };
  const live = publicationMode === 'live';
  const result = live ? value.publicResult : (value.publicResult ?? value.result);
  const results = live ? value.publicResults : (value.publicResults ?? value.results);
  return {
    result: isPublicRecord(result) ? result : null,
    results: Array.isArray(results) ? results : [],
  };
}
