import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { paperCutGeometry, applyPaperSurface, makePaperCanopy } from '../src/paper-style.js';

test('paper templates produce finite solid meshes with colored edge groups', () => {
  for (const name of ['leaf', 'pine', 'hull']) {
    const geometry = paperCutGeometry(name, 0.08);
    geometry.computeBoundingBox();
    assert.ok([...geometry.attributes.position.array].every(Number.isFinite));
    assert.ok(Math.abs(geometry.boundingBox.max.z - geometry.boundingBox.min.z - 0.08) < 1e-6);
    assert.deepEqual(geometry.groups.map((group) => group.materialIndex), [0, 1]);
    geometry.dispose();
  }
  assert.throws(() => paperCutGeometry('unknown'), /Unknown paper template/);
});

test('paper canopy presents three different planes and keeps real thickness', () => {
  const canopy = makePaperCanopy((color) => new THREE.MeshToonMaterial({ color }));
  assert.equal(canopy.children.length, 1);
  assert.equal(canopy.userData.paperLayers, 3);
  const [mesh] = canopy.children;
  assert.equal(mesh.material.vertexColors, true);
  assert.ok(mesh.geometry.attributes.color.count === mesh.geometry.attributes.position.count);
  assert.ok([...mesh.geometry.attributes.color.array].every(Number.isFinite));
  mesh.geometry.computeBoundingBox();
  const size = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
  assert.ok(size.x > 0.5 && size.z > 0.5);
  assert.equal(mesh.castShadow, true);
  assert.equal(mesh.receiveShadow, false);
});

test('paper surface keeps emissive and atlas settings and installs once', () => {
  const map = new THREE.Texture();
  const material = new THREE.MeshToonMaterial({ color: 0x579575, map, emissive: 0x334455, emissiveIntensity: 0.4 });
  applyPaperSurface(material);
  const compile = material.onBeforeCompile;
  applyPaperSurface(material);
  assert.equal(material.onBeforeCompile, compile);
  assert.equal(material.map, map);
  assert.equal(material.emissiveIntensity, 0.4);
  const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <color_fragment>' };
  compile(shader);
  assert.equal(shader.uniforms.paperGrain.value.image.width, 128);
  assert.match(shader.vertexShader, /vPaperPosition = position/);
  assert.match(shader.fragmentShader, /diffuseColor.rgb/);
});
