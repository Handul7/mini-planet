import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.min.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = await readFile(resolve(root, 'src/main.js'), 'utf8');
const extract = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};

function loaderContext(loadAsync) {
  const modelProtoCache = new Map();
  const ctx = vm.createContext({ THREE, modelProtoCache, TOON_GRAD: null, applyPaperObject() {},
    getGltfLoader: () => Promise.resolve({ loadAsync }) });
  vm.runInContext(extract('loadModelProto'), ctx);
  return { ctx, modelProtoCache };
}

test('model loading shares prototypes and materials without disposing shared textures', async () => {
  const scene = new THREE.Group(), geometry = new THREE.BoxGeometry(2, 4, 2);
  const map = new THREE.Texture(), original = new THREE.MeshStandardMaterial({ color: 0x88bb66, map });
  let loads = 0, disposed = 0, textureDisposals = 0;
  original.addEventListener('dispose', () => disposed++);
  map.addEventListener('dispose', () => textureDisposals++);
  scene.add(new THREE.Mesh(geometry, original), new THREE.Mesh(geometry, original), new THREE.Mesh(geometry, [original, original]));
  const { ctx } = loaderContext(async () => { loads++; return { scene }; });
  const a = ctx.loadModelProto('test.gltf', 2), b = ctx.loadModelProto('test.gltf', 2);
  assert.equal(a, b);
  const proto = await a;
  assert.equal(loads, 1);
  assert.equal(disposed, 1);
  assert.equal(textureDisposals, 0);
  assert.equal(scene.children[0].material, scene.children[1].material);
  assert.equal(scene.children[0].material, scene.children[2].material[1]);
  assert.equal(scene.children[0].material.map, map);
  assert.equal(scene.children[0].material.color.getHex(), 0x88bb66);
  assert.equal(scene.scale.y, 0.5);
  assert.equal(new THREE.Box3().setFromObject(proto).min.y, 0);
  assert.equal(proto.clone(true).children[0].children[0].geometry, geometry);
});

test('failed model loads can retry without retaining a rejected cache entry', async () => {
  let attempts = 0;
  const { ctx, modelProtoCache } = loaderContext(async () => {
    if (++attempts === 1) throw new Error('temporary offline');
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    return { scene };
  });
  await assert.rejects(ctx.loadModelProto('retry.gltf', 1), /temporary offline/);
  assert.equal(modelProtoCache.size, 0);
  await ctx.loadModelProto('retry.gltf', 1);
  assert.equal(attempts, 2);
  assert.equal(modelProtoCache.size, 1);
});

test('GLTF loader is requested only when a model is needed', async () => {
  const sw = await readFile(resolve(root, 'sw.js'), 'utf8');
  assert.doesNotMatch(source, /import\s+\{\s*GLTFLoader\s*\}\s+from/);
  assert.match(extract('getGltfLoader'), /import\('\.\.\/vendor\/three\/examples\/jsm\/loaders\/GLTFLoader.js'\)/);
  assert.doesNotMatch(sw.slice(sw.indexOf('const SHELL'), sw.indexOf('self.addEventListener')), /GLTFLoader/);
  assert.match(extract('getGltfLoader'), /gltfLoaderPromise = null; throw error/);
});

test('every bundled model binary and texture belongs to an editor registry entry', async () => {
  const used = new Set();
  const models = [...source.matchAll(/file:\s*'(assets\/models\/[^']+\.gltf)'/g)].map(m => m[1]);
  assert.equal(models.length, 9);
  for (const model of models) {
    used.add(model);
    const gltf = JSON.parse(await readFile(resolve(root, model), 'utf8'));
    for (const entry of [...gltf.buffers || [], ...gltf.images || []]) {
      if (!entry.uri || entry.uri.startsWith('data:')) continue;
      const path = resolve(root, dirname(model), decodeURIComponent(entry.uri));
      await readFile(path);
      used.add(relative(root, path));
    }
  }
  for (const entry of await readdir(resolve(root, 'assets/models'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(gltf|glb|bin|png|jpe?g)$/i.test(entry.name)) continue;
    const path = relative(root, resolve(entry.parentPath, entry.name));
    assert.ok(used.has(path), `unreferenced model resource: ${path}`);
  }
});

test('static module graph does not load the same source under different versions', async () => {
  const versions = new Map(), seen = new Set();
  async function visit(path) {
    if (seen.has(path)) return;
    seen.add(path);
    const text = await readFile(path, 'utf8');
    for (const [, specifier] of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      if (!specifier.startsWith('.')) continue;
      const url = new URL(specifier, `file://${path}`);
      const target = fileURLToPath(url);
      if (!target.endsWith('.js')) continue;
      if (versions.has(target)) assert.equal(versions.get(target), url.search, `duplicate module: ${relative(root, target)}`);
      versions.set(target, url.search);
      await visit(target);
    }
  }
  await visit(resolve(root, 'src/main.js'));
  assert.ok(versions.size > 20);
});
