import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { characterFixture, characterMetrics } from './character-fixture.mjs';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const { agents } = JSON.parse(await readFile(new URL('../config/agents.json', import.meta.url), 'utf8'));
const kit = characterFixture(source);

test('six costumes preserve the original round-headed animated rig and label clearance', () => {
  for (const agent of agents) {
    const model = kit.make(agent), data = model.userData;
    assert.equal(data.designRevision, 'rpg-paper-118');
    assert.equal(data.visualStyle, agent.visual.style);
    assert.equal(data.headRig.position.y, 1.055);
    assert.deepEqual(Object.keys(data.limbs), ['armL', 'armR', 'legL', 'legR']);
    for (const limb of Object.values(data.limbs)) assert.ok(limb.parent);
    const metrics = characterMetrics(model);
    assert.ok(metrics.max[1] < data.labelHeight - 0.1, agent.key);
    assert.ok(metrics.max[0] - metrics.min[0] < 1.2, agent.key);
    assert.ok(metrics.meshes <= 45, `${agent.key}: ${metrics.meshes} draw meshes`);
    assert.ok(metrics.triangles <= 6000, `${agent.key}: ${metrics.triangles} triangles`);
  }
});

test('costume silhouette details and signature tools are actually built', () => {
  const expected = {
    rodi: ['swept-hair', 'split-coat-back', 'conductor-tuning-fork'],
    jarvis: ['automaton-ear-disc', 'butler-cravat', 'split-coat-back'],
    ludwig: ['locked-research-book', 'scholar-scarf-tail'],
    anne: ['braid-segment', 'hat-leaf', 'forest-layered-skirt'],
    yul: ['resonance-ear-crystal', 'listener-wide-sleeve'],
    argos: ['pointed-paper-hood', 'hidden-hand-cuff', 'small-bronze-owl-vessel'],
  };
  for (const agent of agents) {
    const model = kit.make(agent, false);
    for (const name of expected[agent.key]) assert.ok(model.getObjectByName(name), `${agent.key}: ${name}`);
  }
});

test('accessories use the existing matte paper material and valid solid geometry', () => {
  for (const agent of agents) {
    kit.make(agent).traverse(part => {
      if (!part.isMesh) return;
      const attributes = part.geometry.attributes;
      for (const name of ['position', 'normal']) {
        assert.ok(attributes[name], `${agent.key}: ${name}`);
        assert.ok(Array.from(attributes[name].array).every(Number.isFinite));
      }
      if (part.material.isMeshToonMaterial) assert.equal(part.material.userData.paperSurface, true);
      assert.ok(!part.material.isMeshPhysicalMaterial);
    });
  }
});

test('walking and idle motion stay finite after static batching, including held tools', () => {
  for (const agent of agents) {
    const model = kit.make(agent);
    const initial = model.userData.limbs.legL.rotation.x;
    let moved = false;
    for (let frame = 0; frame < 120; frame++) {
      kit.animateCharacterWalk(model, frame < 60 ? 1 : 0, frame / 30);
      model.updateMatrixWorld(true);
      moved ||= model.userData.limbs.legL.rotation.x !== initial;
      model.traverse(part => assert.ok(part.matrixWorld.elements.every(Number.isFinite)));
      const box = new THREE.Box3().setFromObject(model);
      assert.ok(box.max.y < model.userData.labelHeight, agent.key);
    }
    assert.ok(moved, agent.key);
    if (agent.key === 'argos') assert.equal(model.userData.lockedSleeves, true);
  }
});

test('visitor character is not given any agent costume or altered proportions', () => {
  const visitor = kit.makeCharacter(0xcf7954, 0xffe8cf, 'visitor');
  assert.equal(visitor.userData.designRevision, undefined);
  assert.equal(visitor.userData.modelHeight, 1.35);
  assert.equal(visitor.userData.labelHeight, 1.62);
  assert.equal(visitor.getObjectByName('split-coat-back'), undefined);
});
