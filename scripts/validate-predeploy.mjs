import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditSignatureRoster } from '../src/agent-signatures.js';

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

function pngDimensions(relative) {
  const target = resolve(root, relative);
  if (!existsSync(target)) {
    errors.push(`이미지 파일 없음: ${relative}`);
    return null;
  }
  try {
    const bytes = readFileSync(target);
    const signature = bytes.subarray(0, 8).toString('hex');
    if (signature !== '89504e470d0a1a0a' || bytes.length < 24) {
      errors.push(`${relative}: 유효한 PNG 파일이 아닙니다`);
      return null;
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } catch (error) {
    errors.push(`${relative}: 이미지 크기를 읽을 수 없습니다 (${error.message})`);
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

function walkPublicFields(value, visit, path = '') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkPublicFields(item, visit, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    const childPath = path ? `${path}.${key}` : key;
    visit(key, child, childPath);
    walkPublicFields(child, visit, childPath);
  }
}

const agentsConfig = json('config/agents.json');
const servicesConfig = json('config/services.json');
const runtimeConfig = json('config/runtime.json');
const siteConfig = json('config/site.json');
const statusPayload = json('agent-status.json');
const resultPayload = json('agent-results.json');
const manifestConfig = json('manifest.json');

const agents = Array.isArray(agentsConfig?.agents) ? agentsConfig.agents : [];
const agentKeys = agents.map((agent) => agent?.key).filter(Boolean);
if (agents.length !== 6) errors.push(`config/agents.json: 에이전트가 ${agents.length}명입니다 (계약: 6명)`);
if (!unique(agentKeys)) errors.push('config/agents.json: 중복 agent key가 있습니다');
if (agentKeys.some((key) => !/^[a-z0-9_-]{1,32}$/i.test(key))) errors.push('config/agents.json: 사용할 수 없는 agent key가 있습니다');
const signatureAudit = auditSignatureRoster(agents);
for (const gap of signatureAudit.gaps) errors.push('시그니처 에셋: ' + gap);

const expectedVisualStyles = new Set([
  'companion-conductor',
  'clockwork-steward',
  'resonance-listener',
  'moonlight-scholar',
  'forest-atelier',
  'star-warden-observer',
]);
const expectedCharacterTypes = new Set(['person', 'automaton', 'star-warden']);
for (const agent of agents) {
  if (!/^#[0-9a-f]{6}$/i.test(agent.color || '')) errors.push(`${agent.key}: color는 #rrggbb 형식이어야 합니다`);
  if (!expectedCharacterTypes.has(agent.character || 'person')) errors.push(`${agent.key}: 알 수 없는 character (${agent.character || '없음'})`);
  if (!expectedVisualStyles.has(agent.visual?.style)) errors.push(`${agent.key}: 알 수 없는 visual.style (${agent.visual?.style || '없음'})`);
  for (const field of ['skinColor', 'pantsColor', 'glowColor']) {
    if (!/^#[0-9a-f]{6}$/i.test(agent.visual?.[field] || '')) errors.push(`${agent.key}: visual.${field}는 #rrggbb 형식이어야 합니다`);
  }
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
if (!['static-demo', 'live'].includes(runtimeConfig?.publication?.mode)) {
  errors.push('config/runtime.json: publication.mode는 static-demo 또는 live여야 합니다');
}
if (runtimeConfig?.publication?.mode === 'static-demo' && /\blive\s+(?:dashboard|status|agent)/i.test(manifestConfig?.description || '')) {
  errors.push('manifest.json: static-demo 배포를 live dashboard로 설명하면 안 됩니다');
}
if (!Number.isFinite(runtimeConfig?.status?.freshnessTtlMs) || runtimeConfig.status.freshnessTtlMs < 30000) {
  errors.push('config/runtime.json: status.freshnessTtlMs는 30초 이상의 숫자여야 합니다');
}

const statusSchemaVersion = Number(statusPayload?.schemaVersion || 0);
if (statusSchemaVersion > 2) errors.push(`agent-status.json: 지원하지 않는 미래 schemaVersion ${statusSchemaVersion}`);
if (statusPayload?.agents && statusPayload.publicationMode !== runtimeConfig?.publication?.mode) {
  errors.push('agent-status.json과 config/runtime.json의 publication mode가 다릅니다');
}
if (runtimeConfig?.publication?.mode === 'live') {
  for (const field of ['sourceGeneratedAt', 'bridgeObservedAt', 'expiresAt']) {
    if (!statusPayload?.[field] || !Number.isFinite(Date.parse(statusPayload[field]))) {
      errors.push(`agent-status.json: live mode에는 유효한 ${field}가 필요합니다`);
    }
  }
  if (typeof statusPayload?.isStale !== 'boolean') errors.push('agent-status.json: live mode에는 isStale boolean이 필요합니다');
}

let normalizedPublicUrl = '';
if (!siteConfig?.publicUrl) {
  warnings.push('config/site.json: publicUrl이 비어 있습니다');
} else {
  try {
    const url = new URL(siteConfig.publicUrl);
    if (url.protocol !== 'https:') errors.push('config/site.json: publicUrl은 HTTPS여야 합니다');
    if (url.username || url.password || url.search || url.hash) {
      errors.push('config/site.json: publicUrl에 인증 정보·쿼리·해시를 넣을 수 없습니다');
    }
    if (!url.pathname.endsWith('/')) errors.push('config/site.json: publicUrl은 /로 끝나야 합니다');
    normalizedPublicUrl = url.href;
  } catch (_) {
    errors.push('config/site.json: publicUrl 형식이 올바르지 않습니다');
  }
}
if (siteConfig?.homepageUrl) {
  try {
    if (new URL(siteConfig.homepageUrl).protocol !== 'https:') {
      errors.push('config/site.json: homepageUrl은 HTTPS여야 합니다');
    }
  } catch (_) {
    errors.push('config/site.json: homepageUrl 형식이 올바르지 않습니다');
  }
}
if (!siteConfig?.githubUrl) warnings.push('config/site.json: githubUrl이 비어 있습니다');

const index = read('index.html');
const boot = read('src/boot.js');
const main = read('src/main.js');
const style = read('src/style.css');
const sw = read('sw.js');
const robots = read('robots.txt');
const sitemap = read('sitemap.xml');
const deployWorkflow = read('.github/workflows/deploy.yml');
const gitignore = read('.gitignore');
if (normalizedPublicUrl) {
  const canonicalUrl = index.match(/id="canonicalUrl"[^>]+href="([^"]+)"/)?.[1] || '';
  const openGraphUrl = index.match(/id="ogUrl"[^>]+content="([^"]+)"/)?.[1] || '';
  const openGraphImage = index.match(/id="ogImage"[^>]+content="([^"]+)"/)?.[1] || '';
  const twitterImage = index.match(/id="twitterImage"[^>]+content="([^"]+)"/)?.[1] || '';
  const sitemapUrl = new URL('sitemap.xml', normalizedPublicUrl).href;
  const socialImageUrl = new URL('assets/social/og-image.png', normalizedPublicUrl).href;
  if (canonicalUrl !== normalizedPublicUrl) errors.push('index.html: canonical URL이 config/site.json과 다릅니다');
  if (openGraphUrl !== normalizedPublicUrl) errors.push('index.html: og:url이 config/site.json과 다릅니다');
  if (openGraphImage !== socialImageUrl) errors.push('index.html: og:image가 publicUrl 기준 절대 URL이 아닙니다');
  if (twitterImage !== socialImageUrl) errors.push('index.html: twitter:image가 publicUrl 기준 절대 URL이 아닙니다');
  if (!robots.includes(`Sitemap: ${sitemapUrl}`)) errors.push('robots.txt: sitemap URL이 publicUrl과 다릅니다');
  if (!sitemap.includes(`<loc>${normalizedPublicUrl}</loc>`)) errors.push('sitemap.xml: 대표 URL이 publicUrl과 다릅니다');
}
if (!/<meta\s+name="twitter:card"\s+content="summary_large_image"\s*\/>/.test(index)) {
  errors.push('index.html: Twitter large image card 설정이 없습니다');
}
if (!/property="og:image:width"\s+content="1200"/.test(index) || !/property="og:image:height"\s+content="630"/.test(index)) {
  errors.push('index.html: Open Graph 이미지 규격 메타데이터가 올바르지 않습니다');
}
if (!/property="og:image:alt"\s+content="[^"]+"/.test(index)) errors.push('index.html: og:image:alt가 없습니다');
if (!index.includes('<link rel="icon" href="favicon.ico" sizes="any" />')) errors.push('index.html: 실제 favicon 링크가 없습니다');
if (!index.includes('<link rel="apple-touch-icon" href="assets/icons/apple-touch-icon.png" sizes="180x180" />')) {
  errors.push('index.html: apple-touch-icon 링크가 없습니다');
}
const localEditNotice = '이 편집은 현재 브라우저에만 저장되며 공개 홈페이지 원본은 변경하지 않습니다.';
if (index.split(localEditNotice).length - 1 < 2) errors.push('index.html: 편집 진입부와 편집 도구에 브라우저 전용 저장 안내가 모두 필요합니다');
if (runtimeConfig?.publication?.mode === 'static-demo'
  && !index.includes('정적 데모 · Hermes 미연결 · 상태와 결과는 공개용 샘플입니다.')) {
  errors.push('index.html: static-demo 공개 고지가 없습니다');
}
const ids = [...index.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index_) => ids.indexOf(id) !== index_);
if (duplicateIds.length) errors.push(`index.html: 중복 id (${[...new Set(duplicateIds)].join(', ')})`);

const inlineScripts = [...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((match) => !/\bsrc\s*=/i.test(match[1]) && match[2].trim());
if (inlineScripts.length) errors.push(`index.html: 실행 가능한 inline script ${inlineScripts.length}개가 있습니다`);
const scriptPolicy = index.match(/script-src\s+([^;]+);/i)?.[1] || '';
if (!scriptPolicy || /'unsafe-inline'/.test(scriptPolicy)) {
  errors.push('index.html: script-src는 local external script만 허용해야 합니다');
}
if (/fonts\.(?:googleapis|gstatic)\.com/i.test(index) || /fonts\.(?:googleapis|gstatic)\.com/i.test(style)) {
  errors.push('외부 Google Fonts 의존성이 남아 있습니다');
}
if (!deployWorkflow.includes('node scripts/sync-site-metadata.mjs')) {
  errors.push('.github/workflows/deploy.yml: 사이트 메타데이터 동기화 단계가 없습니다');
}
if (!deployWorkflow.includes('node scripts/build-site.mjs')
  || !deployWorkflow.includes('node scripts/validate-site-artifact.mjs _site')) {
  errors.push('.github/workflows/deploy.yml: 최소 Pages artifact 생성·검증 단계가 없습니다');
}
if (!/upload-pages-artifact@[\s\S]+?with:\s*\n\s+path:\s+_site\b/.test(deployWorkflow)) {
  errors.push('.github/workflows/deploy.yml: Pages 업로드 경로는 _site여야 합니다');
}
if (!gitignore.split(/\r?\n/).includes('_site/')) errors.push('.gitignore: 생성된 _site/ 제외 규칙이 없습니다');
if (!main.includes("from '../vendor/three/build/three.module.min.js'")) {
  errors.push('src/main.js: Three.js core가 로컬 고정 경로를 사용하지 않습니다');
}
if (/unpkg\.com/i.test(index) || /unpkg\.com/i.test(boot) || /unpkg\.com/i.test(main) || /unpkg\.com/i.test(sw)) {
  errors.push('런타임 코드에 제거되지 않은 unpkg CDN 의존성이 있습니다');
}

const artDirectionReport = 'docs/world-art-direction-improvement-report.md';
if (!existsSync(resolve(root, artDirectionReport))) {
  errors.push(`${artDirectionReport}: 월드 배치 기준 보고서가 없습니다`);
}
for (const type of ['streetLamp', 'wayfinder', 'agentStation', 'harborCrane', 'dockBollard', 'cargoCluster']) {
  if (!new RegExp(`\\b${type}:\\s*\\{`).test(main)) errors.push(`src/main.js: 아트 디렉션 오브젝트 ${type} 등록이 없습니다`);
}
const frontLayoutSource = main.slice(
  main.indexOf('const HARBOR_FRONT_LAYOUT = ['),
  main.indexOf('const HARBOR_REAR_LAYOUT = ['),
);
const stationKeys = [...frontLayoutSource.matchAll(/type: 'agentStation', agentKey: '([^']+)'/g)]
  .map((match) => match[1]);
const duplicateStations = stationKeys.filter((key, index_) => stationKeys.indexOf(key) !== index_);
if (duplicateStations.length) errors.push(`src/main.js: 중앙 작업대 중복 (${[...new Set(duplicateStations)].join(', ')})`);
if (stationKeys.length) errors.push('src/main.js: 간소화된 기본 배치에 중앙 작업대가 남아 있습니다');
const districtAnchorSource = main.slice(
  main.indexOf('const AGENT_DISTRICT_ANCHORS = Object.freeze({'),
  main.indexOf('const DASHBOARD_VIEW_DIR ='),
);
const missingDistrictAnchors = agentKeys
  .filter((key) => key !== 'argos')
  .filter((key) => !new RegExp(`\\b${key}: Object\\.freeze\\(\\[`).test(districtAnchorSource));
if (missingDistrictAnchors.length) {
  errors.push(`src/main.js: 에이전트 작업 앵커 누락 (${missingDistrictAnchors.join(', ')})`);
}
if (!/function findHomeWorkDir\(home, preferred\)/.test(main)
    || !/a\.workDir = findHomeWorkDir\(home, district\)/.test(main)) {
  errors.push('src/main.js: 등대를 포함한 주택 외곽의 안전 작업 지점 계산이 없습니다');
}
if (!/type: 'lane'/.test(main)) errors.push('src/main.js: 마을 보행 골목 경로가 없습니다');
if (/type: '(?:busStop|utilityPole)'/.test(frontLayoutSource)) {
  errors.push('src/main.js: 기본 항구 배치에 시험용 단일 도로 소품이 남아 있습니다');
}

const threeVendorFiles = [
  'vendor/three/LICENSE',
  'vendor/three/NOTICE.md',
  'vendor/three/build/three.module.min.js',
  'vendor/three/examples/jsm/loaders/GLTFLoader.js',
  'vendor/three/examples/jsm/postprocessing/EffectComposer.js',
  'vendor/three/examples/jsm/postprocessing/MaskPass.js',
  'vendor/three/examples/jsm/postprocessing/OutputPass.js',
  'vendor/three/examples/jsm/postprocessing/Pass.js',
  'vendor/three/examples/jsm/postprocessing/RenderPass.js',
  'vendor/three/examples/jsm/postprocessing/ShaderPass.js',
  'vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js',
  'vendor/three/examples/jsm/shaders/CopyShader.js',
  'vendor/three/examples/jsm/shaders/LuminosityHighPassShader.js',
  'vendor/three/examples/jsm/shaders/OutputShader.js',
  'vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
];
const localFontFiles = [
  'assets/fonts/NUNITO-LICENSE.txt',
  'assets/fonts/README.md',
  'assets/fonts/nunito-latin-600-normal.woff2',
  'assets/fonts/nunito-latin-700-normal.woff2',
  'assets/fonts/nunito-latin-800-normal.woff2',
];
const publicImageFiles = [
  ['assets/social/og-image.png', 1200, 630],
  ['assets/icons/icon-192.png', 192, 192],
  ['assets/icons/icon-512.png', 512, 512],
  ['assets/icons/apple-touch-icon.png', 180, 180],
];
for (const [relative, width, height] of publicImageFiles) {
  const size = pngDimensions(relative);
  if (size && (size.width !== width || size.height !== height)) {
    errors.push(`${relative}: ${width}x${height} 규격이어야 합니다 (현재 ${size.width}x${size.height})`);
  }
}
if (!existsSync(resolve(root, 'favicon.ico')) || readFileSync(resolve(root, 'favicon.ico')).length < 100) {
  errors.push('favicon.ico: 실제 아이콘 파일이 없거나 비어 있습니다');
}
const requiredManifestIcons = [
  ['assets/icons/icon-192.png', '192x192', 'any'],
  ['assets/icons/icon-512.png', '512x512', 'any maskable'],
];
for (const [src, sizes, purpose] of requiredManifestIcons) {
  const icon = manifestConfig?.icons?.find((entry) => entry?.src === src);
  if (!icon || icon.sizes !== sizes || icon.type !== 'image/png' || icon.purpose !== purpose) {
    errors.push(`manifest.json: ${src}의 sizes/type/purpose 설정이 올바르지 않습니다`);
  }
}
for (const relative of ['favicon.ico', ...publicImageFiles.slice(1).map(([file]) => file)]) {
  if (!sw.includes(`'./${relative}'`)) errors.push(`sw.js SHELL에 빠진 앱 아이콘: ./${relative}`);
}
for (const relative of localFontFiles) {
  if (!existsSync(resolve(root, relative))) errors.push(`로컬 폰트 파일 없음: ${relative}`);
  if (relative.endsWith('.woff2') && !sw.includes(`'./${relative}'`)) {
    errors.push(`sw.js SHELL에 빠진 폰트 파일: ./${relative}`);
  }
  if (relative.endsWith('.woff2') && !style.includes(`../${relative}`)) {
    errors.push(`src/style.css에 선언되지 않은 폰트 파일: ../${relative}`);
  }
}
for (const relative of threeVendorFiles) {
  if (!existsSync(resolve(root, relative))) {
    errors.push(`Three.js vendor 파일 없음: ${relative}`);
    continue;
  }
  if (relative.endsWith('.js') && !sw.includes(`'./${relative}'`)) {
    errors.push(`sw.js SHELL에 빠진 Three.js 파일: ./${relative}`);
  }
}
for (const relative of threeVendorFiles.filter((file) => file.endsWith('.js'))) {
  const source = read(relative);
  if (/from\s+['"]three['"]/.test(source)) errors.push(`${relative}: bare Three.js import가 남아 있습니다`);
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const dependency = resolve(root, dirname(relative), match[1]);
    if (!existsSync(dependency)) errors.push(`${relative}: vendor 의존 파일 없음 (${match[1]})`);
  }
}

for (const match of deployWorkflow.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)) {
  if (!/^[0-9a-f]{40}$/i.test(match[2])) errors.push(`deploy.yml: ${match[1]} action이 commit SHA로 고정되지 않았습니다`);
}

const indexVersion = index.match(/src\/style\.css\?v=(\d+)/)?.[1];
const bootVersion = index.match(/src\/boot\.js\?v=(\d+)/)?.[1];
const mainVersion = boot.match(/'v=(\d+)'/)?.[1];
const cacheVersion = sw.match(/CACHE_PREFIX \+ 'v(\d+)'/)?.[1];
if (!indexVersion || indexVersion !== bootVersion || indexVersion !== mainVersion || indexVersion !== cacheVersion) {
  errors.push(`캐시 버전 불일치: style=${indexVersion || '-'}, boot=${bootVersion || '-'}, main=${mainVersion || '-'}, sw=${cacheVersion || '-'}`);
}

const moduleImports = [...main.matchAll(/from '\.\/(.+?\.js\?v=\d+)'/g)].map((match) => `./src/${match[1]}`);
for (const asset of [`./src/boot.js?v=${bootVersion}`, `./src/main.js?v=${mainVersion}`, `./src/style.css?v=${indexVersion}`, ...moduleImports]) {
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

const modelFiles = [...main.matchAll(/file:\s*['"]([^'"]+\.gltf)['"]/g)].map((match) => match[1]);
for (const modelFile of modelFiles) {
  if (!modelFile.startsWith('assets/models/')) {
    errors.push(`src/main.js: 공개 모델 경로가 assets/models 밖을 가리킵니다 (${modelFile})`);
    continue;
  }
  const model = json(modelFile);
  if (!model) continue;
  const resources = [...(model.buffers || []), ...(model.images || [])]
    .map((entry) => entry?.uri)
    .filter(Boolean);
  for (const uri of resources) {
    if (/^data:/i.test(uri)) continue;
    if (/^(?:https?:)?\/\//i.test(uri)) {
      errors.push(`${modelFile}: 원격 GLTF 리소스는 허용하지 않습니다 (${uri})`);
      continue;
    }
    if (!existsSync(resolve(root, dirname(modelFile), uri))) {
      errors.push(`${modelFile}: GLTF 리소스가 없습니다 (${uri})`);
    }
  }
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
  if (/\/Users\/|[A-Za-z]:\\\\Users\\\\|~\/|\.(?:hermes|ssh)(?:\/|\\\\)/i.test(text)) errors.push(`${file}: 로컬 사용자 경로가 공개 데이터에 포함됐습니다`);
  if (/https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?/i.test(text)) errors.push(`${file}: 로컬 서비스 주소가 공개 데이터에 포함됐습니다`);
  if (/Discord\s+#[\w-]+/i.test(text)) errors.push(`${file}: 내부 채널명이 공개 데이터에 포함됐습니다`);
  if (/bearer\s+[a-z0-9._-]+|api[_-]?server[_-]?key\s*[:=]\s*["'][^"']+/i.test(text)) errors.push(`${file}: 비밀키로 보이는 값이 포함됐습니다`);
}

const forbiddenLiveFields = new Set([
  'prompt', 'rawprompt', 'toolargs', 'toolarguments', 'toolresults', 'terminaloutput',
  'memory', 'transcript', 'comments', 'apiserverkey', 'providerendpoint', 'profilepath',
  'sessionid', 'runid', 'discorduserid', 'channelid', 'guildid', 'email', 'phone',
  'tokenusage', 'billing', 'cost',
]);
for (const [file, payload] of [['agent-status.json', statusPayload], ['agent-results.json', resultPayload]]) {
  walkPublicFields(payload, (key, _value, path) => {
    const normalized = key.replace(/[_-]/g, '').toLowerCase();
    if (forbiddenLiveFields.has(normalized)) errors.push(`${file}: 금지 필드 ${path}`);
  });
}

const forbiddenProfileFields = new Set([
  'soul', 'profilekey', 'sourcefiles', 'profilepath', 'cwd', 'environment', 'env',
  'userid', 'discorduserid', 'channelid', 'guildid',
]);
walkPublicFields(agentsConfig, (key, _value, path) => {
  const normalized = key.replace(/[_-]/g, '').toLowerCase();
  if (forbiddenProfileFields.has(normalized)) errors.push(`config/agents.json: private profile field ${path}`);
});

for (const [key, service] of Object.entries(servicesConfig?.services || {})) {
  if (!service?.url) continue;
  try {
    const url = new URL(service.url);
    if (url.protocol !== 'https:') errors.push(`config/services.json: ${key}.url은 공개 HTTPS 주소여야 합니다`);
    if (url.username || url.password) errors.push(`config/services.json: ${key}.url에 인증 정보가 포함됐습니다`);
  } catch (_) {
    errors.push(`config/services.json: ${key}.url 형식이 올바르지 않습니다`);
  }
}

const appJsFiles = ['src/boot.js', 'src/main.js', 'src/status-source.js', 'src/public-dashboard.js', 'src/release-quality.js', 'src/sky.js', 'src/ambient-audio.js', 'src/performance.js', 'src/agent-activity.js', 'src/agent-results.js', 'src/agent-signatures.js', 'src/input-controls.js', 'src/paper-style.js', 'src/world/harbor-kit.js', 'assets/papercut/contours.js'];
for (const file of appJsFiles) {
  if (/from\s+['"]three(?:\/[^'"]*)?['"]/.test(read(file))) {
    errors.push(`${file}: import map이 필요한 bare Three.js import가 남아 있습니다`);
  }
  const checked = spawnSync(process.execPath, ['--check', resolve(root, file)], { encoding: 'utf8' });
  if (checked.status !== 0) errors.push(`${file}: JavaScript 문법 오류\n${checked.stderr.trim()}`);
}

info.push(`에이전트 ${agents.length}명 · 서비스 ${serviceKeys.length}개 · 상태 ${statusKeys.length}개 · 결과 공간 ${resultKeys.length}개`);
info.push(`번들 GLTF ${modelFiles.length}개와 Three.js ${threeVendorFiles.length - 2}개 런타임 파일 검사`);
info.push(`로컬 Nunito WOFF2 ${localFontFiles.filter((file) => file.endsWith('.woff2')).length}개와 OFL 라이선스 검사`);
info.push(`앱 캐시 v${cacheVersion || '?'} · JavaScript ${appJsFiles.length}개 문법 검사`);
info.push(`공개 모드 ${runtimeConfig?.publication?.mode || '?'} · 상태 schema v${statusSchemaVersion || 'legacy'}`);

for (const line of info) console.log(`✓ ${line}`);
for (const line of warnings) console.warn(`⚠ ${line}`);
if (errors.length) {
  for (const line of errors) console.error(`✗ ${line}`);
  console.error(`\n배포 전 검증 실패: ${errors.length}개 오류`);
  process.exit(1);
}
console.log(`\n배포 전 검증 통과${warnings.length ? ` (경고 ${warnings.length}개)` : ''}`);
