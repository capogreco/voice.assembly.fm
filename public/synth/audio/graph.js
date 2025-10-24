// @ts-check

/**
 * Audio graph building for Voice.Assembly.FM Synth Client
 */

/**
 * Initialize audio context and basic components
 * @returns {Promise<AudioContext>} - Initialized audio context
 */
export async function initializeAudioContext() {
  const audioContext = new AudioContext();

  // Resume context if suspended
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return audioContext;
}

/**
 * Load audio worklet modules
 * @param {AudioContext} audioContext - Audio context
 * @returns {Promise<void>}
 */
export async function loadWorkletModules(audioContext) {
  try {
    // Load phasor AudioWorklet processor
    await audioContext.audioWorklet.addModule(
      "./worklets/phasor-processor.worklet.js",
    );

    // Load voice worklet
    await audioContext.audioWorklet.addModule(
      "./worklets/voice-worklet.js",
    );
  } catch (error) {
    console.error("Failed to load worklet modules:", error);
    throw error;
  }
}

/**
 * Create master gain node
 * @param {AudioContext} audioContext - Audio context
 * @param {number} volume - Initial volume (0-1)
 * @returns {GainNode} - Master gain node
 */
export function createMasterGain(audioContext, volume = 0.1) {
  const masterGain = audioContext.createGain();
  masterGain.gain.value = volume;
  masterGain.connect(audioContext.destination);
  return masterGain;
}

/**
 * Initialize phasor worklet for sample-accurate timing
 * @param {AudioContext} audioContext - Audio context
 * @param {number} cycleLength - Initial cycle length
 * @returns {AudioWorkletNode} - Phasor worklet node
 */
export function createPhasorWorklet(audioContext, cycleLength = 2.0) {
  const phasorWorklet = new AudioWorkletNode(
    audioContext,
    "phasor-processor",
    {
      outputChannelCount: [1],
    },
  );

  // Set initial cycle length
  phasorWorklet.parameters.get("cycleLength").value = cycleLength;

  return phasorWorklet;
}

/**
 * Initialize voice synthesis worklet
 * @param {AudioContext} audioContext - Audio context
 * @returns {Promise<Object>} - Voice synthesis components
 */
export async function createVoiceSynthesis(audioContext) {
  const voiceNode = new AudioWorkletNode(
    audioContext,
    "voice-worklet",
    {
      numberOfInputs: 0, // Phase input via AudioParam
      numberOfOutputs: 1,
      outputChannelCount: [5], // Main, duplicate, F1, F2, F3
    },
  );

  // Create mixer for voice output
  const mixer = audioContext.createGain();

  // Create channel splitter for voice worklet's 5 outputs
  const voiceSplitter = audioContext.createChannelSplitter(5);
  voiceNode.connect(voiceSplitter);

  // Route channel 0 (main audio) to mixer for sound output
  voiceSplitter.connect(mixer, 0);

  // Create stereo merger for oscilloscope (F1/F2 channels with decorrelated noise)
  const oscilloscopeMerger = audioContext.createChannelMerger(2);

  // Route F1 and F2 (with integrated noise) directly to oscilloscope
  voiceSplitter.connect(oscilloscopeMerger, 2, 0); // F1 + noise -> X axis
  voiceSplitter.connect(oscilloscopeMerger, 3, 1); // F2 + noise -> Y axis

  return {
    voiceNode,
    mixer,
    voiceSplitter,
    oscilloscopeMerger,
  };
}

/**
 * Connect phasor to voice worklet
 * @param {AudioWorkletNode} phasorWorklet - Phasor worklet
 * @param {AudioWorkletNode} voiceNode - Voice worklet
 */
export function connectPhasorToVoice(phasorWorklet, voiceNode) {
  if (phasorWorklet && voiceNode) {
    phasorWorklet.connect(voiceNode.parameters.get("phase"));
  }
}

/**
 * Setup complete audio graph
 * @param {AudioContext} audioContext - Audio context
 * @param {number} volume - Initial volume
 * @param {number} cycleLength - Initial cycle length
 * @returns {Promise<Object>} - Complete audio graph components
 */
export async function setupAudioGraph(
  audioContext,
  volume = 0.1,
  cycleLength = 2.0,
) {
  // Load worklet modules
  await loadWorkletModules(audioContext);

  // Create master gain
  const masterGain = createMasterGain(audioContext, volume);

  // Create phasor worklet
  const phasorWorklet = createPhasorWorklet(audioContext, cycleLength);

  // Create voice synthesis
  const voiceComponents = await createVoiceSynthesis(audioContext);

  // Connect voice mixer to master gain
  voiceComponents.mixer.connect(masterGain);

  // Connect phasor to voice
  connectPhasorToVoice(phasorWorklet, voiceComponents.voiceNode);

  return {
    masterGain,
    phasorWorklet,
    ...voiceComponents,
  };
}

/**
 * Update volume
 * @param {GainNode} masterGain - Master gain node
 * @param {number} volume - New volume (0-1)
 */
export function updateVolume(masterGain, volume) {
  if (masterGain) {
    masterGain.gain.value = Math.max(0, Math.min(1, volume));
  }
}

/**
 * Initialize parameter output mapping
 * @returns {Object} - Parameter to output channel mapping
 */
export function createParameterOutputMapping() {
  return {
    frequency: 0,
    zingMorph: 1,
    zingAmount: 2,
    vowelX: 3,
    vowelY: 4,
    symmetry: 5,
    amplitude: 6,
    whiteNoise: 7,
  };
}

/**
 * Request screen wake lock to keep screen awake during performance
 * @returns {Promise<Object|null>} - Wake lock object or null if not supported
 */
export async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      const wakeLock = await navigator.wakeLock.request("screen");
      console.log("Screen wake lock acquired");
      return wakeLock;
    }
  } catch (error) {
    console.warn("Could not acquire screen wake lock:", error);
  }
  return null;
}
