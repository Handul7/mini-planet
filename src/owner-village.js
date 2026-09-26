// Board observations are not proof that a resident is online or idle.
export function projectOwnerVillage(snapshot, residentKeys, { hidden = false } = {}) {
  const visibleSession = !hidden && snapshot?.authenticated === true;
  const board = visibleSession ? snapshot.resources?.board : null;
  const current = board?.usable === true && board.state === 'ok' && Array.isArray(board.data?.tasks);
  const state = !visibleSession ? 'locked' : current ? 'current' : board?.state === 'unknown' ? 'waiting' : 'unavailable';
  const residents = Object.fromEntries(residentKeys.map((key) => {
    if (!current) return [key, { label: visibleSession ? '보드 미확인' : '로그인 후 확인', detail: '', needsAttention: false }];
    const tasks = board.data.tasks.filter((task) => task.assignee === key);
    const count = (status) => tasks.filter((task) => task.status === status).length;
    const running = count('running'), blocked = count('blocked'), review = count('review');
    return [key, {
      label: `보드 진행 ${running} · 확인 ${blocked + review}`,
      detail: `보드에 기록된 진행 ${running}건 · 막힘 ${blocked}건 · 검토 ${review}건. 주민의 전체 활동은 미확인입니다.`,
      needsAttention: blocked + review > 0,
    }];
  }));
  return { state, residents, lastSuccessAt: visibleSession ? board?.lastSuccessAt ?? null : null };
}
