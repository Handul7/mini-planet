// Stop the simulation clock as well as GPU work while the page cannot render.
export function createVisibilityLoop({
  frame,
  document: page = globalThis.document,
  requestFrame = globalThis.requestAnimationFrame.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame.bind(globalThis),
  blocked = () => false,
  onPause = () => {},
} = {}) {
  let running = false;
  let pending = null;
  let previous = null;
  let elapsed = 0;
  let frames = 0;
  const available = () => !page.hidden && !blocked();
  function schedule() {
    if (running && available() && pending === null) pending = requestFrame(tick);
  }
  function tick(now) {
    pending = null;
    if (!running || !available()) { refresh(); return; }
    const dt = previous === null ? 0 : Math.max(0, Math.min(0.05, (now - previous) / 1000));
    previous = now;
    elapsed += dt;
    frames++;
    frame(dt, elapsed, now);
    schedule();
  }
  function refresh() {
    if (!available()) {
      if (pending !== null) cancelFrame(pending);
      pending = null;
      previous = null;
      onPause();
    } else schedule();
  }
  page.addEventListener('visibilitychange', refresh);
  return {
    start() { running = true; refresh(); },
    refresh,
    state: () => ({ frames, elapsed: +elapsed.toFixed(2), paused: !running || !available(), pending: pending !== null }),
    dispose() {
      running = false;
      if (pending !== null) cancelFrame(pending);
      pending = null;
      previous = null;
      page.removeEventListener('visibilitychange', refresh);
    },
  };
}

// Label projection changes every frame; its CSS box generally does not.
export function createElementSizeCache({ Observer = globalThis.ResizeObserver } = {}) {
  const entries = new Map();
  let reads = 0;
  let hits = 0;
  const observer = typeof Observer === 'function' ? new Observer((changes) => {
    for (const change of changes) {
      const entry = entries.get(change.target);
      const box = change.borderBoxSize?.[0] || change.borderBoxSize;
      if (entry && box?.inlineSize > 0 && box?.blockSize > 0) {
        entry.width = box.inlineSize;
        entry.height = box.blockSize;
      }
    }
  }) : null;
  return {
    measure(element, now = performance.now()) {
      const text = element.textContent;
      const classes = element.className;
      let entry = entries.get(element);
      if (!entry || entry.text !== text || entry.classes !== classes || now - entry.at >= 1000) {
        const width = Math.max(1, element.offsetWidth);
        const height = Math.max(1, element.offsetHeight);
        reads++;
        if (!entry) observer?.observe(element);
        entry = { width, height, text, classes, at: now };
        entries.set(element, entry);
      } else hits++;
      return entry;
    },
    remove(element) { observer?.unobserve(element); entries.delete(element); },
    state: () => ({ reads, hits, tracked: entries.size }),
    dispose() { observer?.disconnect(); entries.clear(); },
  };
}
