import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CITIES, WEATHER_PRESETS, weatherKind, weatherFactors,
  seoulSeason, localClock, solarState, selectClimateCity,
} from '../src/climate-model.js';

const FRONT = [0, 0.5774647206268071, 0.8164156395068652];
const EAST = [1, 0, 0];
const HOUR_MS = 3600000;
const NOON = Date.parse('2026-09-12T03:00:00.000Z');
const atHour = hour => NOON + (hour - 12) * HOUR_MS;
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const scaled = (vector, factor) => vector.map(value => value * factor);
const unit = vector => scaled(vector, 1 / Math.hypot(...vector));

function close(actual, expected, tolerance = 1e-12) {
  assert.ok(Number.isFinite(actual), `not finite: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function vectorClose(actual, expected, tolerance = 1e-12) {
  assert.equal(actual.length, 3);
  actual.forEach((value, index) => close(value, expected[index], tolerance));
}

function bounded(value, min = 0, max = 1) {
  assert.ok(Number.isFinite(value) && value >= min && value <= max, `out of bounds: ${value}`);
}

function weatherBounded(factors) {
  assert.deepEqual(Object.keys(factors).sort(), ['cloud', 'kind', 'precip', 'snow', 'wind']);
  for (const key of ['precip', 'snow', 'cloud', 'wind']) bounded(factors[key]);
}

test('city constants have the requested identity, coordinates and fixed offsets', () => {
  assert.deepEqual(CITIES, {
    seoul: { name: '\uC11C\uC6B8', lat: 37.5665, lon: 126.978, fallbackOffsetSeconds: 32400 },
    rio: { name: '\uB9AC\uC6B0', lat: -22.9068, lon: -43.1729, fallbackOffsetSeconds: -10800 },
  });
  assert.ok(Object.isFrozen(CITIES));
  assert.ok(Object.values(CITIES).every(Object.isFrozen));
});

test('presets are bounded, immutable and separate snowfall from rain', () => {
  assert.deepEqual(Object.keys(WEATHER_PRESETS), ['clear', 'cloudy', 'rain', 'snow', 'storm']);
  assert.ok(Object.isFrozen(WEATHER_PRESETS));
  for (const [kind, preset] of Object.entries(WEATHER_PRESETS)) {
    weatherBounded(preset);
    assert.equal(preset.kind, kind);
    assert.ok(Object.isFrozen(preset));
    assert.equal(preset.snow > 0, kind === 'snow');
    assert.equal(preset.precip > 0, kind === 'rain' || kind === 'storm');
  }
});

const WMO_GROUPS = {
  clear: [0],
  'partly-cloudy': [1, 2],
  cloudy: [3],
  fog: [45, 48],
  rain: [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82],
  snow: [71, 73, 75, 77, 85, 86],
  storm: [95, 96, 99],
};

test('every documented WMO code maps exactly, including freezing drizzle and hail storms', () => {
  for (const [kind, codes] of Object.entries(WMO_GROUPS)) {
    for (const code of codes) {
      assert.equal(weatherKind(code), kind, String(code));
      assert.equal(weatherKind(` ${code} `), kind);
    }
  }
});

test('unassigned and invalid WMO codes remain clear', () => {
  const known = new Set(Object.values(WMO_GROUPS).flat());
  for (let code = -10; code <= 110; code += 1) {
    if (!known.has(code)) assert.equal(weatherKind(code), 'clear', String(code));
  }
  for (const code of [51.5, 71.1, 95.5, 1000, undefined, null, NaN, Infinity,
    -Infinity, '', 'rain', 'NaN', true, false, [], [61], {}, Symbol('code'), 61n]) {
    assert.equal(weatherKind(code), 'clear');
  }
});

test('zero-precipitation WMO rain, snow and storm codes retain visible floors', () => {
  for (const [kind, floor] of [['rain', 0.16], ['snow', 0.16], ['storm', 0.62]]) {
    for (const weather_code of WMO_GROUPS[kind]) {
      for (const precipitation of [undefined, 0, -10, NaN]) {
        const factors = weatherFactors({ weather_code, precipitation, snowfall: 0 });
        weatherBounded(factors);
        assert.equal(factors.kind, kind);
        assert.equal(factors.precip, kind === 'snow' ? 0 : floor);
        assert.equal(factors.snow, kind === 'snow' ? floor : 0);
      }
    }
  }
});

test('snow never drives rain, and other conditions never emit snow particles', () => {
  for (const [kind, codes] of Object.entries(WMO_GROUPS)) {
    for (const weather_code of codes) {
      const factors = weatherFactors({ weather_code, precipitation: 100, snowfall: 100 });
      assert.equal(factors.precip, kind === 'rain' || kind === 'storm' ? 1 : 0);
      assert.equal(factors.snow, kind === 'snow' ? 1 : 0);
    }
  }
  const unknown = weatherFactors({ weather_code: 999, precipitation: 100, snowfall: 100 });
  assert.equal(unknown.kind, 'clear');
  assert.equal(unknown.precip, 0);
  assert.equal(unknown.snow, 0);
});

test('weather measurements normalize in default API units and preserve existing cloud floors', () => {
  assert.deepEqual(weatherFactors({ weather_code: 61, precipitation: 2, cloud_cover: 90, wind_speed_10m: 16 }),
    { kind: 'rain', precip: 0.5, snow: 0, cloud: 0.9, wind: 0.5 });
  assert.equal(weatherFactors({ weather_code: 73, snowfall: 1, precipitation: 4 }).snow, 0.5);
  assert.equal(weatherFactors({ weather_code: 73, precipitation: 2 }).snow, 0.5);
  assert.equal(weatherFactors({ weather_code: 73, snowfall: 0, precipitation: 4 }).snow, 0.16);
  for (const [weather_code, cloud] of [[0, 0], [2, 0], [3, 0.58], [45, 0.78], [61, 0.68], [71, 0.72], [95, 0.88]]) {
    assert.equal(weatherFactors({ weather_code, cloud_cover: -10 }).cloud, cloud);
  }
  assert.deepEqual(weatherFactors({ weather_code: '61', precipitation: '2', cloud_cover: '90', wind_speed_10m: '16' }),
    weatherFactors({ weather_code: 61, precipitation: 2, cloud_cover: 90, wind_speed_10m: 16 }));
});

test('missing, malformed and extreme measurements always return finite clamped strengths', () => {
  const zero = { kind: 'clear', precip: 0, snow: 0, cloud: 0, wind: 0 };
  for (const current of [undefined, null, false, '', 42, [], Symbol('current')]) {
    assert.deepEqual(weatherFactors(current), zero);
  }
  const values = [-Number.MAX_VALUE, -1, 0, 0.1, 1, 4, 100, Number.MAX_VALUE,
    NaN, Infinity, -Infinity, undefined, null, '', 'bad', true, {}, [], Symbol('value')];
  for (const weather_code of Object.values(WMO_GROUPS).flat()) {
    for (const value of values) {
      weatherBounded(weatherFactors({ weather_code, precipitation: value, snowfall: value,
        cloud_cover: value, wind_speed_10m: value }));
    }
  }
  for (const value of [NaN, Infinity, -Infinity, 'bad', null, true, {}, Symbol('value')]) {
    assert.deepEqual(weatherFactors({ weather_code: 0, precipitation: value, snowfall: value,
      cloud_cover: value, wind_speed_10m: value }), zero);
  }
  assert.deepEqual(weatherFactors({ weather_code: 61, precipitation: Number.MAX_VALUE,
    cloud_cover: Number.MAX_VALUE, wind_speed_10m: Number.MAX_VALUE }),
  { kind: 'rain', precip: 1, snow: 0, cloud: 1, wind: 1 });
});

test('weather normalization does not mutate its input or share mutable results', () => {
  const input = Object.freeze({ weather_code: 71, precipitation: 2, cloud_cover: 80, wind_speed_10m: 16 });
  const before = { ...input };
  const result = weatherFactors(input);
  result.snow = 0;
  assert.deepEqual(input, before);
  assert.equal(weatherFactors(input).snow, 0.5);
});

test('local clocks include fractional hours and keep Seoul exactly twelve hours ahead of Rio', () => {
  assert.deepEqual(localClock(NOON), { hour: 12, time: '12:00', month: 9 });
  assert.deepEqual(localClock(NOON, 'rio'), { hour: 0, time: '00:00', month: 9 });
  assert.deepEqual(localClock(Date.parse('2026-08-31T15:05:00Z')),
    { hour: 0 + 5 / 60, time: '00:05', month: 9 });
  assert.deepEqual(localClock(Date.parse('2026-08-31T15:05:00Z'), 'rio'),
    { hour: 12 + 5 / 60, time: '12:05', month: 8 });
  const fractional = NOON + 34 * 60000 + 56 * 1000 + 789;
  close(localClock(fractional).hour, 12 + 34 / 60 + 56 / 3600 + 789 / HOUR_MS);
  assert.equal(localClock(fractional).time, '12:34');
  for (const start of [0, -24 * HOUR_MS, Date.parse('2026-01-01T00:00:00Z'),
    Date.parse('2026-06-01T00:00:00Z'), Date.parse('2026-12-31T00:00:00Z')]) {
    for (let hour = 0; hour < 48; hour += 0.25) {
      const stamp = start + hour * HOUR_MS;
      close((localClock(stamp).hour - localClock(stamp, 'rio').hour + 24) % 24, 12);
    }
  }
});

test('clock city keys never use supplied API offsets or unknown city properties', () => {
  const expected = localClock(NOON);
  for (const city of [undefined, null, 'missing', 'constructor', '__proto__', '', 1,
    { name: 'rio', utc_offset_seconds: 0, fallbackOffsetSeconds: 0 }]) {
    assert.deepEqual(localClock(NOON, city), expected);
  }
  assert.deepEqual(localClock(NOON, 'seoul', { utc_offset_seconds: -43200 }), expected);
  assert.deepEqual(localClock(NOON, 'rio', { utc_offset_seconds: 43200 }),
    { hour: 0, time: '00:00', month: 9 });
  assert.throws(() => { CITIES.seoul.fallbackOffsetSeconds = 0; }, TypeError);
});

test('seasons use every KST month, including leap day and UTC/KST boundary rollovers', () => {
  const seasons = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer',
    'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];
  seasons.forEach((season, index) => {
    const firstKst = Date.UTC(2026, index, 1) - 9 * HOUR_MS;
    assert.equal(localClock(firstKst).month, index + 1);
    assert.equal(seoulSeason(firstKst), season);
    assert.equal(seoulSeason(firstKst - 1), seasons[(index + 11) % 12]);
    assert.equal(localClock(firstKst).time, '00:00');
    assert.equal(localClock(firstKst - 1).time, '23:59');
  });
  assert.equal(seoulSeason(Date.parse('2024-02-29T14:59:59.999Z')), 'winter');
  assert.equal(seoulSeason(Date.parse('2024-02-29T15:00:00.000Z')), 'spring');
  assert.equal(localClock(Date.parse('2025-12-31T15:00:00Z')).month, 1);
});

test('invalid or out-of-range timestamps deterministically fall back to epoch zero', () => {
  for (const stamp of [undefined, null, NaN, Infinity, -Infinity, Number.MAX_VALUE,
    -Number.MAX_VALUE, 8640000000000000, -8640000000000000, '2026-01-01', '0', {},
    new Date(NOON), 0n, Symbol('time')]) {
    assert.deepEqual(localClock(stamp), localClock(0));
    assert.deepEqual(localClock(stamp, 'rio'), localClock(0, 'rio'));
    assert.equal(seoulSeason(stamp), 'winter');
    assert.deepEqual(solarState(stamp, FRONT), solarState(0, FRONT));
  }
  assert.deepEqual(localClock(0), { hour: 9, time: '09:00', month: 1 });
  assert.deepEqual(localClock(0, 'rio'), { hour: 21, time: '21:00', month: 12 });
});

test('KST dawn, noon, dusk and midnight trace the specified great circle', () => {
  const front = unit(FRONT);
  for (const [hour, expectedSun, expectedElevation, expectedDay] of [
    [0, scaled(front, -1), -1, 0],
    [6, scaled(EAST, -1), 0, 0.5],
    [12, front, 1, 1],
    [18, EAST, 0, 0.5],
    [24, scaled(front, -1), -1, 0],
  ]) {
    const state = solarState(atHour(hour), FRONT);
    assert.deepEqual(Object.keys(state).sort(), ['day', 'seoulHour', 'solarElevation', 'sunDirection']);
    close(state.seoulHour, hour % 24);
    vectorClose(state.sunDirection, expectedSun);
    close(state.solarElevation, expectedElevation);
    close(state.day, expectedDay);
    close(solarState(atHour(hour), scaled(FRONT, -1)).day, 1 - expectedDay);
  }
  for (let hour = 0; hour < 24; hour += 0.125) {
    const angle = (hour - 12) * Math.PI / 12;
    const expectedSun = front.map((value, index) => value * Math.cos(angle) + EAST[index] * Math.sin(angle));
    vectorClose(solarState(atHour(hour), FRONT).sunDirection, expectedSun);
  }
});

test('daylight is the exact bounded smoothstep of the signed solar dot product', () => {
  const front = [0, 0, 1];
  for (const elevation of [-1, -0.5, -0.18, -0.09, 0, 0.09, 0.18, 0.5, 1]) {
    const view = [Math.sqrt(1 - elevation * elevation), 0, elevation];
    const state = solarState(NOON, view, front);
    const t = Math.max(0, Math.min(1, (elevation + 0.18) / 0.36));
    close(state.solarElevation, elevation);
    close(state.day, t * t * (3 - 2 * t));
  }
  close(solarState(NOON, [Math.sqrt(1 - 0.09 ** 2), 0, -0.09], front).day, 0.15625);
});

test('full-sphere views and arbitrary antipodes have complementary day and night at all hours', () => {
  const fronts = [FRONT, [2, -3, 4], [1, 0, 0], [0, -1, 0]];
  for (const front of fronts) {
    for (let hour = 0; hour < 24; hour += 0.5) {
      const stamp = atHour(hour);
      const sun = solarState(stamp, front, front).sunDirection;
      close(Math.hypot(...sun), 1);
      close(solarState(stamp, sun, front).day, 1);
      close(solarState(stamp, scaled(sun, -1), front).day, 0);
      for (let latitude = -90; latitude <= 90; latitude += 30) {
        const lat = latitude * Math.PI / 180;
        for (let longitude = 0; longitude < 360; longitude += 30) {
          const lon = longitude * Math.PI / 180;
          const view = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
          const state = solarState(stamp, view, front);
          const opposite = solarState(stamp, scaled(view, -7), front);
          bounded(state.day);
          bounded(state.solarElevation, -1, 1);
          close(state.solarElevation, dot(view, sun));
          close(state.solarElevation + opposite.solarElevation, 0);
          close(state.day + opposite.day, 1);
          vectorClose(state.sunDirection, opposite.sunDirection);
          close(solarState(stamp + 12 * HOUR_MS, view, front).day, opposite.day);
        }
      }
    }
  }
});

test('custom fronts produce an orthonormal solar orbit, including the parallel-east case', () => {
  for (const input of [[2, -3, 4], [1, 0, 0], [-1, 0, 0], [1, 1e-9, 0], [0, 0, -3]]) {
    const front = unit(input);
    const noon = solarState(NOON, front, input).sunDirection;
    const east = solarState(atHour(18), front, input).sunDirection;
    vectorClose(noon, front);
    close(dot(front, east), 0);
    close(Math.hypot(...east), 1);
    for (let hour = 0; hour < 24; hour += 0.25) {
      const state = solarState(atHour(hour), front, input);
      const angle = (hour - 12) * Math.PI / 12;
      const expected = front.map((value, index) => value * Math.cos(angle) + east[index] * Math.sin(angle));
      vectorClose(state.sunDirection, expected);
      close(Math.hypot(...state.sunDirection), 1);
    }
  }
  const front = unit([2, -3, 4]);
  const expectedEast = unit(EAST.map((value, index) => value - front[0] * front[index]));
  vectorClose(solarState(atHour(18), front, front).sunDirection, expectedEast);
});

const INVALID_DIRECTIONS = [undefined, null, 0, '', [], [0, 0, 0], [1, 2],
  [NaN, 1, 0], [Infinity, 0, 1], ['1', 0, 0], {}, { x: 0, y: 0, z: 0 },
  { x: 1, y: 2 }, { x: NaN, y: 1, z: 0 }, Symbol('direction')];

test('direction normalization accepts arrays and vector objects without mutation or scale sensitivity', () => {
  const input = Object.freeze([2, -3, 4]);
  const front = Object.freeze({ x: 0, y: 2, z: 3 });
  const expected = solarState(atHour(8), input, front);
  for (const view of [{ x: 2, y: -3, z: 4 }, new Float64Array(input),
    scaled(input, 1e300), scaled(input, 1e-300)]) {
    const actual = solarState(atHour(8), view, [0, 2, 3]);
    close(actual.day, expected.day);
    close(actual.solarElevation, expected.solarElevation);
    vectorClose(actual.sunDirection, expected.sunDirection);
  }
  for (const tinyOrHuge of [[Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE]]) {
    close(solarState(NOON, tinyOrHuge, [1, 1, 1]).solarElevation, 1);
  }
  const fresh = solarState(NOON, FRONT);
  fresh.sunDirection[0] = 99;
  vectorClose(solarState(NOON, FRONT).sunDirection, unit(FRONT));
  assert.deepEqual(input, [2, -3, 4]);
  assert.deepEqual(front, { x: 0, y: 2, z: 3 });
});

test('invalid directions use deterministic solar and city fallbacks', () => {
  for (const invalid of INVALID_DIRECTIONS) {
    assert.deepEqual(solarState(NOON, invalid), solarState(NOON, FRONT));
    assert.deepEqual(solarState(NOON, [0, 1, 0], invalid), solarState(NOON, [0, 1, 0]));
    assert.deepEqual(solarState(NOON, invalid, [0, 1, 0]), solarState(NOON, [0, 1, 0], [0, 1, 0]));
    assert.equal(selectClimateCity(invalid, 'rio'), 'rio');
    assert.equal(selectClimateCity(invalid), 'seoul');
    assert.equal(selectClimateCity(invalid, 'unknown'), 'seoul');
    assert.equal(selectClimateCity(FRONT, 'rio', invalid), 'seoul');
  }
});

test('city selection uses strict plus/minus 0.08 hysteresis and retains both prior states in the band', () => {
  const front = [0, 0, 1];
  const viewAt = z => [Math.sqrt(1 - z * z), 0, z];
  for (const z of [-0.08, -0.079, 0, 0.079, 0.08]) {
    for (const previous of ['seoul', 'rio']) {
      assert.equal(selectClimateCity(viewAt(z), previous, front), previous, `${z}, ${previous}`);
    }
  }
  for (const previous of ['seoul', 'rio']) {
    assert.equal(selectClimateCity(viewAt(0.080001), previous, front), 'seoul');
    assert.equal(selectClimateCity(viewAt(-0.080001), previous, front), 'rio');
  }
  let city = 'seoul';
  for (const [z, expected] of [[-0.07, 'seoul'], [-0.09, 'rio'], [0.02, 'rio'],
    [0.07, 'rio'], [0.09, 'seoul'], [-0.01, 'seoul']]) {
    city = selectClimateCity(viewAt(z), city, front);
    assert.equal(city, expected);
  }
  assert.equal(selectClimateCity(viewAt(0), 'bad', front), 'seoul');
});

test('city identity is fixed by reference hemisphere, independent of solar day or night', () => {
  for (const front of [FRONT, [2, -3, 4], [1, 0, 0]]) {
    for (let hour = 0; hour < 24; hour += 1) {
      const stamp = atHour(hour);
      const view = scaled(front, 20);
      const opposite = scaled(front, -0.5);
      close(solarState(stamp, view, front).day + solarState(stamp, opposite, front).day, 1);
      assert.equal(selectClimateCity(view, 'rio', front), 'seoul');
      assert.equal(selectClimateCity(opposite, 'seoul', front), 'rio');
    }
  }
  assert.equal(solarState(atHour(0), FRONT).day, 0);
  assert.equal(selectClimateCity(FRONT), 'seoul');
  assert.equal(selectClimateCity({ x: -FRONT[0], y: -FRONT[1], z: -FRONT[2] }), 'rio');
});
