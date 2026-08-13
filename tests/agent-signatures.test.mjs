import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { AGENT_SIGNATURES, auditSignatureRoster, signatureForAgent } from '../src/agent-signatures.js';

const agentsConfig = JSON.parse(await readFile(new URL('../config/agents.json', import.meta.url), 'utf8'));
const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('all six configured agents have distinct release-ready signatures', () => {
  const audit = auditSignatureRoster(agentsConfig.agents);
  assert.equal(audit.status, 'ready');
  assert.equal(audit.score, 100);
  assert.equal(audit.covered, 6);
  assert.equal(new Set(Object.values(AGENT_SIGNATURES).map((item) => item.id)).size, 6);
});

test('unknown visual styles fail closed', () => {
  assert.equal(signatureForAgent({ visual: { style: 'not-registered' } }), null);
  const audit = auditSignatureRoster([{
    key: 'unknown',
    visual: { style: 'not-registered', silhouette: 'x', tool: 'y', motif: 'z' },
    resultSpace: { name: 'test' },
  }], 1);
  assert.equal(audit.status, 'review');
  assert.ok(audit.gaps.some((gap) => gap.includes('미등록')));
});

test('setting-book canon is represented by config and renderer contracts', () => {
  const expected = {
    rodi: ['#1F2A44', 'person', 'companion-conductor', 'harmonic-fork'],
    jarvis: ['#4F6F8F', 'automaton', 'clockwork-steward', 'chronicle-dial'],
    yul: ['#1C4F5A', 'person', 'resonance-listener', 'resonance-fork'],
    ludwig: ['#737D91', 'person', 'moonlight-scholar', 'crescent-archive'],
    anne: ['#8FAF8F', 'person', 'forest-atelier', 'flower-atelier'],
    argos: ['#4B3F72', 'star-warden', 'star-warden-observer', 'owl-observatory'],
  };

  for (const agent of agentsConfig.agents) {
    const [color, character, style, signatureId] = expected[agent.key];
    assert.equal(agent.color, color);
    assert.equal(agent.character, character);
    assert.equal(agent.visual.style, style);
    assert.equal(signatureForAgent(agent)?.id, signatureId);
    assert.match(mainSource, new RegExp(`style === '${style}'`));
    assert.match(mainSource, new RegExp(`spec\\.id === '${signatureId}'`));
  }
  assert.match(agentsConfig.agents.find((agent) => agent.key === 'argos').visual.tool, /owl/i);
  assert.doesNotMatch(mainSource, /makeOwlCharacter|clockwork-owl|resonance-engineer|quiet-field-observer/);
});
