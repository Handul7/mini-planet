import * as THREE from '../../vendor/three/build/three.module.min.js';
import { makePaperCanopy } from '../paper-style.js?v=97';
import { makePaperSlab } from './paper-assets.js?v=110';

export function makeIslandMooring(materialFactory) {
  const group = new THREE.Group();
  const wood = materialFactory(0x607d82), paper = materialFactory(0xe3e9db);
  for (const x of [-0.52, 0.52]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.085, 0.68, 6), wood);
    post.position.set(x, 0.34, 0);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.07, 0.21), paper);
    cap.position.set(x, 0.70, 0);
    group.add(post, cap);
  }
  const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.30, 0.20), materialFactory(0xeacb83));
  lantern.position.set(-0.52, 0.87, 0);
  const hood = makePaperSlab(materialFactory, { width: 0.32, length: 0.30, color: 0x506a80 });
  hood.position.set(-0.52, 1.06, 0);
  group.add(lantern, hood);
  group.userData.placeRole = 'boarding-marker';
  return group;
}

export function makePaperGrove(materialFactory) {
  const group = new THREE.Group();
  const bark = materialFactory(0x6e7c6c);
  const trunks = new THREE.CylinderGeometry(0.035, 0.07, 0.65, 5);
  [[-0.34, -0.18, 0.86], [0.34, -0.12, 1.08], [0, 0.37, 0.73]].forEach(([x, z, scale], i) => {
    const trunk = new THREE.Mesh(trunks, bark);
    trunk.position.set(x, 0.31, z);
    const crown = makePaperCanopy(materialFactory, { pine: i === 1, color: [0x68967e, 0x467f77, 0xa6b778][i] });
    crown.scale.set(0.46 * scale, 0.65 * scale, 0.46 * scale);
    crown.position.set(x, 0.73, z);
    group.add(trunk, crown);
  });
  group.userData.placeRole = 'southern-grove';
  return group;
}

export function makeWindLookout(materialFactory) {
  const group = new THREE.Group();
  const ink = materialFactory(0x536c72);
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.78, 0.18, 8), ink);
  pedestal.position.y = 0.12;
  group.add(pedestal);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.10, 1.65, 6), ink);
  mast.position.y = 1.02;
  group.add(mast);
  for (let i = 0; i < 4; i++) {
    const leaf = makePaperSlab(materialFactory, { width: 0.48, length: 0.78,
      color: [0xe7cb79, 0xa5c2bd, 0xc5b4d2, 0xe6b49f][i], depth: 0.025, gap: 0.018 });
    const angle = i * Math.PI / 2;
    leaf.position.set(Math.sin(angle) * 0.36, 1.95 + Math.cos(angle) * 0.36, 0);
    leaf.rotation.x = Math.PI / 2;
    leaf.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), -angle + 0.40);
    group.add(leaf);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.16, 8), materialFactory(0xeacb83));
  hub.rotation.x = Math.PI / 2;
  hub.position.set(0, 1.95, 0.13);
  group.add(hub);
  group.userData.placeRole = 'wind-lookout';
  return group;
}
