function buttonPressed(button) {
  return Boolean(button && (button.pressed || Number(button.value) > 0.5));
}

// Only contacts that began on the canvas participate in orbit/pinch.
export function createOrbitGesture() {
  const pointers = new Map();
  let distance = 0;
  const separation = () => {
    if (pointers.size !== 2) return 0;
    const [a, b] = pointers.values();
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  return {
    pointers,
    begin(event) {
      if (event.button !== 0 || pointers.has(event.pointerId)) return false;
      if (pointers.size && event.pointerType !== 'touch') return false;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      distance = separation();
      return true;
    },
    move(event) {
      const point = pointers.get(event.pointerId);
      if (!point) return null;
      const dx = event.clientX - point.x, dy = event.clientY - point.y;
      point.x = event.clientX;
      point.y = event.clientY;
      if (pointers.size === 1) return { dx, dy, zoom: 0 };
      const next = separation();
      const zoom = pointers.size === 2 ? (distance - next) * 0.03 : 0;
      distance = next;
      return { dx: 0, dy: 0, zoom };
    },
    end(event) {
      pointers.delete(event.pointerId);
      distance = separation();
    },
    reset() { pointers.clear(); distance = 0; },
  };
}

export function bindVirtualJoystick({ stick, knob, vector, events = window, page = document, enabled = () => true }) {
  let pointerId = null, cx = 0, cy = 0, radius = 1;
  const listeners = [];
  const listen = (target, name, fn) => {
    target.addEventListener(name, fn);
    listeners.push(() => target.removeEventListener(name, fn));
  };
  const reset = () => {
    const previous = pointerId;
    pointerId = null;
    vector.x = vector.y = 0;
    knob.style.transform = '';
    if (previous !== null && stick.hasPointerCapture?.(previous)) stick.releasePointerCapture(previous);
  };
  const move = (event) => {
    if (event.pointerId !== pointerId) return;
    if (!enabled()) { reset(); return; }
    const dx = event.clientX - cx, dy = event.clientY - cy;
    const divisor = Math.max(radius, Math.hypot(dx, dy));
    vector.x = dx / divisor;
    vector.y = dy / divisor;
    knob.style.transform = `translate(${vector.x * radius}px, ${vector.y * radius}px)`;
  };
  listen(stick, 'pointerdown', (event) => {
    if (pointerId !== null || event.button !== 0 || !enabled()) return;
    const rect = stick.getBoundingClientRect();
    radius = Math.max(1, (Math.min(rect.width, rect.height) - knob.offsetWidth) / 2 - 2);
    cx = rect.left + rect.width / 2;
    cy = rect.top + rect.height / 2;
    pointerId = event.pointerId;
    try { stick.setPointerCapture(pointerId); } catch { reset(); return; }
    move(event);
  });
  listen(stick, 'pointermove', move);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    listen(stick, name, (event) => { if (event.pointerId === pointerId) reset(); });
  }
  listen(events, 'blur', reset);
  listen(events, 'resize', reset);
  listen(page, 'visibilitychange', () => { if (page.hidden) reset(); });
  return { reset, dispose() { reset(); listeners.forEach(remove => remove()); } };
}

export function wheelPixels(event, pageHeight = 800) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  return Math.max(-240, Math.min(240, (Number(event.deltaY) || 0) * unit));
}

export function normalizeStickAxis(value, deadzone = 0.16) {
  const axis = Math.max(-1, Math.min(1, Number(value) || 0));
  const zone = Math.max(0, Math.min(0.8, Number(deadzone) || 0));
  const magnitude = Math.abs(axis);
  if (magnitude <= zone) return 0;
  return Math.sign(axis) * ((magnitude - zone) / (1 - zone));
}

export function readGamepadControls(gamepads) {
  const pads = gamepads ? Array.from(gamepads) : [];
  const pad = pads.find((candidate) => candidate?.connected !== false && candidate?.buttons && candidate?.axes);
  if (!pad) {
    return {
      connected: false,
      forward: 0,
      turn: 0,
      lookX: 0,
      lookY: 0,
      jump: false,
      interact: false,
    };
  }

  const up = buttonPressed(pad.buttons[12]);
  const down = buttonPressed(pad.buttons[13]);
  const left = buttonPressed(pad.buttons[14]);
  const right = buttonPressed(pad.buttons[15]);
  return {
    connected: true,
    id: String(pad.id || ''),
    index: Number.isFinite(pad.index) ? pad.index : 0,
    forward: Math.max(-1, Math.min(1, -normalizeStickAxis(pad.axes[1]) + Number(up) - Number(down))),
    turn: Math.max(-1, Math.min(1, -normalizeStickAxis(pad.axes[0]) + Number(left) - Number(right))),
    lookX: normalizeStickAxis(pad.axes[2]),
    lookY: normalizeStickAxis(pad.axes[3]),
    jump: buttonPressed(pad.buttons[0]),
    interact: buttonPressed(pad.buttons[2]),
  };
}
