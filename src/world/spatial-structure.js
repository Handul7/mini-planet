import * as THREE from '../../vendor/three/build/three.module.min.js';

export function segmentOccludedBySphere(from, to, radius) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq < 1e-10) return false;
  const t = Math.max(0, Math.min(1, -(from.x * dx + from.y * dy + from.z * dz) / lengthSq));
  const x = from.x + t * dx, y = from.y + t * dy, z = from.z + t * dz;
  return x * x + y * y + z * z < radius * radius;
}

// QA uses the real movement callback. No teleporting or collision bypass is
// allowed between route points, including the final approach to a doorway.
export function walkSurfaceRoute(points, { getPosition, move, allowed }) {
  let steps = 0, distance = 0;
  if (!points?.length) return { pass: false, steps, distance, reason: 'no-route' };
  for (const target of points) {
    let stalled = 0;
    if (!allowed(target)) return { pass: false, steps, distance, reason: 'target-blocked' };
    while (getPosition().angleTo(target) > 0.002) {
      const before = getPosition().clone();
      const remaining = before.angleTo(target);
      if (++steps > 12000) return { pass: false, steps, distance, reason: 'step-limit' };
      const tangent = target.clone().addScaledVector(before, -target.dot(before));
      if (!move(tangent, Math.min(0.012, remaining))) return { pass: false, steps, distance, reason: 'movement-blocked' };
      const after = getPosition();
      if (!allowed(after)) return { pass: false, steps, distance, reason: 'left-walkable-surface' };
      distance += before.angleTo(after);
      stalled = after.angleTo(target) >= remaining - 0.00001 ? stalled + 1 : 0;
      if (stalled > 24) return { pass: false, steps, distance, reason: 'no-progress' };
    }
  }
  return { pass: true, steps, distance };
}

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

// Unlike the terrain route finder, this QA route may only use authored street
// samples and their junctions. It cannot report success by cutting over lawns.
export function findStreetRoute(start, end, paths, allowed) {
  if (!allowed(start) || !allowed(end)) return null;
  const nodes = paths.flatMap((path) => path.map((n) => n.clone().normalize()));
  if (!nodes.length || nodes.length > 3000) return null;
  const edges = nodes.map(() => new Set());
  const clear = (a, b) => {
    const count = Math.max(1, Math.ceil(a.angleTo(b) / 0.012));
    for (let i = 0; i <= count; i++) if (!allowed(a.clone().lerp(b, i / count).normalize())) return false;
    return true;
  };
  const join = (a, b) => {
    if (clear(nodes[a], nodes[b])) { edges[a].add(b); edges[b].add(a); }
  };
  let offset = 0;
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) join(offset + i - 1, offset + i);
    offset += path.length;
  }
  const junctionDot = Math.cos(0.03);
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    if (!edges[i].has(j) && nodes[i].dot(nodes[j]) > junctionDot) join(i, j);
  }
  const streetCount = nodes.length;
  for (const point of [start, end]) {
    const index = nodes.length;
    nodes.push(point.clone()); edges.push(new Set());
    for (let i = 0; i < streetCount; i++) if (nodes[i].angleTo(point) < 0.055) join(index, i);
    if (!edges[index].size) return null;
  }
  const source = streetCount, target = source + 1;
  const costs = new Map([[source, 0]]), previous = new Map(), open = new Set([source]);
  while (open.size) {
    let current = -1, best = Infinity;
    for (const i of open) if (costs.get(i) < best) { current = i; best = costs.get(i); }
    open.delete(current);
    if (current === target) {
      const route = [nodes[current]];
      while (previous.has(current)) { current = previous.get(current); route.push(nodes[current]); }
      return route.reverse();
    }
    for (const next of edges[current]) {
      const cost = best + nodes[current].angleTo(nodes[next]);
      if (cost >= (costs.get(next) ?? Infinity) - 1e-10) continue;
      costs.set(next, cost); previous.set(next, current); open.add(next);
    }
  }
  return null;
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
