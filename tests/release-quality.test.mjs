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

test('layout audit blocks a visitor spawn inside a solid prop', () => {
  const audit = auditLayout({
    entries: [
      { type: 'cottage', ownerKey: 'rodi', n: [0, 0, 1], radius: 0.2 },
      { type: 'opsBeacon', n: [0, 1, 0], radius: 0.13 },
    ],
    expectedOwners: ['rodi'],
    spawnN: [0, 1, 0],
  });
  assert.equal(audit.status, 'blocked');
  assert.equal(audit.spawnObstructions.length, 1);
  assert.match(audit.errors.join(' '), /시작 지점 충돌/);
});

test('layout audit accepts a separated visitor spawn', () => {
  const audit = auditLayout({
    entries: [
      { type: 'cottage', ownerKey: 'rodi', n: [0, 0, 1], radius: 0.2 },
      { type: 'opsBeacon', n: [0, 1, 0], radius: 0.13 },
    ],
    expectedOwners: ['rodi'],
    spawnN: [1, 0, 0],
  });
  assert.equal(audit.status, 'ready');
  assert.deepEqual(audit.spawnObstructions, []);
});

test('layout audit compares angular collider radii in surface units', () => {
  const audit = auditLayout({
    entries: [
      { type: 'cottage', ownerKey: 'rodi', n: [0, 0, 1], radius: 0.25 },
      { type: 'tree', n: [0.30, 0, 0.954], radius: 0.25 },
      { type: 'opsBeacon', n: [0, 1, 0], radius: 0.01 },
    ],
    expectedOwners: ['rodi'],
  });
  assert.equal(audit.overlaps.length, 1);
  assert.ok(audit.overlaps[0].required > 2.5);
});

test('layout audit warns when distinct homes lack camera breathing room', () => {
  const audit = auditLayout({
    entries: [
      { type: 'cottage', ownerKey: 'rodi', n: [0, 0, 1], radius: 0 },
      { type: 'cottage', ownerKey: 'jarvis', n: [0.2, 0, 0.98], radius: 0 },
      { type: 'opsBeacon', n: [0, 1, 0], radius: 0.1 },
    ],
    expectedOwners: ['rodi', 'jarvis'],
  });
  assert.equal(audit.status, 'review');
  assert.equal(audit.homeClearance.length, 1);
  assert.ok(audit.warnings.some((message) => message.includes('시야 여백')));
});

test('layout audit warns when a prop blocks a home approach', () => {
  const audit = auditLayout({
    entries: [
      {
        type: 'cottage', ownerKey: 'rodi', n: [0, 0, 1], radius: 0.2,
        doorN: [0.18, 0, 0.984], approachN: [0.38, 0, 0.925],
      },
      { type: 'tree', n: [0.30, 0, 0.954], radius: 0.08 },
      { type: 'opsBeacon', n: [0, 1, 0], radius: 0.01 },
    ],
    expectedOwners: ['rodi'],
  });
  assert.equal(audit.status, 'review');
  assert.equal(audit.doorObstructions.length, 1);
  assert.equal(audit.doorObstructions[0].owner, 'rodi');
  assert.ok(audit.warnings.some((message) => message.includes('진입로')));
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
