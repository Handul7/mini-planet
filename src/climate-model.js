export const CITIES = Object.freeze({
  seoul: Object.freeze({
    name: '\uC11C\uC6B8',
    lat: 37.5665,
    lon: 126.978,
    fallbackOffsetSeconds: 32400,
  }),
  rio: Object.freeze({
    name: '\uB9AC\uC6B0',
    lat: -22.9068,
    lon: -43.1729,
    fallbackOffsetSeconds: -10800,
  }),
});

export const WEATHER_PRESETS = Object.freeze({
  clear: Object.freeze({ kind: 'clear', precip: 0, snow: 0, cloud: 0.02, wind: 0.14 }),
  cloudy: Object.freeze({ kind: 'cloudy', precip: 0, snow: 0, cloud: 0.72, wind: 0.32 }),
  rain: Object.freeze({ kind: 'rain', precip: 0.62, snow: 0, cloud: 0.86, wind: 0.52 }),
  snow: Object.freeze({ kind: 'snow', precip: 0, snow: 0.62, cloud: 0.82, wind: 0.32 }),
  storm: Object.freeze({ kind: 'storm', precip: 1, snow: 0, cloud: 1, wind: 0.92 }),
});

const DEFAULT_FRONT = Object.freeze([0, 0.5774647206268071, 0.8164156395068652]);
const CLOUD_FLOORS = Object.freeze({ cloudy: 0.58, fog: 0.78, rain: 0.68, snow: 0.72, storm: 0.88 });
const HOUR_MS = 3600000;
const MAX_TIMESTAMP_MS = 8640000000000000 - CITIES.seoul.fallbackOffsetSeconds * 1000;

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function finiteNumber(value, fallback = 0) {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
}

// Explicit Open-Meteo WMO codes; unassigned codes do not imply precipitation.
export function weatherKind(code) {
  switch (finiteNumber(code, -1)) {
    case 1: case 2:
      return 'partly-cloudy';
    case 3:
      return 'cloudy';
    case 45: case 48:
      return 'fog';
    case 51: case 53: case 55: case 56: case 57:
    case 61: case 63: case 65: case 66: case 67:
    case 80: case 81: case 82:
      return 'rain';
    case 71: case 73: case 75: case 77: case 85: case 86:
      return 'snow';
    case 95: case 96: case 99:
      return 'storm';
    default:
      return 'clear';
  }
}

/**
 * Open-Meteo current fields in default units: precipitation (mm), snowfall
 * (cm), cloud_cover (%), wind_speed_10m (km/h). All returned strengths are 0..1.
 * Rain saturates at 4 mm, snow at 2 cm, wind at 32 km/h. Missing snowfall uses
 * precipitation / 4 for snow codes only. WMO codes gate both particle types.
 */
export function weatherFactors(current) {
  const kind = weatherKind(current?.weather_code);
  const measuredPrecip = clamp(finiteNumber(current?.precipitation) / 4);
  const measuredSnow = clamp(finiteNumber(current?.snowfall, measuredPrecip * 2) / 2);
  return {
    kind,
    precip: kind === 'storm' ? Math.max(0.62, measuredPrecip)
      : kind === 'rain' ? Math.max(0.16, measuredPrecip) : 0,
    snow: kind === 'snow' ? Math.max(0.16, measuredSnow) : 0,
    cloud: Math.max(CLOUD_FLOORS[kind] || 0, clamp(finiteNumber(current?.cloud_cover) / 100)),
    wind: clamp(finiteNumber(current?.wind_speed_10m) / 32),
  };
}

/** Fixed city-key offsets only. Invalid timestamps use epoch 0; unknown cities use Seoul. */
export function localClock(timestampMs, city = 'seoul') {
  const timestamp = Number.isFinite(timestampMs) && Math.abs(timestampMs) <= MAX_TIMESTAMP_MS
    ? timestampMs : 0;
  const offset = (city === 'rio' ? CITIES.rio : CITIES.seoul).fallbackOffsetSeconds;
  const local = new Date(timestamp + offset * 1000);
  const hour = local.getUTCHours();
  const minute = local.getUTCMinutes();
  return {
    hour: hour + minute / 60 + local.getUTCSeconds() / 3600 + local.getUTCMilliseconds() / HOUR_MS,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    month: local.getUTCMonth() + 1,
  };
}

export function seoulSeason(timestampMs) {
  const { month } = localClock(timestampMs);
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

function unitDirection(value, fallback) {
  const indexed = Array.isArray(value) || ArrayBuffer.isView(value);
  const x = indexed ? value[0] : value?.x;
  const y = indexed ? value[1] : value?.y;
  const z = indexed ? value[2] : value?.z;
  if (![x, y, z].every(Number.isFinite)) return fallback;
  const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (scale === 0) return fallback;
  // Scale first to avoid overflow or underflow for finite nonzero vectors.
  const scaled = [x / scale, y / scale, z / scale];
  const length = Math.hypot(...scaled);
  return scaled.map(component => component / length);
}

/**
 * Directions accept arrays, typed arrays, or {x,y,z}. Invalid front falls back
 * to DEFAULT_FRONT; invalid view falls back to the normalized front.
 * solarElevation is a signed dot product, not an angle in degrees/radians.
 */
export function solarState(timestampMs, viewDirection, frontDirection = DEFAULT_FRONT) {
  const front = unitDirection(frontDirection, unitDirection(DEFAULT_FRONT));
  const view = unitDirection(viewDirection, front);
  // Project +X onto the front's tangent plane; +Y handles a parallel front.
  const axis = Math.abs(front[0]) > 1 - 1e-12 ? [0, 1, 0] : [1, 0, 0];
  const alignment = dot(axis, front);
  const east = unitDirection(axis.map((component, index) => component - alignment * front[index]));
  const seoulHour = localClock(timestampMs).hour;
  const angle = (seoulHour - 12) * Math.PI / 12;
  const sunDirection = unitDirection(front.map((component, index) =>
    component * Math.cos(angle) + east[index] * Math.sin(angle)));
  const solarElevation = clamp(dot(view, sunDirection), -1, 1);
  const twilight = clamp((solarElevation + 0.18) / 0.36);
  return {
    seoulHour,
    day: twilight * twilight * (3 - 2 * twilight),
    solarElevation,
    sunDirection,
  };
}

/** Fixed hemispheres, independent of daylight. Invalid views retain the previous city. */
export function selectClimateCity(viewDir, previous = 'seoul', frontDir = DEFAULT_FRONT) {
  const city = previous === 'rio' ? 'rio' : 'seoul';
  const front = unitDirection(frontDir, unitDirection(DEFAULT_FRONT));
  const view = unitDirection(viewDir);
  if (!view) return city;
  const hemisphere = dot(view, front);
  if (hemisphere > 0.08) return 'seoul';
  if (hemisphere < -0.08) return 'rio';
  return city;
}
