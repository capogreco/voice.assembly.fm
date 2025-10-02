/**
 * AudioWorklet lifecycle management for Voice.Assembly.FM Synth Client
 */

/**
 * Initialize phasor worklet for sample-accurate timing
 * @param {AudioContext} audioContext - Web Audio API context
 * @param {boolean} verbose - Verbose logging
 * @returns {AudioWorkletNode} - Phasor worklet node
 */
export function initializePhasorWorklet(audioContext, verbose = false) {
  const phasorWorklet = new AudioWorkletNode(
    audioContext,
    "phasor-processor",
    {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        sampleRate: audioContext.sampleRate,
      },
    },
  );

  // Handle messages from phasor worklet
  phasorWorklet.port.onmessage = (event) => {
    const { type, phasor } = event.data;
    if (type === "PHASOR_UPDATE") {
      this.workletPhasor = phasor;
    }
  };

  if (verbose) {
    console.log("🔄 Phasor worklet initialized");
  }

  return phasorWorklet;
}

/**
 * Initialize formant synthesis worklet
 * @param {AudioContext} audioContext - Web Audio API context
 * @param {AudioWorkletNode} phasorWorklet - Phasor worklet for timing
 * @param {AudioGainNode} masterGain - Master gain node
 * @param {boolean} verbose - Verbose logging
 * @returns {Object} - Voice synthesis components
 */
export async function initializeFormantSynthesis(audioContext, phasorWorklet, masterGain, verbose = false) {
  try {
    // Load voice worklet
    await audioContext.audioWorklet.addModule(
      "./worklets/voice-worklet.js",
    );

    // Create voice worklet with envelope generation and DSP synthesis
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

    // Connect mixer to master gain
    mixer.connect(masterGain);

    // Connect phasor worklet to voice worklet phase parameter
    if (phasorWorklet && voiceNode) {
      phasorWorklet.connect(
        voiceNode.parameters.get("phase"),
      );
      if (verbose) {
        console.log(
          "🔗 Phasor worklet connected to voice worklet phase parameter",
        );
      }
    }

    return {
      voiceNode,
      mixer,
      voiceSplitter,
      oscilloscopeMerger,
    };
  } catch (error) {
    console.error("❌ Failed to initialize formant synthesis:", error);
    throw error;
  }
}

/**
 * Apply stored state after audio worklets are ready
 * @param {Object} context - Synth context
 * @param {Object} context.lastProgramUpdate - Cached program update
 * @param {Object} context.lastSynthParams - Cached synth parameters
 * @param {function} context.handleProgramUpdate - Program update handler
 * @param {function} context.handleSynthParams - Synth params handler
 * @param {boolean} context.verbose - Verbose logging
 */
export function applyStoredState(context) {
  if (context.verbose) {
    console.log("🔄 Applying stored state after audio initialization");
  }

  // Apply cached PROGRAM_UPDATE if available
  if (context.lastProgramUpdate) {
    if (context.verbose) {
      console.log("📦 Applying cached PROGRAM_UPDATE after audio init");
    }
    context.handleProgramUpdate(context.lastProgramUpdate);
    context.lastProgramUpdate = null; // Clear cache
  }

  // Apply cached synth parameters if available
  if (context.lastSynthParams) {
    if (context.verbose) {
      console.log("📦 Applying cached synth parameters after audio init");
    }
    context.handleSynthParams(context.lastSynthParams);
  }
}

/**
 * Request screen wake lock to keep screen awake during performance
 * @param {boolean} verbose - Verbose logging
 * @returns {WakeLockSentinel|null} - Wake lock sentinel
 */
export async function requestWakeLock(verbose = false) {
  let wakeLock = null;

  if ("wakeLock" in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      if (verbose) {
        console.log("🔒 Screen wake lock acquired");
      }

      wakeLock.addEventListener("release", () => {
        if (verbose) {
          console.log("🔓 Screen wake lock released");
        }
      });
    } catch (error) {
      console.warn("⚠️ Could not acquire screen wake lock:", error);
    }
  } else {
    if (verbose) {
      console.log("⚠️ Wake Lock API not supported");
    }
  }

  return wakeLock;
}

/**
 * Update volume control
 * @param {AudioGainNode} masterGain - Master gain node
 * @param {number} volume - Volume level (0-1)
 */
export function updateVolume(masterGain, volume) {
  if (masterGain) {
    masterGain.gain.value = volume;
  }
}