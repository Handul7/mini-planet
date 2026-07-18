import * as THREE from 'three';

/**
 * Owns every atmospheric concern: sky dome, stars, clouds, rain, lighting,
 * visible celestial bodies, live weather, and the day/night palette.
 * The rest of the app only supplies the current player direction each frame.
 */
export function createSkySystem({
  scene,
  camera,
  renderer,
  vignettePass,
  theme,
  radius,
  devTimeShiftMs = 0,
  devWeatherPreset = '',
  weatherElements = {},
}) {
  const { icon: iconEl, temp: tempEl, time: timeEl } = weatherElements;
  scene.fog = new THREE.FogExp2(theme.world.fogDay, 0.0022);

  const skyMaterial = createSkyDome(scene, theme);
  const stars = createStars(scene);
  const clouds = createClouds(scene, radius);
  const rain = createRain(scene, radius);
  const { hemi, sun } = createLights(scene);
  let performanceTier = 'high';
  const sunDir = sun.position.clone().normalize();
  const celestial = createCelestialBodies(scene, sunDir);
  const celestialForward = new THREE.Vector3();
  const celestialRight = new THREE.Vector3();
  const celestialScreenUp = new THREE.Vector3();
  const celestialScreenDirection = new THREE.Vector3();

  const CITIES = {
    seoul: {
      name: 'SEOUL',
      lat: 37.5665,
      lon: 126.9780,
      fallbackOffsetSeconds: 9 * 3600,
    },
    rio: {
      name: 'RIO DE JANEIRO',
      lat: -22.9068,
      lon: -43.1729,
      fallbackOffsetSeconds: -3 * 3600,
    },
  };
  const WEATHER_PRESETS = {
    clear: { precip: 0, cloud: 0.02, wind: 0.14, kind: 'clear' },
    cloudy: { precip: 0, cloud: 0.72, wind: 0.32, kind: 'cloudy' },
    rain: { precip: 0.62, cloud: 0.86, wind: 0.52, kind: 'rain' },
    storm: { precip: 1, cloud: 1, wind: 0.92, kind: 'storm' },
  };
  const weatherPreset = WEATHER_PRESETS[devWeatherPreset] ? devWeatherPreset : '';
  const weather = { seoul: null, rio: null, active: 'seoul' };
  const weatherVisual = weatherPreset
    ? { ...WEATHER_PRESETS[weatherPreset] }
    : { precip: 0, cloud: 0.3, wind: 0.2, kind: 'clear' };
  const lastPlayerDirection = new THREE.Vector3(0, 1, 0);
  let lastPanelKey = null;
  let lastPanelTick = 0;

  const palette = createDayNightPalette(theme);
  // Use the fallback city offset immediately. Starting every visit at noon
  // made a fast night-time entrance linger in lavender twilight for seconds.
  let visibleDayFactor = dayFactorFromHour(cityHour(weather.active));
  let weatherGrade = 0;

  async function fetchCity(key) {
    const city = CITIES[key];
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}`
      + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation,cloud_cover'
      + '&timezone=auto';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`weather ${key} ${response.status}`);
    const data = await response.json();
    return { ...data.current, utc_offset_seconds: data.utc_offset_seconds };
  }

  async function loadWeather() {
    const [seoul, rio] = await Promise.allSettled([fetchCity('seoul'), fetchCity('rio')]);
    if (seoul.status === 'fulfilled') weather.seoul = seoul.value;
    if (rio.status === 'fulfilled') weather.rio = rio.value;
    if (seoul.status === 'rejected' && rio.status === 'rejected' && tempEl) {
      tempEl.textContent = '--°';
    }
  }
  loadWeather();
  setInterval(loadWeather, 10 * 60 * 1000);

  function cityHour(key) {
    const offset = weather[key]
      ? weather[key].utc_offset_seconds
      : CITIES[key].fallbackOffsetSeconds;
    const local = new Date(Date.now() + devTimeShiftMs + offset * 1000);
    return local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600;
  }

  function cityTimeString(current) {
    if (!current) return '--:--';
    const local = new Date(Date.now() + devTimeShiftMs + current.utc_offset_seconds * 1000);
    const pad = number => String(number).padStart(2, '0');
    return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  }

  function updateWeatherPanel(now) {
    const current = weather[weather.active];
    if (now - lastPanelTick > 20) {
      if (timeEl) timeEl.textContent = cityTimeString(current);
      lastPanelTick = now;
    }
    const night = dayFactorFromHour(cityHour(weather.active)) < 0.15;
    const stamp = weather.active + '|'
      + (current ? current.time + current.weather_code + current.temperature_2m : 'x')
      + `|${night}`;
    if (stamp === lastPanelKey) return;
    lastPanelKey = stamp;
    if (weatherPreset && iconEl) {
      iconEl.textContent = ({
        clear: night ? '🌙' : '☀️',
        cloudy: '☁️',
        rain: '🌧️',
        storm: '⛈️',
      })[weatherPreset];
    }
    if (!current) return;
    const [icon] = weatherCode(current.weather_code, night);
    if (iconEl && !weatherPreset) iconEl.textContent = icon;
    if (tempEl) tempEl.textContent = Math.round(current.temperature_2m) + '°';
    if (timeEl) timeEl.textContent = cityTimeString(current);
  }

  function activeWeatherFactors() {
    if (weatherPreset) return WEATHER_PRESETS[weatherPreset];
    const current = weather[weather.active];
    if (!current) return { precip: 0, cloud: 0.3, wind: 0.2, kind: 'clear' };
    const precip = Math.max(0, Number(current.precipitation) || 0);
    const cloud = Math.max(0, Number(current.cloud_cover) || 0);
    const wind = Math.max(0, Number(current.wind_speed_10m) || 0);
    const kind = weatherKind(current.weather_code);
    const measuredPrecip = Math.min(1, precip / 4);
    // Open-Meteo can report a rainy WMO code between measurement ticks with
    // near-zero instantaneous precipitation. Keep light rain legible, while
    // ensuring snow and fog never reuse the rain streak system.
    const visiblePrecip = kind === 'storm'
      ? Math.max(0.62, measuredPrecip)
      : kind === 'rain'
        ? Math.max(0.16, measuredPrecip)
        : 0;
    const cloudFloor = {
      cloudy: 0.58,
      fog: 0.78,
      rain: 0.68,
      snow: 0.72,
      storm: 0.88,
    }[kind] || 0;
    return {
      precip: visiblePrecip,
      cloud: Math.max(cloudFloor, Math.min(1, cloud / 100)),
      wind: Math.min(1, wind / 32),
      kind,
    };
  }

  function updateDayNight(dt) {
    const target = dayFactorFromHour(cityHour(weather.active));
    visibleDayFactor += (target - visibleDayFactor) * Math.min(1, dt * 0.8);
    const day = visibleDayFactor;
    const twilight = Math.sin(Math.PI * day);
    weatherGrade = THREE.MathUtils.clamp(
      (weatherVisual.cloud * 0.18 + weatherVisual.precip * 0.30) * (0.08 + day * 0.92),
      0,
      0.48,
    );
    const weatherFogGrade = THREE.MathUtils.clamp(
      (weatherVisual.cloud * 0.08 + weatherVisual.precip * 0.22) * (0.25 + day * 0.75),
      0,
      0.30,
    );
    const weatherDim = 1 - weatherVisual.cloud * 0.07 - weatherVisual.precip * 0.10;

    skyMaterial.uniforms.top.value.copy(palette.nightTop)
      .lerp(palette.dayTop, day)
      .lerp(palette.twilightTop, twilight * 0.72)
      .lerp(palette.weatherTop, weatherGrade);
    skyMaterial.uniforms.mid.value.copy(palette.nightMid)
      .lerp(palette.dayMid, day)
      .lerp(palette.twilightMid, twilight * 0.78)
      .lerp(palette.weatherMid, weatherGrade);
    skyMaterial.uniforms.bottom.value.copy(palette.nightBottom)
      .lerp(palette.dayBottom, day)
      .lerp(palette.twilightBottom, twilight * 0.82)
      .lerp(palette.weatherBottom, weatherGrade);

    scene.fog.color.copy(palette.nightFog)
      .lerp(palette.dayFog, day)
      .lerp(palette.twilightFog, twilight * 0.58)
      .lerp(palette.weatherFog, weatherFogGrade);
    scene.fog.density = THREE.MathUtils.lerp(0.0027, 0.00175, day)
      + twilight * 0.00025
      + weatherVisual.cloud * 0.00006
      + weatherVisual.precip * 0.00034;

    sun.intensity = (0.60 + day * 0.80) * weatherDim;
    hemi.intensity = (0.84 + day * 0.42) * (0.96 + weatherDim * 0.04);
    sun.color.copy(palette.moonLight)
      .lerp(palette.sunLight, day)
      .lerp(palette.twilightSun, twilight * 0.72)
      .lerp(palette.weatherLight, weatherGrade * 0.45);
    hemi.color.copy(palette.nightHemiSky)
      .lerp(palette.dayHemiSky, day)
      .lerp(palette.twilightHemiSky, twilight * 0.75)
      .lerp(palette.weatherHemiSky, weatherGrade * 0.34);
    hemi.groundColor.copy(palette.nightHemiGround)
      .lerp(palette.dayHemiGround, day)
      .lerp(palette.twilightHemiGround, twilight * 0.75)
      .lerp(palette.weatherHemiGround, weatherGrade * 0.28);

    celestial.sun.material.opacity = 0.90 * day;
    celestial.sunHalo.material.opacity = 0.38 * day;
    celestial.moon.material.opacity = 0.90 * (1 - day);
    celestial.moonHalo.material.opacity = 0.18 * (1 - day);
    celestial.polaris.material.opacity = 0.06 + (1 - day) * 0.90;
    celestial.polarisHalo.material.opacity = 0.01 + (1 - day) * 0.15;
    stars.opacity = 0.75 * (1 - day) + 0.05;

    renderer.toneMappingExposure = 1.10 + day * 0.04
      - weatherVisual.cloud * 0.025
      - weatherVisual.precip * 0.035;
    vignettePass.uniforms.tint.value.copy(palette.nightTint)
      .lerp(palette.dayTint, day)
      .lerp(palette.twilightTint, twilight * 0.72)
      .lerp(palette.weatherTint, weatherGrade * 0.42);
    vignettePass.uniforms.tintAmount.value = 0.038 - day * 0.021
      + twilight * 0.012
      + weatherVisual.precip * 0.008;
    vignettePass.uniforms.darkness.value = 1.045 + day * 0.025;
  }

  function updateWeatherVisuals(dt, elapsed, playerDirection = lastPlayerDirection) {
    const factors = activeWeatherFactors();
    weatherVisual.precip += (factors.precip - weatherVisual.precip) * Math.min(1, dt * 1.5);
    weatherVisual.cloud += (factors.cloud - weatherVisual.cloud) * Math.min(1, dt * 1.5);
    weatherVisual.wind += (factors.wind - weatherVisual.wind) * Math.min(1, dt * 0.75);
    weatherVisual.kind = factors.kind || weatherVisual.kind;

    const twilight = Math.sin(Math.PI * visibleDayFactor);
    clouds.color.copy(clouds.colors.night)
      .lerp(clouds.colors.day, visibleDayFactor)
      .lerp(clouds.colors.twilight, twilight * 0.34)
      .lerp(clouds.colors.rain, weatherVisual.precip * 0.28);
    clouds.cameraDirection.copy(camera.position).normalize();

    for (const cloud of clouds.items) {
      const windSpeed = 0.52 + weatherVisual.wind * 1.9;
      cloud.position.applyAxisAngle(
        cloud.userData.orbitAxis,
        cloud.userData.orbitSpeed * windSpeed * dt,
      );
      const altitude = cloud.userData.orbitRadius
        + Math.sin(elapsed * 0.10 + cloud.userData.phase) * 0.10;
      cloud.position.setLength(altitude);
      clouds.radial.copy(cloud.position).normalize();
      cloud.material.rotation = cloud.userData.baseRotation
        + Math.sin(elapsed * 0.12 + cloud.userData.phase) * 0.012 * weatherVisual.wind;
      let presence = THREE.MathUtils.smoothstep(
        weatherVisual.cloud,
        cloud.userData.coverThreshold - 0.08,
        cloud.userData.coverThreshold + 0.14,
      );
      // Decorative clouds stay around the silhouette and never drift between
      // the camera and the dashboard's central planet.
      presence *= 1 - THREE.MathUtils.smoothstep(
        clouds.radial.dot(clouds.cameraDirection),
        0.56,
        0.80,
      );
      cloud.visible = presence > 0.01;
      if (!cloud.visible) continue;
      const driftBreath = 1 + Math.sin(elapsed * 0.12 + cloud.userData.phase) * 0.010;
      const presenceScale = (0.88 + presence * 0.12) * driftBreath;
      cloud.scale.copy(cloud.userData.baseScale).multiplyScalar(presenceScale);
      const skyAlpha = presence * (
        0.54 + visibleDayFactor * 0.30 + twilight * 0.08 + weatherVisual.precip * 0.06
      );
      cloud.material.color.copy(clouds.color);
      cloud.material.opacity = cloud.userData.baseOpacity * skyAlpha;
    }

    // A restrained four-point twinkle makes the north star discoverable
    // without turning it into a labelled landmark or UI marker.
    const polarisTwinkle = 0.94 + Math.sin(elapsed * 0.82) * 0.06;
    celestial.polaris.scale.setScalar(1.02 * polarisTwinkle);
    celestial.polarisHalo.scale.setScalar(4.4 * (0.97 + Math.sin(elapsed * 0.82) * 0.03));

    const rainAllowed = weatherVisual.kind === 'rain' || weatherVisual.kind === 'storm';
    const rainStrength = rainAllowed && weatherVisual.precip > 0.02
      ? Math.min(
        0.72,
        0.22 + Math.sqrt(weatherVisual.precip) * 0.42 + (1 - visibleDayFactor) * 0.05,
      )
      : 0;
    rain.material.color.copy(rain.colors.day)
      .lerp(rain.colors.night, 1 - visibleDayFactor);
    rain.material.opacity = rainStrength;
    rain.lines.visible = rainStrength > 0;
    if (rain.lines.visible) {
      rain.step(dt, weatherVisual.wind, playerDirection);
    }
  }

  function updateCelestialAnchors() {
    const place = (object, direction) => {
      object.position.copy(camera.position)
        .addScaledVector(direction, celestial.distance);
    };
    const screenDirection = (x, y) => {
      camera.getWorldDirection(celestialForward);
      celestialRight.crossVectors(celestialForward, camera.up).normalize();
      celestialScreenUp.crossVectors(celestialRight, celestialForward).normalize();
      const halfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
      return celestialScreenDirection.copy(celestialForward)
        .addScaledVector(celestialRight, x * halfFov * camera.aspect)
        .addScaledVector(celestialScreenUp, y * halfFov)
        .normalize();
    };
    place(celestial.sun, celestial.sunDirection);
    place(celestial.sunHalo, celestial.sunDirection);
    place(celestial.moon, celestial.moonDirection);
    place(celestial.moonHalo, celestial.moonDirection);
    const polarisViewDirection = screenDirection(-0.33, 0.64);
    place(celestial.polaris, polarisViewDirection);
    place(celestial.polarisHalo, polarisViewDirection);
  }

  function update({ dt, elapsed, playerDirection }) {
    lastPlayerDirection.copy(playerDirection).normalize();
    weather.active = playerDirection.dot(sunDir) >= 0 ? 'seoul' : 'rio';
    updateWeatherPanel(elapsed);
    updateDayNight(dt);
    updateWeatherVisuals(dt, elapsed, lastPlayerDirection);
    updateCelestialAnchors();
  }

  function updateEdit(dt, elapsed = 0) {
    updateCelestialAnchors();
    updateDayNight(dt);
    updateWeatherVisuals(dt, elapsed, lastPlayerDirection);
  }

  function setPerformanceProfile({ tier = 'high', shadowMapSize = 1024, rainSegments = rain.count } = {}) {
    performanceTier = String(tier || 'high');
    const mapSize = THREE.MathUtils.clamp(Math.round(Number(shadowMapSize) || 1024), 512, 2048);
    if (sun.shadow.mapSize.x !== mapSize || sun.shadow.mapSize.y !== mapSize) {
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
      sun.shadow.mapSize.set(mapSize, mapSize);
      renderer.shadowMap.needsUpdate = true;
    }
    rain.setActiveCount(rainSegments);
  }

  function dayState() {
    const hour = cityHour(weather.active);
    return {
      city: weather.active,
      shiftedHour: +hour.toFixed(3),
      targetDayFactor: +dayFactorFromHour(hour).toFixed(3),
      visibleDayFactor: +visibleDayFactor.toFixed(3),
      twilightFactor: +Math.sin(Math.PI * visibleDayFactor).toFixed(3),
      fogDensity: +scene.fog.density.toFixed(5),
      exposure: +renderer.toneMappingExposure.toFixed(3),
      sky: {
        top: `#${skyMaterial.uniforms.top.value.getHexString()}`,
        mid: `#${skyMaterial.uniforms.mid.value.getHexString()}`,
        bottom: `#${skyMaterial.uniforms.bottom.value.getHexString()}`,
      },
    };
  }

  function weatherState() {
    return {
      city: weather.active,
      preset: weatherPreset || null,
      kind: weatherVisual.kind,
      precip: +weatherVisual.precip.toFixed(3),
      cloud: +weatherVisual.cloud.toFixed(3),
      wind: +weatherVisual.wind.toFixed(3),
      grade: +weatherGrade.toFixed(3),
      qualityTier: performanceTier,
      visibleClouds: clouds.items.filter((cloud) => cloud.visible).length,
      cloudPool: clouds.items.length,
      raining: rain.lines.visible,
      rainOpacity: +rain.material.opacity.toFixed(3),
      rainSegments: rain.activeCount,
      rainPool: rain.count,
    };
  }

  function ambientState() {
    return {
      precip: weatherVisual.precip,
      cloud: weatherVisual.cloud,
      wind: weatherVisual.wind,
      kind: weatherVisual.kind,
      day: visibleDayFactor,
      twilight: Math.sin(Math.PI * visibleDayFactor),
    };
  }

  return {
    update,
    updateEdit,
    setPerformanceProfile,
    dayState,
    weatherState,
    ambientState,
    celestial: {
      sun: celestial.sun,
      moon: celestial.moon,
      polaris: celestial.polaris,
    },
  };
}

function createSkyDome(scene, theme) {
  const shader = {
    uniforms: {
      top: { value: new THREE.Color(theme.world.skyDay.top) },
      mid: { value: new THREE.Color(theme.world.skyDay.mid) },
      bottom: { value: new THREE.Color(theme.world.skyDay.bottom) },
      offset: { value: 0.15 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 top;
      uniform vec3 mid;
      uniform vec3 bottom;
      uniform float offset;
      varying vec3 vDir;
      void main(){
        float h = vDir.y * 0.5 + 0.5 + offset;
        vec3 col = h < 0.5
          ? mix(bottom, mid, smoothstep(0.0, 0.5, h))
          : mix(mid, top, smoothstep(0.5, 1.0, h));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  };
  const material = new THREE.ShaderMaterial({
    ...shader,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), material));
  return material;
}

function createStars(scene) {
  const geometry = new THREE.BufferGeometry();
  const count = 500;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const radius = 250;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random());
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi);
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xfff3d6,
    size: 1.1,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
    fog: false,
  });
  scene.add(new THREE.Points(geometry, material));
  return material;
}

function createClouds(scene, radius) {
  const colors = {
    day: new THREE.Color(0xffffff),
    twilight: new THREE.Color(0xf5e7eb),
    night: new THREE.Color(0x9babc5),
    rain: new THREE.Color(0xb9cbd4),
  };
  const items = [];
  const textures = Array.from({ length: 4 }, (_, index) => createCloudTexture(index));
  // A slightly wider pool keeps cloudy weather legible around both sides of
  // the silhouette without allowing sprites across the central village.
  const poolSize = 18;
  const latitudeBands = [-0.46, -0.34, -0.22, -0.10, 0.02, 0.14, 0.26, 0.38, 0.48];
  let seed = 0x6d2b79f5;
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let i = 0; i < poolSize; i++) {
    const material = new THREE.SpriteMaterial({
      map: textures[i % textures.length],
      color: colors.day,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    const cloud = new THREE.Sprite(material);

    const latitude = latitudeBands[i % latitudeBands.length] + (random() - 0.5) * 0.08;
    const longitude = i / poolSize * Math.PI * 2 + (random() - 0.5) * 0.55;
    const cosLatitude = Math.cos(latitude);
    const direction = new THREE.Vector3(
      cosLatitude * Math.cos(longitude),
      Math.sin(latitude),
      cosLatitude * Math.sin(longitude),
    );
    const orbitRadius = radius + 3.2 + random() * 1.8;
    cloud.position.copy(direction.multiplyScalar(orbitRadius));
    cloud.userData.orbitAxis = new THREE.Vector3(
      (random() - 0.5) * 0.08,
      1,
      (random() - 0.5) * 0.08,
    ).normalize();
    cloud.userData.orbitSpeed = 0.0023 + random() * 0.0030;
    const width = 2.20 + random() * 0.82;
    cloud.userData.baseScale = new THREE.Vector3(
      width,
      width * (0.43 + random() * 0.06),
      1,
    );
    cloud.userData.orbitRadius = orbitRadius;
    cloud.userData.baseRotation = (random() - 0.5) * 0.12;
    cloud.userData.coverThreshold = 0.08 + i / (poolSize - 1) * 0.84;
    cloud.userData.phase = random() * Math.PI * 2;
    cloud.userData.baseOpacity = 0.70 + random() * 0.10;
    cloud.scale.copy(cloud.userData.baseScale).multiplyScalar(0.88);
    cloud.visible = false;
    scene.add(cloud);
    items.push(cloud);
  }

  return {
    items,
    colors,
    color: new THREE.Color(),
    radial: new THREE.Vector3(),
    cameraDirection: new THREE.Vector3(),
  };
}

function createCloudTexture(variant = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const profiles = [
    [[56,72,31],[91,55,39],[133,42,46],[177,58,37],[210,73,27]],
    [[48,73,27],[82,58,37],[123,47,43],[164,39,47],[207,69,30]],
    [[45,74,25],[77,61,33],[113,49,41],[154,54,38],[194,61,34],[221,76,22]],
    [[52,72,29],[91,52,39],[132,57,35],[166,41,46],[207,71,29]],
  ];
  const profile = profiles[variant % profiles.length];

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(184,201,211,0.82)';
  context.beginPath();
  context.ellipse(128, 82, 103, 29, 0, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#ffffff';
  context.beginPath();
  context.ellipse(128, 72, 105, 30, 0, 0, Math.PI * 2);
  context.fill();
  for (const [x, y, r] of profile) {
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.fill();
  }

  // One cool-gray underside band gives the flat sprite a toon-shaded read
  // without bringing back the separate rocky puffs of the old mesh clouds.
  context.globalCompositeOperation = 'source-atop';
  const shade = context.createLinearGradient(0, 56, 0, 104);
  shade.addColorStop(0, 'rgba(218,230,235,0)');
  shade.addColorStop(0.66, 'rgba(183,201,211,0.08)');
  shade.addColorStop(1, 'rgba(158,181,193,0.36)');
  context.fillStyle = shade;
  context.fillRect(18, 50, 220, 62);
  context.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function createRain(scene, radius) {
  const count = 460;
  const centers = new Float32Array(count * 3);
  const vertices = new Float32Array(count * 6);
  const velocity = new Float32Array(count);
  const radial = new THREE.Vector3();
  const tangentWind = new THREE.Vector3();
  const spawnDirection = new THREE.Vector3();
  const windDirection = new THREE.Vector3(0.82, 0.16, 0.55).normalize();
  const fallbackCenter = new THREE.Vector3(0, 1, 0);
  const colors = {
    day: new THREE.Color(0x5f7f96),
    night: new THREE.Color(0xd5e8ff),
  };

  const writeSegment = (index, wind = 0) => {
    const centerIndex = index * 3;
    const vertexIndex = index * 6;
    const x = centers[centerIndex];
    const y = centers[centerIndex + 1];
    const z = centers[centerIndex + 2];
    radial.set(x, y, z).normalize();
    tangentWind.copy(windDirection).addScaledVector(radial, -windDirection.dot(radial));
    if (tangentWind.lengthSq() > 1e-6) tangentWind.normalize();
    const streak = 0.25 + velocity[index] * 0.015;
    vertices[vertexIndex] = x;
    vertices[vertexIndex + 1] = y;
    vertices[vertexIndex + 2] = z;
    vertices[vertexIndex + 3] = x + radial.x * streak - tangentWind.x * wind * 0.15;
    vertices[vertexIndex + 4] = y + radial.y * streak - tangentWind.y * wind * 0.15;
    vertices[vertexIndex + 5] = z + radial.z * streak - tangentWind.z * wind * 0.15;
  };

  const reset = (index, centerDirection = fallbackCenter, wind = 0) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      spawnDirection.randomDirection();
      if (spawnDirection.dot(centerDirection) > 0.05) break;
    }
    spawnDirection.multiplyScalar(radius + 0.8 + Math.random() * 4.4);
    const centerIndex = index * 3;
    centers[centerIndex] = spawnDirection.x;
    centers[centerIndex + 1] = spawnDirection.y;
    centers[centerIndex + 2] = spawnDirection.z;
    velocity[index] = 5.5 + Math.random() * 5.5;
    writeSegment(index, wind);
  };
  for (let i = 0; i < count; i++) reset(i);
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(vertices, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttribute);
  const material = new THREE.LineBasicMaterial({
    color: colors.day,
    transparent: true,
    opacity: 0,
    fog: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.visible = false;
  scene.add(lines);
  let activeCount = count;

  function step(dt, wind, centerDirection) {
    const fallStep = Math.max(0, dt);
    const windStep = wind * 1.7 * fallStep;
    const windLean = wind * 0.15;
    const wx = windDirection.x;
    const wy = windDirection.y;
    const wz = windDirection.z;
    for (let i = 0; i < activeCount; i++) {
      const index = i * 3;
      const x = centers[index];
      const y = centers[index + 1];
      const z = centers[index + 2];
      const length = Math.hypot(x, y, z) || 1;
      if (length <= radius + 0.12) {
        reset(i, centerDirection, wind);
        continue;
      }
      const rx = x / length;
      const ry = y / length;
      const rz = z / length;
      const windDot = wx * rx + wy * ry + wz * rz;
      let tx = wx - rx * windDot;
      let ty = wy - ry * windDot;
      let tz = wz - rz * windDot;
      const tangentLength = Math.hypot(tx, ty, tz);
      if (tangentLength > 1e-6) {
        tx /= tangentLength;
        ty /= tangentLength;
        tz /= tangentLength;
      }

      const nx = x - rx * velocity[i] * fallStep + tx * windStep;
      const ny = y - ry * velocity[i] * fallStep + ty * windStep;
      const nz = z - rz * velocity[i] * fallStep + tz * windStep;
      centers[index] = nx;
      centers[index + 1] = ny;
      centers[index + 2] = nz;

      const nextLength = Math.hypot(nx, ny, nz) || 1;
      const nrx = nx / nextLength;
      const nry = ny / nextLength;
      const nrz = nz / nextLength;
      const streak = 0.25 + velocity[i] * 0.015;
      const vertexIndex = i * 6;
      vertices[vertexIndex] = nx;
      vertices[vertexIndex + 1] = ny;
      vertices[vertexIndex + 2] = nz;
      vertices[vertexIndex + 3] = nx + nrx * streak - tx * windLean;
      vertices[vertexIndex + 4] = ny + nry * streak - ty * windLean;
      vertices[vertexIndex + 5] = nz + nrz * streak - tz * windLean;
    }
    positionAttribute.needsUpdate = true;
  }

  function setActiveCount(value) {
    const nextCount = THREE.MathUtils.clamp(Math.round(Number(value) || count), 120, count);
    if (nextCount > activeCount) {
      for (let i = activeCount; i < nextCount; i++) reset(i);
    }
    activeCount = nextCount;
    geometry.setDrawRange(0, activeCount * 2);
    positionAttribute.needsUpdate = true;
  }

  return {
    lines,
    velocity,
    reset,
    step,
    setActiveCount,
    count,
    get activeCount() { return activeCount; },
    geometry,
    material,
    colors,
  };
}

function createLights(scene) {
  const hemi = new THREE.HemisphereLight(0xeaf7ff, 0x8aa29a, 1.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfffbf2, 1.35);
  sun.position.set(30, 40, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 120;
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.045;
  sun.shadow.radius = 3;
  scene.add(sun);
  return { hemi, sun };
}

function createCelestialBodies(scene, sunDirection) {
  const distance = 220;
  // Kept in real sky space, but composed so the dashboard's opening angle
  // leaves both bodies in clear negative space instead of behind name chips.
  const moonDirection = new THREE.Vector3(0.52, 0.32, -0.79).normalize();
  const polarisDirection = new THREE.Vector3(-0.28, 0.44, -0.85).normalize();
  const sunPosition = sunDirection.clone().multiplyScalar(distance);
  const sunMaterial = new THREE.MeshBasicMaterial({
    color: 0xfff4d6,
    fog: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
  });
  const sun = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 12), sunMaterial);
  sun.position.copy(sunPosition);
  scene.add(sun);

  const haloTexture = createHaloTexture();
  const sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture,
    blending: THREE.AdditiveBlending,
    color: 0xfff4d6,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    fog: false,
  }));
  sunHalo.scale.setScalar(18);
  sunHalo.position.copy(sunPosition);
  scene.add(sunHalo);

  const moonTexture = createMoonTexture();
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: moonTexture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    fog: false,
  }));
  moon.scale.setScalar(6.4);
  moon.position.copy(moonDirection).multiplyScalar(distance);
  scene.add(moon);

  const moonHalo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture,
    blending: THREE.AdditiveBlending,
    color: 0xcdd6ff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    fog: false,
  }));
  moonHalo.scale.setScalar(19);
  moonHalo.position.copy(moon.position);
  scene.add(moonHalo);

  const polaris = new THREE.Sprite(new THREE.SpriteMaterial({
    map: createStarTexture(),
    blending: THREE.AdditiveBlending,
    color: 0xfff1bf,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    fog: false,
  }));
  polaris.scale.setScalar(1.02);
  polaris.position.copy(polarisDirection).multiplyScalar(distance);
  polaris.renderOrder = 2;
  scene.add(polaris);

  const polarisHalo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture,
    blending: THREE.AdditiveBlending,
    color: 0xffe8aa,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    fog: false,
  }));
  polarisHalo.scale.setScalar(4.4);
  polarisHalo.position.copy(polaris.position);
  polarisHalo.renderOrder = 1;
  scene.add(polarisHalo);

  return {
    distance,
    sunDirection,
    moonDirection,
    sun,
    sunHalo,
    moon,
    moonHalo,
    polaris,
    polarisHalo,
  };
}

function createHaloTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(128, 128, 10, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

function createMoonTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const texture = new THREE.CanvasTexture(canvas);

  const draw = () => {
    const phase = moonPhase01();
    const context = canvas.getContext('2d');
    const centerX = 128;
    const centerY = 128;
    const radius = 108;
    context.clearRect(0, 0, 256, 256);
    context.fillStyle = '#e9edff';
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#c6cff2';
    [[-40, 28, 22], [32, -10, 15], [-8, -52, 12], [44, 46, 10]].forEach(
      ([dx, dy, craterRadius]) => {
        context.beginPath();
        context.arc(centerX + dx, centerY + dy, craterRadius, 0, Math.PI * 2);
        context.fill();
      },
    );
    const illumination = (1 - Math.cos(phase * Math.PI * 2)) / 2;
    const darkSide = phase < 0.5 ? -1 : 1;
    context.globalCompositeOperation = 'destination-out';
    context.beginPath();
    context.arc(
      centerX + darkSide * 2 * radius * illumination,
      centerY,
      radius * 1.02,
      0,
      Math.PI * 2,
    );
    context.fill();

    // Faint earthshine keeps a thin crescent discoverable without turning it
    // back into the oversized glowing icon used by the previous version.
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = 'rgba(112,128,174,0.22)';
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.fill();
    context.globalCompositeOperation = 'source-over';
    texture.needsUpdate = true;
  };

  draw();
  setInterval(draw, 60 * 60 * 1000);
  return texture;
}

function moonPhase01(date = new Date()) {
  const synodicMonth = 29.53058867;
  const days = (date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
  return ((days % synodicMonth) + synodicMonth) % synodicMonth / synodicMonth;
}

function createStarTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 26);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.16, 'rgba(245,248,255,0.88)');
  gradient.addColorStop(0.52, 'rgba(220,230,255,0.20)');
  gradient.addColorStop(1, 'rgba(235,240,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  context.fillStyle = 'rgba(255,255,255,0.96)';
  context.beginPath();
  context.arc(32, 32, 1.6, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = 'rgba(255,248,215,0.72)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(32, 8);
  context.lineTo(32, 56);
  context.moveTo(12, 32);
  context.lineTo(52, 32);
  context.stroke();
  return new THREE.CanvasTexture(canvas);
}

function createDayNightPalette(theme) {
  return {
    dayTop: new THREE.Color(theme.world.skyDay.top),
    dayMid: new THREE.Color(theme.world.skyDay.mid),
    dayBottom: new THREE.Color(theme.world.skyDay.bottom),
    twilightTop: new THREE.Color(theme.world.skyTwilight.top),
    twilightMid: new THREE.Color(theme.world.skyTwilight.mid),
    twilightBottom: new THREE.Color(theme.world.skyTwilight.bottom),
    nightTop: new THREE.Color(theme.world.skyNight.top),
    nightMid: new THREE.Color(theme.world.skyNight.mid),
    nightBottom: new THREE.Color(theme.world.skyNight.bottom),
    weatherTop: new THREE.Color(0x698da6),
    weatherMid: new THREE.Color(0x91adbb),
    weatherBottom: new THREE.Color(0xd4e0e4),
    dayFog: new THREE.Color(theme.world.fogDay),
    twilightFog: new THREE.Color(theme.world.fogTwilight),
    nightFog: new THREE.Color(theme.world.fogNight),
    weatherFog: new THREE.Color(0xb8ccd5),
    sunLight: new THREE.Color(0xfffbf2),
    twilightSun: new THREE.Color(0xfff2d6),
    moonLight: new THREE.Color(0xcdd6ff),
    weatherLight: new THREE.Color(0xddebf4),
    dayHemiSky: new THREE.Color(0xeaf7ff),
    dayHemiGround: new THREE.Color(0x8aa29a),
    twilightHemiSky: new THREE.Color(0xfff0f6),
    twilightHemiGround: new THREE.Color(0xb9adbf),
    nightHemiSky: new THREE.Color(0xa9bfdf),
    nightHemiGround: new THREE.Color(0x596b78),
    weatherHemiSky: new THREE.Color(0xc9dae3),
    weatherHemiGround: new THREE.Color(0x7e9294),
    dayTint: new THREE.Color(0xfffbf2),
    twilightTint: new THREE.Color(0xffd9c0),
    nightTint: new THREE.Color(0xbccfff),
    weatherTint: new THREE.Color(0xbcd4e1),
  };
}

function dayFactorFromHour(hour) {
  if (hour >= 7 && hour <= 18) return 1;
  if (hour > 18 && hour < 20) return 1 - (hour - 18) / 2;
  if (hour > 5 && hour < 7) return (hour - 5) / 2;
  return 0;
}

function weatherKind(code) {
  const value = Number(code);
  if (value >= 95 && value <= 99) return 'storm';
  if ((value >= 71 && value <= 77) || value === 85 || value === 86) return 'snow';
  if ((value >= 51 && value <= 67) || (value >= 80 && value <= 82)) return 'rain';
  if (value === 45 || value === 48) return 'fog';
  if (value === 3) return 'cloudy';
  if (value === 1 || value === 2) return 'partly-cloudy';
  return 'clear';
}

function weatherCode(code, night = false) {
  const labels = {
    0: ['☀️', '맑음'], 1: ['🌤️', '대체로 맑음'], 2: ['⛅', '구름 조금'], 3: ['☁️', '흐림'],
    45: ['🌫️', '안개'], 48: ['🌫️', '상고대 안개'],
    51: ['🌦️', '약한 이슬비'], 53: ['🌦️', '이슬비'], 55: ['🌧️', '강한 이슬비'],
    61: ['🌧️', '약한 비'], 63: ['🌧️', '비'], 65: ['🌧️', '강한 비'],
    66: ['🌧️', '어는 비'], 67: ['🌧️', '강한 어는 비'],
    71: ['🌨️', '약한 눈'], 73: ['🌨️', '눈'], 75: ['❄️', '강한 눈'], 77: ['❄️', '싸락눈'],
    80: ['🌦️', '약한 소나기'], 81: ['🌧️', '소나기'], 82: ['⛈️', '강한 소나기'],
    85: ['🌨️', '약한 눈소나기'], 86: ['🌨️', '강한 눈소나기'],
    95: ['⛈️', '뇌우'], 96: ['⛈️', '뇌우·우박'], 99: ['⛈️', '강한 뇌우·우박'],
  };
  if (night && (code === 0 || code === 1)) {
    return ['🌙', code === 0 ? '맑은 밤' : '대체로 맑은 밤'];
  }
  return labels[code] || ['🌡️', '—'];
}
