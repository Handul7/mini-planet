import * as THREE from '../../vendor/three/build/three.module.min.js';

// Broad, low-contrast paper stones. One vertex-colored mesh per surface keeps
// the pattern inexpensive and avoids tiny shadow-casting details that shimmer.
function pavingBuilder(materialFactory, terrainRadius, lift, color) {
  const positions = [], normals = [], colors = [];
  const base = new THREE.Color(color);
  let tiles = 0;
  function tile(project, tone) {
    const tint = base.clone().lerp(new THREE.Color(0xffffff), tone);
    const point = (x, z) => project(x, z).normalize();
    for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) {
      const corners = [point(x / 2, z / 2), point((x + 1) / 2, z / 2),
        point((x + 1) / 2, (z + 1) / 2), point(x / 2, (z + 1) / 2)];
      const outward = corners[1].clone().sub(corners[0]).cross(corners[2].clone().sub(corners[0])).dot(corners[0]) > 0;
      for (const index of outward ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
        const n = corners[index];
        positions.push(...n.clone().multiplyScalar(terrainRadius(n) + lift).toArray());
        normals.push(...n.toArray()); colors.push(...tint.toArray());
      }
    }
    tiles++;
  }
  function finish(role) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    const material = materialFactory(0xffffff);
    material.vertexColors = true;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = false; mesh.castShadow = false;
    mesh.userData.paving = { role, tiles };
    return mesh;
  }
  return { tile, finish };
}

export function makeStreetPavers(points, { radius, terrainRadius, splineDirs, materialFactory,
  width = 0.86, lift = 0.162, color = 0xacb7b6 } = {}) {
  const { dirs } = splineDirs(points, { step: 0.012 });
  const builder = pavingBuilder(materialFactory, terrainRadius, lift, color);
  if (dirs.length < 2) return builder.finish('street');
  const distances = [0];
  for (let i = 1; i < dirs.length; i++) distances.push(distances.at(-1) + dirs[i - 1].angleTo(dirs[i]) * radius);
  const total = distances.at(-1);
  // Very long imported paths retain their base surface without excessive detail.
  if (total > 80) return builder.finish('street');
  const sample = (distance) => {
    let i = 1;
    while (i < distances.length - 1 && distances[i] < distance) i++;
    const fraction = (distance - distances[i - 1]) / Math.max(1e-8, distances[i] - distances[i - 1]);
    return dirs[i - 1].clone().lerp(dirs[i], THREE.MathUtils.clamp(fraction, 0, 1)).normalize();
  };
  for (let row = 0; row < 2; row++) {
    const start = 0.14 + row * 0.23;
    for (let at = start; at + 0.42 < total - 0.10; at += 0.46) {
      const a = sample(at), b = sample(at + 0.42);
      const forward = b.clone().sub(a).normalize();
      const side = new THREE.Vector3().crossVectors(a, forward).normalize();
      const left = -width / 2 + row * width / 2 + 0.015;
      const right = left + width / 2 - 0.03;
      builder.tile((u, v) => a.clone().lerp(b, v)
        .addScaledVector(side, (left + (right - left) * u) / radius), ((row + Math.floor(at * 7)) % 3) * 0.028);
    }
  }
  return builder.finish('street');
}

export function makePlazaPavers(center, rim, { radius, terrainRadius, materialFactory, tangentBasis,
  lift = 0.163, color = 0xc0c8c1, cell = 0.44 } = {}) {
  cell = Number.isFinite(cell) ? Math.max(0.2, Math.min(1, cell)) : 0.44;
  const { east, north } = tangentBasis(center);
  const polygon = rim.map((n) => {
    const depth = Math.max(0.1, n.dot(center));
    return [n.dot(east) / depth * radius, n.dot(north) / depth * radius];
  });
  const inside = (x, z) => {
    let found = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [ax, az] = polygon[i], [bx, bz] = polygon[j];
      if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) found = !found;
    }
    return found;
  };
  const builder = pavingBuilder(materialFactory, terrainRadius, lift, color);
  const minX = Math.max(-8, Math.min(...polygon.map((p) => p[0])));
  const maxX = Math.min(8, Math.max(...polygon.map((p) => p[0])));
  const minZ = Math.max(-8, Math.min(...polygon.map((p) => p[1])));
  const maxZ = Math.min(8, Math.max(...polygon.map((p) => p[1])));
  let count = 0;
  for (let z = Math.ceil(minZ / cell) * cell; z < maxZ; z += cell) {
    const row = Math.round(z / cell);
    for (let x = Math.ceil(minX / cell) * cell + (Math.abs(row) % 2) * cell / 2; x < maxX; x += cell) {
      const size = cell - 0.027;
      if (![[x, z], [x + size, z], [x, z + size], [x + size, z + size]].every(([a, b]) => inside(a, b))) continue;
      if (count++ >= 420) return builder.finish('plaza');
      builder.tile((u, v) => center.clone().addScaledVector(east, (x + size * u) / radius)
        .addScaledVector(north, (z + size * v) / radius), (Math.abs(row + Math.round(x / cell)) % 3) * 0.024);
    }
  }
  return builder.finish('plaza');
}
