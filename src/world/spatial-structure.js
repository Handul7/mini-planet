import * as THREE from '../../vendor/three/build/three.module.min.js';

// The same shoreline profile is used by geometry and water classification.
export function oceanBandBounds(longitude, minY = -0.70, maxY = 0.20) {
  return {
    min: minY + Math.sin(longitude * 3 + 0.7) * 0.035 + Math.cos(longitude * 2) * 0.015,
    max: maxY + Math.sin(longitude * 2 - 0.5) * 0.045 + Math.cos(longitude * 3) * 0.020,
  };
}

export function streetNetworkState(paths, tolerance = 0.02) {
  const components = [];
  const remaining = new Set(paths.map((_, i) => i));
  const near = (a, b) => a.some((p) => b.some((q) => p.dot(q) > Math.cos(tolerance)));
  while (remaining.size) {
    const first = remaining.values().next().value;
    const group = [first]; remaining.delete(first);
    for (let i = 0; i < group.length; i++) {
      for (const candidate of remaining) {
        if (!near(paths[group[i]], paths[candidate])) continue;
        group.push(candidate); remaining.delete(candidate);
      }
    }
    components.push(group);
  }
  return { components, connected: paths.length > 0 && components.length === 1 };
}

// QA-only route search. Every graph edge is checked against the live water
// mask, including its interior, rather than assuming open-water endpoints.
export function findSurfaceRoute(start, end, allowed) {
  if (!allowed(start) || !allowed(end)) return null;
  const clearSegment = (a, b) => {
    const count = Math.max(1, Math.ceil(a.angleTo(b) / 0.025));
    for (let i = 0; i <= count; i++) {
      if (!allowed(a.clone().lerp(b, i / count).normalize())) return false;
    }
    return true;
  };
  if (clearSegment(start, end) && start.dot(end) > -0.95) return [start.clone(), end.clone()];
  const geometry = new THREE.SphereGeometry(1, 64, 32);
  const positions = geometry.getAttribute('position');
  const points = [], indexMap = [], keys = new Map();
  for (let i = 0; i < positions.count; i++) {
    const point = new THREE.Vector3().fromBufferAttribute(positions, i).normalize();
    const key = point.toArray().map((n) => n.toFixed(5)).join(',');
    if (!keys.has(key)) { keys.set(key, points.length); points.push(point); }
    indexMap.push(keys.get(key));
  }
  const adjacency = points.map(() => new Set());
  const valid = points.map(allowed);
  const checked = new Set();
  const link = (a, b) => {
    if (a === b || !valid[a] || !valid[b]) return;
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (checked.has(key)) return;
    checked.add(key);
    if (clearSegment(points[a], points[b])) { adjacency[a].add(b); adjacency[b].add(a); }
  };
  const indices = geometry.index.array;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]].map((j) => indexMap[j]);
    link(a, b); link(b, c); link(c, a);
  }
  geometry.dispose();
  for (const point of [start, end]) {
    const near = points.map((p, i) => ({ i, distance: p.angleTo(point) }))
      .filter((p) => valid[p.i]).sort((a, b) => a.distance - b.distance).slice(0, 24);
    const index = points.length;
    points.push(point.clone()); valid.push(true); adjacency.push(new Set());
    for (const entry of near) link(index, entry.i);
  }
  const source = points.length - 2, target = points.length - 1;
  const open = new Set([source]), closed = new Set();
  const costs = new Map([[source, 0]]), previous = new Map();
  while (open.size) {
    let best = -1, score = Infinity;
    for (const i of open) {
      const value = costs.get(i) + points[i].angleTo(end);
      if (value < score) { best = i; score = value; }
    }
    if (best === target) {
      const result = [points[best]];
      while (previous.has(best)) { best = previous.get(best); result.push(points[best]); }
      return result.reverse();
    }
    open.delete(best); closed.add(best);
    for (const next of adjacency[best]) {
      if (closed.has(next)) continue;
      const cost = costs.get(best) + points[best].angleTo(points[next]);
      if (cost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, cost); previous.set(next, best); open.add(next);
    }
  }
  return null;
}
