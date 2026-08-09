function buttonPressed(button) {
  return Boolean(button && (button.pressed || Number(button.value) > 0.5));
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
