export const AGENT_SIGNATURES = Object.freeze({
  'companion-conductor': Object.freeze({
    id: 'harmonic-fork',
    label: '북극성 공명 지휘탑',
    motion: 'pulse',
  }),
  'clockwork-steward': Object.freeze({
    id: 'chronicle-dial',
    label: '시간기록 문장',
    motion: 'clock',
  }),
  'resonance-listener': Object.freeze({
    id: 'resonance-fork',
    label: '금선 공명 청취탑',
    motion: 'scan',
  }),
  'moonlight-scholar': Object.freeze({
    id: 'crescent-archive',
    label: '달빛 검증 서가',
    motion: 'breathe',
  }),
  'forest-atelier': Object.freeze({
    id: 'flower-atelier',
    label: '향기 아틀리에 표식',
    motion: 'turn',
  }),
  'star-warden-observer': Object.freeze({
    id: 'owl-observatory',
    label: '별지기 올빼미 관측대',
    motion: 'observe',
  }),
});

export function signatureForAgent(agent) {
  const style = typeof agent?.visual?.style === 'string' ? agent.visual.style : '';
  return AGENT_SIGNATURES[style] || null;
}

export function auditSignatureRoster(agents, expectedCount = 6) {
  const roster = Array.isArray(agents) ? agents : [];
  const gaps = [];
  const signatures = [];
  const fields = ['silhouette', 'tool', 'motif'];

  if (roster.length !== expectedCount) gaps.push(`에이전트 수 ${roster.length}/${expectedCount}`);
  for (const agent of roster) {
    const key = typeof agent?.key === 'string' && agent.key ? agent.key : 'unknown';
    const signature = signatureForAgent(agent);
    if (!signature) gaps.push(`${key}: 시그니처 스타일 미등록`);
    else signatures.push(signature.id);
    for (const field of fields) {
      if (!agent?.visual?.[field]) gaps.push(`${key}: visual.${field} 누락`);
    }
    if (!agent?.resultSpace?.name) gaps.push(`${key}: 결과 공간 이름 누락`);
  }

  const duplicateSignatures = signatures.filter((value, index) => signatures.indexOf(value) !== index);
  if (duplicateSignatures.length) gaps.push('중복 시그니처 에셋');
  for (const field of fields) {
    const values = roster.map((agent) => agent?.visual?.[field]).filter(Boolean);
    if (new Set(values).size !== values.length) gaps.push(`중복 visual.${field}`);
  }

  const score = Math.max(0, 100 - gaps.length * 12);
  return {
    status: gaps.length ? 'review' : 'ready',
    score,
    gaps,
    covered: signatures.length,
    expected: expectedCount,
  };
}
