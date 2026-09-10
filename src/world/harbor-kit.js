import * as THREE from '../../vendor/three/build/three.module.min.js';
import { mergeGeometries } from '../../vendor/three/examples/jsm/utils/BufferGeometryUtils.js';
import { makePaperCanopy } from '../paper-style.js?v=97';
import { makePaperSlab } from './paper-assets.js?v=105';

function paperRoofPanels(specs, material) {
  const group = new THREE.Group();
  for (const spec of specs) {
    const panel = makePaperSlab((color) => new THREE.MeshToonMaterial({ color, gradientMap: material.gradientMap ?? null }), {
      width: spec.size[0], length: spec.size[2], color: material.color, depth: 0.035, gap: 0.02,
    });
    panel.position.set(...spec.position);
    panel.rotation.set(...(spec.rotation || [0, 0, 0]));
    group.add(panel);
  }
  return group;
}

function mergedBoxes(specs, material) {
  const geometries = specs.map((spec) => {
    const geometry = new THREE.BoxGeometry(...spec.size);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...(spec.rotation || [0, 0, 0])),
    );
    matrix.compose(
      new THREE.Vector3(...spec.position),
      quaternion,
      new THREE.Vector3(...(spec.scale || [1, 1, 1])),
    );
    geometry.applyMatrix4(matrix);
    return geometry;
  });
  const geometry = mergeGeometries(geometries, false);
  geometries.forEach((item) => item.dispose());
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function makeCottageArchitecture({ ownerKey, wallMaterial, roofMaterial, edgeMaterial, glassMaterial }) {
  const group = new THREE.Group();
  const side = ['yul', 'anne'].includes(ownerKey) ? -1 : 1;

  if (ownerKey === 'rodi') {
    group.userData.architectureProfile = 'signal-house';
    group.add(
      paperRoofPanels([
        { size: [1.30, 0.14, 1.08], position: [0, 3.55, -0.02] },
        { size: [1.08, 0.14, 0.92], position: [0, 4.22, -0.02] },
      ], roofMaterial),
      mergedBoxes([
        { size: [0.92, 0.58, 0.76], position: [0, 3.87, -0.02] },
      ], wallMaterial),
      mergedBoxes([
        { size: [0.58, 0.24, 0.045], position: [0, 3.90, 0.37] },
      ], glassMaterial),
      mergedBoxes([
        { size: [0.075, 0.78, 0.075], position: [0, 4.64, -0.02] },
        { size: [0.42, 0.055, 0.055], position: [0, 4.72, -0.02] },
      ], edgeMaterial),
    );
    return group;
  }

  if (['jarvis', 'yul'].includes(ownerKey)) {
    group.userData.architectureProfile = 'harbor-workshop';
    group.add(
      paperRoofPanels([
        { size: [1.92, 0.12, 0.78], position: [0, 2.34, 1.87], rotation: [-0.08, 0, 0] },
        { size: [0.78, 0.11, 0.68], position: [side * 0.90, 3.80, -0.30], rotation: [0, 0, side * 0.09] },
      ], roofMaterial),
      mergedBoxes([
        { size: [0.09, 1.46, 0.09], position: [-0.78, 0.77, 2.04] },
        { size: [0.09, 1.46, 0.09], position: [0.78, 0.77, 2.04] },
        { size: [0.66, 0.48, 0.56], position: [side * 0.90, 3.53, -0.30] },
      ], edgeMaterial),
      mergedBoxes([
        { size: [0.39, 0.24, 0.045], position: [side * 0.90, 3.55, 0.00] },
      ], glassMaterial),
    );
    return group;
  }

  group.userData.architectureProfile = 'garden-studio';
  group.add(
    paperRoofPanels([
      { size: [0.86, 0.14, 1.48], position: [side * 0.71, 3.54, -0.05], rotation: [0, 0, -side * 0.45] },
      { size: [0.94, 0.10, 1.56], position: [side * 0.70, 3.72, -0.05], rotation: [0, 0, -side * 0.45] },
    ], edgeMaterial),
    mergedBoxes([
      { size: [0.62, 0.055, 1.20], position: [side * 0.70, 3.70, -0.05], rotation: [0, 0, -side * 0.45] },
    ], glassMaterial),
    paperRoofPanels([
      { size: [1.08, 0.12, 0.68], position: [-side * 0.94, 2.18, 1.79], rotation: [-0.12, 0, 0] },
    ], roofMaterial),
  );
  return group;
}

function offsetPath(points, worldOffset, radius, closed = false) {
  return points.map((dir, index) => {
    const last = points.length - 1;
    const previous = points[closed && index === 0 ? last - 1 : Math.max(0, index - 1)];
    const next = points[closed && index === last ? 1 : Math.min(last, index + 1)];
    const forward = next.clone().sub(previous);
    forward.sub(dir.clone().multiplyScalar(forward.dot(dir))).normalize();
    const side = new THREE.Vector3().crossVectors(dir, forward).normalize();
    return dir.clone().add(side.multiplyScalar(worldOffset / radius)).normalize();
  });
}

export function splitBoundaryRuns(points, isOpening) {
  const runs = [];
  let run = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const midpoint = a.clone().add(b).normalize();
    if (isOpening(a) || isOpening(b) || isOpening(midpoint)) {
      if (run.length >= 2) runs.push(run);
      run = [];
    } else {
      if (!run.length) run.push(a);
      run.push(b);
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

export function makeStreetEdges(points, {
  radius,
  roadWidth,
  splineDirs,
  makeSurfaceRibbon,
  materialFactory,
  isOpening = () => false,
}) {
  const { dirs: curve, closed } = splineDirs(points, { step: 0.012 });
  if (closed && curve.length) curve.push(curve[0].clone());
  const edgeOffset = roadWidth * 0.57;
  const left = offsetPath(curve, edgeOffset, radius, closed);
  const right = offsetPath(curve, -edgeOffset, radius, closed);
  const runs = [...splitBoundaryRuns(left, isOpening), ...splitBoundaryRuns(right, isOpening)];
  const baseMaterial = materialFactory(0xa8b3ac);
  const topMaterial = materialFactory(0xe8e1cf);
  const group = new THREE.Group();
  for (const [material, width, lift] of [[baseMaterial, 0.11, 0.171], [topMaterial, 0.055, 0.186]]) {
    const geometries = runs.map((run) => makeSurfaceRibbon(run, { width, lift, material }).geometry);
    if (!geometries.length) { material.dispose(); continue; }
    const mesh = new THREE.Mesh(mergeGeometries(geometries, false), material);
    geometries.forEach((geometry) => geometry.dispose());
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.districtRole = 'street-boundary';
  group.userData.boundaryRuns = runs.length;
  return group;
}

export function makeHedgeLine(points, { radius, terrainRadius, splineDirs, materialFactory }) {
  const curve = splineDirs(points, { step: 0.045 }).dirs;
  const sheet = makePaperCanopy(materialFactory, { color: 0xffffff }).children[0];
  const geometry = sheet.geometry;
  geometry.scale(0.30, 0.28, 0.30);
  const material = sheet.material;
  const hedge = new THREE.InstancedMesh(geometry, material, curve.length);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const upAxis = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  curve.forEach((dir, index) => {
    quaternion.setFromUnitVectors(upAxis, dir);
    const height = 0.82 + (index % 3) * 0.08;
    matrix.compose(
      dir.clone().multiplyScalar(terrainRadius(dir) + 0.19),
      quaternion,
      new THREE.Vector3(1.15 + (index % 2) * 0.10, height, 0.92),
    );
    hedge.setMatrixAt(index, matrix);
    hedge.setColorAt(index, color.setHex(index % 3 === 0 ? 0x5f8369 : 0x78977a));
  });
  hedge.instanceMatrix.needsUpdate = true;
  if (hedge.instanceColor) hedge.instanceColor.needsUpdate = true;
  hedge.castShadow = true;
  hedge.receiveShadow = false;
  hedge.userData.districtRole = 'soft-boundary';
  return hedge;
}

function orientedBoxGeometry(size, position, up, forward) {
  const side = new THREE.Vector3().crossVectors(up, forward).normalize();
  const basis = new THREE.Matrix4().makeBasis(side, up, forward);
  basis.setPosition(position);
  const scale = new THREE.Matrix4().makeScale(...size);
  return new THREE.BoxGeometry(1, 1, 1).applyMatrix4(basis.multiply(scale));
}

export function makeQuayRail(points, { radius, terrainRadius, splineDirs, materialFactory }) {
  const curve = splineDirs(points, { step: 0.052 }).dirs;
  const posts = [];
  const rails = [];
  for (let index = 0; index < curve.length; index++) {
    const dir = curve[index];
    const previous = curve[Math.max(0, index - 1)];
    const next = curve[Math.min(curve.length - 1, index + 1)];
    const forward = next.clone().sub(previous)
      .sub(dir.clone().multiplyScalar(next.clone().sub(previous).dot(dir))).normalize();
    if (index % 3 === 0 || index === curve.length - 1) {
      posts.push(orientedBoxGeometry(
        [0.075, 0.58, 0.075],
        dir.clone().multiplyScalar(terrainRadius(dir) + 0.33),
        dir,
        forward,
      ));
    }
    if (index === curve.length - 1) continue;
    const nextDir = curve[index + 1];
    const mid = dir.clone().add(nextDir).normalize();
    const segmentForward = nextDir.clone().sub(dir)
      .sub(mid.clone().multiplyScalar(nextDir.clone().sub(dir).dot(mid))).normalize();
    const length = dir.angleTo(nextDir) * radius * 1.04;
    for (const height of [0.24, 0.50]) {
      rails.push(orientedBoxGeometry(
        [0.055, 0.055, length],
        mid.clone().multiplyScalar(terrainRadius(mid) + height),
        mid,
        segmentForward,
      ));
    }
  }
  const material = materialFactory(0x53666a);
  const group = new THREE.Group();
  for (const geometries of [posts, rails]) {
    if (!geometries.length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(geometries, false), material);
    geometries.forEach((geometry) => geometry.dispose());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.districtRole = 'quay-rail';
  return group;
}
