const COMPLETE_STATE = /완료|성공|completed|done/i;

/**
 * Procedural, opt-in ambience for the static site.
 * No audio files are fetched: one deterministic noise loop is filtered into
 * sea, wind, and rain layers. The AudioContext is created only after a click,
 * so every visit starts genuinely muted and respects browser autoplay rules.
 */
export function createAmbientAudio({ button } = {}) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  const supported = typeof AudioContextClass === 'function';
  const agentStates = new Map();
  const levels = { ocean: 0, wind: 0, rain: 0 };
  let context = null;
  let master = null;
  let oceanGain = null;
  let windGain = null;
  let rainGain = null;
  let noiseSource = null;
  let enabled = false;
  let observedAgents = false;
  let lastAudioTick = -Infinity;
  let lastChimeAt = -Infinity;
  let suspendTimer = null;

  function syncButton() {
    if (!button) return;
    button.disabled = !supported;
    button.textContent = enabled ? '♫' : '♬';
    button.setAttribute('aria-pressed', String(enabled));
    const label = supported
      ? (enabled ? '환경음 끄기' : '환경음 켜기')
      : '이 브라우저는 환경음을 지원하지 않습니다';
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  function makeNoiseBuffer(audioContext, seconds = 4) {
    const frameCount = Math.floor(audioContext.sampleRate * seconds);
    const buffer = audioContext.createBuffer(1, frameCount, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x51f15e;
    let previous = 0;
    for (let i = 0; i < frameCount; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const white = seed / 4294967296 * 2 - 1;
      previous = previous * 0.78 + white * 0.22;
      data[i] = previous * 0.82 + white * 0.18;
    }
    return buffer;
  }

  function connectLayer(source, filters, gain) {
    let tail = source;
    for (const filter of filters) {
      tail.connect(filter);
      tail = filter;
    }
    tail.connect(gain);
    gain.connect(master);
  }

  function ensureGraph() {
    if (!supported) return false;
    if (context) return true;
    context = new AudioContextClass();
    master = context.createGain();
    master.gain.value = 0;
    master.connect(context.destination);

    noiseSource = context.createBufferSource();
    noiseSource.buffer = makeNoiseBuffer(context);
    noiseSource.loop = true;

    const oceanLow = context.createBiquadFilter();
    oceanLow.type = 'lowpass';
    oceanLow.frequency.value = 520;
    oceanLow.Q.value = 0.7;
    const oceanHigh = context.createBiquadFilter();
    oceanHigh.type = 'highpass';
    oceanHigh.frequency.value = 55;
    oceanGain = context.createGain();
    oceanGain.gain.value = 0;
    connectLayer(noiseSource, [oceanLow, oceanHigh], oceanGain);

    const windBand = context.createBiquadFilter();
    windBand.type = 'bandpass';
    windBand.frequency.value = 860;
    windBand.Q.value = 0.45;
    windGain = context.createGain();
    windGain.gain.value = 0;
    connectLayer(noiseSource, [windBand], windGain);

    const rainHigh = context.createBiquadFilter();
    rainHigh.type = 'highpass';
    rainHigh.frequency.value = 2300;
    const rainLow = context.createBiquadFilter();
    rainLow.type = 'lowpass';
    rainLow.frequency.value = 7800;
    rainGain = context.createGain();
    rainGain.gain.value = 0;
    connectLayer(noiseSource, [rainHigh, rainLow], rainGain);

    noiseSource.start();
    return true;
  }

  async function setEnabled(next) {
    if (!ensureGraph()) return false;
    const nextEnabled = !!next;
    enabled = nextEnabled;
    if (suspendTimer) clearTimeout(suspendTimer);
    suspendTimer = null;
    if (nextEnabled && context.state === 'suspended') {
      await context.resume();
      lastAudioTick = -Infinity;
    }
    if (enabled !== nextEnabled) return enabled;
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(nextEnabled ? 0.58 : 0, now, nextEnabled ? 0.18 : 0.08);
    if (!nextEnabled) {
      const audioContext = context;
      // Let the short fade finish, then stop audio rendering while muted.
      suspendTimer = setTimeout(() => {
        suspendTimer = null;
        if (!enabled && context === audioContext && audioContext.state === 'running') {
          audioContext.suspend().catch(() => {});
        }
      }, 480);
    }
    syncButton();
    return enabled;
  }

  button?.addEventListener('click', () => {
    setEnabled(!enabled).catch(() => {
      enabled = false;
      syncButton();
    });
  });
  syncButton();

  function update({ elapsed = 0, wind = 0.2, precip = 0, cloud = 0.3, day = 1 } = {}) {
    levels.ocean = 0.045 + Math.sin(elapsed * 0.31) * 0.009 + precip * 0.012;
    levels.wind = 0.008 + Math.max(0, wind) * 0.075 + Math.max(0, cloud - 0.7) * 0.012;
    levels.rain = precip > 0.02
      ? (0.02 + Math.sqrt(Math.max(0, precip)) * 0.10) * (1 + (1 - day) * 0.12)
      : 0;
    if (!context || context.state !== 'running' || elapsed - lastAudioTick < 0.10) return;
    lastAudioTick = elapsed;
    const now = context.currentTime;
    oceanGain.gain.setTargetAtTime(levels.ocean, now, 0.45);
    windGain.gain.setTargetAtTime(levels.wind, now, 0.30);
    rainGain.gain.setTargetAtTime(levels.rain, now, 0.20);
  }

  function playCompletionChime() {
    if (!enabled || !context || context.state !== 'running') return;
    if (context.currentTime - lastChimeAt < 1.5) return;
    const now = context.currentTime + 0.02;
    lastChimeAt = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);
    gain.connect(master);
    [659.25, 880].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      if (index === 1) {
        oscillator.addEventListener('ended', () => gain.disconnect(), { once: true });
      }
      oscillator.start(now + index * 0.08);
      oscillator.stop(now + 0.74);
    });
  }

  function observeAgentStates(agents = []) {
    for (const agent of agents) {
      const key = agent?.key;
      if (!key) continue;
      const state = String(agent.status?.state || '');
      const previous = agentStates.get(key) || '';
      if (observedAgents && COMPLETE_STATE.test(state) && !COMPLETE_STATE.test(previous)) {
        playCompletionChime();
      }
      agentStates.set(key, state);
    }
    observedAgents = true;
  }

  function state() {
    return {
      supported,
      enabled,
      contextState: context?.state || 'not-created',
      defaultMuted: true,
      powerSaving: !enabled && context?.state === 'suspended',
      levels: Object.fromEntries(
        Object.entries(levels).map(([key, value]) => [key, +value.toFixed(3)]),
      ),
    };
  }

  return { update, observeAgentStates, setEnabled, state };
}
