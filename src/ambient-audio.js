const COMPLETE_STATE = /완료|성공|completed|done/i;
const MAX_VOICES = 4;
const EFFECTS = {
  board: { frequency: 220, endFrequency: 330, duration: 0.18, peak: 0.028, type: 'sine', debounce: 0.35 },
  land: { frequency: 190, endFrequency: 110, duration: 0.16, peak: 0.032, type: 'sine', debounce: 0.30 },
  open: { frequency: 440, endFrequency: 554.37, duration: 0.12, peak: 0.020, type: 'sine', debounce: 0.25 },
  confirm: { frequency: 659.25, endFrequency: 880, duration: 0.20, peak: 0.024, type: 'sine', debounce: 0.30 },
};

/**
 * Procedural, opt-in ambience and interaction sounds in one shared graph.
 * No assets, timers, or autoplay: only setEnabled(true) can opt into audio.
 */
export function createAmbientAudio({ button } = {}) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  const supported = typeof AudioContextClass === 'function';
  const document = globalThis.document;
  const agentStates = new Map();
  const levels = { ocean: 0, wind: 0, rain: 0 };
  const graphNodes = new Set();
  const voices = new Set();
  const lastPlayedAt = Object.fromEntries(Object.keys(EFFECTS).map((name) => [name, null]));
  const played = Object.fromEntries(Object.keys(EFFECTS).map((name) => [name, 0]));
  const dropped = { inactive: 0, unknown: 0, debounce: 0, voiceLimit: 0, failure: 0 };
  let context = null;
  let master = null;
  let oceanGain = null;
  let windGain = null;
  let rainGain = null;
  let noiseSource = null;
  let enabled = false;
  let audible = false;
  let disposed = false;
  let observedAgents = false;
  let lastAudioTick = -Infinity;
  let lastChimeAt = -Infinity;
  let lastEffect = null;
  let lastError = null;
  let generation = 0;
  let transition = Promise.resolve();
  let transitioning = false;
  let cancelResumeWait = null;
  let disposal = null;

  const hidden = () => document?.hidden === true || document?.visibilityState === 'hidden';
  const canPlay = () => !disposed && enabled && audible && !hidden() && context?.state === 'running';
  const safely = (action) => { try { action(); } catch { /* Already stopped or closed. */ } };

  function syncButton() {
    if (!button) return;
    button.disabled = !supported || disposed;
    button.textContent = enabled ? '♫' : '♬';
    button.setAttribute('aria-pressed', String(enabled));
    const label = supported
      ? (enabled ? '소리 끄기' : '소리 켜기')
      : '이 브라우저는 소리를 지원하지 않습니다';
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

  function track(node) {
    graphNodes.add(node);
    return node;
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
    if (context) return;
    context = new AudioContextClass();
    master = track(context.createGain());
    master.gain.value = 0;
    master.connect(context.destination);

    noiseSource = track(context.createBufferSource());
    noiseSource.buffer = makeNoiseBuffer(context);
    noiseSource.loop = true;

    const oceanLow = track(context.createBiquadFilter());
    oceanLow.type = 'lowpass';
    oceanLow.frequency.value = 520;
    oceanLow.Q.value = 0.7;
    const oceanHigh = track(context.createBiquadFilter());
    oceanHigh.type = 'highpass';
    oceanHigh.frequency.value = 55;
    oceanGain = track(context.createGain());
    oceanGain.gain.value = 0;
    connectLayer(noiseSource, [oceanLow, oceanHigh], oceanGain);

    const windBand = track(context.createBiquadFilter());
    windBand.type = 'bandpass';
    windBand.frequency.value = 860;
    windBand.Q.value = 0.45;
    windGain = track(context.createGain());
    windGain.gain.value = 0;
    connectLayer(noiseSource, [windBand], windGain);

    const rainHigh = track(context.createBiquadFilter());
    rainHigh.type = 'highpass';
    rainHigh.frequency.value = 2300;
    const rainLow = track(context.createBiquadFilter());
    rainLow.type = 'lowpass';
    rainLow.frequency.value = 7800;
    rainGain = track(context.createGain());
    rainGain.gain.value = 0;
    connectLayer(noiseSource, [rainHigh, rainLow], rainGain);

    noiseSource.start();
  }

  function releaseVoice(voice, stop = false) {
    voices.delete(voice);
    if (voice.oscillator) {
      voice.oscillator.removeEventListener('ended', voice.onEnded);
      if (stop) safely(() => voice.oscillator.stop());
      safely(() => voice.oscillator.disconnect());
    }
    if (voice.gain) safely(() => voice.gain.disconnect());
  }

  function silence() {
    audible = false;
    if (master && context) {
      safely(() => {
        master.gain.cancelScheduledValues(context.currentTime);
        master.gain.setValueAtTime(0, context.currentTime);
      });
    }
    for (const voice of voices) releaseVoice(voice, true);
  }

  async function releaseGraph() {
    silence();
    if (noiseSource) safely(() => noiseSource.stop());
    for (const node of graphNodes) safely(() => node.disconnect());
    graphNodes.clear();
    const oldContext = context;
    context = master = noiseSource = oceanGain = windGain = rainGain = null;
    lastAudioTick = lastChimeAt = -Infinity;
    for (const name of Object.keys(EFFECTS)) lastPlayedAt[name] = null;
    if (oldContext && oldContext.state !== 'closed') {
      try { await oldContext.close(); } catch { /* The graph is already disconnected. */ }
    }
  }

  async function resumeContext(audioContext, revision) {
    let cancel;
    const superseded = new Promise((resolve) => { cancel = resolve; });
    cancelResumeWait = cancel;
    try {
      const resumed = Promise.resolve(audioContext.resume());
      // A browser may leave resume pending while hidden or waiting for unlock.
      // New intent can proceed; a late resume is silenced and suspended again.
      void resumed.then(() => {
        if (!disposed && context === audioContext && revision !== generation && (!enabled || hidden())) {
          silence();
          void requestSync();
        }
      }, () => {});
      await Promise.race([resumed, superseded]);
    } finally {
      if (cancelResumeWait === cancel) cancelResumeWait = null;
    }
  }

  function requestSync() {
    const revision = ++generation;
    cancelResumeWait?.();
    cancelResumeWait = null;
    // Serialize reconciliation, but don't let a stale resume block newer intent.
    const reconcile = async () => {
      if (disposed || revision !== generation) return;
      try {
        if (!enabled || hidden()) {
          if (context && context.state !== 'closed' && context.state !== 'suspended') {
            await context.suspend();
          }
          return;
        }
        if (context?.state === 'closed') await releaseGraph();
        if (disposed || revision !== generation) return;
        ensureGraph();
        const audioContext = context;
        if (audioContext.state !== 'running') await resumeContext(audioContext, revision);
        if (disposed || revision !== generation || context !== audioContext) return;
        if (audioContext.state !== 'running') throw new Error('AudioContext did not resume');
        const now = audioContext.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(0.58, now, 0.18);
        audible = true;
        lastAudioTick = -Infinity;
        lastError = null;
      } catch (error) {
        if (disposed || revision !== generation) return;
        lastError = String(error?.message || error);
        enabled = false;
        // A failed suspend must also leave no connected, running graph.
        const closing = releaseGraph();
        syncButton();
        await closing;
      }
    };
    // Idle click handlers create/resume synchronously, preserving Safari unlock.
    if (transitioning) transition = transition.then(reconcile);
    else {
      transitioning = true;
      transition = reconcile();
    }
    const current = transition;
    void current.then(() => {
      if (transition === current) transitioning = false;
    });
    return transition.then(() => enabled);
  }

  function setEnabled(next) {
    if (disposed) return Promise.resolve(false);
    enabled = supported && !!next;
    if (!enabled || hidden()) silence();
    syncButton();
    return requestSync();
  }

  function onClick() {
    void setEnabled(!enabled);
  }

  function onVisibilityChange() {
    if (disposed) return;
    if (hidden()) silence();
    void requestSync();
  }

  button?.addEventListener('click', onClick);
  document?.addEventListener('visibilitychange', onVisibilityChange);
  syncButton();

  function update({ elapsed = 0, wind = 0.2, precip = 0, cloud = 0.3, day = 1 } = {}) {
    if (disposed) return;
    levels.ocean = 0.045 + Math.sin(elapsed * 0.31) * 0.009 + precip * 0.012;
    levels.wind = 0.008 + Math.max(0, wind) * 0.075 + Math.max(0, cloud - 0.7) * 0.012;
    levels.rain = precip > 0.02
      ? (0.02 + Math.sqrt(Math.max(0, precip)) * 0.10) * (1 + (1 - day) * 0.12)
      : 0;
    if (!canPlay() || elapsed - lastAudioTick < 0.10) return;
    lastAudioTick = elapsed;
    const now = context.currentTime;
    oceanGain.gain.setTargetAtTime(levels.ocean, now, 0.45);
    windGain.gain.setTargetAtTime(levels.wind, now, 0.30);
    rainGain.gain.setTargetAtTime(levels.rain, now, 0.20);
  }

  function startVoices(notes) {
    if (voices.size + notes.length > MAX_VOICES) return false;
    const created = [];
    try {
      for (const note of notes) {
        const voice = { gain: null, oscillator: null, onEnded: null };
        created.push(voice);
        const now = context.currentTime + 0.01 + (note.offset || 0);
        voice.gain = context.createGain();
        voice.gain.gain.setValueAtTime(0.0001, now);
        voice.gain.gain.exponentialRampToValueAtTime(note.peak, now + 0.018);
        voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + note.duration);
        voice.gain.connect(master);
        voice.oscillator = context.createOscillator();
        voice.oscillator.type = note.type || 'sine';
        voice.oscillator.frequency.setValueAtTime(note.frequency, now);
        voice.oscillator.frequency.exponentialRampToValueAtTime(note.endFrequency || note.frequency, now + note.duration);
        voice.oscillator.connect(voice.gain);
        voice.onEnded = () => releaseVoice(voice);
        voice.oscillator.addEventListener('ended', voice.onEnded, { once: true });
        voices.add(voice);
        voice.oscillator.start(now);
        voice.oscillator.stop(now + note.duration + 0.015);
      }
      return true;
    } catch {
      for (const voice of created) releaseVoice(voice, true);
      return false;
    }
  }

  /** Returns true only when a known effect was actually scheduled. Never enables audio. */
  function playEffect(name) {
    if (typeof name !== 'string' || !Object.hasOwn(EFFECTS, name)) {
      dropped.unknown++;
      return false;
    }
    if (!canPlay()) {
      dropped.inactive++;
      return false;
    }
    const effect = EFFECTS[name];
    const now = context.currentTime;
    if (lastPlayedAt[name] !== null && now - lastPlayedAt[name] < effect.debounce) {
      dropped.debounce++;
      return false;
    }
    if (voices.size >= MAX_VOICES) {
      dropped.voiceLimit++;
      return false;
    }
    if (!startVoices([effect])) {
      dropped.failure++;
      return false;
    }
    lastPlayedAt[name] = now;
    played[name]++;
    lastEffect = name;
    return true;
  }

  function playCompletionChime() {
    if (!canPlay() || context.currentTime - lastChimeAt < 1.5) return;
    if (startVoices([
      { frequency: 659.25, duration: 0.64, peak: 0.04 },
      { frequency: 880, duration: 0.64, peak: 0.04, offset: 0.08 },
    ])) lastChimeAt = context.currentTime;
  }

  function observeAgentStates(agents = []) {
    if (disposed) return;
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

  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    enabled = false;
    generation++;
    cancelResumeWait?.();
    cancelResumeWait = null;
    button?.removeEventListener('click', onClick);
    document?.removeEventListener('visibilitychange', onVisibilityChange);
    agentStates.clear();
    disposal = releaseGraph();
    syncButton();
    return disposal;
  }

  function state() {
    return {
      supported,
      enabled,
      contextState: context?.state || 'not-created',
      defaultMuted: true,
      powerSaving: (!enabled || hidden()) && context?.state === 'suspended',
      levels: Object.fromEntries(
        Object.entries(levels).map(([key, value]) => [key, +value.toFixed(3)]),
      ),
      hidden: hidden(),
      audible: canPlay(),
      disposed,
      lastError,
      effects: {
        names: Object.keys(EFFECTS),
        debounceSeconds: Object.fromEntries(Object.entries(EFFECTS).map(([name, effect]) => [name, effect.debounce])),
        maxVoices: MAX_VOICES,
        activeVoices: voices.size,
        lastEffect,
        lastPlayedAt: { ...lastPlayedAt },
        played: { ...played },
        dropped: { ...dropped },
      },
    };
  }

  return { update, observeAgentStates, setEnabled, playEffect, dispose, state };
}
