import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createAgentStatusSource } from './status-source.js?v=65';
import { createSkySystem } from './sky.js?v=63';
import { createAmbientAudio } from './ambient-audio.js?v=62';
import { createAgentActivityTools } from './agent-activity.js?v=60';
import { createPerformanceGovernor } from './performance.js?v=63';
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
const DEV_TIME_SHIFT_MS = URL_PARAMS.has('dev')
  ? Number(URL_PARAMS.get('timeShiftHours') || 0) * 3600000
  : 0;
const DEV_WEATHER_PRESET = URL_PARAMS.has('dev')
  ? String(URL_PARAMS.get('weatherPreset') || '').toLowerCase()
  : '';
const DEV_QUALITY_OVERRIDE = URL_PARAMS.has('dev')
  ? String(URL_PARAMS.get('quality') || '').toLowerCase()
  : '';

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
try {
  SITE_CONFIG = { ...SITE_CONFIG, ...(await fetchJSON('config/site.json')) };
} catch (_) { /* optional public-site metadata */ }
try {
  const runtimeCfg = await fetchJSON('config/runtime.json');
  RUNTIME_CONFIG = {
    ...RUNTIME_CONFIG,
    ...runtimeCfg,
    status: { ...RUNTIME_CONFIG.status, ...(runtimeCfg.status || {}) },
    results: { ...RUNTIME_CONFIG.results, ...(runtimeCfg.results || {}) },
  };
} catch (_) { /* optional until the Hermes bridge is enabled */ }
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
    planet:   0x2f6fa8,                                  // ocean globe; islands are explicit land caps
    outline:  0x5d6268,                                  // soft graphite line; agents carry the color accents
    fogDay:   0xdceff7, fogTwilight: 0xe8d8df, fogNight: 0x25344a,
    skyDay:   { top: 0x6fb7e8, mid: 0xa8d8f0, bottom: 0xeaf6ff },
    // The former lavender/apricot day palette now belongs only to the
    // dawn/dusk transition instead of tinting the whole daytime scene.
    skyTwilight: { top: 0x879fd1, mid: 0xd4aeca, bottom: 0xf7c7aa },
    skyNight: { top: 0x07142f, mid: 0x18314f, bottom: 0x4c6173 },
    water:    0x72c9e8,
    seaDeep:  0x2c6798, seaMid: 0x4b8fbd, seaFoam: 0xeaf8f5,
    coastSand: 0xd8cbaa, breakwater: 0xaeb2b2,
    islandGrass: 0xa7ba93, harborDeck: 0xa68f79,
    marketPath: 0xc2b291, camelliaPath: 0x8fa584,
    roadAsphalt: 0xb8b4ad, roadLine: 0xc9c4b5,
    dirt:     0x987d60,
    snowTop:  0xf4f9fd, snowEdge: 0xcfe0ea,
    rosePetal: 0xd91f4e, roseCore: 0xa80f38,
    roseStem: 0x4e8f56, roseLeaf: 0x63a86b,
    roseGold: 0xe6c36a, roseGlass: 0xdff6ff,
  },
  // agent identity colors now live in config/agents.json (per-agent `color`)
  ui: {
    accent: '#81bfbc', accentDark: '#5fa3a0', ink: '#36514f',
    panel: 'rgba(255,255,255,0.72)', rose: '#d91f4e',
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
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const IS_LOCAL_RUNTIME = LOCAL_HOSTS.has(location.hostname);

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
  document.title = `${title} — Interactive Agent Village`;
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
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
    document.querySelector(selector)?.setAttribute('content', description);
  }
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', title);
  document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', title);
  const publicUrl = safe(SITE_CONFIG.publicUrl);
  if (publicUrl) {
    const canonical = document.createElement('link');
    canonical.rel = 'canonical'; canonical.href = publicUrl; document.head.appendChild(canonical);
    const ogUrl = document.createElement('meta');
    ogUrl.setAttribute('property', 'og:url'); ogUrl.content = publicUrl; document.head.appendChild(ogUrl);
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
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  0.27,   // strength — light is an accent, not a veil over the diorama
  0.62,   // radius
  0.92    // threshold (only the sun, lamps, and active signals bloom)
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
  for (let i = 0; i < steps; i++) data[i] = Math.round((i / (steps - 1)) * 255);
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
const TOON_GRAD = makeToonGradient(4);   // one extra band softens the low-poly forms into anime-like paint

// build a toon material with the same gradient ramp for the whole world
function toonMat(color) {
  return new THREE.MeshToonMaterial({ color, gradientMap: TOON_GRAD });
}

// outline material is shared (back-face, slightly inflated)
// soft plum instead of near-black, so the line sits gently against pastels
const OUTLINE_MAT = new THREE.MeshBasicMaterial({ color: THEME.world.outline, side: THREE.BackSide });
const OUTLINE_SCALE = 1.028;

// attach a cartoon outline to a mesh (clones its geometry, inflated & inverted)
function addOutline(mesh, scale = OUTLINE_SCALE) {
  const outline = new THREE.Mesh(mesh.geometry, OUTLINE_MAT);
  outline.scale.setScalar(scale);
  mesh.add(outline);
  return outline;
}

function disposeObject(root) {
  // Bundled GLTF instances share resources owned by modelProtoCache.
  // Disposing one clone would invalidate every clone and the prototype.
  if (root?.userData?.sharedModelResources) return;
  const geometries = new Set();
  const materials = new Set();
  root.traverse(obj => {
    if (obj.geometry) geometries.add(obj.geometry);
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (mat && mat !== OUTLINE_MAT) materials.add(mat);
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

// ---------------------------------------------------------------------------
// The planet
// ---------------------------------------------------------------------------
const planet = new THREE.Mesh(
  new THREE.SphereGeometry(R, 32, 32),         // fewer segments => chunkier low-poly facets
  new THREE.MeshToonMaterial({
    color: THEME.world.planet,
    emissive: THEME.world.seaDeep,
    emissiveIntensity: 0.16,
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
  if (z.band) return target.y >= z.band.minY - extraRadius && target.y <= z.band.maxY + extraRadius;
  const ang = Math.acos(Math.max(-1, Math.min(1, target.dot(z.dir))));
  if (ang > z.radius + extraRadius) return false;      // outside bounding circle
  if (!z.poly) return true;
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

function isInWaterDir(dir) {
  return isInZone(dir, waterZones, 0) && !isInZone(dir, landZones, 0) && !isOnBridgeDir(dir);
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
  const pos = new Float32Array(N * 2 * 3);
  const nor = new Float32Array(N * 2 * 3);
  for (let i = 0; i < N; i++) {
    const d = dirs[i];
    const prev = dirs[closed ? (i - 1 + N) % N : Math.max(0, i - 1)];
    const next = dirs[closed ? (i + 1) % N : Math.min(N - 1, i + 1)];
    const fwd = next.clone().sub(prev);
    fwd.sub(d.clone().multiplyScalar(fwd.dot(d)));   // keep it tangent
    if (fwd.lengthSq() < 1e-10) fwd.copy(tangentBasis(d).north);
    fwd.normalize();
    const side = new THREE.Vector3().crossVectors(d, fwd).normalize();
    for (let k = 0; k < 2; k++) {
      const e = offsetSurfaceDir(d, side, (k === 0 ? -1 : 1) * half);
      const r = terrainRadius(e) + lift;
      const o = (i * 2 + k) * 3;
      pos[o] = e.x * r; pos[o + 1] = e.y * r; pos[o + 2] = e.z * r;
      nor[o] = e.x; nor[o + 1] = e.y; nor[o + 2] = e.z;
    }
  }
  const segs = closed ? N : N - 1;
  const idx = [];
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = i * 2 + 1;
    const c = ((i + 1) % N) * 2, d2 = ((i + 1) % N) * 2 + 1;
    idx.push(a, c, b, b, c, d2);
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
  const rings = Math.max(2, Math.ceil(maxAng / 0.05));
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

function makeLatitudeBand(minY, maxY, { lift = 0.064, material } = {}) {
  const lonSegments = 72;
  const latSegments = 18;
  const geo = new THREE.BufferGeometry();
  const rows = latSegments + 1;
  const cols = lonSegments + 1;
  const pos = new Float32Array(rows * cols * 3);
  const nor = new Float32Array(rows * cols * 3);
  const d = new THREE.Vector3();
  for (let iy = 0; iy < rows; iy++) {
    const y = THREE.MathUtils.lerp(minY, maxY, iy / latSegments);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    for (let ix = 0; ix < cols; ix++) {
      const a = (ix / lonSegments) * Math.PI * 2;
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
function makeVillageTerrace(rx = 1.05, rz = 0.56) {
  const g = new THREE.Group();
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1.03, 0.13, 20),
    toonMat(0x9fa19b)
  );
  skirt.scale.set(rx, 1, rz);
  skirt.position.y = 0.065;
  skirt.castShadow = true;
  skirt.receiveShadow = true;

  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(0.99, 1, 0.04, 20),
    toonMat(0xa8b796)
  );
  top.scale.set(rx, 1, rz);
  top.position.y = 0.145;
  top.receiveShadow = true;
  g.add(skirt, top);
  return g;
}

function makeWorkPlaza(rx = 0.82, rz = 0.43) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 0.055, 24),
    toonMat(0xb4aa92)
  );
  base.scale.set(rx, 1, rz);
  base.position.y = 0.028;
  base.receiveShadow = true;

  // A quiet inner inlay gives the eye a centre without becoming a monument.
  const inlay = new THREE.Mesh(
    new THREE.CylinderGeometry(0.68, 0.68, 0.018, 24),
    toonMat(0xc9c0a7)
  );
  inlay.scale.set(rx, 1, rz);
  inlay.position.y = 0.064;
  inlay.receiveShadow = true;
  g.add(base, inlay);
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

function makeCottage({ wall = 0xf7f5f0, roof = 0xe8896b, scale = 1 } = {}) {
  const g = new THREE.Group();
  // Low, practical modern fishing-village house: white plaster box and a
  // simple folded metal roof instead of the old fairy-tale cone roof.
  const foundation = new THREE.Mesh(
    new THREE.BoxGeometry(3.68, 0.30, 3.30),
    toonMat(0xb9b4aa),
  );
  foundation.position.y = 0.15;
  foundation.castShadow = true;
  foundation.receiveShadow = true;
  addOutline(foundation, 1.016);
  const base = new THREE.Mesh(new THREE.BoxGeometry(3.55, 2.55, 3.18), toonMat(wall));
  base.position.y = 1.28; base.castShadow = true; base.receiveShadow = true; addOutline(base);
  const roofMat = toonMat(roof);
  const roofLeft = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.13, 3.62), roofMat);
  const roofRight = roofLeft.clone();
  roofLeft.position.set(-0.83, 3.02, 0); roofLeft.rotation.z = 0.47;
  roofRight.position.set(0.83, 3.02, 0); roofRight.rotation.z = -0.47;
  [roofLeft, roofRight].forEach(m => { m.castShadow = true; addOutline(m, 1.025); });
  const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.70, 6), roofMat);
  ridge.position.y = 3.53;
  ridge.rotation.x = Math.PI / 2;
  ridge.castShadow = true;
  addOutline(ridge, 1.03);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.82, 1.78, 0.08), toonMat(0x8e6b58));
  door.position.set(0, 0.9, 1.63);
  const frameMat = toonMat(0x8c7465);
  const leftFrame = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.82, 0.075), frameMat);
  const rightFrame = leftFrame.clone();
  leftFrame.position.set(-1.12, 1.45, 1.625);
  rightFrame.position.set(1.12, 1.45, 1.625);
  const windowMat = new THREE.MeshToonMaterial({
    color: 0xfff0b8,
    emissive: 0xd89a43,
    emissiveIntensity: 0.28,
    gradientMap: TOON_GRAD,
  });
  const leftWindow = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.055), windowMat);
  const rightWindow = leftWindow.clone();
  leftWindow.position.set(-1.12, 1.45, 1.675);
  rightWindow.position.set(1.12, 1.45, 1.675);
  const sideFrame = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.76, 0.90), frameMat);
  sideFrame.position.set(1.79, 1.42, 0.2);
  const sideWindow = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.58, 0.72), windowMat);
  sideWindow.position.set(1.835, 1.42, 0.2);
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.92, 0.34), toonMat(0xa57f70));
  chimney.position.set(1.08, 3.62, -0.25); chimney.castShadow = true; addOutline(chimney, 1.035);
  const stoop = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.12, 0.48), toonMat(0xb8a18b));
  stoop.position.set(0, 0.06, 1.82);
  g.add(
    foundation, base, roofLeft, roofRight, ridge, door,
    leftFrame, rightFrame, sideFrame, leftWindow, rightWindow, sideWindow,
    chimney, stoop,
  );
  g.scale.setScalar(scale);
  g.userData.colliderRadius = 0.27 * scale;
  g.userData.windowMaterials = [windowMat];
  g.userData.homeLabelOffset = new THREE.Vector3(0, 3.95, 1.62);
  g.userData.homeFlagOffset = new THREE.Vector3(1.35, 0, 2.25);
  g.userData.doorOffset = new THREE.Vector3(0, 0, 2.15);
  return g;
}

function makeFishingBoat(color = 0xf2f0e8) {
  const g = new THREE.Group();
  const floatBody = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.38, 1.35, 6), toonMat(color));
  hull.rotation.x = Math.PI / 2; hull.scale.y = 0.55; hull.position.y = 0.22;
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.12, 1.08), toonMat(0x477c9b));
  stripe.position.y = 0.29;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.38, 0.46), toonMat(0xf7f2df));
  cabin.position.set(0, 0.52, -0.12);
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
  const counter = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.42, 0.48), toonMat(0xb58c68));
  counter.position.y = 0.22;
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.09, 0.68), toonMat(color));
  canopy.position.y = 1.03;
  [-0.44, 0.44].forEach(x => {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 1.0, 6), toonMat(0x80634f));
    post.position.set(x, 0.52, -0.2); g.add(post);
  });
  [counter, canopy].forEach(m => { m.castShadow = true; addOutline(m, 1.025); g.add(m); });
  g.userData.awning = canopy;
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  return g;
}

function makeFishCrate() {
  const g = new THREE.Group();
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.24, 0.38), toonMat(0x82979d));
  crate.position.y = 0.12; crate.castShadow = true; addOutline(crate, 1.03); g.add(crate);
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

function makeLighthouse() {
  const g = new THREE.Group();
  const white = toonMat(0xfbfaf5);
  const red = toonMat(0xe5524b);
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
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.92, 4.3, 12), white);
  tower.position.y = 2.55;
  const bandLow = new THREE.Mesh(new THREE.CylinderGeometry(0.84, 0.91, 0.54, 12), red);
  bandLow.position.y = 1.42;
  const bandHigh = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.72, 0.5, 12), red);
  bandHigh.position.y = 3.48;
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(0.88, 0.88, 0.16, 12), red);
  gallery.position.y = 4.78;
  const lanternMat = new THREE.MeshToonMaterial({
    color: 0xffe5a1, emissive: 0xf2a52f, emissiveIntensity: 0.85,
    gradientMap: TOON_GRAD, transparent: true, opacity: 0.86,
  });
  const lanternRoom = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.7, 10), lanternMat);
  lanternRoom.position.y = 5.18;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.72, 0.62, 10), red);
  roof.position.y = 5.85;
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.18, 0.08), toonMat(0x765a4d));
  door.position.set(0, 0.86, 0.87);

  const rail = new THREE.Group();
  const railRing = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.035, 6, 24), red);
  railRing.rotation.x = Math.PI / 2;
  railRing.position.y = 5.02;
  rail.add(railRing);
  for (let i = 0; i < 8; i++) {
    const angle = i / 8 * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.28, 6), red);
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
  return g;
}

function makeCamelliaTree() {
  const g = new THREE.Group();
  const canopy = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.15, 0.9, 6), toonMat(0x86664f));
  trunk.position.y = 0.45;
  const crownMats = [toonMat(0x4f8669), toonMat(0x619577)];
  [[0, 1.24, 0, 0.64], [-0.38, 1.12, 0.06, 0.50], [0.38, 1.13, -0.02, 0.52]].forEach(([x,y,z,s], i) => {
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 1), crownMats[i % crownMats.length]);
    crown.position.set(x,y,z); crown.castShadow = true; addOutline(crown, 1.022); canopy.add(crown);
  });
  const bloomMats = [
    new THREE.MeshBasicMaterial({ color: 0xe7686d }),
    new THREE.MeshBasicMaterial({ color: 0xf29a8f }),
  ];
  [
    [-0.40,1.34,0.35],[-0.17,1.53,0.46],[0.12,1.48,0.53],[0.40,1.31,0.34],
    [0.46,1.08,0.35],[0.02,1.12,0.61],[-0.38,1.04,0.42],[0.22,1.65,0.25],
    [-0.28,1.43,-0.39],[0.30,1.38,-0.40],[-0.45,1.16,-0.24],[0.46,1.18,-0.27],
  ].forEach(([x,y,z], i) => {
    const bloom = new THREE.Mesh(new THREE.IcosahedronGeometry(i % 3 === 0 ? 0.13 : 0.105, 1), bloomMats[i % 2]);
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

  const pineMats = [toonMat(0x456f59), toonMat(0x568268), toonMat(0x638e70)];
  [
    [-0.38,1.35,0.02,0.64,0.38,0.50],
    [0.05,1.58,0.00,0.78,0.44,0.58],
    [0.48,1.72,-0.04,0.62,0.36,0.48],
    [0.24,2.02,-0.06,0.50,0.32,0.42],
  ].forEach(([x,y,z,sx,sy,sz], i) => {
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), pineMats[i % pineMats.length]);
    crown.position.set(x,y,z);
    crown.scale.set(sx,sy,sz);
    crown.castShadow = true;
    addOutline(crown, 1.022);
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
  const tone = LEAF_TONES[(Math.random()*LEAF_TONES.length)|0];
  // stacked cones => fuller pine
  const c1 = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.08, 6), toonMat(tone));
  const c2 = new THREE.Mesh(new THREE.ConeGeometry(0.56, 0.98, 6), toonMat(tone));
  const c3 = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.78, 6), toonMat(tone));
  c1.position.y = 1.08; c2.position.y = 1.68; c3.position.y = 2.22;
  trunk.castShadow = true; addOutline(trunk); g.add(trunk);
  [c1, c2, c3].forEach(m => { m.castShadow = true; addOutline(m); foliage.add(m); });
  g.add(foliage);
  const scale = 1.12 + Math.random()*0.56;
  g.scale.setScalar(scale);
  g.userData.colliderRadius = 0.11 * scale;
  g.userData.swayGroup = foliage;
  g.userData.motionPhase = Math.random() * Math.PI * 2;
  return g;
}

function makeRock() {
  const g = new THREE.Group();
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3, 0), toonMat(0x9ea6aa));
  rock.scale.set(1, 0.7, 1.1); rock.castShadow = true; addOutline(rock);
  g.add(rock); g.scale.setScalar(0.7 + Math.random()*0.9);
  return g;
}

const PETAL_TONES = [0xffb3c6, 0xffe9a8, 0xc9b8ff, 0xffc9de, 0xfff5f7];
function makeFlower() {
  const g = new THREE.Group();
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015,0.015,0.3,4), toonMat(0x9bd49b));
  stem.position.y = 0.15;
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09,0),
    toonMat(PETAL_TONES[(Math.random()*PETAL_TONES.length)|0]));
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
const AGENT_PLAZA_DIR = mapDir(0.02, 0.18);
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
  cottage: {
    make: (o) => makeCottage({ wall: o.wall, roof: o.roof, scale: (o.scale ?? 1) * 0.75 }),
    lift: 0.08, collider: 0.27, baseScale: 0.75, scaleInFactory: true, label: 'cottage',
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
  tree:   { make: () => makeTree(), lift: 0.035, collider: 0.12, baseScale: 0.85, label: 'tree',
    category: '자연', paletteLabel: '🌲 나무', editableParams: ['scale', 'yaw'] },
  rock:   { make: () => makeRock(), lift: 0.06, collider: 0, label: 'rock',
    category: '자연', paletteLabel: '🪨 바위', editableParams: ['scale', 'yaw'] },
  flower: { make: () => makeFlower(), lift: 0.0, collider: 0, label: 'flower',
    category: '자연', paletteLabel: '🌸 꽃', editableParams: ['scale', 'yaw'] },
  trafficLight: { make: () => makeTrafficLight(), lift: 0.08, collider: 0, baseScale: 1.2, label: 'traffic-light',
    category: '도로변', paletteLabel: '🚦 신호등', editableParams: ['scale', 'yaw'] },
  busStop: { make: () => makeBusStop(), lift: 0.06, collider: 0.07, baseScale: 1.3, label: 'bus-stop',
    category: '도로변', paletteLabel: '🚏 버스정류장', editableParams: ['scale', 'yaw'] },
  // Slim roadside furniture is decorative, not navigational geometry. Keeping
  // it out of the spherical collider set prevents wandering agents getting
  // pinned between a pole and a building while still leaving houses solid.
  utilityPole: { make: () => makeUtilityPole(), lift: 0.055, collider: 0, label: 'utility-pole',
    category: '도로변', paletteLabel: '🗼 전봇대', editableParams: ['scale', 'yaw'] },
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
  fishingBoat: {
    make: (o) => makeFishingBoat(o.color ?? 0xf2f0e8),
    lift: 0.115, collider: 0, label: 'fishing-boat',
    category: '항구', paletteLabel: '⛵ 어선', editableParams: ['variant', 'scale', 'yaw'],
    variants: [
      { name: '흰색', color: 0xf2f0e8 },
      { name: '주황', color: 0xe98b68 },
      { name: '청색', color: 0x6b9fbd },
    ],
  },
  harborBuoy: { make: () => makeHarborBuoy(), lift: 0.11, collider: 0, label: 'harbor-buoy',
    category: '항구', paletteLabel: '🔴 부표', editableParams: ['scale', 'yaw'] },
  netRack: { make: () => makeNetRack(), lift: 0.055, collider: 0, label: 'net-rack',
    category: '항구', paletteLabel: '🕸️ 건조 그물', editableParams: ['scale', 'yaw'] },
  marketStall: { make: (o) => makeMarketStall(o.color ?? 0xe88768), lift: 0.055, collider: 0.07, label: 'market-stall',
    category: '항구', paletteLabel: '🏪 어시장 좌판', editableParams: ['variant', 'scale', 'yaw'],
    variants: [
      { name: '산호', color: 0xe88768 },
      { name: '하늘', color: 0x76aac4 },
      { name: '크림', color: 0xe7c875 },
    ],
  },
  fishCrate: { make: () => makeFishCrate(), lift: 0.045, collider: 0, label: 'fish-crate',
    category: '항구', paletteLabel: '🧺 어상자', editableParams: ['scale', 'yaw'] },
  tetrapod: { make: () => makeTetrapod(), lift: 0.075, collider: 0, label: 'tetrapod',
    category: '항구', paletteLabel: '🪨 테트라포드', editableParams: ['scale', 'yaw'] },
  lighthouse: { make: () => makeLighthouse(), lift: 0.055, collider: 0.22, label: 'lighthouse',
    category: '건물', paletteLabel: '🔦 등대', editableParams: ['scale', 'yaw'] },
  camellia: { make: () => makeCamelliaTree(), lift: 0.035, collider: 0.08, label: 'camellia',
    category: '자연', paletteLabel: '🌺 동백나무', editableParams: ['scale', 'yaw'] },
  coastPine: { make: () => makeCoastPine(), lift: 0.04, collider: 0.10, label: 'coast-pine',
    category: '자연', paletteLabel: '🌲 해안 소나무', editableParams: ['scale', 'yaw'] },
  terrace: {
    make: (o) => makeVillageTerrace(o.rx ?? 1.05, o.rz ?? 0.56),
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
const PROP_CATEGORIES = ['건물', '항구', '자연', '도로변', '바닥'];

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
  barrel:    { file: 'assets/models/hexagon/barrel.gltf',                  size: 0.62, collider: 0.06, category: '도로변', paletteLabel: '🛢️ 나무통' },
  waterlily: { file: 'assets/models/hexagon/waterlily_A.gltf',             size: 0.55, fit: 'max', lift: 0.085, collider: 0, category: '자연', paletteLabel: '🪷 수련' },
  lantern:   { file: 'assets/models/halloween/post_lantern.gltf',          size: 1.9,  collider: 0,     category: '도로변', paletteLabel: '🏮 가로등' },
  pumpkin:   { file: 'assets/models/halloween/pumpkin_orange.gltf',        size: 0.42, collider: 0.05, category: '자연',  paletteLabel: '🎃 호박' },
  bench:     { file: 'assets/models/city/bench.gltf',                      size: 1.15, fit: 'max', collider: 0.06, category: '도로변', paletteLabel: '🪑 벤치' },
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
    build(points) {
      const g = new THREE.Group();
      // A narrow, unmarked village lane. Removing the bright centre stripe
      // keeps the eye on the agents and makes the loop read as an old coastal
      // road instead of a miniature highway.
      const road = makeCountryRoad(points, { width: 0.86, color: THEME.world.roadAsphalt, lift: 0.095 });
      g.add(road);
      const walkZones = registerPathZones(
        splineDirs(points, { step: 0.055 }).dirs, 0.09, 'road-walk', 0.055, registerBridgeZone
      );
      return { mesh: g, zones: [], walkZones };   // paths remain walkable over the sea cap
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
      const mesh = makeCountryRoad(points, { width: 0.78, color: THEME.world.dirt, lift: 0.068 });
      return { mesh, zones: [] };
    },
  },
  snow: {
    label: '눈길',
    build(points) {
      // snow-packed path: bright top over a pale-blue shoulder
      const g = new THREE.Group();
      const shoulder = makeCountryRoad(points, { width: 1.0, color: THEME.world.snowEdge, lift: 0.062 });
      const top = makeCountryRoad(points, { width: 0.78, color: THEME.world.snowTop, lift: 0.072 });
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
      const zone = registerLatitudeWaterBand(-0.82, 0.28, 'sea-ring');
      const seaMat = makeSeaWaterMat();
      const mesh = makeLatitudeBand(-0.82, 0.28, { lift: 0.064, material: seaMat });
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
      const zone = registerPolyLandZone(center, rim, 'harbor-island');
      const g = new THREE.Group();
      g.add(shore, land);
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
      g.add(makeCountryRoad(points, { width: 0.78, color: 0x8f9497, lift: 0.078 }));
      g.add(makeCountryRoad(points, { width: 0.60, color: THEME.world.breakwater, lift: 0.103 }));
      g.add(makeCountryRoad(points, { width: 0.43, color: 0xd6d1ca, lift: 0.129 }));
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
        mesh: makeCountryRoad(points, { width: 0.64, color: THEME.world.marketPath, lift: 0.103 }),
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
      g.add(makeCountryRoad(points, { width: 0.82, color: 0x75685f, lift: 0.079 }));
      g.add(makeCountryRoad(points, { width: 0.68, color: THEME.world.harborDeck, lift: 0.094 }));
      const deckDirs = splineDirs(points, { step: 0.045 }).dirs;
      const seamStride = Math.max(3, Math.floor(deckDirs.length / 7));
      for (let i = seamStride; i < deckDirs.length - seamStride; i += seamStride) {
        const dir = deckDirs[i];
        const previous = deckDirs[Math.max(0, i - 1)];
        const next = deckDirs[Math.min(deckDirs.length - 1, i + 1)];
        const forward = next.clone().sub(previous);
        forward.sub(dir.clone().multiplyScalar(forward.dot(dir))).normalize();
        const side = new THREE.Vector3().crossVectors(dir, forward).normalize();
        const half = 0.27 / R;
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
      g.add(makeCountryRoad(points, { width: 0.78, color: THEME.world.camelliaPath, lift: 0.093 }));
      g.add(makeCountryRoad(points, { width: 0.46, color: THEME.world.dirt, lift: 0.103 }));
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
      // ground paint: darker forest-floor green
      const { dirs: rim } = splineDirs(points, { step: 0.03, forceClosed: true });
      if (rim.length < 3) return { mesh: new THREE.Group(), zones: [] };
      const center = centroidDir(rim);
      return { mesh: makeCapMesh(center, rim, { lift: 0.045, material: toonMat(0x7cae76) }), zones: [] };
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
  const { mesh, zones = [], landZones: itemLandZones = [], walkZones = [] } = def.build(dirs);
  scene.add(mesh);
  const item = {
    data: { kind: 'path', type: data.type, dirs }, mesh,
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

// serialize / restore the editable layout (props + paths in one array).
// Positions are saved as unit direction vectors `n: [x,y,z]` — valid anywhere
// on the planet. (Old x/z village layouts still load; see normalizePropData.)
const _r4 = (v) => +v.toFixed(4);
function serializeLayout() {
  const paths = editablePaths.map(it => ({
    kind: 'path',
    type: it.data.type,
    n: it.data.dirs.map(d => [_r4(d.x), _r4(d.y), _r4(d.z)]),
  }));
  const props = editables.map(it => {
    const { dir, ...rest } = it.data;
    return { ...rest, n: [_r4(dir.x), _r4(dir.y), _r4(dir.z)] };
  });
  return [...paths, ...props];   // paths first so they render under props
}
function buildLayout(layout) {
  clearProps();
  clearPaths();
  for (const data of layout) {
    if (data && data.kind === 'path') spawnPath(data);
    else spawnProp(data);
  }
}

// --- layout persistence (localStorage + JSON import/export) ----------------
// Keep the old user-edited layout intact under its former key while the harbor
// redesign starts from a clean default. Export/import remains compatible.
const LAYOUT_KEY = 'HandulPlanet_layout_harbor_v3';
const LAYOUT_BACKUP_KEY = 'HandulPlanet_layout_backups_v1';
const LAYOUT_SCHEMA_VERSION = 1;

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
      if (pts.length >= (PATH_DEFS[e.type].minPoints || 2)) out.push({ kind: 'path', type: e.type, n: pts });
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
      for (const k of ['wall', 'roof', 'color', 'len']) {
        if (typeof e[k] === 'number' && isFinite(e[k])) d[k] = e[k];
      }
      if (typeof e.ownerKey === 'string' && /^[a-z0-9_-]{1,32}$/i.test(e.ownerKey)) {
        d.ownerKey = e.ownerKey;
      }
      if (d.len !== undefined) d.len = num(d.len, 0.8, 8, 2.95);
      for (const k of ['rx', 'rz']) d[k] = num(e[k], 0.1, 3, undefined);
      if (d.rx === undefined) delete d.rx;
      if (d.rz === undefined) delete d.rz;
      out.push(d);
    }
  }
  return out.length ? out : null;
}

// read a saved layout from localStorage, or null if none / unreadable.
// (function declaration so it's hoisted for the boot-time buildLayout call.)
function loadSavedLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    return sanitizeLayout(JSON.parse(raw));   // null if corrupt/empty → default
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
    notifyLayoutPersistence(true, '저장됨');
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
  if (recordHistory && lastLayoutSnap !== null && snap !== lastLayoutSnap) {
    undoStack.push(lastLayoutSnap);
    if (undoStack.length > 30) undoStack.shift();
    if (clearRedo) redoStack.length = 0;
  }
  lastLayoutSnap = snap;
  const stored = storeLayoutSnapshot(snap);
  notifyLayoutHistory();
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
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.78, 0.14, 20),
    toonMat(THEME.world.snowTop),
  );
  base.position.y = 0.07; base.castShadow = true; base.receiveShadow = true;
  addOutline(base, 1.025);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.64, 0.025, 6, 24),
    new THREE.MeshBasicMaterial({ color: THEME.world.roseGold }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.155;
  g.add(base, rim);

  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.062, 1.42, 7),
    toonMat(THEME.world.roseStem),
  );
  stem.position.y = 0.88; stem.castShadow = true;
  g.add(stem);
  // two leaves on the stem
  [[0.20, 0.72, -0.5], [-0.18, 1.08, 0.45]].forEach(([x, y, tilt]) => {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.105, 8, 6), toonMat(THEME.world.roseLeaf));
    leaf.scale.set(1.7, 0.45, 0.8);
    leaf.position.set(x, y, 0);
    leaf.rotation.z = tilt;
    leaf.castShadow = true;
    g.add(leaf);
  });
  // the bloom: deep-red core wrapped in a ring of petals
  const head = new THREE.Group();
  head.position.y = 1.70;
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.18, 1), toonMat(THEME.world.roseCore));
  core.castShadow = true; addOutline(core);
  head.add(core);
  const petalMat = toonMat(THEME.world.rosePetal);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const petal = new THREE.Mesh(new THREE.SphereGeometry(0.135, 9, 7), petalMat);
    petal.scale.set(1, 1.3, 0.55);
    petal.position.set(Math.cos(a) * 0.145, 0.035, Math.sin(a) * 0.145);
    petal.rotation.y = -a;
    petal.rotation.x = 0.35;         // petals open outward
    petal.castShadow = true;
    head.add(petal);
  }
  g.add(head);

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
  [-1.78, 0.70], [-1.82, 0.30], [-1.58, 0.02], [-1.08, -0.18],
  [-0.48, -0.25], [0, -0.27], [0.48, -0.25], [1.08, -0.18],
  [1.58, 0.02], [1.82, 0.30], [1.78, 0.70], [1.10, 1.02],
  [0, 1.16], [-1.10, 1.02], [-1.78, 0.70],
];
const HARBOR_TERRAIN_LAYOUT = [
  // A continuous low-latitude ocean band makes the land read as an island
  // from every orbit angle. Polygon land masks carve out the village and cape.
  { kind: 'path', type: 'seaRing', n: [[0, 1, 0], [0, 0, 1]] },
  { kind: 'path', type: 'island', points: HARBOR_FRONT_ISLAND_POINTS },
  { kind: 'path', type: 'island', n: sphericalRing([0, -0.578, -0.816], 0.46, 20, Math.PI / 20) },
  // Pale foam traces the actual island shoreline; inner bands keep the flat,
  // graphic water treatment from the moodboard.
  { kind: 'path', type: 'wave', points: HARBOR_FRONT_ISLAND_POINTS },
  { kind: 'path', type: 'wave', n: sphericalArc(HARBOR_SEA_CENTER, 0.34, -1.22, 1.15, 8) },
  { kind: 'path', type: 'wave', n: sphericalArc(HARBOR_SEA_CENTER, 0.66, -1.02, 1.20, 8) },
  // One continuous loop: front village → east transition → rear cape → west
  // transition → front. The first and last point are identical: no dead end.
  { kind: 'path', type: 'road', points: [
    [-1.72, 0.08], [-1.20, 0.18], [-0.62, 0.24], [0, 0.20], [0.62, 0.24], [1.20, 0.18], [1.72, 0.08],
    [0.966, 0.150, 0.211], [1, 0, 0], [0.866, -0.289, -0.408], [0.5, -0.501, -0.707],
    [0, -0.578, -0.816], [-0.5, -0.501, -0.707], [-0.866, -0.289, -0.408], [-1, 0, 0],
    [-0.966, 0.150, 0.211], [-1.72, 0.08],
  ] },
  { kind: 'path', type: 'deck', points: [[-1.38, -0.36], [-0.78, -0.43], [0, -0.46], [0.78, -0.42], [1.30, -0.33]] },
  { kind: 'path', type: 'market', points: [[-1.35, 0.02], [-0.82, -0.12], [-0.20, -0.18], [0.42, -0.16], [1.10, -0.04]] },
  // Two embracing arms leave a clear harbor mouth instead of closing the bay.
  { kind: 'path', type: 'breakwater', points: [[-1.42, -0.26], [-1.50, -0.50], [-1.30, -0.72], [-0.94, -0.88], [-0.58, -0.94]] },
  { kind: 'path', type: 'breakwater', points: [[1.42, -0.26], [1.50, -0.50], [1.30, -0.72], [0.94, -0.88], [0.58, -0.94]] },
  { kind: 'path', type: 'camellia', n: [
    mapDir(1.45, 0.28).toArray(), [0.9659, 0.1496, 0.2112], [0.8660, -0.2890, -0.4080],
    [0.5, -0.5006, -0.7067], [0, -0.578, -0.816],
  ] },
];

const HARBOR_FRONT_LAYOUT = [
  // One shared work yard is the compositional centre and the destination for
  // active front-side agents. It replaces several decorative props.
  { type: 'workPlaza', x: 0.02, z: 0.18, yaw: -0.05, rx: 0.82, rz: 0.43 },
  // Three shallow landings break the old crown-shaped row into a 2 + 2 + 1
  // hillside composition. They are broad masses, not extra decoration.
  { type: 'terrace', x: -0.28, z: 0.76, yaw: -0.08, rx: 0.84, rz: 0.46 },
  { type: 'terrace', x: 0.55,  z: 0.18, yaw: -0.12, rx: 0.68, rz: 0.40 },
  { type: 'terrace', x: -0.62, z: 0.24, yaw: 0.14, rx: 0.60, rz: 0.39 },

  // Five service homes, deliberately staggered in height, angle, and size.
  { type: 'cottage', ownerKey: 'rodi',   x: -0.08, z: 0.84, yaw: 2.96, scale: 0.72, wall: 0xf7f5f0, roof: 0xe8896b },
  { type: 'cottage', ownerKey: 'jarvis', x: -0.53, z: 0.62, yaw: 2.30, scale: 0.68, wall: 0xf7f5f0, roof: 0x5b7c99 },
  { type: 'cottage', ownerKey: 'yul',    x: 0.34,  z: 0.36, yaw: -2.44, scale: 0.70, wall: 0xf7f5f0, roof: 0x5b7c99 },
  { type: 'cottage', ownerKey: 'ludwig', x: -0.67, z: 0.18, yaw: 1.72, scale: 0.66, wall: 0xf7f5f0, roof: 0xe8896b },
  { type: 'cottage', ownerKey: 'anne',   x: 0.66,  z: 0.04, yaw: -1.84, scale: 0.68, wall: 0xf7f5f0, roof: 0xe8896b },

  // The harbor is one readable scene: two boats, two stalls, and a handful
  // of working props. The open water and clear lane do most of the work.
  { type: 'fishingBoat', x: -0.36, z: -0.68, yaw: 0.18, scale: 0.90, color: 0x6f9eb2 },
  { type: 'fishingBoat', x: 0.42,  z: -0.61, yaw: -0.25, scale: 0.80, color: 0xf0eadc },
  { type: 'harborBuoy', x: -0.82, z: -0.76, yaw: 0, scale: 0.78 },
  { type: 'harborBuoy', x: 0.78,  z: -0.73, yaw: 0, scale: 0.76 },
  { type: 'marketStall', x: -0.46, z: -0.42, yaw: 0.08, color: 0xd98268 },
  { type: 'marketStall', x: 0.30,  z: -0.41, yaw: -0.04, color: 0x6f9eb2 },
  { type: 'fishCrate', x: -0.78, z: -0.16, yaw: 0.28, scale: 0.84 },
  { type: 'fishCrate', x: 0.66,  z: -0.13, yaw: -0.18, scale: 0.78 },
  { type: 'netRack', x: -1.02, z: -0.27, yaw: 0.16, scale: 0.88 },

  // Shoreline punctuation: enough geometry to draw the coast, with gaps so
  // it never becomes a necklace of identical objects.
  { type: 'rock', x: -1.54, z: -0.08, yaw: 0.2, scale: 1.08 },
  { type: 'rock', x: -0.93, z: -0.29, yaw: 2.0, scale: 0.70 },
  { type: 'rock', x: 0.05,  z: -0.35, yaw: 0.8, scale: 0.62 },
  { type: 'rock', x: 0.94,  z: -0.27, yaw: 1.5, scale: 0.74 },
  { type: 'rock', x: 1.55,  z: -0.06, yaw: 0.4, scale: 1.04 },
  { type: 'busStop', x: 1.34, z: 0.08, yaw: -1.48, scale: 0.80 },
  { type: 'bench', x: -1.02, z: 0.06, yaw: 1.44, scale: 0.84 },
  { type: 'utilityPole', x: -1.54, z: 0.21, yaw: 3.142, scale: 0.76 },

  // Three vegetation masses frame the homes; agent colors remain the accents.
  { type: 'coastPine', x: -1.18, z: 0.58, yaw: -0.1, scale: 0.70 },
  { type: 'camellia', x: 0.15, z: 1.15, yaw: 0.2, scale: 0.64 },
  { type: 'camellia', x: 1.18, z: 0.54, yaw: -0.3, scale: 0.66 },

  // Six larger tetrapods imply the two breakwater arms without repeating the
  // same silhouette ten times.
  { type: 'tetrapod', x: -1.58, z: -0.53, yaw: 0.3, scale: 1.36 },
  { type: 'tetrapod', x: -1.31, z: -0.82, yaw: 1.3, scale: 1.46 },
  { type: 'tetrapod', x: -0.78, z: -1.02, yaw: 2.4, scale: 1.38 },
  { type: 'tetrapod', x: 1.58,  z: -0.53, yaw: 2.8, scale: 1.36 },
  { type: 'tetrapod', x: 1.31,  z: -0.82, yaw: 1.8, scale: 1.46 },
  { type: 'tetrapod', x: 0.78,  z: -1.02, yaw: 0.6, scale: 1.38 },
];

const HARBOR_REAR_LAYOUT = [
  // Argos inherits the old far-side-home contract, but his home is now the
  // white-and-red lighthouse and participates in the same service interaction.
  { type: 'lighthouse', ownerKey: 'argos', n: [0, -0.505, -0.863], yaw: 3.142, scale: 0.86 },
  { type: 'bench', n: [0.00, -0.735, -0.679], yaw: 3.142, scale: 0.92 },
  { type: 'lantern', n: [-0.12, -0.69, -0.72], yaw: 0.2, scale: 0.72 },
  { type: 'rock', n: [-0.25, -0.62, -0.74], yaw: 0.4, scale: 1.35 },
  { type: 'rock', n: [0.24, -0.64, -0.73], yaw: 2.2, scale: 1.25 },
  { type: 'rock', n: [-0.38, -0.48, -0.79], yaw: 1.2, scale: 1.10 },
  { type: 'rock', n: [0.39, -0.46, -0.80], yaw: 2.7, scale: 1.05 },
  { type: 'coastPine', n: [-0.28, -0.40, -0.87], yaw: -0.1, scale: 0.92 },
  { type: 'coastPine', n: [0.31, -0.38, -0.87], yaw: 0.2, scale: 0.86 },
  { type: 'coastPine', n: [-0.42, -0.58, -0.70], yaw: -0.2, scale: 0.82 },
  { type: 'camellia', n: [-0.20, -0.61, -0.77], yaw: 0.2, scale: 0.90 },
  { type: 'camellia', n: [0.19, -0.61, -0.77], yaw: -0.3, scale: 0.86 },
  { type: 'camellia', n: [-0.34, -0.53, -0.78], yaw: 0.6, scale: 0.80 },
  { type: 'camellia', n: [0.34, -0.52, -0.79], yaw: -0.5, scale: 0.82 },

  // Sparse east-side transition grove following the green path back to harbor.
  { type: 'camellia', n: [0.94, 0.10, 0.32], yaw: 0.1, scale: 0.76 },
  { type: 'camellia', n: [0.92, -0.12, -0.38], yaw: -0.2, scale: 0.80 },
  { type: 'camellia', n: [0.77, -0.36, -0.53], yaw: 0.4, scale: 0.78 },
  { type: 'camellia', n: [0.54, -0.50, -0.68], yaw: -0.4, scale: 0.82 },
];

const DEFAULT_LAYOUT = [
  ...HARBOR_TERRAIN_LAYOUT,
  ...HARBOR_FRONT_LAYOUT,
  ...HARBOR_REAR_LAYOUT,
];

// Home driveways are terrain tied to each service-home spot — regenerated
// whenever the layout changes, so they follow the houses around in edit mode.
// Agent home assignment rides along: reassigned whenever cottages change.
// (stub until the agents exist; replaced after the AGENTS block below)
const HOME_PROP_TYPES = new Set(['cottage', 'lighthouse']);
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
function rebuildDriveways() {
  // Group.clear() detaches but never disposes — free the GPU resources first,
  // or dragging a cottage (which rebuilds continuously) leaks geometries.
  for (const child of drivewayGroup.children.slice()) disposeObject(child);
  drivewayGroup.clear();
  for (const it of editables) {
    if (!HOME_PROP_TYPES.has(it.data.type)) continue;
    // a short stub out the FRONT DOOR (along the cottage's facing) — works
    // anywhere on the planet, not just relative to the village street
    const face = propFacing(it.data.dir, it.data.yaw || 0);
    const start = offsetSurfaceDir(it.data.dir, face, 0.13);
    const end = offsetSurfaceDir(it.data.dir, face, 0.42);
    const dw = makeCountryRoad([start, end],
      { width: 0.28, color: 0xb89b73, lift: 0.106 });
    dw.userData.surfaceDir = it.dir.clone();
    drivewayGroup.add(dw);
  }
  assignAgentHomes();
}
// cottages carry extras (driveway + agent home flag/nameplate) — call this after
// any editor mutation, and it rebuilds them only when a cottage was involved
function syncCottageExtras(type) {
  if (HOME_PROP_TYPES.has(type)) rebuildDriveways();
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
  buildLayout(loadSavedLayout() || DEFAULT_LAYOUT);
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
} = {}) {
  const element = document.createElement('div');
  element.className = `world-label ${kind}${bubble ? ' bubble' : ''}${emoji ? ' emoji' : ''}`;
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
  label.element.remove();
}

// The rose keeps one quiet story label. Celestial bodies stay label-free so
// they read as distant atmosphere rather than explicit navigation markers.
createWorldLabel('B-612의 장미', {
  target: poleRose,
  offset: new THREE.Vector3(0, 2.24, 0),
  direction: NORTH_POLE,
  kind: 'landmark',
  visibilityDot: 0.015,
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
    element.style.opacity = opacity.toFixed(3);
    label.collisionHidden = false;
    label.hiddenReason = '';
    candidates.push({
      label,
      x,
      y,
      scale,
      distance,
      width: Math.max(1, element.offsetWidth) * scale,
      height: Math.max(1, element.offsetHeight) * scale,
      priority: labelPriority(label),
    });
  }

  candidates.sort((a, b) => b.priority - a.priority || a.distance - b.distance);
  const accepted = [];
  addLabelUiObstacles(accepted);
  const baseOffsets = [0, -18, 18, -36, 36, -54, 54];

  for (const candidate of candidates) {
    const { label, x, y, width, height, scale } = candidate;
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
      const offsetY = label.screenOffsetY || 0;
      const anchorY = y + offsetY;
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
  const { cap = true, pantsColor = 0x5a5f73 } = opts;
  const g = new THREE.Group();
  const bodyMat = toonMat(bodyColor);
  const trimMat = toonMat(characterTone(bodyColor, -0.13));
  const softMat = toonMat(characterTone(bodyColor, 0.14, -0.12));
  const skinMat = toonMat(headColor);
  const pantsMat = toonMat(pantsColor);
  const shoeMat = toonMat(0x424957);

  g.userData.characterType = 'person';
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
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.062, 9, 7), skinMat);
    hand.position.set(0, -0.292, 0.012); hand.castShadow = true;
    pivot.add(arm, hand);
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

// Jarvis's body — 미네르바의 기계 올빼미. A plump bronze automaton owl that
// shares the same walk animator: wings map to the arm pivots (they flap),
// stubby legs to the leg pivots. Same userData contract as makeCharacter.
function makeOwlCharacter(color, name = null) {
  const g = new THREE.Group();
  const bodyMat = toonMat(color);
  const darkMat = toonMat(characterTone(color, -0.16));
  const brassMat = toonMat(0xd9ad62);
  const body = new THREE.Group();
  g.add(body);
  g.userData.body = body;
  g.userData.bodyMaterial = bodyMat;
  g.userData.characterType = 'owl';
  g.userData.labelHeight = 1.54;
  g.userData.activityHeight = 1.40;

  const contactShadow = makeCharacterContactShadow(0.4);
  g.add(contactShadow);
  g.userData.contactShadow = contactShadow;

  // plump torso + cream belly patch
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 12), bodyMat);
  torso.scale.set(1, 1.15, 0.95); torso.position.y = 0.58;
  torso.castShadow = true; addOutline(torso);
  const tummy = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), toonMat(0xf3e6c8));
  tummy.scale.set(0.85, 1.0, 0.55); tummy.position.set(0, 0.52, 0.16);
  body.add(torso, tummy);

  // Big glass eyes, highlights and brows keep the mechanical owl expressive.
  [-0.115, 0.115].forEach(x => {
    const ring = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), toonMat(0xfffbe8));
    ring.position.set(x, 0.84, 0.24);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.048, 8, 6), toonMat(0x3a3344));
    pupil.position.set(x, 0.84, 0.32);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    glint.position.set(x - 0.012, 0.858, 0.363);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.025, 0.035), darkMat);
    brow.position.set(x, 0.955, 0.23);
    brow.rotation.z = x < 0 ? -0.14 : 0.14;
    body.add(ring, pupil, glint, brow);
  });
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.14, 6), toonMat(0xe8b64f));
  beak.rotation.x = Math.PI / 2; beak.position.set(0, 0.73, 0.33);
  body.add(beak);

  // ear tufts — the Minerva silhouette
  [-0.16, 0.16].forEach(x => {
    const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 6), bodyMat);
    tuft.position.set(x, 1.0, 0);
    tuft.castShadow = true;
    body.add(tuft);
  });

  // A tiny clock on the chest links Jarvis's operational role to the body,
  // even while the status effect is not active.
  const clockFace = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.035, 16), toonMat(0xfff4d8));
  clockFace.rotation.x = Math.PI / 2;
  clockFace.position.set(0, 0.52, 0.30);
  const clockRim = new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.014, 6, 18), brassMat);
  clockRim.position.set(0, 0.52, 0.322);
  const clockHand = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.075, 0.018), darkMat);
  clockHand.position.set(0.012, 0.545, 0.34);
  clockHand.rotation.z = -0.45;
  body.add(clockFace, clockRim, clockHand);

  // wings on the arm pivots (the shared animator makes them flap while walking)
  const limbs = {};
  [['armL', -0.32], ['armR', 0.32]].forEach(([key, x]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.72, 0);
    const wing = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.26, 4, 8), bodyMat);
    wing.scale.set(0.55, 1, 1);
    wing.position.y = -0.18; wing.castShadow = true; addOutline(wing);
    pivot.add(wing);
    body.add(pivot);
    limbs[key] = pivot;
  });
  // stubby automaton legs
  [['legL', -0.11], ['legR', 0.11]].forEach(([key, x]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.24, 0);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.2, 6), toonMat(0x8a6f4e));
    leg.position.y = -0.1; leg.castShadow = true;
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), brassMat);
    foot.scale.set(1.1, 0.48, 1.35);
    foot.position.set(0, -0.21, 0.055);
    pivot.add(leg, foot);
    g.add(pivot);
    limbs[key] = pivot;
  });
  g.userData.limbs = limbs;

  if (name) g.userData.labelText = name;
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

  if (style === 'companion-conductor') {
    // 동료형 조율자: 짧은 코트와 별실을 잇는 띠, 작은 소리굽쇠.
    const baton = new THREE.Group();
    const metal = toonMat(0xf7f3ff);
    const gold = new THREE.MeshBasicMaterial({ color: 0xffe19a });
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.021, 0.28, 7), metal);
    handle.position.y = -0.04;
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.025, 0.025), metal);
    bridge.position.y = 0.10;
    baton.add(handle, bridge);
    [-0.046, 0.046].forEach(x => {
      const tine = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 7), metal);
      tine.position.set(x, 0.17, 0);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.018, 7, 5), gold);
      tip.position.set(x, 0.245, 0);
      baton.add(tine, tip);
    });
    baton.position.set(0, -0.31, 0.08);
    baton.rotation.x = -0.58;
    baton.rotation.z = -0.10;
    L.armR.add(baton);
    const coatMat = c.userData.trimMaterial || toonMat(0xc6a84e);
    [-0.095, 0.095].forEach((x, index) => {
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.27, 0.045), coatMat);
      tail.position.set(x, 0.47, -0.10);
      tail.rotation.z = (index ? -1 : 1) * 0.08;
      body.add(tail);
    });
    const sash = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.42, 0.026), toonMat(0xf3e2a4));
    sash.position.set(0, 0.70, 0.225);
    sash.rotation.z = -0.42;
    body.add(sash);
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.045, 0), gold);
    star.scale.set(0.9, 1.35, 0.7);
    star.position.set(-0.105, 0.77, 0.255);
    body.add(star);
    c.userData.labelHeight = 1.62;
    c.userData.activityHeight = 1.52;
  } else if (style === 'clockwork-owl') {
    // 운영 비서: 작은 정장 모자. 시계는 몸체에 내장되어 있어 소품을
    // 추가로 늘리지 않고도 정체성이 두 겹으로 읽힌다.
    const hat = new THREE.Group();
    const hatMat = toonMat(0x485768);
    const bandMat = toonMat(0xd6b46e);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.032, 14), hatMat);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.125, 0.17, 12), hatMat);
    crown.position.y = 0.09;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.128, 0.128, 0.035, 12), bandMat);
    band.position.y = 0.035;
    hat.add(brim, crown, band);
    hat.position.set(0, 1.06, -0.015);
    hat.rotation.z = -0.06;
    body.add(hat);
    const keyStem = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.18, 6), bandMat);
    keyStem.rotation.z = Math.PI / 2;
    keyStem.position.set(-0.30, 0.58, -0.08);
    const keyLoop = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.014, 6, 12), bandMat);
    keyLoop.rotation.y = Math.PI / 2;
    keyLoop.position.set(-0.40, 0.58, -0.08);
    body.add(keyStem, keyLoop);
    c.userData.labelHeight = 1.58;
    c.userData.activityHeight = 1.43;
  } else if (style === 'moonlight-scholar') {
    // 달빛의 공명학자: 둥근 안경 + 펼친 검증 노트.
    const glassMat = toonMat(0x4a4458);
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
    [-1, 1].forEach(side => {
      const cover = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.025, 0.19), coverMat);
      const pages = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.018, 0.18), pageMat);
      cover.position.x = side * 0.052;
      pages.position.set(side * 0.052, 0.016, 0);
      cover.rotation.z = side * -0.12;
      pages.rotation.z = side * -0.12;
      book.add(cover, pages);
    });
    const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.19, 6), coverMat);
    spine.rotation.x = Math.PI / 2;
    book.add(spine);
    book.position.set(0, -0.30, 0.10);
    book.rotation.x = -0.78;
    L.armL.add(book);
    const scholarMat = c.userData.trimMaterial || toonMat(0x6c688f);
    [-0.10, 0.10].forEach((x, index) => {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.34, 0.042), scholarMat);
      panel.position.set(x, 0.44, -0.075);
      panel.rotation.z = (index ? -1 : 1) * 0.055;
      body.add(panel);
    });
    const moonPin = new THREE.Mesh(new THREE.OctahedronGeometry(0.038, 0), new THREE.MeshBasicMaterial({ color: 0xe6e5ff }));
    moonPin.scale.y = 1.35;
    moonPin.position.set(-0.11, 0.77, 0.25);
    body.add(moonPin);
    c.userData.labelHeight = 1.63;
    c.userData.activityHeight = 1.50;
  } else if (style === 'forest-atelier') {
    // 별을 그리는 숲의 요정: 붓 + 다섯 장 꽃 배지.
    const brush = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.34, 6), toonMat(0xc9a87c));
    const bristle = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 8), toonMat(0xd91f4e));
    bristle.position.y = 0.2;
    brush.add(handle, bristle);
    brush.position.set(0, -0.36, 0.06);
    brush.rotation.x = -0.5;
    L.armR.add(brush);
    const flower = new THREE.Group();
    const petalMat = toonMat(0xffb3c6);
    for (let i = 0; i < 5; i++) {
      const angle = i / 5 * Math.PI * 2;
      const petal = new THREE.Mesh(new THREE.SphereGeometry(0.028, 7, 5), petalMat);
      petal.scale.set(0.72, 1.3, 0.55);
      petal.position.set(Math.cos(angle) * 0.04, Math.sin(angle) * 0.04, 0);
      petal.rotation.z = angle - Math.PI / 2;
      flower.add(petal);
    }
    flower.add(new THREE.Mesh(new THREE.SphereGeometry(0.022, 7, 5), toonMat(0xffe19a)));
    flower.position.set(0.11, 0.255, 0.075);
    flower.rotation.x = -0.35;
    headRig?.add(flower);
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
    c.userData.labelHeight = 1.64;
    c.userData.activityHeight = 1.50;
  } else if (style === 'resonance-engineer') {
    // 공명공학자: 머리 수신기 + 안테나 + 가슴 콘솔 + 렌치.
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 6), toonMat(0x59636d));
    mast.position.set(0, 0.25, 0);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 6), new THREE.MeshBasicMaterial({ color: 0x9fe8ff }));
    beacon.position.set(0, 0.33, 0);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.07, 0.01, 6, 16),
      new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.7 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.33, 0);
    headRig?.add(mast, beacon, ring);
    [-0.225, 0.225].forEach(x => {
      const receiver = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.045, 10), toonMat(0x3f6671));
      receiver.rotation.z = Math.PI / 2;
      receiver.position.set(x, 0.01, 0.015);
      headRig?.add(receiver);
    });
    const console_ = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.11, 0.045), toonMat(0x3b4550));
    console_.position.set(0, 0.72, 0.2);
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.045, 0.012), new THREE.MeshBasicMaterial({ color: 0x9fe8ff }));
    screen.position.set(0, 0.73, 0.23);
    const utilityBelt = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.025, 6, 16), toonMat(0x425962));
    utilityBelt.rotation.x = Math.PI / 2;
    utilityBelt.position.set(0, 0.52, 0);
    const signalCoil = new THREE.Mesh(
      new THREE.TorusGeometry(0.075, 0.016, 6, 16),
      new THREE.MeshBasicMaterial({ color: 0x9fe8ff }),
    );
    signalCoil.rotation.y = Math.PI / 2;
    signalCoil.position.set(-0.22, 0.57, 0.02);
    body.add(console_, screen, utilityBelt, signalCoil);
    const wrench = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.3, 6), toonMat(0x8b95a3));
    const jaw = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.016, 6, 12, Math.PI * 1.4), toonMat(0x8b95a3));
    jaw.position.y = 0.17;
    wrench.add(shaft, jaw);
    wrench.position.set(0, -0.36, 0.06);
    wrench.rotation.x = -0.55;
    L.armR.add(wrench);
    c.userData.labelHeight = 1.68;
    c.userData.activityHeight = 1.55;
  } else if (style === 'quiet-field-observer') {
    // 조용한 현장 관측자: 위압적인 눈 지팡이 대신 짧은 여행 망토,
    // 접이식 필드 스코프와 출처 노트를 든다.
    const cloakMat = c.userData.trimMaterial || toonMat(0x5d587c);
    const cloak = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.47, 0.045), cloakMat);
    cloak.position.set(0, 0.66, -0.205);
    cloak.rotation.x = -0.08;
    const cloakHem = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.27, 0.16, 10), cloakMat);
    cloakHem.position.set(0, 0.44, -0.11);
    const clasp = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.037, 0),
      new THREE.MeshBasicMaterial({ color: 0xd9d2ff }),
    );
    clasp.position.set(0, 0.80, 0.235);
    body.add(cloak, cloakHem, clasp);

    const fieldScope = new THREE.Group();
    const scopeMat = toonMat(0x4c5266);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.047, 0.29, 9), scopeMat);
    const lensRim = new THREE.Mesh(new THREE.TorusGeometry(0.049, 0.012, 6, 14), toonMat(0xc7b77a));
    lensRim.rotation.x = Math.PI / 2;
    lensRim.position.y = 0.15;
    const lensGlass = new THREE.Mesh(
      new THREE.CircleGeometry(0.038, 12),
      new THREE.MeshBasicMaterial({ color: 0xbfd9ec, transparent: true, opacity: 0.72, side: THREE.DoubleSide }),
    );
    lensGlass.rotation.x = -Math.PI / 2;
    lensGlass.position.y = 0.157;
    fieldScope.add(tube, lensRim, lensGlass);
    fieldScope.position.set(0, -0.31, 0.09);
    fieldScope.rotation.x = -0.62;
    fieldScope.rotation.z = 0.18;
    L.armL.add(fieldScope);

    const notebook = new THREE.Group();
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.18, 0.035), toonMat(0x8d765f));
    const page = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.15, 0.014), toonMat(0xf2ecdd));
    page.position.z = 0.024;
    notebook.add(cover, page);
    notebook.position.set(0, -0.30, 0.075);
    notebook.rotation.x = -0.42;
    L.armR.add(notebook);

    const satchel = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.075), toonMat(0x806b58));
    satchel.position.set(0.24, 0.55, 0.02);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.40, 0.018), toonMat(0x806b58));
    strap.position.set(0.10, 0.71, 0.20);
    strap.rotation.z = 0.46;
    body.add(satchel, strap);
    c.userData.labelHeight = 1.62;
    c.userData.activityHeight = 1.50;
  }
}

// drive the walk cycle: move01 = 0 (idle) → 1 (full stride). Arms and legs
// swing in opposite phase; idle relaxes into a faint breathing sway.
function animateCharacterWalk(char, move01, t) {
  const L = char.userData.limbs;
  if (!L) return;
  const swing = Math.sin(t * 8.5) * 0.58 * move01;
  L.armL.rotation.x = swing;
  L.armR.rotation.x = -swing;
  L.legL.rotation.x = -swing * 0.92;
  L.legR.rotation.x = swing * 0.92;
  const rest = 1 - move01;
  const breath = Math.sin(t * 1.55);
  const idle = rest * (0.035 + breath * 0.022);
  L.armL.rotation.z = 0.08 + idle;
  L.armR.rotation.z = -0.08 - idle;

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

const player = makeCharacter(save.data.modelFiles.base, 0xffe8cf, '한들');   // 나 — avatar color from saved state
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
    runId: null,
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
    cost: null,
  },
  results: RESULT_COLLECTIONS[a.key] || [],
  service: SERVICES[a.key] || null,
}));
const ARGOS_AGENT = AGENTS.find(a => a.key === 'argos') || null;
let refreshRecentResultsUi = () => {};
let resultRefreshInFlight = null;

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
    const beam = home.userData.lighthouseBeam;
    if (beam) beam.visible = a.key === 'argos' && isWorkingStatus(a.status.state);
  }
}

const npcs = [];
// Spread the agents evenly over the sphere with a Fibonacci lattice so they
// never spawn clumped together. They also repel each other while walking
// (see the NPC loop), so they can never end up 100% overlapping.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));     // golden angle
const N = AGENTS.length;
AGENTS.forEach((d, i) => {
  // `character` comes from config: 'owl' (Jarvis) or a little resonator person
  // with signature props (baton/glasses/brush/antenna…) for a distinct silhouette
  const c = d.character === 'owl'
    ? makeOwlCharacter(d.color, d.name)
    : makeCharacter(d.color, 0xffe8cf, d.name, {
        cap: d.visual.cap !== false,
        pantsColor: configHex(d.visual.pantsColor, 0x5a5f73),
      });
  addAgentAccessories(c, d.visual);
  addAgentActivitySignal(c, d.color, d.activityStyle);
  c.userData.agent = d;                          // dashboard record for the status card
  d.npc = c;                                     // back-reference (bubbles, camera focus)
  const configuredScale = Number(d.visual.scale);
  c.scale.setScalar(Number.isFinite(configuredScale)
    ? THREE.MathUtils.clamp(configuredScale, 0.86, 1.22)
    : 1.02 + (i % 3) * 0.07);                    // agents, not buildings, are the visual protagonists

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
    if (a.key === 'argos') {
      // The watcher works at the lighthouse instead of commuting to the
      // front-side yard.
      a.workDir = offsetSurfaceDir(home.dir, propFacing(home.dir, home.data.yaw || 0), 0.12);
    } else {
      const approach = slerpDir(home.dir, AGENT_PLAZA_DIR, 0.48);
      const lateral = tangentBasis(approach).east;
      a.workDir = offsetSurfaceDir(approach, lateral, (i - 2) * 0.018);
    }
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
    if (repositionNpcs && a.npc) {
      const t = tangentBasis(home.dir);
      const ang = i * 2.4;
      a.npc.userData.dir = home.dir.clone()
        .add(t.east.multiplyScalar(Math.cos(ang) * 0.35))
        .add(t.north.multiplyScalar(Math.sin(ang) * 0.35))
        .normalize();
    }
  });
  syncAgentHomeStatusVisuals();
};
assignAgentHomes(true);

// player state on the sphere: a position (unit dir) + a heading angle around it
let playerDir = mapDir(0.02, 0.02);                   // central open street; also the dashboard's quiet camera anchor
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
const TURN_SPEED = 2.2;                                // radians/sec of A/D turning
let playerStride = 0;                                  // smoothed 0..1 walk intensity for limb swing

// jump state — vertical hop above the surface (height in world units along `up`)
let jumpVel = 0, jumpHeight = 0, onGround = true;
const JUMP_SPEED = 4.0, GRAVITY = 12.0;

// (The old parcel-delivery minigame was removed — the planet is now the
// Hermes agent dashboard. Walking, agents, weather, and editing all remain.)

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = {};
const MOVEMENT_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
let jumpRequested = false;
addEventListener('keydown', e => {
  const key = e.key.toLowerCase();
  const movementKey = MOVEMENT_KEYS.has(key);
  if (isUiInteractionTarget(e.target)) {
    if (key === 'escape') dashboardStopPatrol();
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
let openServicePanel = () => {};        // assigned by the service-panel wiring below
let closeServicePanel = () => {};       // "
let refreshOpenServicePanel = () => {};
let updateServiceProximity = () => {};  // stepped by the main loop (집 문 앞 감지)

const FOCUS_NON_OCCLUDERS = new Set(['road', 'trail', 'river', 'pond', 'sand', 'grass', 'snow']);
const _focusRaycaster = new THREE.Raycaster();
const _focusRayDirection = new THREE.Vector3();
const _focusLookTarget = new THREE.Vector3();
const _focusHomePosition = new THREE.Vector3();

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
  const angles = [0, 0.34, -0.34, 0.68, -0.68, 1.05, -1.05, Math.PI];
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
    const score = base.dot(side) * 2 - Math.abs(angle) * 0.08 - (blocked ? 10 : 0);
    if (score > bestScore) {
      bestScore = score;
      best.copy(side);
    }
  }
  return best;
}

// mouse drag to orbit the camera around the player (rotates the camDir anchor)
let dragging = false, camPitch = 0.68, lastX = 0, lastY = 0;
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
  camDir.applyAxisAngle(playerDir.clone().normalize(), yawDelta);
  keepTangentAtPlayer(camDir);
  camPitch += (e.clientY - lastY) * 0.005;
  camPitch = Math.max(0.05, Math.min(1.2, camPitch));
  lastX = e.clientX; lastY = e.clientY;
});

// ---- zoom: mouse wheel + two-finger pinch ----
const ZOOM_MIN = 4, ZOOM_MAX = 26;
const DASHBOARD_CAM_DIST = 19.6;
const MOBILE_DASHBOARD_CAM_DIST = 24.5;
const EXPLORE_CAM_DIST = 10.5;
const DASHBOARD_CAM_PITCH = 0.82;
const EXPLORE_CAM_PITCH = 0.50;
let camDist = DASHBOARD_CAM_DIST;
let experienceMode = 'dashboard';

function dashboardCameraDistance() {
  return innerWidth <= 520 ? MOBILE_DASHBOARD_CAM_DIST : DASHBOARD_CAM_DIST;
}

function snapFollowCamera() {
  const up = playerDir.clone().normalize();
  const back = camDir.clone().multiplyScalar(-1);
  const camOffset = up.clone().multiplyScalar(Math.sin(camPitch) * camDist)
    .add(back.multiplyScalar(Math.cos(camPitch) * camDist));
  const dashboard = experienceMode === 'dashboard';
  camera.position.copy(dashboard ? camOffset : player.position.clone().add(camOffset));
  camera.up.copy(up);
  camera.lookAt(dashboard
    ? up.clone().multiplyScalar(1.8)
    : player.position.clone().add(up.multiplyScalar(0.8)));
}

function startCameraIntro() {
  cameraIntro = {
    startedAt: performance.now(),
    duration: 2500,
    fromDist: ZOOM_MAX,
    toDist: experienceMode === 'dashboard' ? dashboardCameraDistance() : EXPLORE_CAM_DIST,
    fromPitch: 0.9,
    toPitch: experienceMode === 'dashboard' ? DASHBOARD_CAM_PITCH : EXPLORE_CAM_PITCH,
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
  camDist = experienceMode === 'dashboard' ? dashboardCameraDistance() : EXPLORE_CAM_DIST;
  camPitch = experienceMode === 'dashboard' ? DASHBOARD_CAM_PITCH : EXPLORE_CAM_PITCH;
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
const pinch = { active: false, startDist: 0, startCam: EXPLORE_CAM_DIST };
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
  if (!selectedItem) return;
  selectedItem.data.dir.copy(dir).normalize();
  applyPropTransform(selectedItem);
  refreshPropCollider(selectedItem);
  if (selectedItem.data.type === 'cottage') rebuildDrivewaysThrottled();  // fires per pointermove
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
  if (selectedItem.isPath) removePath(selectedItem);
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
    item = spawnPath({ kind: 'path', type: selectedItem.data.type, dirs });
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
  const item = spawnPath({ kind: 'path', type, dirs });
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
addEventListener('pointerup', () => {
  // commit a drawing point if the press was a click (not a drag)
  if (drawingType && drawPointerStart) {
    if (pendingDrawDir) addDrawPoint(pendingDrawDir);
    pendingDrawDir = null;
    drawPointerStart = null;
    return;
  }
  if (editDragging) {
    saveLayout();
    // the throttle may have skipped the last drag frames — settle driveways/flags
    if (selectedItem) syncCottageExtras(selectedItem.data.type);
  }
  editDragging = false;
  camOrbiting = false;
});
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
  editMode = true;
  dashboardStopPatrol();
  focusNpc = null;                 // release any agent-focus camera
  focusSide = null;
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
const clock = new THREE.Clock();
function animate() {
  performanceGovernor.sample(performance.now());
  const dt = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.elapsedTime;

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
    updateAmbientScene(elapsed, editAtmosphere);
    ambientAudio.update({ elapsed, ...editAtmosphere });
    updateHorizonCulling();
    if (selectedItem) {
      // pulse the highlight ring so the selection is obvious
      selectRing.material.opacity = 0.6 + Math.abs(Math.sin(elapsed * 4)) * 0.4;
    }
    if (!webglContextLost) {
      performanceGovernor.beforeRender(dt);
      composer.render();
    }
    requestAnimationFrame(animate);
    return;
  }

  // ---- movement input: W/S = forward/backstep along facing · A/D = turn ----
  let fwd = 0, turn = 0;
  if (experienceMode === 'explore') {
    if (keys['w'] || keys['arrowup'])    fwd += 1;
    if (keys['s'] || keys['arrowdown'])  fwd -= 1;
    if (keys['a'] || keys['arrowleft'])  turn += 1;
    if (keys['d'] || keys['arrowright']) turn -= 1;
    fwd  += -stickVec.y;
    turn += -stickVec.x;
  }
  const moveMag = Math.min(1, Math.abs(fwd));

  // any movement input releases the agent-focus camera and closes overlays
  if (Math.abs(fwd) > 0.001 || Math.abs(turn) > 0.001) {
    dashboardStopPatrol();
    if (focusNpc) {
      focusNpc = null;
      focusSide = null;
      dashboardCloseCard();
    }
    dashboardCloseTeam();
    closeServicePanel();   // cheap no-op when nothing is open
  }

  // ---- jump physics (vertical hop above the surface) ----
  if (experienceMode === 'explore' && jumpRequested && onGround) {
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
    const axis = new THREE.Vector3().crossVectors(playerDir, travel).normalize();
    _q.setFromAxisAngle(axis, moveMag * WALK * dt);
    const nextDir = playerDir.clone().applyQuaternion(_q).normalize();
    if (!isBlockedSurfaceDir(nextDir)) {
      playerDir.copy(nextDir);
      playerForward.applyQuaternion(_q);
      camDir.applyQuaternion(_q);                      // parallel-transport the camera anchor
      keepPlayerForwardTangent();
    }
  }

  // ---- place & orient the player on the surface (+ jump height along up) ----
  const { up } = tangentBasis(playerDir);
  const inWater = isInWaterDir(playerDir);
  const waterSink = inWater ? -0.24 + Math.sin(elapsed * 7) * 0.025 : 0;
  player.position.copy(playerDir.clone().multiplyScalar(terrainRadius(playerDir) + 0.05 + jumpHeight + waterSink));
  // face along the transported tangent vector, standing up along `up`
  keepPlayerForwardTangent();
  const face = playerForward.clone();
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(up, face).normalize(), up, face
  );
  player.quaternion.setFromRotationMatrix(m);

  // little bob while walking
  playerStride += ((moveMag > 0.001 ? moveMag : 0) - playerStride) * Math.min(1, dt * 10);
  body.position.y = playerStride * Math.abs(Math.sin(elapsed * 9)) * 0.05 - (inWater ? 0.08 : 0);
  animateCharacterWalk(player, playerStride, elapsed);
  updateCharacterContactShadow(player, jumpHeight, playerStride, inWater);

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
    const toCam = focusSide.clone();
    toCam.sub(nUp.clone().multiplyScalar(toCam.dot(nUp)));     // keep tangent to surface
    if (toCam.lengthSq() < 1e-4) toCam.copy(tangentBasis(nUp).north);
    toCam.normalize();
    const focusTarget = aPos.clone()
      .add(toCam.multiplyScalar(innerWidth <= 520 ? 7.0 : 6.4))
      .add(nUp.clone().multiplyScalar(innerWidth <= 520 ? 3.35 : 3.05));
    _focusLookTarget.copy(aPos).add(nUp.clone().multiplyScalar(0.82));
    const focusHome = focusNpc.userData.agent?.home;
    if (focusHome?.mesh) {
      focusHome.mesh.getWorldPosition(_focusHomePosition);
      _focusHomePosition.add(focusHome.dir.clone().multiplyScalar(
        focusHome.data.type === 'lighthouse' ? 1.8 : 1.18
      ));
      _focusLookTarget.lerp(_focusHomePosition, focusHome.data.type === 'lighthouse' ? 0.30 : 0.24);
    }
    camera.position.lerp(focusTarget, 1 - Math.pow(0.02, dt));
    camera.up.copy(nUp);
    camera.lookAt(_focusLookTarget);
  } else {
    // the camera hangs behind its own anchor (camDir) — the character running
    // sideways doesn't swing the view; only dragging rotates it
    const back = camDir.clone().multiplyScalar(-1);
    // In dashboard mode the planet gets a very small cinematic sway and
    // breathing zoom. It is deliberately bounded, so labels and click targets
    // stay stable while the overview feels alive.
    const dashboardSway = experienceMode === 'dashboard' && !dragging
      ? Math.sin(elapsed * 0.11) * 0.055
      : 0;
    if (dashboardSway) back.applyAxisAngle(up, dashboardSway);
    const viewDist = camDist + (experienceMode === 'dashboard' ? Math.sin(elapsed * 0.16) * 0.16 : 0);
    const camOffset = up.clone().multiplyScalar(Math.sin(camPitch) * viewDist)
                      .add(back.multiplyScalar(Math.cos(camPitch) * viewDist));
    const dashboard = experienceMode === 'dashboard';
    const camTarget = dashboard ? camOffset : player.position.clone().add(camOffset);
    camera.position.lerp(camTarget, 1 - Math.pow(0.001, dt));
    camera.up.copy(up);
    camera.lookAt(dashboard
      ? up.clone().multiplyScalar(1.8)
      : player.position.clone().add(up.clone().multiplyScalar(0.8)));
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
  updateAmbientScene(elapsed, atmosphere);
  ambientAudio.update({ elapsed, ...atmosphere });
  updateHorizonCulling();
  updateWorldLabels();

  // Argos's lighthouse works as a live status landmark: the gold beam only
  // sweeps the cape while Argos is actively working.
  const argosBeam = ARGOS_AGENT?.home?.mesh?.userData?.lighthouseBeam;
  if (argosBeam?.visible) argosBeam.rotation.y += dt * (0.58 + atmosphere.wind * 0.34);

  if (!webglContextLost) {
    performanceGovernor.beforeRender(dt);
    composer.render();
  }
  requestAnimationFrame(animate);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  performanceGovernor.resize(innerWidth, innerHeight);
  if (experienceMode === 'dashboard' && !cameraIntro) camDist = dashboardCameraDistance();
});

// kick off — start the render loop immediately so the intro shows a live world behind it,
// then enable the Start button and let the user dismiss the intro with a soft fade.
animate();

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
camDist = dashboardCameraDistance();
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

  const PATH_NAMES = { road: '🛣️ 도로', river: '🌊 물길', trail: '🛤️ 흙길', snow: '❄️ 눈길', pond: '🏞️ 연못', sand: '🏖️ 모래밭', grass: '🌿 풀밭' };

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
      flashHint('클릭 선택 · 드래그 이동 · WASD/방향키 시점 이동 · Ctrl+D 복제 · Ctrl/⌘+Z 실행취소');
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
  window.onLayoutHistoryChanged = ({ canUndo, canRedo }) => {
    if (undoBtn) undoBtn.disabled = !canUndo;
    if (redoBtn) redoBtn.disabled = !canRedo;
  };
  window.onLayoutImported = (ok, err) => {
    flashHint(ok ? '레이아웃을 불러왔습니다 ✓' : `불러오기 실패: ${err || '형식 오류'}`);
  };
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
  const agentByKey = new Map(AGENTS.map((agent) => [agent.key, agent]));
  const chips = {};
  let dashboardView = {
    schemaVersion: 0,
    generatedAt: null,
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
  let connectionState = 'loading';
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
  barToggle?.addEventListener('click', () => setBarCollapsed(!barWrap.classList.contains('collapsed')));
  if (matchMedia('(max-width: 520px)').matches) setBarCollapsed(true);

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

  function renderStatusFreshness() {
    if (!freshnessEl) return;
    const checked = lastStatusReceivedAt ? timeAgo(lastStatusReceivedAt).replace(' 갱신', '') : '';
    const sourceAge = lastStatusGeneratedAt ? timeAgo(lastStatusGeneratedAt).replace(' 갱신', '') : '';
    const stale = lastStatusReceivedAt && Date.now() - Date.parse(lastStatusReceivedAt) > Math.max(120000, (RUNTIME_CONFIG.status.pollMs || 60000) * 2.5);
    freshnessEl.classList.toggle('stale', !!stale || connectionState === 'offline');
    if (connectionState === 'offline') freshnessEl.textContent = checked ? `연결 끊김 · 마지막 확인 ${checked}` : '상태 연결을 확인해주세요';
    else if (!checked) freshnessEl.textContent = '첫 상태를 확인하는 중';
    else freshnessEl.textContent = sourceAge ? `확인 ${checked} · 데이터 ${sourceAge}` : `마지막 확인 ${checked} · 항목 시각 미제공`;
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
    const costEl = el('agentCost');
    const healthLabel = healthLabels[status.health] || '';
    const modelLabel = [status.provider, status.model].filter(Boolean).join(' · ');
    const approvalLabel = approvalLabels[status.approvalState] || '';
    const riskLabel = [status.riskLevel, approvalLabel].filter(Boolean).join(' · ');

    healthEl.textContent = healthLabel ? '런타임 ' + healthLabel : '';
    healthEl.className = status.health ? 'health-' + status.health : '';
    modelEl.textContent = modelLabel;
    riskEl.textContent = riskLabel;
    costEl.textContent = status.cost
      ? status.cost.amount.toLocaleString(undefined, { maximumFractionDigits: 4 }) + (status.cost.currency ? ' ' + status.cost.currency : '')
      : '';
    for (const item of [healthEl, modelEl, riskEl, costEl]) item.hidden = !item.textContent;

    const runtimeEl = el('agentRuntime');
    runtimeEl.hidden = ![healthEl, modelEl, riskEl, costEl].some((item) => !item.hidden);

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
    el('agentSoul').textContent = a.identitySummary || a.soul || '';
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
    setInteractiveState(cardEl, true);
    document.body.classList.add('agent-detail-open');
    if (!editMode && a.npc) { focusNpc = a.npc; focusSide = null; }   // camera glides over
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
    if (restoreFocus && wasOpen) agentCardOpener?.isConnected && agentCardOpener.focus();
    agentCardOpener = null;
  }

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
    if (editMode) return;
    clickStart = { x: e.clientX, y: e.clientY };
  });
  addEventListener('pointerup', (e) => {
    if (editMode || !clickStart) return;
    const moved = Math.hypot(e.clientX - clickStart.x, e.clientY - clickStart.y);
    clickStart = null;
    if (moved > 6) return;                       // it was a camera drag, not a click
    setPointerNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);
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

  const clean = (v, max) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, max) : null;
  const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const normalizeEnum = (value, allowed) => {
    const normalized = clean(value, 32)?.toLowerCase() || null;
    return normalized && allowed.includes(normalized) ? normalized : null;
  };
  const normalizeCost = (value) => {
    const record = Number.isFinite(value) ? { amount: value } : value;
    if (!isRecord(record) || !Number.isFinite(record.amount)) return null;
    const amount = THREE.MathUtils.clamp(record.amount, 0, 1000000);
    return { amount, currency: clean(record.currency, 8)?.toUpperCase() || '' };
  };
  const normalizeRiskLevel = (value) => {
    const risk = clean(value, 2)?.toUpperCase() || null;
    return ['L1', 'L2', 'L3', 'L4'].includes(risk) ? risk : null;
  };
  const normalizeAgentKey = (value) => {
    const key = clean(value, 40);
    return key && agentByKey.has(key) ? key : null;
  };
  const normalizeIdList = (value) => Array.isArray(value)
    ? value.map((item) => clean(item, 120)).filter(Boolean).slice(0, 20)
    : [];
  const normalizeTask = (value) => {
    if (!isRecord(value)) return null;
    const title = clean(value.title, 100);
    if (!title) return null;
    const allowedStatuses = [
      'queued', 'running', 'blocked', 'waiting_approval',
      'verifying', 'completed', 'failed', 'cancelled',
    ];
    const status = normalizeEnum(value.status, allowedStatuses) || 'queued';
    return {
      id: clean(value.id, 120) || '',
      title,
      ownerAgent: normalizeAgentKey(value.ownerAgent ?? value.owner_agent),
      requester: normalizeAgentKey(value.requester),
      status,
      parentIds: normalizeIdList(value.parentIds ?? value.parents),
      dependencyIds: normalizeIdList(value.dependencyIds ?? value.dependencies),
      riskLevel: normalizeRiskLevel(value.riskLevel ?? value.risk_level),
      approvalState: normalizeEnum(
        value.approvalState ?? value.approval_state,
        ['not_required', 'pending', 'approved', 'rejected'],
      ),
      verifier: normalizeAgentKey(value.verifier),
      progress: Number.isFinite(value.progress)
        ? THREE.MathUtils.clamp(value.progress, 0, 1)
        : null,
      updatedAt: clean(value.updatedAt ?? value.updated_at, 40),
    };
  };
  const normalizeApproval = (value) => {
    if (!isRecord(value)) return null;
    const actionSummary = clean(value.actionSummary ?? value.action_summary, 140);
    if (!actionSummary) return null;
    return {
      id: clean(value.id, 120) || '',
      taskId: clean(value.taskId ?? value.task_id, 120),
      requestedBy: normalizeAgentKey(value.requestedBy ?? value.requested_by),
      riskLevel: normalizeRiskLevel(value.riskLevel ?? value.risk_level) || 'L4',
      status: normalizeEnum(value.status, ['pending', 'approved', 'rejected', 'cancelled']) || 'pending',
      actionSummary,
      impactSummary: clean(value.impactSummary ?? value.impact_summary, 180),
      rollbackSummary: clean(value.rollbackSummary ?? value.rollback_summary, 180),
      requestedAt: clean(value.requestedAt ?? value.requested_at, 40),
    };
  };
  function normalizeDashboardView(meta) {
    const team = isRecord(meta.team) ? meta.team : {};
    const runtime = isRecord(meta.runtime) ? meta.runtime : {};
    const schemaVersion = Number.isInteger(meta.schemaVersion) ? meta.schemaVersion : 0;
    return {
      schemaVersion,
      generatedAt: clean(meta.generatedAt, 40),
      source: clean(meta.source, 40) || (schemaVersion > 0 ? 'bridge' : 'legacy'),
      teamHealth: normalizeEnum(
        team.health ?? runtime.health,
        ['healthy', 'degraded', 'error', 'offline'],
      ),
      tasks: (Array.isArray(meta.tasks) ? meta.tasks : [])
        .map(normalizeTask).filter(Boolean).slice(0, 24),
      approvals: (Array.isArray(meta.approvals) ? meta.approvals : [])
        .map(normalizeApproval).filter(Boolean).slice(0, 16),
    };
  }

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
  const isQuietAgent = (agent) => /대기|휴식|오프라인/.test(agent.status.state || '');
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
      renderTeamEmpty(container, '☕', '실행 중인 작업 없음', 'Hermes가 작업을 시작하면 이곳에 흐름이 나타납니다.');
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
    return 'healthy';
  }
  function renderTeamOverview() {
    if (!teamPanelEl) return;
    const tasks = currentTasks();
    const approvals = pendingApprovals();
    const activeTaskStates = new Set(['running', 'blocked', 'waiting_approval', 'verifying']);
    const taskOwners = new Set(
      tasks.filter((task) => activeTaskStates.has(task.status) && task.ownerAgent)
        .map((task) => task.ownerAgent)
    );
    const activeAgents = AGENTS.filter((agent) =>
      !isQuietAgent(agent) && agentTaskStatus(agent) !== 'completed'
    ).length;
    const activeCount = Math.max(activeAgents, taskOwners.size);
    const health = resolvedTeamHealth();
    const healthLabel = {
      healthy: '정상',
      degraded: '주의',
      error: '오류',
      offline: '중단',
    }[health] || '준비';

    el('teamPanelSummary').textContent = TEAM_CONFIG.systemSummary || '역할이 분리된 에이전트 팀의 현재 흐름입니다.';
    const source = dashboardView.schemaVersion > 0
      ? 'v' + dashboardView.schemaVersion + ' · ' + (dashboardView.source || 'bridge')
      : '정적 상태';
    el('teamPanelSource').textContent = source;
    el('teamPanelSource').title = dashboardView.generatedAt || 'Hermes bridge 연결 전';
    el('teamMetricAgents').textContent = String(AGENTS.length);
    el('teamMetricActive').textContent = String(activeCount);
    el('teamMetricApprovals').textContent = String(approvals.length);
    el('teamMetricHealth').textContent = healthLabel;
    el('teamMetricHealth').dataset.health = health || 'ready';

    if (teamApprovalBadge) {
      teamApprovalBadge.hidden = approvals.length === 0;
      teamApprovalBadge.textContent = String(approvals.length);
    }
    teamOverviewBtn?.classList.toggle('has-approval', approvals.length > 0);
    teamOverviewBtn?.setAttribute(
      'aria-label',
      approvals.length ? '팀 흐름 열기, 승인 대기 ' + approvals.length + '건' : '팀 흐름 열기',
    );
    renderTeamHandoffs();
    renderTeamTasks(tasks);
    renderTeamApprovals(approvals);
  }

  function applyAgentStatus(data, meta = {}) {
    if (!data || typeof data !== 'object') return;
    lastStatusReceivedAt = new Date().toISOString();
    lastStatusGeneratedAt = clean(meta.generatedAt, 40);
    dashboardView = normalizeDashboardView(meta);
    for (const a of AGENTS) {
      const s = data[a.key];
      if (!isRecord(s)) continue;
      const runtime = isRecord(s.runtime) ? s.runtime : s;
      const state = clean(s.state, 16);
      if (state) a.status.state = state;
      if (typeof s.task === 'string') a.status.task = s.task.trim().slice(0, 80);
      a.status.updatedAt = clean(s.updatedAt, 40);
      a.status.progress = Number.isFinite(s.progress)
        ? THREE.MathUtils.clamp(s.progress, 0, 1)
        : null;
      a.status.runId = clean(s.runId, 120);
      a.status.result = normalizePublicResult(s.result);
      a.status.results = normalizePublicResults(s.results);
      a.status.health = normalizeEnum(runtime.health, ['healthy', 'degraded', 'error', 'offline']);
      a.status.model = clean(runtime.model, 80);
      a.status.provider = clean(runtime.provider, 40);
      a.status.blocker = clean(runtime.blocker, 160);
      a.status.approvalState = normalizeEnum(
        runtime.approvalState,
        ['not_required', 'pending', 'approved', 'rejected'],
      );
      a.status.riskLevel = normalizeRiskLevel(runtime.riskLevel);
      a.status.currentTaskId = clean(runtime.currentTaskId, 120);
      a.status.lastActivityAt = clean(runtime.lastActivityAt, 40) || a.status.updatedAt;
      a.status.cost = normalizeCost(runtime.cost);
    }
    ambientAudio.observeAgentStates(AGENTS);
    document.body.dataset.statusSchema = String(meta.schemaVersion ?? 0);
    refreshBar();
    renderTeamOverview();
    syncAgentHomeStatusVisuals();
    refreshOpenServicePanel();
    refreshRecentResultsUi();
    renderStatusFreshness();
  }
  renderTeamOverview();
  refreshRecentResultsUi();
  statusSource = createAgentStatusSource({
    config: RUNTIME_CONFIG.status,
    onSnapshot: applyAgentStatus,
    onConnectionChange(state) {
      connectionState = state;
      if (connectionEl) {
        connectionEl.className = `status-connection ${state}`;
        connectionEl.textContent = ({ live: '실시간', polling: '파일 연동', loading: '연결 중', offline: '오프라인' })[state] || state;
      }
      renderStatusFreshness();
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
  let openFor = null;          // agent whose panel is open
  let nearAgent = null;        // agent whose door we're standing at
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
    try { if (url) parsedUrl = new URL(url, location.href); } catch (_) { /* invalid service URL */ }
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
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock');
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
    if (!editMode && !openFor && experienceMode === 'explore') {
      for (const a of AGENTS) {
        const doorDir = homeDoorDir(a.home);
        if (!doorDir) continue;
        const d = playerDir.angleTo(doorDir);
        if (d < bestD) { best = a; bestD = d; }
      }
    }
    if (best === nearAgent) return;
    nearAgent = best;
    if (best) {
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
  promptEl.addEventListener('click', () => { if (nearAgent) openServicePanel(nearAgent); });
  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'f' && !isUiInteractionTarget(e.target) && nearAgent && !editMode && !openFor) openServicePanel(nearAgent);
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
      return {
        camDist: +camDist.toFixed(3),
        camPitch: +camPitch.toFixed(3),
        cinematic: !!cameraIntro,
        mode: experienceMode,
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
      document.documentElement.dataset.qaHomes = JSON.stringify(homes);
      document.documentElement.dataset.qaCharacters = JSON.stringify(window.devPlanet.characters());
      document.documentElement.dataset.qaReady = homes.every((item) => item.ok) ? 'pass' : 'fail';
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
