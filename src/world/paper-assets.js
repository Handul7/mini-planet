import * as THREE from '../../vendor/three/build/three.module.min.js';
import { mergeGeometries } from '../../vendor/three/examples/jsm/utils/BufferGeometryUtils.js';
import { paperCutGeometry } from '../paper-style.js?v=97';

const CUT_EDGE = 0xf4f0e7;
const rectangle = (w, h, x = 0, y = 0) => [
  [x - w / 2, y - h / 2], [x + w / 2, y - h / 2],
  [x + w / 2, y + h / 2], [x - w / 2, y + h / 2],
];

function colorPaper(geometry, color, edge = CUT_EDGE) {
  const faceColor = new THREE.Color(color);
  const edgeColor = new THREE.Color(edge);
  const normal = geometry.attributes.normal;
  const colors = new Float32Array(normal.count * 3);
  for (let i = 0; i < normal.count; i++) {
    (Math.abs(normal.getZ(i)) > 0.5 ? faceColor : edgeColor).toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.clearGroups();
  return geometry;
}

function cutPanel(points, { depth = 0.06, color, edge = CUT_EDGE, holes = [] }) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  shape.holes = holes.map((points) => new THREE.Path(points.map(([x, y]) => new THREE.Vector2(x, y))));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: 1 });
  geometry.translate(0, 0, -depth / 2);
  return colorPaper(geometry, color, edge);
}

function paperMesh(pieces, materialFactory) {
  const material = materialFactory(0xffffff);
  material.vertexColors = true;
  const geometry = mergeGeometries(pieces, false);
  pieces.forEach((piece) => piece.dispose());
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.userData.paperConstruction = 'layered-cut-card';
  return mesh;
}

// Color is baked into vertices: several cut sheets still cost one draw call.
export function makePaperSlab(materialFactory, { width, length, color, layers = 3, depth = 0.045, gap = 0.022, folds = 0 }) {
  const pieces = [];
  for (let i = 0; i < layers; i++) {
    const inset = 1 - i * 0.065;
    const tint = i === 0 ? CUT_EDGE : i === layers - 1
      ? new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.12)
      : new THREE.Color(color).multiplyScalar(0.64);
    const geometry = cutPanel(rectangle(width * inset, length * inset), { depth, color: tint });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, i * (depth + gap), 0);
    pieces.push(geometry);
  }
  for (let i = 1; i <= folds; i++) {
    const crease = cutPanel(rectangle(width * 0.016, length * 0.82), {
      depth: 0.008, color: new THREE.Color(color).multiplyScalar(0.78),
      edge: new THREE.Color(color).multiplyScalar(0.78),
    });
    crease.rotateX(-Math.PI / 2);
    crease.translate(width * 0.82 * (i / (folds + 1) - 0.5), (layers - 1) * (depth + gap) + depth / 2 + 0.006, 0);
    pieces.push(crease);
  }
  const mesh = paperMesh(pieces, materialFactory);
  mesh.userData.paperLayers = layers;
  return mesh;
}

export function makePaperWindowTrim(materialFactory, { accent }) {
  const pieces = [];
  const ink = new THREE.Color(accent).lerp(new THREE.Color(0x52646b), 0.35);
  const windows = [
    { x: -1.12, y: 1.45, z: 1.755, w: 0.75, h: 0.75, angle: 0 },
    { x: 1.12, y: 1.45, z: 1.755, w: 0.75, h: 0.75, angle: 0 },
    { x: 0, y: 1.45, z: -1.755, w: 0.97, h: 0.75, angle: Math.PI },
    { x: -1.865, y: 1.42, z: 0.2, w: 0.83, h: 0.69, angle: -Math.PI / 2 },
    { x: 1.865, y: 1.42, z: 0.2, w: 0.83, h: 0.69, angle: Math.PI / 2 },
  ];
  for (const window of windows) {
    const { w, h } = window;
    const outer = cutPanel(rectangle(w + 0.16, h + 0.16), {
      color: CUT_EDGE, depth: 0.045, holes: [rectangle(w, h)],
    });
    const inner = cutPanel(rectangle(w + 0.025, h + 0.025), {
      color: ink, depth: 0.025, holes: [rectangle(w - 0.05, h - 0.05)],
    });
    inner.translate(0, 0, 0.027);
    const vertical = cutPanel(rectangle(0.035, h), { color: CUT_EDGE, depth: 0.025 });
    const horizontal = cutPanel(rectangle(w, 0.035, 0, h * 0.09), { color: CUT_EDGE, depth: 0.025 });
    vertical.translate(0, 0, 0.023);
    horizontal.translate(0, 0, 0.023);
    for (const part of [outer, inner, vertical, horizontal]) {
      part.rotateY(window.angle);
      part.translate(window.x, window.y, window.z);
      pieces.push(part);
    }
  }
  const vent = cutPanel([[0, 0.21], [-0.21, 0], [0, -0.21], [0.21, 0]], {
    color: CUT_EDGE, depth: 0.035,
    holes: [[[0, 0.125], [0.125, 0], [0, -0.125], [-0.125, 0]]],
  });
  vent.translate(0, 2.87, 1.75);
  pieces.push(vent);
  const mesh = paperMesh(pieces, materialFactory);
  mesh.userData.windowCount = windows.length;
  return mesh;
}

export function makePaperDoor(materialFactory, { width, height, color }) {
  const leaf = new THREE.Color(color).lerp(new THREE.Color(0x63716b), 0.30);
  const pieces = [cutPanel(rectangle(width, height), { depth: 0.08, color: leaf })];
  for (const y of [-height * 0.245, height * 0.24]) {
    const w = width * 0.72;
    const h = height * 0.36;
    const panel = cutPanel(rectangle(w, h, 0, y), { color: leaf.clone().lerp(new THREE.Color(0xffffff), 0.12), depth: 0.018 });
    panel.translate(0, 0, 0.052);
    const frame = cutPanel(rectangle(w + 0.04, h + 0.04, 0, y), {
      color: leaf.clone().lerp(new THREE.Color(CUT_EDGE), 0.42), depth: 0.022,
      holes: [rectangle(w - 0.025, h - 0.025, 0, y)],
    });
    frame.translate(0, 0, 0.068);
    pieces.push(panel, frame);
  }
  const knob = Array.from({ length: 8 }, (_, i) => {
    const a = i / 8 * Math.PI * 2;
    return [width * 0.34 + Math.cos(a) * width * 0.044, -height * 0.045 + Math.sin(a) * width * 0.044];
  });
  const handle = cutPanel(knob, { color: 0xe4ba65, edge: 0xb68b4d, depth: 0.036 });
  handle.translate(0, 0, 0.096);
  pieces.push(handle);
  return paperMesh(pieces, materialFactory);
}

export function makePaperHouseShell(materialFactory, { wall, accent }) {
  const pieces = [];
  for (let layer = 0; layer < 3; layer++) {
    const width = 1.83 - layer * 0.09;
    const top = 2.62 - layer * 0.06;
    const peak = 3.53 - layer * 0.06;
    const bottom = 0.25 + layer * 0.025;
    const color = layer === 0 ? CUT_EDGE : layer === 1
      ? new THREE.Color(wall).lerp(new THREE.Color(accent), 0.38).multiplyScalar(0.67) : wall;
    const windowSize = 0.68 + layer * 0.035;
    const facade = [[-width, bottom], [-0.47, bottom], [-0.47, 1.85], [0.47, 1.85],
      [0.47, bottom], [width, bottom], [width, top], [0, peak], [-width, top]];
    const front = cutPanel(facade, { color, holes: [-1.12, 1.12].map((x) => rectangle(windowSize, windowSize, x, 1.45)) });
    front.translate(0, 0, 1.54 + layer * 0.08);
    pieces.push(front);
    const back = cutPanel([[-width, bottom], [width, bottom], [width, top], [0, peak], [-width, top]], {
      color, holes: [rectangle(0.90 + layer * 0.035, windowSize, 0, 1.45)],
    });
    back.translate(0, 0, -1.54 - layer * 0.08);
    pieces.push(back);
    for (const side of [-1, 1]) {
      const panel = cutPanel(rectangle(3.15 - layer * 0.05, 2.32 - layer * 0.05, 0, 1.43), {
        color, holes: [rectangle(0.76 + layer * 0.035, 0.62 + layer * 0.035, -side * 0.2, 1.42)],
      });
      panel.rotateY(side * Math.PI / 2);
      panel.translate(side * (1.65 + layer * 0.08), 0, 0);
      pieces.push(panel);
    }
  }
  const mesh = paperMesh(pieces, materialFactory);
  mesh.userData.paperLayers = 3;
  mesh.userData.cutWindows = 5;
  return mesh;
}

export function makePaperRelief(materialFactory, { template = 'leaf', color, layers = 5, step = 0.055 }) {
  const pieces = [];
  let contour;
  for (let i = 0; i < layers; i++) {
    const progress = i / Math.max(1, layers - 1);
    const tint = i === 0 ? CUT_EDGE : new THREE.Color(color).lerp(new THREE.Color(0xffffff), progress * 0.24);
    // Extrude once per relief; consume the pristine source on the last layer.
    // BufferGeometry.copy avoids ExtrudeGeometry.clone's extra constructor work.
    contour ??= paperCutGeometry(template, 0.05);
    const geometry = colorPaper(i + 1 >= layers ? contour : new THREE.BufferGeometry().copy(contour), tint);
    geometry.scale(1 - progress * 0.32, 1 - progress * 0.25, 1);
    geometry.translate(0, progress * 0.06, (i - (layers - 1) / 2) * step);
    pieces.push(geometry);
  }
  if (template === 'blossom') {
    const points = Array.from({ length: 10 }, (_, i) => {
      const a = i / 10 * Math.PI * 2;
      return [Math.cos(a) * 0.15, 0.06 + Math.sin(a) * 0.15];
    });
    const center = cutPanel(points, { depth: 0.035, color: 0xf2ca73, edge: CUT_EDGE });
    center.translate(0, 0, (layers - 1) / 2 * step + 0.047);
    pieces.push(center);
  }
  const mesh = paperMesh(pieces, materialFactory);
  mesh.userData.paperLayers = layers;
  return mesh;
}

export function makePaperTierRoof(materialFactory, { radius, height, color, tiers = 5, sides = 8 }) {
  const pieces = [];
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const r = radius * (1 - t * 0.82);
    const points = Array.from({ length: sides }, (_, n) => {
      const angle = n / sides * Math.PI * 2;
      return [Math.cos(angle) * r, Math.sin(angle) * r];
    });
    const tint = i === 0 ? CUT_EDGE : new THREE.Color(color).lerp(new THREE.Color(0xffffff), t * 0.20);
    const geometry = cutPanel(points, { depth: height / tiers * 0.62, color: tint });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, height * t, 0);
    pieces.push(geometry);
  }
  const mesh = paperMesh(pieces, materialFactory);
  mesh.userData.paperLayers = tiers;
  return mesh;
}

export function makePaperTower(materialFactory, { bottomRadius, topRadius, height, color, layers = 16 }) {
  const pieces = [];
  for (let i = 0; i < layers; i++) {
    const t = (i + 0.5) / layers;
    const radius = THREE.MathUtils.lerp(bottomRadius, topRadius, t);
    const points = Array.from({ length: 10 }, (_, n) => {
      const angle = n / 10 * Math.PI * 2;
      return [Math.cos(angle) * radius, Math.sin(angle) * radius];
    });
    const geometry = cutPanel(points, { depth: height / layers * 0.82, color: CUT_EDGE, edge: color });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, (t - 0.5) * height, 0);
    pieces.push(geometry);
  }
  const mesh = paperMesh(pieces, materialFactory);
  mesh.userData.paperLayers = layers;
  return mesh;
}

export function makePaperRose(materialFactory, { petal, core, leaf, stem }) {
  const group = new THREE.Group();
  const stemPieces = [];
  for (const angle of [0, Math.PI / 2]) {
    const stalk = cutPanel([[-0.035, 0.16], [0.035, 0.16], [0.025, 1.66], [-0.025, 1.66]], {
      depth: 0.035, color: stem,
    });
    stalk.rotateY(angle); stemPieces.push(stalk);
  }
  for (const [x, y, tilt] of [[0.16, 0.72, -0.8], [-0.16, 1.08, 0.8]]) {
    for (let layer = 0; layer < 3; layer++) {
      const geometry = colorPaper(paperCutGeometry('leaf', 0.028), layer === 0 ? CUT_EDGE
        : new THREE.Color(leaf).multiplyScalar(layer === 1 ? 0.65 : 1));
      geometry.scale(0.25 - layer * 0.035, 0.30 - layer * 0.028, 1);
      geometry.rotateZ(tilt);
      geometry.translate(x, y, layer * 0.038);
      stemPieces.push(geometry);
    }
  }
  const stemMesh = paperMesh(stemPieces, materialFactory);
  stemMesh.receiveShadow = false;
  group.add(stemMesh);
  const petals = [];
  for (let ring = 0; ring < 2; ring++) {
    const count = ring === 0 ? 7 : 5;
    for (let i = 0; i < count; i++) {
      const angle = i / count * Math.PI * 2 + ring * 0.48;
      const shape = [[-0.07, -0.10], [-0.14, 0.04], [-0.11, 0.19], [0, 0.25],
        [0.11, 0.19], [0.14, 0.04], [0.07, -0.10], [0, -0.14]];
      const geometry = cutPanel(shape, { depth: 0.035,
        color: ring === 0 ? petal : new THREE.Color(petal).lerp(new THREE.Color(core), 0.35),
        edge: new THREE.Color(petal).lerp(new THREE.Color(CUT_EDGE), 0.52),
      });
      if (ring) geometry.scale(0.76, 0.78, 1);
      geometry.rotateX(0.32 - ring * 0.12);
      geometry.rotateY(-angle);
      geometry.translate(Math.cos(angle) * (0.13 - ring * 0.055), ring * 0.035,
        Math.sin(angle) * (0.13 - ring * 0.055));
      petals.push(geometry);
    }
  }
  const head = paperMesh(petals, materialFactory);
  head.position.y = 1.70;
  head.receiveShadow = false;
  head.userData.paperPetals = 12;
  group.add(head);
  group.userData.roseHead = head;
  group.userData.paperConstruction = 'folded-paper-rose';
  return group;
}
