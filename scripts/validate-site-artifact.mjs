import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = resolve(process.argv[2] || resolve(projectRoot, '_site'));
const errors = [];

const expectedTopLevel = new Set([
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
const forbiddenTopLevel = ['.git', '.github', '.claude', 'docs', 'scripts', 'tests', 'README.md', 'config/services.local.json'];

function requireFile(relative) {
  const target = resolve(artifactRoot, relative);
  if (!existsSync(target) || !statSync(target).isFile()) errors.push(`배포 파일 없음: ${relative}`);
}

function localPath(reference, base = '') {
  const clean = String(reference || '').trim();
  if (!clean || clean.startsWith('#') || /^(?:data:|blob:|https?:|mailto:|tel:)/i.test(clean)) return '';
  const withoutQuery = clean.split(/[?#]/)[0];
  if (!withoutQuery) return '';
  return withoutQuery.startsWith('/')
    ? withoutQuery.slice(1)
    : resolve('/', base, withoutQuery).slice(1);
}

function checkReference(reference, base, owner) {
  const relative = localPath(reference, base);
  if (!relative) return;
  if (!existsSync(resolve(artifactRoot, relative))) errors.push(`${owner}: 배포 참조 파일 없음 (${reference})`);
}

if (!existsSync(artifactRoot)) {
  console.error(`배포 artifact가 없습니다: ${artifactRoot}`);
  process.exit(1);
}

const topLevel = readdirSync(artifactRoot).sort();
for (const entry of topLevel) {
  if (!expectedTopLevel.has(entry)) errors.push(`배포 경계 밖의 최상위 항목: ${entry}`);
}
for (const entry of expectedTopLevel) {
  if (!topLevel.includes(entry)) errors.push(`배포 최상위 항목 없음: ${entry}`);
}
for (const entry of forbiddenTopLevel) {
  if (existsSync(resolve(artifactRoot, entry))) errors.push(`배포 금지 항목 포함: ${entry}`);
}

for (const relative of [
  'index.html',
  'manifest.json',
  'robots.txt',
  'sitemap.xml',
  'sw.js',
  'favicon.ico',
  'assets/social/og-image.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/apple-touch-icon.png',
]) requireFile(relative);

const index = readFileSync(resolve(artifactRoot, 'index.html'), 'utf8');
for (const match of index.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
  checkReference(match[1], '', 'index.html');
}

const manifest = JSON.parse(readFileSync(resolve(artifactRoot, 'manifest.json'), 'utf8'));
for (const icon of manifest.icons || []) checkReference(icon?.src, '', 'manifest.json');

const sw = readFileSync(resolve(artifactRoot, 'sw.js'), 'utf8');
for (const match of sw.matchAll(/['"]\.\/([^'"?]+)(?:\?[^'"]*)?['"]/g)) {
  if (match[1]) requireFile(match[1]);
}

const css = readFileSync(resolve(artifactRoot, 'src/style.css'), 'utf8');
for (const match of css.matchAll(/url\((?:['"])?([^)'"\s]+)(?:['"])?\)/g)) {
  checkReference(match[1], 'src', 'src/style.css');
}

for (const name of readdirSync(resolve(artifactRoot, 'config'))) {
  if (name.endsWith('.local.json')) errors.push(`배포 금지 local override: config/${name}`);
}

let fileCount = 0;
let totalBytes = 0;
function countTree(directory) {
  for (const name of readdirSync(directory)) {
    const target = resolve(directory, name);
    const details = statSync(target);
    if (details.isDirectory()) countTree(target);
    else {
      fileCount += 1;
      totalBytes += details.size;
      if (extname(name) === '.map') errors.push(`배포에 source map 포함: ${target.slice(artifactRoot.length + 1)}`);
    }
  }
}
countTree(artifactRoot);

if (errors.length) {
  for (const error of errors) console.error(`✗ ${error}`);
  console.error(`\n배포 artifact 검증 실패: ${errors.length}개 오류`);
  process.exit(1);
}
console.log(`✓ 최소 배포 artifact 검증 통과 · ${fileCount}개 · ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`);
