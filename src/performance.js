const QUALITY_ORDER = ['performance', 'balanced', 'high'];

const QUALITY_PROFILES = Object.freeze({
  high: Object.freeze({
    maxPixelRatio: 1.6,
    bloomStrength: 0.27,
    shadowMapSize: 1536,
    shadowFps: 60,
    rainSegments: 460,
  }),
  balanced: Object.freeze({
    maxPixelRatio: 1.35,
    bloomStrength: 0.24,
    shadowMapSize: 1024,
    shadowFps: 30,
    rainSegments: 380,
  }),
  performance: Object.freeze({
    maxPixelRatio: 1,
    bloomStrength: 0.20,
    shadowMapSize: 1024,
    shadowFps: 20,
    rainSegments: 300,
  }),
});

function normalizeTier(value) {
  const tier = String(value || '').toLowerCase();
  if (tier === 'low') return 'performance';
  return QUALITY_PROFILES[tier] ? tier : '';
}

function chooseInitialTier(nativePixelRatio) {
  const cores = Number(navigator.hardwareConcurrency) || 0;
  const memory = Number(navigator.deviceMemory) || 0;
  const retinaLaptop = nativePixelRatio > 1.45 && (!cores || cores <= 8);
  const compactRetina = nativePixelRatio > 1.45 && innerWidth <= 900;
  const lowMemory = memory > 0 && memory <= 4;
  return retinaLaptop || compactRetina || lowMemory ? 'balanced' : 'high';
}

/**
 * Keeps the diorama smooth without visibly flattening its art direction.
 *
 * The expensive work is fill-rate (Retina + bloom) and shadow rendering, not
 * the small JavaScript rain loop. Retina laptops therefore begin at a visually
 * close balanced tier. Runtime sampling can step down after sustained jank and
 * recover only after a long stable window, avoiding quality oscillation.
 */
export function createPerformanceGovernor({
  renderer,
  composer,
  bloom,
  qualityOverride = '',
} = {}) {
  const requestedTier = normalizeTier(qualityOverride);
  let nativePixelRatio = Math.max(1, Number(window.devicePixelRatio) || 1);
  let tier = requestedTier || chooseInitialTier(nativePixelRatio);
  let locked = !!requestedTier;
  let automaticCeiling = QUALITY_ORDER.indexOf(tier);
  let skySystem = null;
  let effectivePixelRatio = 1;
  let shadowAccumulator = 1;

  let lastFrameAt = 0;
  let frameMs = 16.7;
  let jankRate = 0;
  let sampleCount = 0;
  let slowBudget = 0;
  let fastBudget = 0;
  let lastTierChangeAt = performance.now();

  // EffectComposer invokes renderer.render() for several passes. Prevent the
  // default per-pass reset so diagnostics describe the whole composed frame.
  renderer.info.autoReset = false;

  function currentProfile() {
    return QUALITY_PROFILES[tier];
  }

  function syncSkyProfile() {
    const profile = currentProfile();
    skySystem?.setPerformanceProfile?.({
      tier,
      shadowMapSize: profile.shadowMapSize,
      rainSegments: profile.rainSegments,
    });
  }

  function applyTier(nextTier, force = false) {
    const normalized = normalizeTier(nextTier);
    if (!normalized || (!force && normalized === tier)) return false;
    tier = normalized;
    const profile = currentProfile();
    effectivePixelRatio = Math.min(nativePixelRatio, profile.maxPixelRatio);

    renderer.setPixelRatio(effectivePixelRatio);
    composer.setPixelRatio(effectivePixelRatio);
    bloom.strength = profile.bloomStrength;

    renderer.shadowMap.autoUpdate = profile.shadowFps >= 55;
    renderer.shadowMap.needsUpdate = true;
    shadowAccumulator = 1 / profile.shadowFps;
    syncSkyProfile();

    slowBudget = 0;
    fastBudget = 0;
    lastTierChangeAt = performance.now();
    if (document.body) document.body.dataset.renderQuality = tier;
    return true;
  }

  function sample(now = performance.now()) {
    if (!lastFrameAt) {
      lastFrameAt = now;
      return;
    }
    const rawFrameMs = now - lastFrameAt;
    lastFrameAt = now;
    if (document.hidden || rawFrameMs <= 0 || rawFrameMs > 120) {
      slowBudget = 0;
      fastBudget = 0;
      return;
    }

    frameMs += (rawFrameMs - frameMs) * 0.055;
    jankRate += ((rawFrameMs > 24 ? 1 : 0) - jankRate) * 0.045;
    sampleCount++;
    if (locked || sampleCount < 45 || now - lastTierChangeAt < 5000) return;

    const runningSlow = frameMs > 20.5 || jankRate > 0.20;
    if (runningSlow) {
      slowBudget += rawFrameMs;
      fastBudget = 0;
    } else {
      slowBudget = Math.max(0, slowBudget - rawFrameMs * 1.5);
      fastBudget = frameMs < 17.8 && jankRate < 0.07
        ? fastBudget + rawFrameMs
        : 0;
    }

    const tierIndex = QUALITY_ORDER.indexOf(tier);
    if (slowBudget >= 2200 && tierIndex > 0) {
      applyTier(QUALITY_ORDER[tierIndex - 1]);
    } else if (fastBudget >= 14000 && tierIndex < automaticCeiling) {
      applyTier(QUALITY_ORDER[tierIndex + 1]);
    }
  }

  function beforeRender(dt) {
    const profile = currentProfile();
    renderer.info.reset();
    if (profile.shadowFps >= 55) return;
    const interval = 1 / profile.shadowFps;
    shadowAccumulator += Math.max(0, Math.min(0.05, Number(dt) || 0));
    renderer.shadowMap.needsUpdate = false;
    if (shadowAccumulator >= interval) {
      shadowAccumulator %= interval;
      renderer.shadowMap.needsUpdate = true;
    }
  }

  function resize(width, height) {
    const nextNativePixelRatio = Math.max(1, Number(window.devicePixelRatio) || 1);
    const pixelRatioChanged = Math.abs(nextNativePixelRatio - nativePixelRatio) > 0.01;
    nativePixelRatio = nextNativePixelRatio;
    renderer.setSize(width, height);
    composer.setSize(width, height);
    if (pixelRatioChanged) applyTier(tier, true);
  }

  function attachSkySystem(system) {
    skySystem = system;
    syncSkyProfile();
  }

  function setTier(nextTier) {
    const normalized = normalizeTier(nextTier);
    if (!normalized) return state();
    locked = true;
    automaticCeiling = QUALITY_ORDER.indexOf(normalized);
    applyTier(normalized, true);
    return state();
  }

  function state() {
    const profile = currentProfile();
    const render = renderer.info?.render || {};
    return {
      tier,
      locked,
      nativePixelRatio: +nativePixelRatio.toFixed(2),
      pixelRatio: +effectivePixelRatio.toFixed(2),
      frameMs: +frameMs.toFixed(2),
      fps: +(1000 / Math.max(1, frameMs)).toFixed(1),
      jankPercent: +(jankRate * 100).toFixed(1),
      samples: sampleCount,
      slowBudgetMs: +slowBudget.toFixed(0),
      shadowMapSize: profile.shadowMapSize,
      shadowFps: profile.shadowFps,
      bloomStrength: profile.bloomStrength,
      rainSegments: profile.rainSegments,
      drawCalls: render.calls || 0,
      triangles: render.triangles || 0,
      lines: render.lines || 0,
    };
  }

  document.addEventListener('visibilitychange', () => {
    lastFrameAt = performance.now();
    slowBudget = 0;
    fastBudget = 0;
  });

  // The renderer starts at DPR 1 so the composer never allocates a wasteful
  // DPR-2 target before the selected profile is known.
  applyTier(tier, true);

  return {
    sample,
    beforeRender,
    resize,
    attachSkySystem,
    setTier,
    state,
  };
}
