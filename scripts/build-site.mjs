import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicEntries = [
  'index.html',
  'src',
  'assets',
  'vendor',
  'config',
  'agent-status.json',
  'agent-results.json',
  'manifest.json',
  'robots.txt',
  'sitemap.xml',
  'sw.js',
  'favicon.ico',
  'LICENSE',
];
const excludedNames = new Set(['.DS_Store', 'services.local.json']);

function outputFromArgs() {
  const index = process.argv.indexOf('--out');
  if (index < 0) return resolve(root, '_site');
  const value = process.argv[index + 1];
  if (!value) throw new Error('--out 뒤에 출력 디렉터리가 필요합니다.');
  return resolve(value);
}

function copyPublicTree(source, destination, stats) {
  const details = lstatSync(source);
  if (details.isSymbolicLink()) throw new Error(`배포 경계에서 심볼릭 링크를 허용하지 않습니다: ${source}`);
  if (details.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source).sort()) {
      if (name.startsWith('.') || excludedNames.has(name)) continue;
      copyPublicTree(join(source, name), join(destination, name), stats);
    }
    return;
  }
  if (!details.isFile()) throw new Error(`지원하지 않는 배포 항목입니다: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  stats.files += 1;
  stats.bytes += details.size;
}

const output = outputFromArgs();
const defaultOutput = resolve(root, '_site');
const temporaryRelative = relative(resolve(tmpdir()), output);
const isTemporaryOutput = temporaryRelative && !temporaryRelative.startsWith('..') && !temporaryRelative.startsWith('/');
if (output !== defaultOutput && !isTemporaryOutput) {
  throw new Error('배포 출력은 저장소의 _site 또는 시스템 임시 디렉터리만 사용할 수 있습니다.');
}
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const stats = { files: 0, bytes: 0 };
for (const entry of publicEntries) {
  const source = resolve(root, entry);
  if (!existsSync(source)) throw new Error(`필수 공개 항목이 없습니다: ${entry}`);
  copyPublicTree(source, resolve(output, entry), stats);
}

console.log(`정적 배포본 생성: ${output}`);
console.log(`공개 파일 ${stats.files}개 · ${(stats.bytes / 1024 / 1024).toFixed(2)} MiB`);
