import * as THREE from '../vendor/three/build/three.module.min.js';

export const BOARD_STORAGE_KEY = 'HandulPlanet_village_board_v1';
export const BOARD_LIMITS = Object.freeze({ title: 48, body: 600 });
export function normalizeBoard(value) {
  if (!value || typeof value !== 'object' || typeof value.title !== 'string' || typeof value.body !== 'string') return null;
  const clean = (text, max) => [...text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')].slice(0, max).join('').trim();
  return { title: clean(value.title, BOARD_LIMITS.title), body: clean(value.body, BOARD_LIMITS.body) };
}

export function wrapBoardText(context, text, width, maxLines) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (line && context.measureText(line + character).width > width) { lines.push(line); line = ''; }
      line += character;
    }
    lines.push(line);
  }
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  let last = clipped[maxLines - 1];
  while (last && context.measureText(`${last}…`).width > width) last = [...last].slice(0, -1).join('');
  clipped[maxLines - 1] = `${last}…`;
  return clipped;
}

export async function createVillageBoard() {
  let defaults = { title: '마을 게시판', body: '오늘의 소식과 함께 나누고 싶은 이야기를 남겨주세요.' };
  try {
    const response = await fetch('config/village-board.json', { cache: 'no-store' });
    if (response.ok) defaults = normalizeBoard(await response.json()) || defaults;
  } catch { /* Offline first visit uses the bundled fallback. */ }
  let content = defaults, local = false;
  try {
    const saved = normalizeBoard(JSON.parse(localStorage.getItem(BOARD_STORAGE_KEY)));
    if (saved) { content = saved; local = true; }
  } catch { /* Unavailable or corrupt local storage must not block startup. */ }
  const textures = new Set();
  const dialog = document.createElement('dialog');
  dialog.id = 'villageBoardDialog';
  dialog.className = 'village-board-dialog';
  dialog.setAttribute('aria-labelledby', 'villageBoardTitle');
  dialog.setAttribute('role', 'dialog');
  // User content is assigned only through textContent, value, and canvas text.
  dialog.innerHTML = `<header><span>VILLAGE NOTES</span><button type="button" id="boardClose" aria-label="게시판 닫기" title="닫기">×</button></header>
    <h2 id="villageBoardTitle"></h2><p id="boardBody" class="board-body"></p>
    <form id="boardForm" hidden><label for="boardTitleInput">제목</label><input id="boardTitleInput" maxlength="48" required>
    <label for="boardBodyInput">내용</label><textarea id="boardBodyInput" maxlength="600" rows="8" required></textarea>
    <div class="board-counter" id="boardCounter"></div><p class="board-storage">수정한 글은 이 브라우저에만 저장됩니다. 공개 배포용 글은 JSON으로 내보낼 수 있습니다.</p>
    <div class="board-actions"><button type="button" id="boardCancel">취소</button><button type="submit">저장</button></div></form>
    <div class="board-actions" id="boardReadActions"><button type="button" id="boardReset">기본 글로 복원</button><button type="button" id="boardExport">JSON 내보내기</button><button type="button" id="boardEdit">글 수정</button></div>
    <p id="boardStatus" class="board-status" role="status" aria-live="polite"></p>`;
  document.body.append(dialog);
  const el = (id) => dialog.querySelector(`#${id}`);
  const draw = (texture) => {
    const context = texture.image.getContext('2d');
    context.fillStyle = '#f7f6ef'; context.fillRect(0, 0, 1024, 640);
    context.fillStyle = '#688a80'; context.fillRect(48, 50, 8, 55);
    context.fillStyle = '#36514f'; context.font = 'bold 46px sans-serif';
    wrapBoardText(context, content.title || '마을 게시판', 890, 2).forEach((line, i) => context.fillText(line, 78, 88 + i * 56));
    context.fillStyle = '#56645f'; context.font = '34px sans-serif';
    wrapBoardText(context, content.body, 870, 7).forEach((line, i) => context.fillText(line, 78, 226 + i * 49));
    texture.needsUpdate = true;
  };
  const render = () => {
    el('villageBoardTitle').textContent = content.title || '마을 게시판';
    el('boardBody').textContent = content.body;
    el('boardReset').disabled = !local;
    textures.forEach(draw);
  };
  const editing = (value) => {
    el('boardForm').hidden = !value;
    el('boardBody').hidden = value;
    el('boardReadActions').hidden = value;
    if (value) {
      el('boardTitleInput').value = content.title;
      el('boardBodyInput').value = content.body;
      el('boardCounter').textContent = `${content.body.length} / 600`;
      el('boardTitleInput').focus();
    }
  };
  let opener = null;
  const open = () => {
    if (dialog.open) return;
    opener = document.activeElement;
    editing(false); render();
    el('boardStatus').textContent = local ? '이 브라우저에 저장된 글' : '공개 기본 글';
    dialog.showModal();
    document.dispatchEvent(new Event('village-board-open'));
  };
  el('boardClose').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
  el('boardEdit').onclick = () => editing(true);
  el('boardCancel').onclick = () => { editing(false); el('boardEdit').focus(); };
  el('boardBodyInput').oninput = () => { el('boardCounter').textContent = `${el('boardBodyInput').value.length} / 600`; };
  el('boardForm').onsubmit = (event) => {
    event.preventDefault();
    const next = normalizeBoard({ title: el('boardTitleInput').value, body: el('boardBodyInput').value });
    if (!next?.title || !next.body) { el('boardStatus').textContent = '제목과 내용을 입력해주세요.'; return; }
    try { localStorage.setItem(BOARD_STORAGE_KEY, JSON.stringify(next)); }
    catch { el('boardStatus').textContent = '저장 공간을 사용할 수 없습니다. 입력한 글을 유지했습니다.'; return; }
    content = next; local = true; editing(false); render();
    el('boardStatus').textContent = '이 브라우저에 저장했습니다.'; el('boardEdit').focus();
  };
  el('boardReset').onclick = () => {
    try { localStorage.removeItem(BOARD_STORAGE_KEY); }
    catch { el('boardStatus').textContent = '저장된 글을 복원하지 못했습니다.'; return; }
    content = defaults; local = false; render(); el('boardStatus').textContent = '공개 기본 글로 복원했습니다.';
  };
  el('boardExport').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2) + '\n'], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'village-board.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  document.getElementById('villageBoardBtn')?.addEventListener('click', open);
  render();
  return {
    open, isOpen: () => dialog.open,
    createMesh(materialFactory) {
      const group = new THREE.Group();
      const add = (size, position, color) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), materialFactory(color));
        mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = false; group.add(mesh); return mesh;
      };
      add([2.02, 1.36, 0.14], [0, 1.33, 0], 0x617a70);
      add([1.89, 1.23, 0.04], [0, 1.33, 0.095], 0xe5dac2);
      for (const x of [-0.77, 0.77]) { add([0.11, 1.34, 0.13], [x, 0.67, 0], 0x617a70); add([0.22, 0.10, 0.26], [x, 0.05, 0], 0xc0c7b5); }
      add([2.15, 0.10, 0.34], [0, 2.05, 0.03], 0xc09a86);
      const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 640;
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true;
      textures.add(texture); draw(texture);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(1.78, 1.11), new THREE.MeshBasicMaterial({ map: texture }));
      face.position.set(0, 1.33, 0.123); group.add(face);
      group.userData.disposeResources = () => { textures.delete(texture); texture.dispose(); };
      group.userData.noticeBoard = true;
      return group;
    },
  };
}
