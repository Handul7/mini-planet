import test from 'node:test';
import assert from 'node:assert/strict';

import { auditLayout, summarizeFleet } from '../src/release-quality.js';

test('live fleet fails visibly when an expected agent is missing', () => {
  const fleet = summarizeFleet({
    publicationMode: 'live',
    connectionState: 'polling',
    reportedAgentKeys: ['rodi'],
    agents: [
      { key: 'rodi', state: '작업 중', health: 'healthy' },
      { key: 'jarvis', state: '대기 중', health: 'healthy' },
    ],
  });
  assert.equal(fleet.state, 'incomplete');
  assert.equal(fleet.coverageLabel, '1/2');
  assert.deepEqual(fleet.missing, ['jarvis']);
  assert.equal(fleet.active, 1);
});

test('stale live fleet never reports agents as active', () => {
  const fleet = summarizeFleet({
    publicationMode: 'live',
    connectionState: 'live',
    isStale: true,
    reportedAgentKeys: ['rodi'],
    agents: [{ key: 'rodi', state: '작업 중', health: 'healthy' }],
  });
  assert.equal(fleet.state, 'stale');
  assert.equal(fleet.active, 0);
  assert.equal(fleet.rows[0].linkState, 'stale');
});

test('static demo is explicitly labeled and keeps full sample coverage', () => {
  const fleet = summarizeFleet({
    publicationMode: 'static-demo',
    reportedAgentKeys: [],
    agents: [{ key: 'rodi', state: '대기 중' }, { key: 'jarvis', state: '대기 중' }],
  });
  assert.equal(fleet.state, 'demo');
  assert.equal(fleet.stateLabel, 'DEMO');
  assert.equal(fleet.coverageLabel, '2/2');
});

test('layout audit blocks missing homes and required operations core', () => {
  const audit = auditLayout({
    entries: [{ type: 'cottage', ownerKey: 'rodi', n: [0, 0, 1], radius: 0.2 }],
    expectedOwners: ['rodi', 'jarvis'],
    requiredTypes: ['opsBeacon'],
  });
  assert.equal(audit.status, 'blocked');
  assert.deepEqual(audit.missingOwners, ['jarvis']);
  assert.ok(audit.errors.some((message) => message.includes('opsBeacon')));
});

test('layout audit detects duplicate ownership and close colliders', () => {
  const audit = auditLayout({
    entries: [
      { type: 'cottage', ownerKey: 'rodi', n: [0, 0, 1], radius: 0.3 },
      { type: 'cottage', ownerKey: 'rodi', n: [0.01, 0, 1], radius: 0.3 },
      { type: 'opsBeacon', n: [0, 1, 0], radius: 0.1 },
    ],
    expectedOwners: ['rodi'],
  });
  assert.equal(audit.status, 'blocked');
  assert.deepEqual(audit.duplicateOwners, ['rodi']);
  assert.equal(audit.overlaps.length, 1);
});

test('complete separated layout is release-ready', () => {
  const audit = auditLayout({
    entries: [
      { type: 'cottage', ownerKey: 'rodi', n: [0, 0, 1], radius: 0.2 },
      { type: 'cottage', ownerKey: 'jarvis', n: [1, 0, 0], radius: 0.2 },
      { type: 'opsBeacon', n: [0, 1, 0], radius: 0.1 },
    ],
    expectedOwners: ['rodi', 'jarvis'],
  });
  assert.equal(audit.status, 'ready');
  assert.equal(audit.score, 100);
});
