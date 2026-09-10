import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRoseStory, ROSE_LINES, ROSE_SOURCE } from '../src/rose-story.js';
import { makePaperRose, makePaperSlab, makePaperHouseShell } from '../src/world/paper-assets.js';
import * as THREE from '../vendor/three/build/three.module.min.js';

function storyHarness() {
  const page = { body: { appendChild() {} }, activeElement: null };
  class Element extends EventTarget {
    constructor() { super(); this.attrs = {}; this.isConnected = true; this.open = false; }
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key]; }
    focus() { page.activeElement = this; }
    click() { this.dispatchEvent(new Event('click')); }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent(new Event('close')); }
    remove() { this.isConnected = false; }
  }
  const opener = new Element(); opener.focus();
  const elements = Object.fromEntries(['blockquote', '.rose-story-pages span', '.rose-story-pages button', '.rose-story-close']
    .map((selector) => [selector, new Element()]));
  const dialog = new Element();
  dialog.querySelector = (selector) => elements[selector];
  page.createElement = () => dialog;
  let opens = 0;
  const story = createRoseStory({ document: page, onOpen: () => opens++ });
  return { story, page, opener, dialog, elements, opens: () => opens };
}

test('rose story advances three short attributed excerpts and restores focus', () => {
  const h = storyHarness();
  const next = h.elements['.rose-story-pages button'];
  assert.equal(h.story.open(), true);
  assert.equal(h.story.isOpen(), true);
  assert.equal(h.page.activeElement, next);
  assert.equal(h.elements.blockquote.textContent, ROSE_LINES[0]);
  assert.equal(h.story.open(), false); assert.equal(h.opens(), 1);
  next.click(); assert.equal(h.elements.blockquote.textContent, ROSE_LINES[1]);
  next.click(); assert.equal(next.getAttribute('aria-label'), '이야기 마치기');
  assert.equal(h.elements.blockquote.textContent, ROSE_LINES[2]);
  next.click(); assert.equal(h.story.isOpen(), false); assert.equal(h.page.activeElement, h.opener);
  h.story.open(); assert.equal(h.elements['.rose-story-pages span'].textContent, '1 / 3');
  assert.match(ROSE_SOURCE, /^https:\/\//);
});

test('close and disposal leave no lingering dialog, with a removed opener tolerated', () => {
  const h = storyHarness(); h.story.open();
  h.elements['.rose-story-close'].click(); assert.equal(h.story.isOpen(), false);
  h.opener.isConnected = false;
  h.story.open(); h.story.dispose();
  assert.equal(h.dialog.isConnected, false); assert.equal(h.story.isOpen(), false);
});

test('rose has twelve solid cut petals batched into two meshes without extra lights', () => {
  const rose = makePaperRose((color) => new THREE.MeshToonMaterial({ color }), {
    petal: 0xd91f4e, core: 0xa80f38, leaf: 0x63a86b, stem: 0x4e8f56,
  });
  const meshes = [];
  rose.traverse((obj) => { assert.ok(!obj.isLight); if (obj.isMesh) meshes.push(obj); });
  assert.equal(meshes.length, 2);
  assert.equal(rose.userData.roseHead.userData.paperPetals, 12);
  let triangles = 0;
  for (const mesh of meshes) {
    assert.equal(mesh.geometry.groups.length, 0);
    assert.equal(mesh.material.vertexColors, true);
    assert.equal(mesh.receiveShadow, false);
    assert.ok([...mesh.geometry.attributes.position.array].every(Number.isFinite));
    triangles += mesh.geometry.attributes.position.count / 3;
  }
  assert.ok(triangles < 900);
  const bounds = new THREE.Box3().setFromObject(rose);
  assert.ok(bounds.min.y >= 0 && bounds.max.y <= 2.05);
  assert.ok(bounds.max.x - bounds.min.x < 0.9);
  meshes.forEach((mesh) => { mesh.geometry.dispose(); mesh.material.dispose(); });
});

test('stronger roof and facade layers retain one material batch and the original footprint', () => {
  const material = (color) => new THREE.MeshToonMaterial({ color });
  const roof = makePaperSlab(material, { width: 2.24, length: 3.74, color: 0x52646b, folds: 3 });
  const house = makePaperHouseShell(material, { wall: 0xf7f5f0, accent: 0x72c8c5 });
  for (const mesh of [roof, house]) {
    assert.equal(mesh.children.length, 0); assert.equal(mesh.geometry.groups.length, 0);
    const c = mesh.geometry.attributes.color;
    const levels = Array.from({ length: c.count }, (_, i) => (c.getX(i) + c.getY(i) + c.getZ(i)) / 3);
    assert.ok(Math.max(...levels) - Math.min(...levels) > 0.30);
    mesh.geometry.computeBoundingBox();
  }
  assert.ok(house.geometry.boundingBox.max.x <= 1.86);
  assert.ok(Math.abs(roof.geometry.boundingBox.getSize(new THREE.Vector3()).x - 2.24) < 1e-6);
  [roof, house].forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
});

test('rose interactions reject drag, cancelled pointers, occluded clicks, and gameplay under a modal', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /onActivate: openRoseStory/);
  assert.match(source, /addEventListener\('pointercancel', \(\) => \{ clickStart = null; \}\)/);
  assert.match(source, /moved > 6 \|\| e.target !== renderer.domElement/);
  assert.match(source, /hit.distance < roseHit.distance - 0.01/);
  assert.match(source, /!villageBoard.isOpen\(\) && !roseStory.isOpen\(\)/);
});
