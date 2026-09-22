import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serviceUrl, serviceDetails, renderServiceDetails } from '../src/service-catalog.js';

const config = JSON.parse(await readFile(new URL('../config/services.json', import.meta.url), 'utf8'));

test('catalog covers the six public repositories with honest launch states', () => {
  const services = Object.values(config.services);
  assert.equal(services.length, 6);
  assert.equal(new Set(services.map(item => item.repository)).size, 6);
  const repos = services.map(item => new URL(item.repository).pathname.split('/').at(-1)).sort();
  assert.deepEqual(repos, ['KYOBODTPROFILE', 'TeamJ', 'hermes-local-lab', 'mini-planet', 'open-meteo-weather-web', 'weather_service'].sort());
  for (const service of services) {
    assert.equal(new URL(service.repository).hostname, 'github.com');
    assert.equal(new URL(service.repository).pathname.split('/')[1], 'Handul7');
    assert.ok(service.features.length >= 2 && service.features.length <= 4);
    assert.equal(service.embed, false);
    assert.ok(serviceDetails(service).repository);
  }
  assert.deepEqual(services.filter(item => serviceDetails(item).url).map(item => item.name), ['오늘 날씨 검색', 'Hermes Local Lab']);
  assert.equal(serviceDetails(config.services.rodi).status, 'current');
  assert.equal(serviceDetails(config.services.anne).status, 'source');
  assert.equal(serviceDetails(config.services.yul).status, 'prototype');
  assert.match(config.services.argos.note, /관련 저장소/);
  assert.match(config.services.yul.note, /실제 운전 추적/);
});

test('public catalog rejects private addresses, credentials and unsafe schemes', () => {
  for (const url of ['http://example.com', 'javascript:alert(1)', 'data:text/html,test',
    '//github.com/Handul7', 'file:///tmp/site.html', 'https://user:pass@example.com',
    'https://localhost', 'https://localhost.', 'https://home.local', 'https://home.internal',
    'https://127.0.0.1', 'https://0x7f000001', 'https://192.168.0.2', 'https://10.0.0.1',
    'https://172.16.0.2', 'https://169.254.169.254', 'https://[::1]', 'https://[fd00::1]']) {
    assert.equal(serviceUrl(url), null, url);
  }
  assert.equal(serviceUrl('https://github.com/Handul7'), 'https://github.com/Handul7');
  assert.equal(serviceUrl('http://192.168.1.2:5173', { allowLocal: true }), 'http://192.168.1.2:5173/');
  assert.equal(serviceUrl('javascript:alert(1)', { allowLocal: true }), null);
});

test('missing and malformed service data fail closed without an online claim', () => {
  assert.equal(serviceDetails().status, 'planned');
  assert.equal(serviceDetails({ availability: 'constructor' }).status, 'planned');
  assert.equal(serviceDetails({ availability: 'public', url: 'https://localhost' }).status, 'planned');
  assert.equal(serviceDetails({ availability: 'public', repository: config.services.anne.repository }).status, 'source');
  assert.deepEqual(serviceDetails({ features: ['  one ', null, 42, '', 'x'.repeat(150), 'three', 'four', 'five'] }).features,
    ['one', 'x'.repeat(100), 'three', 'four']);
  assert.equal(serviceDetails({ features: '<img src=x>', checkedAt: 'yesterday' }).checkedAt, '');
  const local = serviceDetails({ url: 'http://127.0.0.1:5173' }, { allowLocal: true });
  assert.equal(local.status, 'private');
});

function elements() {
  const doc = { createElement: () => element() };
  function element() {
    return { ownerDocument: doc, children: [], attrs: {}, textContent: '', hidden: false,
      replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); },
      setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; } };
  }
  return { features: element(), repository: element(), open: element(), checked: element() };
}

test('service rendering uses text nodes, safe links and clears old launch URLs when switching', () => {
  const nodes = elements();
  renderServiceDetails(nodes, { ...config.services.jarvis, features: ['<img src=x onerror=alert(1)>'] });
  assert.equal(nodes.features.children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(nodes.open.attrs.href, config.services.jarvis.url);
  assert.equal(nodes.open.attrs.rel, 'noopener noreferrer');
  assert.equal(nodes.repository.attrs.target, '_blank');
  renderServiceDetails(nodes, config.services.anne);
  assert.equal(nodes.open.hidden, true);
  assert.equal(nodes.open.attrs.href, undefined);
  assert.equal(nodes.repository.hidden, false);
  assert.equal(nodes.repository.attrs.href, config.services.anne.repository);
  assert.equal(nodes.features.children.length, 3);
  renderServiceDetails(nodes, {});
  assert.equal(nodes.repository.hidden, true);
  assert.equal(nodes.repository.attrs.href, undefined);
  assert.equal(nodes.checked.hidden, true);
  assert.equal(nodes.features.hidden, true);
});

test('local overrides remain opt-in to localhost and public preview skips them', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /if \(IS_LOCAL_RUNTIME && URL_PARAMS.get\('publicPreview'\) !== '1'\)/);
  assert.match(source, /allowLocal: IS_LOCAL_RUNTIME && URL_PARAMS.get\('publicPreview'\) !== '1'/);
  assert.doesNotMatch(source, /function checkReachable\(/);
  assert.doesNotMatch(source, /mode: 'no-cors'/);
  assert.match(source, /servicePanelOpener = opener/);
});

test('catalog module and updated configuration are included in offline shell', async () => {
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /src\/service-catalog\.js\?v=113/);
  assert.match(sw, /config\/services\.json/);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="serviceSelect" aria-label="집별 프로젝트 선택"/);
  assert.match(html, /<a[^>]+id="serviceRepoBtn"[^>]+rel="noopener noreferrer"/);
});
