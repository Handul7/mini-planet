import * as THREE from '../../vendor/three/build/three.module.min.js';

const WIDTH = 1.12;
const DECK_LIFT = 0.115;
const POST_HEIGHT = 0.43;
const EDGE_OFFSET = 0.50;

export function makeFootbridge(points, {
  radius, terrainRadius, materialFactory, splineDirs, makeSurfaceRibbon,
  offsetSurfaceDir, placeOnSphereFacing, batchStaticMeshTree,
}) {
  const group = new THREE.Group();
  group.userData.districtRole = 'footbridge';
  if (!Array.isArray(points) || points.length < 2) return group;

  // Match the walk-zone sampling; the deck helper independently samples the
  // same spline so even a long two-point crossing follows the planet's curve.
  const sampled = splineDirs(points, { step: 0.025 }).dirs;
  const curve = sampled.filter((dir, index) => !index || dir.distanceToSquared(sampled[index - 1]) > 1e-12);
  if (curve.length < 2) return group;
  const distances = [0];
  for (let i = 1; i < curve.length; i++) {
    distances.push(distances[i - 1] + curve[i - 1].angleTo(curve[i]) * radius);
  }
  const length = distances.at(-1);
  if (!Number.isFinite(length) || length < 0.001) return group;

  const timber = materialFactory(0xb48b5e);
  const frame = materialFactory(0x816345);
  const seam = materialFactory(0x8d6b48);
  group.add(makeSurfaceRibbon(points, { width: WIDTH + 0.04, lift: 0.078, material: frame }));
  group.add(makeSurfaceRibbon(points, { width: WIDTH, lift: DECK_LIFT, material: timber }));

  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const makeBox = (width, height, depth, material) => {
    const mesh = new THREE.Mesh(boxGeometry, material);
    mesh.scale.set(width, height, depth);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  const frameAt = (distance) => {
    let i = 1;
    while (i < distances.length - 1 && distances[i] < distance) i++;
    const t = Math.max(0, Math.min(1, (distance - distances[i - 1]) / (distances[i] - distances[i - 1])));
    const dir = curve[i - 1].clone().lerp(curve[i], t).normalize();
    const forward = curve[i].clone().sub(curve[i - 1]);
    forward.sub(dir.clone().multiplyScalar(forward.dot(dir))).normalize();
    const side = new THREE.Vector3().crossVectors(dir, forward).normalize();
    return { dir, forward, side };
  };
  const edgeAt = (distance, sideSign) => {
    const frame = frameAt(distance);
    return { ...frame, dir: offsetSurfaceDir(frame.dir, frame.side, sideSign * EDGE_OFFSET / radius) };
  };

  // Leave the complete width open at both entrances. End posts are slightly
  // inset so their thickness does not project beyond the deck's endpoints.
  const inset = Math.min(0.055, length * 0.2);
  const postSegments = Math.min(40, Math.max(1, Math.round((length - inset * 2) / 0.6)));
  for (let i = 0; i <= postSegments; i++) {
    const distance = inset + (length - inset * 2) * i / postSegments;
    for (const sideSign of [-1, 1]) {
      const { dir, forward } = edgeAt(distance, sideSign);
      const post = makeBox(0.065, POST_HEIGHT, 0.065, frame);
      placeOnSphereFacing(post, dir, forward, DECK_LIFT + POST_HEIGHT / 2);
    }
  }

  // Rails use short chords between surface samples, never one straight beam
  // across the sea. Cap the segment count for unusually long edited paths.
  const railSegments = Math.min(160, Math.max(1, curve.length - 1));
  for (const sideSign of [-1, 1]) {
    for (const height of [0.20, 0.40]) {
      let previous = null;
      for (let i = 0; i <= railSegments; i++) {
        const { dir } = edgeAt(inset + (length - inset * 2) * i / railSegments, sideSign);
        const position = dir.clone().multiplyScalar(terrainRadius(dir) + DECK_LIFT + height);
        if (previous) {
          const forward = position.clone().sub(previous).normalize();
          const up = position.clone().add(previous).normalize();
          up.sub(forward.clone().multiplyScalar(up.dot(forward))).normalize();
          const right = new THREE.Vector3().crossVectors(up, forward).normalize();
          const rail = makeBox(0.047, 0.047, position.distanceTo(previous), timber);
          rail.position.copy(position).add(previous).multiplyScalar(0.5);
          rail.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward));
        }
        previous = position;
      }
    }
  }

  // Narrow cross-deck ribbons show the plank joints without making every
  // plank a separate raised box or adding a lip across either entrance.
  const plankCount = Math.min(64, Math.max(1, Math.round(length / 0.24)));
  for (let i = 1; i < plankCount; i++) {
    const { dir, side } = frameAt(length * i / plankCount);
    const across = [-1, 1].map((sign) => offsetSurfaceDir(dir, side, sign * (WIDTH / 2 - 0.015) / radius));
    group.add(makeSurfaceRibbon(across, { width: 0.012, lift: DECK_LIFT + 0.003, material: seam }));
  }

  batchStaticMeshTree(group);
  let boxStillUsed = false;
  group.traverse((object) => { if (object.geometry === boxGeometry) boxStillUsed = true; });
  if (!boxStillUsed) boxGeometry.dispose();
  return group;
}
