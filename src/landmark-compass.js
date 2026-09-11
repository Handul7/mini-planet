// Bearing on the local tangent plane, relative to the camera's screen-right.
// A landmark at the antipode has no unique shortest-path bearing.
export function surfaceBearing(origin, screenRight, target) {
  if (!origin || !screenRight || !target) return { status: 'missing' };
  const ol = Math.hypot(origin.x, origin.y, origin.z);
  const tl = Math.hypot(target.x, target.y, target.z);
  if (!Number.isFinite(ol + tl) || ol < 1e-8 || tl < 1e-8) return { status: 'missing' };
  const x = origin.x / ol, y = origin.y / ol, z = origin.z / ol;
  const tx = target.x / tl, ty = target.y / tl, tz = target.z / tl;
  const dot = Math.max(-1, Math.min(1, x * tx + y * ty + z * tz));
  const distance = Math.acos(dot);
  if (distance < 0.025) return { status: 'near', distance };
  if (Math.PI - distance < 1e-5) return { status: 'antipode', distance };
  const radial = screenRight.x * x + screenRight.y * y + screenRight.z * z;
  let rx = screenRight.x - radial * x;
  let ry = screenRight.y - radial * y;
  let rz = screenRight.z - radial * z;
  const length = Math.hypot(rx, ry, rz);
  if (!Number.isFinite(length) || length < 1e-8) return { status: 'missing', distance };
  rx /= length; ry /= length; rz /= length;
  const fx = y * rz - z * ry, fy = z * rx - x * rz, fz = x * ry - y * rx;
  return { status: 'bearing', distance,
    angle: Math.atan2(tx * rx + ty * ry + tz * rz, tx * fx + ty * fy + tz * fz) * 180 / Math.PI };
}

export function createLandmarkCompass(element) {
  const needles = ['north', 'lighthouse'].map((key) => ({ key,
    element: element?.querySelector(`[data-compass="${key}"]`), angle: null, status: null }));
  let lastAt = -Infinity, samples = 0, writes = 0, lastLabel = '';
  let bearings = {};
  return {
    update(now, { origin, right, north, lighthouse }) {
      if (!element || now - lastAt < 50) return;
      lastAt = now;
      samples++;
      const targets = { north, lighthouse };
      for (const needle of needles) {
        const result = surfaceBearing(origin, right, targets[needle.key]);
        bearings[needle.key] = result;
        if (!needle.element) continue;
        if (needle.status !== result.status) {
          needle.element.hidden = result.status !== 'bearing';
          needle.status = result.status;
          writes++;
        }
        if (result.status !== 'bearing') continue;
        const delta = needle.angle === null ? 0 : ((result.angle - needle.angle + 540) % 360 + 360) % 360 - 180;
        const next = needle.angle === null ? result.angle : needle.angle + delta;
        if (needle.angle === null || Math.abs(delta) >= 0.5) {
          needle.angle = next;
          needle.element.style.setProperty('--bearing', `${next.toFixed(2)}deg`);
          writes++;
        }
      }
      const describe = (key, name) => {
        const state = bearings[key];
        return `${name}: ${state.status === 'bearing' ? '방향 표시' : state.status === 'near'
          ? '도착 지점' : state.status === 'antipode' ? '반대편 극점' : '위치 없음'}`;
      };
      const label = `화면 기준 나침반. ${describe('north', '북쪽 장미')}. ${describe('lighthouse', '등대')}. 등대는 남쪽 섬이며 정남극은 아닙니다.`;
      if (lastLabel !== label) { element.setAttribute('aria-label', label); lastLabel = label; writes++; }
    },
    state: () => ({ samples, writes, bearings }),
  };
}
