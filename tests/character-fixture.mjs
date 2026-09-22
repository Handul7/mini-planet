import * as THREE from '../vendor/three/build/three.module.min.js';
import { mergeGeometries } from '../vendor/three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyPaperSurface } from '../src/paper-style.js';
import { stabilizePaperShadows } from '../src/render-stability.js';

// The review page and Node tests exercise the actual production factories.
// This fixture is excluded from the static release artifact.
export function characterFixture(source) {
  const names = ['makeToonGradient', 'toonMat', 'addOutline', 'characterTone',
    'makeCharacterContactShadow', 'makeCharacter', 'makeBronzeOwlVessel',
    'addAgentAccessories', 'animateCharacterWalk', 'collectRuntimeReferences',
    'materialBatchKey', 'geometryBatchKey', 'batchStaticMeshTree'];
  const functions = names.map(name => {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing production factory: ${name}`);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  });
  const api = new Function('THREE', 'applyPaperSurface', 'mergeGeometries', 'stabilizePaperShadows',
    `${functions.join('\n')}\nconst TOON_GRAD = makeToonGradient(3);
      return { makeCharacter, addAgentAccessories, animateCharacterWalk, batchStaticMeshTree };`
  )(THREE, applyPaperSurface, mergeGeometries, stabilizePaperShadows);
  const make = (agent, batch = true) => {
    const options = { cap: agent.visual.cap !== false, pantsColor: agent.visual.pantsColor };
    if (agent.character === 'automaton') Object.assign(options, { faceStyle: 'blank', handColor: 0xf4f2e8 });
    if (agent.character === 'star-warden') Object.assign(options, { faceStyle: 'closed', handsVisible: false });
    const model = api.makeCharacter(agent.color, agent.visual.skinColor, agent.name, options);
    api.addAgentAccessories(model, agent.visual);
    if (batch) api.batchStaticMeshTree(model);
    return model;
  };
  return { ...api, make };
}

export function characterMetrics(model) {
  let meshes = 0, triangles = 0;
  model.traverse(part => {
    if (!part.isMesh) return;
    meshes++;
    triangles += (part.geometry.index?.count ?? part.geometry.attributes.position.count) / 3;
  });
  const box = new THREE.Box3().setFromObject(model);
  return { meshes, triangles, min: box.min.toArray(), max: box.max.toArray() };
}
