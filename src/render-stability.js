import * as THREE from '../vendor/three/build/three.module.min.js';

export function createStableSceneTarget(renderer, width, height) {
  // Canvas antialias does not cover the composer's offscreen scene target.
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    samples: renderer.capabilities.isWebGL2 ? Math.min(2, renderer.capabilities.maxSamples || 0) : 0,
  });
}

export function stabilizePaperShadows(root) {
  root.traverse((object) => {
    // Fine interleaved sheets use their baked edge colors. Keep cast shadows
    // on the ground, but avoid unstable self-shadow bands on the cut sheets.
    if (object.isMesh && object.userData.paperConstruction === 'layered-cut-card') object.receiveShadow = false;
  });
}
