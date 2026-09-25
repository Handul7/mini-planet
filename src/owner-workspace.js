import { createOwnerClient } from './owner-client.js';

const NAMES = { rodi: '로디', jarvis: '자비스', yul: '율', ludwig: '루드비히', anne: '앤', argos: '아르고스', default: '기본 프로필' };
const STATUS = { triage: '분류 전', todo: '할 일', scheduled: '예약됨', ready: '실행 대기', running: '진행 중', blocked: '막힘', review: '검토 중', done: '완료' };
const FRESHNESS = { unknown: '미확인', ok: '방금 확인', stale: '확인 만료', error: '조회 실패', 'transport-error': '연결 실패', unsupported: '조회 미지원' };
const SESSION_ERROR = {
  invalid_password: '비밀번호를 다시 확인해주세요.', too_many_attempts: '잠시 후 다시 로그인해주세요.',
  host_unavailable: '개인용 서버에 연결하지 못했습니다. 개인용 주소에서 다시 열어주세요.',
  session_expired: '로그인이 만료되었습니다. 다시 로그인해주세요.', logout_failed: '화면의 데이터는 지웠지만 서버 로그아웃을 확인하지 못했습니다. 연결을 확인한 뒤 다시 로그아웃해주세요.',
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(text, onClick, className = '') {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}
function date(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '미확인';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

export function initOwnerWorkspace({ onOpen = () => {}, preview = false } = {}) {
  let tab = 'board';
  let agent = '';
  let filter = '';
  let limit = 30;
  let open = false;
  let opener = null;
  let state = null;
  let loggingIn = false;
  let refreshing = false;
  let lastRenderedTab = '';

  const launch = button('✦ 개인 작업실', () => show({ tab: 'board', agent: '' }), 'owner-launch');
  launch.setAttribute('aria-haspopup', 'dialog');
  launch.setAttribute('aria-expanded', 'false');
  const panel = node('section', 'owner-workspace');
  panel.id = 'ownerWorkspace';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', 'ownerTitle');
  panel.hidden = true;
  panel.inert = true;

  const header = node('header', 'owner-header');
  const heading = node('div');
  heading.append(node('p', 'owner-kicker', 'MY MINI PLANET'));
  const title = node('h2', '', '나의 작업실');
  title.id = 'ownerTitle';
  heading.append(title);
  const close = button('×', () => hide(true), 'owner-close');
  close.setAttribute('aria-label', '개인 작업실 닫기');
  header.append(heading, node('span', 'owner-readonly', '읽기 전용'), close);
  const notice = node('p', 'owner-preview', '익명화 응답으로 확인하는 미리보기입니다. 맥미니에 연결된 화면이 아닙니다.');
  notice.hidden = !preview;
  const login = node('form', 'owner-login');
  const loginHeading = node('h3', '', '내 업무가 머무는 작은 공간');
  const loginText = node('p', '', '로그인하면 주민의 업무와 반복 일정, 로디의 실행 요약을 볼 수 있어요.');
  const label = node('label', '', '개인 작업실 비밀번호');
  label.htmlFor = 'ownerPassword';
  const password = node('input');
  password.id = 'ownerPassword';
  password.type = 'password';
  password.name = 'password';
  password.autocomplete = 'current-password';
  password.required = true;
  password.maxLength = 1024;
  const submit = node('button', 'owner-primary', '작업실 열기');
  submit.type = 'submit';
  const loginMessage = node('p', 'owner-login-message');
  loginMessage.setAttribute('role', 'status');
  const retryLogout = button('서버 로그아웃 다시 확인', () => client.logout(), 'owner-secondary');
  retryLogout.hidden = true;
  login.append(loginHeading, loginText, label, password, submit, loginMessage, retryLogout);

  const body = node('div', 'owner-body');
  const toolbar = node('div', 'owner-toolbar');
  const context = node('p', 'owner-context', '우리 마을의 업무 기록');
  const refresh = button('새로고침', () => reload(), 'owner-secondary');
  const logout = button('로그아웃', async () => { await client.logout(); password.focus(); }, 'owner-secondary');
  toolbar.append(context, refresh, logout);
  const tabs = node('div', 'owner-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '개인 업무 보기');
  const tabButtons = new Map();
  for (const [key, text] of [['board', '업무'], ['jobs', '반복 일정'], ['results', '로디 요약']]) {
    const element = button(text, () => { tab = key; render(); reload(); });
    element.id = `ownerTab-${key}`;
    element.setAttribute('role', 'tab');
    element.setAttribute('aria-controls', 'ownerContent');
    element.addEventListener('keydown', (event) => {
      const keys = [...tabButtons.keys()];
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = keys.indexOf(tab);
      tab = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(index + (event.key === 'ArrowRight' ? 1 : 2)) % keys.length];
      render(); tabButtons.get(tab).focus(); reload();
    });
    tabButtons.set(key, element); tabs.append(element);
  }
  const filters = node('div', 'owner-filters');
  const agentLabel = node('label', '', '담당 주민');
  const agentSelect = node('select');
  agentSelect.setAttribute('aria-label', '담당 주민');
  for (const [key, text] of [['', '모든 주민'], ...Object.entries(NAMES)]) {
    const option = node('option', '', text); option.value = key; agentSelect.append(option);
  }
  agentSelect.addEventListener('change', () => { agent = agentSelect.value; limit = 30; render(); });
  agentLabel.append(agentSelect);
  const statusLabel = node('label', '', '업무 상태');
  const statusSelect = node('select');
  statusSelect.setAttribute('aria-label', '업무 상태');
  for (const [key, text] of [['', '모든 상태'], ...Object.entries(STATUS)]) {
    const option = node('option', '', text); option.value = key; statusSelect.append(option);
  }
  statusSelect.addEventListener('change', () => { filter = statusSelect.value; limit = 30; render(); });
  statusLabel.append(statusSelect);
  filters.append(agentLabel, statusLabel);
  const content = node('section', 'owner-content');
  content.id = 'ownerContent';
  content.setAttribute('role', 'tabpanel');
  const footer = node('p', 'owner-footnote', '주민의 전체 활동은 아직 미확인입니다. 대화와 업무 변경은 다음 연결 단계에서 열립니다.');
  body.append(toolbar, tabs, filters, content, footer);
  panel.append(header, notice, login, body);
  document.body.append(launch, panel);

  const client = createOwnerClient({ onChange(next) { state = next; render(); } });
  state = client.snapshot();

  function freshness(key, container) {
    const row = node('div', 'owner-freshness');
    row.dataset.resource = key;
    row.append(node('span', 'owner-state'), node('span', 'owner-observed'));
    container.append(row);
  }
  function updateFreshness() {
    state = client.tick();
    for (const row of panel.querySelectorAll('[data-resource]')) {
      const view = state.resources[row.dataset.resource];
      row.dataset.state = view?.state || 'unknown';
      row.querySelector('.owner-state').textContent = view?.pending ? '확인 중' : FRESHNESS[view?.state] || '미확인';
      row.querySelector('.owner-observed').textContent = view?.lastSuccessAt ? `마지막 성공 ${date(view.lastSuccessAt)} · 한국 시간` : '아직 확인한 데이터가 없습니다';
    }
  }
  function empty(text, subtext) {
    const box = node('div', 'owner-empty');
    box.append(node('span', '', '◇'), node('h3', '', text));
    if (subtext) box.append(node('p', '', subtext));
    content.append(box);
  }
  function resourceWarning(view) {
    if (view.state === 'stale') content.append(node('p', 'owner-warning', '마지막으로 확인한 기록입니다. 새로고침으로 현재 상태를 확인해주세요.'));
    if (view.state === 'error' || view.state === 'transport-error') empty('기록을 확인하지 못했어요', '연결을 확인한 뒤 다시 새로고침해주세요.');
  }
  function renderBoard() {
    const view = state.resources.board;
    freshness('board', content);
    resourceWarning(view);
    if (!view.data) { if (!['error', 'transport-error'].includes(view.state)) empty('업무 기록을 확인하고 있어요', '조회하지 못한 업무는 0건으로 표시하지 않습니다.'); return; }
    const data = view.data;
    const metrics = node('div', 'owner-metrics');
    for (const [text, count] of [['진행 중', data.counts.running], ['막힘·검토', data.counts.blocked + data.counts.review], ['완료', data.counts.done]]) {
      const item = node('div'); item.append(node('strong', '', String(count)), node('span', '', text)); metrics.append(item);
    }
    content.append(metrics, node('p', 'owner-scope', `주 보드 · 보관 제외 ${data.task_count}건 · 보관된 업무 수는 미조회`));
    const tasks = data.tasks.filter((task) => (!agent || task.assignee === agent) && (!filter || task.status === filter));
    if (!tasks.length) { empty('이 조건에 맞는 업무가 없어요', '주민이나 상태 필터를 바꿔볼 수 있어요.'); return; }
    const list = node('div', 'owner-task-list');
    for (const task of tasks.slice(0, limit)) {
      const card = node('article', 'owner-task');
      const meta = node('div', 'owner-task-meta');
      const badge = node('span', `owner-task-status status-${task.status}`, STATUS[task.status]);
      meta.append(badge, node('span', '', NAMES[task.assignee] || task.assignee || '미배정'));
      card.append(meta, node('h3', '', task.title), node('p', 'owner-task-date', `${task.completed_at ? '완료' : task.started_at ? '시작' : '생성'} ${date(task.completed_at || task.started_at || task.created_at)}`));
      list.append(card);
    }
    content.append(list);
    if (tasks.length > limit) content.append(button(`업무 더 보기 · ${Math.min(limit, tasks.length)} / ${tasks.length}`, () => { limit += 30; render(); }, 'owner-more'));
  }
  function renderJobs() {
    content.append(node('p', 'owner-scope', '기본 프로필은 로디와 별개입니다. 아직 조회할 수 없는 주민의 일정은 미확인으로 남겨둡니다.'));
    for (const profile of ['rodi', 'jarvis', 'default']) {
      const view = state.resources[`jobs:${profile}`];
      const group = node('section', 'owner-job-group');
      group.append(node('h3', '', NAMES[profile]));
      freshness(`jobs:${profile}`, group);
      if (!view.data) group.append(node('p', 'owner-muted', view.state === 'error' ? '일정을 조회하지 못했습니다.' : '아직 확인한 일정이 없습니다.'));
      else {
        group.append(node('p', 'owner-muted', `조회된 일정 ${view.data.count}개${view.state === 'stale' ? ' · 마지막 확인 기록' : ''}`));
        if (!view.data.jobs.length) group.append(node('p', 'owner-muted', '등록된 일정이 없습니다.'));
        view.data.jobs.forEach((job, index) => {
          const row = node('article', 'owner-job');
          const top = node('div', 'owner-task-meta');
          top.append(node('strong', '', `반복 일정 ${index + 1}`), node('span', job.error.present ? 'owner-job-error' : '', job.error.present ? '최근 실행 오류' : job.enabled ? '활성' : '중지됨'));
          row.append(top, node('p', '', `다음 실행 ${date(job.next_run_at)}`), node('p', 'owner-muted', `최근 실행 ${date(job.last_run_at)} · ${job.last_status === 'ok' ? '성공' : job.last_status === 'error' ? '오류' : job.last_status || '미확인'}`));
          if (job.schedule_display) row.append(node('code', 'owner-schedule', job.schedule_display));
          group.append(row);
        });
      }
      content.append(group);
    }
    content.append(node('p', 'owner-unobserved', '율 · 루드비히 · 앤 · 아르고스: 예약 미확인'));
  }
  function renderResults() {
    const view = state.resources['results:rodi'];
    freshness('results:rodi', content);
    resourceWarning(view);
    if (!view.data) { if (!['error', 'transport-error'].includes(view.state)) empty('로디 요약을 아직 확인하지 못했어요', view.state === 'unsupported' ? '이 연결은 현재 실행 요약을 제공하지 않습니다.' : '다음 새로고침에서 다시 확인합니다.'); return; }
    const data = view.data;
    const result = node('article', 'owner-result');
    result.append(node('p', 'owner-kicker', 'RODI · 확인된 실행'), node('h3', '', '로디가 남긴 실행 요약'), node('p', 'owner-muted', `실행 완료 ${date(data.run.completed_at)}`));
    result.append(node('p', 'owner-summary', data.run.summary || data.latest_summary || '이 실행에 남아 있는 요약이 없습니다.'));
    result.append(node('p', 'owner-scope', '연결된 실행의 기록입니다. 로디의 전체 최신 결과 목록을 뜻하지 않습니다.'));
    content.append(result);
    empty('열 수 있는 파일이 없어요', '현재는 로디의 실행 요약만 확인할 수 있어요.');
  }
  function render() {
    if (!state) return;
    const scrollTop = lastRenderedTab === tab ? content.scrollTop : 0;
    const activeId = panel.contains(document.activeElement) ? document.activeElement.id : '';
    login.hidden = state.authenticated;
    body.hidden = !state.authenticated;
    loginMessage.textContent = SESSION_ERROR[state.sessionError] || '';
    retryLogout.hidden = state.sessionError !== 'logout_failed';
    submit.disabled = loggingIn || state.loggingOut;
    submit.textContent = state.loggingOut ? '로그아웃 중…' : loggingIn ? '확인 중…' : '작업실 열기';
    refresh.disabled = refreshing;
    refresh.textContent = refreshing ? '확인 중…' : '새로고침';
    launch.textContent = state.authenticated ? '✦ 나의 작업실' : '✦ 개인 작업실';
    for (const [key, element] of tabButtons) { element.setAttribute('aria-selected', String(key === tab)); element.tabIndex = key === tab ? 0 : -1; }
    filters.hidden = tab !== 'board';
    agentSelect.value = agent;
    statusSelect.value = filter;
    context.textContent = agent && tab === 'board' ? `${NAMES[agent] || agent}의 업무` : '우리 마을의 업무 기록';
    content.setAttribute('aria-labelledby', `ownerTab-${tab}`);
    content.replaceChildren();
    if (state.authenticated && !document.hidden) {
      if (tab === 'board') renderBoard();
      else if (tab === 'jobs') renderJobs();
      else renderResults();
      updateFreshness();
    }
    if (activeId && document.activeElement === document.body) document.getElementById(activeId)?.focus({ preventScroll: true });
    content.scrollTop = scrollTop;
    lastRenderedTab = tab;
  }
  async function reload() {
    if (!state.authenticated || refreshing) return;
    refreshing = true; render();
    try { await client.refreshAll(); } finally { refreshing = false; state = client.snapshot(); render(); }
  }
  async function show(options = {}) {
    onOpen();
    opener = document.activeElement;
    tab = options.tab || 'board';
    agent = options.agent || '';
    filter = ''; limit = 30;
    open = true; panel.hidden = false; panel.inert = false;
    launch.setAttribute('aria-expanded', 'true');
    document.body.classList.add('owner-panel-open');
    render();
    if (!state.authenticated) await client.checkSession();
    if (!open) return;
    (state.authenticated ? close : password).focus({ preventScroll: true });
    if (state.authenticated) await reload();
  }
  function hide(restoreFocus = false) {
    open = false; panel.hidden = true; panel.inert = true;
    document.body.classList.remove('owner-panel-open');
    launch.setAttribute('aria-expanded', 'false');
    if (restoreFocus) (opener?.isConnected ? opener : launch).focus({ preventScroll: true });
  }
  login.addEventListener('submit', async (event) => {
    event.preventDefault(); if (loggingIn || state.loggingOut) return;
    const entered = password.value; password.value = '';
    loggingIn = true; render();
    const success = await client.login(entered);
    loggingIn = false; render();
    if (success) { close.focus(); await reload(); } else password.focus();
  });
  const keyboard = (event) => { if (open && event.key === 'Escape') { event.preventDefault(); hide(true); } };
  document.addEventListener('keydown', keyboard);
  const visibility = () => {
    if (document.hidden) { content.replaceChildren(); return; }
    if (open) { render(); if (state.authenticated) client.checkSession().then(() => { if (state.authenticated) reload(); }); }
  };
  document.addEventListener('visibilitychange', visibility);
  const freshTimer = setInterval(() => { if (open && !document.hidden) updateFreshness(); }, 1000);
  const pollTimer = setInterval(() => { if (open && !document.hidden && state.authenticated) reload(); }, 15000);
  render();
  return { open: show, close: hide, refresh: reload, destroy() { clearInterval(freshTimer); clearInterval(pollTimer); document.removeEventListener('keydown', keyboard); document.removeEventListener('visibilitychange', visibility); client.dispose(); panel.remove(); launch.remove(); } };
}
