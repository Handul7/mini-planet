import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const info = [];

function read(relative) {
  try {
    return readFileSync(resolve(root, relative), 'utf8');
  } catch (error) {
    errors.push(`${relative}: 읽을 수 없습니다 (${error.message})`);
    return '';
  }
}

function json(relative) {
  const text = read(relative);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`${relative}: JSON 문법 오류 (${error.message})`);
    return null;
  }
}

function unique(values) {
  return new Set(values).size === values.length;
}

function objectKeys(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload).filter((key) => !key.startsWith('_'))
    : [];
}

const agentsConfig = json('config/agents.json');
const servicesConfig = json('config/services.json');
const runtimeConfig = json('config/runtime.json');
const siteConfig = json('config/site.json');
const statusPayload = json('agent-status.json');
const resultPayload = json('agent-results.json');
json('manifest.json');

const agents = Array.isArray(agentsConfig?.agents) ? agentsConfig.agents : [];
const agentKeys = agents.map((agent) => agent?.key).filter(Boolean);
if (agents.length !== 6) errors.push(`config/agents.json: 에이전트가 ${agents.length}명입니다 (계약: 6명)`);
if (!unique(agentKeys)) errors.push('config/agents.json: 중복 agent key가 있습니다');
if (agentKeys.some((key) => !/^[a-z0-9_-]{1,32}$/i.test(key))) errors.push('config/agents.json: 사용할 수 없는 agent key가 있습니다');

const expectedVisualStyles = new Set([
  'companion-conductor',
  'clockwork-owl',
  'resonance-engineer',
  'moonlight-scholar',
  'forest-atelier',
  'quiet-field-observer',
]);
for (const agent of agents) {
  if (!/^#[0-9a-f]{6}$/i.test(agent.color || '')) errors.push(`${agent.key}: color는 #rrggbb 형식이어야 합니다`);
  if (!expectedVisualStyles.has(agent.visual?.style)) errors.push(`${agent.key}: 알 수 없는 visual.style (${agent.visual?.style || '없음'})`);
  if (agent.visual?.scale !== undefined && (!Number.isFinite(agent.visual.scale) || agent.visual.scale < 0.86 || agent.visual.scale > 1.22)) {
    errors.push(`${agent.key}: visual.scale은 0.86~1.22 숫자여야 합니다`);
  }
  if (!agent.resultSpace?.name) warnings.push(`${agent.key}: resultSpace.name이 비어 있습니다`);
}

const serviceKeys = objectKeys(servicesConfig?.services);
const statusKeys = statusPayload?.agents ? objectKeys(statusPayload.agents) : objectKeys(statusPayload);
const resultKeys = resultPayload?.agents ? objectKeys(resultPayload.agents) : objectKeys(resultPayload);
for (const [label, keys] of [['services', serviceKeys], ['status', statusKeys], ['results', resultKeys]]) {
  const unknown = keys.filter((key) => !agentKeys.includes(key));
  const missing = agentKeys.filter((key) => !keys.includes(key));
  if (unknown.length) errors.push(`${label}: 알 수 없는 agent key (${unknown.join(', ')})`);
  if (missing.length) errors.push(`${label}: 빠진 agent key (${missing.join(', ')})`);
}

if (!['poll', 'sse'].includes(runtimeConfig?.status?.mode)) errors.push('config/runtime.json: status.mode는 poll 또는 sse여야 합니다');
if (!runtimeConfig?.status?.snapshotUrl) errors.push('config/runtime.json: status.snapshotUrl이 필요합니다');
if (!runtimeConfig?.results?.snapshotUrl) errors.push('config/runtime.json: results.snapshotUrl이 필요합니다');

for (const field of ['publicUrl', 'homepageUrl']) {
  if (!siteConfig?.[field]) warnings.push(`config/site.json: ${field}가 비어 있어 공개 링크가 숨겨집니다`);
}
if (!siteConfig?.githubUrl) warnings.push('config/site.json: githubUrl이 비어 있습니다');

const index = read('index.html');
const main = read('src/main.js');
const sw = read('sw.js');
const ids = [...index.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index_) => ids.indexOf(id) !== index_);
if (duplicateIds.length) errors.push(`index.html: 중복 id (${[...new Set(duplicateIds)].join(', ')})`);

const indexVersion = index.match(/src\/style\.css\?v=(\d+)/)?.[1];
const mainVersion = index.match(/'v=(\d+)'/)?.[1];
const cacheVersion = sw.match(/CACHE_PREFIX \+ 'v(\d+)'/)?.[1];
if (!indexVersion || indexVersion !== mainVersion || indexVersion !== cacheVersion) {
  errors.push(`캐시 버전 불일치: style=${indexVersion || '-'}, main=${mainVersion || '-'}, sw=${cacheVersion || '-'}`);
}

const moduleImports = [...main.matchAll(/from '\.\/(.+?\.js\?v=\d+)'/g)].map((match) => `./src/${match[1]}`);
for (const asset of [`./src/main.js?v=${mainVersion}`, `./src/style.css?v=${indexVersion}`, ...moduleImports]) {
  if (!sw.includes(`'${asset}'`)) errors.push(`sw.js SHELL에 빠진 버전 자산: ${asset}`);
}

const shellFiles = [...sw.matchAll(/'\.\/(.+?)'/g)]
  .map((match) => match[1].split('?')[0])
  .filter((value) => value && value !== '');
for (const relative of shellFiles) {
  if (!existsSync(resolve(root, relative))) errors.push(`sw.js SHELL 파일 없음: ${relative}`);
}

for (const key of agentKeys) {
  const ownerPattern = new RegExp(`ownerKey:\\s*['"]${key}['"]`);
  if (!ownerPattern.test(main)) errors.push(`src/main.js 기본 배치에 ${key} 소유 집이 없습니다`);
}

const publicBoundary = [
  ['config/agents.json', JSON.stringify(agentsConfig)],
  ['config/services.json', JSON.stringify(servicesConfig)],
  ['config/runtime.json', JSON.stringify(runtimeConfig)],
  ['config/site.json', JSON.stringify(siteConfig)],
  ['agent-status.json', JSON.stringify(statusPayload)],
  ['agent-results.json', JSON.stringify(resultPayload)],
];
for (const [file, text] of publicBoundary) {
  if (/\/Users\/|[A-Za-z]:\\\\Users\\\\/i.test(text)) errors.push(`${file}: 로컬 사용자 경로가 공개 데이터에 포함됐습니다`);
  if (/bearer\s+[a-z0-9._-]+|api[_-]?server[_-]?key\s*[:=]\s*["'][^"']+/i.test(text)) errors.push(`${file}: 비밀키로 보이는 값이 포함됐습니다`);
}

for (const file of ['src/main.js', 'src/status-source.js', 'src/sky.js', 'src/ambient-audio.js', 'src/performance.js', 'src/agent-activity.js', 'src/agent-results.js']) {
  const checked = spawnSync(process.execPath, ['--check', resolve(root, file)], { encoding: 'utf8' });
  if (checked.status !== 0) errors.push(`${file}: JavaScript 문법 오류\n${checked.stderr.trim()}`);
}

const localServices = Object.values(servicesConfig?.services || {}).filter((service) => /https?:\/\/(localhost|127\.0\.0\.1)/i.test(service?.url || '')).length;
if (localServices) warnings.push(`서비스 ${localServices}개가 로컬 주소를 사용합니다 (공개 화면에서는 개인 네트워크로 표시됨)`);

info.push(`에이전트 ${agents.length}명 · 서비스 ${serviceKeys.length}개 · 상태 ${statusKeys.length}개 · 결과 공간 ${resultKeys.length}개`);
info.push(`앱 캐시 v${cacheVersion || '?'} · JavaScript ${moduleImports.length + 1}개 문법 검사`);

for (const line of info) console.log(`✓ ${line}`);
for (const line of warnings) console.warn(`⚠ ${line}`);
if (errors.length) {
  for (const line of errors) console.error(`✗ ${line}`);
  console.error(`\n배포 전 검증 실패: ${errors.length}개 오류`);
  process.exit(1);
}
console.log(`\n배포 전 검증 통과${warnings.length ? ` (경고 ${warnings.length}개)` : ''}`);
