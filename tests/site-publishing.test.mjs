import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { syncSiteMetadata } from '../scripts/sync-site-metadata.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');

function pngSize(relative) {
  const bytes = readFileSync(resolve(root, relative));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('metadata sync moves canonical and both social images to a new origin', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-planet-metadata-'));
  try {
    mkdirSync(resolve(directory, 'config'), { recursive: true });
    copyFileSync(resolve(root, 'index.html'), resolve(directory, 'index.html'));
    copyFileSync(resolve(root, 'manifest.json'), resolve(directory, 'manifest.json'));
    const site = JSON.parse(read('config/site.json'));
    site.publicUrl = 'https://planet.example/';
    writeFileSync(resolve(directory, 'config/site.json'), JSON.stringify(site));

    const result = syncSiteMetadata({ root: directory, logger: { log() {} } });
    const index = readFileSync(resolve(directory, 'index.html'), 'utf8');
    assert.equal(result.url, 'https://planet.example/');
    assert.equal(result.socialImageUrl, 'https://planet.example/assets/social/og-image.png');
    assert.match(index, /id="canonicalUrl"[^>]+href="https:\/\/planet\.example\/"/);
    assert.match(index, /id="ogUrl"[^>]+content="https:\/\/planet\.example\/"/);
    assert.match(index, /id="ogImage"[^>]+content="https:\/\/planet\.example\/assets\/social\/og-image\.png"/);
    assert.match(index, /id="twitterImage"[^>]+content="https:\/\/planet\.example\/assets\/social\/og-image\.png"/);
    assert.match(readFileSync(resolve(directory, 'robots.txt'), 'utf8'), /https:\/\/planet\.example\/sitemap\.xml/);
    assert.match(readFileSync(resolve(directory, 'sitemap.xml'), 'utf8'), /<loc>https:\/\/planet\.example\/<\/loc>/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('social image and install icons use production pixel dimensions', () => {
  assert.deepEqual(pngSize('assets/social/og-image.png'), [1200, 630]);
  assert.deepEqual(pngSize('assets/icons/icon-192.png'), [192, 192]);
  assert.deepEqual(pngSize('assets/icons/icon-512.png'), [512, 512]);
  assert.deepEqual(pngSize('assets/icons/apple-touch-icon.png'), [180, 180]);

  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.icons.some((icon) => icon.src === 'assets/icons/icon-192.png' && icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.src === 'assets/icons/icon-512.png' && icon.purpose === 'any maskable'));
  const favicon = readFileSync(resolve(root, 'favicon.ico'));
  assert.equal(favicon.subarray(0, 4).toString('hex'), '00000100');
});

test('public editor repeats the browser-only persistence boundary', () => {
  const index = read('index.html');
  const notice = '이 편집은 현재 브라우저에만 저장되며 공개 홈페이지 원본은 변경하지 않습니다.';
  assert.equal(index.split(notice).length - 1, 2);
  assert.match(index, /정적 데모 · Hermes 미연결 · 상태와 결과는 공개용 샘플입니다\./);
});

test('minimal Pages artifact contains runtime files and excludes development files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mini-planet-artifact-'));
  try {
    const build = spawnSync(process.execPath, [resolve(root, 'scripts/build-site.mjs'), '--out', directory], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const validation = spawnSync(process.execPath, [resolve(root, 'scripts/validate-site-artifact.mjs'), directory], { encoding: 'utf8' });
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);

    assert.deepEqual(readdirSync(directory).sort(), [
      'LICENSE',
      'agent-results.json',
      'agent-status.json',
      'assets',
      'config',
      'favicon.ico',
      'index.html',
      'manifest.json',
      'robots.txt',
      'sitemap.xml',
      'src',
      'sw.js',
      'vendor',
    ]);
    for (const forbidden of ['.git', '.github', 'docs', 'scripts', 'tests', 'README.md']) {
      assert.equal(existsSync(resolve(directory, forbidden)), false, forbidden);
    }
    assert.equal(existsSync(resolve(directory, 'config/services.local.json')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('site builder rejects destructive output paths before deleting anything', () => {
  const protectedSource = resolve(root, 'src/main.js');
  const build = spawnSync(process.execPath, [resolve(root, 'scripts/build-site.mjs'), '--out', resolve(root, 'src')], { encoding: 'utf8' });
  assert.notEqual(build.status, 0);
  assert.match(build.stderr, /_site 또는 시스템 임시 디렉터리/);
  assert.equal(existsSync(protectedSource), true);
});
