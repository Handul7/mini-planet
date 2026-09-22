import * as THREE from '../vendor/three/build/three.module.min.js';

export function createSnow(scene, radius, count = 240) {
  const positions = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  const geometry = new THREE.BufferGeometry();
  const attribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attribute);
  const material = new THREE.PointsMaterial({
    color: 0xf7faf6, size: 0.065, sizeAttenuation: true,
    transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'weather-snow';
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);
  let activeCount = count;
  const centre = new THREE.Vector3(0, 1, 0);
  const east = new THREE.Vector3(1, 0, 0);
  const north = new THREE.Vector3(0, 0, 1);
  const position = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const windDirection = new THREE.Vector3();
  let seeded = false;

  function reset(i, scatter = false) {
    const angle = Math.random() * Math.PI * 2;
    const spread = Math.sqrt(Math.random()) * 1.22;
    position.copy(centre).multiplyScalar(Math.cos(spread))
      .addScaledVector(east, Math.sin(spread) * Math.cos(angle))
      .addScaledVector(north, Math.sin(spread) * Math.sin(angle))
      .setLength(radius + (scatter ? 0.35 + Math.random() * 3.3 : 3.65));
    position.toArray(positions, i * 3);
    speeds[i] = 0.35 + Math.random() * 0.40;
  }

  function step(dt, wind, viewDirection, elapsed) {
    const rebase = !seeded || centre.dot(viewDirection) < 0.70;
    centre.copy(viewDirection).normalize();
    east.set(0, 1, 0).cross(centre);
    if (east.lengthSq() < 0.001) east.set(1, 0, 0);
    east.normalize();
    north.crossVectors(centre, east).normalize();
    if (rebase) {
      for (let i = 0; i < count; i++) reset(i, true);
      seeded = true;
    }
    for (let i = 0; i < activeCount; i++) {
      position.fromArray(positions, i * 3);
      if (position.lengthSq() < (radius + 0.16) ** 2) reset(i);
      else {
        radial.copy(position).normalize();
        windDirection.copy(east).addScaledVector(radial, -east.dot(radial));
        position.addScaledVector(radial, -speeds[i] * dt)
          .addScaledVector(windDirection, (wind * 0.35 + Math.sin(elapsed * 0.7 + i) * 0.12) * dt);
        position.toArray(positions, i * 3);
      }
    }
    attribute.needsUpdate = true;
  }

  function setActiveCount(next) {
    activeCount = THREE.MathUtils.clamp(Math.round(Number(next) || 0), 0, count);
    geometry.setDrawRange(0, activeCount);
  }
  return { points, geometry, material, step, setActiveCount, count,
    get activeCount() { return activeCount; },
    dispose() { scene.remove(points); geometry.dispose(); material.dispose(); },
  };
}
