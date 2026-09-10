import * as THREE from '../vendor/three/build/three.module.min.js';
import { EffectComposer } from '../vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from '../vendor/three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from '../vendor/three/examples/jsm/postprocessing/OutputPass.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from '../vendor/three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyPaperSurface, applyPaperObject, makePaperCanopy, paperCutGeometry } from './paper-style.js?v=97';
import { makePaperSlab, makePaperHouseShell, makePaperRelief, makePaperTierRoof, makePaperTower, makePaperWindowTrim, makePaperDoor, makePaperRose } from './world/paper-assets.js?v=105';
import { makePaperPublicSpace } from './world/public-spaces.js?v=105';
import { createRoseStory } from './rose-story.js?v=105';
import { createVillageBoard } from './village-board.js?v=102';
import { createStableSceneTarget, stabilizePaperShadows } from './render-stability.js?v=102';
import { createVisibilityLoop, createElementSizeCache } from './render-efficiency.js?v=104';
import { oceanBandBounds, streetNetworkState, findSurfaceRoute } from './world/spatial-structure.js?v=103';
import {
  makeCottageArchitecture,
  makeHedgeLine,
  makeQuayRail,
  makeStreetEdges,
} from './world/harbor-kit.js?v=105';
import { createAgentStatusSource } from './status-source.js?v=70';
import { createSkySystem } from './sky.js?v=97';
import { createAmbientAudio } from './ambient-audio.js?v=104';
import { createAgentActivityTools } from './agent-activity.js?v=70';
import { createPerformanceGovernor } from './performance.js?v=64';
import { signatureForAgent } from './agent-signatures.js?v=72';
import { readGamepadControls } from './input-controls.js?v=71';
import {
  cleanPublicText,
  evaluateSnapshotFreshness,
  isPublicRecord,
  normalizePublicAgentStatus,
  normalizePublicDashboardView,
  selectPublicResultProjection,
} from './public-dashboard.js?v=70';
import { auditLayout, summarizeFleet } from './release-quality.js?v=76';
import {
  formatResultDate,
  mergePublicResults,
  normalizePublicResult,
  normalizePublicResults,
  publicResultUrl,
  resultKindMeta,
  resultStatusLabel,
} from './agent-results.js?v=60';

const URL_PARAMS = new URLSearchParams(location.search);
const villageBoard = await createVillageBoard();
const DEV_TIME_SHIFT_MS = URL_PARAMS.has('dev')
  ? Number(URL_PARAMS.get('timeShiftHours') || 0) * 3600000
  : 0;
const DEV_WEATHER_PRESET = URL_PARAMS.has('dev')
  ? String(URL_PARAMS.get('weatherPreset') || '').toLowerCase()
  : '';
const DEV_QUALITY_OVERRIDE = URL_PARAMS.has('dev')
  ? String(URL_PARAMS.get('quality') || '').toLowerCase()
  : '';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const IS_LOCAL_RUNTIME = LOCAL_HOSTS.has(location.hostname);

// ---------------------------------------------------------------------------
// Persistent state (localStorage) — currently just the player's avatar color.
// (The village layout has its own key: see LAYOUT_KEY below.)
// ---------------------------------------------------------------------------
const SAVE_KEY = 'HandulPlanet_data';
const save = {
  data: { modelFiles: { base: 0xff9e80 } },
  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) this.data = { ...this.data, ...JSON.parse(raw) };
    } catch (e) { /* corrupted or unavailable storage -> use defaults */ }
    return this.data;
  },
  store() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.data)); } catch (_) { /* storage unavailable */ }
  },
};
save.load();

// ---------------------------------------------------------------------------
// WORLD CONFIG — the agent roster (config/agents.json) and the house→service
// map (config/services.json) live in JSON so the team and services can be
// edited without touching code. Loaded up-front (module top-level await);
// if a file is missing the planet still boots, just with an empty roster.
// ---------------------------------------------------------------------------
async function fetchJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}
let AGENT_CONFIG = [], SERVICES = {}, RESULT_COLLECTIONS = {};
const STARTUP_WARNINGS = [];
let TEAM_CONFIG = {
  name: 'Rodi Team',
  displayName: '별의 공명자들',
  orchestrator: 'rodi',
  verifier: 'ludwig',
  researcher: 'argos',
  principles: [],
  handoffs: [],
  riskLevels: {},
};
let SITE_CONFIG = {
  title: 'Handul Mini Planet',
  kicker: 'A LIVING AGENT VILLAGE',
  description: '여섯 공명자가 일하고 결과를 쌓아가는 작은 항구 행성. 관제 화면에서 상태와 작업물을 천천히 지켜보세요.',
  metaDescription: '여섯 AI 에이전트의 작업 상태와 결과물을 보여주는 인터랙티브 3D 항구 행성 대시보드.',
  publicUrl: '', homepageUrl: '', githubUrl: '',
};
let RUNTIME_CONFIG = {
  publication: {
    mode: 'static-demo',
    label: '정적 데모',
    notice: 'Hermes 미연결 · 상태와 결과는 공개용 샘플입니다.',
  },
  status: { mode: 'poll', snapshotUrl: 'agent-status.json', eventUrl: '', pollMs: 60000 },
  results: { snapshotUrl: 'agent-results.json' },
};
{
  const [agentsResult, servicesResult] = await Promise.allSettled([
    fetchJSON('config/agents.json'),
    fetchJSON('config/services.json'),
  ]);
  if (agentsResult.status === 'fulfilled') {
    const agentsCfg = agentsResult.value;
    AGENT_CONFIG = Array.isArray(agentsCfg.agents) ? agentsCfg.agents : [];
    TEAM_CONFIG = {
      ...TEAM_CONFIG,
      ...(agentsCfg.team && typeof agentsCfg.team === 'object' ? agentsCfg.team : {}),
    };
  } else {
    STARTUP_WARNINGS.push('에이전트 설정을 불러오지 못했습니다.');
    console.warn('config/agents.json 로드 실패 — 빈 로스터로 시작합니다:', agentsResult.reason);
  }
  if (servicesResult.status === 'fulfilled') {
    SERVICES = servicesResult.value.services || {};
  } else {
    STARTUP_WARNINGS.push('집 서비스 설정을 불러오지 못했습니다.');
    console.warn('config/services.json 로드 실패 — 집은 서비스 없이 표시됩니다:', servicesResult.reason);
  }
}
if (IS_LOCAL_RUNTIME) {
  try {
    const localServices = await fetchJSON('config/services.local.json');
    SERVICES = { ...SERVICES, ...(localServices.services || {}) };
  } catch (_) { /* optional untracked local-only service endpoints */ }
}
try {
  SITE_CONFIG = { ...SITE_CONFIG, ...(await fetchJSON('config/site.json')) };
} catch (_) { /* optional public-site metadata */ }
try {
  const runtimeCfg = await fetchJSON('config/runtime.json');
  RUNTIME_CONFIG = {
    ...RUNTIME_CONFIG,
    ...runtimeCfg,
    publication: { ...RUNTIME_CONFIG.publication, ...(runtimeCfg.publication || {}) },
    status: { ...RUNTIME_CONFIG.status, ...(runtimeCfg.status || {}) },
    results: { ...RUNTIME_CONFIG.results, ...(runtimeCfg.results || {}) },
  };
} catch (_) { /* optional until the Hermes bridge is enabled */ }

const introDisclosure = document.getElementById('introDisclosure');
if (introDisclosure) {
  const publication = RUNTIME_CONFIG.publication || {};
  introDisclosure.textContent = [publication.label, publication.notice].filter(Boolean).join(' · ');
}
try {
  const resultCfg = await fetchJSON(RUNTIME_CONFIG.results.snapshotUrl || 'agent-results.json');
  const collections = resultCfg?.agents && typeof resultCfg.agents === 'object'
    ? resultCfg.agents
    : resultCfg;
  if (collections && typeof collections === 'object') {
    for (const agent of AGENT_CONFIG) {
      RESULT_COLLECTIONS[agent.key] = normalizePublicResults(collections[agent.key]);
    }
  }
} catch (_) { /* the result exhibition stays quietly empty until data exists */ }

// ===========================================================================
// THEME — the single source of truth for identity colors, shared by the 3D
// world (Three.js materials) and the UI (CSS custom properties are synced
// below). Change a value here and both sides follow.
// ===========================================================================
const THEME = {
  world: {
    planet:   0x86a47b,                                  // land globe; water exists only in registered sea meshes
    landDeep: 0x365846,
    outline:  0x5d6268,                                  // soft graphite line; agents carry the color accents
    fogDay:   0xdceff7, fogTwilight: 0xe8d8df, fogNight: 0x25344a,
    skyDay:   { top: 0x6fb7e8, mid: 0xa8d8f0, bottom: 0xeaf6ff },
    // The former lavender/apricot day palette now belongs only to the
    // dawn/dusk transition instead of tinting the whole daytime scene.
    skyTwilight: { top: 0x879fd1, mid: 0xd4aeca, bottom: 0xf7c7aa },
    skyNight: { top: 0x07142f, mid: 0x18314f, bottom: 0x4c6173 },
    water:    0x72c9e8,
    seaDeep:  0x287d91, seaMid: 0x58b5c2, seaFoam: 0xf1faf5,
    coastSand: 0xeee2bd, breakwater: 0xa8bcc2,
    islandGrass: 0xa8cb92, harborDeck: 0xad8881,
    marketPath: 0xc2b291, camelliaPath: 0x8fa584,
    roadAsphalt: 0xc7cdbd, roadLine: 0xebeee4,
    dirt:     0x987d60,
    snowTop:  0xf4f9fd, snowEdge: 0xcfe0ea,
    rosePetal: 0xd91f4e, roseCore: 0xa80f38,
    roseStem: 0x4e8f56, roseLeaf: 0x63a86b,
    roseGold: 0xe6c36a, roseGlass: 0xdff6ff,
  },
  // agent identity colors now live in config/agents.json (per-agent `color`)
  ui: {
    accent: '#81bfbc', accentDark: '#5fa3a0', ink: '#36514f',
    panel: 'rgba(255,255,255,0.94)', rose: '#d91f4e',
  },
  status: {   // agent state badge colors, matched by keyword (see statusColor)
    idle:    '#7fb98a',
    working: '#e0a33f',
    review:  '#8593d8',
    error:   '#d96b6b',
  },
};
// 0xrrggbb → '#rrggbb' (shared by the dashboard, editor swatches, flags…)
function cssHex(hex) { return '#' + hex.toString(16).padStart(6, '0'); }

const {
  statusColor,
  isWorkingStatus,
  agentActivityMode,
  addAgentActivitySignal,
  updateAgentActivitySignal,
} = createAgentActivityTools(THEME.status);

// keep the CSS custom properties in lockstep with the JS theme
(function syncThemeToCSS() {
  const r = document.documentElement.style;
  r.setProperty('--teal', THEME.ui.accent);
  r.setProperty('--teal-d', THEME.ui.accentDark);
  r.setProperty('--ink', THEME.ui.ink);
  r.setProperty('--panel', THEME.ui.panel);
  r.setProperty('--rose', THEME.ui.rose);
})();

// ---------------------------------------------------------------------------
// Scene, camera, renderer
// ---------------------------------------------------------------------------
const app = document.getElementById('app');
const emojibarEl = document.getElementById('emojibar');
const intro = document.getElementById('intro');
const startBtn = document.getElementById('startBtn');
const wxIconEl = document.getElementById('wxIcon');
const wxTempEl = document.getElementById('wxTemp');
const wxTimeEl = document.getElementById('wxTime');

function isUiInteractionTarget(target) {
  return target instanceof Element && !!target.closest(
    'button, a, input, textarea, select, summary, iframe, [contenteditable="true"], [role="tab"], [role="dialog"], .editor, .inspector, .draw-bar, .paper-panel'
  );
}

function setInteractiveState(element, visible) {
  if (!element) return;
  element.inert = !visible;
  element.setAttribute('aria-hidden', String(!visible));
}

let appNoticeTimer = 0;
function showAppNotice(message, { actionLabel = '', onAction = null, sticky = false } = {}) {
  const notice = document.getElementById('appNotice');
  const text = document.getElementById('appNoticeText');
  const action = document.getElementById('appNoticeAction');
  if (!notice || !text || !action) return;
  clearTimeout(appNoticeTimer);
  text.textContent = message;
  action.hidden = !actionLabel || typeof onAction !== 'function';
  action.textContent = actionLabel;
  action.onclick = action.hidden ? null : () => onAction();
  notice.hidden = false;
  if (!sticky) appNoticeTimer = setTimeout(() => { notice.hidden = true; }, 4200);
}

(function applySiteConfig() {
  const safe = (v, fallback = '') => typeof v === 'string' && v.trim() ? v.trim() : fallback;
  const title = safe(SITE_CONFIG.title, 'Handul Mini Planet');
  const description = safe(SITE_CONFIG.metaDescription, SITE_CONFIG.description);
  document.title = `${title} — AI Agent Dashboard`;
  document.getElementById('introKicker').textContent = safe(SITE_CONFIG.kicker, 'A LIVING AGENT VILLAGE');
  const titleWords = title.split(/\s+/);
  const titleEl = document.getElementById('introTitle');
  if (titleEl) {
    const first = document.createElement('span');
    const rest = document.createElement('span');
    first.textContent = (titleWords.shift() || 'HANDUL').toUpperCase();
    rest.textContent = (titleWords.join(' ') || 'MINI PLANET').toUpperCase();
    titleEl.replaceChildren(first, rest);
  }
  document.getElementById('introDescription').textContent = safe(SITE_CONFIG.description);
  for (const selector of ['#siteDescription', '#ogDescription', '#twitterDescription']) {
    document.querySelector(selector)?.setAttribute('content', description);
  }
  document.getElementById('ogSiteName')?.setAttribute('content', title);
  document.getElementById('ogTitle')?.setAttribute('content', title);
  document.getElementById('twitterTitle')?.setAttribute('content', title);
  const publicUrl = safe(SITE_CONFIG.publicUrl);
  if (publicUrl) {
    document.getElementById('canonicalUrl')?.setAttribute('href', publicUrl);
    document.getElementById('ogUrl')?.setAttribute('content', publicUrl);
  }
  const links = [
    ['homepageLink', safe(SITE_CONFIG.homepageUrl)],
    ['githubLink', safe(SITE_CONFIG.githubUrl)],
  ];
  let hasLink = false;
  for (const [id, url] of links) {
    const link = document.getElementById(id);
    if (!link || !url) continue;
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.hidden = false; hasLink = true;
  }
  document.getElementById('publicLinks').hidden = !hasLink;
})();
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1000);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(1); // the performance governor selects the real DPR before frame one
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // filmic color response
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);
let webglContextLost = false;
renderer.domElement.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  webglContextLost = true;
  showAppNotice('그래픽 연결이 잠시 중단되었습니다.', {
    actionLabel: '다시 불러오기',
    onAction: () => location.reload(),
    sticky: true,
  });
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  webglContextLost = false;
  showAppNotice('그래픽 연결이 복구되었습니다.');
});

// ---------------------------------------------------------------------------
// Post-processing: bloom (soft light glow) + vignette
// ---------------------------------------------------------------------------
const composer = new EffectComposer(renderer, createStableSceneTarget(renderer, innerWidth, innerHeight));
composer.addPass(new RenderPass(scene, camera));

const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  0.10,   // Paper stays matte; active signals retain a restrained glow.
  0.62,   // radius
  1.40    // Keep sunlit paper below the glow threshold.
);
composer.addPass(bloom);

// gentle vignette + subtle warm tint, as a tiny custom shader pass
const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    offset:   { value: 1.15 },
    darkness: { value: 1.07 },
    tint:     { value: new THREE.Color(0xffe9d0) },
    tintAmount: { value: 0.03 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float offset; uniform float darkness; uniform vec3 tint; uniform float tintAmount;
    varying vec2 vUv;
    void main(){
      vec4 col = texture2D(tDiffuse, vUv);
      vec2 uv = (vUv - 0.5) * offset;
      float vig = smoothstep(0.8, offset*0.5, 1.0 - dot(uv, uv));
      col.rgb *= mix(1.0, vig, 0.38) * darkness;
      col.rgb = mix(col.rgb, col.rgb * tint, tintAmount);
      gl_FragColor = col;
    }
  `,
};
const vignettePass = new ShaderPass(VignetteShader);
composer.addPass(vignettePass);
composer.addPass(new OutputPass());

const performanceGovernor = createPerformanceGovernor({
  renderer,
  composer,
  bloom,
  qualityOverride: DEV_QUALITY_OVERRIDE,
});

// ---------------------------------------------------------------------------
// Toon / cel-shading toolkit
//   - a stepped gradient map => hard light bands instead of smooth shading
//   - addOutline() => inverted-hull black silhouette for the inky cartoon edge
// ---------------------------------------------------------------------------
function makeToonGradient(steps = 4) {
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) data[i] = Math.round(112 + (i / (steps - 1)) * 143);
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
const TOON_GRAD = makeToonGradient(3);   // Three matte ink values on colored cardstock.

// build a toon material with the same gradient ramp for the whole world
function toonMat(color) {
  return applyPaperSurface(new THREE.MeshToonMaterial({ color, gradientMap: TOON_GRAD }));
}

// Preserve factory callers; paper edges use solid geometry and contact shadows.
function addOutline(mesh) {
  mesh.receiveShadow = true;
  return mesh;
}

function collectRuntimeReferences(value, objects, materials, seen = new WeakSet()) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
  if (value.isObject3D) { objects.add(value); return; }
  if (value.isMaterial) { materials.add(value); return; }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => collectRuntimeReferences(entry, objects, materials, seen));
    return;
  }
  for (const entry of Object.values(value)) {
    collectRuntimeReferences(entry, objects, materials, seen);
  }
}

function materialBatchKey(material) {
  const color = material.color?.getHexString?.() || '';
  const emissive = material.emissive?.getHexString?.() || '';
  return [
    material.type, color, emissive, material.emissiveIntensity || 0,
    material.map?.uuid || '', material.gradientMap?.uuid || '',
    material.side, material.transparent, material.opacity,
    material.depthWrite, material.blending, material.vertexColors,
  ].join('|');
}

function geometryBatchKey(geometry) {
  const attributes = Object.entries(geometry.attributes || {})
    .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized ? 1 : 0}`)
    .sort()
    .join(',');
  return `${geometry.index ? 'indexed' : 'plain'}|${attributes}`;
}

// Merge only leaf meshes that share one static parent. Parent groups remain
// intact, so character limbs, home signals, boat motion and editor transforms
// keep their existing anchors while repeated visual fragments cost one batch.
function batchStaticMeshTree(root) {
  if (!root || root.userData.sharedModelResources) return root;
  stabilizePaperShadows(root);
  const preservedObjects = new Set();
  const runtimeMaterials = new Set();
  root.traverse((object) => {
    collectRuntimeReferences(object.userData, preservedObjects, runtimeMaterials);
  });

  const visit = (parent) => {
    for (const child of [...parent.children]) {
      if (!child.isMesh) visit(child);
    }
    const groups = new Map();
    for (const child of parent.children) {
      if (!child.isMesh || child.isInstancedMesh || child.isSkinnedMesh
          || child.children.length || preservedObjects.has(child)
          || Array.isArray(child.material) || child.material?.transparent
          || child.morphTargetInfluences || !child.geometry) continue;
      const key = [
        materialBatchKey(child.material), geometryBatchKey(child.geometry),
        child.renderOrder, child.castShadow ? 1 : 0, child.receiveShadow ? 1 : 0,
      ].join('::');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(child);
    }

    for (const siblings of groups.values()) {
      if (siblings.length < 2) continue;
      const geometries = siblings.map((mesh) => {
        mesh.updateMatrix();
        return mesh.geometry.clone().applyMatrix4(mesh.matrix);
      });
      const geometry = mergeGeometries(geometries, false);
      geometries.forEach((item) => item.dispose());
      if (!geometry) continue;
      const material = siblings.find((mesh) => runtimeMaterials.has(mesh.material))?.material
        || siblings[0].material;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'district-static-batch';
      mesh.castShadow = siblings[0].castShadow;
      mesh.receiveShadow = siblings[0].receiveShadow;
      mesh.renderOrder = siblings[0].renderOrder;
      siblings.forEach((item) => parent.remove(item));
      parent.add(mesh);
    }
  };
  visit(root);
  return root;
}

function disposeObject(root) {
  // Bundled GLTF instances share resources owned by modelProtoCache.
  // Disposing one clone would invalidate every clone and the prototype.
  if (root?.userData?.sharedModelResources) return;
  root?.userData?.disposeResources?.();
  const geometries = new Set();
  const materials = new Set();
  root.traverse(obj => {
    if (obj.geometry) geometries.add(obj.geometry);
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (mat) materials.add(mat);
    }
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}

function removeSceneObject(obj) {
  if (!obj) return;
  scene.remove(obj);
  disposeObject(obj);
}

// planet radius (declared early; the planet mesh itself is built below)
// 14 -> 11.2 (4/5) -> 7.47 (a further 2/3)
const R = 7.47;
const TERRAIN_RELIEF = 0.38;
const SEA_BAND_MIN_Y = -0.70;
const SEA_BAND_MAX_Y = 0.20;

const skySystem = createSkySystem({
  scene,
  camera,
  renderer,
  vignettePass,
  theme: THEME,
  radius: R,
  devTimeShiftMs: DEV_TIME_SHIFT_MS,
  devWeatherPreset: DEV_WEATHER_PRESET,
  weatherElements: { icon: wxIconEl, temp: wxTempEl, time: wxTimeEl },
});
performanceGovernor.attachSkySystem(skySystem);
const ambientAudio = createAmbientAudio({
  button: document.getElementById('soundToggle'),
});
document.addEventListener('village-board-open', () => ambientAudio.playEffect('open'));
const roseStory = createRoseStory({ onOpen: () => {
  ambientAudio.playEffect('open');
  document.dispatchEvent(new Event('rose-story-open'));
} });

// ---------------------------------------------------------------------------
// The planet
// ---------------------------------------------------------------------------
const planet = new THREE.Mesh(
  new THREE.SphereGeometry(R, 128, 96),        // Match thin paper paths to the analytic surface.
  new THREE.MeshToonMaterial({
    color: THEME.world.planet,
    emissive: THEME.world.landDeep,
    emissiveIntensity: 0.08,
    gradientMap: TOON_GRAD,
  })
);
// gently jitter vertices for a low-poly hilly look
{
  const pos = planet.geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = TERRAIN_RELIEF * Math.sin(v.x * 1.3) * Math.cos(v.y * 1.1) * Math.sin(v.z * 1.2);
    v.setLength(R + n);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  planet.geometry.computeVertexNormals();
}
planet.receiveShadow = true;
applyPaperSurface(planet.material);
scene.add(planet);
addOutline(planet, 1.012); // thin rim so the globe reads as one big cartoon shape

// ---------------------------------------------------------------------------
// Surface decorations — a richer, hand-placed-feeling set: trees, rocks, flowers
// ---------------------------------------------------------------------------
const surfaceColliders = [];
const waterZones = [];
const landZones = [];
const bridgeZones = [];

function registerSurfaceCollider(dir, radius, label = 'object') {
  surfaceColliders.push({ dir: dir.clone().normalize(), radius, label });
}

function registerWaterZone(dir, radius, label = 'water') {
  const z = { dir: dir.clone().normalize(), radius, label };
  waterZones.push(z);
  return z;
}

function registerBridgeZone(dir, radius, label = 'bridge') {
  const z = { dir: dir.clone().normalize(), radius, label };
  bridgeZones.push(z);
  return z;
}

function registerLatitudeWaterBand(minY, maxY, label = 'sea-ring') {
  const z = { label, band: { minY, maxY } };
  waterZones.push(z);
  return z;
}

// remove previously-registered zones (used when deleting an editable river)
function unregisterZones(zoneArray, list) {
  for (const z of list) {
    const i = zoneArray.indexOf(z);
    if (i >= 0) zoneArray.splice(i, 1);
  }
}

// One zone test — circular by default; zones with a `poly` payload (ponds)
// compare the target's angular distance against the outline radius at the
// target's bearing, so arbitrary drawn shapes register correctly.
function zoneContains(z, target, extraRadius = 0) {
  if (z.band) {
    const bounds = z.band.contoured
      ? oceanBandBounds(Math.atan2(target.z, target.x), z.band.minY, z.band.maxY)
      : { min: z.band.minY, max: z.band.maxY };
    return target.y >= bounds.min - extraRadius && target.y <= bounds.max + extraRadius;
  }
  const dot = Math.max(-1, Math.min(1, target.dot(z.dir)));
  const radius = z.radius + extraRadius;
  if (radius < 0 || (radius < Math.PI && dot < Math.cos(radius))) return false;
  if (!z.poly) return true;
  const ang = Math.acos(dot);
  const { basis, samples } = z.poly;                   // samples: [bearing, radius] sorted
  const rel = target.clone().sub(z.dir.clone().multiplyScalar(target.dot(z.dir)));
  if (rel.lengthSq() < 1e-12) return true;             // at the center
  const bearing = Math.atan2(rel.dot(basis.east), rel.dot(basis.north));
  let lo = samples[samples.length - 1], hi = samples[0], span, frac;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i][0] >= bearing) { hi = samples[i]; lo = samples[(i - 1 + samples.length) % samples.length]; break; }
    if (i === samples.length - 1) { lo = samples[i]; hi = samples[0]; }
  }
  span = hi[0] - lo[0];
  if (span <= 0) span += Math.PI * 2;
  let d = bearing - lo[0];
  if (d < 0) d += Math.PI * 2;
  frac = span < 1e-9 ? 0 : Math.min(1, d / span);
  const rimRad = lo[1] + (hi[1] - lo[1]) * frac;
  return ang < rimRad + extraRadius;
}

function isInZone(dir, zones, extraRadius = 0) {
  const target = dir.clone().normalize();
  return zones.some(z => zoneContains(z, target, extraRadius));
}

// register a pond-shaped water zone from its (splined) rim
function registerPolyZone(zoneList, center, rim, label) {
  const basis = tangentBasis(center);
  let maxRad = 0;
  const samples = rim.map(d => {
    const rad = Math.acos(Math.max(-1, Math.min(1, d.dot(center))));
    maxRad = Math.max(maxRad, rad);
    const rel = d.clone().sub(center.clone().multiplyScalar(d.dot(center)));
    const bearing = rel.lengthSq() < 1e-12 ? 0 : Math.atan2(rel.dot(basis.east), rel.dot(basis.north));
    return [bearing, rad];
  }).sort((p, q) => p[0] - q[0]);
  const z = { dir: center.clone().normalize(), radius: maxRad, label, poly: { basis, samples } };
  zoneList.push(z);
  return z;
}

function registerPolyWaterZone(center, rim, label = 'pond') {
  return registerPolyZone(waterZones, center, rim, label);
}

function registerPolyLandZone(center, rim, label = 'island') {
  return registerPolyZone(landZones, center, rim, label);
}

function isOnBridgeDir(dir) {
  return isInZone(dir, bridgeZones, 0.01);
}

function isWaterSurfaceDir(dir) {
  return isInZone(dir, waterZones, 0) && !isInZone(dir, landZones, 0);
}

function isInWaterDir(dir) {
  return isWaterSurfaceDir(dir) && !isOnBridgeDir(dir);
}

function terrainCoverageSummary(sampleCount = 4096) {
  const count = Math.max(256, Math.min(16384, Math.floor(sampleCount)));
  const direction = new THREE.Vector3();
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  let water = 0;
  for (let index = 0; index < count; index++) {
    const y = 1 - (2 * (index + 0.5)) / count;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = index * goldenAngle;
    direction.set(Math.cos(angle) * ring, y, Math.sin(angle) * ring);
    if (isWaterSurfaceDir(direction)) water++;
  }
  const waterPercent = water / count * 100;
  return {
    radius: R,
    diameter: +(R * 2).toFixed(2),
    circumference: +(Math.PI * R * 2).toFixed(2),
    surfaceArea: +(Math.PI * R * R * 4).toFixed(2),
    samples: count,
    seaBandPercent: +((SEA_BAND_MAX_Y - SEA_BAND_MIN_Y) * 50).toFixed(1),
    waterPercent: +waterPercent.toFixed(1),
    landPercent: +(100 - waterPercent).toFixed(1),
  };
}

function getSurfaceColliders() {
  return surfaceColliders;
}

function hasSurfaceClearance(dir, extraRadius = 0) {
  const target = dir.clone().normalize();
  return getSurfaceColliders().every(c => target.dot(c.dir) <= Math.cos(c.radius + extraRadius));
}

function isBlockedSurfaceDir(dir) {
  return !hasSurfaceClearance(dir, 0);
}

// Signed clearance from the nearest solid prop. Positive is walkable; negative
// means the point is inside one or more collider discs.
function surfaceColliderClearance(dir) {
  const target = dir.clone().normalize();
  let clearance = Infinity;
  for (const c of getSurfaceColliders()) {
    const angle = Math.acos(Math.max(-1, Math.min(1, target.dot(c.dir))));
    clearance = Math.min(clearance, angle - c.radius);
  }
  return clearance;
}

function surfaceColliderPenetration(dir) {
  const target = dir.clone().normalize();
  let depth = 0;
  for (const c of getSurfaceColliders()) {
    const angle = Math.acos(Math.max(-1, Math.min(1, target.dot(c.dir))));
    depth += Math.max(0, c.radius - angle);
  }
  return depth;
}

// Character separation or a moved prop can leave an NPC inside a collider.
// Resolve the deepest overlap first and repeat because roadside props may
// overlap one another. This prevents an agent from remaining trapped in a pole.
const _collisionQ = new THREE.Quaternion();
function resolveSurfaceColliderPenetration(dir, margin = 0.006) {
  const out = dir.clone().normalize();
  for (let pass = 0; pass < 8; pass++) {
    let deepest = null;
    let penetration = 0;
    for (const c of getSurfaceColliders()) {
      const dot = Math.max(-1, Math.min(1, out.dot(c.dir)));
      const amount = c.radius + margin - Math.acos(dot);
      if (amount > penetration) { penetration = amount; deepest = c; }
    }
    if (!deepest || penetration <= 0) break;

    // Negative spherical gradient: tangent direction away from the collider.
    const dot = out.dot(deepest.dir);
    const away = out.clone().multiplyScalar(dot).sub(deepest.dir);
    if (away.lengthSq() < 1e-10) away.copy(tangentBasis(out).east);
    away.normalize();
    const axis = new THREE.Vector3().crossVectors(out, away).normalize();
    _collisionQ.setFromAxisAngle(axis, penetration + 0.001);
    out.applyQuaternion(_collisionQ).normalize();
  }
  return out;
}

function offsetSurfaceDir(dir, tangent, amount) {
  const up = dir.clone().normalize();
  const side = tangent.clone().sub(up.clone().multiplyScalar(tangent.dot(up)));
  if (side.lengthSq() < 1e-8) side.copy(tangentBasis(up).east);
  return up.add(side.normalize().multiplyScalar(amount)).normalize();
}

// The planet's vertices use restrained relief for a hand-shaped silhouette
// mesh below) — this evaluates the SAME height function analytically, so
// everything placed on the surface hugs the actual terrain instead of
// floating over dips / sinking into bumps at the mean radius.
function terrainRadius(dir) {
  const p = dir.clone().normalize().multiplyScalar(R);
  return R + TERRAIN_RELIEF * Math.sin(p.x * 1.3) * Math.cos(p.y * 1.1) * Math.sin(p.z * 1.2);
}

function placeOnSphere(obj, dir, lift = 0) {
  const up = dir.clone().normalize();
  obj.position.copy(up.clone().multiplyScalar(terrainRadius(up) + lift));
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  obj.rotateY(Math.random() * Math.PI * 2);
}

function placeOnSphereFacing(obj, dir, forward, lift = 0) {
  const up = dir.clone().normalize();
  const face = forward.clone().sub(up.clone().multiplyScalar(forward.dot(up)));
  if (face.lengthSq() < 1e-8) face.copy(tangentBasis(up).north);
  face.normalize();
  const right = new THREE.Vector3().crossVectors(up, face).normalize();
  obj.position.copy(up.clone().multiplyScalar(terrainRadius(up) + lift));
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, face));
}

function slerpDir(a, b, t) {
  const angle = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
  if (angle < 1e-5) return a.clone();
  const s = Math.sin(angle);
  return a.clone().multiplyScalar(Math.sin((1 - t) * angle) / s)
    .add(b.clone().multiplyScalar(Math.sin(t * angle) / s))
    .normalize();
}

// Resample a polyline of unit dirs into a smooth curve of unit dirs. A
// Catmull-Rom spline is fitted through the points (samples re-normalized onto
// the sphere) so hand-clicked paths bend smoothly instead of kinking at every
// click. Returns { dirs, closed } — closed when the input repeats its first
// point (or forceClosed), in which case the duplicate is dropped and the
// spline wraps around seamlessly.
function splineDirs(points, { step = 0.02, forceClosed = false } = {}) {
  const dirs = points.map(p => p.clone().normalize());
  let closed = forceClosed;
  if (dirs.length > 2 && dirs[0].dot(dirs[dirs.length - 1]) > 0.99995) {
    dirs.pop();
    closed = true;
  }
  closed = closed && dirs.length > 2;
  if (dirs.length < 2) return { dirs, closed: false };
  let total = 0;
  for (let i = 0; i < dirs.length - (closed ? 0 : 1); i++) {
    const a = dirs[i], b = dirs[(i + 1) % dirs.length];
    total += Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
  }
  const n = Math.min(600, Math.max(4, Math.ceil(total / step)));
  if (dirs.length === 2) {
    const out = [];
    for (let i = 0; i <= n; i++) out.push(slerpDir(dirs[0], dirs[1], i / n));
    return { dirs: out, closed: false };
  }
  const curve = new THREE.CatmullRomCurve3(dirs, closed, 'centripetal');
  const out = [];
  const last = closed ? n - 1 : n;
  for (let i = 0; i <= last; i++) out.push(curve.getPoint(i / n).normalize());
  return { dirs: out, closed };
}

// A continuous mitered ribbon following the splined path over the terrain —
// one BufferGeometry with shared edge vertices instead of per-segment boxes,
// so tight curves and even closed loops render without fan-gap artifacts.
function makeSurfaceRibbon(points, { width = 0.8, lift = 0.055, material }) {
  const { dirs, closed } = splineDirs(points);
  const N = dirs.length;
  const geo = new THREE.BufferGeometry();
  if (N < 2) return new THREE.Mesh(geo, material);
  const half = (width / 2) / R;                 // angular half-width
  const columns = Math.max(2, Math.ceil(width / 0.12) + 1);
  const pos = new Float32Array(N * columns * 3);
  const nor = new Float32Array(N * columns * 3);
  for (let i = 0; i < N; i++) {
    const d = dirs[i];
    const prev = dirs[closed ? (i - 1 + N) % N : Math.max(0, i - 1)];
    const next = dirs[closed ? (i + 1) % N : Math.min(N - 1, i + 1)];
    const fwd = next.clone().sub(prev);
    fwd.sub(d.clone().multiplyScalar(fwd.dot(d)));   // keep it tangent
    if (fwd.lengthSq() < 1e-10) fwd.copy(tangentBasis(d).north);
    fwd.normalize();
    const side = new THREE.Vector3().crossVectors(d, fwd).normalize();
    for (let k = 0; k < columns; k++) {
      const e = offsetSurfaceDir(d, side, (k / (columns - 1) * 2 - 1) * half);
      const r = terrainRadius(e) + lift;
      const o = (i * columns + k) * 3;
      pos[o] = e.x * r; pos[o + 1] = e.y * r; pos[o + 2] = e.z * r;
      nor[o] = e.x; nor[o + 1] = e.y; nor[o + 2] = e.z;
    }
  }
  const segs = closed ? N : N - 1;
  const idx = [];
  for (let i = 0; i < segs; i++) {
    for (let k = 0; k < columns - 1; k++) {
      const a = i * columns + k, b = a + 1;
      const c = ((i + 1) % N) * columns + k, d2 = c + 1;
      idx.push(a, c, b, b, c, d2);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return mesh;
}

function makeCountryRoad(points, { width = 0.8, lift = 0.055, color = 0xbba17a, material = null } = {}) {
  const road = new THREE.Group();
  road.add(makeSurfaceRibbon(points, { width, lift, material: material || toonMat(color) }));
  return road;
}

function registerPathZones(points, radius, label, stepAngle = 0.065, register = registerWaterZone) {
  const created = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i].clone().normalize();
    const b = points[i + 1].clone().normalize();
    const angle = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
    const steps = Math.max(1, Math.ceil(angle / stepAngle));
    for (let j = i === 0 ? 0 : 1; j <= steps; j++) {
      created.push(register(slerpDir(a, b, j / steps), radius, label));
    }
  }
  return created;
}

function makeRiver(points, { width = 1.45, shoreWidth = 1.9, lift = 0.07 } = {}) {
  const g = new THREE.Group();
  const shore = makeCountryRoad(points, { width: shoreWidth, lift: lift - 0.012, color: 0xd6c79e });
  const waterMat = new THREE.MeshToonMaterial({
    color: THEME.world.water,
    gradientMap: TOON_GRAD,
    emissive: 0x0e5a78,
    emissiveIntensity: 0.15,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
  });
  const water = makeCountryRoad(points, { width, lift, material: waterMat });
  g.add(shore, water);
  return g;
}

// centroid of a set of unit dirs, back on the sphere
function centroidDir(dirs) {
  return dirs.reduce((acc, d) => acc.add(d), new THREE.Vector3()).normalize();
}

// Fill a closed rim on the sphere with a terrain-hugging cap: rings of
// vertices are slerped from the center out to the rim so even large fills
// follow the bumpy terrain. `grow` pushes the rim outward (shore bands).
// Double-sided so the drawn outline's winding direction never matters.
function makeCapMesh(center, rim, { lift = 0.05, grow = 0, material }) {
  const M = rim.length;
  const geo = new THREE.BufferGeometry();
  if (M < 3) return new THREE.Mesh(geo, material);
  const edge = rim.map(d => {
    if (!grow) return d;
    const away = d.clone().sub(center.clone().multiplyScalar(d.dot(center)));
    if (away.lengthSq() < 1e-12) return d;
    return offsetSurfaceDir(d, away.normalize(), grow);
  });
  let maxAng = 0;
  for (const d of edge) maxAng = Math.max(maxAng, Math.acos(Math.max(-1, Math.min(1, d.dot(center)))));
  const rings = Math.max(2, Math.ceil(maxAng / 0.02));
  const vcount = 1 + rings * M;
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const put = (vi, e) => {
    const r = terrainRadius(e) + lift;
    const o = vi * 3;
    pos[o] = e.x * r; pos[o + 1] = e.y * r; pos[o + 2] = e.z * r;
    nor[o] = e.x; nor[o + 1] = e.y; nor[o + 2] = e.z;
  };
  put(0, center);
  for (let ri = 1; ri <= rings; ri++) {
    const t = ri / rings;
    for (let j = 0; j < M; j++) put(1 + (ri - 1) * M + j, slerpDir(center, edge[j], t));
  }
  const idx = [];
  for (let j = 0; j < M; j++) idx.push(0, 1 + j, 1 + (j + 1) % M);
  for (let ri = 1; ri < rings; ri++) {
    const a0 = 1 + (ri - 1) * M, b0 = 1 + ri * M;
    for (let j = 0; j < M; j++) {
      const j2 = (j + 1) % M;
      idx.push(a0 + j, b0 + j, a0 + j2, a0 + j2, b0 + j, b0 + j2);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(idx);
  material.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return mesh;
}

function makeLatitudeBand(minY, maxY, { lift = 0.064, material, contoured = false } = {}) {
  const lonSegments = 128;
  const latSegments = 48;
  const geo = new THREE.BufferGeometry();
  const rows = latSegments + 1;
  const cols = lonSegments + 1;
  const pos = new Float32Array(rows * cols * 3);
  const nor = new Float32Array(rows * cols * 3);
  const d = new THREE.Vector3();
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const a = (ix / lonSegments) * Math.PI * 2;
      const bounds = contoured ? oceanBandBounds(a, minY, maxY) : { min: minY, max: maxY };
      const y = THREE.MathUtils.lerp(bounds.min, bounds.max, iy / latSegments);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      d.set(Math.cos(a) * r, y, Math.sin(a) * r).normalize();
      const surface = terrainRadius(d) + lift;
      const o = (iy * cols + ix) * 3;
      pos[o] = d.x * surface; pos[o + 1] = d.y * surface; pos[o + 2] = d.z * surface;
      nor[o] = d.x; nor[o + 1] = d.y; nor[o + 2] = d.z;
    }
  }
  const idx = [];
  for (let iy = 0; iy < latSegments; iy++) {
    for (let ix = 0; ix < lonSegments; ix++) {
      const a = iy * cols + ix, b = a + 1, c = a + cols, d2 = c + 1;
      idx.push(a, c, b, b, c, d2);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, material || makeSeaWaterMat());
  mesh.receiveShadow = true;
  return mesh;
}

function makePondWaterMat() {
  return new THREE.MeshToonMaterial({
    color: THEME.world.water,
    gradientMap: TOON_GRAD,
    emissive: 0x0e5a78,
    emissiveIntensity: 0.15,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
  });
}

function makeSeaWaterMat() {
  return new THREE.MeshToonMaterial({
    color: THEME.world.seaMid,
    gradientMap: TOON_GRAD,
    emissive: THEME.world.seaDeep,
    emissiveIntensity: 0.14,
    transparent: false,
    opacity: 1,
    depthWrite: true,
  });
}

// (makeLake / registerLakeZones are gone — lakes are drawn 'pond' paths now.)

function makeSurfacePatch(rx, rz, color, { opacity = 1, lift = 0.035 } = {}) {
  const mat = new THREE.MeshToonMaterial({
    color,
    gradientMap: TOON_GRAD,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
  const patch = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.035, 18), mat);
  patch.scale.set(rx, 1, rz);
  patch.position.y = lift;
  patch.receiveShadow = true;
  return patch;
}

// A shallow, flat village ledge. The stone skirt gives the residential area a
// readable vertical profile while the grass top keeps it part of the island.
// Houses overlap the top slightly on purpose, so the pad reads as terrain
// rather than a separate display plinth.
function makeVillageTerrace(rx = 1.05, rz = 0.56, accentColor = 0x879a8b) {
  const g = new THREE.Group();
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1.03, 0.13, 20),
    toonMat(0x929b96)
  );
  skirt.scale.set(rx, 1, rz);
  skirt.position.y = 0.065;
  skirt.castShadow = true;
  skirt.receiveShadow = true;

  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(0.99, 1, 0.04, 20),
    toonMat(0xb4c49f)
  );
  top.scale.set(rx, 1, rz);
  top.position.y = 0.145;
  top.receiveShadow = true;
  const identityRim = new THREE.Mesh(
    new THREE.TorusGeometry(0.88, 0.035, 5, 28),
    toonMat(accentColor),
  );
  identityRim.rotation.x = Math.PI / 2;
  identityRim.scale.set(rx, rz, 1);
  identityRim.position.y = 0.18;
  identityRim.castShadow = true;

  // Three broad pavers make the front of every lot readable from the opening
  // camera without adding another gameplay collider.
  const paverMat = toonMat(0xd9d3c3);
  for (let index = -1; index <= 1; index++) {
    const paver = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.045, 0.16), paverMat);
    paver.position.set(index * 0.29, 0.19, rz * 0.76);
    paver.rotation.y = index * 0.06;
    paver.castShadow = true;
    paver.receiveShadow = true;
    g.add(paver);
  }
  g.add(skirt, top, identityRim);
  return g;
}

function makeWorkPlaza(rx = 0.82, rz = 0.43) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 0.055, 24),
    toonMat(0x687878)
  );
  base.scale.set(rx, 1, rz);
  base.position.y = 0.028;
  base.receiveShadow = true;

  // A quiet inner inlay gives the eye a centre without becoming a monument.
  const inlay = new THREE.Mesh(
    new THREE.CylinderGeometry(0.76, 0.76, 0.018, 24),
    toonMat(0xc9c0a7)
  );
  inlay.scale.set(rx, 1, rz);
  inlay.position.y = 0.064;
  inlay.receiveShadow = true;

  const paverGeometry = new THREE.BoxGeometry(0.23, 0.035, 0.10);
  const pavers = new THREE.InstancedMesh(paverGeometry, toonMat(0xe0d7bf), 6);
  const paver = new THREE.Object3D();
  for (let index = 0; index < 6; index++) {
    const angle = index / 6 * Math.PI * 2;
    paver.position.set(Math.cos(angle) * rx * 0.80, 0.082, Math.sin(angle) * rz * 0.80);
    paver.rotation.set(0, -angle, 0);
    paver.updateMatrix();
    pavers.setMatrixAt(index, paver.matrix);
  }
  pavers.castShadow = true;
  pavers.receiveShadow = true;

  // Agent state already appears on the operations beacon and in the HUD.
  // Repeating six coloured nodes here made the centre read as a second dial.
  g.add(base, inlay, pavers);
  return g;
}

function makeBridge(length = 4.3, width = 0.78) {
  const g = new THREE.Group();
  const plankMat = toonMat(0x9b6f4d);
  const railMat = toonMat(0x6f4e3c);
  for (let i = 0; i < 9; i++) {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(width, 0.09, length / 10), plankMat);
    plank.position.z = (i - 4) * (length / 9);
    plank.position.y = 0.05;
    plank.castShadow = true;
    g.add(plank);
  }
  [-width / 2 - 0.12, width / 2 + 0.12].forEach(x => {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, length), railMat);
    rail.position.set(x, 0.22, 0);
    rail.castShadow = true;
    g.add(rail);
  });
  return g;
}

function makeTrafficLight() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.5, 6), toonMat(0x59636d));
  pole.position.y = 0.75; pole.castShadow = true;
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.58, 0.16), toonMat(0x3b4550));
  box.position.y = 1.52; box.castShadow = true; addOutline(box, 1.035);
  [
    [0xff5f5f, 1.70],
    [0xffd86b, 1.52],
    [0x73dc78, 1.34],
  ].forEach(([color, y]) => {
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), new THREE.MeshBasicMaterial({ color }));
    light.position.set(0, y, 0.085);
    g.add(light);
  });
  g.add(pole, box);
  return g;
}

function makeRoadSign(kind = 'arrow') {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 1.1, 6), toonMat(0x7a8178));
  pole.position.y = 0.55; pole.castShadow = true;
  const sign = new THREE.Mesh(
    kind === 'stop' ? new THREE.CylinderGeometry(0.24, 0.24, 0.045, 8) : new THREE.BoxGeometry(0.42, 0.28, 0.045),
    toonMat(kind === 'stop' ? 0xff7777 : 0xffee9d)
  );
  sign.position.y = 1.15; sign.rotation.y = Math.PI / 2; sign.castShadow = true; addOutline(sign, 1.04);
  g.add(pole, sign);
  return g;
}

function makeBusStop() {
  const g = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.52), toonMat(0xb7bec6));
  floor.position.y = 0.04;
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.72, 0.06), toonMat(0xe8f4ff));
  back.position.set(0, 0.46, -0.23);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.08, 0.62), toonMat(0x5d8cc8));
  roof.position.y = 0.86;
  const bench = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.08, 0.16), toonMat(0x9b6f4d));
  bench.position.set(0, 0.28, 0.08);
  const signPole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.95, 6), toonMat(0x7a8178));
  signPole.position.set(-0.62, 0.47, 0.04);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.24, 0.035), toonMat(0x4f8bd8));
  sign.position.set(-0.62, 0.96, 0.04);
  [floor, back, roof, bench, signPole, sign].forEach(m => { m.castShadow = true; addOutline(m, 1.025); g.add(m); });
  g.userData.colliderRadius = 0.07;
  return g;
}

function makeUtilityPole() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 1.85, 7), toonMat(0x8a6f5a));
  pole.position.y = 0.92;
  const cross = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.055, 0.055), toonMat(0x6f5747));
  cross.position.y = 1.66;
  const capA = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), toonMat(0xf4f0d9));
  const capB = capA.clone();
  capA.position.set(-0.26, 1.72, 0); capB.position.set(0.26, 1.72, 0);
  [pole, cross, capA, capB].forEach(m => { m.castShadow = true; addOutline(m, 1.025); g.add(m); });
  g.userData.colliderRadius = 0.06;
  return g;
}

function makeGuardRail() {
  const g = new THREE.Group();
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.055, 0.065), toonMat(0xe9eef2));
  rail.position.y = 0.38;
  const p1 = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.42, 6), toonMat(0xaab2b8));
  const p2 = p1.clone();
  p1.position.set(-0.3, 0.2, 0); p2.position.set(0.3, 0.2, 0);
  [rail, p1, p2].forEach(m => { m.castShadow = true; addOutline(m, 1.02); g.add(m); });
  return g;
}

function makeMiniCar(color = 0xf0f4f7) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.32, 1.08), toonMat(color));
  body.position.y = 0.28;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.32, 0.48), toonMat(0xbfe7ff));
  cab.position.set(0, 0.55, -0.08);
  const wheelMat = toonMat(0x2d3338);
  [-0.32, 0.32].forEach(x => [-0.34, 0.34].forEach(z => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 10), wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, 0.14, z);
    g.add(wheel);
  }));
  [body, cab].forEach(m => { m.castShadow = true; addOutline(m, 1.025); g.add(m); });
  g.userData.colliderRadius = 0.08;
  return g;
}

function makeGreenhouse() {
  const g = new THREE.Group();
  const plastic = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.48, 1.45),
    new THREE.MeshToonMaterial({
      color: 0xe8fbff,
      gradientMap: TOON_GRAD,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    })
  );
  plastic.position.y = 0.28;
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.05, 1.5), toonMat(0xa9d5a0));
  base.position.y = 0.035;
  [base, plastic].forEach(m => { m.castShadow = true; addOutline(m, 1.018); g.add(m); });
  return g;
}

function addAgentHomeSignature(root, ownerKey) {
  if (!root || !ownerKey || root.userData.signatureKey === ownerKey) return;
  const agent = AGENT_CONFIG.find((candidate) => candidate.key === ownerKey);
  const spec = signatureForAgent(agent);
  if (!spec) return;

  if (root.userData.signatureRoot) {
    root.remove(root.userData.signatureRoot);
    disposeObject(root.userData.signatureRoot);
  }

  const color = configHex(agent?.color, 0x81bfbc);
  const glowColor = configHex(agent?.visual?.glowColor, color);
  const accent = toonMat(color);
  const dark = toonMat(0x4f5c61);
  const pale = toonMat(0xf5f2e8);
  const glow = new THREE.MeshToonMaterial({
    color: glowColor,
    emissive: glowColor,
    emissiveIntensity: 0.44,
    gradientMap: TOON_GRAD,
  });
  const signature = new THREE.Group();
  signature.name = ownerKey + '-' + spec.id;
  const motion = {
    kind: spec.motion,
    pivot: signature,
    glowMaterial: glow,
    active: false,
    baseY: 0,
    phase: Math.random() * Math.PI * 2,
  };

  if (spec.id === 'harmonic-fork') {
    signature.position.set(-0.72, 3.58, 0.18);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.72, 6), dark);
    mast.position.y = 0.36;
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.10, 0.13), accent);
    bridge.position.y = 0.75;
    const forkGeometry = new THREE.CylinderGeometry(0.045, 0.045, 0.56, 6);
    const left = new THREE.Mesh(forkGeometry, pale);
    const right = left.clone();
    left.position.set(-0.22, 1.00, 0);
    right.position.set(0.22, 1.00, 0);
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.14, 0), glow);
    star.position.y = 1.38;
    const repair = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.018, 5, 12), glow);
    repair.rotation.x = Math.PI / 2;
    repair.position.set(0, 0.53, 0);
    [mast, bridge, left, right, repair, star].forEach((mesh) => { mesh.castShadow = true; signature.add(mesh); });
    addOutline(bridge, 1.035);
    addOutline(star, 1.055);
    motion.pivot = star;
  } else if (spec.id === 'chronicle-dial') {
    signature.position.set(0, 4.08, 0.30);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.10, 16), pale);
    face.rotation.x = Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.052, 6, 20), accent);
    rim.position.z = 0.06;
    const memoryRingA = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.022, 6, 20), glow);
    const memoryRingB = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.016, 6, 18), glow);
    memoryRingA.position.z = 0.075;
    memoryRingB.position.z = 0.085;
    const hour = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.22, 0.035), dark);
    hour.position.set(-0.07, 0.08, 0.13);
    hour.rotation.z = 0.72;
    const minutePivot = new THREE.Group();
    minutePivot.position.z = 0.14;
    const minute = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.29, 0.035), glow);
    minute.position.y = 0.13;
    minutePivot.add(minute);
    [face, rim, memoryRingA, memoryRingB, hour].forEach((mesh) => { mesh.castShadow = true; signature.add(mesh); });
    signature.add(minutePivot);
    addOutline(face, 1.025);
    motion.pivot = minutePivot;
  } else if (spec.id === 'resonance-fork') {
    signature.position.set(-0.62, 3.58, -0.08);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.075, 1.02, 6), dark);
    mast.position.y = 0.51;
    const scan = new THREE.Group();
    scan.position.y = 1.02;
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.075, 0.08), pale);
    bridge.position.y = -0.10;
    const tineA = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.56, 7), pale);
    const tineB = tineA.clone();
    tineA.position.set(-0.19, 0.18, 0);
    tineB.position.set(0.19, 0.18, 0);
    const repair = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.018, 5, 12), glow);
    repair.rotation.x = Math.PI / 2;
    repair.position.y = -0.26;
    const node = new THREE.Mesh(new THREE.IcosahedronGeometry(0.105, 1), glow);
    node.position.y = 0.52;
    [-0.34, 0.34].forEach((x, index) => {
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.085, 0), accent);
      crystal.scale.y = 1.5;
      crystal.position.set(x, 0.04 + index * 0.05, 0);
      crystal.rotation.z = (index ? -1 : 1) * 0.38;
      scan.add(crystal);
    });
    [bridge, tineA, tineB, repair, node].forEach((mesh) => { mesh.castShadow = true; scan.add(mesh); });
    signature.add(mast, scan);
    addOutline(node, 1.05);
    motion.pivot = scan;
  } else if (spec.id === 'crescent-archive') {
    signature.position.set(-0.48, 4.02, 0.26);
    const crescent = new THREE.Mesh(
      new THREE.TorusGeometry(0.31, 0.075, 6, 22, Math.PI * 1.55),
      glow,
    );
    crescent.rotation.z = -0.36;
    const bookLow = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.11, 0.32), accent);
    const bookHigh = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.10, 0.30), pale);
    bookLow.position.set(0.52, -0.21, -0.02);
    bookHigh.position.set(0.48, -0.09, -0.02);
    bookHigh.rotation.z = 0.08;
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.11, 0.06), glow);
    lock.position.set(0.50, -0.03, 0.18);
    [crescent, bookLow, bookHigh, lock].forEach((mesh) => { mesh.castShadow = true; signature.add(mesh); });
    addOutline(crescent, 1.04);
    motion.pivot = crescent;
    motion.baseY = crescent.position.y;
  } else if (spec.id === 'flower-atelier') {
    signature.position.set(0, 3.96, 0.30);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, 0.62, 6), dark);
    stem.position.y = 0.02;
    const flower = new THREE.Group();
    flower.position.y = 0.46;
    const petals = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.17, 8, 6),
      accent,
      5,
    );
    const petal = new THREE.Object3D();
    for (let index = 0; index < 5; index++) {
      const angle = index / 5 * Math.PI * 2;
      petal.position.set(Math.cos(angle) * 0.25, Math.sin(angle) * 0.25, 0);
      petal.rotation.set(0, 0, angle - Math.PI / 2);
      petal.scale.set(0.62, 1, 0.42);
      petal.updateMatrix();
      petals.setMatrixAt(index, petal.matrix);
    }
    petals.castShadow = true;
    const centre = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 1), glow);
    centre.position.z = 0.08;
    centre.castShadow = true;
    flower.add(petals, centre);
    signature.add(stem, flower);
    [0x8db9a4, 0xd6a2bd, 0xe8c66e].forEach((bottleColor, index) => {
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.20, 7), toonMat(bottleColor));
      bottle.position.set(-0.18 + index * 0.18, -0.30, 0.03);
      signature.add(bottle);
    });
    addOutline(centre, 1.05);
    motion.pivot = flower;
  } else if (spec.id === 'owl-observatory') {
    signature.position.set(0, 6.24, 0);
    const orbit = new THREE.Group();
    orbit.rotation.x = 0.58;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.88, 0.035, 6, 28), accent);
    const lenses = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.095, 1),
      glow,
      3,
    );
    const lens = new THREE.Object3D();
    for (let index = 0; index < 3; index++) {
      const angle = index / 3 * Math.PI * 2;
      lens.position.set(Math.cos(angle) * 0.88, Math.sin(angle) * 0.88, 0);
      lens.scale.setScalar(index === 0 ? 1.18 : 0.88);
      lens.updateMatrix();
      lenses.setMatrixAt(index, lens.matrix);
    }
    ring.castShadow = true;
    lenses.castShadow = true;
    orbit.add(ring, lenses);
    const owl = makeBronzeOwlVessel(0.72);
    owl.position.set(0, -0.48, 0.12);
    signature.add(orbit, owl);
    motion.pivot = orbit;
  }

  root.add(signature);
  root.userData.signatureKey = ownerKey;
  root.userData.signatureSpec = spec;
  root.userData.signatureRoot = signature;
  root.userData.signatureMotion = motion;
}

function addAgentHomeFacade(root, ownerKey, kind = 'cottage') {
  if (!root || !ownerKey || root.userData.facadeKey === ownerKey) return;
  const agent = AGENT_CONFIG.find((candidate) => candidate.key === ownerKey);
  const spec = signatureForAgent(agent);
  if (!agent || !spec) return;

  const color = configHex(agent.color, 0x81bfbc);
  const glowColor = configHex(agent.visual?.glowColor, color);
  const accent = toonMat(color);
  const glow = toonMat(glowColor);
  const pale = toonMat(0xf4f1e8);
  const dark = toonMat(0x4b5058);
  const marker = new THREE.Group();
  marker.name = ownerKey + '-home-facade';
  marker.position.set(0, kind === 'lighthouse' ? 2.45 : 2.18, kind === 'lighthouse' ? 0.79 : 1.80);
  marker.scale.setScalar(kind === 'lighthouse' ? 0.82 : 1);
  const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.52, 0.07), dark);
  plaque.castShadow = true;
  marker.add(plaque);

  if (ownerKey === 'rodi') {
    const polaris = new THREE.Mesh(new THREE.OctahedronGeometry(0.105, 0), glow);
    polaris.scale.y = 1.35;
    polaris.position.z = 0.07;
    marker.add(polaris);
    [[-0.22, 0.13], [0.20, 0.15], [-0.15, -0.15], [0.18, -0.12]].forEach(([x, y]) => {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.027, 0), pale);
      star.position.set(x, y, 0.07);
      marker.add(star);
    });
  } else if (ownerKey === 'jarvis') {
    [0.20, 0.135, 0.075].forEach((radius, index) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.018, 6, 18), index ? glow : accent);
      ring.position.z = 0.07 + index * 0.006;
      marker.add(ring);
    });
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.14, 0.018), pale);
    hand.position.set(0.035, 0.045, 0.105);
    hand.rotation.z = -0.52;
    marker.add(hand);
  } else if (ownerKey === 'yul') {
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.045, 0.03), pale);
    bridge.position.set(0, -0.09, 0.075);
    [-0.10, 0.10].forEach(x => {
      const tine = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.25, 0.03), pale);
      tine.position.set(x, 0.05, 0.075);
      marker.add(tine);
    });
    const repair = new THREE.Mesh(new THREE.TorusGeometry(0.047, 0.012, 5, 10), glow);
    repair.position.set(0, -0.16, 0.08);
    [-0.24, 0.24].forEach((x, index) => {
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.065, 0), accent);
      crystal.scale.y = 1.35;
      crystal.position.set(x, 0.03, 0.075);
      crystal.rotation.z = (index ? -1 : 1) * 0.35;
      marker.add(crystal);
    });
    marker.add(bridge, repair);
  } else if (ownerKey === 'ludwig') {
    const book = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.27, 0.045), accent);
    book.position.z = 0.075;
    const pages = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.21, 0.025), pale);
    pages.position.z = 0.105;
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.03), glow);
    lock.position.set(0, 0, 0.13);
    marker.add(book, pages, lock);
  } else if (ownerKey === 'anne') {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.045, 0.04), pale);
    shelf.position.set(0, -0.15, 0.075);
    [0x8db9a4, 0xd6a2bd, 0xe8c66e].forEach((bottleColor, index) => {
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.20, 7), toonMat(bottleColor));
      bottle.position.set(-0.16 + index * 0.16, -0.035, 0.075);
      marker.add(bottle);
    });
    const ribbon = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.018, 5, 14, Math.PI * 1.55), accent);
    ribbon.position.set(0, 0.13, 0.08);
    ribbon.rotation.z = -0.65;
    marker.add(shelf, ribbon);
  } else if (ownerKey === 'argos') {
    const eye = new THREE.Mesh(new THREE.TorusGeometry(0.20, 0.035, 6, 20), glow);
    eye.scale.y = 0.62;
    eye.position.z = 0.08;
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.062, 8, 6), accent);
    pupil.position.z = 0.105;
    [-0.24, 0.24].forEach((x, index) => {
      const featherEye = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.014, 5, 12), pale);
      featherEye.position.set(x, -0.11 + index * 0.04, 0.08);
      marker.add(featherEye);
    });
    marker.add(eye, pupil);
  }

  root.add(marker);
  root.userData.facadeKey = ownerKey;
  root.userData.facadeRoot = marker;
  root.userData.homeCanonStyle = spec.id;
}

function makeCottage({ wall = 0xf7f5f0, roof = 0xe8896b, scale = 1, ownerKey = '' } = {}) {
  const g = new THREE.Group();
  // Cut-out walls and folded card roofs retain the existing walkable footprint.
  const foundation = new THREE.Mesh(
    new THREE.BoxGeometry(3.68, 0.22, 3.30),
    toonMat(0xaeb9aa),
  );
  foundation.position.y = 0.15;
  foundation.castShadow = true;
  foundation.receiveShadow = true;
  addOutline(foundation, 1.016);
  const base = makePaperHouseShell(toonMat, { wall, accent: roof });
  // Coplanar card layers use their baked color separation, avoiding shadow-map
  // acne on the facade while still casting the house silhouette onto the ground.
  base.receiveShadow = false;
  const roofMat = toonMat(roof);
  const roofLeft = makePaperSlab(toonMat, { width: 2.24, length: 3.74, color: roof, depth: 0.06, gap: 0.045, folds: 3 });
  const roofRight = roofLeft.clone();
  roofLeft.position.set(-0.83, 3.02, 0); roofLeft.rotation.z = 0.47;
  roofRight.position.set(0.83, 3.02, 0); roofRight.rotation.z = -0.47;
  [roofLeft, roofRight].forEach(m => { m.castShadow = true; addOutline(m, 1.025); });
  const paperEdge = toonMat(0xf1eee2);
  const foundationSheet = makePaperSlab(toonMat, { width: 3.76, length: 3.38, color: 0xb9c8b7, depth: 0.035, gap: 0.012 });
  foundationSheet.position.y = 0.30;
  foundationSheet.castShadow = foundationSheet.receiveShadow = true;
  g.add(foundationSheet);
  const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.70, 6), roofMat);
  ridge.position.y = 3.53;
  ridge.rotation.x = Math.PI / 2;
  ridge.castShadow = true;
  addOutline(ridge, 1.03);
  const door = makePaperDoor(toonMat, { width: 0.82, height: 1.78, color: roof });
  door.position.set(0, 0.9, 1.63);
  door.receiveShadow = false;
  const windowTrim = makePaperWindowTrim(toonMat, { accent: roof });
  windowTrim.receiveShadow = false;
  g.add(windowTrim);
  const windowMat = new THREE.MeshToonMaterial({
    color: 0xfff0b8,
    emissive: 0xd89a43,
    emissiveIntensity: 0.28,
    gradientMap: TOON_GRAD,
  });
  const leftWindow = new THREE.Mesh(new THREE.BoxGeometry(0.79, 0.79, 0.055), windowMat);
  const rightWindow = leftWindow.clone();
  leftWindow.position.set(-1.12, 1.45, 1.525);
  rightWindow.position.set(1.12, 1.45, 1.525);
  const sillGeometry = new THREE.BoxGeometry(0.98, 0.08, 0.24);
  for (const x of [-1.12, 1.12]) {
    const sill = new THREE.Mesh(sillGeometry, paperEdge);
    sill.position.set(x, 1.00, 1.74);
    sill.castShadow = sill.receiveShadow = true;
    g.add(sill);
  }
  const sideWindow = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.73, 0.88), windowMat);
  sideWindow.position.set(1.605, 1.42, 0.2);
  const oppositeWindow = sideWindow.clone();
  oppositeWindow.position.x *= -1;
  const rearWindow = new THREE.Mesh(new THREE.BoxGeometry(1.01, 0.79, 0.055), windowMat);
  rearWindow.position.set(0, 1.45, -1.525);
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.92, 0.34), toonMat(0xa57f70));
  chimney.position.set(1.08, 3.62, -0.25); chimney.castShadow = true; addOutline(chimney, 1.035);
  const stoop = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.12, 0.48), toonMat(0xb8a18b));
  stoop.position.set(0, 0.06, 1.82);
  g.add(
    foundation, base, roofLeft, roofRight, ridge, door,
    leftWindow, rightWindow, sideWindow, oppositeWindow, rearWindow,
    chimney, stoop,
  );
  const architecture = makeCottageArchitecture({
    ownerKey,
    wallMaterial: toonMat(wall),
    roofMaterial: roofMat,
    edgeMaterial: paperEdge,
    glassMaterial: windowMat,
  });
  g.add(architecture);
  g.scale.setScalar(scale);
  g.userData.colliderRadius = 0.27 * scale;
  g.userData.windowMaterials = [windowMat];
  g.userData.architectureProfile = architecture.userData.architectureProfile;
  g.userData.paperConstruction = 'layered-cut-card';
  g.userData.scaleSpec = {
    doorHeight: 1.78 * scale,
    footprintWidth: 3.68 * scale,
    profile: architecture.userData.architectureProfile,
  };
  g.userData.homeLabelOffset = new THREE.Vector3(0, ownerKey === 'rodi' ? 4.92 : 4.08, 1.62);
  g.userData.homeFlagOffset = new THREE.Vector3(1.35, 0, 2.25);
  g.userData.doorOffset = new THREE.Vector3(0, 0, 2.15);
  addAgentHomeFacade(g, ownerKey);
  addAgentHomeSignature(g, ownerKey);
  return g;
}

function makeFishingBoat(color = 0xf2f0e8) {
  const g = new THREE.Group();
  const floatBody = new THREE.Group();
  const hull = makePaperRelief(toonMat, { template: 'hull', color, layers: 5, step: 0.055 });
  hull.rotation.x = Math.PI / 2; hull.position.y = 0.22;
  const deck = new THREE.Mesh(paperCutGeometry('hull', 0.035), [toonMat(0xf0e9d4), toonMat(0xdbcab7)]);
  deck.rotation.x = Math.PI / 2;
  deck.scale.set(0.88, 0.92, 1);
  deck.position.y = 0.35;
  deck.receiveShadow = true;
  floatBody.add(deck);
  const stripe = new THREE.Mesh(paperCutGeometry('hull', 0.04), [toonMat(0x477c9b), toonMat(0xf4f0e7)]);
  stripe.rotation.x = Math.PI / 2;
  stripe.position.y = 0.29;
  stripe.scale.set(0.92, 0.94, 1);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.38, 0.46), toonMat(0xf7f2df));
  cabin.position.set(0, 0.52, -0.12);
  const cabinRoof = makePaperSlab(toonMat, { width: 0.56, length: 0.55, color: 0x80b4c1, depth: 0.018, gap: 0.009 });
  cabinRoof.position.set(0, 0.72, -0.12);
  floatBody.add(cabinRoof);
  const window = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.04), toonMat(0x79b9d4));
  window.position.set(0, 0.56, 0.13);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.025, 0.86, 6), toonMat(0x7e6754));
  mast.position.set(0, 0.73, 0.25);
  const pennantGeometry = new THREE.BufferGeometry();
  pennantGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, 0, 0.28, -0.07, 0, 0, -0.15, 0,
  ]), 3));
  pennantGeometry.computeVertexNormals();
  const pennant = new THREE.Mesh(
    pennantGeometry,
    new THREE.MeshBasicMaterial({ color: 0xe96f61, side: THREE.DoubleSide }),
  );
  pennant.position.set(0.02, 1.14, 0.25);
  [hull, stripe, cabin, window, mast].forEach(m => { m.castShadow = true; addOutline(m, 1.025); floatBody.add(m); });
  floatBody.add(pennant);
  g.add(floatBody);
  g.userData.floatBody = floatBody;
  g.userData.pennant = pennant;
  g.userData.motionKind = 'boat';
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  return g;
}

function makeHarborBuoy() {
  const g = new THREE.Group();
  const floatBody = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), toonMat(0xe96b62));
  body.scale.y = 1.25; body.position.y = 0.13;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.08, 10), toonMat(0xf8f4e8));
  band.position.y = 0.13;
  floatBody.add(body, band);
  g.add(floatBody);
  g.userData.floatBody = floatBody;
  g.userData.motionKind = 'buoy';
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  return g;
}

function makeChannelBeacon(color = 0xe5b94f) {
  const g = new THREE.Group();
  const floatBody = new THREE.Group();
  const dark = toonMat(0x365468);
  const accent = toonMat(color);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.34, 0.24, 8), accent);
  base.position.y = 0.12;
  const bumper = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.055, 5, 12), dark);
  bumper.rotation.x = Math.PI / 2;
  bumper.position.y = 0.13;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, 0.92, 7), dark);
  pole.position.y = 0.66;
  const platform = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.06, 8), accent);
  platform.position.y = 1.05;
  const lightMat = new THREE.MeshToonMaterial({
    color: 0xffe7a0,
    emissive: 0xffb84d,
    emissiveIntensity: 0.42,
    gradientMap: TOON_GRAD,
  });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.105, 8, 6), lightMat);
  lamp.position.y = 1.20;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.13, 8), dark);
  cap.position.y = 1.34;
  [base, bumper, pole, platform, lamp, cap].forEach((mesh) => {
    mesh.castShadow = true;
    addOutline(mesh, 1.025);
    floatBody.add(mesh);
  });
  g.add(floatBody);
  g.userData.floatBody = floatBody;
  g.userData.motionKind = 'buoy';
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  return g;
}

function makeCargoFerry(color = 0xd98267) {
  const g = new THREE.Group();
  const floatBody = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.40, 0.54, 2.05, 6), toonMat(0x365468));
  hull.rotation.x = Math.PI / 2;
  hull.scale.set(1.18, 0.72, 0.72);
  hull.position.y = 0.20;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.12, 1.52), toonMat(0xe5dcc4));
  deck.position.y = 0.39;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.48, 0.52), toonMat(0xf2efe5));
  cabin.position.set(0, 0.67, 0.43);
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.19, 0.045), toonMat(0x78b5c4));
  windshield.position.set(0, 0.72, 0.705);
  const cargoA = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.28, 0.48), toonMat(color));
  cargoA.position.set(-0.21, 0.58, -0.35);
  const cargoB = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.28, 0.48), toonMat(0xe0b854));
  cargoB.position.set(0.21, 0.58, -0.35);
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.36, 7), toonMat(0x6b584d));
  stack.position.set(0.25, 1.01, 0.39);
  [hull, deck, cabin, windshield, cargoA, cargoB, stack].forEach((mesh) => {
    mesh.castShadow = true;
    addOutline(mesh, 1.025);
    floatBody.add(mesh);
  });

  const wakeGeometry = new THREE.BufferGeometry();
  wakeGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.34, 0.03, -0.80, -0.10, 0.03, -1.92, -0.50, 0.03, -1.72,
     0.34, 0.03, -0.80,  0.50, 0.03, -1.72,  0.10, 0.03, -1.92,
  ]), 3));
  wakeGeometry.computeVertexNormals();
  const wake = new THREE.Mesh(
    wakeGeometry,
    new THREE.MeshBasicMaterial({ color: 0xeaf8f3, transparent: true, opacity: 0.76, side: THREE.DoubleSide }),
  );
  g.add(wake, floatBody);
  g.userData.floatBody = floatBody;
  g.userData.motionKind = 'boat';
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  return g;
}

function makeVendingMachine() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.56, 1.22, 0.38), toonMat(0x67afa8));
  body.position.y = 0.61;
  const displayMat = new THREE.MeshToonMaterial({
    color: 0xd9f4e8,
    emissive: 0x78b9a9,
    emissiveIntensity: 0.16,
    gradientMap: TOON_GRAD,
  });
  const display = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.48, 0.035), displayMat);
  display.position.set(0, 0.78, 0.207);
  const controls = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.24, 0.04), toonMat(0xf0d27d));
  controls.position.set(0.15, 0.39, 0.21);
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 0.04), toonMat(0x365468));
  slot.position.set(-0.08, 0.20, 0.21);
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.09, 0.46), toonMat(0xe9e5d8));
  canopy.position.y = 1.26;
  const feet = [-0.18, 0.18].map((x) => {
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.24), toonMat(0x52636a));
    foot.position.set(x, 0.06, 0);
    return foot;
  });
  [body, display, controls, slot, canopy, ...feet].forEach((mesh) => {
    mesh.castShadow = true;
    addOutline(mesh, 1.025);
    g.add(mesh);
  });
  return g;
}

function makeConvexMirror() {
  const g = new THREE.Group();
  const poleMat = toonMat(0x53646a);
  const accentMat = toonMat(0xe77f58);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.34, 7), poleMat);
  pole.position.y = 0.67;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.055, 0.055), poleMat);
  arm.position.set(0.15, 1.24, 0);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.045, 6, 14), accentMat);
  rim.position.set(0.31, 1.24, 0.035);
  const mirrorMat = new THREE.MeshToonMaterial({
    color: 0xcde8e6,
    emissive: 0x6f9ea5,
    emissiveIntensity: 0.10,
    gradientMap: TOON_GRAD,
    side: THREE.DoubleSide,
  });
  const mirror = new THREE.Mesh(new THREE.CircleGeometry(0.215, 16), mirrorMat);
  mirror.position.set(0.31, 1.24, 0.04);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.12, 7), accentMat);
  base.position.y = 0.06;
  [pole, arm, rim, mirror, base].forEach((mesh) => {
    mesh.castShadow = true;
    addOutline(mesh, 1.025);
    g.add(mesh);
  });
  return g;
}

function makeNetRack() {
  const g = new THREE.Group();
  const wood = toonMat(0x8d6b52);
  const netMat = new THREE.MeshBasicMaterial({ color: 0xc9c7bd, transparent: true, opacity: 0.72, side: THREE.DoubleSide });
  [-0.46, 0.46].forEach(x => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.05, 6), wood);
    post.position.set(x, 0.52, 0); post.castShadow = true; g.add(post);
  });
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.06), wood);
  top.position.y = 1.02;
  const net = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.72, 5, 4), netMat);
  net.position.y = 0.6;
  net.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
  g.add(top, net);
  g.userData.net = net;
  g.userData.netBasePositions = Float32Array.from(net.geometry.attributes.position.array);
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  return g;
}

function makeMarketStall(color = 0xe88768) {
  const g = new THREE.Group();
  const wood = toonMat(0x8b6b52);
  const wall = toonMat(0xe8e3d5);
  const trim = toonMat(0x53666a);
  const counter = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.40, 0.54), toonMat(0xb58c68));
  counter.position.y = 0.22;
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.08, 1.12, 0.10), wall);
  back.position.set(0, 0.58, -0.37);
  const sideLeft = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.88, 0.72), wall);
  const sideRight = sideLeft.clone();
  sideLeft.position.set(-0.49, 0.46, -0.04);
  sideRight.position.set(0.49, 0.46, -0.04);
  const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.42, 0.045), toonMat(0x8fb4b8));
  hatch.position.set(0, 0.67, -0.31);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.22, 0.075), trim);
  sign.position.set(0, 1.28, -0.26);
  const signPaper = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.07, 0.02), toonMat(0xefd477));
  signPaper.position.set(0, 0, 0.05);
  sign.add(signPaper);
  const canopy = new THREE.Group();
  canopy.position.y = 1.03;
  const canopyColors = [color, 0xf4ead6];
  for (let index = 0; index < 6; index++) {
    const strip = makePaperSlab(toonMat, { width: 0.19, length: 0.72, color: canopyColors[index % 2], depth: 0.018, gap: 0.009 });
    strip.position.x = (index - 2.5) * 0.19;
    strip.castShadow = true;
    addOutline(strip, 1.018);
    canopy.add(strip);
  }
  [-0.44, 0.44].forEach(x => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 1.0, 6), wood);
    post.position.set(x, 0.52, -0.2); g.add(post);
  });
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.07, 0.34), toonMat(0x738c92));
  tray.position.set(0, 0.47, 0.02);
  const catchMat = toonMat(0x9fc9cc);
  [-0.24, 0, 0.24].forEach((x, index) => {
    const catchPiece = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.19, 3, 6), catchMat);
    catchPiece.rotation.z = Math.PI / 2;
    catchPiece.rotation.y = index * 0.18;
    catchPiece.position.set(x, 0.55, 0.03);
    catchPiece.castShadow = true;
    g.add(catchPiece);
  });
  [counter, back, sideLeft, sideRight, hatch, sign, tray].forEach(m => {
    m.castShadow = true;
    m.receiveShadow = m === back || m === sideLeft || m === sideRight;
    addOutline(m, 1.025);
    g.add(m);
  });
  g.add(canopy);
  g.userData.awning = canopy;
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  return g;
}

function makeFishCrate() {
  const g = new THREE.Group();
  const frame = toonMat(0x5f777d);
  const slat = toonMat(0x8fa4a7);
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.22, 0.40), frame);
  crate.position.y = 0.11;
  crate.castShadow = true;
  addOutline(crate, 1.03);
  g.add(crate);
  for (let index = -1; index <= 1; index++) {
    const frontSlat = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.16, 0.025), slat);
    frontSlat.position.set(index * 0.18, 0.12, 0.215);
    const backSlat = frontSlat.clone();
    backSlat.position.z = -0.215;
    g.add(frontSlat, backSlat);
  }
  const fishMat = toonMat(0xaed7da);
  [-0.13, 0.13].forEach((x, index) => {
    const fish = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.16, 3, 6), fishMat);
    fish.rotation.z = Math.PI / 2;
    fish.rotation.y = index ? 0.28 : -0.22;
    fish.position.set(x, 0.27, 0);
    fish.castShadow = true;
    g.add(fish);
  });
  return g;
}

function makeStreetLamp() {
  const g = new THREE.Group();
  const metal = toonMat(0x53666a);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 0.16, 8), toonMat(0x8d9692));
  base.position.y = 0.08;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 1.65, 8), metal);
  pole.position.y = 0.88;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.055, 0.055), metal);
  arm.position.set(0.17, 1.64, 0);
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.16, 8), metal);
  hood.position.set(0.36, 1.50, 0);
  hood.rotation.z = Math.PI;
  const glow = new THREE.MeshToonMaterial({
    color: 0xffe5a5,
    emissive: 0xe9a84f,
    emissiveIntensity: 0.72,
    gradientMap: TOON_GRAD,
  });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.095, 9, 7), glow);
  bulb.scale.y = 0.82;
  bulb.position.set(0.36, 1.43, 0);
  [base, pole, arm, hood, bulb].forEach((mesh) => {
    mesh.castShadow = true;
    g.add(mesh);
  });
  [pole, arm, hood].forEach((mesh) => addOutline(mesh, 1.024));
  return g;
}

function makeWayfinder() {
  const g = new THREE.Group();
  const postMat = toonMat(0x53666a);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 1.68, 8), postMat);
  post.position.y = 0.84;
  const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), toonMat(0xf0d06b));
  cap.position.y = 1.78;
  [post, cap].forEach((mesh) => { mesh.castShadow = true; addOutline(mesh, 1.03); g.add(mesh); });
  const fallbackColors = [0xffd76b, 0x71879e, 0x72c8c5, 0x9188bd, 0xe99591, 0x7f79bd];
  AGENT_CONFIG.slice(0, 6).forEach((agent, index) => {
    const side = index % 2 ? -1 : 1;
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(0.54, 0.14, 0.07),
      toonMat(configHex(agent?.color, fallbackColors[index])),
    );
    board.position.set(side * 0.22, 1.46 - index * 0.19, 0);
    board.rotation.y = side > 0 ? -0.08 : 0.08;
    board.castShadow = true;
    addOutline(board, 1.025);
    const point = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.19, 3), board.material);
    point.position.set(side * 0.52, board.position.y, 0);
    point.rotation.z = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    point.castShadow = true;
    g.add(board, point);
  });
  return g;
}

function makeAgentStation(agentKey = '') {
  const g = new THREE.Group();
  const agent = AGENT_CONFIG.find((candidate) => candidate.key === agentKey);
  const color = configHex(agent?.color, 0x81bfbc);
  const graphite = toonMat(0x53666a);
  const timber = toonMat(0x8b725d);
  const pale = toonMat(0xe9ece7);
  const accent = toonMat(color);

  const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.46, 0.08, 10), accent);
  pad.scale.z = 0.80;
  pad.position.y = 0.04;
  const padTop = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.025, 10), pale);
  padTop.scale.z = 0.80;
  padTop.position.y = 0.09;
  const desk = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.10, 0.24), timber);
  desk.position.set(0, 0.34, -0.04);
  const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.30, 0.10), graphite);
  pedestal.position.set(0, 0.18, -0.04);
  const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.23, 0.055), pale);
  monitor.position.set(0, 0.56, -0.02);
  monitor.rotation.x = -0.10;
  const screen = new THREE.Mesh(
    new THREE.BoxGeometry(0.25, 0.14, 0.012),
    new THREE.MeshToonMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.45,
      gradientMap: TOON_GRAD,
    }),
  );
  screen.position.set(0, 0.56, 0.015);
  screen.rotation.x = -0.10;
  const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.18, 8), accent);
  stool.position.set(0, 0.09, 0.34);
  const stationMeshes = [pad, padTop, desk, pedestal, monitor, screen, stool];
  stationMeshes.forEach((mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = mesh === pad || mesh === padTop;
    g.add(mesh);
  });
  [pad, desk, monitor].forEach((mesh) => addOutline(mesh, 1.025));
  g.userData.stationAgentKey = agentKey;
  return g;
}

function makeHarborCrane() {
  const g = new THREE.Group();
  const steel = toonMat(0x426b78);
  const accent = toonMat(0xe4a24a);
  const dark = toonMat(0x4f5558);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.20, 10), dark);
  base.position.y = 0.10;
  const mast = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.25, 0.18), steel);
  mast.position.y = 1.28;
  const boom = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.16, 0.18), steel);
  boom.position.set(0.60, 2.30, 0);
  boom.rotation.z = 0.12;
  const brace = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.10, 0.11), accent);
  brace.position.set(0.35, 1.82, 0);
  brace.rotation.z = 0.72;
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.02, 6), dark);
  cable.position.set(1.27, 1.73, 0);
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.028, 6, 14, Math.PI * 1.45), accent);
  hook.position.set(1.27, 1.17, 0);
  hook.rotation.z = -0.34;
  [base, mast, boom, brace, cable, hook].forEach((mesh) => {
    mesh.castShadow = true;
    g.add(mesh);
  });
  [base, mast, boom, hook].forEach((mesh) => addOutline(mesh, 1.025));
  return g;
}

function makeDockBollard() {
  const g = new THREE.Group();
  const metal = toonMat(0x59666a);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.12, 8), metal);
  base.position.y = 0.06;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.13, 0.36, 8), metal);
  post.position.y = 0.24;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.08, 8), toonMat(0xe7b34f));
  cap.position.y = 0.45;
  [base, post, cap].forEach((mesh) => { mesh.castShadow = true; g.add(mesh); });
  addOutline(post, 1.025);
  return g;
}

function makeCargoCluster() {
  const g = new THREE.Group();
  const crateA = makeFishCrate();
  crateA.position.set(-0.22, 0, 0.05);
  crateA.rotation.y = -0.12;
  const crateB = makeFishCrate();
  crateB.scale.setScalar(0.76);
  crateB.position.set(0.30, 0, -0.08);
  crateB.rotation.y = 0.26;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.20, 0.48, 10), toonMat(0x927053));
  barrel.position.set(0.06, 0.24, 0.30);
  barrel.rotation.z = 0.08;
  const rope = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.035, 6, 18), toonMat(0xc4a36f));
  rope.rotation.x = Math.PI / 2;
  rope.position.set(-0.18, 0.06, -0.32);
  barrel.castShadow = true;
  addOutline(barrel, 1.025);
  g.add(crateA, crateB, barrel, rope);
  return g;
}

function makeCivicPavilion() {
  return makePaperPublicSpace(toonMat, 'garden');
}

function makeClockKiosk() {
  const g = new THREE.Group();
  const dark = toonMat(0x4f5f67);
  const bodyMat = toonMat(0x6e8aa0);
  const faceMat = toonMat(0xf0ead7);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.32, 0.18, 8), dark);
  base.position.y = 0.09;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.38, 1.12, 0.34), bodyMat);
  body.position.y = 0.72;
  const crown = makePaperTierRoof(toonMat, { radius: 0.34, height: 0.28, color: 0x6e8aa0 });
  crown.position.y = 1.28;
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.045, 16), faceMat);
  face.rotation.x = Math.PI / 2;
  face.position.set(0, 1.05, 0.19);
  const handLong = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.16, 0.025), dark);
  handLong.position.set(0, 1.10, 0.22);
  handLong.rotation.z = 0.45;
  const handShort = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.026, 0.025), dark);
  handShort.position.set(0.045, 1.05, 0.222);
  handShort.rotation.z = -0.20;
  [base, body, crown, face, handLong, handShort].forEach((mesh) => {
    mesh.castShadow = true;
    addOutline(mesh, 1.024);
    g.add(mesh);
  });
  return g;
}

function makeRepairShed() {
  const g = new THREE.Group();
  const steel = toonMat(0x426b78);
  const pale = toonMat(0xd9e0dc);
  const timber = toonMat(0x8d725b);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.12, 1.08), toonMat(0x929b99));
  slab.position.y = 0.06;
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.92, 0.10), steel);
  back.position.set(0, 0.55, -0.48);
  const sideA = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.92, 0.95), pale);
  const sideB = sideA.clone();
  sideA.position.set(-0.57, 0.55, 0);
  sideB.position.set(0.57, 0.55, 0);
  const roofA = makePaperSlab(toonMat, { width: 0.82, length: 1.28, color: 0x426b78, depth: 0.025, gap: 0.016 });
  const roofB = roofA.clone();
  roofA.position.set(-0.31, 1.16, -0.02); roofA.rotation.z = 0.36;
  roofB.position.set(0.31, 1.16, -0.02); roofB.rotation.z = -0.36;
  const bench = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.12, 0.34), timber);
  bench.position.set(0, 0.35, -0.27);
  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.54, 0.28), toonMat(0xe3a34d));
  cabinet.position.set(0.40, 0.38, -0.28);
  const doorMat = toonMat(0x6f8890);
  const doorA = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.72, 0.055), doorMat);
  const doorB = doorA.clone();
  doorA.position.set(-0.26, 0.42, 0.49);
  doorB.position.set(0.26, 0.42, 0.49);
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.12, 0.10), timber);
  lintel.position.set(0, 0.86, 0.50);
  const workshopSign = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.22, 0.08), toonMat(0xe7e2d4));
  workshopSign.position.set(0, 1.02, 0.51);
  const signMark = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.055, 0.025), toonMat(0xe3a34d));
  signMark.position.set(0, 0, 0.055);
  workshopSign.add(signMark);
  [slab, back, sideA, sideB, roofA, roofB, bench, cabinet, doorA, doorB, lintel, workshopSign].forEach((mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = mesh === slab;
    addOutline(mesh, 1.023);
    g.add(mesh);
  });
  return g;
}

function makeResultBoard() {
  return villageBoard.createMesh(toonMat);
}

function makeFerryGate() {
  const g = new THREE.Group();
  const metal = toonMat(0x4f666c);
  const accent = toonMat(0xd6a84e);
  [-0.42, 0.42].forEach((x) => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 1.30, 8), metal);
    post.position.set(x, 0.65, 0);
    post.castShadow = true;
    g.add(post);
  });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.13, 0.12), metal);
  beam.position.y = 1.24;
  const marker = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 7, 18), accent);
  marker.position.set(0, 1.25, 0.08);
  [beam, marker].forEach((mesh) => { mesh.castShadow = true; addOutline(mesh, 1.024); g.add(mesh); });
  return g;
}

function makePlanterCluster() {
  const g = new THREE.Group();
  const stone = toonMat(0x9aa49d);
  const soil = toonMat(0x6f5f4f);
  const leafMats = [toonMat(0x5f8b68), toonMat(0x7aa077), toonMat(0x8fad7f)];
  const ground = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.76, 0.06, 12), toonMat(0xb9c5aa));
  ground.scale.z = 0.72;
  ground.position.y = 0.03;
  ground.receiveShadow = true;
  g.add(ground);
  [[-0.38, 0.22], [0.34, 0.20], [0, -0.25]].forEach(([x, z], index) => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.25, 0.42), stone);
    box.position.set(x, 0.15, z);
    const bed = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.04, 0.31), soil);
    bed.position.set(x, 0.285, z);
    const plant = new THREE.Mesh(new THREE.IcosahedronGeometry(0.24 + index * 0.025, 1), leafMats[index]);
    plant.scale.y = 0.78;
    plant.position.set(x, 0.46, z);
    box.castShadow = true;
    plant.castShadow = true;
    addOutline(box, 1.024);
    g.add(box, bed, plant);
  });
  const marker = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.72, 0.12), toonMat(0x53666a));
  marker.position.set(0.58, 0.36, -0.18);
  const markerTop = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.20, 0.08), toonMat(0xe7e2d4));
  markerTop.position.set(0.48, 0.63, -0.18);
  marker.castShadow = true;
  markerTop.castShadow = true;
  addOutline(markerTop, 1.024);
  g.add(marker, markerTop);
  return g;
}

function makeTetrapod() {
  const g = new THREE.Group();
  const concrete = toonMat(0xa9adb2);
  const core = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18, 0), concrete);
  core.position.y = 0.22;
  const armGeo = new THREE.CylinderGeometry(0.09, 0.15, 0.62, 6);
  const armAngles = [
    [0, 0, 0],
    [Math.PI / 2, 0, 0],
    [Math.PI / 2, 0, Math.PI / 2],
    [0.72, 0, 0.78],
  ];
  for (const [rx, ry, rz] of armAngles) {
    const arm = new THREE.Mesh(armGeo, concrete);
    arm.position.y = 0.22;
    arm.rotation.set(rx, ry, rz);
    arm.castShadow = true;
    addOutline(arm, 1.035);
    g.add(arm);
  }
  core.castShadow = true;
  addOutline(core, 1.035);
  g.add(core);
  return g;
}

function makeLighthouse(ownerKey = '') {
  const g = new THREE.Group();
  const owner = AGENT_CONFIG.find((candidate) => candidate.key === ownerKey);
  const paperColor = ownerKey === 'argos' ? 0xeeeaf2 : 0xfbfaf5;
  const accent = toonMat(configHex(owner?.color, 0xe5524b));
  const stone = toonMat(0xa8a3a2);
  const stoneTop = toonMat(0xc7c1b3);
  const apronBase = new THREE.Mesh(
    new THREE.CylinderGeometry(2.10, 2.24, 0.18, 12),
    stone,
  );
  apronBase.position.y = 0.09;
  const apronTop = new THREE.Mesh(
    new THREE.CylinderGeometry(1.96, 2.06, 0.08, 12),
    stoneTop,
  );
  apronTop.position.y = 0.22;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 1.22, 0.48, 12), stone);
  base.position.y = 0.24;
  const tower = makePaperTower(toonMat, { bottomRadius: 0.92, topRadius: 0.58, height: 4.3, color: paperColor });
  tower.position.y = 2.55;
  const bandLow = makePaperTower(toonMat, { bottomRadius: 0.91, topRadius: 0.84, height: 0.54, color: accent.color, layers: 2 });
  bandLow.position.y = 1.42;
  const bandHigh = makePaperTower(toonMat, { bottomRadius: 0.73, topRadius: 0.68, height: 0.5, color: accent.color, layers: 2 });
  bandHigh.position.y = 3.48;
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(0.88, 0.88, 0.16, 12), accent);
  gallery.position.y = 4.78;
  const lanternMat = new THREE.MeshToonMaterial({
    color: 0xffe5a1, emissive: 0xf2a52f, emissiveIntensity: 0.85,
    gradientMap: TOON_GRAD, transparent: true, opacity: 0.86,
  });
  const lanternRoom = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.7, 10), lanternMat);
  lanternRoom.position.y = 5.18;
  const roof = makePaperTierRoof(toonMat, { radius: 0.72, height: 0.62, color: accent.color, tiers: 6, sides: 10 });
  roof.position.y = 5.54;
  const door = makePaperDoor(toonMat, { width: 0.62, height: 1.18, color: accent.color });
  door.position.set(0, 0.86, 0.87);

  const rail = new THREE.Group();
  const railRing = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.035, 6, 24), accent);
  railRing.rotation.x = Math.PI / 2;
  railRing.position.y = 5.02;
  rail.add(railRing);
  for (let i = 0; i < 8; i++) {
    const angle = i / 8 * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.28, 6), accent);
    post.position.set(Math.cos(angle) * 0.78, 4.94, Math.sin(angle) * 0.78);
    rail.add(post);
  }

  const beamPivot = new THREE.Group();
  beamPivot.position.y = 5.2;
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xffdc72, transparent: true, opacity: 0.27,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.72, 5.6, 12, 1, true), beamMat);
  beam.rotation.x = Math.PI / 2;
  beam.position.z = 2.85;
  beamPivot.add(beam);

  [apronBase, apronTop, base, tower, bandLow, bandHigh, gallery, lanternRoom, roof, door].forEach(m => {
    m.castShadow = true; addOutline(m, 1.025); g.add(m);
  });
  rail.traverse((m) => { if (m.isMesh) m.castShadow = true; });
  g.add(rail, beamPivot);
  g.userData.colliderRadius = 0.22;
  g.userData.windowMaterials = [lanternMat];
  g.userData.lighthouseBeam = beamPivot;
  g.userData.homeLabelOffset = new THREE.Vector3(0, 6.35, 0.5);
  g.userData.homeFlagOffset = new THREE.Vector3(1.25, 0, 1.15);
  g.userData.doorOffset = new THREE.Vector3(0, 0, 1.28);
  addAgentHomeFacade(g, ownerKey, 'lighthouse');
  addAgentHomeSignature(g, ownerKey);
  return g;
}

// The village's operational landmark. It is intentionally code-native rather
// than a downloaded model: every node maps to a real configured agent and can
// change color/intensity without loading another texture or draw-call-heavy
// animation rig.
function makeOpsBeacon() {
  const g = new THREE.Group();
  const graphite = toonMat(0x53656b);
  const pale = toonMat(0xe8f0ee);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.70, 0.14, 12), graphite);
  base.position.y = 0.07;
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(0.54, 0.58, 0.09, 12), pale);
  deck.position.y = 0.18;
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.72, 8), toonMat(0x71858a));
  pedestal.position.y = 0.56;
  const coreMaterial = new THREE.MeshToonMaterial({
    color: 0x8bd8d2,
    emissive: 0x5fa3a0,
    emissiveIntensity: 0.72,
    gradientMap: TOON_GRAD,
  });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 1), coreMaterial);
  core.position.y = 1.03;
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xb8efea,
    transparent: true,
    opacity: 0.74,
    depthWrite: false,
  });
  const horizontalRing = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.025, 6, 30), ringMaterial);
  horizontalRing.position.y = 0.82;
  horizontalRing.rotation.x = Math.PI / 2;
  const orbitPivot = new THREE.Group();
  orbitPivot.position.y = 1.03;
  const verticalRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.35, 0.018, 6, 26),
    ringMaterial.clone(),
  );
  verticalRing.rotation.y = Math.PI / 2;
  orbitPivot.add(verticalRing);

  [base, deck, pedestal, core].forEach((mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = mesh === base || mesh === deck;
    addOutline(mesh, 1.025);
    g.add(mesh);
  });
  g.add(horizontalRing, orbitPivot);

  const fallbackColors = [0xffd76b, 0x71879e, 0x72c8c5, 0x9188bd, 0xe99591, 0x7f79bd];
  const configured = AGENT_CONFIG.slice(0, 6);
  const nodes = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const agent = configured[i];
    const color = configHex(agent?.color, fallbackColors[i]);
    const spoke = new THREE.Mesh(
      new THREE.BoxGeometry(0.025, 0.025, 0.40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38 }),
    );
    spoke.position.set(Math.cos(angle) * 0.24, 0.82, Math.sin(angle) * 0.24);
    spoke.rotation.y = -angle + Math.PI / 2;
    const material = new THREE.MeshToonMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.45,
      gradientMap: TOON_GRAD,
    });
    const node = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 1), material);
    node.position.set(Math.cos(angle) * 0.49, 0.82, Math.sin(angle) * 0.49);
    node.castShadow = true;
    addOutline(node, 1.04);
    nodes.push({ key: agent?.key || `agent-${i + 1}`, color, mesh: node, material, spoke: spoke.material });
    g.add(spoke, node);
  }

  g.userData.opsBeacon = {
    core,
    coreMaterial,
    horizontalRing,
    orbitPivot,
    ringMaterials: [ringMaterial, verticalRing.material],
    nodes,
  };
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  g.userData.colliderRadius = 0.13;
  return g;
}

function makeCamelliaTree() {
  const g = new THREE.Group();
  const canopy = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.15, 0.9, 6), toonMat(0x86664f));
  trunk.position.y = 0.45;
  [[0, 1.24, 0, 0.64], [-0.38, 1.12, 0.06, 0.50], [0.38, 1.13, -0.02, 0.52]].forEach(([x,y,z,s], i) => {
    const crown = makePaperCanopy(toonMat, { color: i % 2 ? 0x85b78e : 0x619b79 });
    crown.scale.setScalar(s);
    crown.position.set(x,y,z); canopy.add(crown);
  });
  const bloomColors = [0xe7686d, 0xf29a8f];
  [
    [-0.40,1.34,0.35],[-0.17,1.53,0.46],[0.12,1.48,0.53],[0.40,1.31,0.34],
    [0.46,1.08,0.35],[0.02,1.12,0.61],[-0.38,1.04,0.42],[0.22,1.65,0.25],
    [-0.28,1.43,-0.39],[0.30,1.38,-0.40],[-0.45,1.16,-0.24],[0.46,1.18,-0.27],
  ].forEach(([x,y,z], i) => {
    const bloom = makePaperRelief(toonMat, { template: 'blossom', color: bloomColors[i % 2], layers: 3, step: 0.06 });
    bloom.scale.setScalar(i % 3 === 0 ? 0.21 : 0.17);
    bloom.rotation.y = Math.atan2(x, z);
    bloom.position.set(x,y,z); canopy.add(bloom);
  });
  trunk.castShadow = true; g.add(trunk, canopy);
  g.userData.swayGroup = canopy;
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  return g;
}

function makeCoastPine() {
  const g = new THREE.Group();
  const canopy = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.16, 1.35, 6),
    toonMat(0x80664f),
  );
  trunk.position.set(0.10, 0.66, 0);
  trunk.rotation.z = -0.17;
  trunk.castShadow = true;
  addOutline(trunk, 1.025);
  g.add(trunk);

  [
    [0.02,1.38,0.02,0.74,0.62,0.64],
    [0.20,1.96,-0.04,0.52,0.48,0.46],
  ].forEach(([x,y,z,sx,sy,sz], i) => {
    const crown = makePaperCanopy(toonMat, { pine: true, color: [0x619b7c, 0x8aba8d][i % 2] });
    crown.position.set(x,y,z);
    crown.scale.set(sx,sy,sz);
    crown.castShadow = true;
    canopy.add(crown);
  });
  g.add(canopy);
  g.rotation.z = -0.05;
  g.userData.swayGroup = canopy;
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  g.userData.colliderRadius = 0.10;
  return g;
}

// a few pastel green tones so the foliage isn't flat
const LEAF_TONES = [0x789779, 0x6f8d72, 0x90a783, 0xa4b58e];

function makeTree() {
  const g = new THREE.Group();
  const foliage = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.95, 5), toonMat(0xc9a87c));
  trunk.position.y = 0.47;
  const tone = LEAF_TONES[0];
  // stacked cones => fuller pine
  const c1 = makePaperCanopy(toonMat, { pine: true, color: tone });
  const c2 = makePaperCanopy(toonMat, { pine: true, color: 0x8db899 });
  const c3 = makePaperCanopy(toonMat, { pine: true, color: 0xb0ce9d });
  c1.scale.set(0.8, 0.65, 0.8); c2.scale.set(0.64, 0.55, 0.64); c3.scale.set(0.46, 0.45, 0.46);
  c1.position.y = 1.08; c2.position.y = 1.68; c3.position.y = 2.22;
  trunk.castShadow = true; addOutline(trunk); g.add(trunk);
  [c1, c2, c3].forEach(m => foliage.add(m));
  g.add(foliage);
  g.userData.colliderRadius = 0.11;
  g.userData.swayGroup = foliage;
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  return g;
}

function makeRock() {
  const g = new THREE.Group();
  const rock = makePaperRelief(toonMat, { template: 'stone', color: 0x9ea6aa, layers: 6, step: 0.10 });
  rock.rotation.x = -Math.PI / 2;
  rock.scale.set(0.34, 0.42, 0.70);
  rock.position.y = 0.035;
  g.add(rock);
  return g;
}

const PETAL_TONES = [0xffb3c6, 0xffe9a8, 0xc9b8ff, 0xffc9de, 0xfff5f7];
function makeFlower(color = PETAL_TONES[0]) {
  const g = new THREE.Group();
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015,0.015,0.3,4), toonMat(0x9bd49b));
  stem.position.y = 0.15;
  const head = makePaperRelief(toonMat, { template: 'blossom', color, layers: 3 });
  head.scale.setScalar(0.15);
  head.rotation.x = -0.6;
  head.position.y = 0.32;
  [stem, head].forEach(m => g.add(m));
  addOutline(head);
  return g;
}

// Main terrain plan: lay the village out as a flat map first, then project it
// onto the tiny planet. Local map x = left/right across the village, z = depth.
const MAP_CENTER = new THREE.Vector3(0.0, 0.58, 0.82).normalize();
const MAP_FRAME = tangentBasis(MAP_CENTER);
function mapDir(x, z) {
  return MAP_CENTER.clone()
    .add(MAP_FRAME.east.clone().multiplyScalar(x))
    .add(MAP_FRAME.north.clone().multiplyScalar(z))
    .normalize();
}
function mapForward(x, z) {
  return MAP_FRAME.east.clone().multiplyScalar(x)
    .add(MAP_FRAME.north.clone().multiplyScalar(z))
    .normalize();
}
const DEFAULT_PLAYER_SPAWN_DIR = mapDir(0, -0.18);
const PLAYER_CLEARANCE_RADIUS = 0.026;
// NPC work anchors are separate from the six central dashboard stations. Homes
// may spread across the harbor districts while operational status remains easy
// to scan at the civic core.
const AGENT_DISTRICT_ANCHORS = Object.freeze({
  rodi: Object.freeze([0, 0.85, 0.52]),
  jarvis: Object.freeze([-0.76, 0.64, 0.10]),
  yul: Object.freeze([0.76, 0.64, 0.10]),
  ludwig: Object.freeze([-0.34, 0.78, -0.52]),
  anne: Object.freeze([0.55, 0.65, -0.53]),
});
const DASHBOARD_VIEW_DIR = mapDir(0, 0.34);
const DASHBOARD_VIEW_FORWARD = mapForward(0, 1);
// ===========================================================================
// EDITABLE OBJECT REGISTRY
// Point objects (houses, trees, signs, …) are described as plain data so the
// whole village is serializable — that's what lets the edit mode move & save
// things. Each entry: { type, x, z, yaw, scale }. `type` keys into FACTORIES.
//   x,z   = position on the village map (same coords as the rest of the layout)
//   yaw   = extra rotation around the surface normal (radians)
//   scale = size multiplier (1 = the factory's default)
// Terrain (water, roads, bridges, the forest ground patch) is NOT editable —
// it stays hand-built below — so the editor only deals with these point props.
// ===========================================================================
// `baseScale` normalizes every prop against the CHARACTER (1.3 tall) so the
// world reads as one coherent miniature: houses shrink to give the planet
// breathing room, vehicles/furniture grow to human scale, trees follow houses.
// It multiplies both the mesh and the collider radius (and the user's per-item
// `scale` from edit mode stacks on top).
// Each def is asset METADATA, not just a factory: `category` groups the editor
// palette, `paletteLabel` is the human name, `variants` are curated looks the
// inspector offers as swatches (limited on purpose — good results without
// color theory), `editableParams` says which knobs the inspector shows.
const PROP_DEFS = {
  opsBeacon: {
    make: () => makeOpsBeacon(),
    lift: 0.065, collider: 0.13, baseScale: 1.25, label: 'operations-core',
    category: '관제', paletteLabel: '✦ 운영 코어', editableParams: ['scale', 'yaw'],
  },
  civicPavilion: {
    make: () => makeCivicPavilion(),
    lift: 0.055, collider: 0.045, label: 'civic-pavilion',
    category: '관제', paletteLabel: '◉ 공용 정자', editableParams: ['scale', 'yaw'],
  },
  harborShelter: {
    make: () => makePaperPublicSpace(toonMat, 'harbor'),
    lift: 0.055, collider: 0, label: 'harbor-shelter',
    category: '항구', paletteLabel: '⌂ 항구 쉼터', editableParams: ['scale', 'yaw'],
  },
  clockKiosk: {
    make: () => makeClockKiosk(),
    lift: 0.055, collider: 0.05, label: 'clock-kiosk',
    category: '관제', paletteLabel: '◷ 시간 키오스크', editableParams: ['scale', 'yaw'],
  },
  resultBoard: {
    make: () => makeResultBoard(),
    lift: 0.055, collider: 0.10, label: 'result-board',
    category: '관제', paletteLabel: '▤ 마을 게시판', editableParams: ['scale', 'yaw'],
  },
  cottage: {
    make: (o) => makeCottage({
      wall: o.wall,
      roof: o.roof,
      scale: (o.scale ?? 1) * 0.92,
      ownerKey: o.ownerKey,
    }),
    lift: 0.08, collider: 0.27, baseScale: 0.92, scaleInFactory: true, label: 'cottage',
    category: '건물', paletteLabel: '🏠 집',
    editableParams: ['variant', 'scale', 'yaw'],
    variants: [
      { name: '살구',   wall: 0xffdfb8, roof: 0xd77c72 },
      { name: '하늘',   wall: 0xcde8ff, roof: 0x8aaed8 },
      { name: '크림',   wall: 0xffefbf, roof: 0xe09b64 },
      { name: '새싹',   wall: 0xd9f0c5, roof: 0x7fae78 },
      { name: '라일락', wall: 0xf4d4ff, roof: 0xb28ad8 },
    ],
  },
  greenhouse: { make: () => makeGreenhouse(), lift: 0.055, collider: 0.12, label: 'greenhouse',
    category: '건물', paletteLabel: '🏡 비닐하우스', editableParams: ['scale', 'yaw'] },
  repairShed: { make: () => makeRepairShed(), lift: 0.055, collider: 0.14, label: 'repair-shed',
    category: '건물', paletteLabel: '▰ 항구 수리소', editableParams: ['scale', 'yaw'] },
  tree:   { make: () => makeTree(), lift: 0.035, collider: 0.12, baseScale: 0.85, label: 'tree',
    category: '자연', paletteLabel: '🌲 나무', editableParams: ['scale', 'yaw'] },
  rock:   { make: () => makeRock(), lift: 0.06, collider: 0, label: 'rock',
    category: '자연', paletteLabel: '🪨 바위', editableParams: ['scale', 'yaw'] },
  flower: { make: (o) => makeFlower(o.color ?? PETAL_TONES[0]), lift: 0.0, collider: 0, label: 'flower',
    category: '자연', paletteLabel: '🌸 꽃', editableParams: ['variant', 'scale', 'yaw'],
    variants: PETAL_TONES.map((color, index) => ({ name: `꽃 ${index + 1}`, color })) },
  trafficLight: { make: () => makeTrafficLight(), lift: 0.08, collider: 0, baseScale: 1.2, label: 'traffic-light',
    category: '도로변', paletteLabel: '🚦 신호등', editableParams: ['scale', 'yaw'] },
  busStop: { make: () => makeBusStop(), lift: 0.06, collider: 0, baseScale: 1.3, label: 'bus-stop',
    category: '도로변', paletteLabel: '🚏 버스정류장', editableParams: ['scale', 'yaw'] },
  // Slim roadside furniture is decorative, not navigational geometry. Keeping
  // it out of the spherical collider set prevents wandering agents getting
  // pinned between a pole and a building while still leaving houses solid.
  utilityPole: { make: () => makeUtilityPole(), lift: 0.055, collider: 0, label: 'utility-pole',
    category: '도로변', paletteLabel: '🗼 전봇대', editableParams: ['scale', 'yaw'] },
  streetLamp: { make: () => makeStreetLamp(), lift: 0.055, collider: 0, label: 'street-lamp',
    category: '도로변', paletteLabel: '💡 항구 가로등', editableParams: ['scale', 'yaw'] },
  wayfinder: { make: () => makeWayfinder(), lift: 0.055, collider: 0, label: 'wayfinder',
    category: '관제', paletteLabel: '🧭 공명자 길표지', editableParams: ['scale', 'yaw'] },
  agentStation: { make: (o) => makeAgentStation(o.agentKey), lift: 0.055, collider: 0, label: 'agent-station',
    category: '관제', paletteLabel: '▣ 에이전트 작업대', editableParams: ['scale', 'yaw'] },
  guardRail: { make: () => makeGuardRail(), lift: 0.09, collider: 0, label: 'guard-rail',
    category: '도로변', paletteLabel: '🚧 가드레일', editableParams: ['scale', 'yaw'] },
  car: {
    make: (o) => makeMiniCar(o.color ?? 0xe7f0f2),
    lift: 0.09, collider: 0.08, baseScale: 1.4, label: 'car',
    category: '도로변', paletteLabel: '🚗 자동차',
    editableParams: ['variant', 'scale', 'yaw'],
    variants: [
      { name: '흰색', color: 0xe7f0f2 },
      { name: '파랑', color: 0x9fd0ff },
      { name: '노랑', color: 0xf7d774 },
      { name: '빨강', color: 0xe08a8a },
    ],
  },
  signArrow: { make: () => makeRoadSign('arrow'), lift: 0.06, collider: 0, label: 'road-sign',
    category: '도로변', paletteLabel: '➡️ 화살표 표지판', editableParams: ['scale', 'yaw'] },
  signStop: { make: () => makeRoadSign('stop'), lift: 0.06, collider: 0, label: 'road-sign',
    category: '도로변', paletteLabel: '🛑 정지 표지판', editableParams: ['scale', 'yaw'] },
  vendingMachine: { make: () => makeVendingMachine(), lift: 0.055, collider: 0, label: 'vending-machine',
    category: '도로변', paletteLabel: '▣ 항구 자판기', editableParams: ['scale', 'yaw'] },
  convexMirror: { make: () => makeConvexMirror(), lift: 0.055, collider: 0, label: 'convex-mirror',
    category: '도로변', paletteLabel: '◉ 곡선 반사경', editableParams: ['scale', 'yaw'] },
  fishingBoat: {
    make: (o) => makeFishingBoat(o.color ?? 0xf2f0e8),
    lift: 0.115, collider: 0, baseScale: 1.12, label: 'fishing-boat',
    category: '항구', paletteLabel: '⛵ 어선', editableParams: ['variant', 'scale', 'yaw'],
    variants: [
      { name: '흰색', color: 0xf2f0e8 },
      { name: '주황', color: 0xe98b68 },
      { name: '청색', color: 0x6b9fbd },
    ],
  },
  harborBuoy: { make: () => makeHarborBuoy(), lift: 0.11, collider: 0, label: 'harbor-buoy',
    category: '항구', paletteLabel: '🔴 부표', editableParams: ['scale', 'yaw'] },
  channelBeacon: {
    make: (o) => makeChannelBeacon(o.color ?? 0xe5b94f),
    lift: 0.105, collider: 0, label: 'channel-beacon',
    category: '항구', paletteLabel: '◇ 항로 표지', editableParams: ['variant', 'scale', 'yaw'],
    variants: [
      { name: '황색', color: 0xe5b94f },
      { name: '산호', color: 0xe87867 },
    ],
  },
  cargoFerry: {
    make: (o) => makeCargoFerry(o.color ?? 0xd98267),
    lift: 0.105, collider: 0, label: 'cargo-ferry',
    category: '항구', paletteLabel: '▰ 화물 페리', editableParams: ['variant', 'scale', 'yaw'],
    variants: [
      { name: '산호', color: 0xd98267 },
      { name: '청록', color: 0x5fa3a0 },
    ],
  },
  netRack: { make: () => makeNetRack(), lift: 0.055, collider: 0, label: 'net-rack',
    category: '항구', paletteLabel: '🕸️ 건조 그물', editableParams: ['scale', 'yaw'] },
  marketStall: { make: (o) => makeMarketStall(o.color ?? 0xe88768), lift: 0.055, collider: 0, label: 'market-stall',
    category: '항구', paletteLabel: '🏪 어시장 좌판', editableParams: ['variant', 'scale', 'yaw'],
    variants: [
      { name: '산호', color: 0xe88768 },
      { name: '하늘', color: 0x76aac4 },
      { name: '크림', color: 0xe7c875 },
    ],
  },
  fishCrate: { make: () => makeFishCrate(), lift: 0.045, collider: 0, label: 'fish-crate',
    category: '항구', paletteLabel: '🧺 어상자', editableParams: ['scale', 'yaw'] },
  cargoCluster: { make: () => makeCargoCluster(), lift: 0.045, collider: 0, label: 'cargo-cluster',
    category: '항구', paletteLabel: '📦 하역 화물', editableParams: ['scale', 'yaw'] },
  harborCrane: { make: () => makeHarborCrane(), lift: 0.055, collider: 0.08, label: 'harbor-crane',
    category: '항구', paletteLabel: '🏗️ 항구 크레인', editableParams: ['scale', 'yaw'] },
  dockBollard: { make: () => makeDockBollard(), lift: 0.055, collider: 0, label: 'dock-bollard',
    category: '항구', paletteLabel: '⚓ 계류 볼라드', editableParams: ['scale', 'yaw'] },
  ferryGate: { make: () => makeFerryGate(), lift: 0.055, collider: 0, label: 'ferry-gate',
    category: '항구', paletteLabel: '⌂ 여객 부두 게이트', editableParams: ['scale', 'yaw'] },
  tetrapod: { make: () => makeTetrapod(), lift: 0.075, collider: 0, label: 'tetrapod',
    category: '항구', paletteLabel: '🪨 테트라포드', editableParams: ['scale', 'yaw'] },
  lighthouse: { make: (o) => makeLighthouse(o.ownerKey), lift: 0.055, collider: 0.22, label: 'lighthouse',
    category: '건물', paletteLabel: '🔦 등대', editableParams: ['scale', 'yaw'] },
  camellia: { make: () => makeCamelliaTree(), lift: 0.035, collider: 0.08, label: 'camellia',
    category: '자연', paletteLabel: '🌺 동백나무', editableParams: ['scale', 'yaw'] },
  coastPine: { make: () => makeCoastPine(), lift: 0.04, collider: 0.10, label: 'coast-pine',
    category: '자연', paletteLabel: '🌲 해안 소나무', editableParams: ['scale', 'yaw'] },
  planterCluster: { make: () => makePlanterCluster(), lift: 0.035, collider: 0, label: 'planter-cluster',
    category: '자연', paletteLabel: '▦ 공용 정원', editableParams: ['scale', 'yaw'] },
  terrace: {
    make: (o) => makeVillageTerrace(o.rx ?? 1.05, o.rz ?? 0.56, o.accent ?? 0x879a8b),
    lift: 0.045, collider: 0, label: 'village-terrace', flat: true,
    category: '바닥', paletteLabel: '🧱 마을 테라스', editableParams: ['yaw'],
  },
  workPlaza: {
    make: (o) => makeWorkPlaza(o.rx ?? 0.82, o.rz ?? 0.43),
    lift: 0.055, collider: 0, label: 'work-plaza', flat: true,
    category: '바닥', paletteLabel: '◯ 공용 작업 마당', editableParams: ['yaw'],
  },
  field: {
    make: (o) => makeSurfacePatch(o.rx ?? 0.74, o.rz ?? 0.40, o.color ?? 0xaed28a, { opacity: 0.9, lift: 0.04 }),
    lift: 0.06, collider: 0, label: 'field', flat: true,
    category: '바닥', paletteLabel: '🌾 밭',
    editableParams: ['variant', 'yaw'],
    variants: [
      { name: '연두', color: 0xaed28a },
      { name: '황금', color: 0xc6d77d },
      { name: '초록', color: 0x9fcc83 },
      { name: '이삭', color: 0xb6d98e },
    ],
  },
  bridge: {
    make: (o) => makeBridge(o.len ?? 2.95, 0.96),
    lift: 0.165, collider: 0, label: 'bridge',
    // walkable span (world units) — slightly shorter than the planks so the
    // approaches still dip; refreshPropCollider turns this into bridge zones
    bridgeSpan: (d) => (d.len ?? 2.95) * 0.86,
    category: '도로변', paletteLabel: '🌉 다리',
    editableParams: ['variant', 'scale', 'yaw'],
    variants: [
      { name: '작은 다리', len: 2.95 },
      { name: '긴 다리', len: 5.4 },
    ],
  },
};
const PROP_CATEGORIES = ['관제', '건물', '항구', '자연', '도로변', '바닥'];

// ===========================================================================
// BUNDLED MODEL PROPS — CC0 .gltf assets (assets/models/…, provenance in
// ATTRIBUTION.md) become palette props with one MODEL_PROPS line each.
// Loading is async and cached per file: spawnProp returns an empty group
// immediately and the model pops in when the shared prototype resolves, so
// layouts build synchronously as before.
// ===========================================================================
const gltfLoader = new GLTFLoader();
const modelProtoCache = new Map();   // file → Promise<normalized prototype Group>

// load + normalize once per file: toon-shade every mesh (keeping the pack's
// texture atlas), stand the model on y=0, center it, and scale it so its
// fit axis ('y' height or 'max' largest dimension) equals `size` world units.
function loadModelProto(file, size, fit = 'y') {
  if (!modelProtoCache.has(file)) {
    modelProtoCache.set(file, gltfLoader.loadAsync(file).then(({ scene }) => {
      scene.traverse((o) => {
        if (!o.isMesh) return;
        const src = o.material;
        o.material = new THREE.MeshToonMaterial({
          color: src && src.color ? src.color.clone() : new THREE.Color(0xffffff),
          map: (src && src.map) || null,
          gradientMap: TOON_GRAD,
        });
        o.castShadow = true;
      });
      applyPaperObject(scene);
      const box = new THREE.Box3().setFromObject(scene);
      const dims = box.getSize(new THREE.Vector3());
      const basis = fit === 'max' ? Math.max(dims.x, dims.y, dims.z) : dims.y;
      const s = size / Math.max(basis, 1e-6);
      scene.scale.setScalar(s);
      scene.position.set(
        -((box.min.x + box.max.x) / 2) * s,
        -box.min.y * s,
        -((box.min.z + box.max.z) / 2) * s
      );
      const proto = new THREE.Group();
      proto.add(scene);
      return proto;
    }));
  }
  return modelProtoCache.get(file);
}

function makeModelProp(file, size, fit) {
  const g = new THREE.Group();
  g.userData.sharedModelResources = true;
  loadModelProto(file, size, fit)
    .then((proto) => { g.add(proto.clone(true)); })
    .catch((e) => console.warn('모델 로드 실패:', file, e));
  return g;
}

// key → palette prop. size is world units along `fit` (character = 1.3 tall).
const MODEL_PROPS = {
  well:      { file: 'assets/models/hexagon/building_well_blue.gltf',      size: 1.6,  collider: 0.13, category: '건물',  paletteLabel: '🪣 우물' },
  windmill:  { file: 'assets/models/hexagon/building_windmill_red.gltf',   size: 3.4,  collider: 0.22, category: '건물',  paletteLabel: '🌬️ 풍차' },
  watermill: { file: 'assets/models/hexagon/building_watermill_blue.gltf', size: 2.4,  collider: 0.20, category: '건물',  paletteLabel: '💧 물레방아' },
  fence:     { file: 'assets/models/hexagon/fence_wood_straight.gltf',     size: 1.25, fit: 'max', collider: 0,    category: '도로변', paletteLabel: '🪵 울타리' },
  barrel:    { file: 'assets/models/hexagon/barrel.gltf',                  size: 0.62, collider: 0,    category: '도로변', paletteLabel: '🛢️ 나무통' },
  waterlily: { file: 'assets/models/hexagon/waterlily_A.gltf',             size: 0.55, fit: 'max', lift: 0.085, collider: 0, category: '자연', paletteLabel: '🪷 수련' },
  lantern:   { file: 'assets/models/halloween/post_lantern.gltf',          size: 1.9,  collider: 0,     category: '도로변', paletteLabel: '🏮 가로등' },
  pumpkin:   { file: 'assets/models/halloween/pumpkin_orange.gltf',        size: 0.42, collider: 0.05, category: '자연',  paletteLabel: '🎃 호박' },
  bench:     { file: 'assets/models/city/bench.gltf',                      size: 1.15, fit: 'max', collider: 0,    category: '도로변', paletteLabel: '🪑 벤치' },
};
for (const [key, m] of Object.entries(MODEL_PROPS)) {
  PROP_DEFS[key] = {
    make: () => makeModelProp(m.file, m.size, m.fit),
    lift: m.lift ?? 0.03,
    collider: m.collider,
    label: key,
    category: m.category,
    paletteLabel: m.paletteLabel,
    editableParams: ['scale', 'yaw'],
  };
}

// live list of placed editable props; each item keeps its data + the mesh + collider ref
const editables = [];

// ---------------------------------------------------------------------------
// GLOBAL COORDINATES — props/paths live anywhere on the sphere as unit
// direction vectors (`dir`). Legacy layouts stored village-map (x,z); those
// are converted on load, including a yaw re-basing so every object keeps the
// EXACT facing it had in the old frame.
// ---------------------------------------------------------------------------
function normalizePropData(data) {
  const d = { yaw: 0, scale: 1, ...data };
  if (d.dir && d.dir.isVector3) {
    d.dir = d.dir.clone().normalize();
  } else if (Array.isArray(d.n) && d.n.length === 3) {
    d.dir = new THREE.Vector3(d.n[0], d.n[1], d.n[2]).normalize();
  } else {
    // legacy village coordinates — convert position AND re-base the yaw so the
    // facing (old frame: mapForward) is preserved in the local tangent frame
    const dir = mapDir(d.x ?? 0, d.z ?? 0);
    const oldFwd = mapForward(Math.sin(d.yaw || 0), Math.cos(d.yaw || 0));
    const b = tangentBasis(dir);
    d.yaw = Math.atan2(oldFwd.dot(b.east), oldFwd.dot(b.north));
    d.dir = dir;
  }
  delete d.n; delete d.x; delete d.z;
  return d;
}

// the facing vector for a prop: yaw measured against the LOCAL tangent basis
function propFacing(dir, yaw = 0) {
  const b = tangentBasis(dir);
  return b.north.clone().multiplyScalar(Math.cos(yaw))
    .add(b.east.clone().multiplyScalar(Math.sin(yaw)));
}

// place (or re-place) a prop's mesh from its data record
function applyPropTransform(item) {
  const d = item.data;
  const def = PROP_DEFS[d.type];
  placeOnSphereFacing(item.mesh, d.dir, propFacing(d.dir, d.yaw || 0), def.lift);
  item.dir = d.dir;
  if (d.type === 'cottage') conformCottageFoundation(item);
}

function conformCottageFoundation(item) {
  const root = item.mesh;
  root.updateMatrixWorld(true);
  const perimeter = [];
  const corners = [[-1.85, -1.66], [1.85, -1.66], [1.85, 1.66], [-1.85, 1.66]];
  for (let side = 0; side < 4; side++) {
    const a = corners[side], b = corners[(side + 1) % 4];
    for (let step = 0; step < 8; step++) {
      const t = step / 8;
      const top = new THREE.Vector3(THREE.MathUtils.lerp(a[0], b[0], t), 0.28,
        THREE.MathUtils.lerp(a[1], b[1], t));
      const dir = root.localToWorld(top.clone()).normalize();
      const bottom = root.worldToLocal(dir.multiplyScalar(terrainRadius(dir) + 0.045));
      // Keep the support below the foundation's top, including uphill edges.
      bottom.y = Math.min(bottom.y, top.y - 0.025);
      perimeter.push({ top, bottom });
    }
  }
  const positions = [], colors = [];
  const shades = [0xb2b9aa, 0xe9e3d2, 0xb2b9aa, 0xe9e3d2].map((c) => new THREE.Color(c));
  for (let i = 0; i < perimeter.length; i++) {
    const a = perimeter[i], b = perimeter[(i + 1) % perimeter.length];
    for (let band = 0; band < 4; band++) {
      const points = [a.bottom.clone().lerp(a.top, band / 4), b.bottom.clone().lerp(b.top, band / 4),
        a.bottom.clone().lerp(a.top, (band + 1) / 4), b.bottom.clone().lerp(b.top, (band + 1) / 4)];
      for (const index of [0, 2, 1, 1, 2, 3]) {
        positions.push(...points[index].toArray());
        colors.push(...shades[band].toArray());
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  let skirt = root.userData.foundationSkirt;
  if (!skirt) {
    const material = toonMat(0xffffff);
    material.vertexColors = true;
    material.side = THREE.DoubleSide;
    skirt = new THREE.Mesh(geometry, material);
    skirt.castShadow = skirt.receiveShadow = true;
    root.add(skirt);
    root.userData.foundationSkirt = skirt;
  } else {
    skirt.geometry.dispose();
    skirt.geometry = geometry;
  }
}

// (re)register an item's collider — and, for bridges, its walkable bridge
// zones — replacing any prior ones it owned. Every mutation path (spawn,
// move, rotate; scale/variant respawn) funnels through here.
function refreshPropCollider(item) {
  if (item.collider) {
    const idx = surfaceColliders.indexOf(item.collider);
    if (idx >= 0) surfaceColliders.splice(idx, 1);
    item.collider = null;
  }
  const def = PROP_DEFS[item.data.type];
  const r = (def.collider || 0) * (def.baseScale ?? 1) * (item.data.scale ?? 1);
  if (r > 0) {
    item.collider = { dir: item.dir.clone().normalize(), radius: r, label: def.label };
    surfaceColliders.push(item.collider);
  }
  if (item.bridgeZones && item.bridgeZones.length) {
    unregisterZones(bridgeZones, item.bridgeZones);
    item.bridgeZones = null;
  }
  if (def.bridgeSpan) {
    const half = (def.bridgeSpan(item.data) * (item.data.scale ?? 1)) / 2 / R;
    const face = propFacing(item.data.dir, item.data.yaw || 0);
    const steps = Math.max(2, Math.ceil((half * 2) / 0.05));
    item.bridgeZones = [];
    for (let i = 0; i <= steps; i++) {
      const t = -half + (i / steps) * half * 2;
      item.bridgeZones.push(registerBridgeZone(offsetSurfaceDir(item.data.dir, face, t), 0.095, 'bridge'));
    }
  }
}

// create a prop from a data record, add to scene + registry
function spawnProp(data) {
  const def = PROP_DEFS[data.type];
  if (!def) { console.warn('unknown prop type', data.type); return null; }
  const item = { data: normalizePropData(data), mesh: null, dir: null, collider: null };
  item.mesh = def.make(item.data);
  batchStaticMeshTree(item.mesh);
  applyPaperObject(item.mesh);
  // Apply user scale × the def's baseScale on top of the factory's own baked
  // scale — unless the factory already consumed them (cottages) or it's a flat
  // field patch (sized by rx/rz instead).
  const k = item.data.scale * (def.baseScale ?? 1);
  if (k !== 1 && !def.scaleInFactory && !def.flat) {
    item.mesh.scale.multiplyScalar(k);
  }
  scene.add(item.mesh);
  applyPropTransform(item);
  refreshPropCollider(item);
  editables.push(item);
  return item;
}

// remove a prop entirely (scene + registry + collider + bridge zones)
function removeProp(item) {
  const idx = editables.indexOf(item);
  if (idx >= 0) editables.splice(idx, 1);
  if (item.collider) {
    const ci = surfaceColliders.indexOf(item.collider);
    if (ci >= 0) surfaceColliders.splice(ci, 1);
  }
  if (item.bridgeZones && item.bridgeZones.length) unregisterZones(bridgeZones, item.bridgeZones);
  removeSceneObject(item.mesh);
}

// tear down every prop (used when loading a different layout)
function clearProps() {
  for (const item of editables.slice()) removeProp(item);
}

// ===========================================================================
// EDITABLE PATHS — roads & rivers. Unlike point props these are multi-point
// paths: a path record is { kind:'path', type:'road'|'river', points:[[x,z],…] }.
// They're drawn by clicking points in edit mode, and saved in the same layout.
// ===========================================================================
const PATH_DEFS = {
  road: {
    label: '도로',
    build(points, data = {}) {
      const g = new THREE.Group();
      // Keep the road close to the v11 walking scale. A narrow edge is enough
      // to separate it from grass without reading as a raised highway.
      g.add(makeCountryRoad(points, { width: 0.98, color: 0x99968f, lift: 0.121 }));
      g.add(makeCountryRoad(points, { width: 0.90, color: THEME.world.roadAsphalt, lift: 0.142 }));
      if (data.districtId === 'core' && data.id === 'core.promenade') {
        const center = centroidDir(points);
        const rim = points.map((p) => offsetSurfaceDir(p,
          p.clone().sub(center.clone().multiplyScalar(p.dot(center))).normalize(), 0.056));
        // Fill the old traffic-ring silhouette without changing its safe route.
        for (const child of g.children.slice()) disposeObject(child);
        g.clear();
        g.add(makeCapMesh(center, rim, { lift: 0.139, material: toonMat(0xc7cdbd) }));
      }
      const walkZones = registerPathZones(
        splineDirs(points, { step: 0.055 }).dirs, 0.09, 'road-walk', 0.055, registerBridgeZone
      );
      return { mesh: g, zones: [], walkZones };   // paths remain walkable over the sea cap
    },
  },
  streetEdge: {
    label: '도로 연석',
    build(points, data = {}) {
      if (data.id === 'core.plaza-edge') return { mesh: new THREE.Group(), zones: [] };
      return {
        mesh: makeStreetEdges(points, {
          radius: R,
          roadWidth: 0.90,
          splineDirs,
          makeSurfaceRibbon,
          materialFactory: toonMat,
        }),
        zones: [],
      };
    },
  },
  lane: {
    label: '마을 골목',
    build(points) {
      const g = new THREE.Group();
      g.add(makeCountryRoad(points, { width: 0.78, color: 0x9ca18e, lift: 0.139 }));
      g.add(makeCountryRoad(points, { width: 0.70, color: 0xc5c8b0, lift: 0.158 }));
      const walkZones = registerPathZones(
        splineDirs(points, { step: 0.05 }).dirs, 0.075, 'village-lane', 0.05, registerBridgeZone
      );
      return { mesh: g, zones: [], walkZones };
    },
  },
  laneEdge: {
    label: '골목 연석',
    build(points) {
      return {
        mesh: makeStreetEdges(points, {
          radius: R,
          roadWidth: 0.70,
          splineDirs,
          makeSurfaceRibbon,
          materialFactory: toonMat,
        }),
        zones: [],
      };
    },
  },
  hedge: {
    label: '생울타리',
    build(points) {
      return {
        mesh: makeHedgeLine(points, {
          radius: R,
          terrainRadius,
          splineDirs,
          materialFactory: toonMat,
        }),
        zones: [],
      };
    },
  },
  quayRail: {
    label: '부두 난간',
    build(points) {
      return {
        mesh: makeQuayRail(points, {
          radius: R,
          terrainRadius,
          splineDirs,
          materialFactory: toonMat,
        }),
        zones: [],
      };
    },
  },
  river: {
    label: '물길',
    build(points) {
      const mesh = makeRiver(points, { width: 1.35, shoreWidth: 1.82, lift: 0.076 });
      // zones follow the SAME spline the ribbon renders, so where you see
      // water is where you sink — raw click points would cut the corners
      const zones = registerPathZones(splineDirs(points, { step: 0.065 }).dirs, 0.105, 'river');
      return { mesh, zones };
    },
  },
  trail: {
    label: '흙길',
    build(points) {
      // plain country dirt road — no centerline
      const mesh = makeCountryRoad(points, { width: 1.0, color: THEME.world.dirt, lift: 0.068 });
      return { mesh, zones: [] };
    },
  },
  snow: {
    label: '눈길',
    build(points) {
      // snow-packed path: bright top over a pale-blue shoulder
      const g = new THREE.Group();
      const shoulder = makeCountryRoad(points, { width: 1.18, color: THEME.world.snowEdge, lift: 0.062 });
      const top = makeCountryRoad(points, { width: 0.92, color: THEME.world.snowTop, lift: 0.072 });
      g.add(shoulder, top);
      return { mesh: g, zones: [] };
    },
  },
  pond: {
    label: '연못',
    minPoints: 3,
    closed: true,
    build(points) {
      // closed outline → splined rim → sandy shore + water fill + poly zone
      const { dirs: rim } = splineDirs(points, { step: 0.03, forceClosed: true });
      if (rim.length < 3) return { mesh: new THREE.Group(), zones: [] };
      const center = centroidDir(rim);
      const g = new THREE.Group();
      g.add(makeCapMesh(center, rim, { lift: 0.062, grow: 0.032, material: toonMat(0xd6c79e) }));
      g.add(makeCapMesh(center, rim, { lift: 0.074, material: makePondWaterMat() }));
      const zone = registerPolyWaterZone(center, rim, 'pond');
      return { mesh: g, zones: [zone] };
    },
  },
  seaRing: {
    label: '저위도 바다 링',
    minPoints: 2,
    build() {
      const zone = registerLatitudeWaterBand(SEA_BAND_MIN_Y, SEA_BAND_MAX_Y, 'sea-ring');
      zone.band.contoured = true;
      const seaMat = makeSeaWaterMat();
      const mesh = makeLatitudeBand(SEA_BAND_MIN_Y, SEA_BAND_MAX_Y, { lift: 0.064, material: seaMat, contoured: true });
      mesh.userData.seaMaterials = [seaMat];
      return {
        mesh,
        zones: [zone],
      };
    },
  },
  island: {
    label: '항구 섬',
    minPoints: 3,
    closed: true,
    build(points) {
      const { dirs: rim } = splineDirs(points, { step: 0.03, forceClosed: true });
      if (rim.length < 3) return { mesh: new THREE.Group(), zones: [], landZones: [] };
      const center = centroidDir(rim);
      const shore = makeCapMesh(center, rim, {
        lift: 0.076, grow: 0.027, material: toonMat(THEME.world.coastSand),
      });
      const land = makeCapMesh(center, rim, {
        lift: 0.085, material: toonMat(THEME.world.islandGrass),
      });
      const paperCoast = makeSurfaceRibbon([...rim, rim[0]], {
        width: 0.075, lift: 0.091, material: toonMat(0x6c9b85),
      });
      const zone = registerPolyLandZone(center, rim, 'harbor-island');
      const g = new THREE.Group();
      g.add(shore, land, paperCoast);
      return { mesh: g, zones: [], landZones: [zone] };
    },
  },
  sea: {
    label: '바다',
    minPoints: 6,
    closed: true,
    build(points) {
      const { dirs: rim } = splineDirs(points, { step: 0.035, forceClosed: true });
      if (rim.length < 6) return { mesh: new THREE.Group(), zones: [] };
      const center = centroidDir(rim);
      const g = new THREE.Group();
      // A broad sand/stone shoulder gives the sea a readable coast without a
      // heavy water shader. The water itself is one flat toon-shaded cap.
      g.add(makeCapMesh(center, rim, {
        lift: 0.058, grow: 0.035, material: toonMat(THEME.world.coastSand),
      }));
      const seaMat = makeSeaWaterMat();
      g.add(makeCapMesh(center, rim, { lift: 0.073, material: seaMat }));
      g.userData.seaMaterials = [seaMat];
      const zone = registerPolyWaterZone(center, rim, 'sea');
      return { mesh: g, zones: [zone] };
    },
  },
  openWater: {
    label: '섬 주변 바다',
    minPoints: 6,
    closed: true,
    build(points) {
      const { dirs: rim } = splineDirs(points, { step: 0.03, forceClosed: true });
      const center = centroidDir(rim);
      const material = makeSeaWaterMat();
      const mesh = makeCapMesh(center, rim, { lift: 0.073, material });
      mesh.userData.seaMaterials = [material];
      return { mesh, zones: [registerPolyWaterZone(center, rim, 'islet-water')] };
    },
  },
  wave: {
    label: '파도 밴드',
    build(points) {
      const curve = splineDirs(points, { step: 0.025 });
      const segments = curve.closed
        ? [[...curve.dirs, curve.dirs[0].clone()]]
        : [0.30, 0.50, 0.70].map((fraction) => {
            const center = Math.floor((curve.dirs.length - 1) * fraction);
            const half = Math.max(2, Math.floor(curve.dirs.length * 0.045));
            return curve.dirs.slice(Math.max(0, center - half), Math.min(curve.dirs.length, center + half + 1));
          }).filter(segment => segment.length > 1);
      const g = new THREE.Group();
      const washMat = new THREE.MeshToonMaterial({
        color: THEME.world.seaFoam,
        gradientMap: TOON_GRAD,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      });
      const crestMat = new THREE.MeshToonMaterial({
        color: THEME.world.seaFoam,
        gradientMap: TOON_GRAD,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
      });
      for (const segment of segments) {
        g.add(makeCountryRoad(segment, { width: 0.11, lift: 0.088, material: washMat }));
        g.add(makeCountryRoad(segment, { width: 0.038, lift: 0.099, material: crestMat }));
      }
      g.userData.waveMaterials = [washMat, crestMat];
      g.userData.motionPhase = Math.abs((points[0]?.x || 0) * 11 + (points[0]?.z || 0) * 7);
      return { mesh: g, zones: [] };
    },
  },
  breakwater: {
    label: '방파제 산책로',
    build(points) {
      const g = new THREE.Group();
      // Three stepped ribbons form a continuous low-poly seawall with enough
      // height to read as a structure, while preserving the walkable top.
      g.add(makeCountryRoad(points, { width: 1.00, color: 0x8f9497, lift: 0.078 }));
      g.add(makeCountryRoad(points, { width: 0.80, color: THEME.world.breakwater, lift: 0.103 }));
      g.add(makeCountryRoad(points, { width: 0.60, color: 0xd6d1ca, lift: 0.129 }));
      const walkZones = registerPathZones(
        splineDirs(points, { step: 0.05 }).dirs, 0.065, 'breakwater-walk', 0.05, registerBridgeZone
      );
      return { mesh: g, zones: [], walkZones };
    },
  },
  market: {
    label: '어시장 골목',
    build(points) {
      const walkZones = registerPathZones(
        splineDirs(points, { step: 0.05 }).dirs, 0.06, 'market-walk', 0.05, registerBridgeZone
      );
      return {
        mesh: makeCountryRoad(points, { width: 0.72, color: THEME.world.marketPath, lift: 0.103 }),
        zones: [], walkZones,
      };
    },
  },
  deck: {
    label: '어시장 나무 데크',
    build(points) {
      const g = new THREE.Group();
      // A slim raised boardwalk reads as a deliberate harbor edge. The former
      // 1.6-wide ribbon wrapped too far down the globe and became a brown wall.
      g.add(makeCountryRoad(points, { width: 0.78, color: 0x75685f, lift: 0.079 }));
      g.add(makeCountryRoad(points, { width: 0.62, color: THEME.world.harborDeck, lift: 0.094 }));
      const deckDirs = splineDirs(points, { step: 0.045 }).dirs;
      const seamStride = Math.max(3, Math.floor(deckDirs.length / 7));
      for (let i = seamStride; i < deckDirs.length - seamStride; i += seamStride) {
        const dir = deckDirs[i];
        const previous = deckDirs[Math.max(0, i - 1)];
        const next = deckDirs[Math.min(deckDirs.length - 1, i + 1)];
        const forward = next.clone().sub(previous);
        forward.sub(dir.clone().multiplyScalar(forward.dot(dir))).normalize();
        const side = new THREE.Vector3().crossVectors(dir, forward).normalize();
        const half = 0.18 / R;
        const across = [
          offsetSurfaceDir(dir, side, -half),
          offsetSurfaceDir(dir, side, half),
        ];
        g.add(makeCountryRoad(across, { width: 0.025, color: 0x75685f, lift: 0.101 }));
      }
      const walkZones = registerPathZones(
        splineDirs(points, { step: 0.05 }).dirs, 0.10, 'harbor-deck', 0.05, registerBridgeZone
      );
      return { mesh: g, zones: [], walkZones };
    },
  },
  camellia: {
    label: '동백 오솔길',
    build(points) {
      const g = new THREE.Group();
      g.add(makeCountryRoad(points, { width: 0.92, color: THEME.world.camelliaPath, lift: 0.093 }));
      g.add(makeCountryRoad(points, { width: 0.68, color: THEME.world.dirt, lift: 0.103 }));
      const trail = splineDirs(points, { step: 0.045 }).dirs;
      const petalGeo = new THREE.IcosahedronGeometry(0.038, 0);
      const petalMats = [
        new THREE.MeshBasicMaterial({ color: 0xe7686d }),
        new THREE.MeshBasicMaterial({ color: 0xf29a8f }),
      ];
      const stride = Math.max(2, Math.floor(trail.length / 11));
      for (let i = stride; i < trail.length - stride; i += stride) {
        const dir = trail[i];
        const side = tangentBasis(dir).east;
        const petalDir = offsetSurfaceDir(dir, side, ((i / stride) % 3 - 1) * 0.022);
        const petal = new THREE.Mesh(petalGeo, petalMats[(i / stride) % 2 | 0]);
        petal.position.copy(petalDir.clone().multiplyScalar(terrainRadius(petalDir) + 0.115));
        petal.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), petalDir);
        petal.rotateY(i * 1.7);
        petal.scale.set(1.1, 0.28, 0.72);
        g.add(petal);
      }
      const walkZones = registerPathZones(
        splineDirs(points, { step: 0.05 }).dirs, 0.06, 'camellia-walk', 0.05, registerBridgeZone
      );
      return { mesh: g, zones: [], walkZones };
    },
  },
  sand: {
    label: '모래밭',
    minPoints: 3,
    closed: true,
    build(points) {
      // ground paint: a free-form sandy patch (no water)
      const { dirs: rim } = splineDirs(points, { step: 0.03, forceClosed: true });
      if (rim.length < 3) return { mesh: new THREE.Group(), zones: [] };
      const center = centroidDir(rim);
      return { mesh: makeCapMesh(center, rim, { lift: 0.05, material: toonMat(0xdccb9e) }), zones: [] };
    },
  },
  grass: {
    label: '풀밭',
    minPoints: 3,
    closed: true,
    build(points) {
      // A restrained darker rim keeps community gardens readable as actual
      // districts from the dashboard camera instead of another vague tint.
      const { dirs: rim } = splineDirs(points, { step: 0.03, forceClosed: true });
      if (rim.length < 3) return { mesh: new THREE.Group(), zones: [] };
      const center = centroidDir(rim);
      const mesh = new THREE.Group();
      mesh.add(makeCapMesh(center, rim, { lift: 0.100, grow: 0.012, material: toonMat(0x688c63) }));
      mesh.add(makeCapMesh(center, rim, { lift: 0.116, material: toonMat(0x7cae76) }));
      return { mesh, zones: [] };
    },
  },
  courtyard: {
    label: '건물 앞마당',
    minPoints: 3,
    closed: true,
    build(points) {
      const { dirs: rim } = splineDirs(points, { step: 0.03, forceClosed: true });
      if (rim.length < 3) return { mesh: new THREE.Group(), zones: [] };
      const center = centroidDir(rim);
      const mesh = new THREE.Group();
      mesh.add(makeCapMesh(center, rim, {
        lift: 0.091, grow: 0.010, material: toonMat(0x8f9a94),
      }));
      mesh.add(makeCapMesh(center, rim, {
        lift: 0.098, material: toonMat(0xc8c3ae),
      }));
      mesh.userData.districtRole = 'building-frontage';
      return { mesh, zones: [] };
    },
  },
};

const editablePaths = [];

// normalize a path record's points into world unit dirs — accepts live dirs,
// serialized n:[[x,y,z]…], or legacy village points:[[x,z]…]
function normalizePathDirs(data) {
  if (Array.isArray(data.dirs)) return data.dirs.map(v => v.clone().normalize());
  const src = Array.isArray(data.n) ? data.n : data.points;
  if (!Array.isArray(src)) return [];
  return src
    .filter(p => Array.isArray(p) && p.length >= 2)
    .map(p => p.length >= 3
      ? new THREE.Vector3(p[0], p[1], p[2]).normalize()
      : mapDir(p[0], p[1]));
}

// create a path from a data record, add to scene + path registry
function spawnPath(data) {
  const def = PATH_DEFS[data.type];
  if (!def) return null;
  const dirs = normalizePathDirs(data);
  if (dirs.length < (def.minPoints || 2)) return null;
  const { mesh, zones = [], landZones: itemLandZones = [], walkZones = [] } = def.build(dirs, data);
  applyPaperObject(mesh);
  scene.add(mesh);
  const item = {
    data: { kind: 'path', type: data.type, dirs, ...pathIdentity(data) }, mesh,
    zones, landZones: itemLandZones, walkZones, isPath: true,
  };
  editablePaths.push(item);
  return item;
}

// remove a path entirely (scene + registry + its water zones)
function removePath(item) {
  const idx = editablePaths.indexOf(item);
  if (idx >= 0) editablePaths.splice(idx, 1);
  if (item.zones && item.zones.length) unregisterZones(waterZones, item.zones);
  if (item.landZones && item.landZones.length) unregisterZones(landZones, item.landZones);
  if (item.walkZones && item.walkZones.length) unregisterZones(bridgeZones, item.walkZones);
  removeSceneObject(item.mesh);
}

function clearPaths() {
  for (const item of editablePaths.slice()) removePath(item);
}

function samePathRoute(a, b) {
  if (a.length !== b.length || a.length < 2) return false;
  return a.every((dir, i) => dir.angleTo(b[i]) < 0.00015)
    || a.every((dir, i) => dir.angleTo(b[b.length - 1 - i]) < 0.00015);
}

// Editor commands treat matching paving and curbs as one street. Low-level
// spawn/remove stay independent so saved layouts and undo restore verbatim.
function spawnEditorPath(data) {
  const item = spawnPath(data);
  const edgeType = { road: 'streetEdge', lane: 'laneEdge' }[data.type];
  if (item && edgeType && !editablePaths.some((edge) => edge.data.type === edgeType
    && samePathRoute(edge.data.dirs, item.data.dirs))) {
    spawnPath({ kind: 'path', type: edgeType, dirs: item.data.dirs });
  }
  return item;
}

function removeEditorPath(item) {
  const edgeType = { road: 'streetEdge', lane: 'laneEdge' }[item.data.type];
  const shared = editablePaths.some((other) => other !== item && other.data.type === item.data.type
    && samePathRoute(other.data.dirs, item.data.dirs));
  if (edgeType && !shared) {
    for (const edge of editablePaths.slice()) {
      if (edge.data.type === edgeType && samePathRoute(edge.data.dirs, item.data.dirs)) removePath(edge);
    }
  }
  removePath(item);
}

// serialize / restore the editable layout (props + paths in one array).
// Positions are saved as unit direction vectors `n: [x,y,z]` — valid anywhere
// on the planet. (Old x/z village layouts still load; see normalizePropData.)
const _r4 = (v) => +v.toFixed(4);
function pathIdentity(data) {
  const result = {};
  for (const key of ['id', 'districtId']) {
    if (typeof data[key] === 'string' && /^[a-z0-9_.-]{1,64}$/.test(data[key])) result[key] = data[key];
  }
  return result;
}
function serializeLayout() {
  const paths = editablePaths.map(it => ({
    kind: 'path',
    type: it.data.type,
    ...pathIdentity(it.data),
    n: it.data.dirs.map(d => [_r4(d.x), _r4(d.y), _r4(d.z)]),
  }));
  const props = editables.map(it => {
    const { dir, ...rest } = it.data;
    return { ...rest, n: [_r4(dir.x), _r4(dir.y), _r4(dir.z)] };
  });
  return [...paths, ...props];   // paths first so they render under props
}

function currentLayoutAudit() {
  const entries = editables.map((item) => {
    const def = PROP_DEFS[item.data.type] || {};
    const isHome = item.data.type === 'cottage' || item.data.type === 'lighthouse';
    const doorDir = isHome ? homeDoorDir(item) : null;
    const approachDir = isHome && doorDir
      ? nearestStreetConnection(item, doorDir)?.dir || null
      : null;
    return {
      type: item.data.type,
      ownerKey: item.data.ownerKey || '',
      n: item.data.dir?.toArray?.() || null,
      radius: (def.collider || 0) * (def.baseScale ?? 1) * (item.data.scale ?? 1),
      doorN: doorDir?.toArray() || null,
      approachN: approachDir?.toArray() || null,
    };
  });
  return auditLayout({
    entries,
    expectedOwners: AGENT_CONFIG.map((agent) => agent.key),
    requiredTypes: [
      'opsBeacon', 'wayfinder', 'harborCrane',
      'civicPavilion', 'clockKiosk', 'repairShed', 'ferryGate',
    ],
    planetRadius: R,
    spawnN: DEFAULT_PLAYER_SPAWN_DIR.toArray(),
    spawnClearance: PLAYER_CLEARANCE_RADIUS * R,
  });
}

function notifyLayoutQuality() {
  if (typeof onLayoutQualityChanged === 'function') onLayoutQualityChanged(currentLayoutAudit());
}

function buildLayout(layout) {
  clearProps();
  clearPaths();
  for (const data of layout) {
    if (data && data.kind === 'path') spawnPath(data);
    else spawnProp(data);
  }
  notifyLayoutQuality();
}

// --- layout persistence (localStorage + JSON import/export) ----------------
// Keep the old user-edited layouts intact under their former keys while the
// art-direction pass starts from a clean default. Export/import stays compatible.
const LAYOUT_KEY = 'HandulPlanet_layout_harbor_v27';
const LEGACY_LAYOUT_KEYS = Object.freeze([
  'HandulPlanet_layout_harbor_v26',
  'HandulPlanet_layout_harbor_v25',
  'HandulPlanet_layout_harbor_v24',
  'HandulPlanet_layout_harbor_v23',
  'HandulPlanet_layout_harbor_v22',
  'HandulPlanet_layout_harbor_v21',
  'HandulPlanet_layout_harbor_v20',
  'HandulPlanet_layout_harbor_v19',
]);
const LAYOUT_BACKUP_KEY = 'HandulPlanet_layout_backups_v1';
const LAYOUT_SCHEMA_VERSION = 2;
const HOME_PALETTE_MIGRATIONS = Object.freeze({
  rodi: Object.freeze({ fromWall: 0xf3ecd8, fromRoof: 0xd8af45, wall: 0xe8e9ed, roof: 0x1f2a44 }),
  jarvis: Object.freeze({ fromWall: 0xe3eaed, fromRoof: 0x71879e, wall: 0xdce3e6, roof: 0x4f6f8f }),
  yul: Object.freeze({ fromWall: 0xdcecea, fromRoof: 0x63b5b1, wall: 0xdbe7e4, roof: 0x1c4f5a }),
  ludwig: Object.freeze({ fromWall: 0xe9e4ee, fromRoof: 0x9188bd, wall: 0xe3e4e9, roof: 0x737d91 }),
  anne: Object.freeze({ fromWall: 0xf2e1df, fromRoof: 0xe38c88, wall: 0xe6eee5, roof: 0x8faf8f }),
});
const HARBOR_SPACING_MIGRATIONS = Object.freeze([
  { type: 'terrace', from: { x: -0.28, z: 0.76, yaw: -0.08, rx: 0.84, rz: 0.46 }, to: { x: 0, z: 0.98, yaw: 0, rx: 0.54, rz: 0.34 } },
  { type: 'terrace', from: { x: 0.55, z: 0.18, yaw: -0.12, rx: 0.68, rz: 0.40 }, to: { x: 0.82, z: 0.52, yaw: -0.08, rx: 0.46, rz: 0.57 } },
  { type: 'terrace', from: { x: -0.62, z: 0.24, yaw: 0.14, rx: 0.60, rz: 0.39 }, to: { x: -0.84, z: 0.52, yaw: 0.08, rx: 0.46, rz: 0.57 } },
  { type: 'cottage', ownerKey: 'rodi', from: { x: -0.08, z: 0.84, yaw: 2.96, scale: 0.72 }, to: { x: 0, z: 1.03, yaw: 3.08, scale: 0.66 } },
  { type: 'cottage', ownerKey: 'rodi', from: { x: 0, z: 0.98, yaw: 3.08, scale: 0.66 }, to: { x: 0, z: 1.03, yaw: 3.08, scale: 0.66 } },
  { type: 'cottage', ownerKey: 'jarvis', from: { x: -0.53, z: 0.62, yaw: 2.30, scale: 0.68 }, to: { x: -0.72, z: 0.84, yaw: 2.68, scale: 0.61 } },
  { type: 'cottage', ownerKey: 'yul', from: { x: 0.34, z: 0.36, yaw: -2.44, scale: 0.70 }, to: { x: 0.68, z: 0.84, yaw: -2.68, scale: 0.62 } },
  { type: 'cottage', ownerKey: 'ludwig', from: { x: -0.67, z: 0.18, yaw: 1.72, scale: 0.66 }, to: { x: -0.98, z: 0.20, yaw: 1.68, scale: 0.58 } },
  { type: 'cottage', ownerKey: 'anne', from: { x: 0.66, z: 0.04, yaw: -1.84, scale: 0.68 }, to: { x: 0.98, z: 0.20, yaw: -1.68, scale: 0.58 } },
  { type: 'netRack', from: { x: -1.02, z: -0.27, yaw: 0.16 }, to: { x: -0.58, z: -0.30, yaw: 0.08 } },
  { type: 'rock', from: { x: -1.54, z: -0.08, yaw: 0.20, scale: 1.08 }, to: { x: -1.42, z: -0.34, yaw: 0.20, scale: 1.08 } },
  { type: 'rock', from: { x: 1.55, z: -0.06, yaw: 0.40, scale: 1.04 }, to: { x: 1.42, z: -0.34, yaw: 0.40, scale: 1.04 } },
  { type: 'busStop', from: { x: 1.34, z: 0.08, yaw: -1.48, scale: 0.80 }, to: { x: 0.66, z: -0.20, yaw: -1.44, scale: 0.80 } },
  { type: 'bench', from: { x: -1.02, z: 0.06, yaw: 1.44, scale: 0.84 }, to: { x: -0.46, z: -0.08, yaw: 1.50, scale: 0.84 } },
  { type: 'utilityPole', from: { x: -1.54, z: 0.21, yaw: 3.142, scale: 0.76 }, to: { x: -1.24, z: 0.46, yaw: 3.142, scale: 0.76 } },
  { type: 'coastPine', from: { x: -1.18, z: 0.58, yaw: -0.10, scale: 0.70 }, to: { x: -1.28, z: 0.72, yaw: -0.10, scale: 0.64 } },
  { type: 'camellia', from: { x: 0.15, z: 1.15, yaw: 0.20, scale: 0.64 }, to: { x: 0.30, z: 1.18, yaw: 0.20, scale: 0.60 } },
  { type: 'camellia', from: { x: 1.18, z: 0.54, yaw: -0.30, scale: 0.66 }, to: { x: 1.28, z: 0.70, yaw: -0.30, scale: 0.60 } },
  { type: 'bench', from: { n: [0, -0.735, -0.679], yaw: 3.142, scale: 0.92 }, to: { n: [0.40, -0.75, -0.52], yaw: 3.142, scale: 0.92 } },
]);

function migrateCanonicalHomePalette(layout) {
  for (const entry of layout) {
    if (entry?.type !== 'cottage') continue;
    const palette = HOME_PALETTE_MIGRATIONS[entry.ownerKey];
    if (!palette) continue;
    // Only migrate the exact former default pair. Any user-customized color is
    // treated as intentional and remains untouched.
    if (entry.wall === palette.fromWall && entry.roof === palette.fromRoof) {
      entry.wall = palette.wall;
      entry.roof = palette.roof;
    }
  }
  return layout;
}

function canonicalMapYaw(x, z, yaw) {
  const dir = mapDir(x, z);
  const oldForward = mapForward(Math.sin(yaw || 0), Math.cos(yaw || 0));
  const basis = tangentBasis(dir);
  return Math.atan2(oldForward.dot(basis.east), oldForward.dot(basis.north));
}

function wrappedAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function migrateHarborSpacing(layout) {
  for (const entry of layout) {
    if (!entry || entry.kind === 'path') continue;
    const legacyPosition = Number.isFinite(entry.x) && Number.isFinite(entry.z);
    for (const migration of HARBOR_SPACING_MIGRATIONS) {
      if (entry.type !== migration.type) continue;
      if (migration.ownerKey && entry.ownerKey !== migration.ownerKey) continue;
      const fromUsesDirection = Array.isArray(migration.from.n);
      const toUsesDirection = Array.isArray(migration.to.n);
      const fromDirection = fromUsesDirection
        ? new THREE.Vector3(...migration.from.n).normalize()
        : mapDir(migration.from.x, migration.from.z);
      const toDirection = toUsesDirection
        ? new THREE.Vector3(...migration.to.n).normalize()
        : mapDir(migration.to.x, migration.to.z);
      let positionMatches = false;
      if (legacyPosition && !fromUsesDirection) {
        positionMatches = Math.hypot(entry.x - migration.from.x, entry.z - migration.from.z) < 0.02;
      } else if (Array.isArray(entry.n) && entry.n.length === 3) {
        const savedDir = new THREE.Vector3(entry.n[0], entry.n[1], entry.n[2]).normalize();
        positionMatches = savedDir.angleTo(fromDirection) < 0.003;
      }
      if (!positionMatches) continue;

      const oldYaw = legacyPosition
        ? migration.from.yaw
        : fromUsesDirection
          ? migration.from.yaw
          : canonicalMapYaw(migration.from.x, migration.from.z, migration.from.yaw);
      const newYaw = legacyPosition
        ? migration.to.yaw
        : toUsesDirection
          ? migration.to.yaw
          : canonicalMapYaw(migration.to.x, migration.to.z, migration.to.yaw);
      entry.yaw = wrappedAngle(newYaw + wrappedAngle((entry.yaw || 0) - oldYaw));
      if (legacyPosition) {
        entry.x = migration.to.x;
        entry.z = migration.to.z;
      } else {
        entry.n = toDirection.toArray();
      }
      for (const field of ['scale', 'rx', 'rz']) {
        if (!Number.isFinite(migration.from[field]) || !Number.isFinite(entry[field])) continue;
        if (Math.abs(entry[field] - migration.from[field]) < 0.015) entry[field] = migration.to[field];
      }
      break;
    }
  }
  return layout;
}

const DISTRICT_RELEASE_PATH_TYPES = new Set([
  'streetEdge', 'laneEdge', 'hedge', 'quayRail', 'courtyard',
]);

function pathEndpointsNear(entry, start, end, tolerance = 0.018) {
  const dirs = normalizePathDirs(entry);
  if (dirs.length < 2) return false;
  const startDir = mapDir(...start);
  const endDir = mapDir(...end);
  const direct = dirs[0].angleTo(startDir) < tolerance
    && dirs[dirs.length - 1].angleTo(endDir) < tolerance;
  const reverse = dirs[0].angleTo(endDir) < tolerance
    && dirs[dirs.length - 1].angleTo(startDir) < tolerance;
  return direct || reverse;
}

function replacePathPoints(entry, points) {
  entry.n = points.map(([x, z]) => mapDir(x, z).toArray());
  delete entry.points;
}

function migrateOpenWorldDistrict(layout) {
  // v20 was an internal grey-box build. The former storage keys are left
  // untouched, while the new key gets the final release street boundaries.
  const migrated = layout.filter((entry) => !(
    entry?.kind === 'path' && DISTRICT_RELEASE_PATH_TYPES.has(entry.type)
  ));

  for (const entry of migrated) {
    if (entry?.kind === 'path' && entry.type === 'road') {
      if (pathEndpointsNear(entry, [-0.68, 0.05], [0.66, 0.11], 0.035)) {
        replacePathPoints(entry, HARBOR_MAIN_STREET_POINTS);
      } else if (pathEndpointsNear(entry, [0, -0.45], [0, 0.46], 0.035)) {
        replacePathPoints(entry, HARBOR_HARBOR_AXIS_POINTS);
      }
    }
  }

  const marketPaths = migrated.filter((entry) => entry?.kind === 'path' && entry.type === 'market');
  if (marketPaths.length === 1) replacePathPoints(marketPaths[0], HARBOR_MARKET_POINTS);

  const canonicalShedDir = mapDir(0.78, -0.34);
  for (const entry of migrated) {
    if (entry?.kind === 'path' || entry?.type !== 'repairShed' || entry.scale > 0.86) continue;
    const entryDir = Array.isArray(entry.n)
      ? new THREE.Vector3(...entry.n).normalize()
      : mapDir(entry.x || 0, entry.z || 0);
    if (entryDir.angleTo(canonicalShedDir) < 0.005) entry.scale = 1;
  }

  const releasePaths = [
    ...HARBOR_DISTRICT_INFRASTRUCTURE,
    ...HARBOR_TERRAIN_LAYOUT.filter((entry) => entry.type === 'courtyard'),
  ];
  return sanitizeLayout([...migrated, ...releasePaths]) || migrated;
}

function migratePaperNeighborhoods(layout) {
  const direction = (entry) => Array.isArray(entry.n)
    ? new THREE.Vector3(...entry.n).normalize() : mapDir(entry.x, entry.z);
  const near = (entry, previous) => entry.type === previous.type
    && direction(entry).angleTo(direction(previous)) < 0.003;
  const moves = [
    { type: 'cottage', ownerKey: 'rodi', x: 0, z: 0.54, yaw: 3.14 },
    { type: 'cottage', ownerKey: 'jarvis', x: -0.52, z: -0.02, yaw: 1.56 },
    { type: 'cottage', ownerKey: 'yul', x: 0.52, z: 0, yaw: -1.56 },
    { type: 'cottage', ownerKey: 'ludwig', x: -0.50, z: 0.34, yaw: 1.50 },
    { type: 'cottage', ownerKey: 'anne', x: 0.48, z: 0.36, yaw: -1.48 },
    { type: 'coastPine', x: -1.34, z: 0.66, yaw: -0.10 },
    { type: 'camellia', x: 0.28, z: 1.10, yaw: 0.20 },
  ];
  const removed = [
    { type: 'greenhouse', n: HARBOR_GARDEN_ISLAND_CENTER },
    { type: 'planterCluster', x: 1.12, z: 0.42 },
    { type: 'bench', x: -0.46, z: 0.48 },
    { type: 'streetLamp', x: 0.48, z: -0.12 },
    { type: 'vendingMachine', x: -0.70, z: -0.26 },
    { type: 'netRack', x: -0.94, z: -0.32 },
    { type: 'cargoCluster', x: 0.92, z: -0.31 },
    { type: 'dockBollard', x: -0.54, z: -0.42 },
    { type: 'tetrapod', x: 0.76, z: -0.82 },
    { type: 'bench', n: [0.40, -0.75, -0.52] },
    { type: 'streetLamp', n: [-0.12, -0.69, -0.72] },
    { type: 'camellia', n: [-0.20, -0.61, -0.77] },
  ];
  const pathMoves = [
    ['road', [[-0.68, 0.05], [-0.38, 0.08], [0, 0.10], [0.36, 0.07], [0.66, 0.11]], HARBOR_MAIN_STREET_POINTS],
    ['road', [[0, -0.45], [-0.05, -0.22], [0, 0.10], [-0.07, 0.28], [0, 0.46]], HARBOR_HARBOR_AXIS_POINTS],
    ['streetEdge', [[-0.68, 0.05], [-0.38, 0.08], [0, 0.10], [0.36, 0.07], [0.66, 0.11]], HARBOR_MAIN_STREET_POINTS],
    ['streetEdge', [[0, -0.43], [-0.05, -0.22], [0, 0.10], [-0.07, 0.28], [0, 0.46]], HARBOR_HARBOR_AXIS_POINTS],
    ...['lane', 'laneEdge'].flatMap((type) => [
      [type, [[-0.30, -0.10], [-0.30, 0.10], [-0.29, 0.34]], HARBOR_WEST_LANE_POINTS],
      [type, [[0.30, -0.09], [0.30, 0.10], [0.29, 0.35]], HARBOR_EAST_LANE_POINTS],
    ]),
    ['hedge', [[-1.08, -0.02], [-0.94, 0.16], [-0.78, 0.32]], HARBOR_DISTRICT_INFRASTRUCTURE.find((e) => e.type === 'hedge').points],
    ['hedge', [[0.78, 0.32], [0.94, 0.16], [1.08, -0.02]], HARBOR_DISTRICT_INFRASTRUCTURE.filter((e) => e.type === 'hedge')[1].points],
    ['grass', [[0.72, 0.24], [1.14, 0.24], [1.16, 0.62], [0.76, 0.66]], HARBOR_TERRAIN_LAYOUT.find((e) => e.type === 'grass').points],
    ['courtyard', [[-0.94, -0.02], [-0.42, -0.08], [-0.34, 0.48], [-0.82, 0.62]], HARBOR_TERRAIN_LAYOUT.find((e) => e.type === 'courtyard').points],
    ['courtyard', [[0.42, -0.08], [0.94, -0.02], [0.82, 0.62], [0.34, 0.48]], HARBOR_TERRAIN_LAYOUT.filter((e) => e.type === 'courtyard')[1].points],
  ];
  return layout.filter((entry) => entry.kind === 'path' || !removed.some((old) => near(entry, old)))
    .map((source) => {
      const entry = { ...source };
      if (entry.kind === 'path') {
        const dirs = normalizePathDirs(entry);
        for (const [type, before, after] of pathMoves) {
          if (entry.type !== type || dirs.length !== before.length) continue;
          if (dirs.every((d, i) => d.angleTo(mapDir(...before[i])) < 0.003)) {
            replacePathPoints(entry, after);
            break;
          }
        }
        // The rear coastal path keeps its authored spherical samples.
        if (entry.type === 'lane' && dirs.length === 6
            && dirs[0].angleTo(mapDir(-0.54, 0.32)) < 0.003) {
          entry.n = dirs.map((d, i) => i === 0 ? mapDir(-0.72, 0.33).toArray() : d.toArray());
          delete entry.points;
        }
        return entry;
      }
      const old = moves.find((candidate) => near(entry, candidate)
        && (!candidate.ownerKey || entry.ownerKey === candidate.ownerKey));
      if (!old) return entry;
      const next = HARBOR_FRONT_LAYOUT.find((candidate) => candidate.type === old.type
        && (!old.ownerKey || candidate.ownerKey === old.ownerKey));
      const offset = wrappedAngle((entry.yaw || 0) - (Array.isArray(entry.n)
        ? canonicalMapYaw(old.x, old.z, old.yaw) : old.yaw));
      entry.n = mapDir(next.x, next.z).toArray();
      entry.yaw = wrappedAngle(canonicalMapYaw(next.x, next.z, next.yaw) + offset);
      delete entry.x;
      delete entry.z;
      return entry;
    });
}

// Validate & clamp an untrusted layout (imported JSON / localStorage) into
// entries that are guaranteed safe to spawn. Invalid entries are dropped, so
// buildLayout can never crash halfway and leave a half-cleared scene. Returns
// null if nothing usable remains.
function sanitizeLayout(raw) {
  if (!Array.isArray(raw)) return null;
  const num = (v, min, max, dflt) =>
    (typeof v === 'number' && isFinite(v)) ? Math.max(min, Math.min(max, v)) : dflt;
  // a valid unit-ish direction triple → normalized [x,y,z], else null
  const dirN = (n) => {
    if (!Array.isArray(n) || n.length !== 3) return null;
    if (!n.every(v => typeof v === 'number' && isFinite(v))) return null;
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 0.5 || len > 2) return null;
    return [n[0] / len, n[1] / len, n[2] / len];
  };
  const out = [];
  for (const e of raw.slice(0, 400)) {                 // hard cap on item count
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'path') {
      if (!PATH_DEFS[e.type]) continue;
      const src = Array.isArray(e.n) ? e.n : e.points;
      if (!Array.isArray(src)) continue;
      const pts = [];
      for (const p of src.slice(0, 64)) {
        if (!Array.isArray(p)) continue;
        if (p.length === 3) {                          // global dir triple
          const n = dirN(p);
          if (n) pts.push(n);
        } else if (p.length === 2 && typeof p[0] === 'number' && isFinite(p[0])
                                  && typeof p[1] === 'number' && isFinite(p[1])) {
          pts.push([num(p[0], -3.2, 3.2, 0), num(p[1], -2.4, 2.4, 0)]);   // legacy map pt
        }
      }
      if (pts.length >= (PATH_DEFS[e.type].minPoints || 2)) out.push({ kind: 'path', type: e.type, n: pts, ...pathIdentity(e) });
    } else {
      if (!PROP_DEFS[e.type]) continue;
      const d = {
        type: e.type,
        yaw: num(e.yaw, -Math.PI * 2, Math.PI * 2, 0),
        scale: num(e.scale, 0.3, 3, 1),
      };
      const n = dirN(e.n);
      if (n) {
        d.n = n;                                       // global position
      } else {
        d.x = num(e.x, -3.2, 3.2, 0);                  // legacy village position
        d.z = num(e.z, -2.4, 2.4, 0);
      }
      // cosmetic extras pass through only as finite numbers
      for (const k of ['wall', 'roof', 'color', 'accent', 'len']) {
        if (typeof e[k] === 'number' && isFinite(e[k])) d[k] = e[k];
      }
      if (typeof e.ownerKey === 'string' && /^[a-z0-9_-]{1,32}$/i.test(e.ownerKey)) {
        d.ownerKey = e.ownerKey;
      }
      if (typeof e.agentKey === 'string' && /^[a-z0-9_-]{1,32}$/i.test(e.agentKey)) {
        d.agentKey = e.agentKey;
      }
      if (d.len !== undefined) d.len = num(d.len, 0.8, 8, 2.95);
      for (const k of ['rx', 'rz']) d[k] = num(e[k], 0.1, 3, undefined);
      if (d.rx === undefined) delete d.rx;
      if (d.rz === undefined) delete d.rz;
      out.push(d);
    }
  }
  return out.length ? migrateHarborSpacing(migrateCanonicalHomePalette(out)) : null;
}

// read a saved layout from localStorage, or null if none / unreadable.
// (function declaration so it's hoisted for the boot-time buildLayout call.)
function loadSavedLayout() {
  try {
    let sourceKey = LAYOUT_KEY;
    let raw = localStorage.getItem(sourceKey);
    if (!raw) {
      sourceKey = LEGACY_LAYOUT_KEYS.find((key) => localStorage.getItem(key)) || '';
      raw = sourceKey ? localStorage.getItem(sourceKey) : null;
    }
    if (!raw) return null;
    let clean = sanitizeLayout(JSON.parse(raw));
    if (!clean) return null;
    // Layouts created before the operations view existed keep every user
    // placement; only the missing release-critical core is migrated in.
    if (!clean.some((entry) => entry?.type === 'opsBeacon')) {
      clean.push({ type: 'opsBeacon', x: 0.02, z: 0.18, yaw: 0, scale: 1 });
    }
    if (sourceKey !== LAYOUT_KEY) {
      if (sourceKey !== 'HandulPlanet_layout_harbor_v26') {
        if (!['HandulPlanet_layout_harbor_v21', 'HandulPlanet_layout_harbor_v22', 'HandulPlanet_layout_harbor_v23', 'HandulPlanet_layout_harbor_v24', 'HandulPlanet_layout_harbor_v25'].includes(sourceKey)) {
          clean = migrateOpenWorldDistrict(clean);
        }
        if (!['HandulPlanet_layout_harbor_v22', 'HandulPlanet_layout_harbor_v23', 'HandulPlanet_layout_harbor_v24', 'HandulPlanet_layout_harbor_v25'].includes(sourceKey)) clean = migratePaperNeighborhoods(clean);
        if (!['HandulPlanet_layout_harbor_v23', 'HandulPlanet_layout_harbor_v24', 'HandulPlanet_layout_harbor_v25'].includes(sourceKey)) clean = spreadWorldNeighborhoods(clean);
        clean = migrateRoadJunctions(clean);
        if (sourceKey !== 'HandulPlanet_layout_harbor_v25') clean = migrateSharedHarbor(clean);
        clean = migrateVillageBoard(clean);
      }
      clean = migrateSpatialStructure(clean);
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(clean)); } catch (_) { /* optional migration */ }
    }
    clean = migrateSavedComposition(clean, raw);
    return clean.filter((entry) => !isRetiredOceanTrail(entry));
  } catch (e) { /* corrupt -> fall back to default */ }
  return null;
}

// Edit history — one snapshot per completed edit (a drag counts once, on
// release, since saveLayout only runs on pointerup). Capped at 30 steps.
const undoStack = [];
const redoStack = [];
let lastLayoutSnap = null;   // the layout as of the last save (set at boot)

function notifyLayoutPersistence(ok, message = '') {
  if (typeof onLayoutSaveState === 'function') onLayoutSaveState(ok, message);
}

function notifyLayoutHistory() {
  if (typeof onLayoutHistoryChanged === 'function') {
    onLayoutHistoryChanged({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
  }
}

function storeLayoutSnapshot(snap) {
  try {
    localStorage.setItem(LAYOUT_KEY, snap);
    notifyLayoutPersistence(true, '이 브라우저에 저장됨');
    return true;
  } catch (error) {
    console.warn('레이아웃 저장 실패:', error);
    notifyLayoutPersistence(false, '저장 실패 · JSON으로 백업해주세요');
    return false;
  }
}

// write the current layout to localStorage (auto-save on every edit),
// pushing the PREVIOUS state onto the undo stack.
function saveLayout({ recordHistory = true, clearRedo = true } = {}) {
  let snap;
  try {
    snap = JSON.stringify(serializeLayout());
  } catch (error) {
    notifyLayoutPersistence(false, '저장 실패 · 배치를 직렬화할 수 없습니다');
    return false;
  }
  const changed = lastLayoutSnap !== null && snap !== lastLayoutSnap;
  if (recordHistory && changed) {
    undoStack.push(lastLayoutSnap);
    if (undoStack.length > 30) undoStack.shift();
    if (clearRedo) redoStack.length = 0;
  }
  lastLayoutSnap = snap;
  const stored = storeLayoutSnapshot(snap);
  if (stored && changed) ambientAudio.playEffect('confirm');
  notifyLayoutHistory();
  notifyLayoutQuality();
  return stored;
}

function restoreLayoutSnapshot(snapshot) {
  selectItem(null);
  cancelDrawing();
  buildLayout(JSON.parse(snapshot));
  rebuildDriveways();
  lastLayoutSnap = snapshot;
  storeLayoutSnapshot(snapshot);
  notifyLayoutHistory();
}

// Ctrl+Z: restore the previous snapshot, preserving the current one for redo.
function undoLayout() {
  if (!undoStack.length) return false;
  const current = lastLayoutSnap || JSON.stringify(serializeLayout());
  const prev = undoStack.pop();
  redoStack.push(current);
  if (redoStack.length > 30) redoStack.shift();
  restoreLayoutSnapshot(prev);
  return true;
}

function redoLayout() {
  if (!redoStack.length) return false;
  const current = lastLayoutSnap || JSON.stringify(serializeLayout());
  const next = redoStack.pop();
  undoStack.push(current);
  if (undoStack.length > 30) undoStack.shift();
  restoreLayoutSnapshot(next);
  return true;
}

function backupCurrentLayout(reason = 'manual') {
  try {
    const backups = JSON.parse(localStorage.getItem(LAYOUT_BACKUP_KEY) || '[]');
    const next = Array.isArray(backups) ? backups.slice(-4) : [];
    next.push({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      reason,
      layout: serializeLayout(),
    });
    localStorage.setItem(LAYOUT_BACKUP_KEY, JSON.stringify(next));
    return true;
  } catch (error) {
    console.warn('레이아웃 안전 백업 실패:', error);
    notifyLayoutPersistence(false, '안전 백업 실패 · 먼저 내보내기를 권장합니다');
    return false;
  }
}

function restoreLatestLayoutBackup() {
  try {
    const backups = JSON.parse(localStorage.getItem(LAYOUT_BACKUP_KEY) || '[]');
    const latest = Array.isArray(backups) ? backups[backups.length - 1] : null;
    const clean = sanitizeLayout(latest?.layout);
    if (!clean) return false;
    backupCurrentLayout('before-backup-restore');
    buildLayout(clean);
    rebuildDriveways();
    saveLayout();
    selectItem(null);
    return true;
  } catch (error) {
    console.warn('레이아웃 백업 복구 실패:', error);
    notifyLayoutPersistence(false, '백업 복구 실패');
    return false;
  }
}

// reset to the built-in default layout (and persist it).
function resetLayout() {
  backupCurrentLayout('before-reset');
  buildLayout(DEFAULT_LAYOUT);
  rebuildDriveways();
  saveLayout();
}

// download the current layout as a JSON file the user can keep / share.
function exportLayout() {
  const payload = {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'Handul Mini Planet',
    layout: serializeLayout(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mini-planet-layout-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// load a layout from a user-picked JSON file, rebuild the scene, and persist it.
// The file is sanitized BEFORE the old layout is torn down, so a bad file
// reports an error and leaves the current village untouched.
function importLayoutFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const rawLayout = Array.isArray(parsed) ? parsed : parsed?.layout;
      const clean = sanitizeLayout(rawLayout);
      if (!clean) throw new Error('사용할 수 있는 오브젝트가 없습니다');
      backupCurrentLayout('before-import');
      buildLayout(clean);
      rebuildDriveways();
      saveLayout();
      if (typeof onLayoutImported === 'function') onLayoutImported(true);
    } catch (e) {
      if (typeof onLayoutImported === 'function') onLayoutImported(false, e.message);
    }
  };
  reader.readAsText(file);
}

// (Everything that used to be fixed terrain here — the big lake, the two
// bridges, the forest pond/trail/floor — now lives in DEFAULT_LAYOUT as
// editable ponds, bridge props, trail and grass paint, so the whole planet
// can be rearranged in edit mode. Only the pole rose below stays put.)

// ---------------------------------------------------------------------------
// 북극점의 장미 — 어린왕자 오마주. The planet's fixed reference point: the rose
// grows at true north, directly beneath Polaris. A monument, not an editable
// prop — it never moves.
// ---------------------------------------------------------------------------
const NORTH_POLE = new THREE.Vector3(0, 1, 0);
const poleRose = (() => {
  const g = new THREE.Group();
  g.name = 'B-612 Rose';

  // A pale plinth and gold rim make the tiny landmark readable against either
  // grass or sea when it reaches the planet's silhouette.
  const base = makePaperTierRoof(toonMat, { radius: 0.78, height: 0.15,
    color: THEME.world.snowTop, tiers: 3, sides: 20 });
  base.receiveShadow = false;
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.64, 0.025, 6, 24),
    new THREE.MeshBasicMaterial({ color: THEME.world.roseGold }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.155;
  g.add(base, rim);

  const flower = makePaperRose(toonMat, { petal: THEME.world.rosePetal,
    core: THEME.world.roseCore, leaf: THEME.world.roseLeaf, stem: THEME.world.roseStem });
  const head = flower.userData.roseHead;
  g.add(flower);

  // The Little Prince's glass globe: deliberately light and graphic, not a
  // realistic refractive shader. It catches the sky without muddying the rose.
  const glass = new THREE.Mesh(
    new THREE.SphereGeometry(0.84, 20, 14),
    new THREE.MeshBasicMaterial({
      color: THEME.world.roseGlass,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  glass.scale.y = 1.15;
  glass.position.y = 0.96;
  glass.renderOrder = 4;
  g.add(glass);

  const glow = new THREE.PointLight(THEME.world.rosePetal, 0.42, 3.8, 2);
  glow.position.y = 1.70;
  g.add(glow);
  g.userData.roseHead = head;
  g.userData.glow = glow;
  placeOnSphere(g, NORTH_POLE, 0);
  scene.add(g);
  registerSurfaceCollider(NORTH_POLE, 0.08, 'pole-rose');
  return g;
})();
// (main / village / lake roads are editable paths in DEFAULT_LAYOUT below.)

// ---------------------------------------------------------------------------
// HARBOR VILLAGE LAYOUT — staged, data-first composition matching the approved
// full-sphere moodboard. These arrays are the single built-in layout source;
// user edits continue to live separately in localStorage / exported JSON.
// ---------------------------------------------------------------------------
function sphericalRing(centerValues, radius, segments = 20, phase = 0) {
  const center = new THREE.Vector3(...centerValues).normalize();
  const b = tangentBasis(center);
  const out = [];
  for (let i = 0; i < segments; i++) {
    const a = phase + (i / segments) * Math.PI * 2;
    const tangent = b.east.clone().multiplyScalar(Math.cos(a))
      .add(b.north.clone().multiplyScalar(Math.sin(a)));
    const d = center.clone().multiplyScalar(Math.cos(radius))
      .add(tangent.multiplyScalar(Math.sin(radius))).normalize();
    out.push(d.toArray());
  }
  out.push(out[0].slice());
  return out;
}

function sphericalArc(centerValues, radius, from, to, segments = 8) {
  const center = new THREE.Vector3(...centerValues).normalize();
  const b = tangentBasis(center);
  return Array.from({ length: segments }, (_, i) => {
    const a = from + (to - from) * (i / (segments - 1));
    const tangent = b.east.clone().multiplyScalar(Math.cos(a))
      .add(b.north.clone().multiplyScalar(Math.sin(a)));
    return center.clone().multiplyScalar(Math.cos(radius))
      .add(tangent.multiplyScalar(Math.sin(radius))).normalize().toArray();
  });
}

const HARBOR_SEA_CENTER = [0, -0.42, 0.91];
const HARBOR_FRONT_ISLAND_POINTS = [
  [-1.48, 0.72], [-1.52, 0.28], [-1.34, -0.08], [-0.98, -0.31],
  [-0.48, -0.42], [0, -0.45], [0.48, -0.42], [0.98, -0.31],
  [1.34, -0.08], [1.52, 0.28], [1.48, 0.72], [1.02, 1.02],
  [0, 1.18], [-1.02, 1.02], [-1.48, 0.72],
];
// Two overlapping land masks pull the inhabited hemisphere down around the
// harbor without asking the cap triangulator to fill one deeply concave U.
// Their inner seams sit below roads, terraces and working-harbor dressing.
const HARBOR_WEST_PENINSULA_POINTS = [
  [-1.40, 0.48], [-1.66, 0.18], [-1.68, -0.24], [-1.48, -0.56],
  [-1.10, -0.72], [-0.72, -0.60], [-0.58, -0.40], [-0.88, -0.24],
  [-1.24, -0.02], [-1.40, 0.48],
];
const HARBOR_EAST_PENINSULA_POINTS = [
  [1.32, 0.50], [1.62, 0.25], [1.70, -0.16], [1.52, -0.52],
  [1.16, -0.72], [0.78, -0.62], [0.60, -0.42], [0.88, -0.24],
  [1.24, -0.02], [1.32, 0.50],
];
const HARBOR_GARDEN_ISLAND_CENTER = mapDir(1.70, 0.72).toArray();
const HARBOR_GARDEN_ISLAND_POINTS = sphericalRing(HARBOR_GARDEN_ISLAND_CENTER, 0.095, 16, Math.PI / 16);
const HARBOR_REAR_LIGHTHOUSE_DIR = new THREE.Vector3(0, -0.505, -0.863).normalize();
const HARBOR_REAR_LIGHTHOUSE_APPROACH = offsetSurfaceDir(
  HARBOR_REAR_LIGHTHOUSE_DIR,
  propFacing(HARBOR_REAR_LIGHTHOUSE_DIR, Math.PI),
  0.28,
).toArray();
const HARBOR_MAIN_STREET_POINTS = [
  [-0.86, 0.08], [-0.38, 0.08], [0, 0.10], [0.36, 0.07], [0.74, 0.10],
];
const HARBOR_HARBOR_AXIS_POINTS = [
  [0, -0.45], [-0.05, -0.22], [0, 0.10], [-0.07, 0.42], [-0.08, 0.80],
];
const HARBOR_MARKET_POINTS = [
  [-0.92, -0.28], [-0.48, -0.30], [0, -0.31], [0.48, -0.30], [0.92, -0.28],
];
const HARBOR_WEST_LANE_POINTS = [[-0.70, 0.08], [-0.72, 0.33], [-0.88, 0.64]];
const HARBOR_EAST_LANE_POINTS = [[0.65, 0.10], [0.85, 0.34], [1.04, 0.64]];
const HARBOR_TERRAIN_LAYOUT = [
  // A continuous low-latitude ocean band makes the land read as an island
  // from every orbit angle. Polygon land masks carve out the village and cape.
  { kind: 'path', type: 'seaRing', n: [[0, 1, 0], [0, 0, 1]] },
  { kind: 'path', type: 'island', points: HARBOR_FRONT_ISLAND_POINTS },
  { kind: 'path', type: 'island', points: HARBOR_WEST_PENINSULA_POINTS },
  { kind: 'path', type: 'island', points: HARBOR_EAST_PENINSULA_POINTS },
  { kind: 'path', type: 'island', n: HARBOR_GARDEN_ISLAND_POINTS },
  { kind: 'path', type: 'island', n: sphericalRing([0, -0.578, -0.816], 0.46, 20, Math.PI / 20) },
  // Pale foam traces the actual island shoreline; inner bands keep the flat,
  // graphic water treatment from the moodboard.
  { kind: 'path', type: 'wave', points: HARBOR_FRONT_ISLAND_POINTS },
  { kind: 'path', type: 'wave', points: [
    [-1.48, 0.36], [-1.66, 0.06], [-1.63, -0.34], [-1.38, -0.62], [-1.03, -0.72], [-0.72, -0.58],
  ] },
  { kind: 'path', type: 'wave', points: [
    [1.40, 0.40], [1.66, 0.12], [1.64, -0.30], [1.43, -0.60], [1.12, -0.72], [0.78, -0.60],
  ] },
  { kind: 'path', type: 'wave', n: HARBOR_GARDEN_ISLAND_POINTS },
  // One shared garden gives the east work street a public destination. It is
  // deliberately attached to the street instead of floating in spare lawn.
  { kind: 'path', type: 'grass', points: [
    [1.05, 0.64], [1.50, 0.60], [1.48, 0.94], [1.08, 1.00],
  ] },
  { kind: 'path', type: 'courtyard', points: [
    [-1.28, -0.12], [-0.82, -0.16], [-0.66, 0.22], [-1.16, 0.28],
  ] },
  { kind: 'path', type: 'courtyard', points: [
    [0.68, -0.18], [1.15, -0.18], [1.22, 0.22], [0.74, 0.28],
  ] },
  // A short cross street and a harbor axis form the readable town structure.
  // Two narrower work lanes hold real building frontages; home approaches are
  // generated from each door to the nearest street below.
  { kind: 'path', type: 'road', points: HARBOR_MAIN_STREET_POINTS },
  { kind: 'path', type: 'road', points: HARBOR_HARBOR_AXIS_POINTS },
  { kind: 'path', type: 'lane', points: HARBOR_WEST_LANE_POINTS },
  { kind: 'path', type: 'lane', points: HARBOR_EAST_LANE_POINTS },
  // A single coastal service lane gives the rear lighthouse a land route. It
  // ends at the destination instead of circling the whole globe as decoration.
  { kind: 'path', type: 'lane', n: [
    mapDir(-0.72, 0.33).toArray(), [-0.966, 0.150, 0.211], [-1, 0, 0],
    [-0.866, -0.289, -0.408], [-0.5, -0.501, -0.707], HARBOR_REAR_LIGHTHOUSE_APPROACH,
  ] },
  { kind: 'path', type: 'deck', points: [[-1.28, -0.38], [-0.72, -0.42], [0, -0.44], [0.74, -0.42], [1.30, -0.37]] },
  { kind: 'path', type: 'deck', points: [[-0.28, -0.41], [-0.30, -0.68]] },
  { kind: 'path', type: 'deck', points: [[0.62, -0.40], [0.65, -0.61]] },
  { kind: 'path', type: 'deck', points: [[1.38, 0.62], [1.52, 0.67], [1.66, 0.71]] },
  { kind: 'path', type: 'market', points: HARBOR_MARKET_POINTS },
  // Two embracing arms leave a clear harbor mouth instead of closing the bay.
  { kind: 'path', type: 'breakwater', points: [[-1.38, -0.39], [-1.50, -0.57], [-1.39, -0.75], [-1.10, -0.88], [-0.72, -0.94]] },
  { kind: 'path', type: 'breakwater', points: [[1.40, -0.38], [1.53, -0.55], [1.42, -0.74], [1.12, -0.88], [0.76, -0.94]] },
  { kind: 'path', type: 'camellia', n: [
    mapDir(1.45, 0.28).toArray(), [0.9659, 0.1496, 0.2112], [0.8660, -0.2890, -0.4080],
    [0.5, -0.5006, -0.7067], [0, -0.578, -0.816],
  ] },
];

// Repeated boundaries are infrastructure, not decorative clutter. They turn
// the road ribbons into one readable street while leaving doors and the boat
// gate open. All pieces remain editable paths and migrate with v19/v20 layouts.
const HARBOR_DISTRICT_INFRASTRUCTURE = [
  { kind: 'path', type: 'streetEdge', points: HARBOR_MAIN_STREET_POINTS },
  { kind: 'path', type: 'streetEdge', points: HARBOR_HARBOR_AXIS_POINTS },
  { kind: 'path', type: 'laneEdge', points: HARBOR_WEST_LANE_POINTS },
  { kind: 'path', type: 'laneEdge', points: HARBOR_EAST_LANE_POINTS },
  { kind: 'path', type: 'hedge', points: [[-1.22, 0.35], [-1.06, 0.39], [-0.90, 0.42]] },
  { kind: 'path', type: 'hedge', points: [[1.12, 0.36], [1.28, 0.39], [1.40, 0.45]] },
  { kind: 'path', type: 'quayRail', points: [[-1.20, -0.44], [-0.88, -0.45], [-0.52, -0.45]] },
  { kind: 'path', type: 'quayRail', points: [[0.18, -0.45], [0.66, -0.45], [1.20, -0.43]] },
];

const HARBOR_FRONT_LAYOUT = [
  // Homes occupy the west coast, upper ridge and east garden. Shared services
  // remain at the harbor; short lanes connect each neighborhood to the core.
  { type: 'workPlaza', x: 0.00, z: 0.10, yaw: 0, rx: 0.46, rz: 0.30 },
  { type: 'opsBeacon', x: 0.00, z: 0.10, yaw: 0, scale: 0.68 },
  { type: 'cottage', ownerKey: 'rodi',   x: -0.10, z: 1.02, yaw: 3.14, scale: 0.64, wall: 0xe8e9ed, roof: 0x1f2a44 },
  { type: 'cottage', ownerKey: 'jarvis', x: -1.08, z: 0.04, yaw: 1.40, scale: 0.62, wall: 0xdce3e6, roof: 0x4f6f8f },
  { type: 'cottage', ownerKey: 'yul',    x: 0.96, z: -0.02, yaw: -1.20, scale: 0.62, wall: 0xdbe7e4, roof: 0x1c4f5a },
  { type: 'cottage', ownerKey: 'ludwig', x: -1.15, z: 0.82, yaw: 1.90, scale: 0.62, wall: 0xe3e4e9, roof: 0x737d91 },
  { type: 'cottage', ownerKey: 'anne',   x: 1.30, z: 0.80, yaw: -2.00, scale: 0.62, wall: 0xe6eee5, roof: 0x8faf8f },

  // Shared landmarks give each district a public purpose beyond its home.
  // They stay visually substantial while most street furniture remains
  // collider-free, preserving wide walk corridors.
  { type: 'civicPavilion', x: 0.38, z: -0.16, yaw: -0.18, scale: 0.62 },
  { type: 'resultBoard', x: -0.25, z: 0.26, yaw: 0.16, scale: 0.72 },
  { type: 'clockKiosk', x: -0.50, z: -0.28, yaw: 0.08, scale: 0.80 },
  { type: 'repairShed', x: 0.78, z: -0.34, yaw: -0.12, scale: 1.00 },
  { type: 'ferryGate', x: 0.34, z: -0.43, yaw: -0.04, scale: 0.82 },

  // One orientation marker, one waiting bench and a pair of lamps are enough
  // to explain the civic core without repeating miniature street furniture.
  { type: 'wayfinder', x: -0.30, z: -0.04, yaw: -0.22, scale: 0.62 },
  { type: 'streetLamp', x: -0.48, z: -0.12, yaw: 0, scale: 0.84 },

  // The south edge is a working harbor, not a strip of unrelated samples.
  // Cargo, mooring and lifting props cluster around the two market stalls.
  { type: 'fishingBoat', x: -0.28, z: -0.92, yaw: 0.18, scale: 1.30, color: 0x6f9eb2 },
  { type: 'harborBuoy', x: -0.72, z: -0.72, yaw: 0, scale: 0.90 },
  { type: 'channelBeacon', x: 0.56, z: -1.14, yaw: 0, scale: 0.96, color: 0xe5b94f },
  { type: 'cargoFerry', x: 1.34, z: -1.16, yaw: -0.42, scale: 0.82, color: 0xd98267 },
  { type: 'marketStall', x: -0.26, z: -0.34, yaw: -0.02, scale: 0.94, color: 0x6f9eb2 },
  { type: 'harborCrane', x: 1.40, z: -0.52, yaw: -0.78, scale: 0.74 },

  // Two different silhouettes frame the village without repeating greenery.
  { type: 'coastPine', x: -1.50, z: 0.40, yaw: -0.10, scale: 0.68 },
  { type: 'camellia', x: 0.45, z: 1.02, yaw: 0.20, scale: 0.56 },
];

const HARBOR_REAR_LAYOUT = [
  // Argos inherits the old far-side-home contract, but his home is now the
  // violet-and-white lighthouse and participates in the same service interaction.
  { type: 'lighthouse', ownerKey: 'argos', n: HARBOR_REAR_LIGHTHOUSE_DIR.toArray(), yaw: 3.142, scale: 0.86 },
  { type: 'rock', n: [-0.25, -0.62, -0.74], yaw: 0.4, scale: 1.35 },
];

const WORLD_HOME_SITES = Object.freeze({
  rodi: Object.freeze({ n: [0, 0.96, 0.28], yaw: Math.PI, district: 'front-ridge' }),
  jarvis: Object.freeze({ n: [-0.90, 0.42, 0.12], yaw: 0, district: 'west-coast' }),
  yul: Object.freeze({ n: [0.90, 0.42, 0.12], yaw: 0, district: 'east-coast' }),
  ludwig: Object.freeze({ n: [-0.45, 0.60, -0.66], yaw: 0, district: 'rear-west-highland' }),
  anne: Object.freeze({ n: [0.65, 0.43, -0.63], yaw: 0, district: 'rear-east-garden' }),
});

function isRetiredOceanTrail(entry) {
  if (entry.kind !== 'path' || entry.type !== 'camellia') return false;
  const original = HARBOR_TERRAIN_LAYOUT.find((path) => path.type === 'camellia');
  const expected = normalizePathDirs(original);
  const actual = normalizePathDirs(entry);
  return actual.length === expected.length && actual.every((dir, i) => dir.angleTo(expected[i]) < 0.003);
}

function spreadWorldNeighborhoods(layout) {
  const unit = (n) => new THREE.Vector3(...n).normalize();
  const work = (key) => unit(AGENT_DISTRICT_ANCHORS[key]);
  const sideOf = (key, distance) => {
    const dir = unit(WORLD_HOME_SITES[key].n);
    return offsetSurfaceDir(dir, tangentBasis(dir).east, distance).toArray();
  };
  const west = [mapDir(-0.86, 0.08).toArray(), mapDir(-1.1, 0.45).toArray(), work('jarvis').toArray()];
  const east = [mapDir(0.74, 0.10).toArray(), mapDir(1.1, 0.45).toArray(), work('yul').toArray()];
  const highland = [work('jarvis').toArray(), [-0.65, 0.73, -0.20], work('ludwig').toArray(),
    [0.05, 0.80, -0.60], work('anne').toArray(), [0.72, 0.64, -0.27], work('yul').toArray()];
  const replacements = [
    ...['lane', 'laneEdge'].flatMap((type) => [
      { type, before: HARBOR_WEST_LANE_POINTS, after: west },
      { type, before: HARBOR_EAST_LANE_POINTS, after: east },
    ]),
    ...HARBOR_TERRAIN_LAYOUT.filter((p) => ['grass', 'courtyard'].includes(p.type)).map((p, i) => ({
      type: p.type, before: p.points,
      after: sphericalRing(WORLD_HOME_SITES[['anne', 'jarvis', 'yul'][i]].n, p.type === 'grass' ? 0.23 : 0.20, 16),
    })),
    ...HARBOR_DISTRICT_INFRASTRUCTURE.filter((p) => p.type === 'hedge').map((p, i) => ({
      type: p.type, before: p.points,
      after: sphericalArc(WORLD_HOME_SITES[i === 0 ? 'ludwig' : 'anne'].n, 0.27, Math.PI * 0.9, Math.PI * 1.5, 7),
    })),
  ];
  const movedProps = {
    civicPavilion: { n: sideOf('ludwig', 0.38), yaw: -0.3 },
    clockKiosk: { n: sideOf('jarvis', 0.34), yaw: 0 },
    repairShed: { n: sideOf('yul', -0.38), yaw: 0.2 },
    streetLamp: { n: sideOf('jarvis', -0.29), yaw: 0 },
    camellia: { n: sideOf('anne', 0.34), yaw: 0.2 },
    coastPine: { n: sideOf('ludwig', -0.33), yaw: -0.1 },
  };
  function entryDirection(entry) {
    return Array.isArray(entry.n) ? new THREE.Vector3(...entry.n).normalize() : mapDir(entry.x, entry.z);
  }
  const result = layout.filter((source) => !isRetiredOceanTrail(source)
    && !(source.type === 'coastPine' && Array.isArray(source.n)
    && entryDirection(source).angleTo(unit([0.31, -0.38, -0.87])) < 0.003)).map((source) => {
    const entry = { ...source };
    if (entry.kind === 'path') {
      const dirs = normalizePathDirs(entry);
      const replacement = replacements.find((p) => p.type === entry.type && p.before.length === dirs.length
        && dirs.every((dir, i) => dir.angleTo(mapDir(...p.before[i])) < 0.003));
      if (replacement) {
        entry.n = replacement.after.map((n) => unit(n).toArray());
        delete entry.points;
      }
      // The remote lighthouse has a local approach. Ocean travel between
      // districts uses boats instead of an invisible bridge across the sea.
      if (entry.type === 'lane' && dirs.length === 6
          && dirs[0].angleTo(mapDir(-0.72, 0.33)) < 0.003) {
        entry.n = [HARBOR_REAR_LIGHTHOUSE_APPROACH,
          offsetSurfaceDir(HARBOR_REAR_LIGHTHOUSE_DIR,
            propFacing(HARBOR_REAR_LIGHTHOUSE_DIR, Math.PI), 0.40).toArray()];
        delete entry.points;
      }
      return entry;
    }
    const site = WORLD_HOME_SITES[entry.ownerKey];
    if (entry.type === 'cottage' && site) {
      entry.n = unit(site.n).toArray();
      entry.yaw = site.yaw;
      delete entry.x;
      delete entry.z;
      return entry;
    }
    const moved = movedProps[entry.type];
    const original = HARBOR_FRONT_LAYOUT.find((p) => p.type === entry.type);
    if (moved && original && entryDirection(entry).angleTo(entryDirection(original)) < 0.003) {
      entry.n = unit(moved.n).toArray();
      entry.yaw = moved.yaw;
      delete entry.x;
      delete entry.z;
    }
    return entry;
  });
  const exists = result.some((p) => p.kind === 'path' && p.type === 'lane'
    && normalizePathDirs(p).length === highland.length
    && normalizePathDirs(p).every((d, i) => d.angleTo(unit(highland[i])) < 0.003));
  if (!exists) result.push({ kind: 'path', type: 'lane', n: highland.map((n) => unit(n).toArray()) });
  return result;
}

function migrateRoadJunctions(layout) {
  const center = mapDir(0, 0.10);
  const direction = (entry) => entry.n ? new THREE.Vector3(...entry.n).normalize() : mapDir(entry.x, entry.z);
  const core = layout.find((entry) => entry.type === 'opsBeacon');
  const rodi = layout.find((entry) => entry.ownerKey === 'rodi' && entry.type === 'cottage');
  if (!core || !rodi || direction(core).angleTo(center) > 0.003
      || Math.abs((core.scale ?? 1) - 0.68) > 0.001
      || direction(rodi).angleTo(new THREE.Vector3(...WORLD_HOME_SITES.rodi.n).normalize()) > 0.003) return layout;
  const matches = (entry, points) => {
    const dirs = normalizePathDirs(entry);
    return entry.kind === 'path' && dirs.length === points.length
      && dirs.every((dir, i) => dir.angleTo(mapDir(...points[i])) < 0.003);
  };
  if (!layout.some((p) => p.type === 'road' && matches(p, HARBOR_MAIN_STREET_POINTS))
      || !layout.some((p) => p.type === 'road' && matches(p, HARBOR_HARBOR_AXIS_POINTS))) return layout;
  const rimToward = (target) => {
    const tangent = target.clone().sub(center.clone().multiplyScalar(target.dot(center))).normalize();
    return offsetSurfaceDir(center, tangent, 0.205).toArray();
  };
  const main = HARBOR_MAIN_STREET_POINTS.map((p) => mapDir(...p));
  const axis = HARBOR_HARBOR_AXIS_POINTS.map((p) => mapDir(...p));
  const house = direction(rodi);
  const forecourt = offsetSurfaceDir(house, propFacing(house, rodi.yaw ?? Math.PI),
    0.27 * 0.92 * (rodi.scale ?? 1) + 0.026 + 0.06).toArray();
  const replacements = [
    [HARBOR_MAIN_STREET_POINTS, [
      [main[0].toArray(), main[1].toArray(), rimToward(main[1])],
      [rimToward(main[3]), main[3].toArray(), main[4].toArray()],
    ]],
    [HARBOR_HARBOR_AXIS_POINTS, [
      [mapDir(0, -0.40).toArray(), axis[1].toArray(), rimToward(axis[1])],
      [rimToward(new THREE.Vector3(...forecourt)), forecourt],
    ]],
  ];
  const result = layout.flatMap((entry) => {
    if (!['road', 'streetEdge'].includes(entry.type)) return [entry];
    const replacement = replacements.find(([before]) => matches(entry, before));
    if (!replacement) return [entry];
    return replacement[1].map((n) => ({ kind: 'path', type: entry.type, n }));
  });
  const ring = sphericalRing(center.toArray(), 0.205, 40);
  result.push({ kind: 'path', type: 'road', n: ring }, { kind: 'path', type: 'streetEdge', n: ring });
  return result;
}

function lighthouseIsletOutline(grow = 0) {
  const center = offsetSurfaceDir(HARBOR_REAR_LIGHTHOUSE_DIR,
    propFacing(HARBOR_REAR_LIGHTHOUSE_DIR, Math.PI), 0.12);
  const basis = tangentBasis(center);
  const points = Array.from({ length: 28 }, (_, i) => {
    const angle = i / 28 * Math.PI * 2;
    const ripple = 1 + Math.sin(angle * 3 + 0.4) * 0.055;
    return center.clone().add(basis.east.clone().multiplyScalar(Math.cos(angle) * (0.35 + grow) * ripple))
      .add(basis.north.clone().multiplyScalar(Math.sin(angle) * (0.42 + grow) * ripple)).normalize().toArray();
  });
  return [...points, points[0].slice()];
}

function migrateSharedHarbor(layout) {
  const direction = (p) => p.n ? new THREE.Vector3(...p.n).normalize() : mapDir(p.x, p.z);
  const matches = (p, expected) => {
    const actual = normalizePathDirs(p);
    return actual.length === expected.length && actual.every((d, i) => d.angleTo(new THREE.Vector3(...expected[i]).normalize()) < 0.003);
  };
  const result = layout.map((p) => ({ ...p }));
  const home = result.find((p) => p.ownerKey === 'argos' && p.type === 'lighthouse');
  const oldIsland = sphericalRing([0, -0.578, -0.816], 0.46, 20, Math.PI / 20);
  const island = result.find((p) => p.type === 'island' && matches(p, oldIsland));
  // Only reshape the original cape. A moved home or hand-edited coast is kept.
  const isletCenter = offsetSurfaceDir(HARBOR_REAR_LIGHTHOUSE_DIR,
    propFacing(HARBOR_REAR_LIGHTHOUSE_DIR, Math.PI), 0.12);
  const marineTypes = new Set(['fishingBoat', 'cargoFerry', 'harborBuoy', 'channelBeacon']);
  const protectedShoreProps = result.some((p) => {
    if (p.kind === 'path' || p === home || marineTypes.has(p.type)) return false;
    const dir = direction(p);
    if (p.type === 'rock' && dir.angleTo(new THREE.Vector3(-0.25, -0.62, -0.74).normalize()) < 0.003) return false;
    const distance = dir.angleTo(isletCenter);
    return distance > 0.26 && distance < 0.60;
  });
  if (home && island && !protectedShoreProps && (home.scale ?? 1) <= 1
      && direction(home).angleTo(HARBOR_REAR_LIGHTHOUSE_DIR) < 0.003) {
    island.n = lighthouseIsletOutline();
    delete island.points;
    const center = offsetSurfaceDir(HARBOR_REAR_LIGHTHOUSE_DIR, propFacing(HARBOR_REAR_LIGHTHOUSE_DIR, Math.PI), 0.12);
    result.push({ kind: 'path', type: 'openWater', n: sphericalRing(center.toArray(), 0.57, 32) },
      { kind: 'path', type: 'wave', n: lighthouseIsletOutline(0.035) },
      { kind: 'path', type: 'deck', n: [0.34, 0.60].map((distance) => offsetSurfaceDir(
        HARBOR_REAR_LIGHTHOUSE_DIR, propFacing(HARBOR_REAR_LIGHTHOUSE_DIR, Math.PI), distance).toArray()) });
  }
  const pavilion = result.find((p) => p.type === 'civicPavilion');
  const pavilionSite = new THREE.Vector3(...WORLD_HOME_SITES.ludwig.n).normalize();
  const originalPavilion = offsetSurfaceDir(pavilionSite, tangentBasis(pavilionSite).east, 0.38);
  if (pavilion && direction(pavilion).angleTo(originalPavilion) < 0.003 && Math.abs((pavilion.scale ?? 1) - 0.62) < 0.001) {
    pavilion.scale = 0.95;
    const near = result.filter((p) => p.type === 'lane').flatMap(normalizePathDirs)
      .sort((a, b) => a.angleTo(originalPavilion) - b.angleTo(originalPavilion))[0];
    if (near) {
      const basis = tangentBasis(originalPavilion);
      pavilion.yaw = Math.atan2(near.dot(basis.east), near.dot(basis.north));
    }
  }
  if (!result.some((p) => p.type === 'harborShelter')) {
    const site = mapDir(-0.62, -0.20);
    const occupied = result.some((p) => p.kind !== 'path' && direction(p).angleTo(site) < 0.24);
    if (!occupied) result.push({ type: 'harborShelter', n: site.toArray(),
      yaw: canonicalMapYaw(-0.62, -0.20, Math.PI), scale: 0.90 });
  }
  return result;
}

function migrateVillageBoard(layout) {
  const result = layout.map((p) => ({ ...p }));
  const boards = result.filter((p) => p.type === 'resultBoard');
  const position = { n: mapDir(-0.36, 0.39).toArray(), yaw: canonicalMapYaw(-0.36, 0.39, Math.PI), scale: 0.90 };
  if (!boards.length) result.push({ type: 'resultBoard', ...position });
  for (const board of boards) {
    const dir = board.n ? new THREE.Vector3(...board.n).normalize() : mapDir(board.x, board.z);
    if (dir.angleTo(mapDir(-0.25, 0.26)) < 0.003 && Math.abs((board.scale ?? 1) - 0.72) < 0.001) {
      Object.assign(board, position); delete board.x; delete board.z;
    }
  }
  return result;
}

function migrateSpatialStructure(layout) {
  const result = layout.map((p) => ({ ...p }));
  const unit = (n) => new THREE.Vector3(...n).normalize();
  const centerOf = (points) => points.reduce((sum, n) => sum.add(n), new THREE.Vector3()).normalize();
  const dir = (p) => p.n ? unit(p.n) : mapDir(p.x, p.z);
  const matches = (p, expected) => {
    const points = normalizePathDirs(p);
    return points.length === expected.length && points.every((n, i) => n.angleTo(unit(expected[i])) < 0.003);
  };
  const core = result.find((p) => p.type === 'opsBeacon');
  const ring = sphericalRing(mapDir(0, 0.10).toArray(), 0.205, 40);
  if (core && dir(core).angleTo(mapDir(0, 0.10)) < 0.003) {
    for (const p of result) {
      if (p.kind === 'path' && ['road', 'streetEdge'].includes(p.type) && matches(p, ring)) {
        p.id = p.type === 'road' ? 'core.promenade' : 'core.plaza-edge'; p.districtId = 'core';
      }
    }
  }
  // Only the known default sites are migrated. Moved homes and hand-drawn
  // courtyards remain untouched; stable IDs survive save/import/undo.
  for (const key of ['rodi', 'jarvis', 'yul', 'ludwig', 'anne']) {
    const home = result.find((p) => p.type === 'cottage' && p.ownerKey === key);
    if (!home || dir(home).angleTo(unit(WORLD_HOME_SITES[key].n)) > 0.003) continue;
    const id = `${key}.forecourt`;
    if (result.some((p) => p.id === id)) continue;
    const center = dir(home), front = propFacing(center, home.yaw || 0);
    const side = new THREE.Vector3().crossVectors(front, center).normalize();
    const type = key === 'anne' ? 'grass' : 'courtyard';
    const prior = result.find((p) => p.kind === 'path' && p.type === type
      && matches(p, sphericalRing(WORLD_HOME_SITES[key].n, type === 'grass' ? 0.23 : 0.20, 16)));
    const custom = result.some((p) => p !== prior && p.kind === 'path' && ['grass', 'courtyard'].includes(p.type)
      && centerOf(normalizePathDirs(p)).angleTo(center) < 0.25);
    if (custom) continue;
    const right = ['jarvis', 'ludwig'].includes(key) ? 0.43 : 0.27;
    const left = key === 'yul' ? -0.43 : -0.27;
    const outline = [[left, -0.13], [right * 0.8, -0.15], [right, 0.02],
      [right * 0.92, 0.23], [0.09, 0.31], [left * 0.88, 0.24], [left, 0.04]];
    const n = outline.map(([x, z]) => center.clone().addScaledVector(side, x).addScaledVector(front, z).normalize().toArray());
    if (prior) Object.assign(prior, { n, id, districtId: key });
    else result.push({ kind: 'path', type, n, id, districtId: key });
    if (prior) delete prior.points;
    if (key === 'anne' && !result.some((p) => p.id === 'anne.garden-coast')) {
      result.push({ kind: 'path', type: 'island', n, id: 'anne.garden-coast', districtId: key });
    }
  }
  if (!result.some((p) => p.id === 'rose.quiet-garden')
      && !result.some((p) => p.kind === 'path' && ['grass', 'courtyard'].includes(p.type)
        && centerOf(normalizePathDirs(p)).angleTo(new THREE.Vector3(0, 1, 0)) < 0.18)) {
    result.push({ kind: 'path', type: 'grass', id: 'rose.quiet-garden', districtId: 'rose',
      n: sphericalRing([0, 1, 0], 0.17, 16) });
  }
  const gate = result.find((p) => p.type === 'ferryGate' && dir(p).angleTo(mapDir(0.34, -0.43)) < 0.003);
  if (gate && (gate.scale ?? 1) === 0.82) {
    gate.n = mapDir(-0.30, -0.54).toArray();
    gate.yaw = canonicalMapYaw(-0.30, -0.54, 0);
    delete gate.x; delete gate.z;
  }
  return result;
}

function migrateVillageComposition(layout) {
  const unit = (n) => new THREE.Vector3(...n).normalize();
  const dir = (p) => p.n ? unit(p.n) : mapDir(p.x, p.z);
  const matches = (p, points) => {
    const actual = normalizePathDirs(p);
    return actual.length === points.length && actual.every((n, i) => n.angleTo(unit(points[i])) < 0.003);
  };
  const result = layout.map((p) => ({ ...p }));
  const oldPavilion = offsetSurfaceDir(unit(WORLD_HOME_SITES.ludwig.n),
    tangentBasis(unit(WORLD_HOME_SITES.ludwig.n)).east, 0.38);
  const pavilion = result.find((p) => p.type === 'civicPavilion' && dir(p).angleTo(oldPavilion) < 0.003
    && Math.abs((p.scale ?? 1) - 0.95) < 0.001);
  const rearJunction = unit([0.05, 0.80, -0.60]);
  const rearSite = unit([0.10, 0.52, -0.85]);
  const rearRoad = result.some((p) => p.type === 'lane'
    && normalizePathDirs(p).some((n) => n.angleTo(rearJunction) < 0.003));
  const occupied = result.some((p) => p.kind !== 'path' && p !== pavilion
    && dir(p).angleTo(rearSite) < (p.ownerKey || p.type === 'harborShelter' ? 0.33 : 0.24));
  if (pavilion && rearRoad && !occupied) {
    pavilion.n = rearSite.toArray();
    const basis = tangentBasis(rearSite);
    pavilion.yaw = Math.atan2(rearJunction.dot(basis.east), rearJunction.dot(basis.north));
    delete pavilion.x; delete pavilion.z;
  }
  // Extend only the original harbor spur; custom streets keep their endpoints.
  for (const p of result) {
    if (!['road', 'streetEdge'].includes(p.type)) continue;
    const points = normalizePathDirs(p);
    if (points.length === 3 && points[0].angleTo(mapDir(0, -0.40)) < 0.003
        && points[1].angleTo(mapDir(-0.05, -0.22)) < 0.003) {
      p.n = [mapDir(0, -0.425).toArray(), ...points.slice(1).map((n) => n.toArray())];
      delete p.points;
    }
  }
  const rose = result.find((p) => p.id === 'rose.quiet-garden' && p.type === 'grass'
    && matches(p, sphericalRing([0, 1, 0], 0.17, 16)));
  const roseJunction = unit([-0.65, 0.73, -0.20]);
  const roseRoad = result.some((p) => p.type === 'lane'
    && normalizePathDirs(p).some((n) => n.angleTo(roseJunction) < 0.003));
  const approach = [unit([-0.14, 0.99, -0.043]), unit([-0.32, 0.94, -0.098]), roseJunction];
  const roseOccupied = result.some((p) => p.kind !== 'path'
    && approach.some((n) => dir(p).angleTo(n) < 0.20));
  if (rose && roseRoad && !roseOccupied) {
    rose.type = 'courtyard';
    rose.n = sphericalRing([0, 1, 0], 0.12, 16);
    delete rose.points;
    if (!result.some((p) => p.id === 'rose.approach')) result.push({ kind: 'path', type: 'lane',
      id: 'rose.approach', districtId: 'rose', n: approach.map((n) => n.toArray()) });
  }
  // This is the specific offshore placement reviewed in v105, not every saved boat.
  const stranded = unit([-0.7627984, -0.4034992, 0.5052989]);
  const mooring = mapDir(-0.28, -0.92);
  const pier = result.some((p) => p.type === 'deck'
    && matches(p, [[-0.28, -0.41], [-0.30, -0.68]].map((n) => mapDir(...n).toArray())));
  const boat = result.find((p) => p.type === 'fishingBoat' && dir(p).angleTo(stranded) < 0.001);
  if (boat && pier && !result.some((p) => p !== boat && p.kind !== 'path'
      && dir(p).angleTo(mooring) < (p.type === 'ferryGate' ? 0.18 : 0.25))) {
    boat.n = mooring.toArray(); boat.yaw = 0.18;
    delete boat.x; delete boat.z;
  }
  const retiredTerraces = [unit([-0.42039, 0.64069, 0.64249]), unit([0.41240, 0.64950, 0.63880])];
  return result.filter((p) => !(p.type === 'terrace'
    && retiredTerraces.some((n) => dir(p).angleTo(n) < 0.001)));
}

function migrateSavedComposition(layout, raw) {
  const key = 'HandulPlanet_composition_v106';
  try {
    if (localStorage.getItem(key)) return layout;
    const next = migrateVillageComposition(layout);
    if (JSON.stringify(next) !== JSON.stringify(layout)) {
      const backups = JSON.parse(localStorage.getItem(LAYOUT_BACKUP_KEY) || '[]');
      const kept = Array.isArray(backups) ? backups.slice(-4) : [];
      kept.push({ schemaVersion: LAYOUT_SCHEMA_VERSION, createdAt: new Date().toISOString(),
        reason: 'before-composition-v106', layout: JSON.parse(raw) });
      // Do not change the saved arrangement unless its original is backed up.
      localStorage.setItem(LAYOUT_BACKUP_KEY, JSON.stringify(kept));
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
    }
    // If only the marker fails, keep rendering the already-saved arrangement.
    // The geometry migration is idempotent, so a retry is harmless.
    try { localStorage.setItem(key, '1'); } catch (_) { /* retry next load */ }
    return next;
  } catch (error) {
    console.warn('배치 개선 백업/저장 보류:', error);
    return layout;
  }
}

const DEFAULT_LAYOUT = migrateVillageComposition(migrateSpatialStructure(migrateVillageBoard(migrateSharedHarbor(migrateRoadJunctions(spreadWorldNeighborhoods([
  ...HARBOR_TERRAIN_LAYOUT,
  ...HARBOR_DISTRICT_INFRASTRUCTURE,
  ...HARBOR_FRONT_LAYOUT,
  ...HARBOR_REAR_LAYOUT,
]))))));

// Home driveways are terrain tied to each service-home spot — regenerated
// whenever the layout changes, so they follow the houses around in edit mode.
// Agent home assignment rides along: reassigned whenever cottages change.
// (stub until the agents exist; replaced after the AGENTS block below)
const HOME_PROP_TYPES = new Set(['cottage', 'lighthouse']);
const PUBLIC_SPACE_TYPES = new Set(['civicPavilion', 'harborShelter']);
let assignAgentHomes = () => {};
function homeDoorDir(home) {
  if (!home?.mesh || !home.dir) return null;
  const local = home.mesh.userData.doorOffset;
  if (!local) return home.dir.clone();
  home.mesh.updateMatrixWorld(true);
  return home.mesh.localToWorld(local.clone()).normalize();
}
const drivewayGroup = new THREE.Group();
scene.add(drivewayGroup);
const drivewayConnections = [];

function nearestStreetConnection(home, doorDir) {
  const facing = propFacing(home.data.dir, home.data.yaw || 0);
  let best = null;
  for (const path of editablePaths) {
    const streetTypes = PUBLIC_SPACE_TYPES.has(home.data.type) ? ['road', 'lane', 'market', 'deck'] : ['road', 'lane'];
    if (!streetTypes.includes(path.data.type)) continue;
    const samples = splineDirs(path.data.dirs, { step: 0.015 }).dirs;
    for (const dir of samples) {
      const tangent = dir.clone().sub(home.data.dir.clone().multiplyScalar(dir.dot(home.data.dir)));
      const ahead = tangent.lengthSq() > 1e-8 ? tangent.normalize().dot(facing) : 1;
      if (ahead < -0.12) continue;
      const angle = doorDir.angleTo(dir);
      const score = angle + Math.max(0, 0.18 - ahead) * 0.08;
      if (!best || score < best.score) best = { dir: dir.clone(), score, angle, type: path.data.type };
    }
  }
  return best;
}

function rebuildDriveways() {
  // Group.clear() detaches but never disposes — free the GPU resources first,
  // or dragging a cottage (which rebuilds continuously) leaks geometries.
  for (const child of drivewayGroup.children.slice()) disposeObject(child);
  drivewayGroup.clear();
  drivewayConnections.length = 0;
  for (const it of editables) {
    if (!HOME_PROP_TYPES.has(it.data.type) && !PUBLIC_SPACE_TYPES.has(it.data.type)) continue;
    const start = homeDoorDir(it);
    const connection = start ? nearestStreetConnection(it, start) : null;
    if (!start || !connection || connection.angle > 0.34) continue;
    const end = connection.dir;
    const paving = makeCountryRoad([start, end],
      { width: 0.50, color: 0xc5c8b0, lift: 0.168 });
    paving.userData.surfaceDir = it.dir.clone();
    drivewayGroup.add(paving);
    drivewayConnections.push({
      home: it,
      ownerKey: it.data.ownerKey || '',
      streetType: connection.type,
      length: connection.angle * R,
      start: start.clone(),
      end: end.clone(),
    });
  }
  rebuildStreetEdges();
  assignAgentHomes();
}

function rebuildStreetEdges() {
  const widths = { road: 0.90, lane: 0.70, deck: 0.62, market: 0.72 };
  const streets = editablePaths.filter((path) => widths[path.data.type]).map((path) => ({
    dirs: path.data.dirs,
    samples: splineDirs(path.data.dirs, { step: 0.012 }).dirs,
    width: widths[path.data.type],
  }));
  const driveways = drivewayConnections.map((link) => ({
    samples: splineDirs([link.start, link.end], { step: 0.012 }).dirs, width: 0.50,
  }));
  for (const path of editablePaths) {
    if (!['streetEdge', 'laneEdge'].includes(path.data.type)) continue;
    const others = streets.filter((street) => !samePathRoute(street.dirs, path.data.dirs));
    const crossings = [...others, ...driveways];
    const old = path.mesh;
    const mesh = path.data.id === 'core.plaza-edge' ? new THREE.Group() : makeStreetEdges(path.data.dirs, {
      radius: R, roadWidth: path.data.type === 'streetEdge' ? 0.90 : 0.70,
      splineDirs, makeSurfaceRibbon, materialFactory: toonMat,
      isOpening: (dir) => crossings.some((street) => street.samples.some((sample) =>
        sample.dot(dir) > Math.cos((street.width / 2 + 0.07) / R))),
    });
    mesh.visible = old.visible;
    applyPaperObject(mesh);
    scene.add(mesh);
    path.mesh = mesh;
    removeSceneObject(old);
  }
}

function roadClearanceState() {
  const paths = editablePaths.filter((path) => ['road', 'lane'].includes(path.data.type));
  const issues = [];
  let samples = 0, blockedSamples = 0, wetSamples = 0;
  const result = paths.map((path, index) => {
    const width = path.data.type === 'road' ? 0.90 : 0.70;
    const { dirs, closed } = splineDirs(path.data.dirs, { step: 0.012 });
    let blocked = 0, wet = 0;
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i];
      const previous = dirs[closed ? (i - 1 + dirs.length) % dirs.length : Math.max(0, i - 1)];
      const next = dirs[closed ? (i + 1) % dirs.length : Math.min(dirs.length - 1, i + 1)];
      const side = new THREE.Vector3().crossVectors(dir, next.clone().sub(previous)).normalize();
      for (const lateral of [-1, 0, 1]) {
        const point = offsetSurfaceDir(dir, side, lateral * Math.max(0, width / (2 * R) - PLAYER_CLEARANCE_RADIUS));
        samples++;
        const collider = getSurfaceColliders().find((item) => point.angleTo(item.dir) < item.radius + PLAYER_CLEARANCE_RADIUS);
        const inWater = isWaterSurfaceDir(point);
        if (collider) { blocked++; blockedSamples++; }
        if (inWater) { wet++; wetSamples++; }
        if ((collider || inWater) && !issues.some((issue) => issue.path === index && issue.obstacle === (collider?.label || 'water'))) {
          issues.push({ path: index, type: path.data.type, obstacle: collider?.label || 'water', n: point.toArray() });
        }
      }
    }
    return { type: path.data.type, closed, samples: dirs.length * 3, blocked, wet };
  });
  return { paths: paths.length, samples, blockedSamples, wetSamples, issues, segments: result,
    pass: paths.length > 0 && blockedSamples === 0 && wetSamples === 0 };
}

function sharedHarborState() {
  const spaces = editables.filter((item) => PUBLIC_SPACE_TYPES.has(item.data.type)).map((item) => {
    const link = drivewayConnections.find((connection) => connection.home === item);
    const samples = link ? splineDirs([link.start, link.end], { step: 0.012 }).dirs : [];
    return { type: item.data.type, connected: !!link, length: link ? +link.length.toFixed(3) : null,
      clear: samples.length > 0 && samples.every((dir) => !isInWaterDir(dir) && hasSurfaceClearance(dir, PLAYER_CLEARANCE_RADIUS)) };
  });
  const lighthouse = editables.find((item) => item.data.type === 'lighthouse' && item.data.ownerKey === 'argos');
  const islandChecked = !!lighthouse && lighthouse.dir.angleTo(HARBOR_REAR_LIGHTHOUSE_DIR) < 0.003
    && editablePaths.some((item) => item.data.type === 'openWater');
  const coast = islandChecked ? lighthouseIsletOutline(0.065).slice(0, -1).map((n) => new THREE.Vector3(...n)) : [];
  const pierEnd = offsetSurfaceDir(HARBOR_REAR_LIGHTHOUSE_DIR, propFacing(HARBOR_REAR_LIGHTHOUSE_DIR, Math.PI), 0.68);
  const mooring = offsetSurfaceDir(pierEnd, tangentBasis(pierEnd).east, 0.16);
  const landing = islandChecked ? nearestDryShoreDirection(mooring) : null;
  const island = { checked: islandChecked, coastSamples: coast.length,
    waterSamples: coast.filter(isWaterSurfaceDir).length,
    boatOnly: islandChecked && isWaterSurfaceDir(mooring) && !playerSurfaceAllowed(mooring, false),
    canLand: !!landing && !isInWaterDir(landing) && hasSurfaceClearance(landing, PLAYER_CLEARANCE_RADIUS) };
  const boat = editables.find((item) => item.data.type === 'fishingBoat');
  return { spaces, island, boatScale: boat ? +(boat.mesh.scale.x).toFixed(3) : null,
    pass: spaces.length === 2 && spaces.every((space) => space.connected && space.clear)
      && island.checked && island.waterSamples === island.coastSamples && island.boatOnly && island.canLand };
}
// Rebuild dependent driveways and curb openings after home or street edits.
function syncCottageExtras(type) {
  if (HOME_PROP_TYPES.has(type) || PUBLIC_SPACE_TYPES.has(type) || ['road', 'lane', 'streetEdge', 'laneEdge', 'deck', 'market'].includes(type)) rebuildDriveways();
}
// throttle wrapper for continuous (per-pointermove) rebuilds while dragging
let lastDrivewayRebuild = 0;
function rebuildDrivewaysThrottled() {
  const now = performance.now();
  if (now - lastDrivewayRebuild < 120) return;
  lastDrivewayRebuild = now;
  rebuildDriveways();
}

// Build the starting (or saved) village. loadLayout() is defined with the
// persistence helpers below; fall back to the default if nothing is saved.
// A saved layout that somehow still fails to build must never brick the app —
// fall back to the default village.
try {
  // QA defaults to the release layout; qaLayout=saved also exercises migration.
  buildLayout(URL_PARAMS.has('qa') && URL_PARAMS.get('qaLayout') !== 'saved'
    ? DEFAULT_LAYOUT : (loadSavedLayout() || DEFAULT_LAYOUT));
} catch (e) {
  console.warn('saved layout failed to build — using default', e);
  try { localStorage.removeItem(LAYOUT_KEY); } catch (_) { /* ignore */ }
  buildLayout(DEFAULT_LAYOUT);
}
lastLayoutSnap = JSON.stringify(serializeLayout());   // undo baseline
rebuildDriveways();

// (All the world's objects — houses, fields, bridges, forest trees, even the
// lakes — are now built from DEFAULT_LAYOUT / the saved layout above, so the
// edit mode can move and persist every one of them.)

// ---------------------------------------------------------------------------
// DOM world labels — kept outside the post-processing composer so bloom never
// washes out text. Every label follows a Three.js target via camera projection.
// ---------------------------------------------------------------------------
const worldLabelsEl = document.getElementById('worldLabels');
const worldLabels = new Set();
const labelSizeCache = createElementSizeCache();
const _labelWorld = new THREE.Vector3();
const _labelProjected = new THREE.Vector3();
const _labelCameraDir = new THREE.Vector3();
const _labelOcclusionPoint = new THREE.Vector3();
const _labelRayDirection = new THREE.Vector3();
const _labelRaycaster = new THREE.Raycaster();
let worldLabelFrame = 0;

const LABEL_PRIORITY = {
  bubble: 110,
  player: 95,
  agent: 75,
  landmark: 60,
  home: 40,
  default: 30,
};

function createWorldLabel(text, {
  target,
  offset = new THREE.Vector3(),
  direction = null,
  bubble = false,
  emoji = false,
  color = null,
  kind = bubble ? 'bubble' : 'default',
  visibilityDot = 0.14,
  onActivate = null,
} = {}) {
  const element = document.createElement(onActivate ? 'button' : 'div');
  element.className = `world-label ${kind}${bubble ? ' bubble' : ''}${emoji ? ' emoji' : ''}`;
  if (onActivate) {
    element.type = 'button';
    element.classList.add('interactive');
    element.setAttribute('aria-label', text);
    element.inert = document.body.classList.contains('intro-active');
    element.title = `${text} 이야기`;
    element.addEventListener('click', onActivate);
  } else element.setAttribute('aria-hidden', 'true');
  if (color) {
    const dot = document.createElement('span');
    dot.className = 'world-label-dot';
    dot.style.backgroundColor = color;
    element.appendChild(dot);
  }
  const copy = document.createElement('span');
  copy.textContent = text ?? '';
  element.appendChild(copy);
  worldLabelsEl.appendChild(element);

  const label = {
    element,
    target,
    offset: offset.clone(),
    direction,
    alpha: 1,
    enabled: true,
    kind,
    emoji,
    visibilityDot,
    occluded: false,
    collisionHidden: false,
    screenOffsetY: 0,
    occlusionPhase: worldLabels.size % 3,
    offsetChangedAt: 0,
    hiddenReason: '',
  };
  worldLabels.add(label);
  return label;
}

function removeWorldLabel(label) {
  if (!label) return;
  worldLabels.delete(label);
  labelSizeCache.remove(label.element);
  label.element.remove();
}

function openRoseStory() {
  if (editMode || document.body.classList.contains('intro-active')) return false;
  dashboardStopPatrol();
  dashboardCloseCard();
  dashboardCloseTeam();
  closeServicePanel();
  villageBoard.close?.();
  return roseStory.open();
}
const roseLabel = createWorldLabel('B-612의 장미', {
  target: poleRose,
  offset: new THREE.Vector3(0, 2.24, 0),
  direction: NORTH_POLE,
  kind: 'landmark',
  visibilityDot: 0.015,
  onActivate: openRoseStory,
});

function isObjectInside(object, ancestor) {
  for (let current = object; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function labelOccludedByBuilding(label, buildings) {
  const { target } = label;
  const probeHeight = label.kind === 'agent' || label.kind === 'player' || label.kind === 'bubble'
    ? 0.72
    : label.kind === 'landmark' ? 1.1 : 0;
  target.localToWorld(_labelOcclusionPoint.set(0, probeHeight, 0));
  _labelRayDirection.copy(_labelOcclusionPoint).sub(camera.position);
  const distance = _labelRayDirection.length();
  if (distance < 0.5) return false;
  _labelRayDirection.multiplyScalar(1 / distance);
  _labelRaycaster.set(camera.position, _labelRayDirection);
  _labelRaycaster.near = 0.08;
  _labelRaycaster.far = Math.max(0.1, distance - 0.34);
  if (!buildings.length) return false;
  return _labelRaycaster.intersectObjects(buildings, true)
    .some((hit) => !isObjectInside(hit.object, target));
}

function labelPriority(label) {
  let priority = LABEL_PRIORITY[label.kind] || LABEL_PRIORITY.default;
  if (label.emoji) priority += 8;
  if (typeof focusNpc !== 'undefined' && label.target === focusNpc) priority += 20;
  return priority;
}

function screenRectCollides(rect, accepted, padding = 4) {
  return accepted.some((other) => !(
    rect.right + padding <= other.left
    || rect.left >= other.right + padding
    || rect.bottom + padding <= other.top
    || rect.top >= other.bottom + padding
  ));
}

function addLabelUiObstacles(accepted) {
  const elements = [
    document.querySelector('.hud'),
    document.getElementById('weather'),
    document.getElementById('agentbarWrap'),
    document.querySelector('.agent-card.show'),
    document.querySelector('.team-panel.show'),
    document.querySelector('.service-panel.show'),
  ];
  for (const element of elements) {
    if (!element || element.offsetParent === null) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) accepted.push(rect);
  }
}

function updateWorldLabels() {
  worldLabelFrame++;
  const measureAt = performance.now();
  const accepted = [];
  addLabelUiObstacles(accepted);
  _labelCameraDir.copy(camera.position).normalize();
  const mobileControlsVisible = experienceMode === 'explore' && innerWidth <= 520;
  const candidates = [];
  const buildingOccluders = editables
    .filter((item) => HOME_PROP_TYPES.has(item.data.type) && item.mesh?.visible)
    .map((item) => item.mesh);
  let nearestHomeLabel = null;
  let nearestHomeAngle = 0.72;
  if (experienceMode === 'explore') {
    for (const label of worldLabels) {
      if (label.kind !== 'home' || !label.enabled || !label.target?.parent) continue;
      const direction = typeof label.direction === 'function' ? label.direction() : label.direction;
      if (!direction) continue;
      const angle = playerDir.angleTo(direction);
      if (angle < nearestHomeAngle) {
        nearestHomeAngle = angle;
        nearestHomeLabel = label;
      }
    }
  }

  for (const label of worldLabels) {
    const { target, element } = label;
    const hideHomeLabel = label.kind === 'home'
      && (experienceMode === 'dashboard' || label !== nearestHomeLabel);
    if (!label.enabled || !target?.parent || hideHomeLabel) {
      element.hidden = true;
      label.hiddenReason = !label.enabled ? 'disabled' : hideHomeLabel ? 'home-priority' : 'detached';
      continue;
    }

    target.localToWorld(_labelWorld.copy(label.offset));
    _labelProjected.copy(_labelWorld).project(camera);
    const surfaceDir = typeof label.direction === 'function'
      ? label.direction()
      : label.direction;
    const behindPlanet = surfaceDir && surfaceDir.dot(_labelCameraDir) <= label.visibilityDot;
    const x = (_labelProjected.x * 0.5 + 0.5) * innerWidth;
    const y = (-_labelProjected.y * 0.5 + 0.5) * innerHeight;
    const offscreen = x < -120 || x > innerWidth + 120 || y < -80 || y > innerHeight + 80;
    const overlapsMobileControls = mobileControlsVisible && y > innerHeight - 165
      && (x < 175 || x > innerWidth - 175);

    if (_labelProjected.z > 1 || behindPlanet || offscreen || overlapsMobileControls) {
      element.hidden = true;
      label.hiddenReason = behindPlanet
        ? 'planet'
        : offscreen ? 'offscreen' : overlapsMobileControls ? 'mobile-controls' : 'camera';
      continue;
    }

    if ((worldLabelFrame + label.occlusionPhase) % 3 === 0) {
      label.occluded = labelOccludedByBuilding(label, buildingOccluders);
    }
    if (label.occluded) {
      element.hidden = true;
      label.hiddenReason = 'building';
      continue;
    }

    const distance = camera.position.distanceTo(_labelWorld);
    const nearFactor = THREE.MathUtils.clamp(1 - (distance - 6) / 24, 0, 1);
    const opacity = (0.5 + nearFactor * 0.5) * label.alpha;
    const scale = 0.85 + nearFactor * 0.15;
    element.hidden = false;
    label.collisionHidden = false;
    label.hiddenReason = '';
    candidates.push({
      label,
      x,
      y,
      scale,
      distance,
      opacity,
      priority: labelPriority(label),
    });
  }

  // Read all sizes before opacity/transform writes, avoiding per-label reflow.
  for (const candidate of candidates) {
    const size = labelSizeCache.measure(candidate.label.element, measureAt);
    candidate.width = size.width * candidate.scale;
    candidate.height = size.height * candidate.scale;
  }
  candidates.sort((a, b) => b.priority - a.priority || a.distance - b.distance);
  const baseOffsets = [0, -18, 18, -36, 36, -54, 54];

  for (const candidate of candidates) {
    const { label, x: anchorX, y, width, height, scale } = candidate;
    label.element.style.opacity = candidate.opacity.toFixed(3);
    const x = candidate.priority >= LABEL_PRIORITY.player
      ? THREE.MathUtils.clamp(anchorX, 8 + width / 2, innerWidth - 8 - width / 2)
      : anchorX;
    const canSettle = Math.abs(label.screenOffsetY) > 0.5
      && worldLabelFrame - label.offsetChangedAt > 18;
    const offsets = [
      ...(canSettle ? [0] : []),
      label.screenOffsetY,
      ...baseOffsets,
    ]
      .filter((value, index, all) => all.findIndex((other) => Math.abs(other - value) < 0.5) === index);
    let placed = null;
    for (const offsetY of offsets) {
      const anchorY = y + offsetY;
      const rect = {
        left: x - width / 2,
        right: x + width / 2,
        top: anchorY - height,
        bottom: anchorY,
      };
      const insideFrame = rect.left >= 8 && rect.right <= innerWidth - 8
        && rect.top >= 8 && rect.bottom <= innerHeight - 8;
      if (insideFrame && !screenRectCollides(rect, accepted)) {
        placed = { offsetY, rect };
        break;
      }
    }

    // Speech and player feedback must never disappear; lower-priority chips
    // yield when the frame is too crowded.
    if (!placed && candidate.priority >= LABEL_PRIORITY.player) {
      const anchorY = THREE.MathUtils.clamp(y + (label.screenOffsetY || 0), height + 8, innerHeight - 8);
      const offsetY = anchorY - y;
      placed = {
        offsetY,
        rect: {
          left: x - width / 2,
          right: x + width / 2,
          top: anchorY - height,
          bottom: anchorY,
        },
      };
    }

    if (!placed) {
      label.element.hidden = true;
      label.collisionHidden = true;
      label.hiddenReason = 'collision';
      continue;
    }

    if (Math.abs(label.screenOffsetY - placed.offsetY) > 0.5) {
      label.offsetChangedAt = worldLabelFrame;
      label.screenOffsetY = placed.offsetY;
    }
    accepted.push(placed.rect);
    label.element.hidden = false;
    label.element.style.transform = `translate3d(${x.toFixed(2)}px, ${(y + placed.offsetY).toFixed(2)}px, 0) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
  }
}

// ---------------------------------------------------------------------------
// Characters — abeto-style little people: tapered torso, round head with a
// face, a cap, and pivoted arms/legs that swing while walking. Shared by the
// player and the NPCs/agents.
// ---------------------------------------------------------------------------
function characterTone(color, lightnessOffset, saturationOffset = -0.03) {
  return new THREE.Color(color).offsetHSL(0, saturationOffset, lightnessOffset);
}

function makeCharacterContactShadow(radius = 0.36) {
  const material = new THREE.MeshBasicMaterial({
    color: 0x24363f,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), material);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.014;
  shadow.scale.set(1, 0.62, 1);
  shadow.renderOrder = -2;
  return shadow;
}

function updateCharacterContactShadow(character, lift = 0, move01 = 0, hidden = false) {
  const shadow = character.userData.contactShadow;
  if (!shadow) return;
  const air = THREE.MathUtils.clamp(lift / 1.1, 0, 1);
  const spread = 1 + move01 * 0.08 + air * 0.26;
  shadow.position.y = 0.014 - lift;
  shadow.scale.set(spread, (0.62 + air * 0.12) * spread, 1);
  shadow.material.opacity = hidden ? 0 : 0.16 * (1 - air * 0.72);
}

function setCharacterBodyColor(character, color) {
  character.userData.bodyMaterial?.color.setHex(color);
  character.userData.trimMaterial?.color.copy(characterTone(color, -0.13));
  character.userData.softMaterial?.color.copy(characterTone(color, 0.14, -0.12));
}

function makeCharacter(bodyColor, headColor = 0xffe8cf, name = null, opts = {}) {
  const {
    cap = true,
    pantsColor = 0x5a5f73,
    handColor = headColor,
    faceStyle = 'default',
    handsVisible = true,
  } = opts;
  const g = new THREE.Group();
  const bodyMat = toonMat(bodyColor);
  const trimMat = toonMat(characterTone(bodyColor, -0.13));
  const softMat = toonMat(characterTone(bodyColor, 0.14, -0.12));
  const skinMat = toonMat(headColor);
  const handMat = toonMat(handColor);
  const pantsMat = toonMat(pantsColor);
  const shoeMat = toonMat(0x424957);

  g.userData.characterType = 'person';
  g.userData.modelHeight = 1.35;
  g.userData.labelHeight = 1.62;
  g.userData.activityHeight = 1.48;
  g.userData.bodyMaterial = bodyMat;
  g.userData.trimMaterial = trimMat;
  g.userData.softMaterial = softMat;

  const contactShadow = makeCharacterContactShadow();
  g.add(contactShadow);
  g.userData.contactShadow = contactShadow;

  // `body` groups everything that bobs while walking (torso/head/arms);
  // the legs live on the root so the bob reads as an upper-body hop.
  const body = new THREE.Group();
  g.add(body);
  g.userData.body = body;

  // Jacket, seam and collar: a tiny amount of layering makes the body read as
  // clothing instead of one unbroken cylinder when the camera moves in.
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.225, 0.44, 12), bodyMat);
  torso.position.y = 0.66; torso.castShadow = true; addOutline(torso);
  body.add(torso);
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.26, 0.024), trimMat);
  seam.position.set(0, 0.64, 0.218);
  body.add(seam);
  [-0.052, 0.052].forEach((x, i) => {
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.04, 0.03), softMat);
    collar.position.set(x, 0.845, 0.17);
    collar.rotation.z = (i ? -1 : 1) * 0.48;
    body.add(collar);
  });
  [0.61, 0.70].forEach(y => {
    const button = new THREE.Mesh(new THREE.SphereGeometry(0.015, 7, 5), trimMat);
    button.position.set(0.035, y, 0.226);
    body.add(button);
  });

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.12, 10), skinMat);
  neck.position.y = 0.91;
  body.add(neck);

  // The whole head is one rig, allowing restrained idle glances without eyes,
  // hat and accessories drifting apart.
  const headRig = new THREE.Group();
  headRig.position.y = 1.055;
  body.add(headRig);
  g.userData.headRig = headRig;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 13), skinMat);
  head.scale.set(1.02, 1.02, 0.96);
  head.castShadow = true; addOutline(head);
  headRig.add(head);
  const eyeMat = toonMat(0x40394a);
  if (faceStyle === 'closed') {
    [-0.07, 0.07].forEach((x, index) => {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.012, 0.014), eyeMat);
      eye.position.set(x, 0.014, 0.218);
      eye.rotation.z = (index ? -1 : 1) * 0.08;
      headRig.add(eye);
    });
  } else if (faceStyle !== 'blank') {
    [-0.07, 0.07].forEach(x => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.029, 9, 7), eyeMat);
      eye.position.set(x, 0.018, 0.204);
      const glint = new THREE.Mesh(
        new THREE.SphereGeometry(0.008, 6, 4),
        new THREE.MeshBasicMaterial({ color: 0xfffbef }),
      );
      glint.position.set(-0.007, 0.009, 0.026);
      eye.add(glint);
      headRig.add(eye);
    });
    const cheekMat = toonMat(0xe9a49d);
    [-0.128, 0.128].forEach(x => {
      const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.018, 7, 5), cheekMat);
      cheek.scale.set(1.05, 0.56, 0.38);
      cheek.position.set(x, -0.035, 0.196);
      headRig.add(cheek);
    });
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.014, 7, 5), toonMat(0x9d6667));
    mouth.scale.set(1.45, 0.34, 0.32);
    mouth.position.set(0, -0.063, 0.209);
    headRig.add(mouth);
  }

  // A shallow cap keeps the top silhouette soft; the old tall dome looked like
  // a cone at close range and hid too much of the face.
  if (cap) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.222, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.48), bodyMat);
    dome.position.y = 0.032; dome.castShadow = true;
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.255, 0.028, 0.14), softMat);
    brim.position.set(0, 0.052, 0.205);
    headRig.add(dome, brim);
  }

  // Arms end in visible hands; feet angle slightly forward so the walking
  // direction stays readable even when the planet is zoomed out.
  const limbs = {};
  [['armL', -0.235], ['armR', 0.235]].forEach(([key, x]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.84, 0);                      // shoulder
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.20, 4, 8), bodyMat);
    arm.position.y = -0.145; arm.castShadow = true; addOutline(arm);
    pivot.add(arm);
    if (handsVisible) {
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.062, 9, 7), handMat);
      hand.position.set(0, -0.292, 0.012); hand.castShadow = true;
      pivot.add(hand);
    }
    body.add(pivot);
    limbs[key] = pivot;
  });
  [['legL', -0.10], ['legR', 0.10]].forEach(([key, x]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.45, 0);                      // hip
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.064, 0.19, 4, 8), pantsMat);
    leg.position.y = -0.155; leg.castShadow = true; addOutline(leg);
    const shoe = new THREE.Mesh(new THREE.SphereGeometry(0.082, 10, 7), shoeMat);
    shoe.scale.set(0.9, 0.56, 1.28);
    shoe.position.set(0, -0.31, 0.045); shoe.castShadow = true;
    pivot.add(leg, shoe);
    g.add(pivot);
    limbs[key] = pivot;
  });
  g.userData.limbs = limbs;

  if (name) g.userData.labelText = name;
  return g;
}

// Argos keeps a compact bronze owl vessel beside the star-warden body. It is a
// companion prop, not Jarvis's body, and deliberately has no character rig.
function makeBronzeOwlVessel(scale = 1) {
  const g = new THREE.Group();
  const bronze = toonMat(0xa98258);
  const violet = toonMat(0x4b3f72);
  const gold = toonMat(0xf2cf70);
  const dark = toonMat(0x29233f);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.20, 12, 9), bronze);
  body.scale.set(0.88, 1.18, 0.78);
  body.position.y = 0.25;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 9), bronze);
  head.scale.set(1.18, 0.92, 0.88);
  head.position.y = 0.47;
  [-0.19, 0.19].forEach((x, index) => {
    const wing = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.24, 3, 7), violet);
    wing.scale.set(0.62, 1, 0.48);
    wing.position.set(x, 0.26, -0.01);
    wing.rotation.z = (index ? -1 : 1) * 0.24;
    const eyeMark = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.009, 5, 12), gold);
    eyeMark.position.set(x, 0.27, 0.075);
    const eyeCore = new THREE.Mesh(new THREE.SphereGeometry(0.016, 6, 5), dark);
    eyeCore.position.set(x, 0.27, 0.084);
    g.add(wing, eyeMark, eyeCore);
  });
  [-0.073, 0.073].forEach(x => {
    const lens = new THREE.Mesh(new THREE.TorusGeometry(0.054, 0.015, 6, 14), gold);
    lens.position.set(x, 0.49, 0.165);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.043, 12), dark);
    glass.position.set(x, 0.49, 0.17);
    g.add(lens, glass);
  });
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.038, 0.10, 6), gold);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.43, 0.19);
  [-0.13, 0.13].forEach(x => {
    const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.11, 6), bronze);
    tuft.position.set(x, 0.64, 0);
    g.add(tuft);
  });
  const chestStars = [
    [-0.055, 0.29], [0.035, 0.33], [0.068, 0.23], [-0.025, 0.18],
  ];
  for (const [x, y] of chestStars) {
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.018, 0), gold);
    star.position.set(x, y, 0.17);
    g.add(star);
  }
  [body, head, beak].forEach((mesh) => {
    mesh.castShadow = true;
    addOutline(mesh, 1.035);
    g.add(mesh);
  });
  g.scale.setScalar(scale);
  return g;
}

// Per-agent signature props so each resonator reads at a glance, even from
// afar. The stable `visual.style` enum comes from config/agents.json, keeping
// the public character design next to the role/SOUL projection instead of
// coupling it to an agent key in this renderer.
function addAgentAccessories(c, visual = {}) {
  const body = c.userData.body;
  const L = c.userData.limbs;
  if (!body || !L) return;
  const headRig = c.userData.headRig;
  const style = typeof visual.style === 'string' ? visual.style : '';
  c.userData.visualStyle = style;

  const addHairDome = (color, { back = true } = {}) => {
    if (!headRig) return null;
    const hairMat = toonMat(color);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.226, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.53),
      hairMat,
    );
    dome.position.y = 0.025;
    dome.castShadow = true;
    headRig.add(dome);
    if (back) {
      const backHair = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.20, 3, 8), hairMat);
      backHair.position.set(0, -0.12, -0.15);
      backHair.castShadow = true;
      headRig.add(backHair);
    }
    return hairMat;
  };

  const makeTuningFork = ({ repair = true, scale = 1 } = {}) => {
    const fork = new THREE.Group();
    const silver = toonMat(0xd9dee7);
    const gold = toonMat(0xf2cf70);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.021, 0.28, 7), silver);
    handle.position.y = -0.04;
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.025, 0.025), silver);
    bridge.position.y = 0.10;
    fork.add(handle, bridge);
    [-0.046, 0.046].forEach(x => {
      const tine = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.15, 7), silver);
      tine.position.set(x, 0.175, 0);
      fork.add(tine);
    });
    if (repair) {
      const repairBand = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.008, 5, 10), gold);
      repairBand.rotation.x = Math.PI / 2;
      repairBand.position.set(0, 0.015, 0);
      fork.add(repairBand);
    }
    fork.scale.setScalar(scale);
    return fork;
  };

  if (style === 'companion-conductor') {
    // Midnight constellation coat, Polaris pins and gold-mended baton.
    addHairDome(0x172033);
    const baton = makeTuningFork({ repair: true, scale: 1.08 });
    baton.position.set(0, -0.31, 0.08);
    baton.rotation.x = -0.58;
    baton.rotation.z = -0.10;
    L.armR.add(baton);
    const coatMat = c.userData.trimMaterial || toonMat(0x151d31);
    [-0.095, 0.095].forEach((x, index) => {
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.43, 0.05), coatMat);
      tail.position.set(x, 0.38, -0.10);
      tail.rotation.z = (index ? -1 : 1) * 0.08;
      body.add(tail);
    });
    const sash = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.43, 0.026), toonMat(0x7f8ca8));
    sash.position.set(0, 0.70, 0.225);
    sash.rotation.z = -0.42;
    body.add(sash);
    const polaris = new THREE.Mesh(new THREE.OctahedronGeometry(0.047, 0), toonMat(0xffd76b));
    polaris.scale.set(0.9, 1.35, 0.7);
    polaris.position.set(-0.105, 0.77, 0.255);
    body.add(polaris);
    [[-0.06, 0.69], [0.05, 0.62], [0.11, 0.72]].forEach(([x, y]) => {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.018, 0), toonMat(0xb9c5e3));
      star.position.set(x, y, 0.245);
      body.add(star);
    });
    c.userData.labelHeight = 1.68;
    c.userData.activityHeight = 1.56;
  } else if (style === 'clockwork-steward') {
    // Human-shaped butler automaton: lunar lenses, chronicle crest and watch.
    const brass = toonMat(0xd1a45f);
    const glass = new THREE.MeshBasicMaterial({ color: 0x8fcbff });
    const white = toonMat(0xf4f2e8);
    [-0.075, 0.075].forEach(x => {
      const lens = new THREE.Mesh(new THREE.TorusGeometry(0.059, 0.014, 6, 16), brass);
      lens.position.set(x, 0.018, 0.221);
      const lensGlass = new THREE.Mesh(new THREE.CircleGeometry(0.047, 14), glass);
      lensGlass.position.set(x, 0.018, 0.225);
      headRig?.add(lens, lensGlass);
    });
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.022, 0.018), toonMat(0x72583d));
    brow.position.set(0, 0.105, 0.195);
    headRig?.add(brow);

    [-0.11, 0.11].forEach((x, index) => {
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.42, 0.05), c.userData.trimMaterial);
      tail.position.set(x, 0.38, -0.10);
      tail.rotation.z = (index ? -1 : 1) * 0.07;
      body.add(tail);
    });
    const shirt = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.24, 0.025), white);
    shirt.position.set(0, 0.70, 0.225);
    const bow = new THREE.Mesh(new THREE.OctahedronGeometry(0.045, 0), toonMat(0x35414d));
    bow.scale.set(1.55, 0.70, 0.55);
    bow.position.set(0, 0.80, 0.25);
    body.add(shirt, bow);

    const crest = new THREE.Group();
    [0.095, 0.068, 0.040].forEach((radius, index) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.009, 5, 18), index === 0 ? brass : glass);
      crest.add(ring);
    });
    const hour = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.066, 0.012), toonMat(0x27394a));
    hour.position.y = 0.025;
    const minute = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.082, 0.012), toonMat(0x27394a));
    minute.position.set(0.025, 0.025, 0);
    minute.rotation.z = -0.62;
    crest.add(hour, minute);
    crest.position.set(0, 0.62, 0.247);
    body.add(crest);

    const watch = new THREE.Group();
    const watchFace = new THREE.Mesh(new THREE.CircleGeometry(0.055, 14), white);
    const watchRim = new THREE.Mesh(new THREE.TorusGeometry(0.061, 0.012, 6, 16), brass);
    watch.add(watchFace, watchRim);
    watch.position.set(0.20, 0.54, 0.238);
    body.add(watch);
    for (let index = 0; index < 4; index++) {
      const link = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.005, 5, 10), brass);
      link.position.set(0.12 + index * 0.025, 0.69 - index * 0.045, 0.245);
      body.add(link);
    }
    const memoryRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.19, 0.012, 6, 24),
      new THREE.MeshBasicMaterial({ color: 0x8fcbff, transparent: true, opacity: 0.48 }),
    );
    memoryRing.position.set(-0.24, 0.92, -0.02);
    memoryRing.rotation.set(0.55, 0.25, 0.35);
    body.add(memoryRing);
    c.userData.labelHeight = 1.72;
    c.userData.activityHeight = 1.58;
  } else if (style === 'moonlight-scholar') {
    // Gray-haired scholar with silver glasses and a locked research book.
    addHairDome(0x8a8f9b);
    const glassMat = toonMat(0xc9ced8);
    [-0.07, 0.07].forEach(x => {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.011, 6, 16), glassMat);
      rim.position.set(x, 0.018, 0.218);
      headRig?.add(rim);
    });
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.014, 0.014), glassMat);
    bridge.position.set(0, 0.018, 0.22);
    headRig?.add(bridge);
    const book = new THREE.Group();
    const coverMat = toonMat(0x6f5747);
    const pageMat = toonMat(0xf4efe2);
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.055, 0.26), coverMat);
    const pages = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.045, 0.235), pageMat);
    pages.position.y = 0.035;
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.042, 0.025), toonMat(0xc9a35f));
    lock.position.set(0, 0.065, 0.13);
    book.add(cover, pages, lock);
    [0xe07a7a, 0x778fbd, 0xd8bd67].forEach((color, index) => {
      const mark = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.012, 0.10), toonMat(color));
      mark.position.set(-0.06 + index * 0.06, 0.068, -0.13);
      book.add(mark);
    });
    book.position.set(0, -0.31, 0.09);
    book.rotation.x = -0.62;
    L.armL.add(book);
    const scholarMat = c.userData.trimMaterial || toonMat(0x6c688f);
    [-0.10, 0.10].forEach((x, index) => {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.34, 0.042), scholarMat);
      panel.position.set(x, 0.44, -0.075);
      panel.rotation.z = (index ? -1 : 1) * 0.055;
      body.add(panel);
    });
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.035, 6, 18), toonMat(0x9aa1b2));
    scarf.rotation.x = Math.PI / 2;
    scarf.position.y = 0.85;
    const crescent = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.012, 5, 14, Math.PI * 1.55), toonMat(0xd5d9f2));
    crescent.position.set(-0.09, 0.73, 0.25);
    crescent.rotation.z = -0.35;
    body.add(scarf, crescent);
    const ink = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 5), toonMat(0x3c4058));
    ink.position.set(0.025, -0.33, 0.052);
    L.armR.add(ink);
    c.userData.labelHeight = 1.70;
    c.userData.activityHeight = 1.56;
  } else if (style === 'forest-atelier') {
    // Small forest fairy: red twin braids, straw hat, brush and scent bottles.
    const hairMat = addHairDome(0xb93a3f, { back: false });
    [-0.18, 0.18].forEach((x, index) => {
      const braid = new THREE.Mesh(new THREE.CapsuleGeometry(0.043, 0.22, 3, 8), hairMat);
      braid.position.set(x, -0.13, -0.01);
      braid.rotation.z = (index ? -1 : 1) * 0.08;
      headRig?.add(braid);
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.042, 0.13, 7), toonMat(0xf4d8c5));
      ear.position.set(index ? 0.23 : -0.23, -0.005, 0);
      ear.rotation.z = (index ? -1 : 1) * Math.PI / 2;
      headRig?.add(ear);
    });
    [-0.10, -0.06, 0.06, 0.10].forEach((x, index) => {
      const freckle = new THREE.Mesh(new THREE.SphereGeometry(0.006, 5, 4), toonMat(0xb97868));
      freckle.position.set(x, -0.025 - (index % 2) * 0.008, 0.222);
      headRig?.add(freckle);
    });
    const straw = toonMat(0xd8bd78);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.035, 16), straw);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.15, 14), straw);
    brim.position.y = 0.18;
    crown.position.y = 0.27;
    const ribbon = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.018, 6, 18), toonMat(0x8faf8f));
    ribbon.rotation.x = Math.PI / 2;
    ribbon.position.y = 0.225;
    headRig?.add(brim, crown, ribbon);
    const brush = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.34, 6), toonMat(0xc9a87c));
    const bristle = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 8), toonMat(0xd91f4e));
    bristle.position.y = 0.2;
    brush.add(handle, bristle);
    brush.position.set(0, -0.36, 0.06);
    brush.rotation.x = -0.5;
    L.armR.add(brush);
    const apron = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.22, 0.026), toonMat(0xf8ded8));
    apron.position.set(0, 0.64, 0.224);
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.19, 0.285, 0.27, 12),
      c.userData.softMaterial || toonMat(0xf1b6b1),
    );
    skirt.position.y = 0.46;
    const satchel = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.13, 0.07), toonMat(0xb79268));
    satchel.position.set(-0.235, 0.57, 0.07);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.39, 0.022), toonMat(0xb79268));
    strap.position.set(-0.10, 0.72, 0.20);
    strap.rotation.z = -0.48;
    body.add(skirt, apron, satchel, strap);
    [0x8db9a4, 0xd6a2bd, 0xe8c66e].forEach((color, index) => {
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.023, 0.09, 7), toonMat(color));
      bottle.position.set(-0.17 + index * 0.055, 0.54, 0.245);
      body.add(bottle);
    });
    c.userData.labelHeight = 1.72;
    c.userData.activityHeight = 1.58;
  } else if (style === 'resonance-listener') {
    // Last resonant: low-tied black hair, ear crystals and repaired tuning fork.
    const hairMat = addHairDome(0x17191f);
    const ponytail = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.28, 3, 8), hairMat);
    ponytail.position.set(0, -0.20, -0.20);
    ponytail.rotation.x = -0.10;
    headRig?.add(ponytail);
    const crystalMat = new THREE.MeshToonMaterial({
      color: 0x63e0d4,
      emissive: 0x1c4f5a,
      emissiveIntensity: 0.45,
      gradientMap: TOON_GRAD,
    });
    [-1, 1].forEach(side => {
      for (let index = 0; index < 3; index++) {
        const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.035 - index * 0.005, 0), crystalMat);
        crystal.scale.y = 1.45;
        crystal.position.set(side * (0.215 + index * 0.025), 0.045 - index * 0.055, -0.005);
        crystal.rotation.z = side * (0.42 + index * 0.15);
        headRig?.add(crystal);
      }
      const irisRune = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.006, 5, 14), crystalMat);
      irisRune.position.set(side * 0.07, 0.018, 0.223);
      headRig?.add(irisRune);
    });
    [-0.105, 0.105].forEach((x, index) => {
      const robePanel = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.43, 0.048), c.userData.trimMaterial);
      robePanel.position.set(x, 0.38, -0.085);
      robePanel.rotation.z = (index ? -1 : 1) * 0.045;
      body.add(robePanel);
    });
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.055, 0.03), toonMat(0xd7e3df));
    collar.position.set(0, 0.81, 0.22);
    body.add(collar);
    const fork = makeTuningFork({ repair: true, scale: 1.0 });
    fork.position.set(0, -0.32, 0.07);
    fork.rotation.x = -0.58;
    L.armR.add(fork);
    const pendant = makeTuningFork({ repair: true, scale: 0.34 });
    pendant.position.set(0, 0.72, 0.245);
    pendant.rotation.z = Math.PI;
    body.add(pendant);
    c.userData.labelHeight = 1.70;
    c.userData.activityHeight = 1.57;
  } else if (style === 'star-warden-observer') {
    // Tall star-warden body with hidden hands, floating eyes and owl vessel.
    const robeMat = c.userData.trimMaterial || toonMat(0x342d54);
    const hood = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.062, 7, 20), robeMat);
    hood.position.set(0, 0.01, 0.005);
    headRig?.add(hood);
    const robe = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.31, 0.66, 12), robeMat);
    robe.position.y = 0.48;
    const cloak = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.62, 0.055), robeMat);
    cloak.position.set(0, 0.53, -0.21);
    cloak.rotation.x = -0.06;
    body.add(robe, cloak);
    [L.armL, L.armR].forEach((arm, index) => {
      const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.078, 0.28, 4, 8), robeMat);
      sleeve.position.set(0, -0.17, 0.005);
      sleeve.scale.set(1.15, 1.15, 1.05);
      arm.add(sleeve);
      arm.rotation.z = (index ? -1 : 1) * 0.38;
    });
    const starMat = toonMat(0xd7cee9);
    [[-0.14, 0.72], [0.09, 0.63], [-0.04, 0.51], [0.15, 0.42], [-0.10, 0.32]].forEach(([x, y], index) => {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(index === 0 ? 0.024 : 0.015, 0), starMat);
      star.position.set(x, y, 0.245);
      body.add(star);
    });
    const eyeGold = toonMat(0xf2cf70);
    [[-0.34, 1.05, -0.03], [0.34, 0.92, 0.01], [0.28, 1.25, -0.06]].forEach(([x, y, z], index) => {
      const eye = new THREE.Group();
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.060 - index * 0.006, 0.012, 6, 16), eyeGold);
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.024, 7, 5), toonMat(0x29233f));
      core.position.z = 0.012;
      eye.add(rim, core);
      eye.position.set(x, y, z);
      body.add(eye);
    });
    const owl = makeBronzeOwlVessel(0.68);
    owl.position.set(0.34, 0.38, 0.08);
    owl.rotation.y = -0.22;
    body.add(owl);
    c.userData.lockedSleeves = true;
    c.userData.labelHeight = 1.82;
    c.userData.activityHeight = 1.68;
  }
}

// drive the walk cycle: move01 = 0 (idle) → 1 (full stride). Arms and legs
// swing in opposite phase; idle relaxes into a faint breathing sway.
function animateCharacterWalk(char, move01, t) {
  const L = char.userData.limbs;
  if (!L) return;
  const swing = Math.sin(t * 8.5) * 0.58 * move01;
  L.legL.rotation.x = -swing * 0.92;
  L.legR.rotation.x = swing * 0.92;
  const rest = 1 - move01;
  const breath = Math.sin(t * 1.55);
  const idle = rest * (0.035 + breath * 0.022);
  if (char.userData.lockedSleeves) {
    L.armL.rotation.x = 0.10 + Math.sin(t * 0.7) * 0.012;
    L.armR.rotation.x = 0.10 - Math.sin(t * 0.7) * 0.012;
    L.armL.rotation.z = 0.38 + idle * 0.2;
    L.armR.rotation.z = -0.38 - idle * 0.2;
  } else {
    L.armL.rotation.x = swing;
    L.armR.rotation.x = -swing;
    L.armL.rotation.z = 0.08 + idle;
    L.armR.rotation.z = -0.08 - idle;
  }

  const body = char.userData.body;
  if (body) {
    body.scale.set(1 - rest * breath * 0.004, 1 + rest * breath * 0.008, 1);
    body.rotation.x = 0;
    body.rotation.y = 0;
    body.rotation.z = Math.sin(t * 8.5) * 0.025 * move01;
  }
  const headRig = char.userData.headRig;
  if (headRig) {
    headRig.rotation.x = 0;
    headRig.rotation.y = Math.sin(t * 0.58) * 0.12 * rest;
    headRig.rotation.z = Math.sin(t * 0.81 + 0.7) * 0.018 * rest;
  }
}

const CHARACTER_WORLD_SCALE = 0.84;
const player = makeCharacter(save.data.modelFiles.base, 0xffe8cf, '한들');   // 나 — avatar color from saved state
batchStaticMeshTree(player);
player.scale.setScalar(CHARACTER_WORLD_SCALE);
const body = player.userData.body;
scene.add(player);

// ---------------------------------------------------------------------------
// Public visitor UI — a small checklist and avatar palette. This borrows the
// reference site's "world first, paper UI on demand" rhythm without copying
// its game objectives or visual assets.
// ---------------------------------------------------------------------------
const VISITOR_SAVE_KEY = 'HandulPlanet_visitor_v1';
let visitorProgress = { explore: false, agent: false, service: false };
try {
  visitorProgress = { ...visitorProgress, ...JSON.parse(localStorage.getItem(VISITOR_SAVE_KEY) || '{}') };
} catch (_) { /* ignore malformed visitor progress */ }

function updateVisitorGuide() {
  const keys = ['explore', 'agent', 'service'];
  let completed = 0;
  for (const key of keys) {
    const done = !!visitorProgress[key];
    document.querySelector(`[data-visit="${key}"]`)?.classList.toggle('done', done);
    if (done) completed++;
  }
  const label = document.getElementById('visitProgressText');
  const bar = document.getElementById('visitProgressBar');
  if (label) label.textContent = `${completed} / ${keys.length} 완료`;
  if (bar) bar.style.width = `${(completed / keys.length) * 100}%`;
}

function markVisitorStep(key) {
  if (!(key in visitorProgress) || visitorProgress[key]) return;
  visitorProgress[key] = true;
  try { localStorage.setItem(VISITOR_SAVE_KEY, JSON.stringify(visitorProgress)); } catch (_) { /* ignore */ }
  updateVisitorGuide();
}

function closeVisitorPanels(exceptId = '') {
  for (const [panelId, toggleId] of [['visitorGuide', 'guideToggle'], ['appearancePanel', 'appearanceToggle']]) {
    if (panelId === exceptId) continue;
    const panel = document.getElementById(panelId);
    const toggle = document.getElementById(toggleId);
    if (panel) panel.hidden = true;
    toggle?.setAttribute('aria-expanded', 'false');
  }
}

(function wireVisitorUI() {
  const pairs = [
    ['guideToggle', 'visitorGuide', 'guideClose'],
    ['appearanceToggle', 'appearancePanel', 'appearanceClose'],
  ];
  for (const [toggleId, panelId, closeId] of pairs) {
    const toggle = document.getElementById(toggleId);
    const panel = document.getElementById(panelId);
    toggle?.addEventListener('click', () => {
      dashboardStopPatrol();
      const willOpen = panel.hidden;
      closeVisitorPanels(willOpen ? panelId : '');
      panel.hidden = !willOpen;
      toggle.setAttribute('aria-expanded', String(willOpen));
    });
    document.getElementById(closeId)?.addEventListener('click', () => closeVisitorPanels());
  }
  const current = save.data.modelFiles.base;
  for (const swatch of document.querySelectorAll('[data-avatar-color]')) {
    const color = parseInt(swatch.dataset.avatarColor, 16);
    swatch.classList.toggle('active', color === current);
    swatch.addEventListener('click', () => {
      setCharacterBodyColor(player, color);
      save.data.modelFiles.base = color;
      save.store();
      document.querySelectorAll('[data-avatar-color]').forEach(b => b.classList.toggle('active', b === swatch));
    });
  }
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVisitorPanels(); });
  updateVisitorGuide();
})();

// ---------------------------------------------------------------------------
// HERMES AGENTS — 여섯 공명자가 행성을 거닌다. 로스터는 config/agents.json,
// 각 집의 서비스는 config/services.json에서 온다(코드 수정 없이 편집 가능).
// 클릭하면 상태 카드가 열린다(에이전트 대시보드). `status`는 agent-status.json
// 파일이 주기적으로 덮어쓴다 — 헤르메스 실데이터 연동 지점.
// ---------------------------------------------------------------------------
function configHex(value, fallback) {
  const match = typeof value === 'string' ? value.trim().match(/^#?([0-9a-f]{6})$/i) : null;
  return match ? parseInt(match[1], 16) : fallback;
}
const AGENTS = AGENT_CONFIG.map((a) => ({
  ...a,
  color: configHex(a.color, 0xcccccc),
  visual: {
    ...(a.visual && typeof a.visual === 'object' ? a.visual : {}),
    style: typeof a.visual?.style === 'string' ? a.visual.style : '',
  },
  lines: Array.isArray(a.lines) && a.lines.length ? a.lines : ['…'],
  status: {
    state: a.defaultStatus?.state || '대기 중',
    task: a.defaultStatus?.task || '',
    updatedAt: null,
    progress: null,
    result: null,
    results: [],
    health: null,
    model: null,
    provider: null,
    blocker: null,
    approvalState: null,
    riskLevel: null,
    currentTaskId: null,
    lastActivityAt: null,
    verificationState: null,
    verifiedAt: null,
    evidenceDigest: null,
  },
  results: RESULT_COLLECTIONS[a.key] || [],
  service: SERVICES[a.key] || null,
}));
const ARGOS_AGENT = AGENTS.find(a => a.key === 'argos') || null;
let refreshRecentResultsUi = () => {};
let resultRefreshInFlight = null;
let opsBeaconFleetSummary = null;

async function refreshPublicResults() {
  if (resultRefreshInFlight) return resultRefreshInFlight;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  resultRefreshInFlight = (async () => {
    try {
      const response = await fetch(RUNTIME_CONFIG.results.snapshotUrl || 'agent-results.json', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`results ${response.status}`);
      const payload = await response.json();
      const collections = payload?.agents && typeof payload.agents === 'object'
        ? payload.agents
        : payload;
      if (!collections || typeof collections !== 'object') throw new Error('invalid result snapshot');
      for (const agent of AGENTS) {
        agent.results = normalizePublicResults(collections[agent.key]);
      }
      refreshOpenServicePanel();
      refreshRecentResultsUi();
      return true;
    } catch (error) {
      console.warn('공개 결과 새로고침 실패:', error);
      return false;
    } finally {
      clearTimeout(timeout);
      resultRefreshInFlight = null;
    }
  })();
  return resultRefreshInFlight;
}

function syncAgentHomeStatusVisuals() {
  for (const a of AGENTS) {
    const home = a.home?.mesh;
    if (!home) continue;
    const mode = agentActivityMode(a.status);
    // Idle homes keep the village's warm evening-window language. Status
    // colors appear only when they carry information, instead of making every
    // resting house glow the same green.
    const statusLit = mode === 'working' || mode === 'review' || mode === 'error';
    const tone = new THREE.Color(statusLit ? statusColor(a.status.state) : 0xffe8ad);
    const intensity = {
      working: 0.88,
      review: 0.68,
      error: 0.74,
      complete: 0.56,
      idle: 0.42,
    }[mode] ?? 0.42;
    for (const mat of home.userData.windowMaterials || []) {
      if (mat.color) mat.color.copy(tone);
      if (mat.emissive) mat.emissive.copy(tone);
      if ('emissiveIntensity' in mat) mat.emissiveIntensity = intensity;
    }
    const signature = home.userData.signatureMotion;
    if (signature) {
      signature.active = statusLit;
      signature.glowMaterial.emissiveIntensity = statusLit ? 0.86 : 0.44;
    }
    const beam = home.userData.lighthouseBeam;
    if (beam) beam.visible = a.key === 'argos' && isWorkingStatus(a.status.state);
  }
  syncOpsBeaconStatusVisuals();
}

function syncOpsBeaconStatusVisuals(fleet = opsBeaconFleetSummary) {
  const rowByKey = new Map((fleet?.rows || []).map((row) => [row.key, row]));
  const state = fleet?.state || 'demo';
  const coreTone = ({
    healthy: 0x72c8c5,
    demo: 0x81bfbc,
    loading: 0x8ea3a5,
    degraded: 0xe0a33f,
    incomplete: 0xe0a33f,
    stale: 0xc3844e,
    error: 0xd96b6b,
    offline: 0x7f8c90,
  })[state] || 0x8ea3a5;
  for (const item of editables) {
    const beacon = item.mesh?.userData?.opsBeacon;
    if (!beacon) continue;
    beacon.coreMaterial.color.setHex(coreTone);
    beacon.coreMaterial.emissive.setHex(coreTone);
    beacon.coreMaterial.emissiveIntensity = ['healthy', 'demo'].includes(state) ? 0.78 : 0.48;
    for (const material of beacon.ringMaterials) {
      material.color.setHex(coreTone);
      material.opacity = state === 'offline' ? 0.28 : 0.68;
    }
    for (const node of beacon.nodes) {
      const row = rowByKey.get(node.key);
      const agent = AGENTS.find((candidate) => candidate.key === node.key);
      const mode = agent ? agentActivityMode(agent.status) : 'idle';
      const linkState = row?.linkState || (fleet ? 'missing' : 'demo');
      const dimmed = ['missing', 'stale', 'offline'].includes(linkState);
      const failed = linkState === 'error' || mode === 'error';
      const color = failed ? 0xd96b6b : dimmed ? 0x839093 : node.color;
      node.material.color.setHex(color);
      node.material.emissive.setHex(color);
      node.material.emissiveIntensity = mode === 'working' ? 0.95 : dimmed ? 0.16 : 0.48;
      node.mesh.scale.setScalar(dimmed ? 0.78 : mode === 'working' ? 1.12 : 1);
      node.spoke.color.setHex(color);
      node.spoke.opacity = dimmed ? 0.12 : mode === 'working' ? 0.66 : 0.34;
    }
  }
}

const npcs = [];
// Spread the agents evenly over the sphere with a Fibonacci lattice so they
// never spawn clumped together. They also repel each other while walking
// (see the NPC loop), so they can never end up 100% overlapping.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));     // golden angle
const N = AGENTS.length;
AGENTS.forEach((d, i) => {
  // Every roster member keeps the shared walk/status contract. Config selects
  // the face and hand treatment; accessories establish the canonical silhouette.
  const skinColor = configHex(d.visual.skinColor, 0xffe8cf);
  const baseOptions = {
    cap: d.visual.cap !== false,
    pantsColor: configHex(d.visual.pantsColor, 0x5a5f73),
  };
  if (d.character === 'automaton') {
    Object.assign(baseOptions, {
      handColor: 0xf4f2e8,
      faceStyle: 'blank',
    });
  } else if (d.character === 'star-warden') {
    Object.assign(baseOptions, {
      faceStyle: 'closed',
      handsVisible: false,
    });
  }
  const c = makeCharacter(d.color, skinColor, d.name, baseOptions);
  c.userData.characterType = d.character || 'person';
  addAgentAccessories(c, d.visual);
  addAgentActivitySignal(c, d.color, d.activityStyle);
  batchStaticMeshTree(c);
  c.userData.agent = d;                          // dashboard record for the status card
  d.npc = c;                                     // back-reference (bubbles, camera focus)
  const configuredScale = Number(d.visual.scale);
  c.scale.setScalar((Number.isFinite(configuredScale)
    ? THREE.MathUtils.clamp(configuredScale, 0.86, 1.22)
    : 1.02 + (i % 3) * 0.07) * CHARACTER_WORLD_SCALE);

  // evenly distributed point on the unit sphere
  const y = 1 - (i + 0.5) / N * 2;               // y from ~+1 down to ~-1
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN * i;
  c.userData.dir = new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r).normalize();
  c.userData.nameLabel = createWorldLabel(c.userData.labelText, {
    target: c,
    offset: new THREE.Vector3(0, c.userData.labelHeight || 1.62, 0),
    direction: () => c.userData.dir,
    color: cssHex(d.color),
    kind: 'agent',
  });

  c.userData.heading = theta;                    // current facing
  c.userData.desiredHeading = theta;             // steering goal (smoothly chased)
  c.userData.turnTimer = 0.5 + i * 0.4;          // stagger their first turns
  c.userData.speed = 0.07 + (i % 4) * 0.012;     // slow, readable movement for an observation scene
  c.userData.phase = i * 1.7;                    // walk-bob phase offset so they're out of sync
  c.userData.lines = d.lines;                    // speech-bubble phrases
  c.userData.bubble = null;                      // current DOM speech bubble
  c.userData.bubbleTimer = 6 + i * 1.7;          // dialogue is an accent, not constant visual noise
  c.userData.activityTimer = 2.5 + i * 0.65;
  c.userData.isResting = i % 2 === 0;
  scene.add(c);
  npcs.push(c);
});

// ---------------------------------------------------------------------------
// Agent home bases — five agents claim cottages; Argos claims the lighthouse.
// gets a flag in the agent's color, and the wander AI drifts back toward it.
// Reassigned automatically whenever cottages move/appear/disappear in edit
// mode (rebuildDriveways calls assignAgentHomes).
// ---------------------------------------------------------------------------
// Sized to stay readable after the cottage's ~0.7 child-scale shrinks it.
function makeAgentFlag(color) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.8, 6), toonMat(0x81786d));
  pole.position.y = 0.9; pole.castShadow = true;
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.56, 0.30, 5, 1),
    new THREE.MeshToonMaterial({ color, gradientMap: TOON_GRAD, side: THREE.DoubleSide })
  );
  flag.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
  flag.position.set(0.31, 1.55, 0);
  g.add(pole, flag);
  g.userData.cloth = flag;
  g.userData.clothBasePositions = Float32Array.from(flag.geometry.attributes.position.array);
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  return g;
}

const homeMarkers = [];   // flags, rebuilt whenever cottages change
const homeLabels = [];    // DOM nameplates, rebuilt with their cottage targets
function findHomeWorkDir(home, preferred) {
  const usable = (dir) => !isInWaterDir(dir) && hasSurfaceClearance(dir, 0.026);
  if (preferred && home.dir.angleTo(preferred) < 0.42 && usable(preferred)) return preferred;
  const forward = propFacing(home.dir, home.data.yaw || 0);
  // A moved or scaled house may cover its former work anchor. Search outside
  // the actual collider, preferring its entrance and then the side yards.
  const radius = (PROP_DEFS[home.data.type]?.collider || 0.27)
    * (PROP_DEFS[home.data.type]?.baseScale ?? 1) * (home.data.scale ?? 1);
  for (const margin of [0.07, 0.13, 0.21, 0.32]) {
    for (const angle of [0, -0.55, 0.55, -1.1, 1.1, -1.7, 1.7, Math.PI]) {
      const candidate = offsetSurfaceDir(home.dir,
        forward.clone().applyAxisAngle(home.dir, angle), radius + margin);
      if (usable(candidate)) return candidate;
    }
  }
  return null;
}
assignAgentHomes = function (repositionNpcs = false) {
  // clear old markers (their cottages may have been rebuilt or deleted)
  for (const m of homeMarkers) {
    m.parent?.remove(m);
    disposeObject(m);
  }
  homeMarkers.length = 0;
  for (const label of homeLabels) removeWorldLabel(label);
  homeLabels.length = 0;

  const homes = editables.filter(it => HOME_PROP_TYPES.has(it.data.type));
  const cottages = homes.filter(it => it.data.type === 'cottage');
  const claimed = new Set();
  // Migrate layouts saved before stable ownership existed. Once assigned,
  // ownerKey survives scale/color rebuilds and serialization.
  for (const a of AGENTS) {
    let home = homes.find(it => it.data.ownerKey === a.key);
    if (!home) {
      home = cottages.find(it => !it.data.ownerKey && !claimed.has(it));
      if (home) home.data.ownerKey = a.key;
    }
    if (home) claimed.add(home);
  }
  AGENTS.forEach((a, i) => {
    const home = homes.find(it => it.data.ownerKey === a.key) || null;
    a.home = home;
    a.workDir = null;
    if (!home) return;
    addAgentHomeSignature(home.mesh, a.key);
    const configured = AGENT_DISTRICT_ANCHORS[a.key];
    const district = configured ? new THREE.Vector3(...configured).normalize() : null;
    a.workDir = findHomeWorkDir(home, district);
    const flag = makeAgentFlag(a.color);
    // OUTSIDE the front wall beside the door (walls span x±1.97, z±1.81 local —
    // the old (1.5, 1.55) spot was buried inside the house geometry)
    flag.position.copy(home.mesh.userData.homeFlagOffset || new THREE.Vector3(1.35, 0, 2.5));
    home.mesh.add(flag);
    homeMarkers.push(flag);

    // nameplate above the door — moves/scales with the house in edit mode
    const plate = createWorldLabel(`${a.kor}의 집`, {
      target: home.mesh,
      offset: home.mesh.userData.homeLabelOffset || new THREE.Vector3(0, 3.9, 1.9),
      direction: () => home.dir,
      color: cssHex(a.color),
      kind: 'home',
    });
    homeLabels.push(plate);

    // on first assignment, drop each agent near their own house
    if (repositionNpcs && a.npc && a.workDir) {
      a.npc.userData.dir = a.workDir.clone();
    }
  });
  syncAgentHomeStatusVisuals();
};
assignAgentHomes(true);

// player state on the sphere: a position (unit dir) + a heading angle around it
let playerDir = DEFAULT_PLAYER_SPAWN_DIR.clone();     // south avenue: clear of the operations-core collider
let playerForward = mapForward(0, 1);                 // character facing (visual)
player.userData.nameLabel = createWorldLabel(player.userData.labelText, {
  target: player,
  offset: new THREE.Vector3(0, player.userData.labelHeight || 1.62, 0),
  direction: () => playerDir,
  kind: 'player',
});
// camera anchor direction — input is CAMERA-relative (W = away from viewer,
// A/D = sideways on screen). Decoupled from the character's facing so running
// sideways doesn't swing the camera; only dragging rotates it.
const camDir = playerForward.clone();
const WALK = 0.9;                                      // radians/sec of surface travel scaled below
const SAIL = 0.62;
const TURN_SPEED = 2.2;                                // radians/sec of A/D turning
let playerStride = 0;                                  // smoothed 0..1 walk intensity for limb swing
let lastSafePlayerDir = playerDir.clone();
let playerBlockedFor = 0;
let playerRecoveryCount = 0;
let lastPlayerEscapeOptions = 12;
let activeBoatItem = null;
const BOAT_INTERACT_ANGLE = 0.30;
const _playerSurfaceQ = new THREE.Quaternion();

function playerSurfaceAllowed(dir, aboard = !!activeBoatItem) {
  return aboard ? isWaterSurfaceDir(dir) : !isInWaterDir(dir);
}

function nearestBoardableBoat(origin = playerDir, maxAngle = BOAT_INTERACT_ANGLE) {
  let nearest = null;
  let nearestAngle = maxAngle;
  for (const item of editables) {
    if (item.data.type !== 'fishingBoat' || !isWaterSurfaceDir(item.dir)) continue;
    const angle = origin.angleTo(item.dir);
    if (angle < nearestAngle) {
      nearest = item;
      nearestAngle = angle;
    }
  }
  return nearest;
}

function surfaceStepDirection(origin, tangent, angle) {
  const up = origin.clone().normalize();
  const travel = tangent.clone().sub(up.clone().multiplyScalar(tangent.dot(up)));
  if (travel.lengthSq() < 1e-10 || angle <= 0) return up;
  travel.normalize();
  const axis = new THREE.Vector3().crossVectors(up, travel).normalize();
  _playerSurfaceQ.setFromAxisAngle(axis, angle);
  return up.applyQuaternion(_playerSurfaceQ).normalize();
}

function playerEscapeOptionCount(origin = playerDir, step = 0.045, samples = 12, aboard = !!activeBoatItem) {
  const basis = tangentBasis(origin);
  let options = 0;
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2;
    const travel = basis.east.clone().multiplyScalar(Math.cos(angle))
      .add(basis.north.clone().multiplyScalar(Math.sin(angle)));
    const candidate = surfaceStepDirection(origin, travel, step);
    if (hasSurfaceClearance(candidate, PLAYER_CLEARANCE_RADIUS) && playerSurfaceAllowed(candidate, aboard)) options++;
  }
  return options;
}

function commitPlayerSurfaceDirection(nextDir) {
  const next = nextDir.clone().normalize();
  _playerSurfaceQ.setFromUnitVectors(playerDir, next);
  playerForward.applyQuaternion(_playerSurfaceQ);
  camDir.applyQuaternion(_playerSurfaceQ);
  playerDir.copy(next);
  keepPlayerForwardTangent();
}

function syncActiveBoatTransform() {
  if (!activeBoatItem) return;
  activeBoatItem.data.dir.copy(playerDir);
  const basis = tangentBasis(playerDir);
  activeBoatItem.data.yaw = Math.atan2(playerForward.dot(basis.east), playerForward.dot(basis.north));
  applyPropTransform(activeBoatItem);
}

function boardBoat(item) {
  if (!item || item.data.type !== 'fishingBoat' || !isWaterSurfaceDir(item.dir)) return false;
  activeBoatItem = item;
  commitPlayerSurfaceDirection(item.dir);
  playerForward.copy(propFacing(item.dir, item.data.yaw || 0)).normalize();
  camDir.copy(playerForward);
  keepPlayerForwardTangent();
  jumpVel = 0;
  jumpHeight = 0;
  onGround = true;
  player.visible = false;
  if (player.userData.nameLabel) player.userData.nameLabel.enabled = false;
  document.body.classList.add('boat-mode');
  syncActiveBoatTransform();
  ambientAudio.playEffect('board');
  showAppNotice('어선에 승선했습니다. 방향키나 WASD로 운항하고, 해안 가까이에서 F로 내릴 수 있어요.');
  return true;
}

function nearestDryShoreDirection(origin = playerDir) {
  const basis = tangentBasis(origin);
  const candidates = [];
  for (const radius of [0.035, 0.06, 0.09, 0.13, 0.18, 0.24, 0.31]) {
    for (let index = 0; index < 24; index++) {
      const angle = index / 24 * Math.PI * 2;
      const tangent = basis.east.clone().multiplyScalar(Math.cos(angle))
        .add(basis.north.clone().multiplyScalar(Math.sin(angle)));
      const candidate = surfaceStepDirection(origin, tangent, radius);
      if (isInWaterDir(candidate) || !hasSurfaceClearance(candidate, PLAYER_CLEARANCE_RADIUS)) continue;
      const exits = playerEscapeOptionCount(candidate, 0.038, 10, false);
      if (exits < 2) continue;
      candidates.push({
        dir: candidate,
        exits,
        score: exits * 0.012 + surfaceColliderClearance(candidate) * 0.5 - radius,
      });
    }
    if (candidates.length) break;
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.dir || null;
}

function disembarkBoat({ notify = true } = {}) {
  if (!activeBoatItem) return false;
  const shore = nearestDryShoreDirection(playerDir);
  if (!shore) {
    if (notify) showAppNotice('해안에 조금 더 가까이 가야 배에서 내릴 수 있어요.');
    return false;
  }
  syncActiveBoatTransform();
  activeBoatItem = null;
  commitPlayerSurfaceDirection(shore);
  lastSafePlayerDir.copy(shore);
  playerBlockedFor = 0;
  player.visible = experienceMode === 'explore' && !activeBoatItem;
  if (player.userData.nameLabel) {
    player.userData.nameLabel.enabled = experienceMode === 'explore' && !activeBoatItem;
  }
  document.body.classList.remove('boat-mode');
  if (notify) {
    ambientAudio.playEffect('land');
    showAppNotice('해안에 내렸습니다.');
  }
  return true;
}

function cancelBoatModeToSafeSurface() {
  if (!activeBoatItem) return;
  syncActiveBoatTransform();
  activeBoatItem = null;
  commitPlayerSurfaceDirection(lastSafePlayerDir);
  document.body.classList.remove('boat-mode');
}

function nearestSafePlayerDirection(origin = playerDir) {
  const candidates = [];
  const consider = (candidate, bonus = 0) => {
    if (!candidate
      || !playerSurfaceAllowed(candidate)
      || !hasSurfaceClearance(candidate, PLAYER_CLEARANCE_RADIUS)) return;
    const distance = origin.angleTo(candidate);
    const escapeOptions = playerEscapeOptionCount(candidate, 0.038, 10);
    if (escapeOptions < 2) return;
    const clearance = Math.min(0.16, surfaceColliderClearance(candidate) - PLAYER_CLEARANCE_RADIUS);
    candidates.push({
      dir: candidate.clone(),
      escapeOptions,
      score: bonus + clearance * 1.8 + escapeOptions * 0.008 - distance * 0.48,
    });
  };

  const depenetrated = resolveSurfaceColliderPenetration(
    origin,
    PLAYER_CLEARANCE_RADIUS + 0.008,
  );
  consider(depenetrated, 0.04);
  if (lastSafePlayerDir.angleTo(origin) < 0.65 || (!activeBoatItem && isInWaterDir(origin))) {
    consider(lastSafePlayerDir, 0.10);
  }

  const basis = tangentBasis(origin);
  for (const radius of [0.04, 0.07, 0.11, 0.17, 0.25]) {
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const tangent = basis.east.clone().multiplyScalar(Math.cos(angle))
        .add(basis.north.clone().multiplyScalar(Math.sin(angle)));
      consider(surfaceStepDirection(origin, tangent, radius));
    }
    if (candidates.some((candidate) => candidate.escapeOptions >= 6)) break;
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.dir || null;
}

function recoverPlayerToSafeSurface({ notify = true, force = false } = {}) {
  const clear = playerSurfaceAllowed(playerDir)
    && hasSurfaceClearance(playerDir, PLAYER_CLEARANCE_RADIUS);
  const options = playerEscapeOptionCount(playerDir);
  lastPlayerEscapeOptions = options;
  if (!force && clear && options > 1) return false;
  if (force && clear && options >= 4) {
    if (notify) showAppNotice('현재 위치는 충분히 이동할 수 있는 공간이에요.');
    return false;
  }
  const safe = nearestSafePlayerDirection(playerDir);
  if (!safe) {
    if (notify) showAppNotice('가까운 안전 지점을 찾지 못했어요. 편집 모드에서 주변 오브젝트를 조금 띄워주세요.');
    return false;
  }
  commitPlayerSurfaceDirection(safe);
  lastSafePlayerDir.copy(safe);
  playerBlockedFor = 0;
  playerRecoveryCount++;
  if (notify) showAppNotice('좁은 틈에서 가까운 안전 지점으로 이동했어요.');
  return true;
}

function tryMovePlayerOnSurface(travel, step) {
  const tangent = travel.clone()
    .sub(playerDir.clone().multiplyScalar(travel.dot(playerDir)));
  if (tangent.lengthSq() < 1e-10) return false;
  tangent.normalize();

  const direct = surfaceStepDirection(playerDir, tangent, step);
  if (playerSurfaceAllowed(direct) && hasSurfaceClearance(direct, PLAYER_CLEARANCE_RADIUS)) {
    commitPlayerSurfaceDirection(direct);
    return true;
  }

  // Remove the component pointing into each nearby obstacle. A slight outward
  // bias keeps the spherical step from cutting back through a curved collider.
  const blockers = getSurfaceColliders().filter((collider) => (
    direct.angleTo(collider.dir) < collider.radius + PLAYER_CLEARANCE_RADIUS + step
  ));
  const slide = tangent.clone();
  for (const blocker of blockers) {
    const toward = blocker.dir.clone()
      .sub(playerDir.clone().multiplyScalar(playerDir.dot(blocker.dir)));
    if (toward.lengthSq() < 1e-10) continue;
    toward.normalize();
    const inward = slide.dot(toward);
    if (inward > 0) slide.addScaledVector(toward, -inward - 0.16);
  }

  const side = new THREE.Vector3().crossVectors(playerDir, tangent).normalize();
  const directions = [];
  if (slide.lengthSq() > 1e-5) directions.push(slide.normalize());
  for (const angle of [0.48, -0.48, 0.82, -0.82]) {
    directions.push(tangent.clone().multiplyScalar(Math.cos(angle))
      .add(side.clone().multiplyScalar(Math.sin(angle))).normalize());
  }
  for (const direction of directions) {
    for (const scale of [1, 0.62, 0.34]) {
      const candidate = surfaceStepDirection(playerDir, direction, step * scale);
      if (!playerSurfaceAllowed(candidate)
        || !hasSurfaceClearance(candidate, PLAYER_CLEARANCE_RADIUS)) continue;
      commitPlayerSurfaceDirection(candidate);
      return true;
    }
  }
  return false;
}

// jump state — vertical hop above the surface (height in world units along `up`)
let jumpVel = 0, jumpHeight = 0, onGround = true;
const JUMP_SPEED = 4.0, GRAVITY = 12.0;

// (The old parcel-delivery minigame was removed — the planet is now the
// Hermes agent dashboard. Walking, agents, weather, and editing all remain.)

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = {};
document.addEventListener('village-board-open', () => {
  for (const key of Object.keys(keys)) delete keys[key];
  jumpRequested = false;
});
document.addEventListener('rose-story-open', () => {
  for (const key of Object.keys(keys)) delete keys[key];
  stickVec.x = stickVec.y = 0;
  jumpRequested = false;
});
const MOVEMENT_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
let jumpRequested = false;
addEventListener('keydown', e => {
  if (villageBoard.isOpen() || roseStory.isOpen()) return;
  const key = e.key.toLowerCase();
  const movementKey = MOVEMENT_KEYS.has(key);
  const quickAgentIndex = Number(key) - 1;
  const typingTarget = e.target instanceof Element
    && e.target.matches('input, textarea, select, [contenteditable=\"true\"]');
  if (
    Number.isInteger(quickAgentIndex)
    && quickAgentIndex >= 0
    && quickAgentIndex < AGENTS.length
    && !typingTarget
    && !editMode
    && !intro.isConnected
  ) {
    e.preventDefault();
    dashboardOpenAgentByIndex(quickAgentIndex);
    return;
  }
  if (isUiInteractionTarget(e.target)) {
    if (key === 'escape') dashboardStopPatrol();
    return;
  }
  if (key === 'r' && !editMode && experienceMode === 'explore') {
    e.preventDefault();
    recoverPlayerToSafeSurface({ notify: true, force: true });
    return;
  }
  if (cameraIntro) skipCameraIntro();
  if (movementKey || key === 'escape') {
    dashboardStopPatrol();
  }
  if (movementKey && key.startsWith('arrow')) e.preventDefault();
  // The overview is the default landing mode, but movement should never feel
  // disabled. The first WASD/arrow input hands control to exploration while
  // preserving the same key press, so W+Right and Up+A combinations work too.
  if (movementKey && !editMode && experienceMode === 'dashboard' && !intro.isConnected) {
    setExperienceMode('explore');
  }
  if (e.key === ' ') e.preventDefault();   // stop spacebar from scrolling the page
  if ((e.key === ' ' || e.key === 'Spacebar') && !e.repeat) jumpRequested = true;
  if (!(editMode && (e.ctrlKey || e.metaKey))) keys[key] = true;
});
addEventListener('keyup',   e => keys[e.key.toLowerCase()] = false);

// camera focus: while an agent card is open the camera tracks that agent.
// Cleared when the card closes, on movement input, or entering edit mode.
// focusSide is the viewing direction, captured ONCE when focus starts so the
// camera doesn't swing around as the agent's home-relative direction changes.
let focusNpc = null;
let focusSide = null;
let dashboardCloseCard = () => {};   // assigned by the dashboard wiring below
let dashboardCloseTeam = () => {};   // assigned by the team-overview wiring below
let dashboardUpdatePatrol = () => {}; // optional read-only monitoring tour
let dashboardStopPatrol = () => {};
let dashboardPatrolState = () => ({ enabled: false });
let dashboardOpenAgentByIndex = () => {};
let openServicePanel = () => {};        // assigned by the service-panel wiring below
let closeServicePanel = () => {};       // "
let refreshOpenServicePanel = () => {};
let activateNearbyService = () => false;
let updateServiceProximity = () => {};  // stepped by the main loop (집 문 앞 감지)

const FOCUS_NON_OCCLUDERS = new Set(['road', 'trail', 'river', 'pond', 'sand', 'grass', 'snow']);
const _focusRaycaster = new THREE.Raycaster();
const _focusRayDirection = new THREE.Vector3();
const _focusLookTarget = new THREE.Vector3();
const _focusTransitLookTarget = new THREE.Vector3();
const _focusHomePosition = new THREE.Vector3();
const _focusCameraDir = new THREE.Vector3();
const _focusTargetDir = new THREE.Vector3();
const _focusArcRotation = new THREE.Quaternion();
const _focusArcStep = new THREE.Quaternion();
let cameraTransitionMinClearance = Infinity;
let trackCameraTransition = false;

function moveCameraAroundPlanet(target, alpha) {
  const currentRadius = camera.position.length();
  const targetRadius = target.length();
  _focusCameraDir.copy(camera.position).normalize();
  _focusTargetDir.copy(target).normalize();
  _focusArcRotation.setFromUnitVectors(_focusCameraDir, _focusTargetDir);
  _focusArcStep.identity().slerp(_focusArcRotation, alpha);
  _focusCameraDir.applyQuaternion(_focusArcStep).normalize();
  camera.position.copy(_focusCameraDir.multiplyScalar(
    THREE.MathUtils.lerp(currentRadius, targetRadius, alpha),
  ));
  if (trackCameraTransition) {
    cameraTransitionMinClearance = Math.min(
      cameraTransitionMinClearance,
      camera.position.length() - R,
    );
  }
}

function chooseAgentFocusSide(npc) {
  const up = npc.userData.dir.clone().normalize();
  const home = npc.userData.agent?.home;
  const base = home?.dir
    ? npc.userData.dir.clone().sub(home.dir)
    : camera.position.clone().sub(npc.position);
  base.sub(up.clone().multiplyScalar(base.dot(up)));
  if (base.lengthSq() < 1e-5) base.copy(tangentBasis(up).north);
  base.normalize();

  const occluders = editables
    .filter((item) => !item.isPath && !FOCUS_NON_OCCLUDERS.has(item.data.type) && item.mesh?.visible)
    .map((item) => item.mesh);
  const lookAt = npc.position.clone().add(up.clone().multiplyScalar(0.82));
  const frontage = home?.dir ? propFacing(home.dir, home.data.yaw || 0) : base;
  const angles = [0, 0.34, -0.34, 0.68, -0.68, 1.05, -1.05, 1.57, -1.57, Math.PI];
  let best = base.clone();
  let bestScore = -Infinity;

  for (const angle of angles) {
    const side = base.clone().applyAxisAngle(up, angle).normalize();
    const candidate = npc.position.clone()
      .add(side.clone().multiplyScalar(6.4))
      .add(up.clone().multiplyScalar(3.05));
    _focusRayDirection.copy(lookAt).sub(candidate);
    const distance = _focusRayDirection.length();
    _focusRayDirection.multiplyScalar(1 / Math.max(distance, 0.001));
    _focusRaycaster.set(candidate, _focusRayDirection);
    _focusRaycaster.near = 0.1;
    _focusRaycaster.far = Math.max(0.1, distance - 0.35);
    const blocked = occluders.length > 0
      && _focusRaycaster.intersectObjects(occluders, true).length > 0;
    const score = base.dot(side) + frontage.dot(side) * 1.6 - Math.abs(angle) * 0.08 - (blocked ? 10 : 0);
    if (score > bestScore) {
      bestScore = score;
      best.copy(side);
    }
  }
  return best;
}

// mouse drag to orbit the camera around the player (rotates the camDir anchor)
let dragging = false, camPitch = 0.68, lastX = 0, lastY = 0;
let dashboardYaw = 0;
const dashboardOrbitAxis = new THREE.Vector3(0, 1, 0);
let cameraIntro = null;
renderer.domElement.addEventListener('pointerdown', e => {
  if (editMode) return;
  if (cameraIntro) skipCameraIntro();
  dashboardStopPatrol();
  dragging = true; lastX = e.clientX; lastY = e.clientY;
});
addEventListener('pointerup', () => dragging = false);
addEventListener('pointermove', e => {
  if (editMode || !dragging) return;
  const yawDelta = -(e.clientX - lastX) * 0.005;
  if (experienceMode === 'dashboard') {
    dashboardYaw = wrappedAngle(dashboardYaw + yawDelta);
  } else {
    camDir.applyAxisAngle(playerDir.clone().normalize(), yawDelta);
    keepTangentAtPlayer(camDir);
  }
  camPitch += (e.clientY - lastY) * 0.005;
  camPitch = Math.max(0.05, Math.min(1.2, camPitch));
  lastX = e.clientX; lastY = e.clientY;
});

// ---- zoom: mouse wheel + two-finger pinch ----
const ZOOM_MIN = 4, ZOOM_MAX = 48;
const DESKTOP_CINEMATIC_CAM_DIST = 26;
const DASHBOARD_CAM_DIST = 21.5;
const MOBILE_DASHBOARD_CAM_DIST = 44.0;
const MOBILE_INTRO_CAM_DIST = 46.0;
const EXPLORE_CAM_DIST = 4.3;
const MOBILE_EXPLORE_CAM_DIST = 5.2;
const DASHBOARD_CAM_PITCH = 1.00;
const EXPLORE_CAM_PITCH = 0.34;
const MOBILE_EXPLORE_CAM_PITCH = 0.44;
let camDist = DASHBOARD_CAM_DIST;
let experienceMode = 'dashboard';

function dashboardCameraDistance() {
  if (innerWidth <= 520) return MOBILE_DASHBOARD_CAM_DIST;
  const aspect = innerWidth / Math.max(1, innerHeight);
  return Math.min(MOBILE_DASHBOARD_CAM_DIST,
    DASHBOARD_CAM_DIST * Math.max(1, 1.1 / aspect));
}

function introCameraDistance() {
  return innerWidth <= 520 ? MOBILE_INTRO_CAM_DIST : dashboardCameraDistance();
}

function exploreCameraDistance() {
  return innerWidth <= 520 ? MOBILE_EXPLORE_CAM_DIST : EXPLORE_CAM_DIST;
}

function exploreCameraPitch() {
  return innerWidth <= 520 ? MOBILE_EXPLORE_CAM_PITCH : EXPLORE_CAM_PITCH;
}

function dashboardLookHeight() {
  if (innerWidth <= 520) return 2.5;
  return innerWidth / Math.max(1, innerHeight) > 1.5 ? 5.2 : 3.9;
}

function snapFollowCamera() {
  const dashboard = experienceMode === 'dashboard';
  const up = dashboard ? DASHBOARD_VIEW_DIR.clone().applyAxisAngle(dashboardOrbitAxis, dashboardYaw)
    : playerDir.clone().normalize();
  const back = (dashboard ? DASHBOARD_VIEW_FORWARD.clone().applyAxisAngle(dashboardOrbitAxis, dashboardYaw)
    : camDir.clone()).multiplyScalar(-1);
  const camOffset = up.clone().multiplyScalar(Math.sin(camPitch) * camDist)
    .add(back.multiplyScalar(Math.cos(camPitch) * camDist));
  camera.position.copy(dashboard ? camOffset : player.position.clone().add(camOffset));
  camera.up.copy(up);
  camera.lookAt(dashboard
    ? up.clone().multiplyScalar(dashboardLookHeight())
    : player.position.clone().add(up.multiplyScalar(0.8)));
}

function startCameraIntro() {
  cameraIntro = {
    startedAt: performance.now(),
    duration: 2500,
    fromDist: innerWidth <= 520 ? MOBILE_INTRO_CAM_DIST : DESKTOP_CINEMATIC_CAM_DIST,
    toDist: experienceMode === 'dashboard' ? dashboardCameraDistance() : exploreCameraDistance(),
    fromPitch: 0.9,
    toPitch: experienceMode === 'dashboard' ? DASHBOARD_CAM_PITCH : exploreCameraPitch(),
  };
  camDist = cameraIntro.fromDist;
  camPitch = cameraIntro.fromPitch;
  snapFollowCamera();
}

function skipCameraIntro() {
  if (!cameraIntro) return;
  camDist = cameraIntro.toDist;
  camPitch = cameraIntro.toPitch;
  cameraIntro = null;
  snapFollowCamera();
}

function stepCameraIntro(now) {
  if (!cameraIntro) return;
  const t = THREE.MathUtils.clamp((now - cameraIntro.startedAt) / cameraIntro.duration, 0, 1);
  const eased = 1 - Math.pow(1 - t, 3);
  camDist = THREE.MathUtils.lerp(cameraIntro.fromDist, cameraIntro.toDist, eased);
  camPitch = THREE.MathUtils.lerp(cameraIntro.fromPitch, cameraIntro.toPitch, eased);
  if (t >= 1) cameraIntro = null;
}

// The initiating intro click happens before cameraIntro exists. Any later
// pointer/wheel input skips the cinematic immediately.
addEventListener('pointerdown', () => { if (cameraIntro) skipCameraIntro(); }, { capture: true });
addEventListener('wheel', e => {
  if (!cameraIntro) return;
  skipCameraIntro();
  e.preventDefault();
  e.stopPropagation();
}, { capture: true, passive: false });

function setExperienceMode(mode) {
  dashboardCloseTeam();
  experienceMode = mode === 'explore' ? 'explore' : 'dashboard';
  if (experienceMode === 'explore') dashboardStopPatrol();
  if (experienceMode === 'explore') markVisitorStep('explore');
  player.visible = experienceMode === 'explore';
  if (player.userData.nameLabel) player.userData.nameLabel.enabled = experienceMode === 'explore';
  document.body.classList.toggle('dashboard-mode', experienceMode === 'dashboard');
  document.body.classList.toggle('explore-mode', experienceMode === 'explore');
  const dashboardBtn = document.getElementById('dashboardModeBtn');
  const exploreBtn = document.getElementById('exploreModeSwitchBtn');
  const introExploreBtn = document.getElementById('exploreModeBtn');
  for (const [button, active] of [
    [dashboardBtn, experienceMode === 'dashboard'],
    [exploreBtn, experienceMode === 'explore'],
    [introExploreBtn, experienceMode === 'explore'],
  ]) {
    if (!button) continue;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  camDist = experienceMode === 'dashboard' ? dashboardCameraDistance() : exploreCameraDistance();
  camPitch = experienceMode === 'dashboard' ? DASHBOARD_CAM_PITCH : exploreCameraPitch();
  if (experienceMode === 'dashboard') {
    stickVec.x = stickVec.y = 0;
    jumpRequested = false;
  }
}

function applyZoom(delta) {
  dashboardStopPatrol();
  camDist = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, camDist + delta));
}
renderer.domElement.addEventListener('wheel', e => {
  e.preventDefault();
  if (editMode) return;
  if (cameraIntro) { skipCameraIntro(); return; }
  applyZoom(e.deltaY * 0.012);
}, { passive: false });

// pinch-to-zoom on touch devices
const pinch = { active: false, startDist: 0, startCam: exploreCameraDistance() };
const touchPts = new Map();
renderer.domElement.addEventListener('pointerdown', e => {
  if (e.pointerType === 'touch') touchPts.set(e.pointerId, e);
});
renderer.domElement.addEventListener('pointermove', e => {
  if (e.pointerType !== 'touch') return;
  if (touchPts.has(e.pointerId)) touchPts.set(e.pointerId, e);
  if (touchPts.size === 2) {
    dragging = false;                              // pinch overrides drag-orbit
    const [a, b] = [...touchPts.values()];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!pinch.active) { pinch.active = true; pinch.startDist = d; pinch.startCam = camDist; }
    else { camDist = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinch.startCam - (d - pinch.startDist) * 0.03)); }
  }
});
function clearTouch(e) { touchPts.delete(e.pointerId); if (touchPts.size < 2) pinch.active = false; }
addEventListener('pointerup', clearTouch);
addEventListener('pointercancel', clearTouch);

// mobile virtual joystick
let stickVec = { x: 0, y: 0 };
addEventListener('blur', () => {
  for (const key of Object.keys(keys)) keys[key] = false;
  jumpRequested = false;
  stickVec.x = stickVec.y = 0;
});
(function joystick() {
  const stick = document.getElementById('stick'), knob = document.getElementById('knob');
  let active = false, cx = 0, cy = 0;
  const radius = 44;
  stick.addEventListener('pointerdown', e => {
    active = true; const r = stick.getBoundingClientRect();
    cx = r.left + r.width/2; cy = r.top + r.height/2; stick.setPointerCapture(e.pointerId);
  });
  stick.addEventListener('pointermove', e => {
    if (!active) return;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const len = Math.hypot(dx, dy) || 1;
    const cl = Math.min(len, radius);
    dx = dx/len*cl; dy = dy/len*cl;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    stickVec.x = dx/radius; stickVec.y = dy/radius;
  });
  const end = () => { active = false; stickVec.x = stickVec.y = 0; knob.style.transform = ''; };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);
})();

document.getElementById('mobileJumpBtn')?.addEventListener('click', () => {
  if (!editMode && experienceMode === 'explore') jumpRequested = true;
});
document.getElementById('mobileRecoverBtn')?.addEventListener('click', () => {
  if (!editMode && experienceMode === 'explore') {
    recoverPlayerToSafeSurface({ notify: true, force: true });
  }
});
document.getElementById('mobileInteractBtn')?.addEventListener('click', () => {
  activateNearbyService();
});

let gamepadSnapshot = readGamepadControls([]);
let gamepadJumpHeld = false;
let gamepadInteractHeld = false;
function pollGamepadInput(dt) {
  const next = readGamepadControls(
    typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [],
  );
  if (!next.connected) {
    gamepadJumpHeld = false;
    gamepadInteractHeld = false;
    gamepadSnapshot = next;
    return next;
  }
  if (villageBoard.isOpen() || roseStory.isOpen()) {
    gamepadJumpHeld = next.jump;
    gamepadInteractHeld = next.interact;
    gamepadSnapshot = next;
    return { ...next, forward: 0, turn: 0, lookX: 0, lookY: 0, jump: false, interact: false };
  }

  const moving = Math.abs(next.forward) > 0.01 || Math.abs(next.turn) > 0.01;
  if (moving && !editMode && experienceMode === 'dashboard' && !intro.isConnected) {
    setExperienceMode('explore');
  }
  if (next.jump && !gamepadJumpHeld && !editMode && experienceMode === 'explore') {
    jumpRequested = true;
  }
  if (next.interact && !gamepadInteractHeld) activateNearbyService();

  if (!editMode && experienceMode === 'explore') {
    if (Math.abs(next.lookX) > 0.01) {
      camDir.applyAxisAngle(playerDir.clone().normalize(), -next.lookX * dt * 1.8);
      keepTangentAtPlayer(camDir);
    }
    if (Math.abs(next.lookY) > 0.01) {
      camPitch = THREE.MathUtils.clamp(camPitch + next.lookY * dt * 1.35, 0.05, 1.2);
    }
  }

  gamepadJumpHeld = next.jump;
  gamepadInteractHeld = next.interact;
  gamepadSnapshot = next;
  return next;
}

// emoji popups use the same bloom-free DOM overlay as speech bubbles.
const emojiBubbles = [];
function popEmoji(ch) {
  const bubble = createWorldLabel(ch, {
    target: player,
    offset: new THREE.Vector3(0, (player.userData.labelHeight || 1.62) + 0.28, 0),
    direction: () => playerDir,
    bubble: true,
    emoji: true,
  });
  bubble.age = 0;
  emojiBubbles.push(bubble);
}
emojibarEl.addEventListener('click', e => {
  const b = e.target.closest('button'); if (b) popEmoji(b.dataset.e);
});

// ---------------------------------------------------------------------------
// Helpers for sphere-walking math
// ---------------------------------------------------------------------------
const _q = new THREE.Quaternion();
function tangentBasis(dir) {
  // build an orthonormal frame at `dir`: up = dir, plus two tangents
  const up = dir.clone().normalize();
  let ref = Math.abs(up.y) > 0.99 ? new THREE.Vector3(1,0,0) : new THREE.Vector3(0,1,0);
  const east = new THREE.Vector3().crossVectors(ref, up).normalize();
  const north = new THREE.Vector3().crossVectors(up, east).normalize();
  return { up, east, north };
}

function keepTangentAtPlayer(v) {
  v.sub(playerDir.clone().multiplyScalar(v.dot(playerDir)));
  if (v.lengthSq() < 1e-8) v.copy(tangentBasis(playerDir).north);
  v.normalize();
}
function keepPlayerForwardTangent() {
  keepTangentAtPlayer(playerForward);
  keepTangentAtPlayer(camDir);
}

// ---------------------------------------------------------------------------
// NPC update — smooth steering + separation. Pulled out as a function so it can
// be stepped deterministically (the live loop just calls updateNPCs(dt)).
//   Each NPC keeps a `heading` (actual facing) and `desiredHeading` (goal).
//   It turns toward the goal at a limited rate, walks along its true facing, and
//   biases the goal away from close neighbors — facing and travel always agree.
// ---------------------------------------------------------------------------
// fade a speech bubble in/out over its remaining life, dropping it at 0
// (shared by the wander loop and the "standing still, card open" branch)
function stepBubble(ud, dt) {
  if (!ud.bubble) return;
  ud.bubble.life -= dt;
  const t = ud.bubble.life;
  const maxLife = ud.bubble.maxLife || 2.6;
  ud.bubble.alpha = Math.max(0, Math.min(1, t))
    * Math.max(0, Math.min(1, (maxLife - t) * 3));
  if (t <= 0) { removeWorldLabel(ud.bubble); ud.bubble = null; }
}

function chooseNpcAvoidanceHeading(dir, basis, heading) {
  const probeStep = 0.085;                        // look roughly 0.6 world units ahead
  const offsets = [
    Math.PI / 6, -Math.PI / 6,
    Math.PI / 3, -Math.PI / 3,
    Math.PI / 2, -Math.PI / 2,
    Math.PI * 0.75, -Math.PI * 0.75,
    Math.PI,
  ];
  let bestHeading = heading + Math.PI;
  let bestScore = -Infinity;

  for (const offset of offsets) {
    const candidateHeading = heading + offset;
    const travel = basis.north.clone().multiplyScalar(Math.cos(candidateHeading))
      .add(basis.east.clone().multiplyScalar(Math.sin(candidateHeading))).normalize();
    const axis = new THREE.Vector3().crossVectors(dir, travel).normalize();
    _q.setFromAxisAngle(axis, probeStep);
    const probe = dir.clone().applyQuaternion(_q).normalize();
    const clearance = surfaceColliderClearance(probe);
    const solidScore = Number.isFinite(clearance) ? clearance : 1;
    const waterPenalty = isInWaterDir(probe) ? 2 : 0;
    // Prefer the widest clear route; use the smaller turn only as a tiebreaker.
    const score = solidScore - waterPenalty - Math.abs(offset) * 0.002;
    if (score > bestScore) {
      bestScore = score;
      bestHeading = candidateHeading;
    }
  }
  return bestHeading;
}

const NPC_MIN_SEP = 2.2;   // start steering away from neighbors within this range
const NPC_HARD_SEP = 1.1;  // never allowed closer than this (hard clamp)
const NPC_TURN_RATE = 2.4; // max radians/sec a body can rotate
let npcTime = 0;           // accumulated sim time (for deterministic walk-bob)
function updateNPCs(dt) {
  npcTime += dt;
  for (const c of npcs) {
    const ud = c.userData;

    // Dynamic separation or an edited prop can overlap an NPC with a pole.
    // Put it back in valid space before making the next steering decision.
    if (isBlockedSurfaceDir(ud.dir)) {
      const depenetrated = resolveSurfaceColliderPenetration(ud.dir);
      if (ud.dir.angleTo(depenetrated) > 1e-7) {
        ud.dir.copy(depenetrated);
        ud.avoidTimer = 0;
        ud.stuckTime = 0;
      }
    }

    // while this agent's status card is open they stand still (being "talked
    // to") — idle pose facing the viewer, speech bubble fades out naturally.
    if (c === focusNpc) {
      ud.body.position.y = 0;
      animateCharacterWalk(c, 0, npcTime + ud.phase);
      updateCharacterContactShadow(c, 0, 0);
      updateAgentActivitySignal(c, dt, npcTime + ud.phase, 0);
      if (focusSide) {
        const nb = tangentBasis(ud.dir);
        const face = focusSide.clone().sub(nb.up.clone().multiplyScalar(focusSide.dot(nb.up)));
        if (face.lengthSq() > 1e-6) {
          face.normalize();
          c.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
            new THREE.Vector3().crossVectors(nb.up, face).normalize(), nb.up, face
          ));
        }
      }
      stepBubble(ud, dt);
      continue;
    }

    const b = tangentBasis(ud.dir);
    const working = isWorkingStatus(ud.agent?.status?.state);

    // Agents alternate between short walks and longer purposeful pauses. The
    // old perpetual wandering made the village feel like a game board; this
    // rhythm reads more like people quietly working near their own spaces.
    ud.activityTimer -= dt;
    if (ud.activityTimer <= 0) {
      ud.isResting = !ud.isResting;
      ud.activityTimer = ud.isResting
        ? (working ? 3.2 : 5.0) + Math.random() * (working ? 2.8 : 4.0)
        : 3.0 + Math.random() * 3.0;
    }
    const anchorDir = working && ud.agent?.workDir
      ? ud.agent.workDir
      : ud.agent?.home?.dir;
    const anchorDistance = anchorDir ? ud.dir.angleTo(anchorDir) : 0;
    if (anchorDistance > (working ? 0.12 : 0.38)) ud.isResting = false;

    // (1) occasionally choose a new wander goal — biased back toward the
    // agent's home cottage once it strays too far, so each resonator hangs
    // around their own house instead of roaming the whole planet.
    ud.turnTimer -= dt;
    if (ud.turnTimer <= 0) {
      const home = ud.agent?.home;
      const anchor = working && ud.agent?.workDir ? ud.agent.workDir : home?.dir;
      const roamLimit = working ? 0.28 : 0.38;
      if (anchor && ud.dir.dot(anchor) < Math.cos(working ? 0.12 : roamLimit)) {
        const t = anchor.clone().sub(ud.dir.clone().multiplyScalar(anchor.dot(ud.dir)));
        if (t.lengthSq() > 1e-8) {
          t.normalize();
          ud.desiredHeading = Math.atan2(t.dot(b.east), t.dot(b.north));
        }
      } else {
        ud.desiredHeading = ud.heading + (Math.random() - 0.5) * 1.6;
      }
      ud.turnTimer = 2.5 + Math.random() * 3.0;
    }

    // (2) separation steering: bias the goal heading away from close characters
    const myPos = ud.dir.clone().multiplyScalar(R);
    const away = new THREE.Vector3();
    let crowded = 0;
    for (const o of npcs) {
      if (o === c) continue;
      const oPos = o.userData.dir.clone().multiplyScalar(R);
      const d = myPos.distanceTo(oPos);
      if (d < NPC_MIN_SEP && d > 1e-4) {
        const t = myPos.clone().sub(oPos).normalize();
        t.sub(ud.dir.clone().multiplyScalar(t.dot(ud.dir)));   // project to tangent plane
        away.add(t.multiplyScalar((NPC_MIN_SEP - d) / NPC_MIN_SEP));
        crowded++;
      }
    }
    { // also keep clear of the player
      const oPos = playerDir.clone().multiplyScalar(R);
      const d = myPos.distanceTo(oPos);
      if (d < NPC_MIN_SEP && d > 1e-4) {
        const t = myPos.clone().sub(oPos).normalize();
        t.sub(ud.dir.clone().multiplyScalar(t.dot(ud.dir)));
        away.add(t.multiplyScalar((NPC_MIN_SEP - d) / NPC_MIN_SEP));
        crowded++;
      }
    }
    if (crowded > 0 && away.lengthSq() > 1e-6 && !(ud.avoidTimer > 0)) {
      const aN = away.dot(b.north), aE = away.dot(b.east);
      ud.desiredHeading = Math.atan2(aE, aN);
    }

    // (3) turn smoothly toward the desired heading (shortest angular path)
    let diff = ud.desiredHeading - ud.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));         // wrap to [-PI, PI]
    const maxTurn = NPC_TURN_RATE * dt;
    ud.heading += Math.max(-maxTurn, Math.min(maxTurn, diff));

    // (4) walk forward along the (now-updated) facing; ease speed while turning
    // hard. Buildings and water now block agents just like the player — but an
    // agent that somehow ends up inside a blocked zone may always walk out.
    const turnEase = 1 - Math.min(Math.abs(diff), 1) * 0.4;
    const resting = ud.isResting && !isBlockedSurfaceDir(ud.dir) && !isInWaterDir(ud.dir);
    const dirBefore = ud.dir.clone();                       // remember where we started this frame
    const newTravel = b.north.clone().multiplyScalar(Math.cos(ud.heading))
                        .add(b.east.clone().multiplyScalar(Math.sin(ud.heading))).normalize();
    const axis = new THREE.Vector3().crossVectors(ud.dir, newTravel).normalize();
    _q.setFromAxisAngle(axis, ud.speed * turnEase * dt * (resting ? 0 : 1));
    const nextDir = ud.dir.clone().applyQuaternion(_q).normalize();
    const curSolidBlocked = isBlockedSurfaceDir(ud.dir);
    const nextSolidBlocked = isBlockedSurfaceDir(nextDir);
    const curColliderDepth = curSolidBlocked ? surfaceColliderPenetration(ud.dir) : 0;
    const nextColliderDepth = nextSolidBlocked ? surfaceColliderPenetration(nextDir) : 0;
    const curInWater = isInWaterDir(ud.dir);
    const nextInWater = isInWaterDir(nextDir);
    const nextBlocked = nextColliderDepth > 0 || nextInWater;
    const escapingCollider = curColliderDepth > 0 && nextColliderDepth < curColliderDepth - 1e-6;
    // Preserve the old ability to walk out of water, but never at the cost of
    // entering another solid prop.
    const escapingWater = curInWater && nextColliderDepth === 0;
    if (!nextBlocked || escapingCollider || escapingWater) {
      ud.dir.copy(nextDir);
      ud.avoidTimer = 0;
    } else if (!(ud.avoidTimer > 0)) {
      // Pick the direction with the most actual clearance, not merely the first
      // passing sample. This is important where several poles overlap.
      ud.desiredHeading = chooseNpcAvoidanceHeading(ud.dir, b, ud.heading);
      ud.avoidTimer = 1.35;                            // hold this heading — no re-rolls
      ud.turnTimer = Math.max(ud.turnTimer, 1.5);      // and no wander-reroll mid-avoid
    }
    if (ud.avoidTimer > 0) ud.avoidTimer -= dt;

    // (5) hard non-overlap clamp: if still inside HARD_SEP of anyone, slide directly
    // apart along the surface. This is the guarantee that they can NEVER overlap.
    {
      const here = ud.dir.clone().multiplyScalar(R);
      const others = npcs.filter(o => o !== c).map(o => o.userData.dir).concat([playerDir]);
      for (const oDir of others) {
        const oPos = oDir.clone().multiplyScalar(R);
        const d = here.distanceTo(oPos);
        if (d < NPC_HARD_SEP && d > 1e-4) {
          const t = here.clone().sub(oPos).normalize();
          t.sub(ud.dir.clone().multiplyScalar(t.dot(ud.dir)));     // tangent
          if (t.lengthSq() > 1e-6) {
            const sAxis = new THREE.Vector3().crossVectors(ud.dir, t.normalize()).normalize();
            _q.setFromAxisAngle(sAxis, (NPC_HARD_SEP - d) / R);     // rotate to reach the gap
            ud.dir.applyQuaternion(_q).normalize();
            here.copy(ud.dir.clone().multiplyScalar(R));
          }
        }
      }
    }

    // Character separation above can itself push an NPC into a nearby post.
    // Resolve once more, then detect true lack of progress and choose a new gap.
    if (isBlockedSurfaceDir(ud.dir)) {
      const separatedSafe = resolveSurfaceColliderPenetration(ud.dir);
      if (ud.dir.angleTo(separatedSafe) > 1e-7) ud.dir.copy(separatedSafe);
    }
    const movedDistance = dirBefore.angleTo(ud.dir) * R;
    ud.stuckTime = resting ? 0 : (movedDistance < 0.002 ? (ud.stuckTime || 0) + dt : 0);
    if (ud.stuckTime > 1.25) {
      const escapeBasis = tangentBasis(ud.dir);
      ud.desiredHeading = chooseNpcAvoidanceHeading(ud.dir, escapeBasis, ud.heading);
      ud.avoidTimer = 1.5;
      ud.turnTimer = Math.max(ud.turnTimer, 1.6);
      ud.stuckTime = 0;
    }

    // (6) orient the body to its ACTUAL net displacement this frame, and sync `heading`
    // to it — so facing always matches travel (no backward-walking, no clamp jerk).
    const nb = tangentBasis(ud.dir);
    c.position.copy(ud.dir.clone().multiplyScalar(terrainRadius(ud.dir) + 0.05));
    let move = ud.dir.clone().sub(dirBefore);               // net surface motion
    move.sub(nb.up.clone().multiplyScalar(move.dot(nb.up))); // tangent component
    let face;
    if (move.lengthSq() > 1e-8) {
      face = move.normalize();
      ud.heading = Math.atan2(face.dot(nb.east), face.dot(nb.north));  // keep heading in sync
    } else {
      face = nb.north.clone().multiplyScalar(Math.cos(ud.heading))
               .add(nb.east.clone().multiplyScalar(Math.sin(ud.heading))).normalize();
    }
    c.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3().crossVectors(nb.up, face).normalize(), nb.up, face
    ));

    // gentle walk-bob, paced by sim time
    const move01 = resting ? 0 : turnEase;
    ud.body.position.y = Math.abs(Math.sin(npcTime * 8 + ud.phase)) * 0.045 * move01;
    animateCharacterWalk(c, move01, npcTime + ud.phase);
    updateCharacterContactShadow(c, 0, move01);
    updateAgentActivitySignal(c, dt, npcTime + ud.phase, move01);

    // ---- speech bubbles: pop a random line now and then ----
    ud.bubbleTimer -= dt;
    if (ud.bubbleTimer <= 0) {
      // One speaker at a time keeps the planet readable and gives each line a
      // small cinematic beat instead of producing a wall of chat bubbles.
      const anotherSpeaker = npcs.some(o => o !== c && o.userData.bubble);
      if (anotherSpeaker) {
        ud.bubbleTimer = 2 + Math.random() * 3;
        stepBubble(ud, dt);
        continue;
      }
      if (ud.bubble) { removeWorldLabel(ud.bubble); ud.bubble = null; }
      // Active agents usually report the real task; idle chatter stays rare.
      const taskChance = working ? 0.72 : 0.16;
      const line = (ud.agent?.status?.task && Math.random() < taskChance)
        ? `${ud.agent.status.task} 중…`
        : ud.lines[(Math.random() * ud.lines.length) | 0];
      const bub = createWorldLabel(line, {
        target: c,
        offset: new THREE.Vector3(0, (ud.labelHeight || 1.62) + 0.56, 0),
        direction: () => ud.dir,
        bubble: true,
      });
      bub.life = 3.0;
      bub.maxLife = 3.0;
      ud.bubble = bub;
      ud.bubbleTimer = working ? 5 + Math.random() * 6 : 9 + Math.random() * 10;
    }
    stepBubble(ud, dt);
  }
}

// Sparse ambient motion keeps the diorama alive even when every agent is
// idle. Wind and precipitation come from the same weather state as the sky;
// only soft harbor materials move, so paths and clickable buildings stay calm.
function updateAmbientScene(t, atmosphere = {}) {
  const wind = THREE.MathUtils.clamp(Number(atmosphere.wind) || 0, 0, 1);
  const precip = THREE.MathUtils.clamp(Number(atmosphere.precip) || 0, 0, 1);
  const day = THREE.MathUtils.clamp(Number(atmosphere.day) || 0, 0, 1);
  for (const item of editables) {
    const root = item.mesh;
    if (!root.visible) continue;
    const phase = root.userData.motionPhase || 0;
    const floatBody = root.userData.floatBody;
    if (floatBody) {
      const buoy = root.userData.motionKind === 'buoy';
      const bob = buoy
        ? 0.035 + precip * 0.026 + wind * 0.012
        : 0.026 + precip * 0.018 + wind * 0.010;
      floatBody.position.y = Math.sin(t * (buoy ? 1.42 : 1.05) + phase) * bob;
      floatBody.rotation.z = Math.sin(t * (buoy ? 1.16 : 0.78) + phase) * (bob * 0.72);
      floatBody.rotation.x = Math.sin(t * 0.69 + phase * 0.73) * (0.010 + wind * 0.018);
    }
    const pennant = root.userData.pennant;
    if (pennant) pennant.rotation.y = Math.sin(t * (1.7 + wind) + phase) * (0.06 + wind * 0.24);
    const awning = root.userData.awning;
    if (awning) awning.rotation.z = Math.sin(t * (1.0 + wind * 0.8) + phase) * (0.012 + wind * 0.035);
    const net = root.userData.net;
    const netBase = root.userData.netBasePositions;
    if (net && netBase) {
      const positions = net.geometry.attributes.position;
      const amplitude = 0.006 + wind * 0.050;
      for (let i = 0; i < positions.count; i++) {
        const x = netBase[i * 3];
        const y = netBase[i * 3 + 1];
        const reach = THREE.MathUtils.clamp((x + 0.42) / 0.84, 0, 1);
        positions.setZ(
          i,
          netBase[i * 3 + 2]
            + Math.sin(t * (1.15 + wind) + x * 6 + y * 3 + phase)
              * amplitude * (0.35 + reach * 0.65),
        );
      }
      positions.needsUpdate = true;
    }
    const sway = root.userData.swayGroup;
    if (sway) sway.rotation.z = Math.sin(t * (0.58 + wind * 0.45) + phase) * (0.010 + wind * 0.034);
    const beacon = root.userData.opsBeacon;
    if (beacon) {
      const pulse = 1 + Math.sin(t * 1.65 + phase) * 0.055;
      beacon.core.rotation.y = t * 0.42 + phase;
      beacon.core.scale.setScalar(pulse);
      beacon.orbitPivot.rotation.y = t * 0.32 + phase;
      beacon.orbitPivot.rotation.z = Math.sin(t * 0.24 + phase) * 0.18;
      beacon.nodes.forEach((node, index) => {
        node.mesh.position.y = 0.82 + Math.sin(t * 1.18 + phase + index * 0.72) * 0.018;
      });
    }
    const signature = root.userData.signatureMotion;
    if (signature?.pivot) {
      const activity = signature.active ? 1 : 0.42;
      const signatureTime = t + signature.phase;
      if (signature.kind === 'pulse') {
        signature.pivot.scale.setScalar(1 + Math.sin(signatureTime * 1.9) * 0.075 * activity);
      } else if (signature.kind === 'clock') {
        signature.pivot.rotation.z = -signatureTime * (0.28 + activity * 0.34);
      } else if (signature.kind === 'scan') {
        signature.pivot.rotation.z = Math.sin(signatureTime * (0.52 + activity * 0.48)) * 0.34;
      } else if (signature.kind === 'breathe') {
        signature.pivot.position.y = signature.baseY + Math.sin(signatureTime * 1.1) * 0.035 * activity;
      } else if (signature.kind === 'turn') {
        signature.pivot.rotation.z = signatureTime * (0.08 + activity * 0.12);
      } else if (signature.kind === 'observe') {
        signature.pivot.rotation.y = signatureTime * (0.10 + activity * 0.24);
      }
    }
  }
  for (const item of editablePaths) {
    const root = item.mesh;
    const phase = root.userData.motionPhase || 0;
    const waveMaterials = root.userData.waveMaterials;
    if (waveMaterials) {
      const waveRate = 0.48 + wind * 0.42 + precip * 0.24;
      const breath = 0.5 + Math.sin(t * waveRate + phase) * 0.5;
      waveMaterials[0].opacity = 0.07 + breath * (0.06 + wind * 0.035);
      waveMaterials[1].opacity = 0.35 + breath * (0.12 + wind * 0.08 + precip * 0.04);
    }
    for (const material of root.userData.seaMaterials || []) {
      material.emissiveIntensity = 0.105 + day * 0.025
        + Math.sin(t * (0.18 + wind * 0.08) + phase) * (0.012 + wind * 0.010);
    }
  }
  for (const marker of homeMarkers) {
    const cloth = marker.userData.cloth;
    if (!cloth) continue;
    const phase = marker.userData.motionPhase || 0;
    cloth.rotation.y = Math.sin(t * (1.15 + wind) + phase) * (0.045 + wind * 0.18);
    const base = marker.userData.clothBasePositions;
    const positions = cloth.geometry.attributes.position;
    if (base && positions) {
      for (let i = 0; i < positions.count; i++) {
        const x = base[i * 3];
        const reach = THREE.MathUtils.clamp((x + 0.28) / 0.56, 0, 1);
        positions.setZ(
          i,
          base[i * 3 + 2]
            + Math.sin(t * (1.7 + wind) + reach * 3.2 + phase) * wind * 0.052 * reach,
        );
      }
      positions.needsUpdate = true;
    }
  }
  const rosePulse = 0.5 + Math.sin(t * 1.35) * 0.5;
  poleRose.userData.roseHead.rotation.y = Math.sin(t * 0.38) * 0.12;
  poleRose.userData.glow.intensity = 0.32 + rosePulse * 0.18;
}

// Three.js frustum culling cannot know that the opaque planet hides the far
// hemisphere, so it would submit every cottage, prop, and character anyway.
// Keep a generous 16-degree horizon margin for tall silhouettes, then hide
// only groups that are safely behind the sphere. This becomes increasingly
// valuable as curated GLTF assets are added later.
const HORIZON_CULL_DOT = -0.28;
const _horizonCameraDir = new THREE.Vector3();
let horizonCulling = { visibleProps: 0, culledProps: 0, visibleAgents: 0, culledAgents: 0 };
function updateHorizonCulling() {
  _horizonCameraDir.copy(camera.position).normalize();
  let visibleProps = 0;
  let culledProps = 0;
  for (const item of editables) {
    const visible = item.dir.dot(_horizonCameraDir) > HORIZON_CULL_DOT;
    item.mesh.visible = visible;
    if (visible) visibleProps++;
    else culledProps++;
  }
  for (const driveway of drivewayGroup.children) {
    const direction = driveway.userData.surfaceDir;
    driveway.visible = !direction || direction.dot(_horizonCameraDir) > HORIZON_CULL_DOT;
  }
  let visibleAgents = 0;
  let culledAgents = 0;
  for (const npc of npcs) {
    const visible = npc.userData.dir.dot(_horizonCameraDir) > HORIZON_CULL_DOT;
    npc.visible = visible;
    if (visible) visibleAgents++;
    else culledAgents++;
  }
  poleRose.visible = NORTH_POLE.dot(_horizonCameraDir) > HORIZON_CULL_DOT;
  horizonCulling = { visibleProps, culledProps, visibleAgents, culledAgents };
}

// ===========================================================================
// EDIT MODE — click an object to select, drag it across the planet to move it,
// keys to rotate/scale/delete, a palette to add. Changes auto-save. While
// editing, the player/NPC gameplay is paused and the camera orbits the village.
// ===========================================================================
let editMode = false;
let selectedItem = null;
let editDragging = false;     // dragging the selected object across the surface
let camOrbiting = false;      // dragging empty space to orbit the edit camera
let lastPointer = { x: 0, y: 0 };
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

// edit-camera orbit state — the target is switchable (마을 / 북극 presets)
let editTargetDir = MAP_CENTER.clone();
let editYaw = 0, editPitch = 0.85, editDist = 16;
function setEditCameraTarget(dir) {
  editTargetDir = dir.clone().normalize();
  editYaw = 0;
}

// a soft ring placed under the selected object as a highlight
const selectRing = (() => {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.85, 28),
    new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.visible = false;
  ring.renderOrder = 5;
  scene.add(ring);
  return ring;
})();

function setPointerNDC(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

// raycast against all editable meshes (props + paths); returns the topmost item.
// Props are checked first so a house on a road still selects the house.
function pickEditable() {
  raycaster.setFromCamera(pointerNDC, camera);
  const all = editables.concat(editablePaths);
  const hits = raycaster.intersectObjects(all.map(it => it.mesh), true);
  if (!hits.length) return null;
  // walk up from the hit object to find which editable group owns it
  let obj = hits[0].object;
  while (obj && !all.some(it => it.mesh === obj)) obj = obj.parent;
  return all.find(it => it.mesh === obj) || null;
}

// raycast against the planet sphere; returns the surface direction hit, or null
const _planetSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), R);
function pickSurfaceDir() {
  raycaster.setFromCamera(pointerNDC, camera);
  const pt = raycaster.ray.intersectSphere(_planetSphere, new THREE.Vector3());
  return pt ? pt.normalize() : null;
}

function highlightSelected() {
  if (!selectedItem) { selectRing.visible = false; return; }
  // for a path, ring sits at its middle point; for a prop, at its position
  let dir, s;
  if (selectedItem.isPath) {
    const dirs = selectedItem.data.dirs;
    dir = dirs[Math.floor(dirs.length / 2)].clone().normalize();
    s = 1.4;
  } else {
    dir = selectedItem.dir.clone().normalize();
    s = 0.7 + (selectedItem.data.scale ?? 1) * 0.7;
  }
  selectRing.position.copy(dir.clone().multiplyScalar(terrainRadius(dir) + 0.12));
  selectRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  selectRing.scale.setScalar(s);
  selectRing.visible = true;
}

function selectItem(item) {
  selectedItem = item;
  highlightSelected();
  if (typeof onSelectionChanged === 'function') onSelectionChanged(item);
}

// move the selected item to a new surface direction — anywhere on the planet
function moveSelectedTo(dir) {
  if (!selectedItem || selectedItem.isPath) return;
  selectedItem.data.dir.copy(dir).normalize();
  applyPropTransform(selectedItem);
  refreshPropCollider(selectedItem);
  if (HOME_PROP_TYPES.has(selectedItem.data.type) || PUBLIC_SPACE_TYPES.has(selectedItem.data.type)) rebuildDrivewaysThrottled();
  highlightSelected();
}

function rotateSelected(delta) {
  // paths have no yaw/scale — only props (the UI hides these buttons for paths,
  // but the keyboard shortcuts must be guarded too or they crash on PROP_DEFS)
  if (!selectedItem || selectedItem.isPath) return;
  if (!PROP_DEFS[selectedItem.data.type]?.editableParams?.includes('yaw')) return;
  selectedItem.data.yaw = ((selectedItem.data.yaw || 0) + delta) % (Math.PI * 2);
  applyPropTransform(selectedItem);
  refreshPropCollider(selectedItem);
  syncCottageExtras(selectedItem.data.type);
  saveLayout();
}

function scaleSelected(factor) {
  if (!selectedItem || selectedItem.isPath) return;
  if (!PROP_DEFS[selectedItem.data.type]?.editableParams?.includes('scale')) return;
  const next = Math.max(0.4, Math.min(2.2, (selectedItem.data.scale ?? 1) * factor));
  selectedItem.data.scale = next;
  // rebuild the mesh so factory-baked scale (trees etc.) recomputes cleanly
  const data = { ...selectedItem.data, dir: selectedItem.data.dir.clone() };
  removeProp(selectedItem);
  const item = spawnProp(data);
  syncCottageExtras(item.data.type);
  selectItem(item);
  saveLayout();
}

function deleteSelected() {
  if (!selectedItem) return;
  const wasType = selectedItem.data.type;
  if (selectedItem.isPath) removeEditorPath(selectedItem);
  else removeProp(selectedItem);
  selectedItem = null;
  selectRing.visible = false;
  syncCottageExtras(wasType);
  saveLayout();
  if (typeof onSelectionChanged === 'function') onSelectionChanged(null);
}

// apply a curated variant (colorway) to the selected prop and rebuild it
function applyVariantToSelected(variant) {
  if (!selectedItem || selectedItem.isPath) return;
  const data = { ...selectedItem.data, dir: selectedItem.data.dir.clone() };
  for (const [k, v] of Object.entries(variant)) {
    if (k !== 'name') data[k] = v;
  }
  removeProp(selectedItem);
  const item = spawnProp(data);
  syncCottageExtras(item.data.type);
  selectItem(item);
  saveLayout();
}

// nudge a surface direction sideways in its local tangent frame
function nudgeDir(dir, east = 0.15, north = 0.15) {
  const b = tangentBasis(dir);
  return dir.clone()
    .add(b.east.multiplyScalar(east))
    .add(b.north.multiplyScalar(north))
    .normalize();
}

// duplicate the selected prop or path, offset a little, and select the copy
function duplicateSelected() {
  if (!selectedItem) return;
  let item = null;
  if (selectedItem.isPath) {
    const dirs = selectedItem.data.dirs.map(d => nudgeDir(d, 0.15, 0.15));
    item = spawnEditorPath({ kind: 'path', type: selectedItem.data.type, dirs });
    if (item) syncCottageExtras(item.data.type);
  } else {
    const data = { ...selectedItem.data, dir: nudgeDir(selectedItem.data.dir, 0.15, 0.15) };
    if (HOME_PROP_TYPES.has(data.type)) delete data.ownerKey;
    item = spawnProp(data);
    syncCottageExtras(data.type);
  }
  if (item) {
    selectItem(item);
    saveLayout();
  }
}

// add a fresh prop of `type` where the edit camera is looking, and select it
function addProp(type) {
  const extras = {
    cottage: { wall: 0xffe3b0, roof: 0xd98a72, scale: 0.94 },
    field: { rx: 0.74, rz: 0.40, color: 0xaed28a },
    car: { color: 0xe7f0f2 },
  }[type] || {};
  const item = spawnProp({
    type,
    dir: nudgeDir(editTargetDir, 0.12, 0.05),
    yaw: 0, scale: 1, ...extras,
  });
  syncCottageExtras(type);
  selectItem(item);
  saveLayout();
  return item;
}

// ---------------------------------------------------------------------------
// Path drawing — click points on the ground to lay a road or river. A live
// preview line + dot markers follow each click; 완료 / double-click finalizes.
// ---------------------------------------------------------------------------
let drawingType = null;            // 'road' | 'river' while drawing, else null
let drawPoints = [];               // [[x,z], …] collected so far
let pendingDrawDir = null;         // surface dir under a pending click (drawing)
let drawPointerStart = null;       // pointer-down pos, to tell a click from a drag
const STRUCTURAL_PATH_TYPES = new Set([
  'island', 'sea', 'deck', 'market', 'breakwater', 'wave', 'camellia',
  'streetEdge', 'laneEdge', 'hedge', 'quayRail', 'courtyard',
]);
const drawPreview = new THREE.Group();
drawPreview.visible = false;
scene.add(drawPreview);

function clearDrawPreview() {
  for (const c of drawPreview.children.slice()) { drawPreview.remove(c); disposeObject(c); }
}

// rebuild the dashed preview (dot markers + a thin guide line) from drawPoints
function updateDrawPreview() {
  clearDrawPreview();
  if (!drawPoints.length) { drawPreview.visible = false; return; }
  drawPreview.visible = true;
  const markerMat = new THREE.MeshBasicMaterial({
    color: (drawingType === 'river' || drawingType === 'pond') ? 0x6fc7e8 : 0xffd24a,
  });
  for (const dotDir of drawPoints) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), markerMat);
    dot.position.copy(dotDir.clone().multiplyScalar(terrainRadius(dotDir) + 0.14));
    drawPreview.add(dot);
  }
  if (drawPoints.length >= 2) {
    // closed shapes (pond/sand) preview with the loop back to the first point
    const closed = PATH_DEFS[drawingType]?.closed && drawPoints.length >= 3;
    const ghostPts = closed ? [...drawPoints, drawPoints[0]] : drawPoints;
    const wet = drawingType === 'river' || drawingType === 'pond';
    const ghost = makeCountryRoad(ghostPts, {
      width: wet ? 1.2 : 0.85,
      lift: 0.12,
      material: new THREE.MeshBasicMaterial({
        color: wet ? 0x8fd6f0 : 0xbfc6cc,
        transparent: true, opacity: 0.55, depthWrite: false,
      }),
    });
    drawPreview.add(ghost);
  }
}

function startDrawing(type) {
  selectItem(null);
  if (STRUCTURAL_PATH_TYPES.has(type)) backupCurrentLayout('before-world-structure');
  drawingType = type;
  drawPoints = [];
  updateDrawPreview();
  if (typeof onDrawModeChanged === 'function') onDrawModeChanged(type);
  if (typeof onDrawPointsChanged === 'function') onDrawPointsChanged(0);
}

function addDrawPoint(dir) {
  if (!drawingType) return;
  drawPoints.push(dir.clone().normalize());   // anywhere on the planet
  updateDrawPreview();
  if (typeof onDrawPointsChanged === 'function') onDrawPointsChanged(drawPoints.length);
}

function undoDrawPoint() {
  if (!drawingType || !drawPoints.length) return;
  drawPoints.pop();
  updateDrawPreview();
  if (typeof onDrawPointsChanged === 'function') onDrawPointsChanged(drawPoints.length);
}

// finalize the current drawing into a real editable path (needs ≥2 points)
function finishDrawing() {
  const type = drawingType, dirs = drawPoints;
  cancelDrawing();
  if (!type || dirs.length < (PATH_DEFS[type]?.minPoints || 2)) return null;
  const item = spawnEditorPath({ kind: 'path', type, dirs });
  syncCottageExtras(type);
  saveLayout();
  return item;
}

function cancelDrawing() {
  drawingType = null;
  drawPoints = [];
  clearDrawPreview();
  drawPreview.visible = false;
  if (typeof onDrawModeChanged === 'function') onDrawModeChanged(null);
}

// position the orbit camera for edit mode
function updateEditCamera(dt) {
  const up = editTargetDir.clone().normalize();
  const basis = tangentBasis(up);
  // offset built from yaw (around up) + pitch (tilt toward up)
  const horiz = basis.east.clone().multiplyScalar(Math.sin(editYaw))
    .add(basis.north.clone().multiplyScalar(Math.cos(editYaw)));
  const offset = horiz.multiplyScalar(Math.cos(editPitch) * editDist)
    .add(up.clone().multiplyScalar(Math.sin(editPitch) * editDist));
  const target = up.clone().multiplyScalar(R);
  camera.position.lerp(target.clone().add(offset), 1 - Math.pow(0.0001, dt));
  camera.up.copy(up);
  camera.lookAt(target);
}

// pointer handlers — only active while editing. Registered once; they early-out
// when not in edit mode so they don't interfere with the play-mode controls.
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!editMode || e.pointerType === 'touch' && touchPts.size > 1) return;
  setPointerNDC(e);
  lastPointer = { x: e.clientX, y: e.clientY };

  // while drawing a path: a click drops a point on the ground (orbit needs a drag)
  if (drawingType) {
    pendingDrawDir = pickSurfaceDir();    // committed on pointerup if it wasn't a drag
    drawPointerStart = { x: e.clientX, y: e.clientY };
    return;
  }

  const hit = pickEditable();
  if (hit) {
    selectItem(hit);
    editDragging = true;
  } else {
    selectItem(null);
    camOrbiting = true;
  }
});
addEventListener('pointermove', (e) => {
  if (!editMode) return;
  // dragging while drawing → orbit the camera (and cancel the pending point)
  if (drawingType && drawPointerStart) {
    const moved = Math.hypot(e.clientX - drawPointerStart.x, e.clientY - drawPointerStart.y);
    if (moved > 6) {
      pendingDrawDir = null;   // it's a drag, not a click → don't drop a point
      editYaw   -= (e.clientX - lastPointer.x) * 0.006;
      editPitch += (e.clientY - lastPointer.y) * 0.006;
      editPitch = Math.max(0.25, Math.min(1.4, editPitch));
      lastPointer = { x: e.clientX, y: e.clientY };
    }
    return;
  }
  if (editDragging && selectedItem && !selectedItem.isPath) {
    setPointerNDC(e);
    const dir = pickSurfaceDir();
    if (dir) moveSelectedTo(dir);
  } else if (camOrbiting) {
    editYaw   -= (e.clientX - lastPointer.x) * 0.006;
    editPitch += (e.clientY - lastPointer.y) * 0.006;
    editPitch = Math.max(0.25, Math.min(1.4, editPitch));
    lastPointer = { x: e.clientX, y: e.clientY };
  }
});
function finishEditPointer(cancelled = false) {
  // commit a drawing point if the press was a click (not a drag)
  if (drawingType && drawPointerStart) {
    if (!cancelled && pendingDrawDir) addDrawPoint(pendingDrawDir);
    pendingDrawDir = null;
    drawPointerStart = null;
  }
  if (editDragging) {
    // the throttle may have skipped the last drag frames — settle driveways/flags
    if (selectedItem) syncCottageExtras(selectedItem.data.type);
    saveLayout();
  }
  editDragging = false;
  camOrbiting = false;
}
addEventListener('pointerup', () => finishEditPointer());
addEventListener('pointercancel', () => finishEditPointer(true));
addEventListener('blur', () => finishEditPointer(true));
// wheel zooms the edit camera (independent of the play-mode zoom)
renderer.domElement.addEventListener('wheel', (e) => {
  if (!editMode) return;
  editDist = Math.max(6, Math.min(40, editDist + e.deltaY * 0.02));
}, { passive: false });

// double-click finishes the current path drawing
renderer.domElement.addEventListener('dblclick', (e) => {
  if (!editMode || !drawingType) return;
  e.preventDefault();
  // dblclick fires after two pointerups, so the 2nd click already added a point;
  // just finalize what we have.
  finishDrawing();
});

// keyboard shortcuts for editing
addEventListener('keydown', (e) => {
  if (!editMode || isUiInteractionTarget(e.target)) return;
  const k = e.key.toLowerCase();
  // undo/redo work everywhere in edit mode (also cancels an in-progress drawing)
  if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault();
    if (e.shiftKey) redoLayout();
    else undoLayout();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redoLayout(); return; }
  // duplicate is Ctrl+D (plain D pans the camera right)
  if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
  // drawing-mode keys take priority
  if (drawingType) {
    if (k === 'enter') { e.preventDefault(); finishDrawing(); }
    else if (k === 'escape') cancelDrawing();
    else if (k === 'backspace' || k === 'delete') { e.preventDefault(); undoDrawPoint(); }
    return;
  }
  if (k === '[') rotateSelected(-Math.PI / 12);
  else if (k === ']') rotateSelected(Math.PI / 12);
  else if (k === '-' || k === '_') scaleSelected(1 / 1.12);
  else if (k === '=' || k === '+') scaleSelected(1.12);
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelected(); }
  else if (k === 'escape') { selectItem(null); }
});

// enter / leave edit mode (wired to UI buttons below)
function enterEditMode() {
  roseStory.close();
  cancelBoatModeToSafeSurface();
  editMode = true;
  dashboardStopPatrol();
  focusNpc = null;                 // release any agent-focus camera
  focusSide = null;
  trackCameraTransition = false;
  dashboardCloseCard();
  dashboardCloseTeam();
  closeServicePanel();
  closeVisitorPanels();
  for (const key of Object.keys(keys)) keys[key] = false;
  editTargetDir = MAP_CENTER.clone();
  editYaw = 0; editPitch = 0.85; editDist = 16;
  document.body.classList.add('editing');
  if (typeof onEditModeChanged === 'function') onEditModeChanged(true);
}
function exitEditMode() {
  editMode = false;
  selectItem(null);
  saveLayout();
  document.body.classList.remove('editing');
  if (typeof onEditModeChanged === 'function') onEditModeChanged(false);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let lastDevMetricsAt = -1;
let paperPixelSamples = 0;
function publishDevMetrics(elapsed) {
  if (!URL_PARAMS.has('dev') || elapsed - lastDevMetricsAt < 0.5) return;
  lastDevMetricsAt = elapsed;
  if (URL_PARAMS.has('qa') && elapsed > 2 && paperPixelSamples < 2) {
    const gl = renderer.getContext();
    const colors = new Set();
    const pixel = new Uint8Array(4);
    for (let y = 1; y < 8; y++) {
      for (let x = 1; x < 8; x++) {
        gl.readPixels(Math.floor(gl.drawingBufferWidth * x / 8),
          Math.floor(gl.drawingBufferHeight * y / 8), 1, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        colors.add(Array.from(pixel).join(','));
      }
    }
    document.documentElement.dataset.qaCanvas = JSON.stringify({
      width: gl.drawingBufferWidth, height: gl.drawingBufferHeight,
      uniqueColors: colors.size, sample: ++paperPixelSamples,
    });
  }
  document.documentElement.dataset.qaPerformance = JSON.stringify({
    ...performanceGovernor.state(),
    ...horizonCulling,
  });
  document.documentElement.dataset.qaRenderStability = JSON.stringify({
    sceneSamples: composer.renderTarget1.samples,
    bloomThreshold: bloom.threshold,
    boardMeshes: editables.filter((item) => item.data.type === 'resultBoard').length,
  });
  document.documentElement.dataset.qaEfficiency = JSON.stringify({
    loop: worldLoop.state(), labels: labelSizeCache.state(),
  });
  document.documentElement.dataset.qaAudio = JSON.stringify(ambientAudio.state());
  document.documentElement.dataset.qaSignatures = JSON.stringify(
    AGENTS.map((agent) => ({
      key: agent.key,
      id: agent.home?.mesh?.userData?.signatureSpec?.id || null,
    })),
  );
}
function animate(dt, elapsed, now) {
  performanceGovernor.sample(now);
  const gamepad = pollGamepadInput(dt);

  if (editMode) {
    // WASD/arrows pan the edit camera target ANYWHERE on the planet —
    // including the far side. Speed scales with zoom so it feels constant.
    {
      let px = 0, py = 0;
      if (keys['w'] || keys['arrowup'])    py += 1;
      if (keys['s'] || keys['arrowdown'])  py -= 1;
      if (keys['a'] || keys['arrowleft']) px -= 1;
      if (keys['d'] || keys['arrowright']) px += 1;
      if (px || py) {
        const up = editTargetDir.clone().normalize();
        const basis = tangentBasis(up);
        const horiz = basis.east.clone().multiplyScalar(Math.sin(editYaw))
          .add(basis.north.clone().multiplyScalar(Math.cos(editYaw)));   // target → camera
        const fwdDir = horiz.multiplyScalar(-1);                          // screen-forward
        const rightDir = new THREE.Vector3().crossVectors(fwdDir, up).normalize();
        const pan = fwdDir.multiplyScalar(py).add(rightDir.multiplyScalar(px));
        if (pan.lengthSq() > 1e-8) {
          pan.normalize();
          const axis = new THREE.Vector3().crossVectors(up, pan).normalize();
          _q.setFromAxisAngle(axis, (0.25 + editDist * 0.025) * dt);
          editTargetDir.applyQuaternion(_q).normalize();
        }
      }
    }
    updateEditCamera(dt);
    skySystem.updateEdit(dt, elapsed);    // keep weather and lighting alive while editing
    const editAtmosphere = skySystem.ambientState();
    updateHorizonCulling();
    updateAmbientScene(elapsed, editAtmosphere);
    ambientAudio.update({ elapsed, ...editAtmosphere });
    if (selectedItem) {
      // pulse the highlight ring so the selection is obvious
      selectRing.material.opacity = 0.6 + Math.abs(Math.sin(elapsed * 4)) * 0.4;
    }
    if (!webglContextLost) {
      performanceGovernor.beforeRender(dt);
      composer.render();
      publishDevMetrics(elapsed);
    }
    return;
  }

  // ---- movement input: W/S = forward/backstep along facing · A/D = turn ----
  let fwd = 0, turn = 0;
  if (experienceMode === 'explore' && !villageBoard.isOpen() && !roseStory.isOpen()) {
    if (keys['w'] || keys['arrowup'])    fwd += 1;
    if (keys['s'] || keys['arrowdown'])  fwd -= 1;
    if (keys['a'] || keys['arrowleft'])  turn += 1;
    if (keys['d'] || keys['arrowright']) turn -= 1;
    fwd  += -stickVec.y;
    turn += -stickVec.x;
    fwd  += gamepad.forward;
    turn += gamepad.turn;
  }
  const moveMag = Math.min(1, Math.abs(fwd));
  let playerMoved = false;

  // any movement input releases the agent-focus camera and closes overlays
  if (Math.abs(fwd) > 0.001 || Math.abs(turn) > 0.001) {
    dashboardStopPatrol();
    if (focusNpc) {
      focusNpc = null;
      focusSide = null;
      trackCameraTransition = false;
      dashboardCloseCard();
    }
    dashboardCloseTeam();
    closeServicePanel();   // cheap no-op when nothing is open
  }

  // ---- jump physics (vertical hop above the surface) ----
  if (experienceMode === 'explore' && !villageBoard.isOpen() && !roseStory.isOpen() && !activeBoatItem && jumpRequested && onGround) {
    jumpVel = JUMP_SPEED; onGround = false;
  }
  jumpRequested = false;
  if (!onGround) {
    jumpHeight += jumpVel * dt;
    jumpVel -= GRAVITY * dt;
    if (jumpHeight <= 0) { jumpHeight = 0; jumpVel = 0; onGround = true; }
  }

  // ---- turn: A/D rotates the character like before. The camera anchor turns
  // in lockstep, so the view follows the turn while any drag-look offset the
  // player set is preserved. ----
  if (Math.abs(turn) > 0.001) {
    _q.setFromAxisAngle(playerDir, turn * TURN_SPEED * dt);
    playerForward.applyQuaternion(_q);
    camDir.applyQuaternion(_q);
    keepPlayerForwardTangent();
  }

  // ---- move along the facing: W walks forward, S back-pedals (no about-turn) ----
  if (Math.abs(fwd) > 0.001) {
    keepPlayerForwardTangent();
    const travel = playerForward.clone().multiplyScalar(Math.sign(fwd));
    playerMoved = tryMovePlayerOnSurface(travel, moveMag * (activeBoatItem ? SAIL : WALK) * dt);
  }

  // Keep a comfortable point behind the visitor as a recovery anchor. When a
  // layout edit or a narrow collider wedge leaves too few exits, recover after
  // a short grace period; simply walking into one wall never teleports anyone.
  const playerClear = playerSurfaceAllowed(playerDir)
    && hasSurfaceClearance(playerDir, PLAYER_CLEARANCE_RADIUS);
  const roomyClearance = surfaceColliderClearance(playerDir) > PLAYER_CLEARANCE_RADIUS + 0.035;
  if (!activeBoatItem && playerClear && roomyClearance) lastSafePlayerDir.copy(playerDir);
  let needsRecovery = !playerClear;
  if (!needsRecovery && Math.abs(fwd) > 0.001 && !playerMoved) {
    lastPlayerEscapeOptions = playerEscapeOptionCount(playerDir);
    needsRecovery = lastPlayerEscapeOptions <= 1;
  }
  playerBlockedFor = needsRecovery ? playerBlockedFor + dt : 0;
  if (playerBlockedFor > 0.42) {
    recoverPlayerToSafeSurface({ notify: true });
  }

  // ---- place & orient the player on the surface (+ jump height along up) ----
  const { up } = tangentBasis(playerDir);
  player.position.copy(playerDir.clone().multiplyScalar(terrainRadius(playerDir) + 0.05 + jumpHeight));
  if (activeBoatItem) syncActiveBoatTransform();
  // face along the transported tangent vector, standing up along `up`
  keepPlayerForwardTangent();
  const face = playerForward.clone();
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(up, face).normalize(), up, face
  );
  player.quaternion.setFromRotationMatrix(m);

  // little bob while walking
  playerStride += ((moveMag > 0.001 ? moveMag : 0) - playerStride) * Math.min(1, dt * 10);
  const playerInWater = !activeBoatItem && isInWaterDir(playerDir);
  body.position.y = playerStride * Math.abs(Math.sin(elapsed * 9)) * 0.05 - (playerInWater ? 0.08 : 0);
  animateCharacterWalk(player, playerStride, elapsed);
  updateCharacterContactShadow(player, jumpHeight, playerStride, playerInWater);

  // ---- 집 문 앞 감지: 가까우면 입장 프롬프트가 뜬다 (F / 탭) ----
  updateServiceProximity();

  stepCameraIntro(performance.now());
  dashboardUpdatePatrol(dt);

  // ---- camera: track the focused agent (card open) or follow the player ----
  if (focusNpc) {
    const nUp = focusNpc.userData.dir.clone().normalize();
    const aPos = focusNpc.position;
    // pick the viewing side ONCE per focus: away from the agent's home cottage
    // (house becomes the backdrop, not an occluder), else the current camera side
    if (!focusSide) {
      focusSide = chooseAgentFocusSide(focusNpc);
    }
    const focusHome = focusNpc.userData.agent?.home;
    const lighthouseFocus = focusHome?.data?.type === 'lighthouse';
    const toCam = focusSide.clone();
    toCam.sub(nUp.clone().multiplyScalar(toCam.dot(nUp)));     // keep tangent to surface
    if (toCam.lengthSq() < 1e-4) toCam.copy(tangentBasis(nUp).north);
    toCam.normalize();
    const focusDistance = lighthouseFocus
      ? (innerWidth <= 520 ? 7.2 : 6.6)
      : (innerWidth <= 520 ? 6.2 : 5.5);
    const focusElevation = lighthouseFocus
      ? (innerWidth <= 520 ? 5.2 : 4.8)
      : (innerWidth <= 520 ? 4.15 : 3.8);
    const focusTarget = aPos.clone()
      .add(toCam.multiplyScalar(focusDistance))
      .add(nUp.clone().multiplyScalar(focusElevation));
    _focusLookTarget.copy(aPos).add(nUp.clone().multiplyScalar(lighthouseFocus ? 1.34 : 0.94));
    if (focusHome?.mesh) {
      focusHome.mesh.getWorldPosition(_focusHomePosition);
      _focusHomePosition.add(focusHome.dir.clone().multiplyScalar(
        lighthouseFocus ? 3.4 : 1.18
      ));
      _focusLookTarget.lerp(_focusHomePosition, lighthouseFocus ? 0.42 : 0.24);
    }
    const focusAlpha = 1 - Math.pow(0.02, dt);
    moveCameraAroundPlanet(focusTarget, focusAlpha);
    camera.up.lerp(nUp, focusAlpha).normalize();
    // On an opposite-side focus, aiming at the destination immediately makes
    // the globe fill the frame even though the camera itself stays outside it.
    // Follow the currently visible surface first, then hand the gaze to the
    // agent once the destination hemisphere is in view.
    _focusCameraDir.copy(camera.position).normalize();
    const destinationVisibility = _focusCameraDir.dot(nUp);
    const destinationBlend = THREE.MathUtils.smoothstep(destinationVisibility, 0.18, 0.72);
    _focusTransitLookTarget.copy(_focusCameraDir)
      .multiplyScalar(dashboardLookHeight())
      .lerp(_focusLookTarget, destinationBlend);
    camera.lookAt(_focusTransitLookTarget);
  } else {
    // the camera hangs behind its own anchor (camDir) — the character running
    // sideways doesn't swing the view; only dragging rotates it
    const dashboard = experienceMode === 'dashboard';
    const cameraUp = dashboard ? DASHBOARD_VIEW_DIR.clone().applyAxisAngle(dashboardOrbitAxis, dashboardYaw) : up;
    const cameraForward = dashboard ? DASHBOARD_VIEW_FORWARD.clone().applyAxisAngle(dashboardOrbitAxis, dashboardYaw) : camDir;
    const back = cameraForward.clone().multiplyScalar(-1);
    // In dashboard mode the planet gets a very small cinematic sway and
    // breathing zoom. It is deliberately bounded, so labels and click targets
    // stay stable while the overview feels alive.
    const dashboardSway = experienceMode === 'dashboard' && !dragging
      ? Math.sin(elapsed * 0.11) * 0.055
      : 0;
    if (dashboardSway) back.applyAxisAngle(cameraUp, dashboardSway);
    const viewDist = camDist + (experienceMode === 'dashboard' ? Math.sin(elapsed * 0.16) * 0.16 : 0);
    const camOffset = cameraUp.clone().multiplyScalar(Math.sin(camPitch) * viewDist)
                      .add(back.multiplyScalar(Math.cos(camPitch) * viewDist));
    const camTarget = dashboard ? camOffset : player.position.clone().add(camOffset);
    const followAlpha = 1 - Math.pow(0.001, dt);
    if (dashboard) moveCameraAroundPlanet(camTarget, followAlpha);
    else camera.position.lerp(camTarget, followAlpha);
    camera.up.lerp(cameraUp, followAlpha).normalize();
    if (dashboard) {
      const lookHeight = dashboardLookHeight();
      _focusCameraDir.copy(camera.position).normalize();
      const destinationBlend = THREE.MathUtils.smoothstep(
        _focusCameraDir.dot(cameraUp), 0.18, 0.70,
      );
      _focusLookTarget.copy(cameraUp).multiplyScalar(lookHeight);
      _focusTransitLookTarget.copy(_focusCameraDir).multiplyScalar(lookHeight)
        .lerp(_focusLookTarget, destinationBlend);
      camera.lookAt(_focusTransitLookTarget);
    } else {
      camera.lookAt(player.position.clone().add(up.clone().multiplyScalar(0.8)));
    }
  }

  // ---- animate DOM emoji bubbles (float up & fade) ----
  for (let i = emojiBubbles.length - 1; i >= 0; i--) {
    const bubble = emojiBubbles[i];
    bubble.age += dt;
    bubble.offset.y = 1.8 + bubble.age * 0.8;
    bubble.alpha = Math.max(0, 1 - bubble.age / 1.6);
    if (bubble.age > 1.6) {
      removeWorldLabel(bubble);
      emojiBubbles.splice(i, 1);
    }
  }

  // ---- NPCs wander the planet with smooth steering; they never overlap ----
  updateNPCs(dt);
  skySystem.update({ dt, elapsed, playerDirection: playerDir });
  const atmosphere = skySystem.ambientState();
  updateHorizonCulling();
  updateAmbientScene(elapsed, atmosphere);
  ambientAudio.update({ elapsed, ...atmosphere });
  updateWorldLabels();

  // Argos's lighthouse works as a live status landmark: the gold beam only
  // sweeps the cape while Argos is actively working.
  const argosBeam = ARGOS_AGENT?.home?.mesh?.userData?.lighthouseBeam;
  if (argosBeam?.visible) argosBeam.rotation.y += dt * (0.58 + atmosphere.wind * 0.34);

  if (!webglContextLost) {
    performanceGovernor.beforeRender(dt);
    composer.render();
    publishDevMetrics(elapsed);
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  performanceGovernor.resize(innerWidth, innerHeight);
  if (experienceMode === 'dashboard' && !cameraIntro) {
    camDist = document.body.classList.contains('intro-active')
      ? introCameraDistance()
      : dashboardCameraDistance();
  }
});

// kick off — start the render loop immediately so the intro shows a live world behind it,
// then enable the Start button and let the user dismiss the intro with a soft fade.
const worldLoop = createVisibilityLoop({
  frame: animate,
  blocked: () => webglContextLost,
  onPause: () => {
    for (const key of Object.keys(keys)) keys[key] = false;
    stickVec.x = 0;
    stickVec.y = 0;
    jumpRequested = false;
  },
});
renderer.domElement.addEventListener('webglcontextlost', () => worldLoop.refresh());
renderer.domElement.addEventListener('webglcontextrestored', () => worldLoop.refresh());
worldLoop.start();

startBtn.disabled = false;
startBtn.textContent = '에이전트 관제하기';
const introExploreBtn = document.getElementById('exploreModeBtn');
if (introExploreBtn) {
  introExploreBtn.disabled = false;
  introExploreBtn.textContent = '직접 산책하기';
}
if (STARTUP_WARNINGS.length) {
  setTimeout(() => showAppNotice(STARTUP_WARNINGS.join(' '), {
    actionLabel: '다시 시도',
    onAction: () => location.reload(),
    sticky: true,
  }), 500);
}
addEventListener('offline', () => showAppNotice('인터넷 연결이 끊겼습니다. 저장된 행성은 계속 둘러볼 수 있습니다.', { sticky: true }));
addEventListener('online', () => showAppNotice('인터넷 연결이 복구되었습니다.'));
addEventListener('mini-planet-update-ready', () => showAppNotice('새 버전의 행성이 준비되었습니다.', {
  actionLabel: '새로고침',
  onAction: () => location.reload(),
  sticky: true,
}));

function beginGame(mode = 'dashboard', { cinematic = true } = {}) {
  roseLabel.element.inert = false;
  setExperienceMode(mode);
  if (cinematic) startCameraIntro();
  else cameraIntro = null;
  document.body.classList.remove('intro-active');
  const uiRoot = document.querySelector('.ui');
  if (uiRoot) {
    uiRoot.inert = false;
    uiRoot.removeAttribute('inert');
    uiRoot.setAttribute('aria-hidden', 'false');
  }
  intro.classList.add('hide');
  setTimeout(() => intro.remove(), 850);   // remove after the fade finishes
  removeEventListener('keydown', anyKeyStart);
}
function anyKeyStart(e) {
  if (isUiInteractionTarget(e.target)) return;
  const key = e.key.toLowerCase();
  if (e.key === 'Enter') beginGame('dashboard');
  else if (MOVEMENT_KEYS.has(key)) {
    e.preventDefault();
    beginGame('explore', { cinematic: false });
  }
}
startBtn.addEventListener('click', () => beginGame('dashboard'));
introExploreBtn?.addEventListener('click', () => beginGame('explore'));
document.getElementById('dashboardModeBtn')?.addEventListener('click', () => setExperienceMode('dashboard'));
document.getElementById('exploreModeSwitchBtn')?.addEventListener('click', () => setExperienceMode('explore'));
setExperienceMode('dashboard');
camDist = introCameraDistance();
camPitch = DASHBOARD_CAM_PITCH;
snapFollowCamera();
addEventListener('keydown', anyKeyStart);

// ===========================================================================
// EDIT-MODE UI wiring — connects the toolbar / palette / intro button to the
// editor functions defined above. The editor exposes a few on* callbacks that
// this section implements to keep the DOM and the 3D editor in sync.
// ===========================================================================
(function wireEditorUI() {
  const editorBar   = document.getElementById('editorBar');
  const paletteEl   = document.getElementById('palette');
  const inspectorEl = document.getElementById('inspector');
  const editBtn     = document.getElementById('editModeBtn');     // on the intro screen
  const quickEditBtn = document.getElementById('editModeQuickBtn');
  const modeEditBtn = document.getElementById('editModeSwitchBtn');
  const exitBtn     = document.getElementById('editExitBtn');
  const undoBtn     = document.getElementById('editUndoBtn');
  const redoBtn     = document.getElementById('editRedoBtn');
  const saveStateEl = document.getElementById('editorSaveState');
  const qualityEl   = document.getElementById('editorQuality');
  const auditEl     = document.getElementById('layoutAudit');
  const auditScoreEl = document.getElementById('layoutAuditScore');
  const auditSummaryEl = document.getElementById('layoutAuditSummary');
  const exportBtn   = document.getElementById('editExportBtn');
  const importBtn   = document.getElementById('editImportBtn');
  const restoreBtn  = document.getElementById('editRestoreBtn');
  const resetBtn    = document.getElementById('editResetBtn');
  const importInput = document.getElementById('editImportInput');
  const hintEl      = document.getElementById('editHint');
  const collapseBtn = document.getElementById('editorCollapseBtn');
  const objectsTab  = document.getElementById('editorObjectsTab');
  const terrainTab  = document.getElementById('editorTerrainTab');
  const objectsPanel = document.getElementById('editorObjectsPanel');
  const terrainPanel = document.getElementById('editorTerrainPanel');
  const contextEl   = document.getElementById('editorContext');
  if (!editorBar) return;   // markup missing -> skip silently

  let editorTab = 'objects';
  let editorOpener = null;
  function setEditorContext(message) {
    if (contextEl) contextEl.textContent = message;
  }
  function setEditorCollapsed(collapsed) {
    editorBar.classList.toggle('compact', collapsed);
    collapseBtn?.setAttribute('aria-expanded', String(!collapsed));
    if (collapseBtn) collapseBtn.textContent = collapsed ? '도구 열기' : '도구 접기';
  }
  function setEditorTab(tab) {
    editorTab = tab === 'terrain' ? 'terrain' : 'objects';
    const objectActive = editorTab === 'objects';
    objectsTab?.classList.toggle('active', objectActive);
    terrainTab?.classList.toggle('active', !objectActive);
    objectsTab?.setAttribute('aria-selected', String(objectActive));
    terrainTab?.setAttribute('aria-selected', String(!objectActive));
    if (objectsTab) objectsTab.tabIndex = objectActive ? 0 : -1;
    if (terrainTab) terrainTab.tabIndex = objectActive ? -1 : 0;
    if (objectsPanel) objectsPanel.hidden = !objectActive;
    if (terrainPanel) terrainPanel.hidden = objectActive;
    setEditorContext(objectActive
      ? '카테고리를 열고 오브젝트를 추가한 뒤 행성 위에서 드래그하세요.'
      : '길 또는 영역을 선택하고 지면을 클릭해 점을 연결하세요.');
  }

  collapseBtn?.addEventListener('click', () => {
    const collapsed = !editorBar.classList.contains('compact');
    setEditorCollapsed(collapsed);
    if (matchMedia('(max-width: 520px)').matches && !drawingType) {
      const showInspector = collapsed && !!selectedItem;
      inspectorEl.classList.toggle('show', showInspector);
      setInteractiveState(inspectorEl, showInspector);
    }
  });
  objectsTab?.addEventListener('click', () => {
    if (drawingType) cancelDrawing();
    setEditorTab('objects');
  });
  terrainTab?.addEventListener('click', () => setEditorTab('terrain'));
  for (const tab of [objectsTab, terrainTab]) {
    tab?.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' || event.key === 'ArrowLeft' ? 'objects' : 'terrain';
      setEditorTab(next);
      (next === 'objects' ? objectsTab : terrainTab)?.focus();
    });
  }

  // build the palette from the asset registry, grouped by category
  PROP_CATEGORIES.forEach((cat, categoryIndex) => {
    const group = document.createElement('div');
    group.className = `pal-group${categoryIndex === 0 ? '' : ' collapsed'}`;
    const title = document.createElement('button');
    title.className = 'pal-cat';
    title.type = 'button';
    title.append(document.createTextNode(cat));
    const items = document.createElement('div');
    items.className = 'pal-items';
    const definitions = Object.entries(PROP_DEFS).filter(([, def]) => def.category === cat);
    const count = document.createElement('span');
    count.className = 'pal-count';
    count.textContent = definitions.length;
    title.appendChild(count);
    title.setAttribute('aria-expanded', String(categoryIndex === 0));
    title.addEventListener('click', () => {
      const shouldOpen = group.classList.contains('collapsed');
      for (const other of paletteEl.querySelectorAll('.pal-group')) {
        other.classList.add('collapsed');
        other.querySelector('.pal-cat')?.setAttribute('aria-expanded', 'false');
      }
      if (shouldOpen) {
        group.classList.remove('collapsed');
        title.setAttribute('aria-expanded', 'true');
      }
    });
    group.append(title, items);
    for (const [type, def] of definitions) {
      const b = document.createElement('button');
      b.className = 'pal-btn';
      b.textContent = def.paletteLabel;
      b.addEventListener('click', () => {
        addProp(type);
        flashHint(`${def.paletteLabel} 추가됨 — 드래그해서 배치하세요`);
      });
      items.appendChild(b);
    }
    paletteEl.appendChild(group);
  });

  let hintTimer = 0;
  function flashHint(msg) {
    hintEl.textContent = msg;
    hintEl.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hintEl.classList.remove('show'), 2200);
  }

  const PATH_NAMES = {
    road: '🛣️ 도로', lane: '🧱 마을 골목', river: '🌊 물길', trail: '🛤️ 흙길',
    snow: '❄️ 눈길', pond: '🏞️ 연못', sand: '🏖️ 모래밭', grass: '🌿 풀밭',
    island: '🏝️ 섬', sea: '🌐 바다', deck: '▦ 데크', market: '⚑ 어시장',
    breakwater: '▰ 방파제', wave: '≋ 파도', camellia: '✿ 동백길',
    streetEdge: '▱ 도로 연석', laneEdge: '▱ 골목 연석', hedge: '♧ 생울타리',
    quayRail: '⌇ 부두 난간', courtyard: '▦ 건물 앞마당',
  };

  // editor -> UI callbacks (referenced by name inside the editor module)
  window.onSelectionChanged = (item) => {
    if (!item) {
      inspectorEl.classList.remove('show');
      setInteractiveState(inspectorEl, false);
      setEditorContext(editorTab === 'objects'
        ? '카테고리를 열고 오브젝트를 추가한 뒤 행성 위에서 드래그하세요.'
        : '길 또는 영역을 선택하고 지면을 클릭해 점을 연결하세요.');
      return;
    }
    inspectorEl.classList.add('show');
    setInteractiveState(inspectorEl, true);
    const isPath = item.isPath;
    const itemName = isPath
      ? PATH_NAMES[item.data.type]
      : (PROP_DEFS[item.data.type]?.paletteLabel || item.data.type);
    inspectorEl.querySelector('.insp-name').textContent = itemName;
    if (isPath) setEditorTab('terrain');
    setEditorContext(`${itemName} 선택됨 — 아래 도구에서 회전·크기·복제·삭제를 조정하세요.`);
    if (matchMedia('(max-width: 520px)').matches) setEditorCollapsed(true);
    // paths can only be deleted — hide rotate/scale buttons for them
    inspectorEl.classList.toggle('path-selected', !!isPath);

    // curated variant swatches (색상 이론 몰라도 안전한 조합만 제공)
    const vWrap = document.getElementById('inspVariants');
    vWrap.textContent = '';
    const def = !isPath && PROP_DEFS[item.data.type];
    inspectorEl.classList.toggle('no-yaw', !def?.editableParams?.includes('yaw'));
    inspectorEl.classList.toggle('no-scale', !def?.editableParams?.includes('scale'));
    if (def && def.variants) {
      for (const v of def.variants) {
        const sw = document.createElement('button');
        sw.className = 'insp-swatch';
        sw.title = v.name;
        const hex = v.wall ?? v.color ?? 0xffffff;
        sw.style.background = cssHex(hex);
        if (v.roof !== undefined) {
          sw.style.borderTopColor = cssHex(v.roof);
        }
        sw.addEventListener('click', () => applyVariantToSelected(v));
        vWrap.appendChild(sw);
      }
    }
  };
  window.onEditModeChanged = (on) => {
    editorBar.classList.toggle('show', on);
    setInteractiveState(editorBar, on);
    modeEditBtn?.setAttribute('aria-pressed', String(on));
    if (on) {
      if (!editorOpener) editorOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setEditorCollapsed(false);
      setEditorTab('objects');
      editorBar.querySelector('.editor-manage')?.removeAttribute('open');
      flashHint('편집 내용은 이 브라우저에만 저장됩니다 · 공개 홈페이지 원본은 변경되지 않습니다');
      requestAnimationFrame(() => exitBtn?.focus());
    }
    else {
      inspectorEl.classList.remove('show');
      setInteractiveState(inspectorEl, false);
      cancelDrawing();
      const focusTarget = editorOpener?.isConnected ? editorOpener : modeEditBtn;
      requestAnimationFrame(() => focusTarget?.focus());
      editorOpener = null;
    }
  };
  window.onLayoutSaveState = (ok, message) => {
    if (!saveStateEl) return;
    saveStateEl.textContent = message || (ok ? '저장됨' : '저장 실패');
    saveStateEl.classList.toggle('saved', !!ok);
    saveStateEl.classList.toggle('error', !ok);
  };
  window.onLayoutQualityChanged = (audit) => {
    if (!audit) return;
    const label = audit.status === 'ready'
      ? `기능 검사 ${audit.score}`
      : audit.status === 'review' ? `배치 검토 ${audit.score}` : `배치 차단 ${audit.score}`;
    const placementDetails = [
      ...(audit.homeClearance || []).map((issue) =>
        `${issue.a}↔${issue.b} 시야 ${issue.distance.toFixed(1)}m`),
      ...(audit.doorObstructions || []).map((issue) =>
        `${issue.owner} 진입로: ${issue.obstacleType} ${issue.distance.toFixed(1)}m`),
      ...(audit.overlaps || []).map((issue) =>
        `${issue.aType}↔${issue.bType} ${issue.distance.toFixed(1)}m`),
    ];
    const details = [...audit.errors, ...audit.warnings, ...placementDetails];
    if (qualityEl) {
      qualityEl.className = `editor-quality ${audit.status}`;
      qualityEl.textContent = label;
      qualityEl.title = details.join(' · ') || '필수 집, 운영 코어, 이동 충돌 점검 통과';
    }
    if (auditEl) auditEl.dataset.state = audit.status;
    if (auditScoreEl) auditScoreEl.textContent = String(audit.score);
    if (auditSummaryEl) {
      auditSummaryEl.textContent = details[0]
        || `필수 배치 통과 · 오브젝트 ${audit.objectCount}개 · 이동 충돌 없음`;
      auditSummaryEl.title = details.join('\n');
    }
  };
  window.onLayoutHistoryChanged = ({ canUndo, canRedo }) => {
    if (undoBtn) undoBtn.disabled = !canUndo;
    if (redoBtn) redoBtn.disabled = !canRedo;
  };
  window.onLayoutImported = (ok, err) => {
    flashHint(ok ? '레이아웃을 불러왔습니다 ✓' : `불러오기 실패: ${err || '형식 오류'}`);
  };
  notifyLayoutQuality();
  // path drawing UI state
  const drawBar = document.getElementById('drawBar');
  window.onDrawModeChanged = (type) => {
    editorBar.classList.toggle('drawing', !!type);
    if (drawBar) {
      drawBar.classList.toggle('show', !!type);
      setInteractiveState(drawBar, !!type);
    }
    for (const button of editorBar.querySelectorAll('.draw-btn')) button.classList.remove('active');
    if (type) {
      setEditorTab('terrain');
      const activeButton = document.getElementById(`draw${type[0].toUpperCase()}${type.slice(1)}Btn`);
      activeButton?.classList.add('active');
      inspectorEl.classList.remove('show');
      setInteractiveState(inspectorEl, false);
      setEditorContext(`${PATH_NAMES[type]} 그리는 중 — 지면을 클릭하고 아래 완료 버튼으로 확정하세요.`);
      if (matchMedia('(max-width: 520px)').matches) setEditorCollapsed(true);
      flashHint(`${PATH_NAMES[type]} 그리는 중 — 지면을 클릭해 점을 찍고, 완료를 누르세요`);
    } else {
      setEditorContext(editorTab === 'objects'
        ? '카테고리를 열고 오브젝트를 추가한 뒤 행성 위에서 드래그하세요.'
        : '길 또는 영역을 선택하고 지면을 클릭해 점을 연결하세요.');
    }
  };
  window.onDrawPointsChanged = (n) => {
    const c = document.getElementById('drawCount');
    if (c) c.textContent = n;
    const done = document.getElementById('drawDoneBtn');
    if (done) done.disabled = n < (PATH_DEFS[drawingType]?.minPoints || 2);
  };

  // enter edit mode from the intro (also dismisses the intro)
  if (editBtn) editBtn.addEventListener('click', () => {
    editorOpener = editBtn;
    beginGame('dashboard', { cinematic: false });
    enterEditMode();
  });
  const openEditorFromApp = () => {
    editorOpener = document.activeElement instanceof HTMLElement ? document.activeElement : modeEditBtn;
    if (intro.isConnected) beginGame('dashboard', { cinematic: false });
    enterEditMode();
  };
  quickEditBtn?.addEventListener('click', openEditorFromApp);
  modeEditBtn?.addEventListener('click', openEditorFromApp);
  // E consistently toggles the editor after the intro has been dismissed.
  addEventListener('keydown', (e) => {
    if (isUiInteractionTarget(e.target) || e.key.toLowerCase() !== 'e' || e.repeat || e.ctrlKey || e.metaKey || intro.isConnected) return;
    if (editMode) exitEditMode();
    else enterEditMode();
  });

  exitBtn.addEventListener('click', () => exitEditMode());
  undoBtn?.addEventListener('click', () => {
    flashHint(undoLayout() ? '마지막 편집을 취소했습니다' : '취소할 편집이 없습니다');
  });
  redoBtn?.addEventListener('click', () => {
    flashHint(redoLayout() ? '편집을 다시 적용했습니다' : '다시 적용할 편집이 없습니다');
  });
  exportBtn.addEventListener('click', () => exportLayout());
  restoreBtn?.addEventListener('click', () => {
    if (!confirm('가장 최근 안전 백업으로 배치를 되돌릴까요? 현재 배치도 새 백업으로 남습니다.')) return;
    flashHint(restoreLatestLayoutBackup() ? '최근 안전 백업을 복구했습니다 ✓' : '복구할 안전 백업이 없습니다');
  });
  resetBtn.addEventListener('click', () => {
    if (confirm('마을을 기본 배치로 되돌릴까요? 저장된 편집 내용이 사라집니다.')) {
      resetLayout();
      selectItem(null);
      flashHint('기본 배치로 되돌렸습니다');
    }
  });
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importLayoutFromFile(file);
    importInput.value = '';   // allow re-importing the same file
  });

  // inspector quick-action buttons (rotate / scale / delete)
  inspectorEl.querySelector('.insp-rotL').addEventListener('click', () => rotateSelected(-Math.PI / 8));
  inspectorEl.querySelector('.insp-rotR').addEventListener('click', () => rotateSelected(Math.PI / 8));
  inspectorEl.querySelector('.insp-bigger').addEventListener('click', () => scaleSelected(1.15));
  inspectorEl.querySelector('.insp-smaller').addEventListener('click', () => scaleSelected(1 / 1.15));
  inspectorEl.querySelector('.insp-dup').addEventListener('click', () => duplicateSelected());
  inspectorEl.querySelector('.insp-del').addEventListener('click', () => deleteSelected());

  // edit-camera view presets
  const camVillageBtn = document.getElementById('camVillageBtn');
  const camPoleBtn = document.getElementById('camPoleBtn');
  if (camVillageBtn) camVillageBtn.addEventListener('click', () => setEditCameraTarget(MAP_CENTER));
  if (camPoleBtn) camPoleBtn.addEventListener('click', () => setEditCameraTarget(NORTH_POLE));

  // path-drawing buttons (toolbar + floating finish/cancel bar) — one button
  // per path type, wired by convention: #draw<Type>Btn → startDrawing(type)
  for (const type of Object.keys(PATH_NAMES)) {
    const btn = document.getElementById(`draw${type[0].toUpperCase()}${type.slice(1)}Btn`);
    if (btn) btn.addEventListener('click', () => startDrawing(type));
  }
  const drawDoneBtn = document.getElementById('drawDoneBtn');
  const drawCancelBtn = document.getElementById('drawCancelBtn');
  if (drawDoneBtn)  drawDoneBtn.addEventListener('click', () => {
    const need = PATH_DEFS[drawingType]?.minPoints || 2;
    const made = finishDrawing();
    flashHint(made ? '경로를 추가했습니다 ✓' : `점을 ${need}개 이상 찍어야 합니다`);
  });
  if (drawCancelBtn) drawCancelBtn.addEventListener('click', () => cancelDrawing());
  notifyLayoutHistory();
})();

// ===========================================================================
// AGENT DASHBOARD — 행성이 곧 팀 현황판. 에이전트를 클릭하면 상태 카드가
// 열리고, 좌측 팀 바에서 여섯 공명자의 상태를 한눈에 본다. 상태 데이터는
// agent-status.json(같은 폴더)을 주기적으로 읽어 갱신하므로, 그 파일만
// 바꾸면 실시간 대시보드로 동작한다.
// ===========================================================================
(function wireAgentDashboard() {
  const cardEl = document.getElementById('agentCard');
  const barEl = document.getElementById('agentbar');
  if (!cardEl || !barEl) return;

  const el = (id) => document.getElementById(id);
  const barWrap = document.getElementById('agentbarWrap');
  const barToggle = document.getElementById('agentbarToggle');
  const connectionEl = document.getElementById('statusConnection');
  const teamNameEl = document.getElementById('agentbarName');
  const teamPanelEl = document.getElementById('teamOverviewPanel');
  const teamOverviewBtn = document.getElementById('teamOverviewBtn');
  const teamApprovalBadge = document.getElementById('teamApprovalBadge');
  const patrolToggle = document.getElementById('patrolToggle');
  const patrolStateEl = document.getElementById('patrolState');
  const refreshBtn = document.getElementById('statusRefreshBtn');
  const freshnessEl = document.getElementById('statusFreshness');
  const recentResultsBtn = document.getElementById('recentResultsBtn');
  const recentResultsState = document.getElementById('recentResultsState');
  const recentResultsBadge = document.getElementById('recentResultsBadge');
  const opsFleetEl = document.getElementById('opsFleet');
  const opsActiveEl = document.getElementById('opsActive');
  const opsApprovalEl = document.getElementById('opsApproval');
  const opsPipelineEl = document.getElementById('opsPipeline');
  const opsLinkEl = document.getElementById('opsLink');
  const opsLinkDetailEl = document.getElementById('opsLinkDetail');
  const agentByKey = new Map(AGENTS.map((agent) => [agent.key, agent]));
  const chips = {};
  let dashboardView = {
    schemaVersion: 0,
    publicationMode: RUNTIME_CONFIG.publication?.mode || 'static-demo',
    generatedAt: null,
    sourceGeneratedAt: null,
    bridgeObservedAt: null,
    expiresAt: null,
    isStale: false,
    freshness: { state: 'static', isStale: false, reason: 'static-demo' },
    source: 'legacy',
    teamHealth: null,
    tasks: [],
    approvals: [],
  };
  let openAgent = null;
  let agentCardOpener = null;
  let teamPanelOpener = null;
  let patrolEnabled = false;
  let patrolOrder = [];
  let patrolIndex = -1;
  let patrolTimer = 0;
  let patrolAgent = null;
  const PATROL_SECONDS = 9;
  let statusSource = null;
  let lastStatusReceivedAt = null;
  let lastStatusGeneratedAt = null;
  let lastRecoveryAttemptAt = 0;
  let connectionState = 'loading';
  let reportedAgentKeys = new Set();
  const RESULT_SEEN_KEY = 'HandulPlanet_seen_results_v1';
  let seenResults = new Set();
  try {
    const stored = JSON.parse(localStorage.getItem(RESULT_SEEN_KEY) || '[]');
    if (Array.isArray(stored)) seenResults = new Set(stored.filter((value) => typeof value === 'string').slice(-120));
  } catch (_) { /* malformed seen history is harmless */ }

  if (teamNameEl) {
    teamNameEl.textContent = '✦ ' + (TEAM_CONFIG.displayName || TEAM_CONFIG.name || '별의 공명자들');
    teamNameEl.title = TEAM_CONFIG.systemSummary || TEAM_CONFIG.name || '';
  }

  function closeTeamOverview(restoreFocus = false) {
    if (!teamPanelEl) return;
    const wasOpen = teamPanelEl.classList.contains('show');
    teamPanelEl.classList.remove('show');
    setInteractiveState(teamPanelEl, false);
    teamOverviewBtn?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('team-overview-open');
    if (restoreFocus && wasOpen) (teamPanelOpener?.isConnected ? teamPanelOpener : teamOverviewBtn)?.focus();
    teamPanelOpener = null;
  }

  function openTeamOverview() {
    if (!teamPanelEl) return;
    dashboardStopPatrol();
    closeVisitorPanels();
    closeServicePanel();
    closeAgentCard();
    renderTeamOverview();
    teamPanelOpener = document.activeElement instanceof HTMLElement ? document.activeElement : teamOverviewBtn;
    teamPanelEl.scrollTop = 0;
    teamPanelEl.classList.add('show');
    setInteractiveState(teamPanelEl, true);
    teamOverviewBtn?.setAttribute('aria-expanded', 'true');
    document.body.classList.add('team-overview-open');
    setTimeout(() => {
      if (teamPanelEl.classList.contains('show')) el('teamOverviewClose')?.focus({ preventScroll: true });
    }, 320);
  }

  teamOverviewBtn?.addEventListener('click', () => {
    if (teamPanelEl?.classList.contains('show')) closeTeamOverview(true);
    else openTeamOverview();
  });
  el('teamOverviewClose')?.addEventListener('click', () => closeTeamOverview(true));
  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (teamPanelEl?.classList.contains('show')) closeTeamOverview(true);
    else if (cardEl.classList.contains('show')) closeAgentCard(true);
  });
  dashboardCloseTeam = closeTeamOverview;

  function setBarCollapsed(collapsed) {
    barWrap?.classList.toggle('collapsed', collapsed);
    barToggle?.setAttribute('aria-expanded', String(!collapsed));
  }
  const agentBarBreakpoint = matchMedia('(max-width: 520px)');
  let barCollapseTouched = false;
  barToggle?.addEventListener('click', () => {
    barCollapseTouched = true;
    setBarCollapsed(!barWrap.classList.contains('collapsed'));
  });
  const syncAgentBarBreakpoint = () => {
    // A user choice lasts within the current breakpoint. Crossing between
    // mobile and desktop restores the ergonomic default instead of leaving a
    // rotated phone's collapsed state stuck on a large monitor.
    barCollapseTouched = false;
    setBarCollapsed(agentBarBreakpoint.matches);
  };
  agentBarBreakpoint.addEventListener?.('change', syncAgentBarBreakpoint);
  if (!barCollapseTouched) setBarCollapsed(agentBarBreakpoint.matches);

  // '3분 전' style relative time for status.updatedAt (null → '')
  function timeAgo(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const min = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (min < 1) return '방금 갱신';
    if (min < 60) return `${min}분 전 갱신`;
    if (min < 60 * 24) return `${Math.round(min / 60)}시간 전 갱신`;
    return `${Math.round(min / 60 / 24)}일 전 갱신`;
  }

  function setUnknownPublicStatus(agent, task = '공개 상태의 유효기간이 지났습니다.') {
    Object.assign(agent.status, {
      state: '상태 미확인',
      task,
      updatedAt: null,
      progress: null,
      result: null,
      results: [],
      health: 'unknown',
      model: null,
      provider: null,
      blocker: null,
      approvalState: null,
      riskLevel: null,
      currentTaskId: null,
      lastActivityAt: null,
      verificationState: 'unverified',
      verifiedAt: null,
      evidenceDigest: null,
    });
  }

  // Live mode starts closed: curated defaults must never be mistaken for a
  // Hermes observation when the first bridge request is slow or unavailable.
  if (dashboardView.publicationMode === 'live') {
    for (const agent of AGENTS) setUnknownPublicStatus(agent, '첫 공개 상태를 확인하는 중입니다.');
  }

  function expireLiveDashboard(reason) {
    if (dashboardView.publicationMode !== 'live' || dashboardView.isStale) return;
    dashboardView = {
      ...dashboardView,
      isStale: true,
      teamHealth: 'unknown',
      tasks: [],
      approvals: [],
      freshness: { ...dashboardView.freshness, state: 'stale', isStale: true, reason },
    };
    for (const agent of AGENTS) setUnknownPublicStatus(agent);
    refreshBar();
    renderTeamOverview();
    syncAgentHomeStatusVisuals();
    refreshOpenServicePanel();
    refreshRecentResultsUi();
    renderConnectionBadge();
  }

  function renderStatusFreshness() {
    if (!freshnessEl) return;
    const now = Date.now();
    const checked = lastStatusReceivedAt ? timeAgo(lastStatusReceivedAt).replace(' 갱신', '') : '';
    const sourceAge = lastStatusGeneratedAt ? timeAgo(lastStatusGeneratedAt).replace(' 갱신', '') : '';
    const transportStale = lastStatusReceivedAt
      && now - Date.parse(lastStatusReceivedAt) > Math.max(120000, (RUNTIME_CONFIG.status.pollMs || 60000) * 2.5);
    if (dashboardView.publicationMode === 'live' && !dashboardView.isStale) {
      const freshness = evaluateSnapshotFreshness({
        publicationMode: dashboardView.publicationMode,
        sourceGeneratedAt: dashboardView.sourceGeneratedAt,
        bridgeObservedAt: dashboardView.bridgeObservedAt,
        expiresAt: dashboardView.expiresAt,
        isStale: false,
      }, {
        now,
        ttlMs: RUNTIME_CONFIG.status.freshnessTtlMs || 180000,
        maxFutureSkewMs: RUNTIME_CONFIG.status.maxFutureSkewMs || 300000,
      });
      if (freshness.isStale) expireLiveDashboard(freshness.reason);
    }
    if (transportStale) expireLiveDashboard('transport-timeout');
    const recoveryInterval = Math.max(30000, Math.min(60000, RUNTIME_CONFIG.status.pollMs || 60000));
    if (dashboardView.publicationMode === 'live' && dashboardView.isStale
      && statusSource && now - lastRecoveryAttemptAt >= recoveryInterval) {
      lastRecoveryAttemptAt = now;
      statusSource.refresh();
    }
    const stale = dashboardView.isStale || transportStale;
    freshnessEl.classList.toggle('stale', !!stale || connectionState === 'offline');
    if (dashboardView.publicationMode === 'static-demo') {
      freshnessEl.classList.remove('stale');
      freshnessEl.textContent = RUNTIME_CONFIG.publication?.notice || 'Hermes 미연결 · 공개용 샘플 데이터';
    } else if (dashboardView.isStale) {
      freshnessEl.textContent = sourceAge ? `상태 만료 · 데이터 ${sourceAge}` : '상태 만료 · 공개 상태를 확인해주세요';
    } else if (connectionState === 'offline') freshnessEl.textContent = checked ? `연결 끊김 · 마지막 확인 ${checked}` : '상태 연결을 확인해주세요';
    else if (!checked) freshnessEl.textContent = '첫 상태를 확인하는 중';
    else freshnessEl.textContent = sourceAge ? `확인 ${checked} · 데이터 ${sourceAge}` : `마지막 확인 ${checked} · 항목 시각 미제공`;
  }

  function renderConnectionBadge() {
    if (!connectionEl) return;
    let state = connectionState;
    let label = ({ live: '실시간', polling: '주기 확인', loading: '연결 중', offline: '오프라인' })[state] || state;
    if (dashboardView.publicationMode === 'static-demo') {
      state = 'static';
      label = RUNTIME_CONFIG.publication?.label || '정적 데모';
    } else if (dashboardView.isStale) {
      state = 'stale';
      label = '상태 만료';
    }
    connectionEl.className = `status-connection ${state}`;
    connectionEl.textContent = label;
  }

  function resultFingerprint(agent, result) {
    return `${agent.key}:${result.id || `${result.title}:${result.updatedAt || ''}`}`;
  }

  function allRecentResults() {
    const items = [];
    for (const agent of AGENTS) {
      for (const result of mergePublicResults(agent.status.result, agent.status.results, agent.results)) {
        items.push({ agent, result, fingerprint: resultFingerprint(agent, result) });
      }
    }
    return items.sort((a, b) => (Date.parse(b.result.updatedAt) || 0) - (Date.parse(a.result.updatedAt) || 0));
  }

  refreshRecentResultsUi = () => {
    if (!recentResultsBtn || !recentResultsState || !recentResultsBadge) return;
    const items = allRecentResults();
    recentResultsBtn.hidden = items.length === 0;
    if (!items.length) return;
    const unread = items.filter((item) => !seenResults.has(item.fingerprint));
    const latest = unread[0] || items[0];
    recentResultsState.textContent = `${latest.agent.kor} · ${latest.result.title}`;
    recentResultsBadge.hidden = unread.length === 0;
    recentResultsBadge.textContent = String(unread.length);
    recentResultsBtn.setAttribute('aria-label', unread.length
      ? `최근 결과 열기, 새 결과 ${unread.length}건`
      : `최근 결과 열기, 최신 ${latest.agent.kor}`);
  };

  recentResultsBtn?.addEventListener('click', () => {
    const items = allRecentResults();
    const latest = items.find((item) => !seenResults.has(item.fingerprint)) || items[0];
    if (!latest) return;
    for (const item of items) seenResults.add(item.fingerprint);
    try { localStorage.setItem(RESULT_SEEN_KEY, JSON.stringify([...seenResults].slice(-120))); } catch (_) { /* private mode */ }
    refreshRecentResultsUi();
    openServicePanel(latest.agent, { tab: 'results' });
  });

  function renderResponsibilities(a) {
    const wrap = el('agentResponsibilities');
    const items = Array.isArray(a.responsibilities) ? a.responsibilities.slice(0, 3) : [];
    wrap.replaceChildren();
    for (const item of items) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const chip = document.createElement('span');
      chip.textContent = item.trim();
      wrap.appendChild(chip);
    }
    wrap.hidden = !wrap.childElementCount;
  }

  function renderPersonaNotes(a) {
    const notes = el('agentProfileNotes');
    const voice = Array.isArray(a.voiceTraits) ? a.voiceTraits.slice(0, 2).join(' · ') : '';
    const values = Array.isArray(a.values) ? a.values.slice(0, 3).join(' · ') : '';
    const resultSpace = a.resultSpace && typeof a.resultSpace === 'object'
      ? [a.resultSpace.name, a.resultSpace.summary].filter(Boolean).join(' — ')
      : '';
    el('agentVoiceTraits').textContent = voice;
    el('agentValues').textContent = values;
    el('agentResultSpace').textContent = resultSpace;
    notes.hidden = !voice && !values && !resultSpace;
  }

  function renderRuntime(a) {
    const status = a.status;
    const healthLabels = {
      healthy: '정상',
      degraded: '주의',
      error: '오류',
      offline: '오프라인',
      unknown: '미확인',
    };
    const verificationLabels = {
      unverified: '미검증',
      pending: '검증 대기',
      verified: '검증됨',
      failed: '검증 실패',
      not_applicable: '',
    };
    const approvalLabels = {
      not_required: '',
      pending: '승인 대기',
      approved: '승인됨',
      rejected: '승인 거절',
    };
    const healthEl = el('agentHealth');
    const modelEl = el('agentModel');
    const riskEl = el('agentRisk');
    const verificationEl = el('agentVerification');
    const healthLabel = healthLabels[status.health] || '';
    const modelLabel = [status.provider, status.model].filter(Boolean).join(' · ');
    const approvalLabel = approvalLabels[status.approvalState] || '';
    const riskLabel = [status.riskLevel, approvalLabel].filter(Boolean).join(' · ');

    healthEl.textContent = healthLabel ? '런타임 ' + healthLabel : '';
    healthEl.className = status.health ? 'health-' + status.health : '';
    modelEl.textContent = modelLabel;
    riskEl.textContent = riskLabel;
    verificationEl.textContent = verificationLabels[status.verificationState] || '';
    verificationEl.title = status.verifiedAt || status.evidenceDigest || '';
    for (const item of [healthEl, modelEl, riskEl, verificationEl]) item.hidden = !item.textContent;

    const runtimeEl = el('agentRuntime');
    runtimeEl.hidden = ![healthEl, modelEl, riskEl, verificationEl].some((item) => !item.hidden);

    const alertEl = el('agentAlert');
    const waitingApproval = status.approvalState === 'pending';
    alertEl.hidden = !waitingApproval && !status.blocker;
    if (!alertEl.hidden) {
      el('agentAlertTitle').textContent = waitingApproval
        ? '한들 승인 대기' + (status.riskLevel ? ' · ' + status.riskLevel : '')
        : '진행 블로커';
      el('agentAlertBody').textContent = status.blocker
        || '외부 영향 또는 되돌리기 어려운 작업이라 확인이 필요합니다.';
    }
  }

  function renderCard(a) {
    cardEl.style.setProperty('--agent-color', cssHex(a.color));
    el('agentDot').style.background = cssHex(a.color);
    // build via DOM + textContent (no innerHTML) so future dynamic fields stay XSS-safe
    const nameEl = el('agentName');
    nameEl.textContent = a.name + ' ';
    const small = document.createElement('small');
    small.textContent = a.kor;
    nameEl.appendChild(small);
    el('agentFantasy').textContent = (a.emoji || '✦') + ' ' + (a.fantasy || '');
    el('agentRole').textContent = a.operationalRole || a.role || '';
    el('agentSoul').textContent = a.identitySummary || '';
    el('agentTagline').textContent = a.tagline ? '“' + a.tagline + '”' : '';
    el('agentChannel').textContent = a.channel || '';
    el('agentChannel').hidden = !a.channel;
    el('agentAutonomy').textContent = a.autonomy || '';
    el('agentAutonomy').hidden = !a.autonomy;
    renderResponsibilities(a);
    renderPersonaNotes(a);
    const stEl = el('agentState');
    const sc = statusColor(a.status.state);
    stEl.textContent = a.status.state;
    stEl.style.background = sc + '2e';   // themed tint behind the badge
    stEl.style.color = sc;
    el('agentTask').textContent = a.status.task || '—';
    el('agentUpdated').textContent = timeAgo(a.status.lastActivityAt || a.status.updatedAt);
    renderRuntime(a);

    const progressEl = el('agentProgress');
    const progress = Number.isFinite(a.status.progress)
      ? THREE.MathUtils.clamp(a.status.progress, 0, 1)
      : null;
    progressEl.hidden = progress === null;
    if (progress !== null) {
      const percent = Math.round(progress * 100);
      el('agentProgressText').textContent = `${percent}%`;
      el('agentProgressBar').style.width = `${percent}%`;
    }

    const resultEl = el('agentResult');
    const result = a.status.result;
    resultEl.hidden = !result;
    if (result) {
      el('agentResultTitle').textContent = result.title;
      el('agentResultSummary').textContent = result.summary || '';
      const resultUrl = publicResultUrl(result.url);
      if (resultUrl) {
        resultEl.href = resultUrl;
        resultEl.firstElementChild.textContent = 'RECENT RESULT ↗';
      } else {
        resultEl.removeAttribute('href');
        resultEl.firstElementChild.textContent = 'RECENT RESULT';
      }
    } else {
      resultEl.removeAttribute('href');
    }
    // house service shortcut — hidden when the agent has no configured service
    const svcBtn = el('agentServiceBtn');
    if (a.service) {
      svcBtn.hidden = false;
      svcBtn.textContent = `${a.service.icon || '🏠'} ${a.service.name} 보기`;
      svcBtn.onclick = () => { closeAgentCard(); openServicePanel(a); };
    } else {
      svcBtn.hidden = true;
    }
  }

  function openAgentCard(a, { focus = true } = {}) {
    closeVisitorPanels();
    closeTeamOverview();
    markVisitorStep('agent');
    openAgent = a;
    agentCardOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    renderCard(a);
    cardEl.classList.add('show');
    if (focus) ambientAudio.playEffect('open');
    setInteractiveState(cardEl, true);
    document.body.classList.add('agent-detail-open');
    if (!editMode && a.npc) {
      focusNpc = a.npc;
      focusSide = null;
      cameraTransitionMinClearance = Infinity;
      trackCameraTransition = true;
    }   // camera glides over
    if (focus) requestAnimationFrame(() => el('agentCardClose')?.focus());
  }
  function closeAgentCard(restoreFocus = false) {
    const wasOpen = cardEl.classList.contains('show');
    openAgent = null;
    cardEl.classList.remove('show');
    setInteractiveState(cardEl, false);
    document.body.classList.remove('agent-detail-open');
    focusNpc = null;                             // camera returns to the player
    focusSide = null;
    trackCameraTransition = false;
    if (restoreFocus && wasOpen) agentCardOpener?.isConnected && agentCardOpener.focus();
    agentCardOpener = null;
  }
  dashboardOpenAgentByIndex = (index) => {
    const agent = AGENTS[index];
    if (!agent) return;
    dashboardStopPatrol();
    closeServicePanel();
    setExperienceMode('dashboard');
    openAgentCard(agent);
  };

  function patrolRank(agent) {
    return {
      error: 5,
      review: 4,
      working: 3,
      complete: 2,
      idle: 1,
    }[agentActivityMode(agent.status)] || 0;
  }

  function syncPatrolUi() {
    patrolToggle?.setAttribute('aria-pressed', String(patrolEnabled));
    if (patrolStateEl) {
      patrolStateEl.textContent = patrolEnabled && patrolAgent
        ? `${patrolIndex + 1}/${patrolOrder.length} · ${patrolAgent.kor}`
        : '꺼짐';
    }
    for (const agent of AGENTS) {
      chips[agent.key]?.classList.toggle('patrol-current', patrolEnabled && agent === patrolAgent);
    }
    document.body.classList.toggle('patrol-active', patrolEnabled);
  }

  function stopPatrol() {
    if (!patrolEnabled && !patrolAgent) return;
    patrolEnabled = false;
    patrolTimer = 0;
    patrolAgent = null;
    syncPatrolUi();
  }

  function openNextPatrolAgent() {
    if (!patrolEnabled || !patrolOrder.length) return;
    patrolIndex = (patrolIndex + 1) % patrolOrder.length;
    patrolAgent = patrolOrder[patrolIndex];
    closeServicePanel();
    closeTeamOverview();
    closeVisitorPanels();
    openAgentCard(patrolAgent, { focus: false });
    patrolTimer = PATROL_SECONDS;
    syncPatrolUi();
  }

  function startPatrol() {
    setExperienceMode('dashboard');
    patrolOrder = AGENTS.slice().sort((a, b) => patrolRank(b) - patrolRank(a));
    patrolIndex = -1;
    patrolEnabled = patrolOrder.length > 0;
    openNextPatrolAgent();
  }

  dashboardStopPatrol = stopPatrol;
  dashboardUpdatePatrol = (dt) => {
    if (!patrolEnabled) return;
    if (editMode || experienceMode !== 'dashboard') { stopPatrol(); return; }
    patrolTimer -= dt;
    if (patrolTimer <= 0) openNextPatrolAgent();
    else if (patrolStateEl && patrolAgent) {
      patrolStateEl.textContent = `${patrolIndex + 1}/${patrolOrder.length} · ${Math.ceil(patrolTimer)}초`;
    }
  };
  dashboardPatrolState = () => ({
    enabled: patrolEnabled,
    agent: patrolAgent?.key || null,
    index: patrolIndex,
    total: patrolOrder.length,
    remaining: +Math.max(0, patrolTimer).toFixed(2),
  });
  patrolToggle?.addEventListener('click', () => {
    if (patrolEnabled) stopPatrol();
    else startPatrol();
  });
  cardEl.addEventListener('pointerdown', () => stopPatrol());
  el('agentCardClose').addEventListener('click', () => {
    stopPatrol();
    closeAgentCard(true);
  });
  dashboardCloseCard = closeAgentCard;           // movement input can close the card

  // ---- 팀 현황 바 (좌측): 여섯 공명자 칩 — 클릭하면 카드 ----
  for (const a of AGENTS) {
    const chip = document.createElement('button');
    chip.className = 'agent-chip';
    chip.dataset.agentKey = a.key;
    chip.style.setProperty('--agent-color', cssHex(a.color));
    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    dot.style.background = cssHex(a.color);
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = a.name;
    const state = document.createElement('span');
    state.className = 'chip-state';
    state.textContent = a.status.state;
    chip.append(dot, name, state);
    chip.addEventListener('click', () => {
      stopPatrol();
      openAgentCard(a);
    });
    barEl.appendChild(chip);
    chips[a.key] = chip;
  }
  function refreshBar() {
    for (const a of AGENTS) {
      const st = chips[a.key].querySelector('.chip-state');
      if (st) {
        st.textContent = a.status.state;
        st.style.color = statusColor(a.status.state);
      }
      // pulse the chip dot while the agent is actively working
      chips[a.key].classList.toggle('busy', isWorkingStatus(a.status.state));
    }
    if (openAgent) renderCard(openAgent);   // keep an open card in sync
  }

  // ---- 3D에서 에이전트 클릭 → 카드 (플레이 모드 전용) ----
  let clickStart = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (editMode || e.button !== 0) return;
    clickStart = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  });
  addEventListener('pointercancel', () => { clickStart = null; });
  addEventListener('pointerup', (e) => {
    if (editMode || !clickStart) return;
    if (e.pointerId !== clickStart.pointerId) { clickStart = null; return; }
    const moved = Math.hypot(e.clientX - clickStart.x, e.clientY - clickStart.y);
    clickStart = null;
    if (moved > 6 || e.target !== renderer.domElement) return;
    setPointerNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
    const roseHit = poleRose.visible && raycaster.intersectObject(poleRose, true)[0];
    if (roseHit && !raycaster.intersectObjects([planet, ...npcs.filter((npc) => npc.visible),
      ...editables.filter((item) => item.mesh.visible).map((item) => item.mesh)], true)
      .some((hit) => hit.distance < roseHit.distance - 0.01)) {
      openRoseStory(); return;
    }
    const boards = editables.filter((item) => item.data.type === 'resultBoard' && item.mesh.visible);
    const boardHits = raycaster.intersectObjects(boards.map((item) => item.mesh), true);
    if (boardHits.length && !raycaster.intersectObjects([planet, ...npcs, ...editables.filter((item) => item.data.type !== 'resultBoard' && item.mesh.visible)
      .map((item) => item.mesh)], true).some((hit) => hit.distance < boardHits[0].distance)) {
      villageBoard.open(); return;
    }
    const hits = raycaster.intersectObjects(npcs, true);
    if (hits.length) {
      let obj = hits[0].object;
      while (obj && !npcs.includes(obj)) obj = obj.parent;
      if (obj && obj.userData.agent) { openAgentCard(obj.userData.agent); return; }
    }
    // no agent under the pointer → try their houses (집 클릭 = 서비스 패널)
    const homes = AGENTS.filter(a => a.home?.mesh);
    const homeHits = raycaster.intersectObjects(homes.map(a => a.home.mesh), true);
    if (!homeHits.length) return;
    let obj = homeHits[0].object;
    while (obj) {
      const owner = homes.find(a => a.home.mesh === obj);
      if (owner) { openServicePanel(owner); return; }
      obj = obj.parent;
    }
  });

  const clean = cleanPublicText;
  const isRecord = isPublicRecord;

  const makeTeamElement = (tag, className = '', text = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const taskStatusLabel = {
    queued: '대기',
    running: '진행',
    blocked: '막힘',
    waiting_approval: '승인 대기',
    verifying: '검증',
    completed: '완료',
    failed: '오류',
    cancelled: '취소',
  };
  const isQuietAgent = (agent) => /대기|휴식|오프라인|상태 미확인/.test(agent.status.state || '');
  function agentTaskStatus(agent) {
    if (agent.status.approvalState === 'pending') return 'waiting_approval';
    if (agent.status.blocker) return 'blocked';
    if (/오류|에러|실패/.test(agent.status.state || '')) return 'failed';
    if (/검증|리뷰/.test(agent.status.state || '')) return 'verifying';
    if (/완료/.test(agent.status.state || '')) return 'completed';
    if (isWorkingStatus(agent.status.state)) return 'running';
    return 'queued';
  }
  function currentTasks() {
    if (dashboardView.publicationMode === 'live' && (!lastStatusReceivedAt || dashboardView.isStale)) return [];
    if (dashboardView.tasks.length) return dashboardView.tasks;
    return AGENTS.filter((agent) => !isQuietAgent(agent)).map((agent) => ({
      id: agent.status.currentTaskId || '',
      title: agent.status.task || '현재 작업',
      ownerAgent: agent.key,
      requester: null,
      status: agentTaskStatus(agent),
      parentIds: [],
      dependencyIds: [],
      riskLevel: agent.status.riskLevel,
      approvalState: agent.status.approvalState,
      verifier: null,
      progress: agent.status.progress,
      updatedAt: agent.status.lastActivityAt || agent.status.updatedAt,
    }));
  }
  function pendingApprovals() {
    const items = dashboardView.approvals.filter((approval) => approval.status === 'pending').slice();
    for (const agent of AGENTS) {
      if (agent.status.approvalState !== 'pending') continue;
      const exists = items.some((approval) =>
        approval.requestedBy === agent.key
        && (!approval.taskId || approval.taskId === agent.status.currentTaskId)
      );
      if (exists) continue;
      items.push({
        id: '',
        taskId: agent.status.currentTaskId,
        requestedBy: agent.key,
        riskLevel: agent.status.riskLevel || 'L4',
        status: 'pending',
        actionSummary: agent.status.task || '승인 필요한 작업',
        impactSummary: agent.status.blocker || '승인 전까지 실행이 보류됩니다.',
        rollbackSummary: null,
        requestedAt: agent.status.lastActivityAt || agent.status.updatedAt,
      });
    }
    return items.slice(0, 12);
  }
  function currentFleetSummary(approvalCount = pendingApprovals().length) {
    return summarizeFleet({
      agents: AGENTS.map((agent) => ({
        key: agent.key,
        name: agent.name,
        kor: agent.kor,
        role: agent.role,
        color: agent.color,
        state: agent.status.state,
        task: agent.status.task,
        health: agent.status.health,
        updatedAt: agent.status.updatedAt,
      })),
      reportedAgentKeys: [...reportedAgentKeys],
      publicationMode: dashboardView.publicationMode,
      connectionState,
      isStale: dashboardView.isStale,
      approvalCount,
    });
  }
  function renderOperationalSummary(fleet = currentFleetSummary()) {
    if (opsFleetEl) opsFleetEl.textContent = fleet.coverageLabel;
    if (opsActiveEl) opsActiveEl.textContent = String(fleet.active);
    if (opsApprovalEl) opsApprovalEl.textContent = String(fleet.approvalCount);
    if (opsPipelineEl) opsPipelineEl.textContent = fleet.stateLabel;
    if (opsLinkEl) opsLinkEl.dataset.state = fleet.state;
    if (opsLinkDetailEl) {
      opsLinkDetailEl.textContent = dashboardView.publicationMode === 'static-demo'
        ? 'sample'
        : ({ live: 'stream', polling: 'poll', loading: 'bridge', offline: 'retry' })[connectionState] || 'bridge';
    }
    opsBeaconFleetSummary = fleet;
    syncOpsBeaconStatusVisuals(fleet);
  }
  function renderTeamNetwork(fleet) {
    const container = el('teamNetwork');
    if (!container) return;
    container.replaceChildren();
    const summary = el('teamNetworkSummary');
    if (summary) {
      summary.textContent = dashboardView.publicationMode === 'static-demo'
        ? `${fleet.expected}명 샘플`
        : `${fleet.linked} / ${fleet.expected} 연결`;
    }
    const linkLabels = {
      demo: '샘플', online: '연결', degraded: '확인', missing: '누락',
      stale: '만료', offline: '중단', error: '오류', ready: '준비',
    };
    for (const row of fleet.rows) {
      const article = makeTeamElement('article', `team-network-agent state-${row.linkState}`);
      article.dataset.agent = row.key;
      const identity = makeTeamElement('div', 'team-network-identity');
      const dot = makeTeamElement('i');
      dot.style.background = Number.isFinite(row.color) ? cssHex(row.color) : '#8ea3a5';
      const nameWrap = makeTeamElement('span');
      nameWrap.append(
        makeTeamElement('strong', '', row.kor || row.name),
        makeTeamElement('small', '', clean(row.role, 52) || row.key),
      );
      identity.append(dot, nameWrap);
      const activity = makeTeamElement('div', 'team-network-activity');
      activity.append(
        makeTeamElement('strong', '', clean(row.state, 32) || '상태 미확인'),
        makeTeamElement('small', '', clean(row.task, 80) || (row.updatedAt ? timeAgo(row.updatedAt) : '공개 작업 정보 없음')),
      );
      const link = makeTeamElement('span', `team-network-link state-${row.linkState}`, linkLabels[row.linkState] || '확인');
      article.append(identity, activity, link);
      container.appendChild(article);
    }
  }
  function renderTeamEmpty(container, icon, title, copy) {
    const empty = makeTeamElement('div', 'team-empty');
    empty.append(
      makeTeamElement('span', 'team-empty-icon', icon),
      makeTeamElement('strong', '', title),
      makeTeamElement('small', '', copy),
    );
    container.appendChild(empty);
  }
  function renderTeamHandoffs() {
    const container = el('teamHandoffs');
    if (!container) return;
    container.replaceChildren();
    const routes = Array.isArray(TEAM_CONFIG.handoffs) ? TEAM_CONFIG.handoffs.slice(0, 6) : [];
    if (!routes.length) {
      renderTeamEmpty(container, '↔', '등록된 핸드오프 없음', 'config/agents.json에서 팀 흐름을 정의할 수 있습니다.');
      return;
    }
    for (const route of routes) {
      if (!isRecord(route)) continue;
      const row = makeTeamElement('div', 'team-handoff');
      const path = makeTeamElement('div', 'team-handoff-path');
      const keys = [route.from, route.via, route.to].filter(Boolean);
      keys.forEach((key, index) => {
        const agent = agentByKey.get(key);
        const node = makeTeamElement(
          'span',
          'team-handoff-node',
          (agent?.emoji || '•') + ' ' + (agent?.name || key),
        );
        if (agent) node.style.setProperty('--node-color', cssHex(agent.color));
        path.appendChild(node);
        if (index < keys.length - 1) path.appendChild(makeTeamElement('i', '', '→'));
      });
      row.append(path, makeTeamElement('small', '', clean(route.label, 80) || 'handoff'));
      container.appendChild(row);
    }
  }
  function renderTeamTasks(tasks) {
    const container = el('teamTaskList');
    if (!container) return;
    container.replaceChildren();
    el('teamTaskCount').textContent = tasks.length + (tasks.length === 1 ? ' task' : ' tasks');
    if (!tasks.length) {
      const copy = dashboardView.publicationMode === 'static-demo'
        ? 'Hermes 연결 후 공개 승인된 작업만 이곳에 표시됩니다.'
        : '공개 승인된 작업이 생기면 이곳에 흐름이 나타납니다.';
      renderTeamEmpty(container, '☕', '공개된 작업 없음', copy);
      return;
    }
    for (const task of tasks.slice(0, 8)) {
      const owner = agentByKey.get(task.ownerAgent);
      const article = makeTeamElement('article', 'team-task status-' + task.status);
      const top = makeTeamElement('div', 'team-task-top');
      const ownerLabel = makeTeamElement('span', 'team-task-owner');
      const dot = makeTeamElement('i');
      dot.style.background = owner ? cssHex(owner.color) : '#9ba9a7';
      ownerLabel.append(dot, document.createTextNode((owner?.emoji || '•') + ' ' + (owner?.name || task.ownerAgent || 'Unassigned')));
      const state = makeTeamElement('span', 'team-task-status status-' + task.status, taskStatusLabel[task.status] || task.status);
      top.append(ownerLabel, state);
      article.append(top, makeTeamElement('strong', 'team-task-title', task.title));

      const meta = makeTeamElement('div', 'team-task-meta');
      if (task.riskLevel) meta.appendChild(makeTeamElement('span', 'risk-' + task.riskLevel.toLowerCase(), task.riskLevel));
      const verifier = agentByKey.get(task.verifier);
      if (task.verifier) meta.appendChild(makeTeamElement('span', '', (verifier?.name || task.verifier) + ' 검증'));
      if (task.dependencyIds.length) meta.appendChild(makeTeamElement('span', '', '의존 ' + task.dependencyIds.length));
      const updated = timeAgo(task.updatedAt);
      if (updated) meta.appendChild(makeTeamElement('span', '', updated.replace(' 갱신', '')));
      if (meta.childElementCount) article.appendChild(meta);

      if (Number.isFinite(task.progress)) {
        const progress = makeTeamElement('div', 'team-task-progress');
        const bar = makeTeamElement('i');
        bar.style.width = Math.round(task.progress * 100) + '%';
        progress.append(makeTeamElement('span', '', Math.round(task.progress * 100) + '%'), bar);
        article.appendChild(progress);
      }
      container.appendChild(article);
    }
  }
  function renderTeamApprovals(approvals) {
    const container = el('teamApprovalList');
    if (!container) return;
    container.replaceChildren();
    if (!approvals.length) {
      renderTeamEmpty(container, '✓', '승인 대기 없음', 'L4 작업이 생기면 영향과 롤백 정보를 보여줍니다.');
      return;
    }
    for (const approval of approvals.slice(0, 8)) {
      const requester = agentByKey.get(approval.requestedBy);
      const article = makeTeamElement('article', 'team-approval');
      const top = makeTeamElement('div', 'team-approval-top');
      top.append(
        makeTeamElement('span', '', (requester?.emoji || '•') + ' ' + (requester?.name || approval.requestedBy || 'Rodi')),
        makeTeamElement('b', '', approval.riskLevel || 'L4'),
      );
      article.append(top, makeTeamElement('strong', '', approval.actionSummary));
      if (approval.impactSummary) article.appendChild(makeTeamElement('p', '', approval.impactSummary));
      if (approval.rollbackSummary) article.appendChild(makeTeamElement('small', '', 'ROLLBACK · ' + approval.rollbackSummary));
      container.appendChild(article);
    }
  }
  function resolvedTeamHealth() {
    if (dashboardView.teamHealth) return dashboardView.teamHealth;
    const health = AGENTS.map((agent) => agent.status.health).filter(Boolean);
    if (!health.length) return null;
    if (health.includes('error')) return 'error';
    if (health.includes('degraded')) return 'degraded';
    if (health.every((value) => value === 'offline')) return 'offline';
    if (health.includes('unknown')) return 'unknown';
    if (health.includes('offline')) return 'degraded';
    return 'healthy';
  }
  function renderTeamOverview() {
    if (!teamPanelEl) return;
    const tasks = currentTasks();
    const approvals = pendingApprovals();
    const fleet = currentFleetSummary(approvals.length);
    const activeTaskStates = new Set(['running', 'blocked', 'waiting_approval', 'verifying']);
    const taskOwners = new Set(
      tasks.filter((task) => activeTaskStates.has(task.status) && task.ownerAgent)
        .map((task) => task.ownerAgent)
    );
    const activeAgents = AGENTS.filter((agent) =>
      !isQuietAgent(agent) && agentTaskStatus(agent) !== 'completed'
    ).length;
    const activeCount = Math.max(activeAgents, taskOwners.size, fleet.active);
    const health = resolvedTeamHealth();
    const fleetHealth = ({
      healthy: health,
      loading: 'unknown',
      degraded: 'degraded',
      incomplete: 'degraded',
      stale: 'degraded',
      error: 'error',
      offline: 'offline',
    })[fleet.state] || health;
    const healthLabel = dashboardView.publicationMode === 'static-demo' ? '미연결' : ({
      healthy: '정상',
      degraded: '주의',
      error: '오류',
      offline: '중단',
      unknown: '미확인',
    }[fleetHealth] || '미확인');

    const teamSummary = TEAM_CONFIG.systemSummary || '역할이 분리된 에이전트 팀의 현재 흐름입니다.';
    el('teamPanelSummary').textContent = dashboardView.publicationMode === 'static-demo'
      ? `${teamSummary} 현재 표시는 공개용 정적 샘플입니다.`
      : teamSummary;
    const source = dashboardView.publicationMode === 'static-demo'
      ? (RUNTIME_CONFIG.publication?.label || '정적 데모')
      : `v${dashboardView.schemaVersion || '?'} · ${dashboardView.source || 'bridge'}`;
    el('teamPanelSource').textContent = source;
    el('teamPanelSource').title = dashboardView.sourceGeneratedAt || 'Hermes bridge 연결 전';
    el('teamMetricAgents').textContent = String(AGENTS.length);
    el('teamMetricActive').textContent = String(activeCount);
    el('teamMetricApprovals').textContent = String(approvals.length);
    el('teamMetricHealth').textContent = healthLabel;
    el('teamMetricHealth').dataset.health = fleetHealth || 'ready';

    if (teamApprovalBadge) {
      teamApprovalBadge.hidden = approvals.length === 0;
      teamApprovalBadge.textContent = String(approvals.length);
    }
    teamOverviewBtn?.classList.toggle('has-approval', approvals.length > 0);
    teamOverviewBtn?.setAttribute(
      'aria-label',
      approvals.length ? '팀 흐름 열기, 승인 대기 ' + approvals.length + '건' : '팀 흐름 열기',
    );
    renderOperationalSummary(fleet);
    renderTeamNetwork(fleet);
    renderTeamHandoffs();
    renderTeamTasks(tasks);
    renderTeamApprovals(approvals);
  }

  function applyAgentStatus(data, meta = {}) {
    if (!data || typeof data !== 'object') return;
    lastStatusReceivedAt = new Date().toISOString();
    reportedAgentKeys = new Set(Object.keys(data).filter((key) => agentByKey.has(key)));
    dashboardView = normalizePublicDashboardView({
      ...meta,
      publicationMode: meta.publicationMode || RUNTIME_CONFIG.publication?.mode,
    }, [...agentByKey.keys()], {
      ttlMs: RUNTIME_CONFIG.status.freshnessTtlMs || 180000,
      maxFutureSkewMs: RUNTIME_CONFIG.status.maxFutureSkewMs || 300000,
    });
    if (!dashboardView.isStale) lastRecoveryAttemptAt = 0;
    lastStatusGeneratedAt = dashboardView.sourceGeneratedAt;
    for (const a of AGENTS) {
      if (dashboardView.publicationMode === 'live' && dashboardView.isStale) {
        setUnknownPublicStatus(a);
        continue;
      }
      const s = data[a.key];
      if (!isRecord(s)) {
        if (dashboardView.publicationMode === 'live') {
          setUnknownPublicStatus(a, '공개 상태가 제공되지 않았습니다.');
        }
        continue;
      }
      const normalized = normalizePublicAgentStatus(s, {
        publicationMode: dashboardView.publicationMode,
      });
      if (!normalized) continue;
      if (dashboardView.publicationMode === 'live') {
        a.status.state = normalized.state || '상태 미확인';
        a.status.task = normalized.task || '공개 작업 정보 없음';
      } else {
        if (normalized.state) a.status.state = normalized.state;
        if (normalized.task !== null) a.status.task = normalized.task;
      }
      const resultProjection = selectPublicResultProjection(s, {
        publicationMode: dashboardView.publicationMode,
      });
      a.status.updatedAt = normalized.updatedAt;
      a.status.progress = normalized.progress;
      a.status.result = normalizePublicResult(resultProjection.result);
      a.status.results = normalizePublicResults(resultProjection.results);
      a.status.health = normalized.health;
      a.status.model = normalized.model;
      a.status.provider = normalized.provider;
      a.status.blocker = normalized.blocker;
      a.status.approvalState = normalized.approvalState;
      a.status.riskLevel = normalized.riskLevel;
      a.status.currentTaskId = normalized.publicTaskId;
      a.status.lastActivityAt = normalized.lastActivityAt;
      a.status.verificationState = normalized.verificationState;
      a.status.verifiedAt = normalized.verifiedAt;
      a.status.evidenceDigest = normalized.evidenceDigest;
    }
    ambientAudio.observeAgentStates(AGENTS);
    document.body.dataset.statusSchema = String(meta.schemaVersion ?? 0);
    refreshBar();
    renderTeamOverview();
    syncAgentHomeStatusVisuals();
    refreshOpenServicePanel();
    refreshRecentResultsUi();
    renderConnectionBadge();
    renderStatusFreshness();
  }
  renderTeamOverview();
  refreshRecentResultsUi();
  statusSource = createAgentStatusSource({
    config: RUNTIME_CONFIG.status,
    onSnapshot: applyAgentStatus,
    onConnectionChange(state) {
      connectionState = state;
      renderConnectionBadge();
      renderStatusFreshness();
      renderTeamOverview();
    },
  });
  refreshBtn?.addEventListener('click', async () => {
    if (refreshBtn.classList.contains('refreshing')) return;
    refreshBtn.classList.add('refreshing');
    refreshBtn.disabled = true;
    const [statusOk, resultsOk] = await Promise.all([
      statusSource?.refresh() ?? false,
      refreshPublicResults(),
    ]);
    refreshBtn.classList.remove('refreshing');
    refreshBtn.disabled = false;
    showAppNotice(statusOk || resultsOk ? '상태와 결과를 새로 확인했습니다.' : '새로고침하지 못했습니다. 연결을 확인해주세요.');
  });
  setInterval(renderStatusFreshness, 15000);
})();

// ===========================================================================
// HOUSE SERVICES — 각 집은 서비스의 현관이다. 문 앞에 서면 입장 프롬프트가
// 뜨고(F / 탭), 집을 클릭해도 열린다. 어떤 집이 어떤 서비스인지는
// config/services.json에서 편집한다. url이 있으면 온라인 확인 후 열기/미리보기,
// 없으면 '준비 중'으로 표시.
// ===========================================================================
(function wireHouseServices() {
  const panelEl = document.getElementById('servicePanel');
  const promptEl = document.getElementById('enterPrompt');
  if (!panelEl || !promptEl) return;

  const el = (id) => document.getElementById(id);
  const frameWrap = el('serviceFrameWrap');
  const serviceTabBtn = el('serviceTabBtn');
  const resultsTabBtn = el('resultsTabBtn');
  const servicePane = el('servicePane');
  const resultsPane = el('resultsPane');
  const mobileInteractBtn = el('mobileInteractBtn');
  let openFor = null;          // agent whose panel is open
  let nearAgent = null;        // agent whose door we're standing at
  let nearBoat = null;
  let interactionPromptKey = '';
  let servicePanelOpener = null;
  let reachSeq = 0;

  // ---- reachability: opaque no-cors fetch — resolve = something answered ----
  function checkReachable(url, cb) {
    const seq = ++reachSeq;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2500);
    fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      .then(() => { if (seq === reachSeq) cb(true); })
      .catch(() => { if (seq === reachSeq) cb(false); })
      .finally(() => clearTimeout(to));
  }

  function setOnlineBadge(state) {   // checking | online | offline | planned | external | private
    const badge = el('serviceOnline');
    badge.className = 'service-online ' + state;
    badge.textContent = {
      checking: '확인 중…', online: '● 온라인', offline: '● 오프라인',
      planned: '준비 중', external: '↗ 외부 링크', private: '개인 네트워크',
    }[state];
  }

  function setServiceTab(tab, focus = false) {
    const showResults = tab === 'results';
    serviceTabBtn?.classList.toggle('active', !showResults);
    resultsTabBtn?.classList.toggle('active', showResults);
    serviceTabBtn?.setAttribute('aria-selected', String(!showResults));
    resultsTabBtn?.setAttribute('aria-selected', String(showResults));
    serviceTabBtn?.setAttribute('tabindex', showResults ? '-1' : '0');
    resultsTabBtn?.setAttribute('tabindex', showResults ? '0' : '-1');
    if (servicePane) servicePane.hidden = showResults;
    if (resultsPane) resultsPane.hidden = !showResults;
    if (focus) (showResults ? resultsTabBtn : serviceTabBtn)?.focus();
  }

  function makeResultText(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function renderHomeResults(a) {
    const results = mergePublicResults(
      a.status.result,
      a.status.results,
      a.results,
    );
    const space = a.resultSpace && typeof a.resultSpace === 'object' ? a.resultSpace : {};
    el('resultSpaceName').textContent = space.name || `${a.kor}의 결과 공간`;
    el('resultSpaceSummary').textContent = space.summary || '최근 공개 결과를 조용히 모아보는 집입니다.';
    el('resultSpaceCount').textContent = `${results.length} / 6`;
    el('resultTabCount').textContent = String(results.length);
    resultsTabBtn?.setAttribute('aria-label', `최근 결과 ${results.length}건`);

    const list = el('homeResultList');
    list.replaceChildren();
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'home-result-empty';
      empty.append(
        makeResultText('span', '', '◇'),
        makeResultText('strong', '', '아직 공개된 결과가 없습니다'),
        makeResultText('small', '', '헤르메스가 공개 가능한 결과를 남기면 이 집에 최대 6개까지 조용히 쌓입니다.'),
      );
      list.appendChild(empty);
      return;
    }

    for (const result of results) {
      const safeUrl = publicResultUrl(result.url);
      const card = document.createElement(safeUrl ? 'a' : 'article');
      card.className = 'home-result-card';
      card.style.setProperty('--agent-color', cssHex(a.color));
      if (safeUrl) {
        card.href = safeUrl;
        card.target = '_blank';
        card.rel = 'noopener noreferrer';
      }
      const kind = resultKindMeta(result.kind);
      const meta = document.createElement('div');
      meta.className = 'home-result-meta';
      meta.append(
        makeResultText('span', 'home-result-kind', `${kind.icon} ${kind.label}`),
        makeResultText('span', 'home-result-status', resultStatusLabel(result.status)),
      );
      const date = formatResultDate(result.updatedAt);
      if (date) {
        const time = makeResultText('time', 'home-result-date', date);
        time.dateTime = result.updatedAt;
        meta.appendChild(time);
      }
      card.append(meta, makeResultText('h4', '', result.title));
      if (result.summary) card.appendChild(makeResultText('p', '', result.summary));
      if (safeUrl) card.appendChild(makeResultText('span', 'home-result-link', '↗'));
      list.appendChild(card);
    }
  }

  serviceTabBtn?.addEventListener('click', () => setServiceTab('service'));
  resultsTabBtn?.addEventListener('click', () => setServiceTab('results'));
  for (const button of [serviceTabBtn, resultsTabBtn]) {
    button?.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setServiceTab(button === serviceTabBtn ? 'results' : 'service', true);
    });
  }

  openServicePanel = function (a, { tab = 'service' } = {}) {
    ambientAudio.playEffect('open');
    dashboardStopPatrol();
    closeVisitorPanels();
    dashboardCloseTeam();
    markVisitorStep('service');
    servicePanelOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openFor = a;
    const svc = a.service;
    panelEl.style.setProperty('--agent-color', cssHex(a.color));
    el('serviceIcon').textContent = svc?.icon || '🏠';
    el('serviceName').textContent = svc ? svc.name : `${a.kor}의 집`;
    el('serviceOwner').textContent = `${a.kor}의 집`;
    el('serviceDesc').textContent = svc ? (svc.desc || '') : '이 집엔 아직 서비스가 등록되지 않았어요. config/services.json에서 추가할 수 있습니다.';
    const openBtn = el('serviceOpenBtn');
    const url = svc?.url?.trim();
    let parsedUrl = null;
    try {
      if (url) parsedUrl = new URL(url, location.href);
      if (parsedUrl && !['http:', 'https:'].includes(parsedUrl.protocol)) parsedUrl = null;
    } catch (_) { /* invalid service URL */ }
    const localOnly = parsedUrl && LOCAL_HOSTS.has(parsedUrl.hostname);
    const privateOnPublic = !!(localOnly && !IS_LOCAL_RUNTIME);
    const crossOrigin = !!(parsedUrl && parsedUrl.origin !== location.origin);
    const note = privateOnPublic
      ? '이 서비스는 운영자의 개인 네트워크에서만 연결됩니다.'
      : (svc?.note || '');
    el('serviceNote').textContent = note;
    el('serviceNote').hidden = !note;

    if (parsedUrl && !privateOnPublic) {
      openBtn.hidden = false;
      openBtn.onclick = () => window.open(parsedUrl.href, '_blank', 'noopener');
      if (crossOrigin && !IS_LOCAL_RUNTIME) setOnlineBadge('external');
      else {
        setOnlineBadge('checking');
        checkReachable(parsedUrl.href, (ok) => setOnlineBadge(ok ? 'online' : 'offline'));
      }
    } else if (privateOnPublic) {
      openBtn.hidden = true;
      setOnlineBadge('private');
    } else {
      openBtn.hidden = true;
      setOnlineBadge('planned');
    }

    // embedded preview — only for services that opt in (local apps)
    frameWrap.textContent = '';
    frameWrap.hidden = true;
    if (parsedUrl && !privateOnPublic && svc.embed && (!crossOrigin || IS_LOCAL_RUNTIME)) {
      const iframe = document.createElement('iframe');
      iframe.src = parsedUrl.href;
      iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-pointer-lock');
      iframe.title = svc.name;
      frameWrap.appendChild(iframe);
      frameWrap.hidden = false;
    }

    renderHomeResults(a);
    setServiceTab(tab);

    panelEl.classList.add('show');
    panelEl.inert = false;
    panelEl.setAttribute('aria-hidden', 'false');
    document.body.classList.add('service-detail-open');
    dashboardCloseCard();                        // one overlay at a time
    requestAnimationFrame(() => el('serviceClose')?.focus());
  };
  closeServicePanel = function (restoreFocus = false) {
    if (!openFor) return;
    const closingAgent = openFor;
    openFor = null;
    panelEl.classList.remove('show');
    panelEl.inert = true;
    panelEl.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('service-detail-open');
    frameWrap.textContent = '';                  // stop any embedded app
    if (restoreFocus) {
      const fallback = document.querySelector(`[data-agent-key="${closingAgent.key}"]`);
      const target = servicePanelOpener?.isConnected && !servicePanelOpener.closest('[inert]')
        ? servicePanelOpener
        : fallback;
      target?.focus();
    }
    servicePanelOpener = null;
  };
  refreshOpenServicePanel = () => { if (openFor) renderHomeResults(openFor); };
  el('serviceClose').addEventListener('click', () => closeServicePanel(true));

  // ---- 입장 프롬프트 (문 앞 감지는 메인 루프가 매 프레임 호출) ----
  // The trigger follows the actual front-door offset, not the building center.
  // This keeps the passing loop quiet while leaving a comfortable tap radius.
  const ENTER_ANGLE = 0.18;
  updateServiceProximity = function () {
    let best = null, bestD = ENTER_ANGLE;
    let boat = activeBoatItem;
    if (!editMode && !openFor && experienceMode === 'explore') {
      if (!boat) boat = nearestBoardableBoat();
      if (!boat) {
        for (const a of AGENTS) {
          const doorDir = homeDoorDir(a.home);
          if (!doorDir) continue;
          const d = playerDir.angleTo(doorDir);
          if (d < bestD) { best = a; bestD = d; }
        }
      }
    }
    const promptKey = activeBoatItem ? 'boat-exit' : boat ? 'boat-enter' : best?.key || '';
    nearAgent = best;
    nearBoat = boat;
    if (promptKey === interactionPromptKey) return;
    interactionPromptKey = promptKey;
    if (mobileInteractBtn) {
      mobileInteractBtn.disabled = !promptKey;
      const label = activeBoatItem
        ? '배에서 내리기'
        : boat
          ? '어선 승선'
          : best
            ? (best.service?.name || best.kor + '의 집') + ' 입장'
            : '가까운 집 또는 배 이용';
      mobileInteractBtn.setAttribute('aria-label', label);
      mobileInteractBtn.title = label;
      const icon = mobileInteractBtn.querySelector('span');
      if (icon) icon.textContent = activeBoatItem || boat ? '⛵' : '⌂';
    }
    if (activeBoatItem || boat) {
      promptEl.textContent = '';
      const icon = document.createElement('span');
      icon.textContent = '⛵ ';
      const label = document.createElement('b');
      label.textContent = activeBoatItem ? '배에서 내리기' : '어선 승선';
      const hint = document.createElement('span');
      hint.className = 'enter-key';
      hint.textContent = activeBoatItem ? 'F 하선' : 'F 승선';
      promptEl.append(icon, label, hint);
      promptEl.classList.add('show');
      promptEl.tabIndex = 0;
      setInteractiveState(promptEl, true);
    } else if (best) {
      const svc = best.service;
      promptEl.textContent = '';
      const door = document.createElement('span');
      door.textContent = svc ? `${svc.icon || '🚪'} ` : '🚪 ';
      const label = document.createElement('b');
      label.textContent = svc ? svc.name : `${best.kor}의 집`;
      const hint = document.createElement('span');
      hint.className = 'enter-key';
      hint.textContent = 'F 입장';
      promptEl.append(door, label, hint);
      promptEl.classList.add('show');
      promptEl.tabIndex = 0;
      setInteractiveState(promptEl, true);
    } else {
      promptEl.classList.remove('show');
      promptEl.tabIndex = -1;
      setInteractiveState(promptEl, false);
    }
  };
  activateNearbyService = () => {
    if (editMode || openFor || villageBoard.isOpen() || roseStory.isOpen() || experienceMode !== 'explore') return false;
    if (activeBoatItem) return disembarkBoat();
    if (nearBoat) return boardBoat(nearBoat);
    if (!nearAgent) return false;
    openServicePanel(nearAgent);
    return true;
  };
  promptEl.addEventListener('click', activateNearbyService);
  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    // Korean IMEs may report either the consonant or Process with KeyF.
    const boatKey = (activeBoatItem || nearBoat) && (k === '\u3139' || e.code === 'KeyF');
    if ((k === 'f' || boatKey) && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey
        && !isUiInteractionTarget(e.target)) activateNearbyService();
    else if (k === 'escape') closeServicePanel(true);
  });
})();

// ---------------------------------------------------------------------------
// Dev hook (open with ?dev=1) — tiny console API for inspecting the planet:
//   devPlanet.teleport(x, y, z)      → drop the player at a sphere direction
//   devPlanet.aimEditCamera(x, y, z) → point the edit camera at a direction
// Handy for checking far-side builds without walking half the globe.
// ---------------------------------------------------------------------------
if (URL_PARAMS.has('dev')) {
  const reviewOrbit = Number(URL_PARAMS.get('qaOrbit'));
  if (Number.isFinite(reviewOrbit)) dashboardYaw = wrappedAngle(reviewOrbit);
  if (URL_PARAMS.get('qaPole') === 'south') {
    DASHBOARD_VIEW_DIR.set(0, -1, 0);
    DASHBOARD_VIEW_FORWARD.set(0, 0, 1);
  }
  if (URL_PARAMS.get('qaView') === 'dashboard') {
    queueMicrotask(() => startBtn.click());
  } else if (URL_PARAMS.get('qaView') === 'explore') {
    queueMicrotask(() => document.getElementById('exploreModeBtn')?.click());
  } else if (URL_PARAMS.get('qaView') === 'rose') {
    queueMicrotask(() => {
      beginGame('explore', { cinematic: false });
      commitPlayerSurfaceDirection(offsetSurfaceDir(NORTH_POLE, new THREE.Vector3(1, 0, 0), 0.20));
      playerForward.copy(NORTH_POLE).addScaledVector(playerDir, -NORTH_POLE.dot(playerDir)).normalize();
      camDir.copy(playerForward);
      camDist = 7;
      camPitch = 0.42;
    });
  }
  const objectScreenState = (object, opacity = 1) => {
    const ndc = object.getWorldPosition(new THREE.Vector3()).project(camera);
    return {
      ndc: ndc.toArray().map(v => +v.toFixed(3)),
      inFrame: ndc.z >= -1 && ndc.z <= 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1,
      opacity: +opacity.toFixed(3),
    };
  };
  window.devPlanet = {
    teleport(x, y, z) {
      playerDir = new THREE.Vector3(x, y, z).normalize();
      return playerDir.toArray();
    },
    aimEditCamera(x, y, z) {
      editTargetDir = new THREE.Vector3(x, y, z).normalize();
      editYaw = 0;
      return editTargetDir.toArray();
    },
    // list placed props (optionally filtered by type) with rounded positions
    list(type) {
      return editables
        .filter(it => !type || it.data.type === type)
        .map(it => ({ type: it.data.type, n: it.dir.toArray().map(v => +v.toFixed(3)) }));
    },
    layoutAudit() {
      return currentLayoutAudit();
    },
    homeStreetAccessState() {
      const homes = editables.filter((item) => HOME_PROP_TYPES.has(item.data.type));
      const connections = homes.map((home) => {
        const link = drivewayConnections.find((item) => item.home === home);
        return {
          key: home.data.ownerKey || '',
          connected: !!link,
          streetType: link?.streetType || null,
          length: link ? +link.length.toFixed(3) : null,
        };
      });
      return {
        homes: homes.length,
        connected: connections.filter((item) => item.connected).length,
        longest: connections.reduce((max, item) => Math.max(max, item.length || 0), 0),
        connections,
        pass: homes.length === AGENTS.length
          && connections.every((item) => item.connected && item.length > 0.02 && item.length <= 2.2),
      };
    },
    roadClearanceState,
    sharedHarborState,
    operationsCore() {
      return editables
        .filter((item) => item.data.type === 'opsBeacon')
        .map((item) => {
          const beacon = item.mesh.userData.opsBeacon;
          return {
            n: item.dir.toArray().map((value) => +value.toFixed(3)),
            nodes: beacon?.nodes.map((node) => ({
              key: node.key,
              intensity: +node.material.emissiveIntensity.toFixed(2),
            })) || [],
            coreIntensity: +(beacon?.coreMaterial.emissiveIntensity || 0).toFixed(2),
          };
        });
    },
    // angular distance from the player to each actual front door
    doorProbe() {
      return AGENTS.map(a => homeDoorDir(a.home)
        ? { key: a.key, angle: +playerDir.angleTo(homeDoorDir(a.home)).toFixed(3) }
        : { key: a.key, home: false });
    },
    homes() {
      return AGENTS.map(a => ({
        key: a.key,
        ownerKey: a.home?.data?.ownerKey || null,
        n: a.home?.dir?.toArray().map(v => +v.toFixed(3)) || null,
      }));
    },
    agentActivities() {
      return AGENTS.map(a => ({
        key: a.key,
        style: a.npc?.userData.activitySignal?.userData.style || 'circuit',
        state: a.status.state,
        mode: agentActivityMode(a.status),
        visible: !!a.npc?.userData.activitySignal?.visible,
        parts: a.npc?.userData.activitySignal?.userData.parts?.length || 0,
        pose: a.npc?.userData.workPose || null,
      }));
    },
    characters() {
      return AGENTS.map((agent) => ({
        key: agent.key,
        character: agent.character,
        visualStyle: agent.npc?.userData.visualStyle || '',
        scale: +(agent.npc?.scale.x || 0).toFixed(2),
        labelHeight: agent.npc?.userData.labelHeight || null,
        childMeshes: agent.npc?.getObjectsByProperty('isMesh', true).length || 0,
      }));
    },
    districtState() {
      const infrastructureTypes = ['streetEdge', 'laneEdge', 'hedge', 'quayRail'];
      const paths = Object.fromEntries(infrastructureTypes.map((type) => [
        type,
        editablePaths.filter((item) => item.data.type === type).length,
      ]));
      const profiles = editables
        .filter((item) => item.data.type === 'cottage')
        .map((item) => item.mesh.userData.architectureProfile)
        .filter(Boolean);
      const homes = editables.filter((item) => item.data.ownerKey && HOME_PROP_TYPES.has(item.data.type));
      const distances = homes.flatMap((a, i) => homes.slice(i + 1).map((b) => a.dir.angleTo(b.dir) * R));
      const minimumHomeDistance = distances.length ? Math.min(...distances) : 0;
      const rearHemisphereHomes = homes.filter((home) => home.dir.dot(MAP_CENTER) < 0).length;
      return {
        paths,
        architectureProfiles: [...new Set(profiles)].sort(),
        cottageHomes: profiles.length,
        minimumHomeDistance: +minimumHomeDistance.toFixed(3),
        rearHemisphereHomes,
        homeDirections: homes.map((home) => ({ key: home.data.ownerKey, n: home.dir.toArray() })),
        pass: paths.streetEdge >= 2
          && paths.laneEdge >= 2
          && paths.hedge >= 2
          && paths.quayRail >= 2
          && new Set(profiles).size >= 3
          && minimumHomeDistance >= 6
          && rearHemisphereHomes >= 3,
      };
    },
    worldScaleState() {
      const visitorHeight = player.userData.modelHeight * player.scale.y;
      const homes = AGENTS
        .filter((agent) => agent.home?.data.type === 'cottage')
        .map((agent) => {
          const spec = agent.home.mesh.userData.scaleSpec;
          const agentHeight = agent.npc.userData.modelHeight * agent.npc.scale.y;
          return {
            key: agent.key,
            profile: spec?.profile || null,
            doorHeight: +(spec?.doorHeight || 0).toFixed(3),
            agentHeight: +agentHeight.toFixed(3),
            doorToAgent: spec ? +(spec.doorHeight / agentHeight).toFixed(2) : null,
          };
        });
      return {
        visitorHeight: +visitorHeight.toFixed(3),
        roadWidth: 0.90,
        laneWidth: 0.70,
        homes,
      };
    },
    mobilityState() {
      return AGENTS.map((agent) => {
        const dir = agent.npc?.userData?.dir;
        const clearance = dir ? surfaceColliderClearance(dir) : null;
        return {
          key: agent.key,
          blocked: dir ? isBlockedSurfaceDir(dir) : null,
          inWater: dir ? isInWaterDir(dir) : null,
          clearance: Number.isFinite(clearance) ? +(clearance * R).toFixed(3) : null,
          stuckFor: +(agent.npc?.userData?.stuckTime || 0).toFixed(3),
          homeDistance: dir && agent.home?.dir ? +(dir.angleTo(agent.home.dir) * R).toFixed(3) : null,
          workDistance: dir && agent.workDir ? +(dir.angleTo(agent.workDir) * R).toFixed(3) : null,
        };
      });
    },
    playerMobilityState() {
      const clearance = surfaceColliderClearance(playerDir);
      return {
        aboard: !!activeBoatItem,
        blocked: !hasSurfaceClearance(playerDir, PLAYER_CLEARANCE_RADIUS),
        terrainAllowed: playerSurfaceAllowed(playerDir),
        clearance: Number.isFinite(clearance) ? +(clearance * R).toFixed(3) : null,
        requiredClearance: +(PLAYER_CLEARANCE_RADIUS * R).toFixed(3),
        escapeOptions: playerEscapeOptionCount(playerDir),
        blockedFor: +playerBlockedFor.toFixed(3),
        recoveries: playerRecoveryCount,
        spawnDistance: +(playerDir.angleTo(DEFAULT_PLAYER_SPAWN_DIR) * R).toFixed(3),
      };
    },
    waterAccessState() {
      const boats = editables.filter((item) => item.data.type === 'fishingBoat');
      const sample = boats.find((item) => isWaterSurfaceDir(item.dir))?.dir || null;
      const footAllowed = sample ? playerSurfaceAllowed(sample, false) : null;
      const boatAllowed = sample ? playerSurfaceAllowed(sample, true) : null;
      return {
        boats: boats.length,
        sampleInWater: sample ? isWaterSurfaceDir(sample) : null,
        footAllowed,
        boatAllowed,
        aboard: !!activeBoatItem,
        pass: !!sample && !footAllowed && boatAllowed,
      };
    },
    marineEnvironmentState() {
      const marineTypes = new Set(['fishingBoat', 'harborBuoy', 'channelBeacon', 'cargoFerry']);
      const items = editables.filter((item) => marineTypes.has(item.data.type));
      const waterborne = items.filter((item) => isWaterSurfaceDir(item.dir));
      const mainBoat = items.find((item) => item.data.type === 'fishingBoat');
      return {
        objects: items.length,
        waterborne: waterborne.length,
        types: [...new Set(items.map((item) => item.data.type))].sort(),
        mainBoatScale: mainBoat?.data.scale ?? null,
        pass: items.length >= 4
          && waterborne.length === items.length
          && (mainBoat?.data.scale ?? 0) >= 1.25,
      };
    },
    testHarborJourney() {
      if (activeBoatItem) return { pass: false, reason: 'already-aboard' };
      const boat = editables.find((p) => p.data.type === 'fishingBoat' && isWaterSurfaceDir(p.dir));
      if (!boat) return { pass: false, reason: 'missing-boat' };
      const original = {
        player: playerDir.clone(), forward: playerForward.clone(), camera: camDir.clone(),
        safe: lastSafePlayerDir.clone(), boat: boat.dir.clone(), yaw: boat.data.yaw,
        visible: player.visible, label: player.userData.nameLabel?.enabled,
        jumpVel, jumpHeight, onGround, playerBlockedFor,
      };
      const stages = {};
      const travel = (points) => {
        if (!points) return false;
        for (const target of points) {
          for (let steps = 0; playerDir.angleTo(target) > 0.002; steps++) {
            if (steps > 400) return false;
            const angle = Math.min(0.012, playerDir.angleTo(target));
            const tangent = target.clone().sub(playerDir.clone().multiplyScalar(target.dot(playerDir)));
            if (!tryMovePlayerOnSurface(tangent, angle)) return false;
          }
        }
        if (activeBoatItem) syncActiveBoatTransform();
        return true;
      };
      try {
        commitPlayerSurfaceDirection(DEFAULT_PLAYER_SPAWN_DIR);
        stages.walkToPier = travel([mapDir(0, -0.40), mapDir(-0.28, -0.41), mapDir(-0.30, -0.68)]);
        if (!stages.walkToPier) return { pass: false, stages, reason: 'pier-approach-blocked' };
        stages.boardFromPier = nearestBoardableBoat() === boat && boardBoat(boat);
        if (!stages.boardFromPier) return { pass: false, stages, reason: 'boat-outside-pier-reach',
          boatDirection: boat.dir.toArray(), distanceFromPier: +(playerDir.angleTo(boat.dir) * R).toFixed(3) };
        const pierEnd = offsetSurfaceDir(HARBOR_REAR_LIGHTHOUSE_DIR,
          propFacing(HARBOR_REAR_LIGHTHOUSE_DIR, Math.PI), 0.68);
        const mooring = offsetSurfaceDir(pierEnd, tangentBasis(pierEnd).east, 0.16);
        const route = findSurfaceRoute(playerDir, mooring,
          (dir) => playerSurfaceAllowed(dir, true) && hasSurfaceClearance(dir, PLAYER_CLEARANCE_RADIUS));
        stages.sailToIsland = travel(route);
        if (!stages.sailToIsland) return { pass: false, stages, reason: 'island-route-blocked' };
        stages.landOnIsland = disembarkBoat({ notify: false });
        if (!stages.landOnIsland) return { pass: false, stages, reason: 'island-landing-blocked' };
        stages.reboard = nearestBoardableBoat() === boat && boardBoat(boat);
        if (!stages.reboard) return { pass: false, stages, reason: 'island-reboarding-blocked' };
        stages.sailHome = travel([...route].reverse());
        stages.landAtHarbor = stages.sailHome && disembarkBoat({ notify: false });
        if (!stages.landAtHarbor) return { pass: false, stages, reason: 'harbor-return-blocked' };
        stages.walkHome = travel(findSurfaceRoute(playerDir, DEFAULT_PLAYER_SPAWN_DIR,
          (dir) => playerSurfaceAllowed(dir, false) && hasSurfaceClearance(dir, PLAYER_CLEARANCE_RADIUS)));
        return { pass: Object.values(stages).every(Boolean), stages,
          routePoints: route.length, boatStartPreserved: true };
      } finally {
        activeBoatItem = null;
        boat.data.dir.copy(original.boat); boat.data.yaw = original.yaw; applyPropTransform(boat);
        playerDir.copy(original.player); playerForward.copy(original.forward); camDir.copy(original.camera);
        lastSafePlayerDir.copy(original.safe); player.visible = original.visible;
        if (player.userData.nameLabel) player.userData.nameLabel.enabled = original.label;
        jumpVel = original.jumpVel; jumpHeight = original.jumpHeight; onGround = original.onGround;
        playerBlockedFor = original.playerBlockedFor;
        document.body.classList.remove('boat-mode');
      }
    },
    testBoatLifecycle() {
      if (activeBoatItem) return { boarded: false, aboard: false, disembarked: false, landed: false, pass: false };
      const boat = editables.find((item) => item.data.type === 'fishingBoat' && isWaterSurfaceDir(item.dir));
      if (!boat) return { boarded: false, aboard: false, disembarked: false, landed: false, pass: false };

      const original = {
        playerDir: playerDir.clone(),
        playerForward: playerForward.clone(),
        camDir: camDir.clone(),
        lastSafePlayerDir: lastSafePlayerDir.clone(),
        boatDir: boat.data.dir.clone(),
        boatYaw: boat.data.yaw || 0,
        playerVisible: player.visible,
        labelEnabled: player.userData.nameLabel?.enabled,
        jumpVel, jumpHeight, onGround, playerBlockedFor,
      };
      try {
        // A saved boat may legitimately be offshore. Exercise landing at the
        // islet's mooring without changing the user's saved boat position.
        if (!nearestDryShoreDirection(boat.dir)) {
          const pierEnd = offsetSurfaceDir(HARBOR_REAR_LIGHTHOUSE_DIR, propFacing(HARBOR_REAR_LIGHTHOUSE_DIR, Math.PI), 0.68);
          const mooring = offsetSurfaceDir(pierEnd, tangentBasis(pierEnd).east, 0.16);
          if (!isWaterSurfaceDir(mooring) || !nearestDryShoreDirection(mooring)) {
            return { boarded: false, aboard: false, disembarked: false, landed: false, pass: false, reason: 'no-safe-test-mooring' };
          }
          boat.data.dir.copy(mooring);
          applyPropTransform(boat);
        }
        const boarded = boardBoat(boat);
        const aboard = boarded
          && activeBoatItem === boat
          && !player.visible
          && playerSurfaceAllowed(playerDir, true);
        const disembarked = boarded && disembarkBoat({ notify: false });
        const landed = disembarked
          && !activeBoatItem
          && !isInWaterDir(playerDir)
          && playerSurfaceAllowed(playerDir, false);
        return { boarded, aboard, disembarked, landed, pass: boarded && aboard && disembarked && landed };
      } finally {
        activeBoatItem = null;
        boat.data.dir.copy(original.boatDir);
        boat.data.yaw = original.boatYaw;
        applyPropTransform(boat);
        playerDir.copy(original.playerDir);
        playerForward.copy(original.playerForward);
        camDir.copy(original.camDir);
        lastSafePlayerDir.copy(original.lastSafePlayerDir);
        player.visible = original.playerVisible;
        if (player.userData.nameLabel) player.userData.nameLabel.enabled = original.labelEnabled;
        jumpVel = original.jumpVel;
        jumpHeight = original.jumpHeight;
        onGround = original.onGround;
        playerBlockedFor = original.playerBlockedFor;
        document.body.classList.remove('boat-mode');
      }
    },
    boardFirstBoat() {
      const boat = editables.find((item) => item.data.type === 'fishingBoat' && isWaterSurfaceDir(item.dir));
      return { boarded: boardBoat(boat), state: this.waterAccessState() };
    },
    leaveBoat() {
      return { disembarked: disembarkBoat({ notify: false }), state: this.waterAccessState() };
    },
    boatPosition() {
      return activeBoatItem ? activeBoatItem.dir.toArray().map((value) => +value.toFixed(5)) : null;
    },
    townWalkability() {
      const traps = [];
      let walkable = 0;
      // Cover the complete connected harbor city, including both new
      // peninsulas. The former central-only rectangle missed outer homes and
      // could report a healthy town while a district edge contained a trap.
      for (let z = -0.72; z <= 1.12; z += 0.10) {
        for (let x = -1.58; x <= 1.58; x += 0.10) {
          const dir = mapDir(x, z);
          if (!hasSurfaceClearance(dir, PLAYER_CLEARANCE_RADIUS) || isInWaterDir(dir)) continue;
          walkable++;
          const exits = playerEscapeOptionCount(dir, 0.038, 10);
          if (exits <= 1) traps.push({ x: +x.toFixed(2), z: +z.toFixed(2), exits });
        }
      }
      const neighborhoods = AGENTS.map((agent) => {
        const home = agent.home?.dir;
        if (!home) return { key: agent.key, samples: 0, traps: 1 };
        const basis = tangentBasis(home);
        let samples = 0, blockedPockets = 0;
        for (let x = -0.4; x <= 0.401; x += 0.1) {
          for (let z = -0.4; z <= 0.401; z += 0.1) {
            const dir = home.clone().addScaledVector(basis.east, x).addScaledVector(basis.north, z).normalize();
            if (isInWaterDir(dir) || !hasSurfaceClearance(dir, PLAYER_CLEARANCE_RADIUS)) continue;
            samples++;
            if (playerEscapeOptionCount(dir, 0.038, 10) <= 1) blockedPockets++;
          }
        }
        return { key: agent.key, samples, traps: blockedPockets };
      });
      const anchors = AGENTS.map((agent) => {
        const dir = agent.workDir || agent.home?.dir || null;
        if (!dir) return { key: agent.key, valid: false, reason: 'missing' };
        const inWater = isInWaterDir(dir);
        const blocked = !hasSurfaceClearance(dir, 0.015);
        const exits = playerEscapeOptionCount(dir, 0.038, 10);
        return { key: agent.key, valid: !inWater && !blocked && exits >= 2, inWater, blocked, exits };
      });
      return {
        walkable,
        traps,
        neighborhoods,
        anchors,
        pass: traps.length === 0 && anchors.every((anchor) => anchor.valid)
          && neighborhoods.every((area) => area.samples > 0 && area.traps === 0),
      };
    },
    terrainCoverage(sampleCount = 4096) {
      return terrainCoverageSummary(sampleCount);
    },
    testPlayerRecovery() {
      const original = {
        dir: playerDir.clone(),
        forward: playerForward.clone(),
        camera: camDir.clone(),
        safe: lastSafePlayerDir.clone(),
        blockedFor: playerBlockedFor,
        recoveries: playerRecoveryCount,
      };
      const results = getSurfaceColliders().map((collider) => {
        playerDir.copy(collider.dir);
        const before = hasSurfaceClearance(playerDir, PLAYER_CLEARANCE_RADIUS);
        const recovered = recoverPlayerToSafeSurface({ notify: false });
        return {
          label: collider.label,
          startedClear: before,
          recovered,
          clear: hasSurfaceClearance(playerDir, PLAYER_CLEARANCE_RADIUS),
          exits: playerEscapeOptionCount(playerDir),
        };
      });
      playerDir.copy(original.dir);
      playerForward.copy(original.forward);
      camDir.copy(original.camera);
      lastSafePlayerDir.copy(original.safe);
      playerBlockedFor = original.blockedFor;
      playerRecoveryCount = original.recoveries;
      keepPlayerForwardTangent();
      return results;
    },
    setAgentState(key, state, task = '') {
      const agent = AGENTS.find((item) => item.key === key);
      if (!agent) return null;
      agent.status.state = String(state || '대기 중').slice(0, 16);
      if (task) agent.status.task = String(task).slice(0, 80);
      syncAgentHomeStatusVisuals();
      refreshOpenServicePanel();
      ambientAudio.observeAgentStates(AGENTS);
      return { key, state: agent.status.state, mode: agentActivityMode(agent.status) };
    },
    cameraState() {
      const focusedHome = focusNpc?.userData.agent?.home?.mesh || null;
      const cameraRadius = camera.position.length();
      return {
        camDist: +camDist.toFixed(3),
        camPitch: +camPitch.toFixed(3),
        cameraRadius: +cameraRadius.toFixed(3),
        planetClearance: +(cameraRadius - R).toFixed(3),
        transitionMinClearance: Number.isFinite(cameraTransitionMinClearance)
          ? +cameraTransitionMinClearance.toFixed(3)
          : null,
        cinematic: !!cameraIntro,
        mode: experienceMode,
        dashboardYaw: +dashboardYaw.toFixed(3),
        playerDirection: playerDir.toArray().map(value => +value.toFixed(4)),
        focusedAgent: focusNpc?.userData.agent?.key || null,
        agentScreen: focusNpc ? objectScreenState(focusNpc) : null,
        homeScreen: focusedHome ? objectScreenState(focusedHome) : null,
        patrol: dashboardPatrolState(),
      };
    },
    labelState() {
      const labels = [...worldLabels].map((label) => ({
        text: label.element.textContent,
        kind: label.kind,
        visible: !label.element.hidden,
        reason: label.hiddenReason || '',
        occluded: label.occluded,
        collisionHidden: label.collisionHidden,
        offsetY: label.screenOffsetY,
      }));
      return {
        total: labels.length,
        visible: labels.filter((label) => label.visible).length,
        occluded: labels.filter((label) => label.reason === 'building').length,
        collisions: labels.filter((label) => label.collisionHidden).length,
        labels,
      };
    },
    resultSpaces() {
      return AGENTS.map((agent) => ({
        key: agent.key,
        name: agent.resultSpace?.name || '',
        static: agent.results.length,
        live: agent.status.results.length + (agent.status.result ? 1 : 0),
        visible: mergePublicResults(agent.status.result, agent.status.results, agent.results).length,
      }));
    },
    patrolToggle() {
      document.getElementById('patrolToggle')?.click();
      return dashboardPatrolState();
    },
    patrolTick(seconds = 10) {
      dashboardUpdatePatrol(Math.max(0, Number(seconds) || 0));
      return dashboardPatrolState();
    },
    dayState() {
      return skySystem.dayState();
    },
    weatherState() {
      return skySystem.weatherState();
    },
    performanceState() {
      return { ...performanceGovernor.state(), ...horizonCulling };
    },
    renderStructureState() {
      const summarize = (root) => {
        const result = { meshes: 0, batches: 0, shadowCasters: 0 };
        root?.traverseVisible?.((object) => {
          if (!object.isMesh) return;
          result.meshes++;
          const groups = object.geometry?.groups?.length || 0;
          result.batches += Array.isArray(object.material) ? Math.max(1, groups) : 1;
          if (object.castShadow) result.shadowCasters++;
        });
        return result;
      };
      const add = (target, value) => {
        target.meshes += value.meshes;
        target.batches += value.batches;
        target.shadowCasters += value.shadowCasters;
      };
      const propTypes = {};
      for (const item of editables) {
        const state = summarize(item.mesh);
        const aggregate = propTypes[item.data.type]
          || (propTypes[item.data.type] = { count: 0, meshes: 0, batches: 0, shadowCasters: 0 });
        aggregate.count++;
        add(aggregate, state);
      }
      const agentTypes = {};
      for (const agent of AGENTS) agentTypes[agent.key] = summarize(agent.npc);
      return {
        scene: summarize(scene),
        props: Object.fromEntries(Object.entries(propTypes)
          .sort((a, b) => b[1].batches - a[1].batches)),
        agents: agentTypes,
      };
    },
    setQuality(tier) {
      return performanceGovernor.setTier(tier);
    },
    audioState() {
      return ambientAudio.state();
    },
    toggleAudio(enabled = !ambientAudio.state().enabled) {
      return ambientAudio.setEnabled(!!enabled);
    },
    ambientMotionState() {
      const boat = editables.find((item) => item.mesh.userData.motionKind === 'boat')?.mesh;
      const buoy = editables.find((item) => item.mesh.userData.motionKind === 'buoy')?.mesh;
      const netRoot = editables.find((item) => item.mesh.userData.net)?.mesh;
      const netPositions = netRoot?.userData.net?.geometry?.attributes?.position;
      const netBase = netRoot?.userData.netBasePositions;
      let netOffset = 0;
      if (netPositions && netBase) {
        for (let i = 0; i < netPositions.count; i++) {
          netOffset = Math.max(netOffset, Math.abs(netPositions.getZ(i) - netBase[i * 3 + 2]));
        }
      }
      const sampleTransform = (root) => {
        const body = root?.userData.floatBody;
        return body ? {
          y: +body.position.y.toFixed(4),
          pitch: +body.rotation.x.toFixed(4),
          roll: +body.rotation.z.toFixed(4),
        } : null;
      };
      return {
        boats: editables.filter((item) => item.mesh.userData.motionKind === 'boat').length,
        buoys: editables.filter((item) => item.mesh.userData.motionKind === 'buoy').length,
        nets: editables.filter((item) => item.mesh.userData.net).length,
        flags: homeMarkers.filter((marker) => marker.userData.cloth).length,
        waves: editablePaths.filter((item) => item.mesh.userData.waveMaterials).length,
        boatSample: sampleTransform(boat),
        buoySample: sampleTransform(buoy),
        netOffset: +netOffset.toFixed(4),
      };
    },
    celestialState() {
      const { sun, moon, polaris } = skySystem.celestial;
      return {
        sun: objectScreenState(sun, sun.material.opacity),
        moon: objectScreenState(moon, moon.material.opacity),
        polaris: objectScreenState(polaris, polaris.material.opacity),
        polarisLabelVisible: false,
      };
    },
    roseState() {
      const state = objectScreenState(poleRose, 1);
      return {
        ...state,
        northAligned: poleRose.position.clone().normalize().dot(NORTH_POLE) > 0.999,
        labelVisible: [...worldLabels].some(label => label.target === poleRose && !label.element.hidden),
      };
    },
    svcTick() {
      updateServiceProximity();
      const p = document.getElementById('enterPrompt');
      return { editMode, cls: p.className, text: p.textContent };
    },
    testAllHomes() {
      const originalDir = playerDir.clone();
      const originalMode = experienceMode;
      experienceMode = 'explore';
      const results = [];
      for (const a of AGENTS) {
        const door = homeDoorDir(a.home);
        if (!door) {
          results.push({ key: a.key, ok: false, reason: 'home missing' });
          continue;
        }
        // Exercise the same three dev probes used during manual QA: place the
        // player at the door, measure proximity, then run the service tick.
        this.teleport(...door.toArray());
        const probe = this.doorProbe().find(p => p.key === a.key);
        const tick = this.svcTick();
        openServicePanel(a);
        const panel = document.getElementById('servicePanel');
        const panelOk = panel.classList.contains('show')
          && document.getElementById('serviceOwner').textContent === `${a.kor}의 집`
          && document.getElementById('serviceName').textContent === (a.service?.name || `${a.kor}의 집`);
        document.getElementById('resultsTabBtn')?.click();
        const resultSpaceOk = !document.getElementById('resultsPane')?.hidden
          && document.getElementById('resultSpaceName')?.textContent === (a.resultSpace?.name || `${a.kor}의 결과 공간`)
          && Number(document.getElementById('resultTabCount')?.textContent || 0) >= 0;
        results.push({
          key: a.key,
          homeType: a.home.data.type,
          doorAngle: probe?.angle ?? null,
          prompt: tick.text,
          promptOk: tick.cls.includes('show'),
          panelOk,
          resultSpaceOk,
          resultCount: Number(document.getElementById('resultTabCount')?.textContent || 0),
          ok: tick.cls.includes('show') && panelOk && resultSpaceOk,
        });
        closeServicePanel();
      }
      playerDir.copy(originalDir);
      experienceMode = originalMode;
      updateServiceProximity();
      return results;
    },
    // aim the edit camera at the i-th prop of a type; returns where it looked
    aimAt(type, i = 0) {
      const hits = editables.filter(it => it.data.type === type);
      const it = hits[i];
      if (!it) return null;
      editTargetDir = it.dir.clone();
      editYaw = 0;
      return { count: hits.length, n: it.dir.toArray().map(v => +v.toFixed(3)) };
    },
  };
  if (URL_PARAMS.get('qa') === '1') {
    queueMicrotask(() => {
      const homes = window.devPlanet.testAllHomes();
      const coverage = window.devPlanet.terrainCoverage();
      const waterAccess = window.devPlanet.waterAccessState();
      const boatLifecycle = window.devPlanet.testBoatLifecycle();
      const marineEnvironment = window.devPlanet.marineEnvironmentState();
      const homeStreetAccess = window.devPlanet.homeStreetAccessState();
      const district = window.devPlanet.districtState();
      const roadClearance = roadClearanceState();
      const sharedHarbor = sharedHarborState();
      const journey = window.devPlanet.testHarborJourney();
      document.documentElement.dataset.qaHarborJourney = JSON.stringify(journey);
      document.documentElement.dataset.qaSpatialStructure = JSON.stringify({
        sites: editablePaths.filter((p) => p.data.districtId).map((p) => ({ id: p.data.id, district: p.data.districtId, type: p.data.type })),
        objectCount: editables.length,
      });
      const routes = editablePaths.filter((p) => ['road', 'lane'].includes(p.data.type))
        .map((p) => splineDirs(p.data.dirs, { step: 0.012 }).dirs);
      const mainland = routes.filter((points) => points.some((p) => p.y > 0));
      const network = streetNetworkState(mainland);
      document.documentElement.dataset.qaStreetNetwork = JSON.stringify({
        mainlandPaths: mainland.length, islandPaths: routes.length - mainland.length, ...network,
      });
      document.documentElement.dataset.qaHomes = JSON.stringify(homes);
      document.documentElement.dataset.qaCharacters = JSON.stringify(window.devPlanet.characters());
      document.documentElement.dataset.qaLayout = JSON.stringify(window.devPlanet.layoutAudit());
      document.documentElement.dataset.qaPlayerMobility = JSON.stringify(window.devPlanet.playerMobilityState());
      document.documentElement.dataset.qaWalkability = JSON.stringify(window.devPlanet.townWalkability());
      document.documentElement.dataset.qaTerrainCoverage = JSON.stringify(coverage);
      document.documentElement.dataset.qaWaterAccess = JSON.stringify(waterAccess);
      document.documentElement.dataset.qaBoatLifecycle = JSON.stringify(boatLifecycle);
      document.documentElement.dataset.qaMarineEnvironment = JSON.stringify(marineEnvironment);
      document.documentElement.dataset.qaHomeStreetAccess = JSON.stringify(homeStreetAccess);
      document.documentElement.dataset.qaDistrict = JSON.stringify(district);
      document.documentElement.dataset.qaRoadClearance = JSON.stringify(roadClearance);
      document.documentElement.dataset.qaSharedHarbor = JSON.stringify(sharedHarbor);
      document.documentElement.dataset.qaScale = JSON.stringify(window.devPlanet.worldScaleState());
      document.documentElement.dataset.qaRenderStructure = JSON.stringify(window.devPlanet.renderStructureState());
      document.documentElement.dataset.qaLayoutReview = JSON.stringify({
        radius: R,
        reference: MAP_CENTER.toArray(),
        spawn: DEFAULT_PLAYER_SPAWN_DIR.toArray(),
        rose: NORTH_POLE.toArray(),
        props: editables.map((item) => ({ type: item.data.type, owner: item.data.ownerKey || null,
          n: item.dir.toArray(), scale: item.data.scale || 1 })),
        distances: AGENTS.flatMap((a, i) => AGENTS.slice(i + 1).map((b) => ({
          a: a.key, b: b.key, arc: +(a.home.dir.angleTo(b.home.dir) * R).toFixed(3),
        }))),
        routes: editablePaths.filter((p) => ['road', 'lane', 'deck'].includes(p.data.type)).map((p) => {
          const points = splineDirs(p.data.dirs, { step: 0.012 }).dirs;
          return { type: p.data.type, id: p.data.id || '', start: points[0].toArray(),
            end: points.at(-1).toArray(), length: +points.slice(1).reduce((sum, dir, i) => sum + dir.angleTo(points[i]) * R, 0).toFixed(3) };
        }),
      });
      document.documentElement.dataset.qaRecovery = JSON.stringify(window.devPlanet.testPlayerRecovery());
      document.documentElement.dataset.qaReady = homes.every((item) => item.ok)
        && window.devPlanet.layoutAudit().status === 'ready'
        && window.devPlanet.townWalkability().pass
        && coverage.waterPercent >= 34
        && coverage.waterPercent <= 44
        && waterAccess.pass
        && boatLifecycle.pass
        && marineEnvironment.pass
        && homeStreetAccess.pass
        && district.pass
        && roadClearance.pass
        && sharedHarbor.pass
        && network.connected
        && journey.pass
        ? 'pass'
        : 'fail';
    });
  }
  if (URL_PARAMS.get('verifyPlayerRecovery') === '1') {
    queueMicrotask(() => {
      const trap = getSurfaceColliders().find((collider) => collider.label === 'operations-core');
      if (!trap) return;
      playerDir.copy(trap.dir);
      playerBlockedFor = 0;
      const recoveriesBefore = playerRecoveryCount;
      setTimeout(() => {
        document.documentElement.dataset.qaAutoRecovery = JSON.stringify({
          clear: hasSurfaceClearance(playerDir, PLAYER_CLEARANCE_RADIUS),
          exits: playerEscapeOptionCount(playerDir),
          recovered: playerRecoveryCount > recoveriesBefore,
        });
      }, 900);
    });
  }
  const forcedActivityState = {
    working: '작업 중',
    review: '검증 중',
    error: '오류',
    complete: '완료',
  }[URL_PARAMS.get('verifyActivity')] || '';
  const syncDevDayState = () => {
    if (forcedActivityState) {
      for (const agent of AGENTS) {
        agent.status.state = forcedActivityState;
        const npc = agent.npc;
        const anchor = agent.workDir || agent.home?.dir;
        if (npc && anchor) npc.userData.dir.copy(anchor);
        if (npc) {
          npc.userData.isResting = true;
          npc.userData.activityTimer = 4;
          updateAgentActivitySignal(npc, 0, npcTime + (npc.userData.phase || 0), 0);
        }
      }
      syncAgentHomeStatusVisuals();
    }
    document.body.dataset.dayVerification = JSON.stringify(window.devPlanet.dayState());
    document.body.dataset.weatherVerification = JSON.stringify(window.devPlanet.weatherState());
    document.body.dataset.performanceVerification = JSON.stringify(window.devPlanet.performanceState());
    document.body.dataset.audioVerification = JSON.stringify(window.devPlanet.audioState());
    document.body.dataset.ambientMotionVerification = JSON.stringify(window.devPlanet.ambientMotionState());
    document.body.dataset.celestialVerification = JSON.stringify(window.devPlanet.celestialState());
    document.body.dataset.roseVerification = JSON.stringify(window.devPlanet.roseState());
    document.body.dataset.activityVerification = JSON.stringify(window.devPlanet.agentActivities());
    document.body.dataset.cameraVerification = JSON.stringify(window.devPlanet.cameraState());
    document.body.dataset.labelVerification = JSON.stringify(window.devPlanet.labelState());
    document.body.dataset.resultVerification = JSON.stringify(window.devPlanet.resultSpaces());
    document.body.dataset.mobilityVerification = JSON.stringify(window.devPlanet.mobilityState());
  };
  syncDevDayState();
  const queueDevStateSync = () => {
    if (document.hidden) return;
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(syncDevDayState, { timeout: 450 });
    } else {
      setTimeout(syncDevDayState, 0);
    }
  };
  // QA snapshots are useful, but rebuilding all of them twice a second caused
  // a small periodic hitch in the very ?dev=1 view used for visual review.
  setInterval(queueDevStateSync, 1000);
  if (URL_PARAMS.has('verifyHomes')) {
    const report = window.devPlanet.testAllHomes();
    document.body.dataset.homeVerification = JSON.stringify(report);
    console.info('devPlanet home verification', report);
  }
}
