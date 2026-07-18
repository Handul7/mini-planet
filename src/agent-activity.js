import * as THREE from 'three';

const AGENT_ACTIVITY_STYLES = new Set([
  'conductor',
  'clock',
  'circuit',
  'proof',
  'paint',
  'observer',
]);

/**
 * Status semantics and role-specific 3D activity motifs.
 * Keeping this module independent from the dashboard lets the same public
 * state drive cards, home lights, and in-world animation without duplicating
 * keyword rules.
 */
export function createAgentActivityTools(statusTheme = {}) {
  const palette = {
    idle: '#7fb98a',
    working: '#e0a33f',
    review: '#8593d8',
    error: '#d96b6b',
    ...statusTheme,
  };

  function isWorkingStatus(state) {
    return /작업|진행|실행|구축|running|active/i.test(state || '');
  }

  function isReviewStatus(state) {
    return /검증|리뷰|review|verifying/i.test(state || '');
  }

  function isErrorStatus(state) {
    return /오류|에러|실패|error|failed/i.test(state || '');
  }

  function isCompletedStatus(state) {
    return /완료|성공|completed|done/i.test(state || '');
  }

  function statusColor(state) {
    if (isErrorStatus(state)) return palette.error;
    if (isWorkingStatus(state)) return palette.working;
    if (isReviewStatus(state)) return palette.review;
    return palette.idle;
  }

  function agentActivityMode(status) {
    const state = status?.state || '';
    if (isErrorStatus(state)) return 'error';
    if (status?.approvalState === 'pending' || isReviewStatus(state)) return 'review';
    if (isCompletedStatus(state)) return 'complete';
    if (isWorkingStatus(state)) return 'working';
    return 'idle';
  }

  function addAgentActivitySignal(character, identityColor, style = 'circuit') {
    const resolvedStyle = AGENT_ACTIVITY_STYLES.has(style) ? style : 'circuit';
    const signal = new THREE.Group();
    const baseHeight = Number.isFinite(character.userData.activityHeight)
      ? character.userData.activityHeight
      : 1.48;
    signal.position.y = baseHeight;
    signal.visible = false;
    const primary = new THREE.MeshBasicMaterial({
      color: identityColor,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
    const soft = new THREE.MeshBasicMaterial({
      color: identityColor,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    const pale = new THREE.MeshBasicMaterial({
      color: 0xfff9ea,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });
    primary.userData.baseOpacity = primary.opacity;
    soft.userData.baseOpacity = soft.opacity;
    pale.userData.baseOpacity = pale.opacity;
    const parts = [];
    const addPart = (object, kind, phase = 0) => {
      object.userData.activityKind = kind;
      object.userData.phase = phase;
      object.userData.basePosition = object.position.clone();
      object.userData.baseRotation = object.rotation.clone();
      object.userData.baseScale = object.scale.clone();
      signal.add(object);
      parts.push(object);
      return object;
    };
    const addRing = (radius = 0.28, tube = 0.012) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 6, 28), soft);
      ring.rotation.x = Math.PI / 2;
      return addPart(ring, 'ring');
    };

    if (resolvedStyle === 'conductor') {
      addRing(0.30, 0.012);
      for (let i = 0; i < 3; i++) {
        const node = new THREE.Mesh(new THREE.OctahedronGeometry(0.045, 0), primary);
        const angle = i / 3 * Math.PI * 2;
        node.position.set(Math.cos(angle) * 0.30, (i - 1) * 0.07, Math.sin(angle) * 0.30);
        addPart(node, 'note', angle);
      }
    } else if (resolvedStyle === 'clock') {
      addRing(0.27, 0.014);
      for (let i = 0; i < 4; i++) {
        const tick = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.035, 0.065), primary);
        const angle = i / 4 * Math.PI * 2;
        tick.position.set(Math.sin(angle) * 0.27, 0, Math.cos(angle) * 0.27);
        tick.rotation.y = angle;
        addPart(tick, 'tick', angle);
      }
      const handPivot = new THREE.Group();
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.022, 0.21), pale);
      hand.position.z = 0.105;
      handPivot.add(hand);
      addPart(handPivot, 'hand');
    } else if (resolvedStyle === 'proof') {
      addRing(0.29, 0.011);
      for (let i = 0; i < 3; i++) {
        const page = new THREE.Mesh(
          new THREE.BoxGeometry(0.16, 0.11, 0.018),
          i === 1 ? pale : primary,
        );
        page.position.set((i - 1) * 0.17, (1 - i) * 0.055, 0);
        page.rotation.y = (i - 1) * 0.32;
        addPart(page, 'page', i * 2.1);
      }
    } else if (resolvedStyle === 'paint') {
      for (let i = 0; i < 5; i++) {
        const petal = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.052, 0),
          i % 2 ? pale : primary,
        );
        const angle = i / 5 * Math.PI * 2;
        petal.position.set(
          Math.cos(angle) * 0.27,
          Math.sin(angle * 2) * 0.08,
          Math.sin(angle) * 0.27,
        );
        petal.scale.set(1.35, 0.72, 0.88);
        addPart(petal, 'petal', angle);
      }
      addPart(new THREE.Mesh(new THREE.OctahedronGeometry(0.04, 0), soft), 'paintCore');
    } else if (resolvedStyle === 'observer') {
      addRing(0.30, 0.010);
      for (let i = 0; i < 4; i++) {
        const eye = new THREE.Group();
        const shell = new THREE.Mesh(new THREE.SphereGeometry(0.046, 8, 6), pale);
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.022, 7, 5), primary);
        pupil.position.z = 0.038;
        eye.add(shell, pupil);
        const angle = i / 4 * Math.PI * 2;
        eye.position.set(
          Math.cos(angle) * 0.30,
          (i % 2 ? 1 : -1) * 0.07,
          Math.sin(angle) * 0.30,
        );
        addPart(eye, 'eye', angle);
      }
    } else {
      addRing(0.29, 0.011);
      for (let i = 0; i < 4; i++) {
        const chip = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.055, 0.04), primary);
        const angle = i / 4 * Math.PI * 2;
        chip.position.set(
          Math.cos(angle) * 0.28,
          (i % 2 ? 1 : -1) * 0.06,
          Math.sin(angle) * 0.28,
        );
        chip.rotation.y = -angle;
        addPart(chip, 'chip', angle);
      }
      addPart(new THREE.Mesh(new THREE.OctahedronGeometry(0.045, 0), pale), 'circuitCore');
    }

    signal.userData.style = resolvedStyle;
    signal.userData.identityColor = identityColor;
    signal.userData.parts = parts;
    signal.userData.tintMaterials = [primary, soft];
    signal.userData.materials = [primary, soft, pale];
    signal.userData.mode = 'idle';
    signal.userData.modeChangedAt = 0;
    signal.userData.baseHeight = baseHeight;
    character.add(signal);
    character.userData.activitySignal = signal;
  }

  function applyRoleWorkPose(character, style, mode, time) {
    const body = character.userData.body;
    const head = character.userData.headRig;
    if (!body) return;
    const motion = mode === 'review' ? 0.64 : 1;
    character.userData.workPose = { style, mode };

    if (style === 'conductor') {
      body.rotation.y += Math.sin(time * 1.25) * 0.08 * motion;
      body.rotation.x += 0.025;
      if (head) head.rotation.y += Math.sin(time * 0.72) * 0.15;
    } else if (style === 'clock') {
      body.rotation.y += Math.sin(time * 1.8) * 0.055 * motion;
      body.rotation.x += 0.035;
      body.position.y += Math.abs(Math.sin(time * 1.8)) * 0.012;
    } else if (style === 'proof') {
      body.rotation.x += 0.055;
      if (head) {
        head.rotation.x += 0.19;
        head.rotation.y += Math.sin(time * 0.62) * 0.045;
      }
    } else if (style === 'paint') {
      body.rotation.y += Math.sin(time * 1.05) * 0.07 * motion;
      if (head) {
        head.rotation.x += 0.045;
        head.rotation.z += Math.sin(time * 1.45) * 0.055;
      }
    } else if (style === 'observer') {
      body.rotation.x += 0.018;
      if (head) {
        head.rotation.x -= 0.035;
        head.rotation.y += Math.sin(time * 0.48) * 0.34;
      }
    } else {
      body.rotation.x += 0.035;
      if (head) head.rotation.y += Math.sin(time * 1.35) * 0.18;
    }

    if (mode === 'error') {
      body.rotation.z += Math.sin(time * 12) * 0.028;
      body.rotation.y += Math.sin(time * 8) * 0.035;
    } else if (mode === 'complete') {
      body.position.y += Math.abs(Math.sin(time * 3.2)) * 0.026;
      if (head) head.rotation.z += Math.sin(time * 2.4) * 0.035;
    }
  }

  function updateAgentActivitySignal(character, dt, time, move01 = 0) {
    const signal = character.userData.activitySignal;
    if (!signal) return;
    const status = character.userData.agent?.status || {};
    const mode = agentActivityMode(status);
    if (mode !== signal.userData.mode) {
      signal.userData.mode = mode;
      signal.userData.modeChangedAt = time;
    }
    const modeAge = Math.max(0, time - signal.userData.modeChangedAt);
    const completionLife = 8;
    signal.visible = mode !== 'idle' && (mode !== 'complete' || modeAge < completionLife);
    character.userData.workPose = null;
    if (!signal.visible) return;

    const tint = mode === 'working'
      ? signal.userData.identityColor
      : mode === 'review'
        ? palette.review
        : mode === 'error'
          ? palette.error
          : palette.idle;
    for (const material of signal.userData.tintMaterials) material.color.set(tint);
    const fade = mode === 'complete'
      ? THREE.MathUtils.clamp(1 - modeAge / completionLife, 0, 1)
      : 1;
    const errorPulse = mode === 'error' ? 0.72 + Math.abs(Math.sin(time * 7)) * 0.28 : 1;
    for (const material of signal.userData.materials) {
      material.opacity = material.userData.baseOpacity * fade * errorPulse;
    }

    const style = signal.userData.style;
    const pace = mode === 'error' ? 1.8 : mode === 'review' ? 0.42 : mode === 'complete' ? 1.1 : 0.86;
    signal.rotation.y += dt * pace;
    signal.position.set(
      mode === 'error' ? Math.sin(time * 27) * 0.025 : 0,
      signal.userData.baseHeight + (mode === 'error' ? Math.sin(time * 19) * 0.018 : 0),
      0,
    );
    const scale = mode === 'complete'
      ? 1 + modeAge * 0.055
      : 1 + Math.sin(time * (mode === 'error' ? 7 : 2.2)) * (mode === 'error' ? 0.09 : 0.025);
    signal.scale.setScalar(scale);

    for (const part of signal.userData.parts) {
      const kind = part.userData.activityKind;
      const phase = part.userData.phase || 0;
      part.position.copy(part.userData.basePosition);
      part.rotation.copy(part.userData.baseRotation);
      part.scale.copy(part.userData.baseScale);

      if (style === 'conductor' && kind === 'note') {
        part.position.y += Math.sin(time * 2.6 + phase) * 0.065;
        part.rotation.y += time * 1.2 + phase;
      } else if (style === 'clock' && kind === 'tick') {
        part.scale.multiplyScalar(0.88 + Math.abs(Math.sin(time * 2 + phase)) * 0.22);
      } else if (style === 'clock' && kind === 'hand') {
        part.rotation.y -= time * (mode === 'error' ? 4.5 : 1.5);
      } else if (style === 'circuit' && kind === 'chip') {
        part.scale.multiplyScalar(0.82 + Math.abs(Math.sin(time * 3.6 + phase)) * 0.38);
        part.position.y += Math.sin(time * 2.2 + phase) * 0.035;
      } else if (style === 'circuit' && kind === 'circuitCore') {
        part.rotation.y += time * 2.2;
        part.scale.multiplyScalar(0.9 + Math.abs(Math.sin(time * 3.2)) * 0.35);
      } else if (style === 'proof' && kind === 'page') {
        part.position.y += Math.sin(time * 1.7 + phase) * 0.045;
        part.rotation.z += Math.sin(time * 1.2 + phase) * 0.08;
      } else if (style === 'paint' && kind === 'petal') {
        const rise = (time * 0.12 + phase / (Math.PI * 2)) % 1;
        part.position.y += rise * 0.28 - 0.12;
        part.rotation.y += time * 1.5 + phase;
        part.scale.multiplyScalar(0.82 + Math.sin(rise * Math.PI) * 0.28);
      } else if (style === 'paint' && kind === 'paintCore') {
        part.rotation.y += time * 1.8;
        part.scale.multiplyScalar(0.9 + Math.abs(Math.sin(time * 2.5)) * 0.3);
      } else if (style === 'observer' && kind === 'eye') {
        part.position.y += Math.sin(time * 1.1 + phase) * 0.055;
        part.rotation.y = -signal.rotation.y;
      } else if (kind === 'ring') {
        part.rotation.z += Math.sin(time * 0.9) * 0.16;
      }
    }

    if (move01 < 0.15) {
      applyRoleWorkPose(character, style, mode, time);
      const limbs = character.userData.limbs;
      if (!limbs) return;
      if (mode === 'complete') {
        limbs.armL.rotation.x = -0.72 + Math.sin(time * 3.2) * 0.12;
        limbs.armR.rotation.x = -0.72 - Math.sin(time * 3.2) * 0.12;
      } else if (mode === 'error') {
        limbs.armL.rotation.x = 0.06 + Math.sin(time * 5.5) * 0.05;
        limbs.armR.rotation.x = 0.06 - Math.sin(time * 5.5) * 0.05;
      } else if (style === 'conductor') {
        limbs.armL.rotation.x = -0.24 - Math.sin(time * 2.8) * 0.10;
        limbs.armR.rotation.x = -0.52 + Math.sin(time * 3.2) * 0.28;
      } else if (style === 'clock') {
        limbs.armL.rotation.x = -0.16 + Math.sin(time * 1.6) * 0.06;
        limbs.armR.rotation.x = -0.16 - Math.sin(time * 1.6) * 0.06;
      } else if (style === 'proof') {
        limbs.armL.rotation.x = -0.50 + Math.sin(time * 1.5) * 0.05;
        limbs.armR.rotation.x = -0.18 - Math.sin(time * 1.9) * 0.08;
      } else if (style === 'paint') {
        limbs.armL.rotation.x = -0.18 - Math.sin(time * 2.0) * 0.08;
        limbs.armR.rotation.x = -0.46 + Math.sin(time * 3.7) * 0.26;
      } else if (style === 'observer') {
        limbs.armL.rotation.x = -0.28;
        limbs.armR.rotation.x = -0.10 + Math.sin(time * 1.1) * 0.08;
      } else {
        limbs.armL.rotation.x = -0.30 + Math.sin(time * 3.1) * 0.10;
        limbs.armR.rotation.x = -0.48 - Math.sin(time * 4.4) * 0.14;
      }
    }
  }

  return {
    statusColor,
    isWorkingStatus,
    isReviewStatus,
    isErrorStatus,
    isCompletedStatus,
    agentActivityMode,
    addAgentActivitySignal,
    updateAgentActivitySignal,
  };
}
