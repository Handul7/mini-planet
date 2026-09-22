import * as THREE from '../vendor/three/build/three.module.min.js';

export const SEASON_SURFACES = Object.freeze({
  spring: { label: '봄', ground: 0xa1bb91, leaf: 0xacce98, amount: 0.48 },
  summer: { label: '여름', ground: 0x86a47b, leaf: 0x76ad8c, amount: 0 },
  autumn: { label: '가을', ground: 0xacac86, leaf: 0xd2a267, amount: 0.86 },
  winter: { label: '겨울', ground: 0xd8e3de, leaf: 0xe2ece5, amount: 0.88 },
});
let activeSeason = 'summer';

export function setSurfaceSeason(season, groundMaterial) {
  if (!Object.hasOwn(SEASON_SURFACES, season)) return;
  activeSeason = season;
  if (groundMaterial) groundMaterial.color.set(SEASON_SURFACES[season].ground);
}

export function prepareSeasonalGround(mesh, { amount = 1 } = {}) {
  const original = mesh.material.color.clone();
  const target = new THREE.Color();
  let applied = null;
  const previous = mesh.onBeforeRender;
  mesh.onBeforeRender = function (...args) {
    if (applied !== activeSeason) {
      target.set(SEASON_SURFACES[activeSeason].ground);
      mesh.material.color.copy(original).lerp(target, activeSeason === 'summer' ? 0 : amount);
      applied = activeSeason;
    }
    previous?.apply(this, args);
  };
  return mesh;
}

export function prepareSeasonalFoliage(mesh, { evergreen = false } = {}) {
  const colors = mesh.geometry.getAttribute('color');
  if (!colors) return;
  const original = colors.array.slice();
  const tint = new THREE.Color();
  let applied = null;
  const previous = mesh.onBeforeRender;
  // Recolor existing vertices only when the season changes. Paper edges and
  // vein highlights stay intact; no new layers, geometry, or draw calls.
  mesh.onBeforeRender = function (...args) {
    if (applied !== activeSeason) {
      const palette = SEASON_SURFACES[activeSeason];
      tint.set(palette.leaf);
      const strength = evergreen && activeSeason === 'autumn' ? 0.06
        : evergreen ? palette.amount * 0.72 : palette.amount;
      for (let i = 0; i < original.length; i += 3) {
        const r = original[i], g = original[i + 1], b = original[i + 2];
        const weight = g > r * 1.08 && g > b * 1.05 ? strength : 0;
        colors.array[i] = r + (tint.r - r) * weight;
        colors.array[i + 1] = g + (tint.g - g) * weight;
        colors.array[i + 2] = b + (tint.b - b) * weight;
      }
      colors.needsUpdate = true;
      applied = activeSeason;
    }
    previous?.apply(this, args);
  };
}
