const params = new URLSearchParams(location.search);
const dev = params.has('dev');

function showMiniPlanetBootError() {
  for (const id of ['startBtn', 'exploreModeBtn']) {
    const button = document.getElementById(id);
    if (button) {
      button.disabled = true;
      button.textContent = '새로고침 필요';
    }
  }
  const loading = document.getElementById('introLoading');
  if (loading) {
    loading.textContent = '3D 파일을 불러오지 못했습니다. 연결과 배포 파일을 확인한 뒤 새로고침해주세요.';
    loading.classList.add('error');
  }
  const retry = document.getElementById('bootRetryBtn');
  if (retry) retry.hidden = false;
}

document.getElementById('bootRetryBtn')?.addEventListener('click', () => location.reload());
if (dev) {
  const styles = document.getElementById('appStyles');
  if (styles) styles.href = new URL(`./style.css?dev=${Date.now()}`, import.meta.url).href;
}

import(`./main.js?${dev ? `dev=${Date.now()}` : 'v=76'}`).catch((error) => {
  console.error('Mini Planet boot failed', error);
  showMiniPlanetBootError();
});

// Service-worker caching is progressive enhancement. Development unregisters
// only this app's scope so source changes always load immediately.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const appScope = new URL('../', import.meta.url).href;
    if (dev) {
      navigator.serviceWorker.getRegistrations().then((registrations) =>
        Promise.all(registrations
          .filter((registration) => registration.scope === appScope)
          .map((registration) => registration.unregister()))
      ).catch(() => {});
      return;
    }
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), {
      updateViaCache: 'none',
    }).then((registration) => {
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            window.dispatchEvent(new Event('mini-planet-update-ready'));
          }
        });
      });
    }).catch(() => {});
  });
}
