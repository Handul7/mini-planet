import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { AGENT_SIGNATURES, auditSignatureRoster, signatureForAgent } from '../src/agent-signatures.js';

const agentsConfig = JSON.parse(await readFile(new URL('../config/agents.json', import.meta.url), 'utf8'));

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
