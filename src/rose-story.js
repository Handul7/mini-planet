export const ROSE_LINES = Object.freeze([
  '물론 나는 너를 사랑해.',
  '네가 몰랐던 건 내 잘못이야.',
  '행복해져.',
]);
// Short excerpts from chapter IX, translated here rather than copied from a Korean edition.
export const ROSE_SOURCE = 'https://lepetitprince.eu/numerique/le-petit-prince/';

export function createRoseStory({ document: page = globalThis.document, onOpen = () => {} } = {}) {
  const dialog = page.createElement('dialog');
  dialog.className = 'rose-story';
  dialog.setAttribute('aria-labelledby', 'roseStoryTitle');
  dialog.innerHTML = `<button type="button" class="rose-story-close" aria-label="장미 이야기 닫기" title="닫기">×</button>
    <header><span>B-612</span><h2 id="roseStoryTitle">장미가 남긴 말</h2></header>
    <blockquote aria-live="polite" aria-atomic="true"></blockquote>
    <footer><cite>어린 왕자 · 9장<br><small>생텍쥐페리 · 원문 직접 번역</small></cite>
    <div class="rose-story-pages"><span></span><button type="button" title="다음 문장" aria-label="다음 문장">→</button></div></footer>`;
  page.body.appendChild(dialog);
  const quote = dialog.querySelector('blockquote');
  const count = dialog.querySelector('.rose-story-pages span');
  const next = dialog.querySelector('.rose-story-pages button');
  const close = dialog.querySelector('.rose-story-close');
  let index = 0, opener = null;
  function render() {
    quote.textContent = ROSE_LINES[index];
    count.textContent = `${index + 1} / ${ROSE_LINES.length}`;
    next.setAttribute('aria-label', index === ROSE_LINES.length - 1 ? '이야기 마치기' : '다음 문장');
    next.title = next.getAttribute('aria-label');
    next.textContent = index === ROSE_LINES.length - 1 ? '✓' : '→';
  }
  close.addEventListener('click', () => dialog.close());
  next.addEventListener('click', () => {
    if (index === ROSE_LINES.length - 1) dialog.close();
    else { index++; render(); }
  });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
  return {
    open() {
      if (dialog.open) return false;
      opener = page.activeElement;
      index = 0;
      render();
      dialog.showModal();
      next.focus();
      onOpen();
      return true;
    },
    close: () => { if (dialog.open) dialog.close(); },
    isOpen: () => dialog.open,
    dispose: () => { if (dialog.open) dialog.close(); dialog.remove(); },
  };
}
