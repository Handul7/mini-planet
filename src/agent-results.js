const MAX_AGENT_RESULTS = 6;

const KIND_META = {
  briefing: { label: '브리핑', icon: '✦' },
  decision: { label: '결정', icon: '⌁' },
  operations: { label: '운영', icon: '◷' },
  build: { label: '구현', icon: '◇' },
  verification: { label: '검증', icon: '✓' },
  content: { label: '콘텐츠', icon: '✿' },
  research: { label: '조사', icon: '◉' },
  report: { label: '보고서', icon: '▤' },
  commit: { label: '커밋', icon: '⌘' },
  image: { label: '이미지', icon: '▧' },
  link: { label: '링크', icon: '↗' },
  artifact: { label: '결과', icon: '◆' },
};

const STATUS_LABELS = {
  ready: '완료',
  review: '검토 중',
  draft: '초안',
  live: '운영 중',
};

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}

function cleanText(value, max) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : '';
}

/**
 * Accept only the small, public artifact projection used by the browser.
 * Raw prompts, logs, local paths, and provider payloads never cross this edge.
 */
export function normalizePublicResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = cleanText(value.title, 80);
  if (!title) return null;
  const kind = cleanText(value.kind, 24).toLowerCase();
  const status = cleanText(value.status, 16).toLowerCase();
  return {
    id: cleanText(value.id, 120),
    title,
    summary: cleanText(value.summary, 180),
    url: cleanText(value.url, 500),
    kind: KIND_META[kind] ? kind : 'artifact',
    status: STATUS_LABELS[status] ? status : 'ready',
    updatedAt: cleanText(value.updatedAt ?? value.updated_at, 40),
  };
}

export function normalizePublicResults(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizePublicResult).filter(Boolean).slice(0, MAX_AGENT_RESULTS);
}

export function mergePublicResults(...collections) {
  const merged = [];
  const seen = new Set();
  for (const collection of collections) {
    const values = Array.isArray(collection) ? collection : collection ? [collection] : [];
    for (const value of values) {
      const result = normalizePublicResult(value);
      if (!result) continue;
      const fingerprint = result.id || `${result.title}\n${result.updatedAt || ''}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      merged.push(result);
    }
  }
  // Source order is authoritative: callers put the current singleton first,
  // then live newest-first history and curated fallback fill remaining slots.
  return merged.slice(0, MAX_AGENT_RESULTS);
}

export function publicResultUrl(value, baseHref = '') {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const fallback = baseHref || (typeof location !== 'undefined' ? location.href : undefined);
    const url = new URL(value.trim(), fallback);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const base = fallback ? new URL(fallback) : null;
    if (isPrivateHostname(url.hostname) && base && !isPrivateHostname(base.hostname)) return null;
    return url.href;
  } catch (_) {
    return null;
  }
}

export function resultKindMeta(kind) {
  return KIND_META[kind] || KIND_META.artifact;
}

export function resultStatusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.ready;
}

export function formatResultDate(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: 'short', day: 'numeric',
  }).format(parsed);
}

export { MAX_AGENT_RESULTS };
