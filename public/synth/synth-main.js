/**
 * Voice.Assembly.FM Synth Client Main Application
 */

import { generatePeerId, WebRTCStar } from "../../src/common/webrtc-star.js";
import {
  MessageBuilder,
  MessageTypes,
} from "../../src/common/message-protocol.js";
import { XYOscilloscope } from "./src/visualization/xy-oscilloscope.js";

class SynthClient {
  constructor() {
    this.peerId = generatePeerId("synth");
    this.star = null;
    this.audioContext = null;
    this.oscilloscope = null;

    // Audio synthesis
    this.masterGain = null;
    this.formantNode = null; // Legacy - will be replaced by voiceNode
    this.voiceNode = null; // New voice worklet for pure DSP
    this.programNode = null; // New program worklet for timing/control
    this.synthesisActive = false; // Track if synthesis is active
    this.noiseNode = null;

    // Parameter output mapping for routing
    this.paramOutputMapping = {
      frequency: 0,
      zingMorph: 1,
      zingAmount: 2,
      vowelX: 3,
      vowelY: 4,
      symmetry: 5,
      amplitude: 6,
      whiteNoise: 7,
    };

    // Audio graph components for parameter routing
    this.parameterSwitches = null;
    this.channelSplitter = null;
    this.channelMerger = null;

    // UI state
    this.currentState = "join"; // 'join', 'connecting', 'active'
    this.volume = 0.1;

    // Store received state for application after audio init
    this.lastSynthParams = null;
    this.lastProgramUpdate = null; // Cache PROGRAM_UPDATE until audio/worklets are ready

    // Program configuration
    this.program = null;
    this.randomSeed = this.hashString(this.peerId); // Unique seed per synth
    this.lastProgramUpdate = null; // cache last full program update for scenes
    this.pendingSceneState = null; // apply at next cycle reset to avoid clicks

    // Phasor synchronization
    this.receivedPhasor = 0.0;
    this.receivedBpm = 120;
    this.receivedBeatsPerCycle = 4;
    this.receivedCycleLength = 2.0;
    this.receivedStepsPerCycle = 16; // Default until first PHASOR_SYNC
    this.receivedCpm = 30; // Default cycles per minute
    this.lastPhasorMessage = 0;
    this.phasorRate = 0.5; // Phasor increment per second (1.0 / cycleLength)
    this.interpolatedPhasor = 0.0; // Current interpolated phasor value
    this.phasorUpdateId = null; // RequestAnimationFrame ID for interpolation

    // AudioWorklet phasor
    this.phasorWorklet = null; // AudioWorkletNode for sample-accurate phasor
    this.workletPhasor = 0.0; // Current phasor from AudioWorklet

    // Screen wake lock
    this.wakeLock = null;

    // Long press handling
    this.longPressTimer = null;
    this.pressStartTime = 0;

    // PLL (Phase-Locked Loop) settings
    this.pllCorrectionFactor = 0.1; // How aggressively to correct phase errors (0.1 = gentle)
    this.pllEnabled = true; // Enable/disable phase correction

    // Look-ahead scheduler settings
    this.timingConfig = null; // Official timing from controller
    this.schedulerLookahead = 0.1; // Schedule ramps 100ms ahead
    this.schedulerInterval = 25; // Check every 25ms
    this.nextCycleTime = null; // When the next cycle should start
    this.schedulerTimerId = null; // setTimeout ID for scheduler

    // Rhythm settings
    this.rhythmEnabled = false; // Enable/disable rhythmic events
    this.stepsPerCycle = 16; // Number of steps per cycle (16 = 16th notes)
    this.clickVolume = 0.3; // Volume for rhythmic click sounds
    this.receivedBeatsPerCycle = 4; // Store beats per cycle from ctrl for rhythm

    // UI Elements
    this.elements = {
      joinState: document.getElementById("join-state"),
      activeState: document.getElementById("active-state"),
      joinButton: document.getElementById("join-button"),
      connectionStatus: document.getElementById("connection-status"),
      synthId: document.getElementById("synth-id"),
      synthesisStatus: document.getElementById("synthesis-status"),
      loading: document.getElementById("loading"),
      canvas: document.getElementById("oscilloscope-canvas"),
    };

    this.amplitudeEnvelope = null;

    // Envelope calculation helpers needed for real-time gain control
    this._lerp = (a, b, mix) => a * (1 - mix) + b * mix;

    this._getLinTypeEnvelope = (t, p) => {
      const t_clamped = Math.max(0, Math.min(1, t));
      const p_clamped = Math.max(0, Math.min(1, p));
      let exponent;
      const minExponent = 1 / 8;
      const maxExponent = 8;
      if (p_clamped < 0.5) {
        exponent = 1 + (p_clamped - 0.5) * 2 * (1 - minExponent);
      } else {
        exponent = 1 + (p_clamped - 0.5) * 2 * (maxExponent - 1);
      }
      if (t_clamped === 0) return 0;
      return Math.pow(t_clamped, exponent);
    };

    this._getCosTypeEnvelope = (t, p) => {
      const t_clamped = Math.max(0, Math.min(1, t));
      const p_clamped = Math.max(0, Math.min(1, p));
      const f_square = t_clamped > 0 ? 1 : 0;
      const f_cosine = 0.5 - Math.cos(t_clamped * Math.PI) * 0.5;
      const f_median = t_clamped < 0.5 ? 0 : 1;
      if (p_clamped < 0.5) {
        const mix = p_clamped * 2;
        return this._lerp(f_square, f_cosine, mix);
      } else {
        const mix = (p_clamped - 0.5) * 2;
        return this._lerp(f_cosine, f_median, mix);
      }
    };

    this.setupEventHandlers();
    this.setupKeyboardShortcuts();

    // Scene Memory: Track resolved parameter state
    this.currentResolvedState = {};
    this.stableSynthId = this.getStableSynthId(); // Persistent ID for scene storage

    // Display synth ID (but it won't be visible until after joinChoir)
    this.updateSynthIdDisplay();

    // Auto-connect to network on page load
    this.autoConnect();
  }

  /**
   * Core routing logic - the "switchboard operator"
   * Manages whether parameters come from main thread or program worklet
   */
  _updateParameterRouting(paramName, mode) {
    if (!this.voiceNode || !this.programNode || !this.parameterSwitches) return;

    const gainNode = this.parameterSwitches[paramName];
    if (!gainNode) return;

    if (mode === "direct") {
      // Turn off program worklet input for this parameter (use AudioParam)
      gainNode.gain.setTargetAtTime(0, this.audioContext.currentTime, 0.015);
      const destination = paramName === "whiteNoise"
        ? "WhiteNoise Gain"
        : "Voice";
      console.log(`🔌 Route for '${paramName}': Main Thread -> ${destination}`);
    } else { // mode is 'program'
      // Turn on program worklet input for this parameter
      gainNode.gain.setTargetAtTime(1, this.audioContext.currentTime, 0.015);
      const destination = paramName === "whiteNoise"
        ? "WhiteNoise Gain"
        : "Voice";
      console.log(`🔌 Route for '${paramName}': Program -> ${destination}`);
    }
  }

  setupEventHandlers() {
    // Join button
    this.elements.joinButton.addEventListener("click", () => this.joinChoir());

    // Handle window resize for canvas
    globalThis.addEventListener("resize", () => {
      if (this.oscilloscope) {
        this.oscilloscope.resize();
      }
    });

    // Clean up on page unload
    globalThis.addEventListener("beforeunload", () => {
      this.cleanup();
    });
  }

  setupKeyboardShortcuts() {
    document.addEventListener("keydown", (event) => {
      // Only respond if no input fields are focused
      if (document.activeElement.tagName === "INPUT") return;

      switch (event.key.toLowerCase()) {
        case "m":
          if (this.audioContext) {
            this.toggleRhythm();
            event.preventDefault();
          }
          break;
      }
    });
  }

  async autoConnect() {
    try {
      // Connect to network immediately
      await this.connectToNetwork();

      // Show join button for audio initialization
      this.setState("join");
      this.updateConnectionStatus("connected", "Connected - Tap to join");
    } catch (error) {
      console.error("❌ Auto-connect failed:", error);
      this.updateConnectionStatus("error", `Error: ${error.message}`);
      this.setState("join");
    }
  }

  async joinChoir() {
    try {
      this.setState("initializing-audio");

      // Initialize audio context (requires user gesture)
      await this.initializeAudio();

      // Show active state first so canvas container has proper dimensions
      this.setState("active");

      // Initialize oscilloscope and long press after DOM is updated
      // Use requestAnimationFrame to ensure DOM changes are applied
      requestAnimationFrame(() => {
        this.initializeOscilloscope();

        // Set up long press now that the synth-id is visible
        this.setupLongPress();
      });
    } catch (error) {
      console.error("❌ Failed to join choir:", error);
      this.updateConnectionStatus("error", `Error: ${error.message}`);

      // Return to join state after 3 seconds
      setTimeout(() => {
        this.setState("join");
      }, 3000);
    }
  }

  async initializeAudio() {
    this.audioContext = new AudioContext();

    // Resume context if suspended
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    // Load phasor AudioWorklet processor
    try {
      await this.audioContext.audioWorklet.addModule(
        "./worklets/phasor-processor.worklet.js",
      );
    } catch (error) {
      console.error("❌ Failed to load phasor processor:", error);
      throw error;
    }

    // Create master gain node
    this.masterGain = this.audioContext.createGain();
    this.masterGain.connect(this.audioContext.destination);
    this.updateVolume();

    // Create phasor worklet for sample-accurate timing
    this.initializePhasorWorklet();

    // Initialize formant synthesis
    await this.initializeFormantSynthesis();

    // Request screen wake lock to keep screen awake during performance
    await this.requestWakeLock();
  }

  async initializeFormantSynthesis() {
    try {
      // Load all worklet modules
      await this.audioContext.audioWorklet.addModule(
        "./worklets/program-worklet.js",
      );
      await this.audioContext.audioWorklet.addModule(
        "./worklets/voice-worklet.js",
      );
      await this.audioContext.audioWorklet.addModule(
        "./worklets/white-noise-processor.js",
      );

      // Create program worklet with 8 outputs (one per parameter)
      this.programNode = new AudioWorkletNode(
        this.audioContext,
        "program-worklet",
        {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [8], // frequency, zingMorph, zingAmount, vowelX, vowelY, symmetry, amplitude, whiteNoise
        },
      );

      // Create voice worklet with 5 channels output (main + duplicate + F1 + F2 + F3)
      this.voiceNode = new AudioWorkletNode(
        this.audioContext,
        "voice-worklet",
        {
          numberOfInputs: 1, // Accept control inputs from program worklet
          numberOfOutputs: 1,
          inputChannelCount: [7], // 7 control channels from program worklet (excluding whiteNoise)
          outputChannelCount: [5], // Main, duplicate, F1, F2, F3
        },
      );

      // Create two independent white noise worklets for decorrelated audio/visualization
      this.whiteNoiseAudio = new AudioWorkletNode(
        this.audioContext,
        "white-noise-processor",
        {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2], // Stereo white noise for audio
        },
      );

      this.whiteNoiseViz = new AudioWorkletNode(
        this.audioContext,
        "white-noise-processor",
        {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2], // Stereo white noise for visualization
        },
      );

      // Send different seeds for decorrelated noise
      this.whiteNoiseAudio.port.postMessage({
        type: "seed",
        seed: Math.random(),
      });
      this.whiteNoiseViz.port.postMessage({
        type: "seed",
        seed: Math.random(),
      });

      // Create parameter routing system
      this.parameterSwitches = {};
      this.channelSplitter = this.audioContext.createChannelSplitter(8);

      // Create separate mergers for voice and noise parameters
      this.voiceChannelMerger = this.audioContext.createChannelMerger(7); // For voice worklet
      this.whiteNoiseAudioGain = this.audioContext.createGain(); // For audio white noise volume
      this.whiteNoiseAudioGain.gain.value = 0; // Default to silent

      // Connect program worklet to channel splitter
      this.programNode.connect(this.channelSplitter);

      // Create gain node switches for voice parameters (first 7 channels)
      const voiceParamNames = [
        "frequency",
        "zingMorph",
        "zingAmount",
        "vowelX",
        "vowelY",
        "symmetry",
        "amplitude",
      ];
      voiceParamNames.forEach((paramName, index) => {
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = 0; // Default to off (direct mode)
        this.parameterSwitches[paramName] = gainNode;

        // Connect: splitter → gain switch → voice merger
        this.channelSplitter.connect(gainNode, index);
        gainNode.connect(this.voiceChannelMerger, 0, index);
      });

      // Create gain switch for white noise parameter (channel 7)
      const whiteNoiseGainSwitch = this.audioContext.createGain();
      whiteNoiseGainSwitch.gain.value = 0; // Default to off (direct mode)
      this.parameterSwitches["whiteNoise"] = whiteNoiseGainSwitch;

      // Connect whiteNoise parameter to control audio white noise volume only
      this.channelSplitter.connect(whiteNoiseGainSwitch, 7); // Channel 7 is whiteNoise
      whiteNoiseGainSwitch.connect(this.whiteNoiseAudioGain.gain); // Control the audio gain only

      // Create mixer for combining voice and white noise
      this.mixer = this.audioContext.createGain(); // Simple mixer

      // Connect voice merger to voice worklet
      this.voiceChannelMerger.connect(this.voiceNode);

      // Create channel splitter for voice worklet's 5 outputs
      this.voiceSplitter = this.audioContext.createChannelSplitter(5);
      this.voiceNode.connect(this.voiceSplitter);

      // Route channel 0 (main audio) to mixer for sound output
      this.voiceSplitter.connect(this.mixer, 0);

      // Create gain nodes to mix formants with white noise for oscilloscope
      this.oscilloscopeLeftGain = this.audioContext.createGain();
      this.oscilloscopeRightGain = this.audioContext.createGain();

      // Route F1 and F2 to the oscilloscope gain nodes
      this.voiceSplitter.connect(this.oscilloscopeLeftGain, 2); // F1 -> X axis mixer
      this.voiceSplitter.connect(this.oscilloscopeRightGain, 3); // F2 -> Y axis mixer

      // Create stereo merger for oscilloscope (F1/F2 + white noise visualization)
      this.oscilloscopeMerger = this.audioContext.createChannelMerger(2);

      // Connect mixed signals to oscilloscope merger
      this.oscilloscopeLeftGain.connect(this.oscilloscopeMerger, 0, 0); // Mixed X axis
      this.oscilloscopeRightGain.connect(this.oscilloscopeMerger, 0, 1); // Mixed Y axis

      // Audio path: white noise for sound output
      this.whiteNoiseAudio.connect(this.whiteNoiseAudioGain);
      this.whiteNoiseAudioGain.connect(this.mixer);

      // Visualization path: independent white noise for stable XY traces
      this.whiteNoiseVizGain = this.audioContext.createGain(); // Tracks audio noise level
      this.whiteNoiseVizGain.gain.value = 0; // Default to match audio gain
      this.whiteNoiseVizSplitter = this.audioContext.createChannelSplitter(2);
      this.whiteNoiseViz.connect(this.whiteNoiseVizGain);
      this.whiteNoiseVizGain.connect(this.whiteNoiseVizSplitter);

      // Route viz noise left to X axis, right to Y axis (with fixed small gain)
      this.whiteNoiseVizSplitter.connect(this.oscilloscopeLeftGain, 0); // WN Left -> X axis
      this.whiteNoiseVizSplitter.connect(this.oscilloscopeRightGain, 1); // WN Right -> Y axis

      // Connect mixer to master gain
      this.mixer.connect(this.masterGain);

      // Apply any stored state that was received before audio was ready
      this.applyStoredState();
    } catch (error) {
      console.error("❌ Failed to initialize formant synthesis:", error);
      throw error;
    }
  }

  applyStoredState() {
    console.log("🔄 Applying stored state after audio initialization");

    // Prefer applying the most recent PROGRAM_UPDATE (full state)
    if (this.lastProgramUpdate) {
      if (this.verbose) {
        console.log("🎼 Applying cached PROGRAM_UPDATE after init");
      }
      const cached = this.lastProgramUpdate;
      // Clear before applying in case apply triggers another cache
      this.lastProgramUpdate = null;
      this.handleProgramUpdate(cached);
    }

    // Apply synth parameters if they were received before audio was ready
    if (this.lastSynthParams) {
      if (this.verbose) console.log("🎵 Applying stored synth parameters");
      this.handleSynthParams(this.lastSynthParams);
    }

    // Ensure phasor/timing config reaches worklets now that they exist
    this.updatePhasorWorklet();
  }

  async connectToNetwork() {
    // Create star network
    this.star = new WebRTCStar(this.peerId, "synth");
    this.setupStarEventHandlers();

    // Connect to signaling server - use current host
    // Dynamic WebSocket URL that works in production and development
    const protocol = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
    const port = globalThis.location.port ? `:${globalThis.location.port}` : "";
    const signalingUrl =
      `${protocol}//${globalThis.location.hostname}${port}/ws`;
    await this.star.connect(signalingUrl);
  }

  setupStarEventHandlers() {
    this.star.addEventListener("peer-connected", (event) => {
      // Hide loading indicator and update status
      this.elements.loading.style.display = "none";
      this.updateConnectionStatus("connected", "Connected to network");
    });

    this.star.addEventListener("peer-removed", (event) => {
    });

    this.star.addEventListener("data-message", (event) => {
      const { peerId, channelType, message } = event.detail;
      this.handleDataMessage(peerId, channelType, message);
    });
  }

  handleDataMessage(peerId, channelType, message) {
    switch (message.type) {
      case MessageTypes.SYNTH_PARAMS:
        this.handleSynthParams(message);
        break;

      case MessageTypes.PROGRAM_UPDATE:
        this.handleProgramUpdate(message);
        break;

      case MessageTypes.DIRECT_PARAM_UPDATE:
        this.handleDirectParamUpdate(message);
        break;

      case MessageTypes.PHASOR_SYNC:
        this.handlePhasorSync(message);
        break;

      case MessageTypes.PROGRAM:
        this.handleProgramConfig(message);
        break;

      case MessageTypes.RESEED_RANDOMIZATION:
        if (this.programNode) {
          // Ask program worklet to re-resolve stochastic values at next EOC
          this.programNode.port.postMessage({ type: "RESEED_RANDOMIZATION" });
          console.log(
            "🔀 Received reseed request; forwarded to program worklet",
          );
        }
        break;

      case MessageTypes.SAVE_SCENE:
        this.handleSaveScene(message);
        break;

      case MessageTypes.LOAD_SCENE:
        this.handleLoadScene(message);
        break;

      default:
        break;
    }
  }

  handleDirectParamUpdate(message) {
    console.log(
      `🎛️ Direct parameter update: ${message.param} = ${message.value}`,
    );

    // Handle single direct parameter updates (e.g., from blur events)
    if (!this.isReadyToReceiveParameters()) {
      return;
    }

    this._updateParameterRouting(message.param, "direct");

    if (message.param === "whiteNoise") {
      // White noise controls both audio and visualization gain
      if (this.whiteNoiseAudioGain) {
        this.whiteNoiseAudioGain.gain.setTargetAtTime(
          message.value,
          this.audioContext.currentTime,
          0.015,
        );
      }
      if (this.whiteNoiseVizGain) {
        this.whiteNoiseVizGain.gain.setTargetAtTime(
          message.value,
          this.audioContext.currentTime,
          0.015,
        );
      }
      console.log(
        `🔌 Route for '${message.param}': Main Thread -> WhiteNoise Audio Gain`,
      );
    } else if (
      this.voiceNode && this.voiceNode.parameters.has(`${message.param}_in`)
    ) {
      const audioParam = this.voiceNode.parameters.get(`${message.param}_in`);
      audioParam.setTargetAtTime(
        message.value,
        this.audioContext.currentTime,
        0.015,
      );
      console.log(`🔌 Route for '${message.param}': Main Thread -> Voice`);
    }
  }

  isReadyToReceiveParameters() {
    if (!this.voiceNode || !this.programNode) {
      console.warn("⚠️ Cannot apply musical parameters: worklets not ready");
      return false;
    }

    return true;
  }

  handleSynthParams(message) {
    // Always store the latest parameters for application after audio init
    this.lastSynthParams = message;

    // Handle manual mode state changes
    const wasSynthesisActive = this.synthesisActive;
    this.synthesisActive = message.synthesisActive;

    // Update synthesis status display
    this.updateSynthesisStatus(this.synthesisActive);

    // If exiting manual mode, stop synthesis
    if (wasSynthesisActive && !this.synthesisActive) {
      if (this.voiceNode) {
        this.voiceNode.parameters.get("active").value = 0;
      }
      return;
    }

    // Check if we're ready to receive parameters
    if (!this.isReadyToReceiveParameters()) {
      return;
    }

    // If not in manual mode, don't apply parameters
    if (!this.synthesisActive) {
      return;
    }

    // Extract parameter values (handle both static values and envelope objects)
    const extractValue = (param) => {
      return (param && typeof param === "object" && param.static)
        ? param.value
        : param;
    };

    // Resume audio context if needed
    if (this.audioContext.state === "suspended") {
      this.audioContext.resume().then(() => {
      }).catch((err) => {
        console.error("❌ Failed to resume audio context:", err);
      });
    }

    // Legacy handleSynthParams - parameters now handled by PROGRAM_UPDATE
    if (this.verbose) {
      console.log(
        "⚠️ handleSynthParams is deprecated - use PROGRAM_UPDATE instead",
      );
    }
  }

  /**
   * OBSOLETE - Apply a parameter value that may be static or have envelope configuration
   * This method is deprecated in the two-worklet architecture
   */
  // applyParameterWithEnvelope(paramName, paramValue) {
  //   // Method removed - parameters now handled by direct routing or program worklet
  // }

  handleProgramUpdate(message) {
    if (this.verbose) console.log("📨 PROGRAM_UPDATE received:", message);
    // Keep last full program for scene snapshots
    this.lastProgramUpdate = message;
    if (!this.voiceNode || !this.programNode) {
      // Cache and apply after audio/worklets are initialized
      console.warn("⚠️ Worklets not ready; caching PROGRAM_UPDATE for later");
      return;
    }

    const program = message;
    const programmaticConfigs = {};

    // Handle synthesis active state
    if (message.synthesisActive !== undefined) {
      if (this.voiceNode && this.voiceNode.parameters.has("active")) {
        const activeParam = this.voiceNode.parameters.get("active");
        activeParam.value = message.synthesisActive ? 1 : 0;
        if (this.verbose) {
          console.log(
            `🎵 Synthesis ${message.synthesisActive ? "enabled" : "disabled"}`,
          );
        }
      }
    }

    for (const paramName in program) {
      // Skip non-parameter fields
      if (
        ["type", "timestamp", "synthesisActive", "isManualMode"].includes(
          paramName,
        )
      ) continue;

      const paramData = program[paramName];

      // Debug: Check if white noise is in the program update
      if (paramName === "whiteNoise") {
        if (this.verbose) {
          console.log(
            `🔍 WHITE NOISE found in program update: scope=${paramData.scope}, interpolation=${paramData.interpolation}`,
          );
        }
      }

      // Handle discriminated union format based on scope
      if (paramData.scope === "direct") {
        this._updateParameterRouting(paramName, "direct");

        if (paramName === "whiteNoise") {
          // White noise controls both audio and visualization gain
          if (this.whiteNoiseAudioGain) {
            this.whiteNoiseAudioGain.gain.setTargetAtTime(
              paramData.directValue,
              this.audioContext.currentTime,
              0.015,
            );
          }
          if (this.whiteNoiseVizGain) {
            this.whiteNoiseVizGain.gain.setTargetAtTime(
              paramData.directValue,
              this.audioContext.currentTime,
              0.015,
            );
          }
          console.log(
            `🎚️ Applied direct parameter: ${paramName} = ${paramData.directValue}`,
          );
        } else if (this.voiceNode.parameters.has(`${paramName}_in`)) {
          const audioParam = this.voiceNode.parameters.get(`${paramName}_in`);
          audioParam.setTargetAtTime(
            paramData.directValue,
            this.audioContext.currentTime,
            0.015,
          );
          console.log(
            `🎚️ Applied direct parameter: ${paramName} = ${paramData.directValue}`,
          );
        }
      } else if (paramData.scope === "program") {
        this._updateParameterRouting(paramName, "program");

        // Convert discriminated union to program worklet format
        if (paramData.interpolation === "step") {
          // Step interpolation - constant values between EOCs
          programmaticConfigs[paramName] = {
            interpolationType: "step",
            startValueGenerator: paramData.startValueGenerator,
          };
          if (this.verbose) {
            console.log(`🎯 Step interpolation for ${paramName}`);
          }
        } else {
          // Linear/cosine/parabolic interpolation - envelope behavior
          programmaticConfigs[paramName] = {
            interpolationType: paramData.interpolation,
            startValueGenerator: paramData.startValueGenerator,
            endValueGenerator: paramData.endValueGenerator,
            intensity: paramData.intensity,
          };
          if (paramName === "whiteNoise") {
            if (this.verbose) {
              console.log(
                `🎵 WHITE NOISE ${paramData.interpolation} interpolation for ${paramName}`,
              );
            }
          } else {
            if (this.verbose) {
              console.log(
                `📈 ${paramData.interpolation} interpolation for ${paramName}`,
              );
            }
          }
        }
      }
    }

    // Send programmatic configs to program worklet
    if (Object.keys(programmaticConfigs).length > 0) {
      this.programNode.port.postMessage({
        type: "SET_PROGRAM",
        config: programmaticConfigs,
        synthId: this.peerId,
      });
      if (this.verbose) {
        console.log(
          "✅ Forwarded programmatic configs to program worklet:",
          programmaticConfigs,
        );
      }
    }
  }

  // OBSOLETE - These methods were used by the old monolithic worklet
  // applyProgramUpdateFromWorklet(parameters) {
  //   // Method removed - worklet communication now handled differently
  // }

  // applyRandomizedParametersFromWorklet(parameters) {
  //   // Method removed - randomization now handled in program worklet
  // }

  handlePhasorSync(message) {
    this.receivedPhasor = message.phasor;
    this.receivedCpm = message.cpm;
    this.receivedStepsPerCycle = message.stepsPerCycle;
    this.receivedCycleLength = message.cycleLength;
    this.lastPhasorMessage = performance.now();

    // Calculate phasor rate
    this.phasorRate = 1.0 / this.receivedCycleLength;

    // Store official timing and start look-ahead scheduler if needed
    if (this.programNode) {
      console.log(`⏰ Received phasor sync: ${message.cpm} CPM`);

      // Check if timing has changed significantly
      const newTimingConfig = {
        cpm: message.cpm,
        stepsPerCycle: message.stepsPerCycle,
        cycleLength: message.cycleLength,
        phasor: message.phasor,
      };

      const timingChanged = !this.timingConfig ||
        this.timingConfig.cpm !== newTimingConfig.cpm ||
        this.timingConfig.cycleLength !== newTimingConfig.cycleLength;

      // Store the new timing config
      this.timingConfig = newTimingConfig;

      // Scheduler disabled - using phasor worklet cycle resets instead
      // console.log(`📡 Timing config updated, relying on phasor worklet cycle resets`);
    }

    // Update legacy phasor worklet (if still needed)
    this.updatePhasorWorklet();

    // Send phase correction to worklet (PLL behavior)
    this.sendPhaseCorrection();

    // Start interpolation if not already running (optional debug display)
    if (this.verbose && !this.phasorUpdateId) {
      this.startPhasorInterpolation();
    }
  }

  handleProgramConfig(message) {
    this.program = message.config;

    // Send config to program worklet for randomization handling
    if (this.programNode && this.program) {
      this.programNode.port.postMessage({
        type: "SET_PROGRAM",
        config: this.program,
        synthId: this.peerId,
      });
    }
  }

  startPhasorInterpolation() {
    const updateLoop = () => {
      this.updateInterpolatedPhasor();
      this.phasorUpdateId = requestAnimationFrame(updateLoop);
    };
    updateLoop();
  }

  updateInterpolatedPhasor() {
    const currentTime = performance.now();
    const timeSinceMessage = (currentTime - this.lastPhasorMessage) / 1000.0; // Convert to seconds

    // Interpolate phasor position
    this.interpolatedPhasor = this.receivedPhasor +
      (timeSinceMessage * this.phasorRate);

    // Wrap around at 1.0
    if (this.interpolatedPhasor >= 1.0) {
      this.interpolatedPhasor -= Math.floor(this.interpolatedPhasor);
    }

    // Update connection status display
    if (this.elements.connectionStatus && this.verbose) {
      this.elements.connectionStatus.textContent =
        `connected (${this.receivedBpm} bpm, ${this.receivedBeatsPerCycle}/cycle, φ=${
          this.interpolatedPhasor.toFixed(3)
        })`;
    }
  }

  stopPhasorInterpolation() {
    if (this.phasorUpdateId) {
      cancelAnimationFrame(this.phasorUpdateId);
      this.phasorUpdateId = null;
    }
  }

  initializePhasorWorklet() {
    try {
      // Create phasor AudioWorkletNode
      this.phasorWorklet = new AudioWorkletNode(
        this.audioContext,
        "phasor-processor",
        {
          outputChannelCount: [1],
        },
      );

      // Set initial cycle length
      this.phasorWorklet.parameters.get("cycleLength").value =
        this.receivedCycleLength;

      // Listen for phasor updates from the worklet
      this.phasorWorklet.port.onmessage = (event) => {
        if (event.data.type === "phasor-update") {
          this.workletPhasor = event.data.phase;

          // Forward phasor to program worklet for envelope calculations
          if (this.programNode) {
            this.programNode.port.postMessage({
              type: "PHASOR_UPDATE",
              phase: event.data.phase,
            });
          }

          // Calculate phase error for display (optional monitoring)
          const currentTime = performance.now();
          const timeSinceMessage = (currentTime - this.lastPhasorMessage) /
            1000.0;
          const expectedCtrlPhasor =
            (this.receivedPhasor + (timeSinceMessage * this.phasorRate)) % 1.0;
          const phaseError = this.calculatePhaseError(
            expectedCtrlPhasor,
            this.workletPhasor,
          );

          // Update display to show worklet phasor with error info
          if (this.elements.connectionStatus && this.verbose) {
            const errorDisplay = Math.abs(phaseError) > 0.001
              ? ` Δ${(phaseError * 1000).toFixed(0)}ms`
              : "";
            const rhythmDisplay = this.rhythmEnabled ? " 🥁" : "";
            this.elements.connectionStatus.textContent =
              `connected (${this.receivedBpm} bpm, ${this.receivedBeatsPerCycle}/cycle, ♪=${
                this.workletPhasor.toFixed(3)
              }${errorDisplay}${rhythmDisplay})`;
          }
        } else if (event.data.type === "cycle-reset") {
          // Phasor worklet has reset - trigger new program worklet ramp
          // console.log('🔄 Phasor reset detected');
          this.handleCycleReset(event.data);
        } else if (event.data.type === "step-trigger") {
          this.onStepTrigger(event.data.step, event.data.stepsPerCycle);
        }
      };

      // Start the worklet phasor
      this.phasorWorklet.port.postMessage({ type: "start" });

      if (this.verbose) console.log("✅ Phasor worklet initialized");
    } catch (error) {
      console.error("❌ Failed to initialize phasor worklet:", error);
    }
  }

  updatePhasorWorklet() {
    if (this.phasorWorklet) {
      // Update cycle length and steps per cycle in worklet
      const cl = Number.isFinite(this.receivedCycleLength)
        ? this.receivedCycleLength
        : 2.0;
      const spc = Number.isFinite(this.receivedStepsPerCycle)
        ? this.receivedStepsPerCycle
        : 16;
      this.phasorWorklet.parameters.get("cycleLength").value = cl;
      this.phasorWorklet.parameters.get("stepsPerCycle").value = spc;
    }

    // Also update program worklet with phasor timing
    if (this.programNode) {
      this.programNode.port.postMessage({
        type: "SET_PHASOR",
        cpm: Number.isFinite(this.receivedCpm) ? this.receivedCpm : 30,
        stepsPerCycle: Number.isFinite(this.receivedStepsPerCycle)
          ? this.receivedStepsPerCycle
          : 16,
        cycleLength: Number.isFinite(this.receivedCycleLength)
          ? this.receivedCycleLength
          : 2.0,
        phase: Number.isFinite(this.receivedPhasor) ? this.receivedPhasor : 0.0,
      });
    }
  }

  calculatePhaseError(targetPhase, currentPhase) {
    // Calculate phase error (accounting for wrap-around)
    let phaseError = targetPhase - currentPhase;

    // Handle wrap-around cases
    if (phaseError > 0.5) {
      phaseError -= 1.0; // Target is behind, we're ahead
    } else if (phaseError < -0.5) {
      phaseError += 1.0; // Target is ahead, we're behind
    }

    return phaseError;
  }

  _scheduler() {
    if (!this.timingConfig || !this.nextCycleTime) {
      return; // No timing config yet
    }

    const now = this.audioContext.currentTime;
    const timeUntilNextCycle = this.nextCycleTime - now;

    // If the next cycle is within our lookahead window, schedule it
    if (timeUntilNextCycle <= this.schedulerLookahead) {
      this._schedulePhaseRampAtTime(this.nextCycleTime);

      // Calculate the time for the cycle after that
      this.nextCycleTime += this.timingConfig.cycleLength;

      console.log(
        `⏰ Ramp PRE-SCHEDULED for ${this.nextCycleTime.toFixed(3)}s (${
          timeUntilNextCycle.toFixed(3)
        }s ahead)`,
      );
    }

    // Schedule the next scheduler check
    this.schedulerTimerId = setTimeout(
      () => this._scheduler(),
      this.schedulerInterval,
    );
  }

  _schedulePhaseRampAtTime(startTime) {
    if (!this.programNode || !this.timingConfig) return;

    const phaseParam = this.programNode.parameters.get("phase");
    const cycleDuration = this.timingConfig.cycleLength;
    const endTime = startTime + cycleDuration;

    // Schedule the ramp at the precise time
    phaseParam.setValueAtTime(0, startTime);
    phaseParam.linearRampToValueAtTime(1.0, endTime);

    // console.log(`🎯 Ramp SCHEDULED: ${startTime.toFixed(3)}s → ${endTime.toFixed(3)}s`);
  }

  _startScheduler() {
    // Stop any existing scheduler
    if (this.schedulerTimerId) {
      clearTimeout(this.schedulerTimerId);
    }

    // Calculate synchronized start time based on control's phase
    const now = this.audioContext.currentTime;
    let syncedStartTime;

    if (this.timingConfig && this.timingConfig.phasor !== undefined) {
      // Calculate how much time is left in the current cycle
      const currentPhase = this.timingConfig.phasor;
      const timeUntilNextCycle = (1.0 - currentPhase) *
        this.timingConfig.cycleLength;

      // Start the next cycle when control's cycle ends, or minimum 100ms ahead
      syncedStartTime = now + Math.max(timeUntilNextCycle, 0.1);
      // console.log(`🎯 Syncing to control phase ${currentPhase.toFixed(3)}, next cycle in ${timeUntilNextCycle.toFixed(3)}s`);
    } else {
      // Fallback to arbitrary start if no phase info
      syncedStartTime = now + 0.1;
      console.log(`⚠️ No phase info available, starting arbitrarily`);
    }

    this.nextCycleTime = syncedStartTime;
    this._scheduler();

    console.log(
      `🎬 Look-ahead scheduler started, first cycle at ${
        this.nextCycleTime.toFixed(3)
      }s`,
    );
  }

  _stopScheduler() {
    if (this.schedulerTimerId) {
      clearTimeout(this.schedulerTimerId);
      this.schedulerTimerId = null;
      console.log(`🛑 Look-ahead scheduler stopped`);
    }
  }

  handleCycleReset(resetData) {
    if (!this.programNode) return;

    // Calculate when the reset actually occurred
    const resetTime = this.audioContext.currentTime -
      ((resetData.blockSize - resetData.sampleIndex) /
        this.audioContext.sampleRate);

    // Schedule new phase ramp immediately
    const phaseParam = this.programNode.parameters.get("phase");
    const cycleLength = resetData.cycleLength;
    const rampEndTime = resetTime + cycleLength;

    if (this.verbose) {
      console.log(
        `🎯 Scheduling ramp: ${resetTime.toFixed(3)}s → ${
          rampEndTime.toFixed(3)
        }s`,
      );
    }

    // Cancel any existing automation and set phase to 0 at reset time
    phaseParam.cancelScheduledValues(resetTime);
    phaseParam.setValueAtTime(0, resetTime);
    phaseParam.linearRampToValueAtTime(1.0, rampEndTime);

    // If we have a pending scene snapshot, apply it exactly at cycle start
    if (this.pendingSceneState) {
      const snapshot = this.pendingSceneState;
      this.pendingSceneState = null;
      this.applyResolvedState(snapshot);
    }
  }

  sendPhaseCorrection() {
    if (!this.phasorWorklet || !this.pllEnabled) {
      return;
    }

    // Calculate what the ctrl's phasor should be right now
    const currentTime = performance.now();
    const timeSinceMessage = (currentTime - this.lastPhasorMessage) / 1000.0;
    const expectedCtrlPhasor =
      (this.receivedPhasor + (timeSinceMessage * this.phasorRate)) % 1.0;

    // Send phase correction to worklet
    this.phasorWorklet.port.postMessage({
      type: "phase-correction",
      targetPhase: expectedCtrlPhasor,
      correctionFactor: this.pllCorrectionFactor,
    });
  }

  onStepTrigger(stepNumber, stepsPerCycle) {
    if (!this.rhythmEnabled || !this.audioContext) {
      return;
    }

    // Generate a simple click sound for each step
    this.playClickSound(stepNumber, stepsPerCycle);
  }

  playClickSound(stepNumber, stepsPerCycle) {
    const now = this.audioContext.currentTime;

    // With CPM paradigm, we work directly with steps
    // High click at cycle start (step 0), low clicks on all other steps
    const isCycleStart = stepNumber === 0;

    // Play clicks on all steps

    // Create a simple click using oscillator + envelope
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();

    // High click for cycle start, low click for all other steps
    if (isCycleStart) {
      osc.frequency.value = 1200; // High click for cycle start
      osc.type = "sine";
    } else {
      osc.frequency.value = 600; // Lower click for all other steps
      osc.type = "triangle";
    }

    // Slightly different volumes
    const volume = isCycleStart ? this.clickVolume : this.clickVolume * 0.7;

    // Quick envelope for click sound
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    // Connect and play
    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + 0.05);
  }

  toggleRhythm() {
    this.rhythmEnabled = !this.rhythmEnabled;

    if (this.phasorWorklet) {
      // Update worklet rhythm settings
      this.phasorWorklet.parameters.get("enableRhythm").value =
        this.rhythmEnabled ? 1 : 0;
      this.phasorWorklet.parameters.get("stepsPerCycle").value =
        this.stepsPerCycle;
    }

    console.log(`Rhythm ${this.rhythmEnabled ? "enabled" : "disabled"}`);
  }

  initializeOscilloscope() {
    this.oscilloscope = new XYOscilloscope(
      this.elements.canvas,
      this.audioContext,
      this.oscilloscopeMerger, // Connect to F1/F2 stereo merger for Lissajous curves
    );

    // XYOscilloscope constructor connects F1/F2 merger to channel splitter for XY visualization
    this.oscilloscope.start();
  }

  updateVolume() {
    if (this.masterGain) {
      // Hardcoded volume at 0.1
      const gainValue = 0.1;
      this.masterGain.gain.setValueAtTime(
        gainValue,
        this.audioContext.currentTime,
      );
    }
  }

  setState(newState) {
    this.currentState = newState;

    switch (newState) {
      case "join":
        this.elements.joinState.style.display = "flex";
        this.elements.activeState.classList.remove("visible");
        break;

      case "connecting":
        this.elements.joinState.style.display = "none";
        this.elements.activeState.classList.add("visible");
        this.elements.loading.style.display = "block";
        this.updateConnectionStatus("syncing", "Connecting...");
        break;

      case "initializing-audio":
        this.elements.joinState.style.display = "none";
        this.elements.activeState.classList.add("visible");
        this.elements.loading.style.display = "block";
        // Don't change connection status - keep showing network connection status
        break;

      case "active":
        this.elements.loading.style.display = "none";
        break;
    }
  }

  updateConnectionStatus(status, message = "") {
    const element = this.elements.connectionStatus;

    element.classList.remove("connected", "syncing", "error");
    element.classList.add(status);

    const statusText = {
      "connected": message || "Connected",
      "syncing": message || "Syncing...",
      "error": message || "Error",
    }[status] || message;

    element.textContent = statusText;
  }

  updateSynthesisStatus(isActive) {
    const element = this.elements.synthesisStatus;
    if (!element) return;

    if (isActive) {
      element.classList.add("active");
      element.textContent = "synthesis on";
    } else {
      element.classList.remove("active");
      element.textContent = "synthesis off";
    }
  }

  updateSynthIdDisplay() {
    console.log(
      "🔍 Updating synth ID display, element:",
      this.elements.synthId,
    );
    if (this.elements.synthId) {
      // Extract just the last part of the peer ID for cleaner display
      const shortId = this.peerId.split("-").slice(-2).join("-");
      const rhythmIndicator = this.rhythmEnabled ? " 🎵" : "";
      this.elements.synthId.textContent = shortId + rhythmIndicator;
      console.log("✅ Synth ID updated to:", shortId + rhythmIndicator);

      // Apply CSS class for visual indication
      if (this.rhythmEnabled) {
        this.elements.synthId.classList.add("rhythm-active");
      } else {
        this.elements.synthId.classList.remove("rhythm-active");
      }
    } else {
      console.error("❌ Synth ID element not found in updateSynthIdDisplay");
    }
  }

  setupLongPress() {
    const synthIdElement = this.elements.synthId;
    console.log("🔍 Setting up long press, synthId element:", synthIdElement);
    console.log("🔍 All elements:", this.elements);

    if (!synthIdElement) {
      console.error("❌ Synth ID element not found for long press setup");
      // Try to find the element directly
      const directElement = document.getElementById("synth-id");
      console.log("🔍 Trying direct getElementById:", directElement);
      if (directElement) {
        this.elements.synthId = directElement;
        this.setupLongPressOnElement(directElement);
      }
      return;
    }

    this.setupLongPressOnElement(synthIdElement);
  }

  setupLongPressOnElement(synthIdElement) {
    console.log("✅ Setting up long press on element:", synthIdElement);

    let pressTimer = null;
    let isLongPress = false;

    const startPress = (e) => {
      console.log("👆 Press started on synth ID");
      e.preventDefault();
      isLongPress = false;
      synthIdElement.classList.add("pressing");

      pressTimer = setTimeout(() => {
        console.log("⏰ Long press triggered - toggling rhythm");
        isLongPress = true;
        this.toggleRhythm();
        this.updateSynthIdDisplay();

        // Haptic feedback if available
        if (navigator.vibrate) {
          navigator.vibrate(50);
        }
      }, 500); // 500ms long press threshold
    };

    const endPress = (e) => {
      console.log("👆 Press ended on synth ID");
      e.preventDefault();
      synthIdElement.classList.remove("pressing");

      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    const cancelPress = (e) => {
      console.log("❌ Press cancelled on synth ID");
      synthIdElement.classList.remove("pressing");
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    // Touch events
    synthIdElement.addEventListener("touchstart", startPress, {
      passive: false,
    });
    synthIdElement.addEventListener("touchend", endPress, { passive: false });
    synthIdElement.addEventListener("touchcancel", cancelPress, {
      passive: false,
    });
    synthIdElement.addEventListener("touchmove", cancelPress, {
      passive: false,
    });

    // Mouse events (for desktop testing)
    synthIdElement.addEventListener("mousedown", startPress);
    synthIdElement.addEventListener("mouseup", endPress);
    synthIdElement.addEventListener("mouseleave", cancelPress);

    console.log("✅ Long press event listeners attached");
  }

  async requestWakeLock() {
    // Check if Wake Lock API is supported
    if (!("wakeLock" in navigator)) {
      console.log("⚠️ Wake Lock API not supported");
      return;
    }

    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      console.log("✅ Screen wake lock acquired");

      // Handle wake lock release
      this.wakeLock.addEventListener("release", () => {
        console.log("🔓 Screen wake lock released");
      });

      // Handle visibility changes to re-acquire wake lock
      document.addEventListener(
        "visibilitychange",
        this.handleVisibilityChange.bind(this),
      );
    } catch (err) {
      console.error(`❌ Wake Lock failed: ${err.name}, ${err.message}`);
    }
  }

  async handleVisibilityChange() {
    if (this.wakeLock !== null && document.visibilityState === "visible") {
      try {
        this.wakeLock = await navigator.wakeLock.request("screen");
        console.log("✅ Screen wake lock re-acquired after visibility change");
      } catch (err) {
        console.error(
          `❌ Wake Lock re-acquisition failed: ${err.name}, ${err.message}`,
        );
      }
    }
  }

  releaseWakeLock() {
    if (this.wakeLock !== null) {
      this.wakeLock.release().then(() => {
        this.wakeLock = null;
        console.log("🔓 Screen wake lock manually released");
      });
    }
  }

  cleanup() {
    // Release wake lock
    this.releaseWakeLock();

    // Clean up WebRTC connections
    if (this.star) {
      this.star.cleanup();
    }

    // Stop audio worklets
    if (this.phasorWorklet) {
      this.phasorWorklet.disconnect();
    }

    if (this.voiceNode) {
      this.voiceNode.disconnect();
    }

    if (this.programNode) {
      this.programNode.disconnect();
    }

    console.log("🧹 Synth client cleaned up");
  }

  // Randomization utility methods
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  generateRandomValueInRange(min, max, key) {
    // Generate a deterministic but unique random value for this synth and parameter
    // Use a stable seed that doesn't change between parameter broadcasts
    const seed = this.randomSeed ^ this.hashString(key);
    const random = Math.abs(Math.sin(seed)) % 1;
    return min + (max - min) * random;
  }

  // Scene Memory Methods
  getStableSynthId() {
    let synthId = localStorage.getItem("synth_unique_id");
    if (!synthId) {
      synthId = `synth_${Date.now()}_${
        Math.random().toString(36).substring(2)
      }`;
      localStorage.setItem("synth_unique_id", synthId);
    }
    return synthId;
  }

  handleSaveScene(payload) {
    const { memoryLocation } = payload;
    console.log(
      `💾 Received command to save scene to location ${memoryLocation}`,
    );

    const key = `scene_${memoryLocation}_synth_${this.stableSynthId}`;
    const hasSnapshot = this.currentResolvedState &&
      Object.keys(this.currentResolvedState).length > 0;
    const snapshot = hasSnapshot
      ? this.currentResolvedState
      : (this.lastProgramUpdate
        ? this._resolveProgram(this.lastProgramUpdate)
        : {});
    this.currentResolvedState = snapshot;
    const stateToSave = JSON.stringify(snapshot);

    localStorage.setItem(key, stateToSave);
    console.log(`✅ Saved local state for scene ${memoryLocation}.`);
  }

  handleLoadScene(payload) {
    const { memoryLocation, program } = payload;
    console.log(
      `📂 Received command to load scene from location ${memoryLocation}`,
    );

    const key = `scene_${memoryLocation}_synth_${this.stableSynthId}`;
    const localData = localStorage.getItem(key);

    if (localData) {
      // This synth has a saved state for this scene. Load it.
      console.log("Found local state. Loading...");
      let resolvedState = {};
      try {
        resolvedState = JSON.parse(localData) || {};
      } catch {}
      if (!resolvedState || Object.keys(resolvedState).length === 0) {
        if (program) {
          console.log(
            "Saved snapshot empty; resolving from provided program...",
          );
          resolvedState = this._resolveProgram(program);
          localStorage.setItem(key, JSON.stringify(resolvedState));
        } else if (this.lastProgramUpdate) {
          console.log(
            "Saved snapshot empty; resolving from last PROGRAM_UPDATE...",
          );
          resolvedState = this._resolveProgram(this.lastProgramUpdate);
          localStorage.setItem(key, JSON.stringify(resolvedState));
        }
      }
      // Defer apply to next cycle reset to minimize glitches
      this.pendingSceneState = resolvedState;
      this.currentResolvedState = resolvedState;
    } else {
      // This is a new synth. Resolve the program, apply it, and save the result.
      console.log("No local state found. Resolving new state from program...");
      const newResolvedState = this._resolveProgram(program);
      this.pendingSceneState = newResolvedState;
      this.currentResolvedState = newResolvedState;

      // Immediately save this newly generated state for future loads.
      localStorage.setItem(key, JSON.stringify(newResolvedState));
      console.log(
        `✅ Resolved and saved new local state for scene ${memoryLocation}.`,
      );
    }
  }

  applyResolvedState(resolvedState) {
    // Apply resolved parameter values to the audio engine
    if (this.verbose) {
      console.log("🧩 Applying resolved scene state:", resolvedState);
    }
    for (const [paramName, value] of Object.entries(resolvedState)) {
      const v = Number.isFinite(value) ? value : 0;
      const wasProgram = this.lastProgramUpdate &&
        this.lastProgramUpdate[paramName] &&
        this.lastProgramUpdate[paramName].scope === "program";

      if (paramName === "whiteNoise") {
        if (this.whiteNoiseAudioGain) {
          if (wasProgram && this.programNode) {
            // Keep program routing and set immediate value via program worklet
            this._updateParameterRouting("whiteNoise", "program");
            this.programNode.port.postMessage({
              type: "SET_DIRECT_VALUE",
              param: "whiteNoise",
              value: v,
            });
          } else {
            // Route direct and set gain
            this._updateParameterRouting("whiteNoise", "direct");
            this.whiteNoiseAudioGain.gain.setTargetAtTime(
              v,
              this.audioContext.currentTime,
              0.015,
            );
            if (this.whiteNoiseVizGain) {
              this.whiteNoiseVizGain.gain.setTargetAtTime(
                v,
                this.audioContext.currentTime,
                0.015,
              );
            }
          }
          if (this.verbose) console.log(`🎚️ Scene apply: whiteNoise -> ${v}`);
        }
      } else if (this.voiceNode) {
        if (wasProgram && this.programNode) {
          // Keep program routing and push immediate value into program worklet
          this._updateParameterRouting(paramName, "program");
          this.programNode.port.postMessage({
            type: "SET_DIRECT_VALUE",
            param: paramName,
            value: v,
          });
        } else {
          // Route direct and set AudioParam via main thread
          this._updateParameterRouting(paramName, "direct");
          const paramKey = `${paramName}_in`;
          if (this.voiceNode.parameters.has(paramKey)) {
            const audioParam = this.voiceNode.parameters.get(paramKey);
            audioParam.setTargetAtTime(v, this.audioContext.currentTime, 0.015);
            if (this.verbose) {
              console.log(`🎚️ Scene apply: ${paramKey} -> ${v}`);
            }
          } else if (this.verbose) {
            console.warn(`⚠️ Scene apply: voice param missing '${paramKey}'`);
          }
        }
      }
    }

    // Ensure synthesis is active if desired
    if (this.voiceNode && this.voiceNode.parameters.has("active")) {
      const activeParam = this.voiceNode.parameters.get("active");
      activeParam.value = this.synthesisActive ? 1 : 0;
      if (this.verbose) {
        console.log(`🔈 Voice active = ${this.synthesisActive ? 1 : 0}`);
      }
    }
  }

  _resolveProgram(program) {
    // Resolve a program config to concrete parameter values
    const resolvedState = {};

    for (const [paramName, paramConfig] of Object.entries(program)) {
      if (paramConfig.scope === "direct") {
        // Direct value - use as-is
        resolvedState[paramName] = paramConfig.directValue;
      } else if (paramConfig.scope === "program") {
        // Program mode - resolve the generator to a concrete value
        if (paramConfig.interpolation === "step") {
          // For step interpolation, resolve the start generator
          resolvedState[paramName] = this._resolveGenerator(
            paramConfig.startValueGenerator,
            paramName,
          );
        } else {
          // For other interpolations, we need both start and end values
          // For now, just use the start value (the program worklet will handle envelopes)
          resolvedState[paramName] = this._resolveGenerator(
            paramConfig.startValueGenerator,
            paramName,
          );
        }
      }
    }

    return resolvedState;
  }

  _resolveGenerator(generator, paramName) {
    // Resolve a generator config to a concrete value
    // This is similar to the logic in program-worklet.js but for initial resolution
    if (!generator) return 0;

    switch (generator.type) {
      case "periodic": {
        const baseValue = generator.baseValue || 440;
        const numerators = this._parseSIN(generator.numerators || "1");
        const denominators = this._parseSIN(generator.denominators || "1");
        const numerator = numerators[0]; // Use first value for initial resolution
        const denominator = denominators[0] || 1;
        return baseValue * (numerator / denominator);
      }
      case "normalised": {
        if (typeof generator.range === "number") {
          return generator.range;
        } else if (generator.range && typeof generator.range === "object") {
          const range = generator.range.max - generator.range.min;
          return generator.range.min + (Math.random() * range);
        }
        return Math.random() * 0.5;
      }
      default: {
        return generator.value || 0;
      }
    }
  }

  _parseSIN(sinString) {
    // Simple parser for SIN (Simple Integer Notation) strings
    if (!sinString || typeof sinString !== "string") return [1];

    const results = [];
    const parts = sinString.split(",");

    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.includes("-")) {
        const [start, end] = trimmed.split("-").map((n) => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            results.push(i);
          }
        }
      } else {
        const num = parseInt(trimmed);
        if (!isNaN(num)) results.push(num);
      }
    }

    return results.length > 0 ? results : [1];
  }
}

/**
 * Simple XY Oscilloscope for visualizing formant outputs
 */

// Initialize the synth client
const synthClient = new SynthClient();

// Make it globally available for debugging
globalThis.synthClient = synthClient;
