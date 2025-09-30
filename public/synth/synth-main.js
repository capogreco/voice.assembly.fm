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
    this.voiceNode = null; // Voice worklet with envelope generation and DSP synthesis
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
    this._pendingSceneAtEoc = null; // new versioned scene staging

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

    // Envelope control state
    this.isPaused = false;
    this.pausedPhase = 0;

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
      phaseValue: document.getElementById("phase-value"),
      phaseBar: document.getElementById("phase-bar"),
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

    // Scene Memory: Simple in-memory snapshots (ephemeral)
    this.sceneSnapshots = []; // Array of 10 scene slots, lost on refresh
    this.currentResolvedState = {};
    this.pendingCaptureBank = null; // Bank to capture on next EOC

    // Musical brain state (main thread owns resolution)
    this.programConfig = {}; // Current program configuration from controller
    this.hrgState = {}; // HRG sequence state per parameter
    this.rbgState = {}; // RBG random value state per parameter (for static behavior)
    this.reresolveAtNextEOC = false; // Flag to re-randomize static HRG indices

    // Note: No persistent synth ID - using ephemeral session

    // Auto-connect to network on page load
    this.autoConnect();
  }

  /**
   * Core routing logic - the "switchboard operator"
   * Manages whether parameters come from main thread or program worklet
   */

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
      this.updateConnectionStatus("connected", "Connected");
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
      // Load voice worklet and white noise processor
      await this.audioContext.audioWorklet.addModule(
        "./worklets/voice-worklet.js",
      );
      await this.audioContext.audioWorklet.addModule(
        "./worklets/white-noise-processor.js",
      );

      // Create voice worklet with envelope generation and DSP synthesis
      this.voiceNode = new AudioWorkletNode(
        this.audioContext,
        "voice-worklet",
        {
          numberOfInputs: 0, // Phase input via AudioParam
          numberOfOutputs: 1,
          outputChannelCount: [5], // Main, duplicate, F1, F2, F3
        },
      );

      // Track current parameter values for portamento (strict - no defaults)
      this.lastResolvedValues = {};

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

      // Create white noise gain control (controlled by envelope from voice worklet)
      this.whiteNoiseAudioGain = this.audioContext.createGain();
      this.whiteNoiseAudioGain.gain.value = 0; // Default to silent

      // Create mixer for combining voice and white noise
      this.mixer = this.audioContext.createGain();

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

      // White noise envelope will be controlled via port messages to voice worklet
      // For now, synchronize with amplitude parameter (will be updated in Phase 2.4)

      // Route viz noise left to X axis, right to Y axis (with fixed small gain)
      this.whiteNoiseVizSplitter.connect(this.oscilloscopeLeftGain, 0); // WN Left -> X axis
      this.whiteNoiseVizSplitter.connect(this.oscilloscopeRightGain, 1); // WN Right -> Y axis

      // Connect mixer to master gain
      this.mixer.connect(this.masterGain);

      // Connect phasor worklet to voice worklet phase parameter
      if (this.phasorWorklet && this.voiceNode) {
        this.phasorWorklet.connect(
          this.voiceNode.parameters.get("phase"),
        );
        if (this.verbose) {
          console.log(
            "🔗 Phasor worklet connected to voice worklet phase parameter",
          );
        }
      }

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
    if (this.lastProgramUpdate) {
      if (this.verbose) console.log("🎵 Applying stored program update");
      this.handleProgramUpdate(this.lastProgramUpdate);
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
      case MessageTypes.PROGRAM_UPDATE:
        this.handleProgramUpdate(message);
        break;

      case MessageTypes.SUB_PARAM_UPDATE:
        this.handleSubParameterUpdate(message);
        break;

      case MessageTypes.UNIFIED_PARAM_UPDATE:
        this.handleUnifiedParamUpdate(message);
        break;

      case MessageTypes.PHASOR_SYNC:
        this.handlePhasorSync(message);
        break;

      case MessageTypes.PROGRAM:
        this.handleProgramConfig(message);
        break;

      case MessageTypes.RERESOLVE_AT_EOC:
        console.log(
          "🔀 RERESOLVE_AT_EOC received - will re-randomize static HRG indices at next EOC",
        );
        this.reresolveAtNextEOC = true;
        break;

      case MessageTypes.IMMEDIATE_REINITIALIZE:
        this.handleImmediateReinitialize();
        break;

      case MessageTypes.SAVE_SCENE:
        this.handleSaveScene(message);
        break;

      case MessageTypes.LOAD_SCENE:
        const snapshot = this.sceneSnapshots[message.memoryLocation];
        if (snapshot) {
          this.loadScene(snapshot);
        } else {
          console.warn(`⚠️ No scene in bank ${message.memoryLocation}`);
        }
        break;

      case MessageTypes.CLEAR_BANKS:
        this.clearAllBanks();
        break;

      case MessageTypes.CLEAR_SCENE:
        this.clearBank(message.memoryLocation);
        break;

      case MessageTypes.TRANSPORT:
        this.handleTransport(message);
        break;

      case MessageTypes.JUMP_TO_EOC:
        this.handleJumpToEOC(message);
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

    // Note: Routing changes are now handled by handleProgramUpdate staging
    // Direct value updates only - routing changes happen at EOC

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
    } else if (this.voiceNode) {
      // Route to voice worklet via SET_ENV message
      this.voiceNode.port.postMessage({
        type: "SET_ENV",
        v: 1,
        param: message.param,
        startValue: message.value,
        endValue: message.value,
        interpolation: "step",
        portamentoMs: 15  // Convert 0.015s to ms
      });
      console.log(`🔌 Route for '${message.param}': Main Thread -> Voice (SET_ENV)`);
    }
  }

  isReadyToReceiveParameters() {
    if (!this.voiceNode) {
      console.warn("⚠️ Cannot apply musical parameters: voice worklet not ready");
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

    // If synthesis was just enabled, ensure immediate audio output
    if (!wasSynthesisActive && this.synthesisActive) {
      this.activateImmediateSynthesis();
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

  /**
   * Activate synthesis immediately when enabled while paused
   * Ensures audio output starts right away regardless of transport state
   */
  activateImmediateSynthesis() {
    console.log("🎵 Activating immediate synthesis...");

    if (!this.programConfig || Object.keys(this.programConfig).length === 0) {
      console.error(
        "🚨 CRITICAL: Synth activated WITHOUT program config! Using emergency defaults.",
      );
      console.error(
        "🚨 This means controller→synth communication failed or synth activated too early",
      );
      throw new Error(
        "Synth activation without program config - this should never happen!",
      );
    }

    if (this.voiceNode) {
      console.log(
        "🎼 Resolving parameter values for immediate synthesis",
      );

      // Get current phase
      const phase = this.getCurrentPhase();

      // Resolve all parameters and send to voice worklet
      const resolvedParams = {};
      for (const [paramName, cfg] of Object.entries(this.programConfig)) {
        const resolved = this.resolveParameter(paramName, cfg, phase);
        resolvedParams[paramName] = {
          startValue: resolved.startValue,
          endValue: resolved.endValue,
          interpolation: cfg.interpolation,
          portamentoMs: 0, // Immediate, no portamento
        };
        
        // Update tracking
        this.lastResolvedValues[paramName] = cfg.interpolation === "step" 
          ? resolved.startValue 
          : resolved.endValue;
      }

      // Send batch envelope update to voice worklet  
      this.voiceNode.port.postMessage({
        type: "SET_ALL_ENV",
        v: 1,
        params: resolvedParams,
      });

      console.log(
        "🎯 [Immediate] SET_ALL_ENV message sent with resolved parameters:",
        this.lastResolvedValues,
      );
    } else {
      console.log("⚠️ No voice node available for immediate synthesis");
    }
  }

  /**
   * Apply program parameters with portamento when paused
   * Resolves parameter values at current phase and applies with smooth transitions
   */
  applyProgramWithPortamento(portamentoTime) {
    if (!this.programConfig || !this.voiceNode) {
      console.log("⚠️ No program config available for portamento application");
      return;
    }

    console.log(
      `🎵 Applying parameter changes with ${portamentoTime}ms portamento`,
    );

    // Get current phase
    const phase = this.getCurrentPhase();

    // Resolve all parameters and send to voice worklet
    const resolvedParams = {};
    for (const [paramName, cfg] of Object.entries(this.programConfig)) {
      const resolved = this.resolveParameter(paramName, cfg, phase);
      resolvedParams[paramName] = {
        startValue: resolved.startValue,
        endValue: resolved.endValue,
        interpolation: cfg.interpolation,
        portamentoMs: portamentoTime,
      };
      
      // Update tracking
      this.lastResolvedValues[paramName] = cfg.interpolation === "step" 
        ? resolved.startValue 
        : resolved.endValue;
    }

    // Send batch envelope update to voice worklet  
    this.voiceNode.port.postMessage({
      type: "SET_ALL_ENV",
      v: 1,
      params: resolvedParams,
    });

    console.log(
      `🎯 SET_ALL_ENV message sent with ${portamentoTime}ms portamento`,
    );
  }

  /**
   * Apply single parameter with portamento when paused
   * Applies smooth transition for individual parameter changes
   */
  applyWithPortamento(param, value, portamentoTime) {
    console.log(
      `🎵 Applying ${param} = ${value} with ${portamentoTime}ms portamento`,
    );

    if (!this.voiceNode) {
      console.log(
        "⚠️ No voice node available for portamento application",
      );
      return;
    }

    // For single parameter updates, we need to determine interpolation type
    const cfg = this.programConfig?.[param];
    if (!cfg) {
      console.warn(`⚠️ No config found for parameter ${param}`);
      return;
    }

    // Send SET_ENV message to voice worklet
    this.voiceNode.port.postMessage({
      type: "SET_ENV",
      v: 1,
      param: param,
      startValue: value,
      endValue: value, // For single value updates, start = end
      interpolation: cfg.interpolation || "step",
      portamentoMs: portamentoTime,
    });

    // Update tracked value
    this.lastResolvedValues = this.lastResolvedValues || {};
    this.lastResolvedValues[param] = value;
  }

  // _resolveParameterAtPhase method removed - using AudioParams directly

  handleProgramUpdate(message) {
    if (this.verbose) console.log("📨 PROGRAM_UPDATE received:", message);

    if (!this.voiceNode) {
      // Cache and apply after audio/worklets are initialized
      console.warn("⚠️ Worklets not ready; caching PROGRAM_UPDATE for later");
      this.lastProgramUpdate = message;
      return;
    }

    // Check if this update includes portamento time for paused parameter changes
    const hasPortamento = message.portamentoTime !== undefined;

    // Store program config in main thread (we are the musical brain now)
    this.programConfig = {};

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
      this.synthesisActive = !!message.synthesisActive; // ADD THIS
    }

    for (const paramName in message) {
      // Skip non-parameter fields
      if (
        [
          "type",
          "timestamp",
          "synthesisActive",
          "isManualMode",
          "portamentoTime",
        ].includes(
          paramName,
        )
      ) continue;

      const paramData = message[paramName];

      // Store parameter config
      this.programConfig[paramName] = paramData;

      // Error guard: reject messages with scope field
      if ("scope" in paramData) {
        console.error(
          `BREAKING: Parameter '${paramName}' contains forbidden 'scope' field. Ignoring message.`,
        );
        throw new Error(
          `Parameter '${paramName}' has scope field - this is forbidden`,
        );
      }

      // Handle unified format with interpolation + generators

      // Validate baseValue for periodic generators
      if (
        paramData.startValueGenerator?.type === "periodic" &&
        paramData.baseValue === undefined
      ) {
        console.error(
          `🚨 CRITICAL: Periodic generator for ${paramName} missing baseValue!`,
        );
        console.error(
          `🚨 This means controller sent incomplete parameter data`,
        );
        throw new Error(
          `Missing baseValue for periodic generator ${paramName} - controller bug?`,
        );
      }

      // Initialize HRG state for periodic generators
      this._initializeHRGState(paramName, paramData);

      if (this.verbose) {
        console.log(
          `🎼 ${paramData.interpolation} interpolation for ${paramName}`,
        );
      }
    }

    console.log(
      "✅ Program config stored in main thread, HRG states initialized",
    );

    // New paradigm: play vs pause governs application timing
    // - Playing: stage for EOC (handled in handleCycleReset)
    // - Paused: apply immediately with global portamento
    if (this.synthesisActive) {
      if (this.isPlaying) {
        console.log("📋 Staging program update for EOC (playing)");
        // Nothing to do now; handleCycleReset will push start/end AudioParams
      } else {
        const pt = message.portamentoTime ?? 0;
        console.log(
          `⚡ Applying program update now with ${pt}ms portamento (paused)`,
        );

        // Call activateImmediateSynthesis only when synthesis is being enabled for the first time
        if (message.synthesisActive && !this.synthesisActive) {
          this.activateImmediateSynthesis();
        }

        // Apply changed parameters with portamento (for all paused updates, regardless of synthesis state)
        for (const paramName in message) {
          if (
            [
              "type",
              "timestamp",
              "synthesisActive",
              "isManualMode",
              "portamentoTime",
            ].includes(paramName)
          ) {
            continue; // Skip meta fields
          }

          // Standard parameter update: update config first
          this.programConfig[paramName] = message[paramName];

          // Selectively refresh HRG state for changed positions only
          if (message[paramName].startValueGenerator?.type === "periodic") {
            this._reinitHRGPosition(paramName, "start");
          }
          if (
            message[paramName].endValueGenerator?.type === "periodic" &&
            this.programConfig[paramName].interpolation === "cosine"
          ) {
            this._reinitHRGPosition(paramName, "end");
          }

          // Apply single parameter with portamento
          this.applySingleParamWithPortamento(paramName, pt);
        }

        // Interpolation types are now sent per-parameter via SET_ENV messages
      }
    }
  }

  handleSubParameterUpdate(message) {
    if (!this.programConfig) {
      console.warn(
        "⚠️ Sub-parameter update received before program initialization",
      );
      return;
    }

    const { paramPath, value, portamentoTime } = message;
    const pathParts = paramPath.split(".");
    const paramName = pathParts[0];

    console.log(`🔧 Sub-parameter update: ${paramPath} = ${value}`);

    if (!this.programConfig[paramName]) {
      throw new Error(`CRITICAL: Unknown parameter ${paramName}`);
    }

    // Update the specific sub-parameter in config using utility function
    if (!this._setByPath(this.programConfig, paramPath, value)) {
      throw new Error(`CRITICAL: Failed to update path ${paramPath}`);
    }

    // Selective HRG updates to maintain independence between numerators and denominators
    if (paramPath.includes(".numerators")) {
      if (paramPath.includes(".startValueGenerator.")) {
        this._updateHRGNumerators(paramName, "start");
      } else if (paramPath.includes(".endValueGenerator.")) {
        this._updateHRGNumerators(paramName, "end");
      }
    } else if (paramPath.includes(".denominators")) {
      if (paramPath.includes(".startValueGenerator.")) {
        this._updateHRGDenominators(paramName, "start");
      } else if (paramPath.includes(".endValueGenerator.")) {
        this._updateHRGDenominators(paramName, "end");
      }
    } else if (paramPath.includes("numeratorBehavior")) {
      if (paramPath.includes(".startValueGenerator.")) {
        this._updateHRGNumeratorBehavior(paramName, "start");
      } else if (paramPath.includes(".endValueGenerator.")) {
        this._updateHRGNumeratorBehavior(paramName, "end");
      }
    } else if (paramPath.includes("denominatorBehavior")) {
      if (paramPath.includes(".startValueGenerator.")) {
        this._updateHRGDenominatorBehavior(paramName, "start");
      } else if (paramPath.includes(".endValueGenerator.")) {
        this._updateHRGDenominatorBehavior(paramName, "end");
      }
    }

    // Clear RBG state for behavior changes to allow random behavior to take effect
    if (paramPath.includes(".sequenceBehavior")) {
      const pathParts = paramPath.split(".");
      const paramName = pathParts[0];
      const generatorType = pathParts[1]; // 'startValueGenerator' or 'endValueGenerator'

      if (generatorType === "startValueGenerator") {
        const stateKey = `${paramName}_start`;
        delete this.rbgState[stateKey];
        console.log(
          `🎲 Cleared RBG state for ${stateKey} due to behavior change to ${value}`,
        );
      } else if (generatorType === "endValueGenerator") {
        const stateKey = `${paramName}_end`;
        delete this.rbgState[stateKey];
        console.log(
          `🎲 Cleared RBG state for ${stateKey} due to behavior change to ${value}`,
        );
      }
    }

    // Special handling for baseValue changes
    if (paramPath.endsWith(".baseValue")) {
      if (this.isPlaying) {
        console.log(
          `📋 Staging baseValue update for EOC: ${paramPath} = ${value}`,
        );
        // Store the change to be applied at next EOC
        // The config is already updated above, EOC will re-resolve with new base and current HRG indices
      } else {
        console.log(
          `⚡ Applying baseValue update immediately: ${paramPath} = ${value}`,
        );
        // Resolve just this parameter with new base, preserve HRG state, send SET_ENV with portamento
        this.applySingleParamWithPortamento(paramName, portamentoTime);
      }
      return;
    }

    // Apply immediately if paused, stage for EOC if playing
    if (this.isPlaying) {
      console.log(
        `📋 Staging sub-parameter update for EOC: ${paramPath} = ${value}`,
      );
      // Store the change to be applied at next EOC
      // The config is already updated above, so EOC will pick up the new values
    } else {
      console.log(
        `⚡ Applying sub-parameter update immediately: ${paramPath} = ${value}`,
      );
      this.applySingleParamWithPortamento(paramName, portamentoTime);
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
    this.receivedCpm = message.cpm; // Legacy, may be null
    this.receivedStepsPerCycle = message.stepsPerCycle;
    this.receivedCycleLength = message.cycleLength;
    this.receivedIsPlaying = message.isPlaying !== undefined
      ? message.isPlaying
      : true; // Default to true for backward compatibility
    this.lastPhasorMessage = performance.now();

    // Calculate phasor rate
    this.phasorRate = 1.0 / this.receivedCycleLength;

    // Update phasor worklet parameters
    if (this.phasorWorklet) {
      this.phasorWorklet.parameters.get("cycleLength").value =
        this.receivedCycleLength;
      this.phasorWorklet.parameters.get("stepsPerCycle").value =
        this.receivedStepsPerCycle;

      // Control phasor playback based on global playing state
      if (this.receivedIsPlaying) {
        this.phasorWorklet.port.postMessage({ type: "start" });
      } else {
        this.phasorWorklet.port.postMessage({ type: "stop" });
      }
    }

    // Update unified synth worklet with playing state for portamento behavior
    if (
      this.unifiedSynthNode && this.unifiedSynthNode.parameters.has("isPlaying")
    ) {
      this.unifiedSynthNode.parameters.get("isPlaying").value =
        this.receivedIsPlaying ? 1 : 0;
    }

    // Store official timing and start look-ahead scheduler if needed
    if (this.programNode) {
      const periodDisplay = message.cpm
        ? `${message.cpm} CPM`
        : `${this.receivedCycleLength}s period`;
      console.log(`⏰ Received phasor sync: ${periodDisplay}`);

      // Check if timing has changed significantly
      const newTimingConfig = {
        cpm: message.cpm,
        stepsPerCycle: message.stepsPerCycle,
        cycleLength: message.cycleLength,
        phasor: message.phasor,
      };

      const timingChanged = !this.timingConfig ||
        this.timingConfig.cycleLength !== newTimingConfig.cycleLength ||
        this.timingConfig.stepsPerCycle !== newTimingConfig.stepsPerCycle;

      // Store the new timing config
      this.timingConfig = newTimingConfig;

      // Scheduler disabled - using phasor worklet cycle resets instead
      // console.log(`📡 Timing config updated, relying on phasor worklet cycle resets`);
    }

    // Update legacy phasor worklet (if still needed)
    this.updatePhasorWorklet();

    // Send phase correction to worklet (PLL behavior)
    this.sendPhaseCorrection();

    // Start interpolation if not already running (for phase display)
    if (!this.phasorUpdateId) {
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

    // Update phase display
    this.updatePhaseDisplay();

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

          // Update phase display
          this.updatePhaseDisplay();

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
          console.log(
            `🔄 Cycle reset received: sample ${event.data.sampleIndex}/${event.data.blockSize}, cycle ${event.data.cycleLength}s`,
          );
          this.handleCycleReset(event.data);
        } else if (event.data.type === "step-trigger") {
          this.onStepTrigger(event.data.step, event.data.stepsPerCycle);
        }
      };

      // Connect phasor worklet output to unified synth worklet phase parameter
      if (this.unifiedSynthNode) {
        this.phasorWorklet.connect(
          this.unifiedSynthNode.parameters.get("phase"),
        );
        if (this.verbose) {
          console.log(
            "🔗 Phasor worklet connected to unified synth worklet phase parameter",
          );
        }
      }

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

  handleCycleReset(resetData) {
    if (!this.voiceNode) return;

    // Calculate sample-accurate reset time for boundary snapping
    const resetTime = this.audioContext.currentTime - 
      ((resetData.blockSize - resetData.sampleIndex) / this.audioContext.sampleRate);

    // Validate program config before EOC resolution
    if (!this.programConfig || Object.keys(this.programConfig).length === 0) {
      console.error("🚨 EOC RESET WITH EMPTY PROGRAM CONFIG!");
      console.error(
        "🚨 This means synth received EOC before controller sent parameters",
      );
      // Don't throw here, but log loudly - EOC can happen before controller connects
      return;
    }


    // Apply staged scene (takes precedence over re-resolve)
    if (this._pendingSceneAtEoc) {
      if (this.voiceNode) {
        this.voiceNode.port.postMessage({
          type: "SET_ALL_ENV",
          v: 1,
          params: this._pendingSceneAtEoc
        });
        console.log("🎬 Applied staged scene at EOC boundary");
      }
      this._pendingSceneAtEoc = null;
      // Skip re-resolve for this cycle
    }

    // Apply staged whiteNoise at EOC boundary if present
    if (this._pendingWhiteNoiseAtEoc && this.whiteNoiseAudioGain) {
      let v;
      if (this._pendingWhiteNoiseAtEoc.interpolation === "cosine") {
        // For cosine interpolation, at EOC boundary we apply the end value
        v = this._pendingWhiteNoiseAtEoc.endValue;
        console.log(`📋 Applied staged whiteNoise cosine endValue ${v} at EOC boundary`);
      } else {
        // For step interpolation, apply the start value
        v = this._pendingWhiteNoiseAtEoc.startValue;
        console.log(`📋 Applied staged whiteNoise step value ${v} at EOC boundary`);
      }
      
      // Snap at boundary using the backdated, sample-accurate time
      this.whiteNoiseAudioGain.gain.setValueAtTime(v, resetTime);
      if (this.whiteNoiseVizGain) {
        this.whiteNoiseVizGain.gain.setValueAtTime(v, resetTime);
      }
      
      this._pendingWhiteNoiseAtEoc = null;

      // Send ack to ctrl so it can clear the asterisk
      if (this.star) {
        this.star.broadcastToType("ctrl", { type: MessageTypes.PARAM_APPLIED, param: "whiteNoise" }, "control");
      }
    }

    if (this.reresolveAtNextEOC) {
      console.log("🔀 Re-initializing all stochastic generators at EOC");

      // Re-initialize HRG indices for all parameters
      for (const paramName in this.programConfig) {
        const paramConfig = this.programConfig[paramName];

        // Re-init start position if it uses HRG
        if (paramConfig.startValueGenerator?.type === "periodic") {
          this._reinitHRGPosition(paramName, "start");
        }

        // Re-init end position if it uses HRG with cosine interpolation
        if (
          paramConfig.endValueGenerator?.type === "periodic" &&
          paramConfig.interpolation === "cosine"
        ) {
          this._reinitHRGPosition(paramName, "end");
        }
      }

      // Clear all cached RBG values
      this.rbgState = {};
      if (this.verbose) {
        console.log("🎲 Cleared all RBG cached values for re-resolution");
      }

      // Clear flag before resolving to avoid double-application
      this.reresolveAtNextEOC = false;
    }

    // Apply any staged parameter updates before resolving values
    if (
      this.stagedParamUpdates && Object.keys(this.stagedParamUpdates).length > 0
    ) {
      console.log(
        `📋 Applying ${
          Object.keys(this.stagedParamUpdates).length
        } staged parameter updates at EOC`,
      );

      for (const [param, update] of Object.entries(this.stagedParamUpdates)) {
        console.log(
          `📋 Applying staged update: ${param} = ${update.startValue}${
            update.endValue !== undefined ? ` → ${update.endValue}` : ""
          } (${update.interpolation})`,
        );

        // The programConfig was already updated in handleUnifiedParamUpdate
        // Just log for confirmation that changes will take effect
      }

      // Clear staged updates after applying
      this.stagedParamUpdates = {};
    }

    // Regular EOC: always resolve and push ALL parameters to Voice (snap at boundary)
    const resolved = this._resolveProgram(this.programConfig);
    const payload = this._toEnvPayload(resolved, 0);
    
    // ALWAYS send batch envelope update to voice worklet
    this.voiceNode?.port.postMessage({
      type: "SET_ALL_ENV",
      v: 1,
      params: payload
    });

    // Apply whiteNoise in regular EOC batch (for base/range changes)
    const wn = resolved.whiteNoise;
    if (wn !== undefined && this.whiteNoiseAudioGain) {
      let raw;
      if (typeof wn === "object") {
        // For cosine interpolation, at EOC we want the end value
        if (wn.interpolation === "cosine" && wn.endValue !== undefined) {
          raw = wn.endValue;
          console.log(`[EOC] Applied whiteNoise cosine endValue ${raw} from regular batch`);
        } else {
          // For step interpolation or when endValue is undefined
          raw = wn.startValue;
          console.log(`[EOC] Applied whiteNoise startValue ${raw} from regular batch`);
        }
      } else {
        // Scalar value
        raw = wn;
        console.log(`[EOC] Applied whiteNoise scalar ${raw} from regular batch`);
      }
      
      this.whiteNoiseAudioGain.gain.setValueAtTime(raw, resetTime);
      if (this.whiteNoiseVizGain) {
        this.whiteNoiseVizGain.gain.setValueAtTime(raw, resetTime);
      }
    }

    console.log(`[EOC] Sent envelope updates to voice worklet:`, payload);
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

  updatePhaseDisplay() {
    // Prioritize worklet phasor for accuracy, fallback to interpolated
    const phaseToShow = this.workletPhasor !== undefined
      ? this.workletPhasor
      : this.interpolatedPhasor || 0;

    // Update phase value text with higher precision
    if (this.elements.phaseValue) {
      this.elements.phaseValue.textContent = `φ: ${phaseToShow.toFixed(4)}`;
    }

    // Update phase bar width with precise percentage
    if (this.elements.phaseBar) {
      const percentage = Math.max(0, Math.min(100, phaseToShow * 100)); // Clamp 0-100
      this.elements.phaseBar.style.width = `${percentage}%`;
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

  // Immediate Re-initialization Methods

  handleImmediateReinitialize() {
    console.log("⚡ Re-initializing all stochastic generators...");

    // Guard for config presence
    if (!this.programConfig || Object.keys(this.programConfig).length === 0) {
      console.warn("No program config available for re-initialization");
      return;
    }

    // Clear all cached RBG values
    this.rbgState = {};
    console.log("🎲 Cleared all RBG cached values");

    // Re-initialize HRG indices for all parameters
    for (const paramName in this.programConfig) {
      const paramConfig = this.programConfig[paramName];

      // Re-init start position if it uses HRG
      if (paramConfig.startValueGenerator?.type === "periodic") {
        this._reinitHRGPosition(paramName, "start");
      }

      // Re-init end position if it uses HRG with cosine interpolation
      if (
        paramConfig.endValueGenerator?.type === "periodic" &&
        paramConfig.interpolation === "cosine"
      ) {
        this._reinitHRGPosition(paramName, "end");
      }
    }

    // Guard for voice worklet presence
    if (!this.voiceNode) {
      const msg = "❌ Immediate reinitialize failed: voice worklet not ready";
      console.error(msg);
      if (this.log) this.log(msg, "error");
      return; // fail loudly
    }

    // Resolve fresh values using stochastic generators
    const resolvedParams = this._resolveProgram(this.programConfig);
    
    // Send new envelopes to voice worklet (instant portamento)
    this.voiceNode.port.postMessage({
      type: "SET_ALL_ENV",
      v: 1,
      params: resolvedParams,
    });

    // Reset phasor if playing (immediate audible change)
    if (this.isPlaying && this.phasorWorklet) {
      console.log("🔄 Resetting phasor for immediate audible change");
      this.phasorWorklet.port.postMessage({ type: "reset" });
    }

    console.log(`⚡ Sent immediate re-initialization to voice worklet: ${Object.keys(resolvedParams).length} parameters`);

    // Update status
    this.updateSynthesisStatus(
      "re-resolved",
      "Stochastic state re-initialized",
    );
  }

  // Scene Memory Methods

  handleSaveScene(payload) {
    // Save immediately regardless of play/pause state
    console.log(`💾 Capturing scene ${payload.memoryLocation} immediately`);
    this.sceneSnapshots[payload.memoryLocation] = this.buildSceneSnapshot();
  }

  captureScene(bank) {
    const snapshot = {};
    const sequences = {};

    // Capture minimal scene state based on parameter mode and generator type
    for (
      const param of [
        "frequency",
        "vowelX",
        "vowelY",
        "zingAmount",
        "zingMorph",
        "symmetry",
        "amplitude",
        "whiteNoise",
      ]
    ) {
      const paramConfig = this.programConfig[param];

      if (!paramConfig) {
        // No configuration available
        continue;
      }

      if (paramConfig.interpolation === "step") {
        // Program step mode - check generator type
        if (paramConfig.startValueGenerator?.type === "periodic") {
          // HRG - save sequence state (not values)
          const hrgState = this.hrgState[param]?.start;
          if (hrgState) {
            sequences[param] = {
              numeratorBehavior: hrgState.numeratorBehavior,
              denominatorBehavior: hrgState.denominatorBehavior,
              indexN: hrgState.indexN,
              indexD: hrgState.indexD,
              orderN: hrgState.orderN,
              orderD: hrgState.orderD,
            };
          }
        } else if (paramConfig.startValueGenerator?.type === "normalised") {
          // RBG - determine if stat or rand mode
          const generator = paramConfig.startValueGenerator;
          if (typeof generator.range === "number") {
            // Stat mode - save scalar value
            snapshot[param] = generator.range;
          }
          // Rand mode - save nothing, let it re-randomize
        }
      }
      // Skip cosine parameters - they regenerate from program
    }

    // Save to in-memory array (ephemeral)
    this.sceneSnapshots[bank] = { snapshot, sequences };

    console.log(
      `[SCENE] saved to memory slot ${bank}, sequences.frequency:`,
      sequences.frequency,
      `snapshot.frequency:`,
      snapshot.frequency,
    );
  }

  // Build complete scene snapshot with versioned schema
  buildSceneSnapshot() {
    const program = JSON.parse(JSON.stringify(this.programConfig || {}));
    
    // Strip any generator.baseValue (canonical: param-level only)
    for (const param in program) {
      if (program[param].startValueGenerator?.baseValue) {
        delete program[param].startValueGenerator.baseValue;
      }
      if (program[param].endValueGenerator?.baseValue) {
        delete program[param].endValueGenerator.baseValue;
      }
    }
    
    // Capture complete HRG state
    const hrg = {};
    for (const [param, state] of Object.entries(this.hrgState || {})) {
      hrg[param] = {};
      if (state.start) {
        hrg[param].start = {
          numeratorBehavior: state.start.numeratorBehavior,
          denominatorBehavior: state.start.denominatorBehavior,
          indexN: state.start.indexN,
          indexD: state.start.indexD,
          orderN: state.start.orderN || null,
          orderD: state.start.orderD || null
        };
      }
      if (state.end) {
        hrg[param].end = {
          numeratorBehavior: state.end.numeratorBehavior,
          denominatorBehavior: state.end.denominatorBehavior,
          indexN: state.end.indexN,
          indexD: state.end.indexD,
          orderN: state.end.orderN || null,
          orderD: state.end.orderD || null
        };
      }
    }
    
    // Capture RBG cache
    const rbg = { ...(this.rbgState || {}) };
    
    return {
      v: 1,  // Version for future compatibility
      program,
      stochastic: { hrg, rbg },
      meta: {
        synthId: this.peerId,
        sampleRate: this.audioContext?.sampleRate || 48000,
        synthesisActive: this.synthesisActive,
        isPlaying: this.isPlaying,
        createdAt: Date.now()
      }
    };
  }

  // Restore scene snapshot with bounds safety
  restoreSceneSnapshot(snapshot) {
    if (!snapshot || snapshot.v !== 1) {
      throw new Error("Unsupported scene snapshot version");
    }
    
    // 1) Restore program
    this.programConfig = JSON.parse(JSON.stringify(snapshot.program));
    
    // 2) Restore HRG with bounds clamping
    this.hrgState = {};
    for (const [param, positions] of Object.entries(snapshot.stochastic.hrg || {})) {
      if (!this.programConfig[param]) continue;
      
      this.hrgState[param] = {};
      
      // Restore start position
      if (positions.start) {
        const startGen = this.programConfig[param].startValueGenerator;
        const numerators = this._parseSIN(startGen?.numerators || "1");
        const denominators = this._parseSIN(startGen?.denominators || "1");
        
        this.hrgState[param].start = {
          numerators,
          denominators,
          numeratorBehavior: positions.start.numeratorBehavior,
          denominatorBehavior: positions.start.denominatorBehavior,
          // Clamp indices to array bounds
          indexN: Math.min(positions.start.indexN, numerators.length - 1),
          indexD: Math.min(positions.start.indexD, denominators.length - 1),
          orderN: positions.start.orderN || null,
          orderD: positions.start.orderD || null
        };
      }
      
      // Restore end position (for cosine)
      if (positions.end) {
        const endGen = this.programConfig[param].endValueGenerator;
        const numerators = this._parseSIN(endGen?.numerators || "1");
        const denominators = this._parseSIN(endGen?.denominators || "1");
        
        this.hrgState[param].end = {
          numerators,
          denominators,
          numeratorBehavior: positions.end.numeratorBehavior,
          denominatorBehavior: positions.end.denominatorBehavior,
          // Clamp indices to array bounds
          indexN: Math.min(positions.end.indexN, numerators.length - 1),
          indexD: Math.min(positions.end.indexD, denominators.length - 1),
          orderN: positions.end.orderN || null,
          orderD: positions.end.orderD || null
        };
      }
    }
    
    // 3) Restore RBG cache
    this.rbgState = { ...(snapshot.stochastic.rbg || {}) };
    
    console.log(`✅ Restored scene snapshot v${snapshot.v}: ${Object.keys(snapshot.program).length} params, HRG for [${Object.keys(snapshot.stochastic.hrg).join(',')}]`);
  }

  // Convert resolved parameters to worklet envelope payload
  _toEnvPayload(resolved, portamentoMs = 0) {
    const payload = {};
    
    for (const [param, config] of Object.entries(this.programConfig || {})) {
      if (!resolved.hasOwnProperty(param)) continue;
      
      if (config.interpolation === "step") {
        payload[param] = {
          interpolation: "step",
          startValue: resolved[param].startValue || resolved[param],
          endValue: resolved[param].startValue || resolved[param],
          portamentoMs: portamentoMs  // Always explicit
        };
      } else if (config.interpolation === "cosine") {
        payload[param] = {
          interpolation: "cosine",
          startValue: resolved[param].startValue,
          endValue: resolved[param].endValue,
          portamentoMs: portamentoMs  // Always explicit
        };
      }
    }
    
    return payload;
  }

  // Load scene with proper paused vs playing behavior
  loadScene(snapshot) {
    if (!snapshot) {
      console.warn("⚠️ No snapshot to load");
      return;
    }
    
    // Restore state
    this.restoreSceneSnapshot(snapshot);
    
    // Resolve targets from restored state
    const resolved = this._resolveProgram(this.programConfig);
    
    if (!this.voiceNode) {
      console.error("❌ Voice worklet not ready for scene load");
      return;
    }
    
    if (this.isPlaying) {
      // Playing: stage for EOC snap (no portamento)
      const payload = this._toEnvPayload(resolved, 0);
      this._pendingSceneAtEoc = payload;
      this.reresolveAtNextEOC = false;  // Explicitly not re-resolving
      console.log("📋 Scene staged for EOC boundary snap");
    } else {
      // Paused: glide with portamento
      const portMs = this.elements?.portamentoTime 
        ? parseInt(this.elements.portamentoTime.value, 10) 
        : 100;
      const payload = this._toEnvPayload(resolved, portMs);
      this.voiceNode.port.postMessage({
        type: "SET_ALL_ENV",
        v: 1,
        params: payload
      });
      console.log(`⚡ Scene loaded with ${portMs}ms portamento (paused)`);
    }
  }

  handleLoadScene(payload) {
    const { memoryLocation, program } = payload;

    // Check if we have a saved snapshot in memory first
    const saved = this.sceneSnapshots[memoryLocation];

    // Only update program config if we don't have saved state
    // (If we have saved state, we want to keep using the config that was active when we saved)
    if (!saved) {
      this.programConfig = {};
      for (const paramName in program) {
        if (
          !["type", "timestamp", "synthesisActive", "isManualMode"].includes(
            paramName,
          )
        ) {
          this.programConfig[paramName] = program[paramName];
        }
      }
    }

    if (saved) {
      const { snapshot, sequences } = saved;

      console.log(
        `[SCENE] load from memory slot ${memoryLocation}, snapshotKeys:`,
        Object.keys(snapshot),
        `hasHRG:`,
        Object.keys(sequences).length > 0,
      );

      // Initialize HRG state - but only for params without saved sequences
      for (const paramName in this.programConfig) {
        if (sequences[paramName]) {
          // Use saved sequence data to restore complete HRG state
          this._restoreHRGState(
            paramName,
            sequences[paramName],
            this.programConfig[paramName],
          );

          // Detailed frequency HRG state logging
          if (paramName === "frequency") {
            const hrgState = this.hrgState[paramName]?.start;
            console.log(
              `[LOAD_SCENE] frequency HRG state - behavior: ${hrgState.numeratorBehavior}/${hrgState.denominatorBehavior}, index: ${hrgState.indexN}/${hrgState.indexD}, arrays: [${
                hrgState.numerators?.slice(0, 3).join(",")
              }...] / [${hrgState.denominators?.slice(0, 3).join(",")}...]`,
            );
          }
        } else {
          // No saved sequence - initialize fresh with per-synth randomization
          this._initializeHRGState(paramName, this.programConfig[paramName]);
        }
      }

      // Handle scalar values - apply immediately if paused, stage if playing
      if (Object.keys(snapshot).length > 0) {
        if (this.isPlaying) {
          // Playing: stage for next EOC
          this.pendingSceneState = snapshot;
          console.log(`📋 Staged scene snapshot for next EOC:`, snapshot);
        } else {
          // Paused: apply immediately with portamento
          console.log(
            `⚡ Applying scene snapshot immediately (paused):`,
            snapshot,
          );
          for (const [param, value] of Object.entries(snapshot)) {
            // Use portamento for smooth transitions when paused
            const portamentoTime = 100; // Default portamento time
            this.applyWithPortamento(param, value, portamentoTime);
          }
        }
      }
    } else {
      console.log(
        `[SCENE] load, no data in memory slot ${memoryLocation} - initializing fresh`,
      );
      // No saved scene - initialize fresh HRG state with per-synth randomization
      for (const paramName in this.programConfig) {
        this._initializeHRGState(paramName, this.programConfig[paramName]);
      }
    }
  }

  clearAllBanks() {
    // Clear all in-memory scene snapshots
    const clearedCount = this.sceneSnapshots.filter((s) => s).length;
    this.sceneSnapshots = [];
    console.log(`🧹 Cleared ${clearedCount} synth scene bank(s) from memory`);
  }

  clearBank(bank) {
    // Clear specific in-memory scene snapshot
    if (this.sceneSnapshots[bank]) {
      delete this.sceneSnapshots[bank];
      console.log(`🧹 Cleared synth scene bank ${bank} from memory`);
    }
  }

  // Transport control methods
  handleTransport(message) {
    console.log(`🎮 Transport: ${message.action}`);
    if (!this.phasorWorklet || !this.voiceNode) return;

    switch (message.action) {
      case "play":
        this.isPlaying = true;
        this.phasorWorklet.port.postMessage({ type: "start" });

        if (this.isPaused) {
          // Resume from paused position
          console.log(`🎯 Resuming from paused phase: ${this.pausedPhase}`);
          this.isPaused = false;
        } else if (
          this.receivedPhasor === 0.0 || this.receivedPhasor === undefined
        ) {
          // Starting from beginning
          console.log(
            "🎯 Starting from phase 0.0 - triggering immediate cycle reset",
          );
          this.triggerImmediateCycleReset();
        }
        break;

      case "pause":
        this.isPlaying = false;
        this.phasorWorklet.port.postMessage({ type: "stop" });
        // No need for separate envelope pausing - voice worklet handles it
        break;

      case "stop":
        this.isPlaying = false;
        this.phasorWorklet.port.postMessage({ type: "stop" });
        this.phasorWorklet.port.postMessage({ type: "reset" });
        // No need for separate envelope stopping - voice worklet handles it
        break;
    }
  }

  handleJumpToEOC(message) {
    console.log("🎮 Jump to EOC / Reset");
    if (this.phasorWorklet) {
      this.phasorWorklet.port.postMessage({ type: "reset" });
    }

    // Immediately trigger cycle reset to start envelopes
    this.triggerImmediateCycleReset();
  }

  triggerImmediateCycleReset() {
    if (!this.programNode) return;

    console.log("🔄 Triggering immediate cycle reset for envelope restart");

    // Create synthetic reset data
    const resetData = {
      cycleLength: this.receivedCycleLength || 2.0,
      sampleIndex: 0,
      blockSize: 128,
    };

    // Call handleCycleReset to start envelopes immediately
    this.handleCycleReset(resetData);
  }

  handleUnifiedParamUpdate(message) {
    const statusIcon = message.isPlaying ? "📋*" : "⚡";
    console.log(
      `${statusIcon} Unified param update: ${message.param} = ${message.startValue}${
        message.endValue !== undefined ? ` → ${message.endValue}` : ""
      }`,
    );

    if (message.isPlaying) {
      // Special handling for whiteNoise - it's controlled via gain nodes, not the worklet
      if (message.param === "whiteNoise") {
        console.log(`📋 Staging whiteNoise for EOC (gain nodes)`);
        this._pendingWhiteNoiseAtEoc = { 
          startValue: message.startValue,
          endValue: message.endValue,
          interpolation: message.interpolation,
          portamentoMs: 0 
        };

        // Update programConfig for whiteNoise just like other parameters
        if (this.programConfig && this.programConfig[message.param]) {
          console.log(`📋 Updating programConfig.whiteNoise for EOC`);
          
          // Update interpolation type
          this.programConfig[message.param].interpolation = message.interpolation;
          
          const existingConfig = this.programConfig[message.param];
          
          if (message.interpolation === "step") {
            // Step interpolation - update start generator
            if (existingConfig.startValueGenerator) {
              const startGen = { ...existingConfig.startValueGenerator };
              if (typeof startGen.range === "object" && startGen.range.min !== undefined) {
                console.log(`📋 Preserving range ${JSON.stringify(startGen.range)} for whiteNoise step interpolation`);
              } else {
                startGen.range = message.startValue;
              }
              this.programConfig[message.param].startValueGenerator = startGen;
            }
            // Clear end generator for step interpolation
            delete this.programConfig[message.param].endValueGenerator;
          } else if (message.interpolation === "cosine") {
            // Cosine interpolation - preserve both generators
            if (existingConfig.startValueGenerator) {
              const startGen = { ...existingConfig.startValueGenerator };
              if (typeof startGen.range === "object" && startGen.range.min !== undefined) {
                console.log(`📋 Preserving start range ${JSON.stringify(startGen.range)} for whiteNoise cosine interpolation`);
              } else {
                startGen.range = message.startValue;
              }
              this.programConfig[message.param].startValueGenerator = startGen;
            }
            
            // Ensure end generator exists for cosine interpolation
            if (existingConfig.endValueGenerator) {
              const endGen = { ...existingConfig.endValueGenerator };
              if (typeof endGen.range === "object" && endGen.range.min !== undefined) {
                console.log(`📋 Preserving end range ${JSON.stringify(endGen.range)} for whiteNoise cosine interpolation`);
              } else {
                endGen.range = message.endValue;
              }
              this.programConfig[message.param].endValueGenerator = endGen;
            } else {
              // Create end generator based on start generator if missing
              console.log(`📋 Creating missing end generator for whiteNoise cosine interpolation`);
              this.programConfig[message.param].endValueGenerator = {
                type: "normalised",
                range: message.endValue,
                sequenceBehavior: existingConfig.startValueGenerator?.sequenceBehavior || "static",
              };
            }
          }
        }
        
        return; // Don't send to Voice worklet; noise is handled locally
      }

      // Playing: Stage for EOC application
      console.log(`📋 Staging ${message.param} for EOC`);
      this.stagedParamUpdates = this.stagedParamUpdates || {};
      this.stagedParamUpdates[message.param] = {
        startValue: message.startValue,
        endValue: message.endValue,
        interpolation: message.interpolation,
        portamentoTime: message.portamentoTime,
      };

      // Also update programConfig so EOC resolution uses the new values
      if (this.programConfig && this.programConfig[message.param]) {
        console.log(`📋 Updating programConfig.${message.param} for EOC`);

        // Update interpolation type
        this.programConfig[message.param].interpolation = message.interpolation;

        // Preserve existing generator configuration, only update what's needed
        const existingConfig = this.programConfig[message.param];

        if (message.interpolation === "step") {
          // Step interpolation - preserve existing start generator config
          if (existingConfig.startValueGenerator) {
            // Keep existing generator but update for single value if it was resolved from a range
            const startGen = { ...existingConfig.startValueGenerator };
            // If the generator has a range but we got a single resolved value, it means
            // this was an interpolation change, not a range change - keep the original range
            if (
              typeof startGen.range === "object" &&
              startGen.range.min !== undefined
            ) {
              // Keep the existing range object for proper RBG behavior
              console.log(
                `📋 Preserving range ${
                  JSON.stringify(startGen.range)
                } for ${message.param} step interpolation`,
              );
            } else {
              // Update with resolved value if it was a single value anyway
              startGen.range = message.startValue;
            }
            this.programConfig[message.param].startValueGenerator = startGen;
          }
          // Clear end generator for step interpolation
          delete this.programConfig[message.param].endValueGenerator;
        } else if (message.interpolation === "cosine") {
          // Cosine interpolation - preserve both generators, create end generator if missing
          if (existingConfig.startValueGenerator) {
            const startGen = { ...existingConfig.startValueGenerator };
            if (
              typeof startGen.range === "object" &&
              startGen.range.min !== undefined
            ) {
              console.log(
                `📋 Preserving start range ${
                  JSON.stringify(startGen.range)
                } for ${message.param} cosine interpolation`,
              );
            } else {
              startGen.range = message.startValue;
            }
            this.programConfig[message.param].startValueGenerator = startGen;
          }

          // Ensure end generator exists for cosine interpolation
          if (existingConfig.endValueGenerator) {
            const endGen = { ...existingConfig.endValueGenerator };
            if (
              typeof endGen.range === "object" && endGen.range.min !== undefined
            ) {
              console.log(
                `📋 Preserving end range ${
                  JSON.stringify(endGen.range)
                } for ${message.param} cosine interpolation`,
              );
            } else {
              endGen.range = message.endValue;
            }
            this.programConfig[message.param].endValueGenerator = endGen;
          } else {
            // Create end generator based on start generator if missing
            console.log(
              `📋 Creating missing end generator for ${message.param} cosine interpolation`,
            );
            this.programConfig[message.param].endValueGenerator = {
              type: "normalised",
              range: message.endValue,
              sequenceBehavior:
                existingConfig.startValueGenerator?.sequenceBehavior ||
                "static",
            };
          }
        }
      }
    } else {
      // Paused/stopped: Apply immediately with portamento via SET_ENV
      console.log(
        `⚡ Applying ${message.param} immediately with ${message.portamentoTime}ms portamento`,
      );
      
      if (this.voiceNode) {
        this.voiceNode.port.postMessage({
          type: "SET_ENV",
          v: 1,
          param: message.param,
          startValue: message.startValue,
          endValue: message.endValue,
          interpolation: message.interpolation,
          portamentoMs: message.portamentoTime || 0
        });
      }

      // Special handling for whiteNoise - it's controlled via gain nodes, not the worklet
      if (message.param === "whiteNoise") {
        const noiseValue = message.startValue; // whiteNoise is a step parameter
        const portamentoMs = message.portamentoTime || 0;
        // Convert portamento milliseconds to timeConstant (1/3 of desired duration in seconds)
        const timeConstant = portamentoMs > 0 ? portamentoMs / 3000 : 0.015; // fallback to 15ms
        
        if (this.whiteNoiseAudioGain) {
          this.whiteNoiseAudioGain.gain.setTargetAtTime(
            noiseValue,
            this.audioContext.currentTime,
            timeConstant
          );
        }
        if (this.whiteNoiseVizGain) {
          this.whiteNoiseVizGain.gain.setTargetAtTime(
            noiseValue,
            this.audioContext.currentTime,
            timeConstant
          );
        }
        console.log(`⚡ Applied whiteNoise ${noiseValue} directly to gain nodes with ${portamentoMs}ms portamento`);
      }

      // Update programConfig to persist the change across EOC
      if (this.programConfig && this.programConfig[message.param]) {
        const config = this.programConfig[message.param];
        
        // For normalised parameters, update generators with resolved scalars
        if (config.startValueGenerator?.type === "normalised") {
          // Step param: update start generator to scalar
          config.startValueGenerator.range = message.startValue;
          // Clear RBG cache
          delete this.rbgState[`${message.param}_start`];
        }
        
        // For cosine interpolation, update both generators
        if (message.interpolation === "cosine") {
          if (config.endValueGenerator?.type === "normalised") {
            config.endValueGenerator.range = message.endValue;
            delete this.rbgState[`${message.param}_end`];
          }
        }
        
        // For periodic params (HRG), prefer SUB_PARAM_UPDATE - don't overwrite generators
        // Unified updates for periodic are rare and should preserve HRG state
        
        console.log(`⚡ Updated programConfig.${message.param} to persist paused change`);
      }
    }
  }

  // REMOVED: applyParameterUpdate() - Legacy function from old unified worklet
  // All parameter updates now go through SET_ENV/SET_ALL_ENV messaging to voice worklet

  // Portamento is now handled entirely within the unified worklet

  pauseEnvelopes() {
    if (!this.programNode) return;

    console.log("⏸️ Pausing envelopes at current phase");

    const phaseParam = this.programNode.parameters.get("phase");
    const currentTime = this.audioContext.currentTime;

    // Store current phase value for resume
    this.pausedPhase = phaseParam.value;
    this.isPaused = true;

    // Cancel all scheduled automation and hold at current value
    phaseParam.cancelScheduledValues(currentTime);
    phaseParam.setValueAtTime(this.pausedPhase, currentTime);
  }

  stopEnvelopes() {
    if (!this.programNode) return;

    console.log("⏹️ Stopping envelopes and resetting to phase 0");

    const phaseParam = this.programNode.parameters.get("phase");
    const currentTime = this.audioContext.currentTime;

    // Reset state
    this.isPaused = false;
    this.pausedPhase = 0;

    // Cancel all scheduled automation and set to 0
    phaseParam.cancelScheduledValues(currentTime);
    phaseParam.setValueAtTime(0, currentTime);
  }

  applyResolvedState(resolvedState) {
    if (this.verbose) {
      console.log("🧩 Applying resolved scene state:", resolvedState);
    }

    // Build SET_ALL_ENV payload for voice parameters
    const voiceParams = {};
    
    for (const [paramName, value] of Object.entries(resolvedState)) {
      const v = Number.isFinite(value) ? value : 0;

      if (paramName === "whiteNoise") {
        // White noise is handled directly via gain nodes
        if (this.whiteNoiseAudioGain) {
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
          if (this.verbose) console.log(`🎚️ Scene apply: whiteNoise -> ${v}`);
        }
      } else {
        // All other parameters go to voice worklet via SET_ALL_ENV
        voiceParams[paramName] = {
          startValue: v,
          endValue: v,
          interpolation: "step",
          portamentoMs: 15  // Convert 0.015s to ms
        };
        if (this.verbose) {
          console.log(`🎚️ Scene apply: ${paramName} -> ${v} (via SET_ALL_ENV)`);
        }
      }
    }

    // Send all voice parameters in a single SET_ALL_ENV message
    if (this.voiceNode && Object.keys(voiceParams).length > 0) {
      this.voiceNode.port.postMessage({
        type: "SET_ALL_ENV",
        v: 1,
        params: voiceParams
      });
      if (this.verbose) {
        console.log("📦 SET_ALL_ENV sent for scene state with parameters:", Object.keys(voiceParams));
      }
    }

    // Handle synthesis active state separately via direct AudioParam
    if (this.voiceNode && this.synthesisActive !== undefined) {
      const activeValue = this.synthesisActive ? 1 : 0;
      this.voiceNode.parameters.get("active").value = activeValue;
      if (this.verbose) {
        console.log(`🔈 Voice active = ${activeValue} (via AudioParam)`);
      }
    }
  }

  applyResolvedStateValues(resolvedState) {
    if (this.verbose) {
      console.log("🧩 Applying resolved scene values:", resolvedState);
    }

    // Build SET_ALL_ENV payload for voice parameters
    const voiceParams = {};
    
    for (const [paramName, value] of Object.entries(resolvedState)) {
      const v = Number.isFinite(value) ? value : 0;

      if (paramName === "whiteNoise") {
        // White noise is handled directly via gain nodes
        if (this.whiteNoiseAudioGain) {
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
          if (this.verbose) console.log(`🎚️ Scene apply: whiteNoise -> ${v}`);
        }
      } else {
        // All other parameters go to voice worklet via SET_ALL_ENV
        voiceParams[paramName] = {
          startValue: v,
          endValue: v,
          interpolation: "step",
          portamentoMs: 15  // Convert 0.015s to ms
        };
        if (this.verbose) {
          console.log(`🎚️ Scene apply: ${paramName} -> ${v} (via SET_ALL_ENV)`);
        }
      }
    }

    // Send all voice parameters in a single SET_ALL_ENV message
    if (this.voiceNode && Object.keys(voiceParams).length > 0) {
      this.voiceNode.port.postMessage({
        type: "SET_ALL_ENV",
        v: 1,
        params: voiceParams
      });
      if (this.verbose) {
        console.log("📦 SET_ALL_ENV sent for resolved scene values with parameters:", Object.keys(voiceParams));
      }
    }

    // Handle synthesis active state separately via direct AudioParam
    if (this.voiceNode && this.synthesisActive !== undefined) {
      const activeValue = this.synthesisActive ? 1 : 0;
      this.voiceNode.parameters.get("active").value = activeValue;
    }
  }

  // Parse SIN (Simple Integer Notation) strings like "1,3,5" or "1-6"
  _parseSIN(sinString) {
    if (!sinString || typeof sinString !== "string") return [1];

    const results = [];
    const parts = sinString.split(",");

    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.includes("-")) {
        // Handle ranges like "1-6"
        const [start, end] = trimmed.split("-").map((n) => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            results.push(i);
          }
        }
      } else {
        // Handle single numbers
        const num = parseInt(trimmed);
        if (!isNaN(num)) results.push(num);
      }
    }

    return results.length > 0 ? results : [1];
  }

  // Initialize HRG state for a parameter
  _initializeHRGState(param, config) {
    const generator = config.startValueGenerator;
    if (!generator || generator.type !== "periodic") return;

    const numerators = this._parseSIN(generator.numerators || "1");
    const denominators = this._parseSIN(generator.denominators || "1");
    const numeratorBehavior = generator.numeratorBehavior || "static";
    const denominatorBehavior = generator.denominatorBehavior || "static";

    this.hrgState[param] = {
      start: {
        numerators,
        denominators,
        numeratorBehavior,
        denominatorBehavior,
        indexN: numeratorBehavior === "static"
          ? Math.floor(Math.random() * numerators.length)
          : 0,
        indexD: denominatorBehavior === "static"
          ? Math.floor(Math.random() * denominators.length)
          : 0,
        orderN: numeratorBehavior === "shuffle"
          ? this._shuffleArray([...numerators])
          : null,
        orderD: denominatorBehavior === "shuffle"
          ? this._shuffleArray([...denominators])
          : null,
      },
    };

    // Initialize end state if cosine interpolation
    if (
      config.interpolation === "cosine" &&
      config.endValueGenerator?.type === "periodic"
    ) {
      const endGen = config.endValueGenerator;
      const endNumerators = this._parseSIN(endGen.numerators || "1");
      const endDenominators = this._parseSIN(endGen.denominators || "1");
      const endNumBehavior = endGen.numeratorBehavior || "static";
      const endDenBehavior = endGen.denominatorBehavior || "static";

      this.hrgState[param].end = {
        numerators: endNumerators,
        denominators: endDenominators,
        numeratorBehavior: endNumBehavior,
        denominatorBehavior: endDenBehavior,
        indexN: endNumBehavior === "static"
          ? Math.floor(Math.random() * endNumerators.length)
          : 0,
        indexD: endDenBehavior === "static"
          ? Math.floor(Math.random() * endDenominators.length)
          : 0,
        orderN: endNumBehavior === "shuffle"
          ? this._shuffleArray([...endNumerators])
          : null,
        orderD: endDenBehavior === "shuffle"
          ? this._shuffleArray([...endDenominators])
          : null,
      };
    }
  }

  // Re-initialize only a specific HRG position (start or end) for selective updates
  _reinitHRGPosition(param, position) {
    const config = this.programConfig[param];
    if (!config) {
      throw new Error(`CRITICAL: Missing config for ${param}`);
    }

    const generator = position === "start"
      ? config.startValueGenerator
      : config.endValueGenerator;
    if (!generator || generator.type !== "periodic") return;

    const numerators = this._parseSIN(generator.numerators || "1");
    const denominators = this._parseSIN(generator.denominators || "1");
    const numeratorBehavior = generator.numeratorBehavior || "static";
    const denominatorBehavior = generator.denominatorBehavior || "static";

    // Ensure HRG state exists
    if (!this.hrgState[param]) {
      this.hrgState[param] = {};
    }

    // Re-randomize only this position
    this.hrgState[param][position] = {
      numerators,
      denominators,
      numeratorBehavior,
      denominatorBehavior,
      indexN: numeratorBehavior === "static"
        ? Math.floor(Math.random() * numerators.length)
        : 0,
      indexD: denominatorBehavior === "static"
        ? Math.floor(Math.random() * denominators.length)
        : 0,
      orderN: numeratorBehavior === "shuffle"
        ? this._shuffleArray([...numerators])
        : null,
      orderD: denominatorBehavior === "shuffle"
        ? this._shuffleArray([...denominators])
        : null,
    };

    console.log(
      `🔄 Re-initialized HRG ${position} for ${param}: N=${numeratorBehavior}[${
        this.hrgState[param][position].indexN
      }], D=${denominatorBehavior}[${this.hrgState[param][position].indexD}]`,
    );
  }

  // Update only HRG numerators for a specific parameter position
  _updateHRGNumerators(param, position) {
    const config = this.programConfig[param];
    if (!config) {
      throw new Error(`CRITICAL: Missing config for ${param}`);
    }

    const generator = position === "start"
      ? config.startValueGenerator
      : config.endValueGenerator;
    if (!generator || generator.type !== "periodic") return;

    // Ensure HRG state exists
    if (!this.hrgState[param]) {
      this.hrgState[param] = {};
    }
    if (!this.hrgState[param][position]) {
      // If no state exists, fall back to full initialization
      this._reinitHRGPosition(param, position);
      return;
    }

    const state = this.hrgState[param][position];
    const newNumerators = this._parseSIN(generator.numerators || "1");
    
    // Update numerators array and re-randomize ONLY numerator index
    state.numerators = newNumerators;
    if (state.numeratorBehavior === "static") {
      state.indexN = Math.floor(Math.random() * newNumerators.length);
    } else if (state.numeratorBehavior === "shuffle") {
      state.orderN = this._shuffleArray([...newNumerators]);
      state.indexN = 0; // Reset to start of new shuffle
    }
    // For ascending/descending, keep current indexN but it will wrap naturally

    console.log(
      `🔄 Updated HRG numerators for ${param}.${position}: new array [${newNumerators}], indexN=${state.indexN}`,
    );
  }

  // Update only HRG denominators for a specific parameter position
  _updateHRGDenominators(param, position) {
    const config = this.programConfig[param];
    if (!config) {
      throw new Error(`CRITICAL: Missing config for ${param}`);
    }

    const generator = position === "start"
      ? config.startValueGenerator
      : config.endValueGenerator;
    if (!generator || generator.type !== "periodic") return;

    // Ensure HRG state exists
    if (!this.hrgState[param]) {
      this.hrgState[param] = {};
    }
    if (!this.hrgState[param][position]) {
      // If no state exists, fall back to full initialization
      this._reinitHRGPosition(param, position);
      return;
    }

    const state = this.hrgState[param][position];
    const newDenominators = this._parseSIN(generator.denominators || "1");
    
    // Update denominators array and re-randomize ONLY denominator index
    state.denominators = newDenominators;
    if (state.denominatorBehavior === "static") {
      state.indexD = Math.floor(Math.random() * newDenominators.length);
    } else if (state.denominatorBehavior === "shuffle") {
      state.orderD = this._shuffleArray([...newDenominators]);
      state.indexD = 0; // Reset to start of new shuffle
    }
    // For ascending/descending, keep current indexD but it will wrap naturally

    console.log(
      `🔄 Updated HRG denominators for ${param}.${position}: new array [${newDenominators}], indexD=${state.indexD}`,
    );
  }

  // Update only numerator behavior for a specific parameter position
  _updateHRGNumeratorBehavior(param, position) {
    const config = this.programConfig[param];
    if (!config) {
      throw new Error(`CRITICAL: Missing config for ${param}`);
    }

    const generator = position === "start"
      ? config.startValueGenerator
      : config.endValueGenerator;
    if (!generator || generator.type !== "periodic") return;

    // Ensure HRG state exists
    if (!this.hrgState[param]?.[position]) {
      this._reinitHRGPosition(param, position);
      return;
    }

    const state = this.hrgState[param][position];
    const newBehavior = generator.numeratorBehavior || "static";
    
    // Update behavior and re-randomize ONLY numerator index
    state.numeratorBehavior = newBehavior;
    if (newBehavior === "static") {
      state.indexN = Math.floor(Math.random() * state.numerators.length);
      state.orderN = null;
    } else if (newBehavior === "shuffle") {
      state.orderN = this._shuffleArray([...state.numerators]);
      state.indexN = 0;
    } else {
      state.indexN = 0; // Reset for ascending/descending
      state.orderN = null;
    }

    console.log(
      `🔄 Updated HRG numerator behavior for ${param}.${position}: ${newBehavior}, indexN=${state.indexN}`,
    );
  }

  // Update only denominator behavior for a specific parameter position  
  _updateHRGDenominatorBehavior(param, position) {
    const config = this.programConfig[param];
    if (!config) {
      throw new Error(`CRITICAL: Missing config for ${param}`);
    }

    const generator = position === "start"
      ? config.startValueGenerator
      : config.endValueGenerator;
    if (!generator || generator.type !== "periodic") return;

    // Ensure HRG state exists
    if (!this.hrgState[param]?.[position]) {
      this._reinitHRGPosition(param, position);
      return;
    }

    const state = this.hrgState[param][position];
    const newBehavior = generator.denominatorBehavior || "static";
    
    // Update behavior and re-randomize ONLY denominator index
    state.denominatorBehavior = newBehavior;
    if (newBehavior === "static") {
      state.indexD = Math.floor(Math.random() * state.denominators.length);
      state.orderD = null;
    } else if (newBehavior === "shuffle") {
      state.orderD = this._shuffleArray([...state.denominators]);
      state.indexD = 0;
    } else {
      state.indexD = 0; // Reset for ascending/descending
      state.orderD = null;
    }

    console.log(
      `🔄 Updated HRG denominator behavior for ${param}.${position}: ${newBehavior}, indexD=${state.indexD}`,
    );
  }

  // Restore HRG state from saved sequence data (preserves per-synth uniqueness)
  _restoreHRGState(param, seqState, config) {
    const generator = config.startValueGenerator;
    if (!generator || generator.type !== "periodic") return;

    // Use saved behaviors if available, otherwise fall back to config
    const numeratorBehavior = seqState.numeratorBehavior ||
      generator.numeratorBehavior || "static";
    const denominatorBehavior = seqState.denominatorBehavior ||
      generator.denominatorBehavior || "static";

    // For shuffle behavior, the saved orderN/orderD ARE the arrays to use
    // For other behaviors, parse from config but use saved indices
    let numerators, denominators;

    if (numeratorBehavior === "shuffle" && seqState.orderN) {
      numerators = seqState.orderN; // Use saved shuffled array
    } else {
      numerators = this._parseSIN(generator.numerators || "1");
    }

    if (denominatorBehavior === "shuffle" && seqState.orderD) {
      denominators = seqState.orderD; // Use saved shuffled array
    } else {
      denominators = this._parseSIN(generator.denominators || "1");
    }

    this.hrgState[param] = {
      start: {
        numerators,
        denominators,
        numeratorBehavior,
        denominatorBehavior,
        indexN: seqState.indexN,
        indexD: seqState.indexD,
        orderN: seqState.orderN,
        orderD: seqState.orderD,
      },
    };

    // Initialize end state if cosine interpolation
    if (
      config.interpolation === "cosine" &&
      config.endValueGenerator?.type === "periodic"
    ) {
      const endGen = config.endValueGenerator;
      const endNumerators = this._parseSIN(endGen.numerators || "1");
      const endDenominators = this._parseSIN(endGen.denominators || "1");
      const endNumBehavior = endGen.numeratorBehavior || "static";
      const endDenBehavior = endGen.denominatorBehavior || "static";

      this.hrgState[param].end = {
        numerators: endNumerators,
        denominators: endDenominators,
        numeratorBehavior: endNumBehavior,
        denominatorBehavior: endDenBehavior,
        indexN: endNumBehavior === "static"
          ? Math.floor(Math.random() * endNumerators.length)
          : 0,
        indexD: endDenBehavior === "static"
          ? Math.floor(Math.random() * endDenominators.length)
          : 0,
        orderN: endNumBehavior === "shuffle"
          ? this._shuffleArray([...endNumerators])
          : null,
        orderD: endDenBehavior === "shuffle"
          ? this._shuffleArray([...endDenominators])
          : null,
      };
    }

    console.log(
      `🔄 Restored HRG state for ${param} using saved sequences - behavior: ${numeratorBehavior}/${denominatorBehavior}, index: ${seqState.indexN}/${seqState.indexD}`,
    );
  }

  // Shuffle array using Fisher-Yates algorithm
  _shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  // Helper method to resolve parameter values for AudioParams
  _resolveParameterValue(generator, paramName, position) {
    if (!generator) {
      console.error(`🚨 CRITICAL: No generator for ${paramName}/${position}!`);
      console.error(`🚨 This means program config is incomplete or malformed`);
      throw new Error(
        `Missing generator for ${paramName}/${position} - program config incomplete`,
      );
    }

    if (generator.type === "periodic") {
      // HRG - use sequence state
      return this._resolveHRG(paramName, position);
    } else if (generator.type === "normalised") {
      // RBG - resolve scalar
      return this._resolveRBG(generator, paramName, position);
    } else if (generator.value !== undefined) {
      // Direct value
      return generator.value;
    } else {
      console.error(
        `🚨 CRITICAL: Unknown generator type for ${paramName}/${position}!`,
      );
      console.error(`🚨 Generator:`, generator);
      throw new Error(
        `Unknown generator type for ${paramName}/${position} - unsupported generator format`,
      );
    }
  }

  // Get current phase - use received phasor value when available, otherwise 0
  getCurrentPhase() {
    // In the new architecture, phase comes from received phasor sync messages
    return this.receivedPhasor ?? 0;
  }

  // Resolve a single parameter to startValue and endValue
  resolveParameter(paramName, cfg, phase) {
    if (!cfg) {
      throw new Error(`CRITICAL: Missing config for ${paramName}`);
    }

    const result = {
      startValue: this._resolveParameterValue(cfg.startValueGenerator, paramName, "start"),
      endValue: cfg.interpolation === "step" 
        ? this._resolveParameterValue(cfg.startValueGenerator, paramName, "start")
        : this._resolveParameterValue(cfg.endValueGenerator, paramName, "end")
    };

    return result;
  }

  // Apply single parameter with portamento for paused mode
  applySingleParamWithPortamento(paramName, portamentoMs) {
    const phase = this.getCurrentPhase();
    const cfg = this.programConfig[paramName];
    if (!cfg) {
      throw new Error(`CRITICAL: Missing config for ${paramName}`);
    }

    // Resolve stochastic values at current phase
    const resolvedParam = this.resolveParameter(paramName, cfg, phase);
    
    console.log(
      `⚡ Sending SET_ENV for ${paramName}: start=${resolvedParam.startValue}, end=${resolvedParam.endValue}, portamento=${portamentoMs}ms`,
    );

    // Send SET_ENV message to voice worklet
    this.voiceNode.port.postMessage({
      type: "SET_ENV",
      v: 1,
      param: paramName,
      startValue: resolvedParam.startValue,
      endValue: resolvedParam.endValue,
      interpolation: cfg.interpolation,
      portamentoMs: portamentoMs,
    });

    // Update tracking for current values
    this.lastResolvedValues[paramName] = cfg.interpolation === "step" 
      ? resolvedParam.startValue 
      : resolvedParam.endValue;
  }

  // Apply base frequency change with ratio-preserving ramp
  applyBaseChangeWithPortamento(paramName, current, target, portamentoMs) {
    const startParam = this.unifiedSynthNode.parameters.get(
      `${paramName}_start`,
    );
    if (!startParam) {
      throw new Error(`CRITICAL: Missing AudioParam ${paramName}_start`);
    }

    if (!Number.isFinite(current) || !Number.isFinite(target)) {
      throw new Error(
        `CRITICAL: Invalid values for base change ${paramName}: current=${current}, target=${target}`,
      );
    }
    if (paramName === "frequency" && (current <= 0 || target <= 0)) {
      throw new Error(
        `CRITICAL: Invalid frequency for exponential ramp: current=${current}, target=${target}`,
      );
    }

    const now = this.audioContext.currentTime;
    const targetTime = now + portamentoMs / 1000;

    startParam.setValueAtTime(current, now);
    if (paramName === "frequency" && current > 0 && target > 0) {
      startParam.exponentialRampToValueAtTime(target, targetTime);
    } else {
      startParam.linearRampToValueAtTime(target, targetTime);
    }

    this.lastResolvedValues[paramName] = target;
  }

  // Pure parameter resolver at specific phase (no state mutation)
  resolveParameterAtPhase(paramName, config, phase) {
    if (!config) {
      throw new Error(
        `CRITICAL: resolveParameterAtPhase - missing config for ${paramName}`,
      );
    }

    if (config.interpolation === "step") {
      const gen = config.startValueGenerator;
      if (!gen) {
        throw new Error(
          `CRITICAL: Missing startValueGenerator for ${paramName}`,
        );
      }

      if (gen.type === "periodic") {
        return this.peekHRGValue(paramName, "start");
      } else if (gen.type === "normalised") {
        if (typeof gen.range === "number") {
          return gen.range;
        }
        if (gen.range?.min !== undefined && gen.range?.max !== undefined) {
          return gen.range.min +
            Math.random() * (gen.range.max - gen.range.min);
        }
        throw new Error(`CRITICAL: Missing range for normalised ${paramName}`);
      }
      throw new Error(
        `CRITICAL: Unknown generator type for ${paramName}: ${gen.type}`,
      );
    } else if (config.interpolation === "cosine") {
      const startGen = config.startValueGenerator;
      const endGen = config.endValueGenerator;
      if (!startGen) {
        throw new Error(
          `CRITICAL: Missing startValueGenerator for ${paramName}`,
        );
      }
      if (!endGen) {
        throw new Error(
          `CRITICAL: Missing endValueGenerator for cosine ${paramName}`,
        );
      }

      let start, end;

      // Resolve start value
      if (startGen.type === "periodic") {
        start = this.peekHRGValue(paramName, "start");
      } else if (startGen.type === "normalised") {
        if (typeof startGen.range === "number") {
          start = startGen.range;
        } else if (
          startGen.range?.min !== undefined && startGen.range?.max !== undefined
        ) {
          start = startGen.range.min +
            Math.random() * (startGen.range.max - startGen.range.min);
        } else {
          throw new Error(
            `CRITICAL: Missing range for normalised start ${paramName}`,
          );
        }
      } else {
        throw new Error(
          `CRITICAL: Unknown start generator type for ${paramName}: ${startGen.type}`,
        );
      }

      // Resolve end value
      if (endGen.type === "periodic") {
        end = this.peekHRGValue(paramName, "end");
      } else if (endGen.type === "normalised") {
        if (typeof endGen.range === "number") {
          end = endGen.range;
        } else if (
          endGen.range?.min !== undefined && endGen.range?.max !== undefined
        ) {
          end = endGen.range.min +
            Math.random() * (endGen.range.max - endGen.range.min);
        } else {
          throw new Error(
            `CRITICAL: Missing range for normalised end ${paramName}`,
          );
        }
      } else {
        throw new Error(
          `CRITICAL: Unknown end generator type for ${paramName}: ${endGen.type}`,
        );
      }

      const shapedProgress = 0.5 - Math.cos(phase * Math.PI) * 0.5;
      return start + (end - start) * shapedProgress;
    }
    throw new Error(
      `CRITICAL: Unknown interpolation for ${paramName}: ${config.interpolation}`,
    );
  }

  // Pure HRG resolver - does NOT advance sequence indices (for paused parameter resolution)
  peekHRGValue(paramName, position) {
    const cfg = this.programConfig[paramName];
    if (!cfg) {
      throw new Error(
        `CRITICAL: peekHRGValue - missing config for ${paramName}`,
      );
    }
    if (!Number.isFinite(cfg.baseValue)) {
      throw new Error(
        `CRITICAL: peekHRGValue - missing baseValue for ${paramName}`,
      );
    }

    const state = this.hrgState[paramName]?.[position];
    if (!state) {
      throw new Error(
        `CRITICAL: peekHRGValue - missing HRG state for ${paramName}/${position}`,
      );
    }

    // Get current values WITHOUT advancing indices
    const { numerators, denominators, numeratorBehavior, denominatorBehavior } =
      state;

    let numerator, denominator;

    // Get current numerator without advancing
    if (numeratorBehavior === "static") {
      numerator = numerators[state.indexN];
    } else if (numeratorBehavior === "ascending") {
      numerator = numerators[state.indexN % numerators.length];
    } else if (numeratorBehavior === "descending") {
      numerator =
        numerators[(numerators.length - 1 - state.indexN) % numerators.length];
    } else if (numeratorBehavior === "shuffle") {
      numerator = state.orderN[state.indexN % state.orderN.length];
    } else if (numeratorBehavior === "random") {
      numerator = numerators[Math.floor(Math.random() * numerators.length)];
    }

    // Get current denominator without advancing
    if (denominatorBehavior === "static") {
      denominator = denominators[state.indexD];
    } else if (denominatorBehavior === "ascending") {
      denominator = denominators[state.indexD % denominators.length];
    } else if (denominatorBehavior === "descending") {
      denominator = denominators[
        (denominators.length - 1 - state.indexD) % denominators.length
      ];
    } else if (denominatorBehavior === "shuffle") {
      denominator = state.orderD[state.indexD % state.orderD.length];
    } else if (denominatorBehavior === "random") {
      denominator =
        denominators[Math.floor(Math.random() * denominators.length)];
    }

    const base = Number(cfg.baseValue);
    return base * (numerator / (denominator || 1));
  }

  // Resolve HRG value and advance sequence
  _resolveHRG(param, position = "start") {
    const state = this.hrgState[param]?.[position];
    if (!state) {
      console.error(`🚨 CRITICAL: HRG state missing for ${param}/${position}!`);
      console.error(
        `🚨 This means HRG was not initialized - controller message missing or malformed`,
      );
      throw new Error(
        `HRG state not initialized for ${param}/${position} - controller message not received?`,
      );
    }

    const { numerators, denominators, numeratorBehavior, denominatorBehavior } =
      state;

    // Get current values
    let numerator, denominator;

    if (numeratorBehavior === "static") {
      numerator = numerators[state.indexN];
    } else if (numeratorBehavior === "ascending") {
      numerator = numerators[state.indexN % numerators.length];
      state.indexN++;
    } else if (numeratorBehavior === "descending") {
      numerator =
        numerators[(numerators.length - 1 - state.indexN) % numerators.length];
      state.indexN++;
    } else if (numeratorBehavior === "shuffle") {
      numerator = state.orderN[state.indexN % state.orderN.length];
      state.indexN++;
      if (state.indexN >= state.orderN.length) {
        state.orderN = this._shuffleArray([...numerators]);
        state.indexN = 0;
      }
    } else if (numeratorBehavior === "random") {
      numerator = numerators[Math.floor(Math.random() * numerators.length)];
    }

    if (denominatorBehavior === "static") {
      denominator = denominators[state.indexD];
    } else if (denominatorBehavior === "ascending") {
      denominator = denominators[state.indexD % denominators.length];
      state.indexD++;
    } else if (denominatorBehavior === "descending") {
      denominator = denominators[
        (denominators.length - 1 - state.indexD) % denominators.length
      ];
      state.indexD++;
    } else if (denominatorBehavior === "shuffle") {
      denominator = state.orderD[state.indexD % state.orderD.length];
      state.indexD++;
      if (state.indexD >= state.orderD.length) {
        state.orderD = this._shuffleArray([...denominators]);
        state.indexD = 0;
      }
    } else if (denominatorBehavior === "random") {
      denominator =
        denominators[Math.floor(Math.random() * denominators.length)];
    }

    const cfg = this.programConfig[param];
    if (!cfg) {
      throw new Error(
        `CRITICAL: HRG resolution for ${param} - missing program config`,
      );
    }
    if (!Number.isFinite(cfg.baseValue)) {
      throw new Error(
        `CRITICAL: HRG resolution for ${param} - missing baseValue`,
      );
    }

    const base = Number(cfg.baseValue);
    return base * (numerator / (denominator || 1));
  }

  // Resolve RBG value with behavior support
  _resolveRBG(generator, paramName = null, position = null) {
    let result;

    // Handle fixed values
    if (typeof generator.range === "number") {
      result = generator.range;
      // RBG resolved (fixed value)
      return result;
    }

    if (!generator.range || typeof generator.range !== "object") {
      throw new Error(
        `CRITICAL: RBG generator missing range - ${JSON.stringify(generator)}`,
      );
    }

    const behavior = generator.sequenceBehavior || "random"; // Default to randomize each EOC
    const stateKey = paramName && position ? `${paramName}_${position}` : null;

    if (behavior === "static" && stateKey) {
      // Static behavior: generate once and reuse
      if (!this.rbgState[stateKey]) {
        const range = generator.range.max - generator.range.min;
        this.rbgState[stateKey] = generator.range.min + (Math.random() * range);
        // RBG resolved (static, new)
      } else {
        // RBG resolved (static, cached)
      }
      result = this.rbgState[stateKey];
    } else {
      // Random behavior: generate new value each time
      const range = generator.range.max - generator.range.min;
      result = generator.range.min + (Math.random() * range);
      // RBG resolved (random)
    }

    return result;
  }

  // Apply direct value to parameter via unified messaging
  _setDirectValue(paramName, value) {
    if (paramName === "whiteNoise") {
      // White noise controls both audio and visualization gain
      if (this.whiteNoiseAudioGain) {
        this.whiteNoiseAudioGain.gain.setTargetAtTime(
          value,
          this.audioContext.currentTime,
          0.015,
        );
      }
      if (this.whiteNoiseVizGain) {
        this.whiteNoiseVizGain.gain.setTargetAtTime(
          value,
          this.audioContext.currentTime,
          0.015,
        );
      }
    } else if (this.voiceNode) {
      // Route to voice worklet via SET_ENV message
      this.voiceNode.port.postMessage({
        type: "SET_ENV",
        v: 1,
        param: paramName,
        startValue: value,
        endValue: value,
        interpolation: "step",
        portamentoMs: 15  // Convert 0.015s to ms
      });
    }

    if (this.verbose) {
      console.log(`🎚️ Applied direct parameter: ${paramName} = ${value} (unified messaging)`);
    }
  }

  _resolveProgram(program) {
    // Resolve a program config to envelope configurations for SET_ALL_ENV
    const resolvedParams = {};

    for (const [paramName, config] of Object.entries(program)) {
      if (config.interpolation === "step") {
        // Step interpolation - resolve single value
        let stepValue;

        if (config.startValueGenerator?.type === "periodic") {
          stepValue = this._resolveHRG(paramName, "start");
        } else if (config.startValueGenerator?.type === "normalised") {
          stepValue = this._resolveRBG(
            config.startValueGenerator,
            paramName,
            "start",
          );
        } else {
          throw new Error(
            `CRITICAL: Unknown start generator type for ${paramName}: ${config.startValueGenerator?.type}`,
          );
        }

        if (stepValue !== undefined && Number.isFinite(stepValue)) {
          resolvedParams[paramName] = {
            interpolation: "step",
            startValue: stepValue,
            endValue: stepValue,
            portamentoMs: 0 // Instant for re-resolve
          };
        }
      } else if (config.interpolation === "cosine") {
        // Cosine interpolation - resolve start and end values
        let startValue, endValue;

        if (config.startValueGenerator?.type === "periodic") {
          startValue = this._resolveHRG(paramName, "start");
        } else if (config.startValueGenerator?.type === "normalised") {
          startValue = this._resolveRBG(
            config.startValueGenerator,
            paramName,
            "start",
          );
        } else {
          throw new Error(
            `CRITICAL: Unknown start generator type for ${paramName}: ${config.startValueGenerator?.type}`,
          );
        }

        if (config.endValueGenerator?.type === "periodic") {
          endValue = this._resolveHRG(paramName, "end");
        } else if (config.endValueGenerator?.type === "normalised") {
          endValue = this._resolveRBG(config.endValueGenerator, paramName, "end");
        } else {
          throw new Error(
            `CRITICAL: Unknown end generator type for ${paramName}: ${config.endValueGenerator?.type}`,
          );
        }

        if (Number.isFinite(startValue) && Number.isFinite(endValue)) {
          resolvedParams[paramName] = {
            interpolation: "cosine",
            startValue: startValue,
            endValue: endValue,
            portamentoMs: 0 // Instant for re-resolve
          };
        }
      }
    }

    return resolvedParams;
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

  // Utility functions for path-based config updates

  /**
   * Get a value from an object using dot notation path
   * @param {Object} obj - The object to get value from
   * @param {string} path - Dot notation path (e.g., "frequency.startValueGenerator.numerators")
   * @returns {*} The value at the path, or undefined if not found
   */
  _getByPath(obj, path) {
    const pathParts = path.split(".");
    let target = obj;

    for (const part of pathParts) {
      if (
        target === null || target === undefined || !target.hasOwnProperty(part)
      ) {
        return undefined;
      }
      target = target[part];
    }

    return target;
  }

  /**
   * Set a value in an object using dot notation path
   * @param {Object} obj - The object to set value in
   * @param {string} path - Dot notation path (e.g., "frequency.startValueGenerator.numerators")
   * @param {*} value - The value to set
   * @returns {boolean} True if successfully set, false if path is invalid
   */
  _setByPath(obj, path, value) {
    const pathParts = path.split(".");
    const finalKey = pathParts[pathParts.length - 1];
    let target = obj;

    // Navigate to the parent object
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (
        target === null || target === undefined || !target.hasOwnProperty(part)
      ) {
        console.warn(`⚠️ Invalid path ${path} - missing ${part}`);
        return false;
      }
      target = target[part];
    }

    // Set the final value
    if (target !== null && target !== undefined) {
      target[finalKey] = value;
      return true;
    }

    console.warn(`⚠️ Cannot set ${path} - target is null/undefined`);
    return false;
  }

  /**
   * Check if a path exists in an object
   * @param {Object} obj - The object to check
   * @param {string} path - Dot notation path
   * @returns {boolean} True if path exists
   */
  _hasPath(obj, path) {
    return this._getByPath(obj, path) !== undefined;
  }
}

/**
 * Simple XY Oscilloscope for visualizing formant outputs
 */

// Initialize the synth client
const synthClient = new SynthClient();

// Make it globally available for debugging
globalThis.synthClient = synthClient;
