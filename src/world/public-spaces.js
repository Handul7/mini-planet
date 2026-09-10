import * as THREE from '../../vendor/three/build/three.module.min.js';
import { mergeGeometries } from '../../vendor/three/examples/jsm/utils/BufferGeometryUtils.js';
import { makePaperSlab, makePaperTierRoof } from './paper-assets.js?v=105';

// Fixed furnishings share a vertex-colored batch; the layered roof and deck
// reuse the same paper construction as the homes without adding textures.
export function makePaperPublicSpace(materialFactory, kind = 'garden') {
  const harbor = kind === 'harbor';
  const group = new THREE.Group();
  const pieces = [];
  const ink = 0x526b69, edge = 0xf4f0e7;
  const accent = harbor ? 0x7f9eac : 0x87a18a;
  function box(size, position, color) {
    const geometry = new THREE.BoxGeometry(...size);
    geometry.translate(...position);
    const rgb = new THREE.Color(color);
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < geometry.attributes.position.count; i++) rgb.toArray(colors, i * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.clearGroups();
    pieces.push(geometry);
  }
  const deck = makePaperSlab(materialFactory, {
    width: 2.36, length: 1.94, color: harbor ? 0xac9186 : 0xbac5ae,
    depth: 0.035, gap: 0.016, folds: 6,
  });
  deck.position.y = 0.09;
  group.add(deck);
  for (const x of [-0.92, 0.92]) for (const z of [-0.68, 0.68]) {
    box([0.11, 1.48, 0.11], [x, 0.94, z], ink);
    box([0.19, 0.10, 0.19], [x, 0.24, z], edge);
  }
  // Benches flank the open central entrance, never spanning the walkway.
  for (const x of [-0.80, 0.80]) {
    box([0.28, 0.07, 1.00], [x, 0.53, -0.08], accent);
    box([0.055, 0.32, 1.00], [x + Math.sign(x) * 0.14, 0.73, -0.08], edge);
    for (const z of [-0.46, 0.29]) box([0.12, 0.27, 0.12], [x, 0.36, z], ink);
  }
  box([1.88, 0.12, 0.13], [0, 1.59, -0.68], ink);
  box([1.88, 0.12, 0.13], [0, 1.59, 0.68], ink);
  if (harbor) {
    for (const side of [-1, 1]) {
      const roof = makePaperSlab(materialFactory, {
        width: 1.47, length: 2.25, color: accent, depth: 0.026, gap: 0.018, folds: 3,
      });
      roof.position.set(side * 0.60, 1.88, 0);
      roof.rotation.z = -side * 0.32;
      group.add(roof);
    }
    box([0.12, 0.10, 2.30], [0, 2.17, 0], edge);
    // A lifebuoy is a pictorial harbor cue, not another signboard.
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.045, 5, 12), materialFactory(0xd38672));
    ring.position.set(-0.93, 1.14, 0.78);
    ring.castShadow = true;
    group.add(ring);
  } else {
    const roof = makePaperTierRoof(materialFactory, { radius: 1.38, height: 0.48, color: accent, tiers: 6 });
    roof.position.y = 1.64;
    group.add(roof);
    box([0.48, 0.07, 0.44], [0, 0.68, -0.23], edge);
    box([0.13, 0.45, 0.13], [0, 0.43, -0.23], ink);
    box([0.075, 0.20, 0.075], [0, 2.15, 0], 0xd7ba70);
  }
  const material = materialFactory(0xffffff);
  material.vertexColors = true;
  const fixed = new THREE.Mesh(mergeGeometries(pieces, false), material);
  pieces.forEach((geometry) => geometry.dispose());
  fixed.castShadow = fixed.receiveShadow = true;
  group.add(fixed);
  group.userData.doorOffset = new THREE.Vector3(0, 0, 1.03);
  group.userData.publicSpaceKind = kind;
  group.userData.paperConstruction = 'layered-cut-card';
  return group;
}
