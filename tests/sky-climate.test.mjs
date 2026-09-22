import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three/build/three.module.min.js';
import { createSkySystem } from '../src/sky.js';

const FRONT = new THREE.Vector3(0, 0.5774647206268071, 0.8164156395068652).normalize();
const BACK = FRONT.clone().negate();
const NOON = Date.parse('2026-09-12T03:00:00.000Z');
const HOUR_MS = 3600000;
const flush = () => new Promise(resolve => setImmediate(resolve));
const noop = () => {};

function close(actual, expected, tolerance = 0.002) {
  assert.ok(Number.isFinite(actual), `not finite: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function finiteState(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `not finite: ${value}`);
  else if (value && typeof value === 'object') Object.values(value).forEach(finiteState);
}

function canvasStub() {
  const canvas = { width: 0, height: 0 };
  const context = new Proxy({
    canvas,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
  }, { get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : noop });
  canvas.getContext = kind => {
    assert.equal(kind, '2d');
    return context;
  };
  return canvas;
}

function disposeScene(scene) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  scene.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
    object.shadow?.dispose();
  });
  textures.forEach(texture => texture.dispose());
  materials.forEach(material => material.dispose());
  geometries.forEach(geometry => geometry.dispose());
  scene.clear();
}

function fixture(t, { timestamp = NOON, storage = 'absent', transport, ...options } = {}) {
  let wallTime = timestamp;
  let elapsed = 0;
  let nextTimer = 1;
  const timers = new Map();
  const restore = [];
  const requests = [];
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1000);
  const player = FRONT.clone();
  const motion = { matches: false, media: '(prefers-reduced-motion: reduce)',
    addEventListener: noop, removeEventListener: noop };
  const doc = {
    hidden: false,
    getElementById: () => null,
    createElement(tag) { assert.equal(tag, 'canvas'); return canvasStub(); },
    addEventListener: noop,
    removeEventListener: noop,
  };

  function replace(owner, key, descriptor) {
    const original = Object.getOwnPropertyDescriptor(owner, key);
    restore.push(() => {
      if (original) Object.defineProperty(owner, key, original);
      else Reflect.deleteProperty(owner, key);
    });
    if (descriptor) Object.defineProperty(owner, key, { configurable: true, ...descriptor });
    else Reflect.deleteProperty(owner, key);
  }
  const globalValue = (key, value) => replace(globalThis, key, { writable: true, value });

  function schedule(callback, delay, repeat, args) {
    assert.equal(typeof callback, 'function');
    assert.ok(Number.isFinite(delay) && delay > 0, `invalid timer delay: ${delay}`);
    const id = nextTimer++;
    timers.set(id, { callback, delay, repeat, args, due: wallTime + delay });
    return id;
  }

  // No real timers or transports: hourly texture work and request deadlines are
  // advanced explicitly, so tests can detect hidden polling without waiting.
  globalValue('setTimeout', (callback, delay, ...args) => schedule(callback, delay, false, args));
  globalValue('setInterval', (callback, delay, ...args) => schedule(callback, delay, true, args));
  globalValue('clearTimeout', id => timers.delete(id));
  globalValue('clearInterval', id => timers.delete(id));
  globalValue('document', doc);
  globalValue('matchMedia', query => {
    assert.equal(query, motion.media);
    return motion;
  });
  replace(Date, 'now', { writable: true, value: () => wallTime });
  replace(globalThis, 'localStorage', storage === 'denied'
    ? { get() { throw new Error('Storage access denied'); } } : null);
  globalValue('fetch', async (url, init) => {
    requests.push({ url: new URL(url), init });
    if (!transport) throw new Error('Offline test transport');
    return transport(url, init);
  });

  t.after(async () => {
    try {
      // Abort any request left by a failed assertion before restoring globals.
      for (const timer of [...timers.values()]) if (!timer.repeat) timer.callback(...timer.args);
      await flush();
      disposeScene(scene);
      timers.clear();
    } finally {
      restore.reverse().forEach(reset => reset());
    }
  });

  const weatherElements = {
    icon: { textContent: '' }, temp: { textContent: '' }, time: { textContent: '', title: '' },
  };
  const renderer = { toneMappingExposure: 1, shadowMap: { needsUpdate: false } };
  const vignettePass = { uniforms: {
    tint: { value: new THREE.Color() }, tintAmount: { value: 0 }, darkness: { value: 0 },
  } };
  const theme = { world: {
    fogDay: 0xd9edf4, fogTwilight: 0xbfb8cf, fogNight: 0x17232f,
    skyDay: { top: 0x72bde0, mid: 0xa6d8e9, bottom: 0xe4f3f5 },
    skyTwilight: { top: 0x777aab, mid: 0xd3a8b5, bottom: 0xf1d4bf },
    skyNight: { top: 0x111a2a, mid: 0x203046, bottom: 0x34485b },
  } };

  function orbit(direction) {
    camera.position.copy(direction).normalize().multiplyScalar(25);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
  }
  orbit(FRONT);
  const sky = createSkySystem({ scene, camera, renderer, vignettePass, theme,
    radius: 8, weatherElements, ...options });

  function frame({ edit = false, dt = 0.1 } = {}) {
    elapsed += dt;
    if (edit) sky.updateEdit(dt, elapsed);
    else sky.update({ dt, elapsed, playerDirection: player, viewDirection: camera.position });
  }

  function settle(direction = FRONT, options = {}) {
    orbit(direction);
    for (let i = 0; i < 120; i++) frame(options);
    finiteState(sky.dayState());
    finiteState(sky.weatherState());
    finiteState(sky.ambientState());
  }

  function advance(ms) {
    const target = wallTime + ms;
    let steps = 0;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= target)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      assert.ok(++steps < 1000, 'unexpected runaway timer scheduling');
      const [id, timer] = next;
      wallTime = timer.due;
      if (timer.repeat) timer.due += timer.delay;
      else timers.delete(id);
      timer.callback(...timer.args);
    }
    wallTime = target;
  }

  return { sky, scene, camera, player, renderer, motion, doc, requests, weatherElements,
    timers, orbit, frame, settle, advance };
}

function particles(f) {
  const snow = f.scene.getObjectByName('weather-snow');
  const rain = f.scene.children.find(object => object.isLineSegments);
  assert.ok(snow?.isPoints);
  assert.ok(rain?.isLineSegments);
  return { snow, rain };
}

function current(overrides = {}) {
  return { temperature_2m: 23, weather_code: 0, wind_speed_10m: 16,
    precipitation: 0, snowfall: 0, cloud_cover: 20, ...overrides };
}

function response(weather, utc_offset_seconds = 43200) {
  return { ok: true, json: async () => ({ current: weather, utc_offset_seconds }) };
}

// Fixtures temporarily replace browser globals, so these real-module tests run serially.
describe('integrated sky climate', { concurrency: false }, () => {
  for (const [label, timestamp, day, time] of [
    ['noon', NOON, 1, '12:00'], ['midnight', NOON + 12 * HOUR_MS, 0, '00:00'],
  ]) {
    test(`initial Seoul ${label} uses the fixed solar clock`, t => {
      const f = fixture(t, { timestamp, devWeatherPreset: 'clear' });
      close(f.sky.dayState().visibleDayFactor, day);
      f.settle();
      const state = f.sky.dayState();
      assert.equal(state.city, 'seoul');
      close(state.targetDayFactor, day);
      close(state.visibleDayFactor, day);
      assert.equal(f.weatherElements.time.textContent, time);
      assert.equal(f.requests.length, 0);
    });
  }

  test('camera orbit changes hemisphere and eases daylight while the player stays fixed', t => {
    const f = fixture(t, { devWeatherPreset: 'clear' });
    f.settle();
    const noon = f.sky.dayState();
    const player = f.player.clone();
    const sunDirection = f.sky.celestial.sun.position.clone().sub(f.camera.position).normalize();
    close(sunDirection.dot(FRONT), 1);

    f.orbit(BACK);
    f.frame({ dt: 0.25 });
    const transitioning = f.sky.dayState();
    assert.equal(transitioning.city, 'rio');
    close(transitioning.targetDayFactor, 0);
    assert.ok(transitioning.visibleDayFactor > 0 && transitioning.visibleDayFactor < 1);
    f.settle(BACK);
    const night = f.sky.dayState();
    close(night.visibleDayFactor, 0);
    close(noon.targetDayFactor + night.targetDayFactor, 1);
    close(noon.solarElevation, 1);
    close(night.solarElevation, -1);
    assert.equal(f.weatherElements.time.textContent, '00:00');
    assert.notDeepEqual(night.sky, noon.sky);
    assert.ok(night.exposure < noon.exposure);
    assert.ok(f.sky.celestial.moon.material.opacity > f.sky.celestial.sun.material.opacity);
    assert.deepEqual(f.sky.celestial.sun.position.clone().sub(f.camera.position).normalize().toArray(),
      sunDirection.toArray());
    assert.deepEqual(f.player.toArray(), player.toArray());

    f.settle();
    assert.equal(f.sky.dayState().city, 'seoul');
    close(f.sky.dayState().visibleDayFactor, 1);
    assert.equal(f.weatherElements.time.textContent, '12:00');
  });

  for (const preset of ['clear', 'cloudy']) {
    test(`${preset} has neither rain nor snow in rendering and ambient audio state`, t => {
      const f = fixture(t, { devWeatherPreset: preset });
      f.settle();
      const state = f.sky.weatherState();
      const { snow, rain } = particles(f);
      assert.equal(state.kind, preset);
      assert.equal(state.source, 'preview');
      assert.equal(state.precip, 0);
      assert.equal(state.snow, 0);
      assert.equal(state.raining, false);
      assert.equal(state.snowing, false);
      assert.equal(rain.visible, false);
      assert.equal(snow.visible, false);
      assert.equal(f.sky.ambientState().precip, 0);
      if (preset === 'cloudy') assert.ok(state.visibleClouds > 0);
      assert.equal(f.requests.length, 0);
    });
  }

  for (const preset of ['rain', 'storm']) {
    test(`${preset} updates the real rain buffer and feeds rain-only ambient strength`, t => {
      const f = fixture(t, { devWeatherPreset: preset });
      f.settle();
      const state = f.sky.weatherState();
      const { rain } = particles(f);
      const positions = rain.geometry.getAttribute('position');
      const before = positions.array.slice();
      const version = positions.version;
      f.frame();
      assert.equal(state.raining, true);
      assert.ok(state.precip > 0 && state.rainOpacity > 0);
      assert.equal(state.snowing, false);
      assert.equal(state.snow, 0);
      assert.ok(f.sky.ambientState().precip > 0);
      assert.ok(positions.version > version);
      assert.notDeepEqual(positions.array, before);
      assert.equal(f.requests.length, 0);
    });
  }

  test('snow emits actual snow particles with zero rain and zero rain-audio strength', t => {
    const f = fixture(t, { devWeatherPreset: 'snow' });
    f.settle();
    const state = f.sky.weatherState();
    const { snow, rain } = particles(f);
    const positions = snow.geometry.getAttribute('position');
    const version = positions.version;
    const before = positions.array.slice();
    f.frame();
    assert.equal(state.kind, 'snow');
    assert.equal(state.snowing, true);
    assert.ok(state.snow > 0);
    assert.equal(state.precip, 0);
    assert.equal(state.raining, false);
    assert.equal(state.rainOpacity, 0);
    assert.equal(rain.visible, false);
    assert.equal(snow.visible, true);
    assert.equal(f.sky.ambientState().kind, 'snow');
    assert.equal(f.sky.ambientState().precip, 0);
    assert.ok(positions.version > version);
    assert.notDeepEqual(positions.array, before);
    assert.ok(positions.array.every(Number.isFinite));
  });

  test('performance tiers draw 240/160/96 snowflakes from stable pooled geometry', t => {
    const f = fixture(t, { devWeatherPreset: 'snow' });
    f.settle();
    const { snow, rain } = particles(f);
    const snowGeometry = snow.geometry;
    const rainGeometry = rain.geometry;
    const snowBuffer = snow.geometry.getAttribute('position').array;
    const rainBuffer = rain.geometry.getAttribute('position').array;
    const childCount = f.scene.children.length;
    for (const [tier, snowCount, rainSegments] of [
      ['high', 240, 460], ['balanced', 160, 300], ['performance', 96, 160], ['high', 240, 460],
    ]) {
      f.sky.setPerformanceProfile({ tier, rainSegments, shadowMapSize: 512 });
      f.frame();
      const state = f.sky.weatherState();
      assert.equal(state.qualityTier, tier);
      assert.equal(state.snowCount, snowCount);
      assert.equal(state.snowPool, 240);
      assert.equal(state.rainPool, 460);
      assert.equal(state.rainSegments, rainSegments);
      assert.equal(snow.geometry.drawRange.count, snowCount);
      assert.equal(rain.geometry.drawRange.count, rainSegments * 2);
      assert.strictEqual(snow.geometry, snowGeometry);
      assert.strictEqual(rain.geometry, rainGeometry);
      assert.strictEqual(snow.geometry.getAttribute('position').array, snowBuffer);
      assert.strictEqual(rain.geometry.getAttribute('position').array, rainBuffer);
      assert.equal(f.scene.children.length, childCount);
    }
    assert.equal(snowBuffer.length, 240 * 3);
    assert.equal(rainBuffer.length, 460 * 6);
    assert.equal(f.renderer.shadowMap.needsUpdate, true);
  });

  for (const preset of ['snow', 'rain']) {
    test(`changing reduced-motion preference stops and resumes ${preset} without advancing particles`, t => {
      const f = fixture(t, { devWeatherPreset: preset });
      f.settle();
      const object = particles(f)[preset];
      const attribute = object.geometry.getAttribute('position');
      const before = attribute.array.slice();
      const version = attribute.version;
      f.motion.matches = true;
      for (let i = 0; i < 12; i++) f.frame();
      const stopped = f.sky.weatherState();
      assert.equal(stopped.reducedMotion, true);
      assert.equal(stopped.raining, false);
      assert.equal(stopped.snowing, false);
      assert.equal(object.visible, false);
      assert.equal(object.material.opacity, 0);
      assert.equal(attribute.version, version);
      assert.deepEqual(attribute.array, before);
      f.motion.matches = false;
      f.frame();
      assert.equal(f.sky.weatherState().reducedMotion, false);
      assert.equal(object.visible, true);
      assert.ok(attribute.version > version);
      assert.notDeepEqual(attribute.array, before);
    });
  }

  test('edit updates follow the camera hemisphere and rebase snow independently of the player', t => {
    const f = fixture(t, { devWeatherPreset: 'snow' });
    f.settle();
    f.settle(BACK, { edit: true });
    const camera = f.camera.position.clone();
    assert.equal(f.sky.dayState().city, 'rio');
    close(f.sky.dayState().targetDayFactor, 0);
    close(f.sky.dayState().visibleDayFactor, 0);
    assert.equal(f.weatherElements.time.textContent, '00:00');
    const positions = particles(f).snow.geometry.getAttribute('position');
    const mean = new THREE.Vector3();
    const position = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) mean.add(position.fromBufferAttribute(positions, i));
    assert.ok(mean.normalize().dot(BACK) > 0.9);
    assert.deepEqual(f.player.toArray(), FRONT.toArray());
    assert.deepEqual(f.camera.position.toArray(), camera.toArray());
    f.settle(FRONT, { edit: true });
    assert.equal(f.sky.dayState().city, 'seoul');
    close(f.sky.dayState().visibleDayFactor, 1);
  });

  test('live weather blends code floors, separates snow/rain and ignores API clock offsets', async t => {
    const f = fixture(t, { storage: 'denied', transport: async url => {
      const seoul = Number(new URL(url).searchParams.get('latitude')) > 0;
      return response(current(seoul
        ? { weather_code: 73, temperature_2m: -2.4, cloud_cover: 80 }
        : { weather_code: 63, temperature_2m: 25.4, cloud_cover: 90 }), seoul ? -43200 : 43200);
    } });
    assert.equal(f.requests.length, 0);
    assert.equal(f.sky.weatherState().source, 'fallback');
    f.frame();
    await flush();
    assert.equal(f.requests.length, 2);
    f.settle();
    const snow = f.sky.weatherState();
    assert.equal(snow.source, 'live');
    assert.equal(snow.kind, 'snow');
    assert.equal(snow.snowing, true);
    assert.ok(snow.snow >= 0.15);
    assert.equal(snow.precip, 0);
    assert.equal(snow.raining, false);
    assert.equal(f.sky.ambientState().precip, 0);
    assert.equal(f.weatherElements.time.textContent, '12:00');
    assert.equal(f.weatherElements.temp.textContent, '-2\u00b0');

    f.settle(BACK);
    const rain = f.sky.weatherState();
    assert.equal(rain.city, 'rio');
    assert.equal(rain.source, 'live');
    assert.equal(rain.kind, 'rain');
    assert.equal(rain.raining, true);
    assert.ok(rain.precip >= 0.15);
    assert.equal(rain.snowing, false);
    close(rain.snow, 0);
    assert.ok(f.sky.ambientState().precip > 0.15);
    assert.equal(f.weatherElements.time.textContent, '00:00');
    assert.equal(f.weatherElements.temp.textContent, '25\u00b0');
    assert.equal(f.requests.length, 2);
    assert.equal([...f.timers.values()].filter(timer => !timer.repeat).length, 0);
  });

  test('live fetching is frame-driven, ten-minute bounded and inactive while hidden', async t => {
    const f = fixture(t, { transport: async () => response(current()) });
    f.doc.hidden = true;
    f.settle();
    await flush();
    assert.equal(f.requests.length, 0);
    f.advance(65 * 60000);
    await flush();
    f.frame();
    await flush();
    assert.equal(f.requests.length, 0, 'neither hidden frames nor texture timers should fetch');

    f.doc.hidden = false;
    f.frame();
    await flush();
    assert.equal(f.requests.length, 2);
    for (const { url, init } of f.requests) {
      assert.equal(url.origin, 'https://api.open-meteo.com');
      assert.ok(init.signal instanceof AbortSignal);
    }
    f.settle();
    f.advance(600000 - 1);
    f.frame();
    await flush();
    assert.equal(f.requests.length, 2);
    f.advance(1);
    await flush();
    assert.equal(f.requests.length, 2, 'wall-clock passage alone must not fetch');
    f.frame();
    await flush();
    assert.equal(f.requests.length, 4);

    f.doc.hidden = true;
    f.advance(HOUR_MS);
    f.settle();
    await flush();
    assert.equal(f.requests.length, 4);
    f.doc.hidden = false;
    f.frame();
    await flush();
    assert.equal(f.requests.length, 6);
    f.settle();
    await flush();
    assert.equal(f.requests.length, 6);
    assert.equal([...f.timers.values()].filter(timer => !timer.repeat).length, 0);
  });

  for (const storage of ['absent', 'denied']) {
    test(`offline weather still shows advancing local clocks with ${storage} localStorage`, async t => {
      const f = fixture(t, { storage });
      f.frame();
      await flush();
      f.settle();
      assert.equal(f.sky.weatherState().source, 'fallback');
      assert.equal(f.sky.weatherState().kind, 'clear');
      assert.equal(f.weatherElements.temp.textContent, '--\u00b0');
      assert.equal(f.weatherElements.time.textContent, '12:00');
      const title = f.weatherElements.time.title;
      f.advance(61000);
      f.settle();
      assert.equal(f.weatherElements.time.textContent, '12:01');
      f.settle(BACK);
      assert.equal(f.sky.weatherState().source, 'fallback');
      assert.equal(f.weatherElements.time.textContent, '00:01');
      assert.notEqual(f.weatherElements.time.title, title);
      assert.equal(f.sky.weatherState().precip, 0);
      assert.equal(f.sky.weatherState().snow, 0);
      assert.equal(f.requests.length, 2);
    });
  }

  for (const preset of ['constructor', '__proto__']) {
    test(`prototype-like dev weather and season preset ${preset} is ignored with finite state`, async t => {
      const f = fixture(t, { devWeatherPreset: preset, devSeasonPreset: preset });
      f.frame();
      await flush();
      f.settle();
      const state = f.sky.weatherState();
      assert.equal(state.preset, null);
      assert.equal(state.seasonPreset, null);
      assert.equal(state.kind, 'clear');
      assert.equal(state.season, 'autumn');
      assert.equal(state.source, 'fallback');
      assert.equal(state.precip, 0);
      assert.equal(state.snow, 0);
      assert.equal(state.raining, false);
      assert.equal(state.snowing, false);
      close(f.sky.dayState().visibleDayFactor, 1);
      assert.equal(f.requests.length, 2, 'invalid previews must not disable live refresh');
    });
  }
});
