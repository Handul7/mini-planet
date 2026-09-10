import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { normalizeBoard, wrapBoardText } from '../src/village-board.js';
import { createStableSceneTarget, stabilizePaperShadows } from '../src/render-stability.js';

test('board input validates its schema, normalizes newlines and limits Unicode text', () => {
  assert.equal(normalizeBoard(null), null);
  assert.equal(normalizeBoard({ title: 123, body: 'body' }), null);
  const result = normalizeBoard({ title: '가'.repeat(60), body: '첫 줄\r\n둘째 줄\u0000' });
  assert.equal([...result.title].length, 48);
  assert.equal(result.body, '첫 줄\n둘째 줄');
  assert.equal([...normalizeBoard({ title: '안내', body: '별'.repeat(700) }).body].length, 600);
});

test('markup remains literal board text rather than being interpreted', () => {
  const value = { title: '<img src=x onerror=alert(1)>', body: '<script>alert(1)</script>' };
  assert.deepEqual(normalizeBoard(value), value);
});

test('board wrapping handles Korean, long words, blank lines and truncated previews', () => {
  const context = { measureText: (text) => ({ width: [...text].length * 10 }) };
  assert.deepEqual(wrapBoardText(context, '가나다라마바사\n\nabc', 40, 5), ['가나다라', '마바사', '', 'abc']);
  assert.deepEqual(wrapBoardText(context, 'abcdefghijklmnop', 40, 2), ['abcd', 'efg…']);
});

test('scene target enables bounded offscreen antialiasing with a WebGL1 fallback', () => {
  for (const [isWebGL2, maxSamples, expected] of [[true, 4, 2], [true, 1, 1], [false, 0, 0]]) {
    const target = createStableSceneTarget({ capabilities: { isWebGL2, maxSamples } }, 390, 844);
    assert.equal(target.samples, expected);
    assert.equal(target.width, 390); assert.equal(target.height, 844); target.dispose();
  }
});

test('paper self-shadow suppression preserves terrain receiving and object casting', () => {
  const root = new THREE.Group();
  const sheet = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshToonMaterial());
  const ground = sheet.clone();
  sheet.userData.paperConstruction = 'layered-cut-card';
  sheet.castShadow = sheet.receiveShadow = ground.receiveShadow = true;
  root.add(sheet, ground); stabilizePaperShadows(root);
  assert.equal(sheet.receiveShadow, false); assert.equal(sheet.castShadow, true);
  assert.equal(ground.receiveShadow, true);
});

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const context = vm.createContext({ THREE });
vm.runInContext([
  ...['tangentBasis', 'canonicalMapYaw', 'migrateVillageBoard'].map(fn),
  source.slice(source.indexOf('const MAP_CENTER ='), source.indexOf('const DEFAULT_PLAYER_SPAWN_DIR =')),
].join('\n'), context);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the central notice replaces the old decoration without duplication or input mutation', () => {
  const before = [{ type: 'resultBoard', x: -0.25, z: 0.26, scale: 0.72 }, { type: 'tree', n: [0, 1, 0] }];
  const copy = plain(before);
  const result = context.migrateVillageBoard(before);
  assert.deepEqual(before, copy);
  assert.equal(result.length, 2);
  assert.equal(result[0].scale, 0.90);
  assert.ok(result[0].n);
  assert.deepEqual(plain(context.migrateVillageBoard(result)), plain(result));
});

test('custom board positions and user scale are preserved', () => {
  const before = [{ type: 'resultBoard', n: [0, 1, 0], scale: 1.1 }];
  assert.deepEqual(plain(context.migrateVillageBoard(before)), before);
  assert.equal(context.migrateVillageBoard([]).length, 1);
});
