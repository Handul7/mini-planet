import * as THREE from '../vendor/three/build/three.module.min.js';
import { mergeGeometries } from '../vendor/three/examples/jsm/utils/BufferGeometryUtils.js';
import { PAPER_CONTOURS } from '../assets/papercut/contours.js?v=97';

// Shared by all paper materials, including imported models without UVs.
// Local-space sampling keeps the grain attached to moving and edited objects.
const size = 128;
const pixels = new Uint8Array(size * size * 4);
let seed = 9137;
for (let i = 0; i < size * size; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const value = 218 + (seed % 38);
  pixels.set([value, value, value, 255], i * 4);
}
const grain = new THREE.DataTexture(pixels, size, size);
grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
grain.minFilter = THREE.LinearMipmapLinearFilter;
grain.magFilter = THREE.LinearFilter;
grain.generateMipmaps = true;
grain.needsUpdate = true;

export function applyPaperSurface(material) {
  if (!material?.isMeshToonMaterial || material.userData.paperSurface) return material;
  material.userData.paperSurface = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.paperGrain = { value: grain };
    shader.vertexShader = 'varying vec3 vPaperPosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvPaperPosition = position;');
    shader.fragmentShader = 'uniform sampler2D paperGrain;\nvarying vec3 vPaperPosition;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float paperFiber = texture2D(paperGrain, (vPaperPosition.xy + vPaperPosition.z * vec2(0.37, 0.61)) * 0.85).r;
      float fiberContrast = clamp((paperFiber - 0.855) / 0.145, 0.0, 1.0);
      diffuseColor.rgb *= mix(0.965, 1.025, fiberContrast);
    `);
  };
  material.customProgramCacheKey = () => 'handul-paper-surface-v2';
  return material;
}

export function applyPaperObject(root) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach(applyPaperSurface);
  });
  return root;
}

export function paperCutGeometry(template, depth = 0.065) {
  const points = PAPER_CONTOURS[template];
  if (!points) throw new Error(`Unknown paper template: ${template}`);
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: false, steps: 1, curveSegments: 1,
  });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

export function makePaperCanopy(materialFactory, { pine = false, color = 0x76ad8c } = {}) {
  const group = new THREE.Group();
  const material = materialFactory(0xffffff);
  material.vertexColors = true;
  const face = new THREE.Color(color);
  const inset = face.clone().lerp(new THREE.Color(0xe7f0ce), 0.32);
  const edge = new THREE.Color(0xf4f0e7);
  // Interlocking, double-sided paper sandwiches keep depth from every orbit.
  // Vertex colors distinguish the cut edge without extra material passes.
  const pieces = [];
  for (let i = 0; i < 3; i++) {
    for (const layer of [0, -1, 1, -2, 2]) {
      const geometry = paperCutGeometry(pine ? 'pine' : 'leaf', layer === 0 ? 0.065 : 0.04);
      if (layer !== 0) {
        const level = Math.abs(layer);
        geometry.scale(1 - level * 0.15, 1 - level * 0.13, 1);
        geometry.translate(0, level * 0.045, layer * 0.075);
      }
      const normals = geometry.attributes.normal;
      const colors = new Float32Array(normals.count * 3);
      for (let v = 0; v < normals.count; v++) {
        const tint = Math.abs(normals.getZ(v)) < 0.5 || layer === 0 ? edge : Math.abs(layer) === 1 ? face : inset;
        tint.toArray(colors, v * 3);
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.clearGroups();
      geometry.applyMatrix4(new THREE.Matrix4().makeRotationY(i * Math.PI / 3));
      pieces.push(geometry);
    }
    for (const side of [-1, 1]) {
      const shape = new THREE.Shape([
        new THREE.Vector2(-0.018, -0.23), new THREE.Vector2(0.018, -0.23),
        new THREE.Vector2(0.008, 0.69), new THREE.Vector2(-0.006, 0.69),
      ]);
      const vein = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false, steps: 1 });
      vein.translate(0, 0, side > 0 ? 0.174 : -0.186);
      const colors = new Float32Array(vein.attributes.position.count * 3);
      const tint = inset.clone().lerp(edge, 0.36);
      for (let v = 0; v < vein.attributes.position.count; v++) tint.toArray(colors, v * 3);
      vein.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      vein.clearGroups();
      vein.rotateY(i * Math.PI / 3);
      pieces.push(vein);
    }
  }
  const sheet = new THREE.Mesh(mergeGeometries(pieces, false), material);
  pieces.forEach((geometry) => geometry.dispose());
  sheet.castShadow = true;
  // Interlocking sheets retain colored relief without noisy self-shadow bands.
  sheet.receiveShadow = false;
  group.add(sheet);
  group.userData.paperLayers = 3;
  group.userData.sheetsPerPlane = 5;
  return group;
}
