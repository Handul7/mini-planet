import * as THREE from '../vendor/three/build/three.module.min.js';
import { characterFixture, characterMetrics } from './character-fixture.mjs';

const source = await (await fetch('../src/main.js')).text();
const { agents } = await (await fetch('../config/agents.json')).json();
const kit = characterFixture(source);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdce7e4);
const camera = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 30);
camera.position.set(0, 2.3, 8);
camera.lookAt(0, 0.70, 0);
scene.add(new THREE.HemisphereLight(0xfff9ee, 0x77918d, 2.3));
const sun = new THREE.DirectionalLight(0xfff4df, 2.5);
sun.position.set(-3, 5, 5);
scene.add(sun);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);
const select = document.querySelector('select');
const turn = document.querySelector('[aria-label="회전"]');
const walking = document.querySelector('[aria-label="걷기"]');
const models = agents.map(agent => {
  const model = kit.make(agent);
  scene.add(model);
  const label = document.createElement('span');
  label.className = 'name'; label.textContent = agent.kor;
  document.body.append(label);
  select.add(new Option(agent.kor, agent.key));
  return { agent, model, label };
});
function frameModels() {
  const all = select.value === 'all';
  const width = all ? 7.4 : Math.max(2.0, innerWidth / innerHeight * 2.2);
  const height = width * innerHeight / innerWidth;
  Object.assign(camera, { left: -width / 2, right: width / 2, top: height / 2, bottom: -height / 2 });
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  models.forEach(({ model, agent, label }, index) => {
    model.visible = all || agent.key === select.value;
    label.hidden = !model.visible;
    model.position.x = all ? (index - 2.5) * 1.16 : 0;
  });
}
select.addEventListener('change', frameModels);
addEventListener('resize', frameModels);
if (innerWidth < 600) select.value = 'rodi';
frameModels();
document.documentElement.dataset.characterMetrics = JSON.stringify(models.map(({ agent, model }) => ({ key: agent.key, ...characterMetrics(model) })));
const projected = new THREE.Vector3();
let frames = 0;
renderer.setAnimationLoop(time => {
  for (const { model, label } of models) {
    model.rotation.y = Number(turn.value) * Math.PI / 180;
    kit.animateCharacterWalk(model, walking.checked ? 1 : 0, time / 1000);
    projected.set(model.position.x, -0.13, 0).project(camera);
    label.style.left = `${(projected.x * 0.5 + 0.5) * innerWidth}px`;
    label.style.top = `${(-projected.y * 0.5 + 0.5) * innerHeight}px`;
  }
  renderer.render(scene, camera);
  if (++frames % 60 === 0) {
    const gl = renderer.getContext(), pixels = new Uint8Array(4), colors = new Set();
    for (let x = 1; x < 20; x++) for (let y = 1; y < 15; y++) {
      gl.readPixels(Math.floor(gl.drawingBufferWidth * x / 20), Math.floor(gl.drawingBufferHeight * y / 15), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      colors.add(Array.from(pixels).join(','));
    }
    document.documentElement.dataset.reviewRender = JSON.stringify({ frames, colors: colors.size, calls: renderer.info.render.calls });
  }
});
