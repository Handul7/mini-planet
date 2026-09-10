import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { mergeGeometries } from '../vendor/three/examples/jsm/utils/BufferGeometryUtils.js';
import { paperCutGeometry } from '../src/paper-style.js?v=97';
import { makePaperRelief } from '../src/world/paper-assets.js';

const materialFactory = (color) => new THREE.MeshToonMaterial({ color });
const edge = 0xf4f0e7;

// Independent v103 construction oracle: extrude every layer, then merge.
function originalRelief({ template, color, layers, step }) {
  const pieces = [];
  const colorize = (geometry, tint) => {
    const face = new THREE.Color(tint);
    const cut = new THREE.Color(edge);
    const normals = geometry.attributes.normal;
    const colors = new Float32Array(normals.count * 3);
    for (let i = 0; i < normals.count; i++) {
      (Math.abs(normals.getZ(i)) > 0.5 ? face : cut).toArray(colors, i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.clearGroups();
    return geometry;
  };
  for (let i = 0; i < layers; i++) {
    const progress = i / Math.max(1, layers - 1);
    const tint = i === 0 ? edge : new THREE.Color(color).lerp(new THREE.Color(0xffffff), progress * 0.24);
    const geometry = colorize(paperCutGeometry(template, 0.05), tint);
    geometry.scale(1 - progress * 0.32, 1 - progress * 0.25, 1);
    geometry.translate(0, progress * 0.06, (i - (layers - 1) / 2) * step);
    pieces.push(geometry);
  }
  if (template === 'blossom') {
    const points = Array.from({ length: 10 }, (_, i) => {
      const angle = i / 10 * Math.PI * 2;
      return new THREE.Vector2(Math.cos(angle) * 0.15, 0.06 + Math.sin(angle) * 0.15);
    });
    const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(points), {
      depth: 0.035, bevelEnabled: false, steps: 1, curveSegments: 1,
    });
    geometry.translate(0, 0, -0.035 / 2);
    colorize(geometry, 0xf2ca73);
    geometry.translate(0, 0, (layers - 1) / 2 * step + 0.047);
    pieces.push(geometry);
  }
  const merged = mergeGeometries(pieces, false);
  pieces.forEach((geometry) => geometry.dispose());
  return merged;
}

function assertSameGeometry(actual, expected) {
  assert.equal(actual.index, expected.index);
  assert.deepEqual(Object.keys(actual.attributes), Object.keys(expected.attributes));
  assert.deepEqual(actual.groups, expected.groups);
  for (const name of Object.keys(expected.attributes)) {
    const a = actual.attributes[name], b = expected.attributes[name];
    assert.equal(a.itemSize, b.itemSize);
    assert.equal(a.normalized, b.normalized);
    assert.deepEqual(a.array, b.array, `${name} must remain bit-for-bit identical`);
  }
  actual.computeBoundingBox(); expected.computeBoundingBox();
  assert.deepEqual(actual.boundingBox, expected.boundingBox);
}

test('relief optimization preserves every triangle attribute, layer, and bound', () => {
  for (const template of ['leaf', 'pine', 'hull', 'stone', 'blossom']) {
    for (const layers of [1, 2, 3, 5, 6, 2.5]) {
      for (const step of [0, 0.055, 0.10]) {
        const options = { template, color: 0x72c8c5, layers, step };
        const mesh = makePaperRelief(materialFactory, options);
        const expected = originalRelief(options);
        try {
          assertSameGeometry(mesh.geometry, expected);
          assert.equal(mesh.userData.paperLayers, layers);
          assert.equal(mesh.userData.paperConstruction, 'layered-cut-card');
          assert.ok(mesh.isMesh && mesh.castShadow && mesh.receiveShadow);
          assert.ok(mesh.material.vertexColors);
          assert.equal(mesh.children.length, 0);
          assert.deepEqual(mesh.position.toArray(), [0, 0, 0]);
          assert.deepEqual(mesh.scale.toArray(), [1, 1, 1]);
        } finally {
          expected.dispose(); mesh.geometry.dispose(); mesh.material.dispose();
        }
      }
    }
  }
});

test('reliefs triangulate their contour once per invocation, not once per layer', () => {
  const original = THREE.ShapeUtils.triangulateShape;
  let calls = 0;
  THREE.ShapeUtils.triangulateShape = function (...args) {
    calls++;
    return original.apply(this, args);
  };
  try {
    for (const [template, layers, before, after] of [
      ['stone', 6, 6, 1], ['hull', 5, 5, 1], ['blossom', 3, 4, 2], ['leaf', 1, 1, 1],
    ]) {
      const options = { template, color: 0x9ea6aa, layers, step: 0.055 };
      calls = 0;
      originalRelief(options).dispose();
      assert.equal(calls, before);
      for (let repeat = 0; repeat < 2; repeat++) {
        calls = 0;
        const mesh = makePaperRelief(materialFactory, options);
        assert.equal(calls, after, 'no repeated triangulation or cross-call cache');
        mesh.geometry.dispose(); mesh.material.dispose();
      }
    }
  } finally {
    THREE.ShapeUtils.triangulateShape = original;
  }
});

test('temporary sheets are disposed once; returned resources remain independent and editable', () => {
  const original = THREE.BufferGeometry.prototype.dispose;
  const disposed = [];
  THREE.BufferGeometry.prototype.dispose = function () {
    disposed.push(this);
    return original.call(this);
  };
  const meshes = [];
  try {
    for (const [template, layers] of [['stone', 6], ['hull', 5], ['blossom', 3], ['leaf', 1]]) {
      const count = layers + Number(template === 'blossom');
      const options = { template, layers, color: 0x9ea6aa };
      const start = disposed.length;
      const a = makePaperRelief(materialFactory, options);
      const b = makePaperRelief(materialFactory, options);
      meshes.push(a, b);
      const temporary = disposed.slice(start);
      assert.equal(temporary.length, count * 2);
      assert.equal(new Set(temporary).size, count * 2);
      assert.ok(!temporary.includes(a.geometry) && !temporary.includes(b.geometry));
      assert.notEqual(a.material, b.material);
      for (const name of Object.keys(a.geometry.attributes)) {
        assert.notEqual(a.geometry.attributes[name].array.buffer, b.geometry.attributes[name].array.buffer);
      }
      const snapshot = b.geometry.attributes.position.array.slice();
      a.geometry.translate(10, 20, 30);
      a.position.set(1, 2, 3); a.scale.set(2, 3, 4);
      assert.deepEqual(b.geometry.attributes.position.array, snapshot);
      let geometryDisposals = 0, materialDisposals = 0;
      a.geometry.addEventListener('dispose', () => geometryDisposals++);
      a.material.addEventListener('dispose', () => materialDisposals++);
      a.geometry.dispose(); a.material.dispose();
      assert.equal(geometryDisposals, 1);
      assert.equal(materialDisposals, 1);
      assert.deepEqual(b.geometry.attributes.position.array, snapshot);
      b.geometry.dispose(); b.material.dispose();
      meshes.splice(-2);
    }
  } finally {
    THREE.BufferGeometry.prototype.dispose = original;
    for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
});
