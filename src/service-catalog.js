const STATUS = {
  public: '공개 웹', current: '현재 서비스', source: '소스 공개',
  prototype: '프로토타입', private: '개인 연결', planned: '준비 중',
};
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

// Public entries use named HTTPS hosts. LAN/IP URLs require a local preview.
export function serviceUrl(value, { allowLocal = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const local = !host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host)
      || /\.(?:localhost|local|internal|lan|test)$/.test(host);
    if (local ? !allowLocal : url.protocol !== 'https:') return null;
    return url.href;
  } catch (_) { return null; }
}

export function serviceDetails(service = {}, options = {}) {
  const url = serviceUrl(service.url, options);
  const repository = serviceUrl(service.repository);
  const availability = Object.hasOwn(STATUS, service.availability) ? service.availability
    : url ? (serviceUrl(url) ? 'public' : 'private') : 'planned';
  const status = availability === 'public' && !url ? (repository ? 'source' : 'planned') : availability;
  return {
    url: status === 'current' ? null : url, repository, status, label: STATUS[status],
    features: Array.isArray(service.features)
      ? service.features.map(value => text(value, 100)).filter(Boolean).slice(0, 4) : [],
    checkedAt: /^\d{4}-\d{2}-\d{2}$/.test(service.checkedAt || '') ? service.checkedAt : '',
  };
}

export function renderServiceDetails({ features, repository, open, checked }, service, options = {}) {
  const details = serviceDetails(service, options);
  features.replaceChildren();
  features.hidden = details.features.length === 0;
  for (const feature of details.features) {
    const item = features.ownerDocument.createElement('li');
    item.textContent = feature;
    features.appendChild(item);
  }
  for (const [link, url] of [[repository, details.repository], [open, details.url]]) {
    link.hidden = !url;
    link.removeAttribute('href');
    if (url) link.setAttribute('href', url);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  checked.textContent = details.checkedAt ? `정보 확인 ${details.checkedAt} · GitHub 공개 자료 기준` : '';
  checked.hidden = !details.checkedAt;
  return details;
}
