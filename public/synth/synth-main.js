/**
 * Voice.Assembly.FM Synth Client Main Application
 *
 * ARCHITECTURE CHANGES (AudioParam Migration):
 * - All envelope parameters now controlled via AudioParams
 * - Direct scheduling using Web Audio API automation
 * - No more SET_ENV/SET_ALL_ENV messages to worklet
 * - Sample-accurate parameter changes
 * - Proper save/load with HRG/RBG state preservation
 *
 * Key functions:
 * - applyResolvedProgram(): Schedules all parameters via AudioParams
 * - peekHRGValue(): Gets current HRG value without advancing
 * - _resolveRBG(): Handles RBG with peek mode for save/load
 */

import { generatePeerId, WebRTCStar } from "../../src/common/webrtc-star.js";
import {
  MessageBuilder,
  MessageTypes,
} from "../../src/common/message-protocol.js";
import { XYOscilloscope } from "./src/visualization/xy-oscilloscope.js";
import {
  applyPendingScene as applyPendingSceneAtEoc,
  buildSceneSnapshot,
  clearAllBanks as clearAllSceneBanks,
  clearBank as clearSceneBank,
  handleLoadScene as handleSceneCommand,
  loadScene as loadSceneSnapshot,
  toEnvPayload,
} from "./state/scenes.js";
import { resolveProgramSnapshot } from "./state/resolve.js";
import { applyResolvedProgram } from "./audio/scheduler.js";
import { resetPhasorState } from "./scheduler/phasor.js";
import {
  captureSceneSnapshot,
  clearAllSceneBanks as clearAllScenes,
  clearSceneBank as clearSingleSceneBank,
  restoreSceneFromSnapshot,
} from "./state/store.js";

class SynthClient {
  constructor() {
    this.peerId = generatePeerId("synth");

    // Required parameter set for complete programConfig
    this.REQUIRED_PARAMS = [
      "frequency",
      "vibratoRate",
      "vowelX",
      "vowelY",
      "zingAmount",
      "zingMorph",
      "symmetry",
      "amplitude",
      "whiteNoise",
      "vibratoWidth",
    ];

    // Track staging readiness
    this.programConfigComplete = false;

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

    // EOC beacon PLL state
    this.lastBeaconTime = null; // AudioContext time when last beacon arrived
    this.lastBeaconPhasor = null; // Phasor value from last beacon
    this.cachedTimingForPause = null; // Cache timing when paused

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
    this.stagedConfig = {}; // Staged changes during playback (applied at EOC)
    this.hrgState = {}; // HRG sequence state per parameter
    this.rbgState = {}; // RBG random value state per parameter (for static behavior)
    this.reresolveAtNextEOC = false; // Flag to re-randomize static HRG indices

    // Note: No persistent synth ID - using ephemeral session

    // Auto-connect to network on page load
    this.autoConnect();
  }

  _mapPortamentoNormToMs(norm) {
    const clamped = Math.min(Math.max(norm ?? 0, 0), 1);
    return 0.5 * Math.pow(40000, clamped);
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
      // Load voice worklet
      await this.audioContext.audioWorklet.addModule(
        "./worklets/voice-worklet.js",
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

      // Create mixer for voice output
      this.mixer = this.audioContext.createGain();

      // Create channel splitter for voice worklet's 5 outputs
      this.voiceSplitter = this.audioContext.createChannelSplitter(5);
      this.voiceNode.connect(this.voiceSplitter);

      // Route channel 0 (main audio) to mixer for sound output
      this.voiceSplitter.connect(this.mixer, 0);

      // Create stereo merger for oscilloscope (F1/F2 channels with decorrelated noise)
      this.oscilloscopeMerger = this.audioContext.createChannelMerger(2);

      // Route F1 and F2 (with integrated noise) directly to oscilloscope
      this.voiceSplitter.connect(this.oscilloscopeMerger, 2, 0); // F1 + noise -> X axis
      this.voiceSplitter.connect(this.oscilloscopeMerger, 3, 1); // F2 + noise -> Y axis

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

    // Minimal safe implementation: only handle cached PROGRAM_UPDATE
    if (this.lastProgramUpdate) {
      if (this.verbose) {
        console.log("🎼 Applying cached PROGRAM_UPDATE after init");
      }
      const cached = this.lastProgramUpdate;
      this.lastProgramUpdate = null; // Clear cache

      // Pass to unified handler - it will manage all state decisions
      this.handleProgramUpdate(cached);
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

  // Helper predicates for interpolation modes
  isCosInterp(interp) {
    return interp === "disc" || interp === "cont";
  }

  isCont(interp) {
    return interp === "cont";
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
        this.handleImmediateReinitialize(message);
        break;

      case MessageTypes.SAVE_SCENE:
        this.handleSaveScene(message);
        break;

      case MessageTypes.LOAD_SCENE:
        this.handleLoadScene(message);
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

    if (this.voiceNode) {
      // Log exact payload being sent
      console.log("➡️ SET_ENV", message.param, {
        start: message.value,
        end: message.value,
        interp: "step",
      });

      // Route via AudioParam scheduling
      const resolved = {
        [message.param]: {
          startValue: message.value,
          endValue: message.value,
          interpolation: "step",
        },
      };

      applyResolvedProgram(this, resolved, 15); // 15ms portamento

      console.log(
        `🔌 Route for '${message.param}': Main Thread -> Voice (AudioParam)`,
      );
    }
  }

  isReadyToReceiveParameters() {
    if (!this.voiceNode) {
      console.warn(
        "⚠️ Cannot apply control state: voice worklet not ready",
      );
      return false;
    }

    return true;
  }

  /**
   * OBSOLETE - Apply a parameter value that may be static or have envelope configuration
   * This method is deprecated in the two-worklet architecture
   */
  // applyParameterWithEnvelope(paramName, paramValue) {
  //   // Method removed - parameters now handled by direct routing or program worklet
  // }

  /**
   * Set synthesis active flag and AudioParam in one place
   * Single source of truth for synthesis state
   */
  setSynthesisActiveFlag(active) {
    this.synthesisActive = !!active;

    // Immediately update worklet's active AudioParam
    const activeParam = this.voiceNode?.parameters.get("active");
    if (activeParam) {
      activeParam.value = this.synthesisActive ? 1 : 0;
    }

    if (this.verbose) {
      console.log(
        `🎵 Synthesis ${this.synthesisActive ? "enabled" : "disabled"}`,
      );
    }
  }

  /**
   * Activate synthesis immediately when enabled while paused
   * Ensures audio output starts right away regardless of transport state
   */
  activateImmediateSynthesis() {
    console.log("🎵 Activating immediate synthesis...");

    // Guard against incomplete state - fail gracefully, never crash
    if (!this.voiceNode) {
      console.log("⚠️ No voice node available - synthesis activation deferred");
      return;
    }

    if (!this.programConfig || Object.keys(this.programConfig).length === 0) {
      console.log(
        "⚠️ Program config incomplete - synthesis activation deferred",
      );
      return;
    }

    if (!this.programConfigComplete) {
      console.log(
        "⚠️ Program config not complete - synthesis activation deferred",
      );
      return;
    }

    try {
      console.log("🎼 Resolving parameter values for immediate synthesis");

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

        // Tracking removed - using resolver instead
      }

      // Apply via AudioParam scheduling
      const resolved = {};
      for (const [param, cfg] of Object.entries(resolvedParams)) {
        resolved[param] = {
          startValue: cfg.startValue,
          endValue: cfg.endValue,
          interpolation: cfg.interpolation,
        };
      }

      applyResolvedProgram(this, resolved, 0);

      console.log("✅ Immediate synthesis activated successfully");
    } catch (error) {
      console.warn("⚠️ Failed to activate immediate synthesis:", error.message);
      // Continue gracefully - don't crash the join
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
    }

    // Apply via AudioParam scheduling
    const resolved = {};
    for (const [param, cfg] of Object.entries(resolvedParams)) {
      resolved[param] = {
        startValue: cfg.startValue,
        endValue: cfg.endValue,
        interpolation: cfg.interpolation,
      };
    }

    applyResolvedProgram(this, resolved, portamentoTime);

    console.log(
      `🎯 AudioParam scheduling with ${portamentoTime}ms portamento`,
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

    // Apply via AudioParam scheduling
    const resolved = {
      [param]: {
        startValue: value,
        endValue: value, // For single value updates, start = end
        interpolation: cfg.interpolation || "step",
      },
    };

    applyResolvedProgram(this, resolved, portamentoTime);
  }

  // _resolveParameterAtPhase method removed - using AudioParams directly

  handleProgramUpdate(message) {
    if (this.verbose) console.log("📨 PROGRAM_UPDATE received:", message);

    // Step 1: Guard against unready state
    if (!this.voiceNode) {
      console.warn("⚠️ Worklets not ready; caching PROGRAM_UPDATE for later");
      this.lastProgramUpdate = message;
      return;
    }

    // Step 2: Extract meta fields and update synthesis state
    const wasActive = this.synthesisActive;
    if (message.synthesisActive !== undefined) {
      this.setSynthesisActiveFlag(message.synthesisActive);

      // Handle immediate activation when synthesis is turned on
      if (!wasActive && this.synthesisActive) {
        console.log(
          "⚡ Synthesis turned ON - will activate after config processing",
        );
      }

      // Handle deactivation - clear staged config
      if (wasActive && !this.synthesisActive) {
        console.log("🔇 Synthesis turned OFF - clearing staged config");
        this.stagedConfig = {};
      }
    }

    // Step 3: Process parameter payload
    this.programConfig = this.programConfig || {};

    for (const paramName in message) {
      // Skip meta fields
      if (
        [
          "type",
          "timestamp",
          "synthesisActive",
          "isManualMode",
          "portamentoTime",
        ].includes(paramName)
      ) continue;

      const paramData = message[paramName];

      // Error guard: reject forbidden scope field
      if ("scope" in paramData) {
        console.error(
          `BREAKING: Parameter '${paramName}' contains forbidden 'scope' field. Ignoring message.`,
        );
        return; // Fail gracefully instead of throwing
      }

      // Validate baseValue for periodic generators
      if (
        paramData.startValueGenerator?.type === "periodic" &&
        paramData.baseValue === undefined
      ) {
        console.error(
          `🚨 CRITICAL: Periodic generator for ${paramName} missing baseValue!`,
        );
        return; // Fail gracefully instead of throwing
      }

      // Store parameter config and initialize HRG state
      this.programConfig[paramName] = paramData;
      this._initializeHRGState(paramName, paramData);

      if (this.verbose) {
        console.log(
          `🎼 ${paramData.interpolation} interpolation for ${paramName}`,
        );
      }
    }

    // Check completeness - bail early if incomplete
    this.checkProgramConfigCompleteness();
    if (!this.programConfigComplete) {
      console.log("⏸️ Program config incomplete - deferring worklet updates");
      return;
    }

    console.log("✅ Program config complete - determining apply path");

    // Step 4: Decide on apply path based on synthesis state
    if (!this.synthesisActive) {
      // Synthesis disabled: clear staged config, don't touch worklet
      console.log("🔇 Synthesis disabled - clearing staged config");
      this.stagedConfig = {};
      return;
    }

    // Synthesis enabled: check transport state
    if (this.receivedIsPlaying) {
      // Playing: stage for cycle reset
      console.log("📋 Transport playing - staging config for cycle reset");
      this.stagedConfig = JSON.parse(JSON.stringify(this.programConfig));
    } else {
      // Paused: apply immediately
      console.log("⚡ Transport paused - applying immediately");

      // Send PROGRAM config to worklet
      this.voiceNode.port.postMessage({
        type: "PROGRAM",
        config: this.programConfig,
      });
      console.log(`📤 Sent PROGRAM config to worklet`);

      // Only call activateImmediateSynthesis when turning synthesis on while paused
      if (!wasActive && this.synthesisActive) {
        console.log("🎵 Activating synthesis for turn-on-while-paused case");
        this.activateImmediateSynthesis();
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

    // Initialize staged config if needed
    if (Object.keys(this.stagedConfig).length === 0 && this.receivedIsPlaying) {
      this.stagedConfig = JSON.parse(JSON.stringify(this.programConfig));
    }

    const finalPortamento = portamentoTime ?? 0;

    if (this.receivedIsPlaying) {
      // When playing: Update staged config and mirror minimal recomputation on caches
      if (!this._setByPath(this.stagedConfig, paramPath, value)) {
        throw new Error(`CRITICAL: Failed to update staged path ${paramPath}`);
      }

      // Mirror the same minimal recomputation that paused path would perform
      this._performMinimalRecomputation(paramName, paramPath, value, true); // true = staging mode

      console.log(
        `📋 Staging sub-parameter update for EOC: ${paramPath} = ${value}`,
      );
      return; // Don't apply immediately, wait for EOC
    }

    // When paused: Update programConfig and apply minimal recomputation immediately
    if (!this._setByPath(this.programConfig, paramPath, value)) {
      throw new Error(`CRITICAL: Failed to update path ${paramPath}`);
    }

    console.log(`⚡ Applying sub-parameter update: ${paramPath} = ${value}`);

    // Perform minimal recomputation based on paramPath
    this._performMinimalRecomputation(
      paramName,
      paramPath,
      value,
      false,
      finalPortamento,
    );

    // Forward to worklet when paused (not when playing)
    this.voiceNode.port.postMessage({
      type: "UPDATE_PARAM_CONFIG",
      path: paramPath,
      value: value,
    });

    // If synthesis is active and we're paused, make sure we hear the changes
    if (this.synthesisActive && !this.isPlaying) {
      this.activateImmediateSynthesis();
    }
  }

  /**
   * Perform minimal recomputation based on parameter path
   * @param {string} paramName - Parameter name (e.g., 'frequency')
   * @param {string} paramPath - Full dot-notation path
   * @param {*} value - New value
   * @param {boolean} stagingMode - If true, only update caches, don't send to worklet
   * @param {number} portamentoMs - Portamento time (only for immediate application)
   */
  _performMinimalRecomputation(
    paramName,
    paramPath,
    value,
    stagingMode = false,
    portamentoMs = 0,
  ) {
    const cfg = this.programConfig[paramName] || this.stagedConfig[paramName];
    if (!cfg) {
      throw new Error(`CRITICAL: Missing config for ${paramName}`);
    }

    // Handle baseValue changes - rescale using existing ratios
    if (paramPath.endsWith(".baseValue")) {
      if (!stagingMode) {
        this.applyBaseValueUpdate(paramName, value, portamentoMs);
      }
      return;
    }

    // Handle start numerator changes
    if (paramPath.includes(".startValueGenerator.numerators")) {
      this._updateHRGComponent(
        paramName,
        "start",
        "numerator",
        stagingMode,
        portamentoMs,
      );
      return;
    }

    // Handle start denominator changes
    if (paramPath.includes(".startValueGenerator.denominators")) {
      this._updateHRGComponent(
        paramName,
        "start",
        "denominator",
        stagingMode,
        portamentoMs,
      );
      return;
    }

    // Handle end numerator changes
    if (paramPath.includes(".endValueGenerator.numerators")) {
      this._updateHRGComponent(
        paramName,
        "end",
        "numerator",
        stagingMode,
        portamentoMs,
      );
      return;
    }

    // Handle end denominator changes
    if (paramPath.includes(".endValueGenerator.denominators")) {
      this._updateHRGComponent(
        paramName,
        "end",
        "denominator",
        stagingMode,
        portamentoMs,
      );
      return;
    }

    // Handle behavior changes
    if (
      paramPath.includes("numeratorBehavior") ||
      paramPath.includes("denominatorBehavior")
    ) {
      // Behavior changes don't affect current values, just future generation
      if (paramPath.includes(".startValueGenerator.")) {
        this._updateHRGBehavior(paramName, "start", paramPath);
      } else if (paramPath.includes(".endValueGenerator.")) {
        this._updateHRGBehavior(paramName, "end", paramPath);
      }
      return;
    }

    // Handle RBG range/behavior updates
    if (
      paramPath.includes(".range") || paramPath.includes(".behavior") ||
      paramPath.includes(".sequenceBehavior")
    ) {
      this._updateRBGState(paramName, paramPath, value);
      if (!stagingMode) {
        this.applySingleParamWithPortamento(paramName, portamentoMs);
      }
      return;
    }

    // For all other paths, fall back to full resolution
    if (!stagingMode) {
      this.applySingleParamWithPortamento(paramName, portamentoMs);
    }
  }

  /**
   * Update a specific HRG component (numerator or denominator) for start or end
   */
  _updateHRGComponent(
    paramName,
    position,
    component,
    stagingMode = false,
    portamentoMs = 0,
  ) {
    const cfg = this.programConfig[paramName] || this.stagedConfig[paramName];
    const generator = position === "start"
      ? cfg.startValueGenerator
      : cfg.endValueGenerator;

    if (!generator || generator.type !== "periodic") {
      return;
    }

    // Update the HRG state for this component
    if (component === "numerator") {
      this._updateHRGNumerators(paramName, position);
    } else {
      this._updateHRGDenominators(paramName, position);
    }

    // If not staging, compute new value and send to worklet
    if (!stagingMode) {
      // Use peekHRGValue to get the current value after update
      const newValue = this.peekHRGValue(paramName, position);

      // Send minimal SET_ENV for just the affected value
      if (position === "start") {
        // Get preserved end value using peek
        const endValue = cfg.endValueGenerator?.type === "periodic"
          ? this.peekHRGValue(paramName, "end")
          : this._resolveRBG(cfg.endValueGenerator, paramName, "end", true);
        this._sendSetEnvMessage(
          paramName,
          newValue,
          endValue,
          cfg.interpolation,
          portamentoMs,
        );
      } else {
        // Get preserved start value using peek
        const startValue = cfg.startValueGenerator?.type === "periodic"
          ? this.peekHRGValue(paramName, "start")
          : this._resolveRBG(cfg.startValueGenerator, paramName, "start", true);
        this._sendSetEnvMessage(
          paramName,
          startValue,
          newValue,
          cfg.interpolation,
          portamentoMs,
        );
      }

      console.log(
        `🔄 Minimal ${component} update for ${paramName}.${position}: ${
          newValue.toFixed(3)
        }`,
      );
    }
  }

  /**
   * Update HRG behavior without affecting current values
   */
  _updateHRGBehavior(paramName, position, paramPath) {
    if (paramPath.includes("numeratorBehavior")) {
      this._updateHRGNumeratorBehavior(paramName, position);
    } else if (paramPath.includes("denominatorBehavior")) {
      this._updateHRGDenominatorBehavior(paramName, position);
    }
  }

  /**
   * Send SET_ENV message to worklet
   */
  _sendSetEnvMessage(
    paramName,
    startValue,
    endValue,
    interpolation,
    portamentoMs,
  ) {
    // Use AudioParam scheduling instead of message
    const resolved = {
      [paramName]: {
        startValue,
        endValue,
        interpolation,
      },
    };

    // Apply via AudioParam scheduling
    applyResolvedProgram(this, resolved, portamentoMs);

    console.log(
      `➡️ AudioParam schedule (HRG update): ${paramName} start=${
        startValue.toFixed(2)
      }, end=${endValue.toFixed(2)}`,
    );
  }

  /**
   * Update RBG state when parameter config changes
   */
  _updateRBGState(paramName, paramPath, value) {
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

    // EOC Beacon PLL Implementation
    // Guard against null audioContext during initialization
    if (!this.audioContext) {
      console.log("⏳ Audio context not ready, deferring EOC beacon PLL");
      // Fall back to legacy behavior until audio context is available

      // Update phasor worklet parameters when ready
      if (this.phasorWorklet) {
        this.phasorWorklet.parameters.get("cycleLength").value =
          this.receivedCycleLength;
        this.phasorWorklet.parameters.get("stepsPerCycle").value =
          this.receivedStepsPerCycle;

        if (this.receivedIsPlaying) {
          this.phasorWorklet.port.postMessage({ type: "start" });
        } else {
          this.phasorWorklet.port.postMessage({ type: "stop" });
        }
      }

      // Continue with rest of method for compatibility
      if (
        this.unifiedSynthNode &&
        this.unifiedSynthNode.parameters.has("isPlaying")
      ) {
        this.unifiedSynthNode.parameters.get("isPlaying").value =
          this.receivedIsPlaying ? 1 : 0;
      }

      if (this.programNode) {
        const periodDisplay = message.cpm
          ? `${message.cpm} CPM`
          : `${this.receivedCycleLength}s period`;
        console.log(`⏰ Received phasor sync: ${periodDisplay}`);

        const newTimingConfig = {
          cpm: message.cpm,
          stepsPerCycle: message.stepsPerCycle,
          cycleLength: message.cycleLength,
          phasor: message.phasor,
        };

        this.timingConfig = newTimingConfig;
      }

      this.updatePhasorWorklet();

      if (!this.phasorUpdateId) {
        this.startPhasorInterpolation();
      }

      if (!this.receivedIsPlaying) {
        resetPhasorState(this, this.receivedPhasor ?? 0);
      }
      return;
    }

    const currentAudioTime = this.audioContext.currentTime;
    const messageTimestamp = message.timestamp || performance.now();

    if (this.receivedIsPlaying) {
      // Cache timing for later use
      this.cachedTimingForPause = {
        cycleLength: this.receivedCycleLength,
        stepsPerCycle: this.receivedStepsPerCycle,
      };

      // Estimate message arrival time accounting for network delay
      const estimatedSendTime = messageTimestamp / 1000.0; // Convert to seconds
      const estimatedArrivalDelay = 0.01; // Assume ~10ms network delay
      const beaconAudioTime = currentAudioTime - estimatedArrivalDelay;

      // Store beacon timing for PLL
      this.lastBeaconTime = beaconAudioTime;
      this.lastBeaconPhasor = this.receivedPhasor;

      // Detect beacon type: EOC vs step beacon
      const isEOC = Math.abs(this.receivedPhasor) < 0.001; // phasor ≈ 0

      if (isEOC) {
        // EOC beacon - schedule next cycle reset
        this.nextCycleTime = beaconAudioTime + this.receivedCycleLength;

        // Send EOC scheduling to phasor worklet
        if (this.phasorWorklet) {
          this.phasorWorklet.port.postMessage({
            type: "schedule-eoc-reset",
            nextCycleTime: this.nextCycleTime,
            cycleLength: this.receivedCycleLength,
            correctionFactor: this.pllCorrectionFactor,
          });
        }

        console.log(
          `🎯 EOC beacon: scheduled next cycle at audio time ${
            this.nextCycleTime.toFixed(3)
          }s`,
        );
      } else {
        // Step beacon - apply gentle PLL correction
        const expectedStepIndex = Math.round(
          this.receivedPhasor * this.receivedStepsPerCycle,
        );
        const stepPhase = expectedStepIndex / this.receivedStepsPerCycle;

        // Send step-aligned phase correction to worklet
        if (this.phasorWorklet) {
          this.phasorWorklet.port.postMessage({
            type: "phase-correction",
            targetPhase: stepPhase,
            correctionFactor: this.pllCorrectionFactor * 0.5, // Gentler correction for steps
          });
        }

        console.log(
          `🔄 Step beacon: step ${expectedStepIndex} (phase ${
            stepPhase.toFixed(3)
          })`,
        );
      }
    } else {
      // Not playing - cache timing but don't advance
      this.cachedTimingForPause = {
        cycleLength: this.receivedCycleLength,
        stepsPerCycle: this.receivedStepsPerCycle,
      };

      console.log(
        `⏸️ Paused heartbeat: cached timing (${this.receivedCycleLength}s cycle)`,
      );

      // Force phasor state to the received phase for new/paused synths
      resetPhasorState(this, this.receivedPhasor ?? 0);
    }

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
    }

    // Update legacy phasor worklet (if still needed)
    this.updatePhasorWorklet();

    // Apply gentle PLL correction between beacons
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
      ((resetData.blockSize - resetData.sampleIndex) /
        this.audioContext.sampleRate);

    if (this._pendingSceneAtEoc) {
      applyPendingSceneAtEoc(this);
      return;
    }

    // Apply staged config changes at EOC
    if (Object.keys(this.stagedConfig).length > 0) {
      console.log(
        `🚀 Committing staged config changes at EOC (${
          Object.keys(this.stagedConfig).length
        } parameters)`,
      );

      // Merge staged config into active config
      this.programConfig = JSON.parse(JSON.stringify(this.stagedConfig));

      // Apply minimal recomputation for each staged parameter to generate fresh values
      const resolvedParams = {};
      for (const paramName of Object.keys(this.stagedConfig)) {
        const phase = this.getCurrentPhase();
        const cfg = this.programConfig[paramName];
        if (cfg) {
          const resolvedParam = this.resolveParameter(paramName, cfg, phase);
          resolvedParams[paramName] = {
            startValue: resolvedParam.startValue,
            endValue: resolvedParam.endValue,
            interpolation: cfg.interpolation,
          };
        }
      }

      // Forward resolved parameters to worklet
      if (this.voiceNode) {
        this.voiceNode.port.postMessage({
          type: "SET_ALL_ENV",
          v: 1,
          params: resolvedParams,
        });
        console.log(
          `📤 Applied committed config with preserved caches to worklet`,
        );
      }

      // Clear staged config
      this.stagedConfig = {};

      console.log(
        `✅ Staged config committed with minimal recomputation at EOC`,
      );
      return;
    }

    // EOC logging for debugging
    console.log(
      `📊 handleCycleReset: EOC received, worklet handles resolution`,
    );
  }

  sendPhaseCorrection() {
    if (!this.phasorWorklet || !this.pllEnabled || !this.receivedIsPlaying) {
      return;
    }

    // EOC Beacon PLL: apply gentle correction based on expected phase
    if (this.lastBeaconTime !== null) {
      const currentAudioTime = this.audioContext.currentTime;
      const timeSinceBeacon = currentAudioTime - this.lastBeaconTime;

      // Calculate expected phasor based on beacon timing
      const expectedPhase =
        (this.lastBeaconPhasor + (timeSinceBeacon / this.receivedCycleLength)) %
        1.0;

      // Send gentle correction to worklet
      this.phasorWorklet.port.postMessage({
        type: "phase-correction",
        targetPhase: expectedPhase,
        correctionFactor: this.pllCorrectionFactor,
      });
    }
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

  handleImmediateReinitialize(message = {}) {
    console.log("⚡ Re-initializing all stochastic generators...");

    // Guard for config presence
    if (!this.programConfig || Object.keys(this.programConfig).length === 0) {
      console.warn("No program config available for re-initialization");
      return;
    }

    // Clear all cached RBG values, but preserve cont mode end values
    const contParams = [];
    for (const paramName in this.programConfig) {
      if (this.programConfig[paramName].interpolation === "cont") {
        contParams.push(paramName);
      }
    }

    // Preserve cont mode end values when clearing
    const preservedEndValues = {};
    for (const param of contParams) {
      if (this.rbgState[`${param}_end`]) {
        preservedEndValues[`${param}_end`] = this.rbgState[`${param}_end`];
      }
    }

    this.rbgState = {};

    // Restore cont mode end values
    Object.assign(this.rbgState, preservedEndValues);

    console.log(
      `🎲 Cleared all RBG cached values (preserved ${
        Object.keys(preservedEndValues).length
      } cont mode end values)`,
    );

    // Re-initialize HRG indices for all parameters
    for (const paramName in this.programConfig) {
      const paramConfig = this.programConfig[paramName];

      // Re-init start position if it uses HRG
      if (paramConfig.startValueGenerator?.type === "periodic") {
        this._reinitHRGPosition(paramName, "start");
      }

      // Re-init end position if it uses HRG with disc/cont interpolation
      if (
        paramConfig.endValueGenerator?.type === "periodic" &&
        this.isCosInterp(paramConfig.interpolation)
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

    // Resolve fresh values using the pure resolver
    const resolvedParams = resolveProgramSnapshot({
      programConfig: this.programConfig,
      hrgState: this.hrgState,
      rbgState: this.rbgState,
      isCosInterp: this.isCosInterp.bind(this),
      resolveHRG: (param, pos, peek = false) =>
        peek ? this.peekHRGValue(param, pos) : this._resolveHRG(param, pos),
      resolveRBG: (gen, param, pos, peek) =>
        this._resolveRBG(gen, param, pos, peek),
    });

    let portamentoMs = 0;
    if (typeof message.portamento === "number") {
      portamentoMs = this._mapPortamentoNormToMs(message.portamento);
    } else if (this.elements?.portamentoTime) {
      portamentoMs = this._mapPortamentoNormToMs(
        parseFloat(this.elements.portamentoTime.value),
      );
    }

    // Add portamento to all resolved parameters
    for (const paramName in resolvedParams) {
      resolvedParams[paramName].portamentoMs = portamentoMs;
    }

    // DETAILED REINIT LOGGING
    console.log(`\n🟢 RE-RESOLVE ==================`);
    console.log("📊 New resolved values:");
    for (const [param, values] of Object.entries(resolvedParams)) {
      console.log(
        `  ${param}: start=${values.startValue?.toFixed(2)}, end=${
          values.endValue?.toFixed(2)
        }`,
      );
    }

    // Log HRG state for frequency
    const freqHrg = this.hrgState?.frequency;
    if (freqHrg?.start) {
      console.log(
        `🎲 frequency HRG start: idx=${freqHrg.start.indexN} val=${
          freqHrg.start.numerators?.[freqHrg.start.indexN]
        }/${
          freqHrg.start.denominators?.[freqHrg.start.indexD]
        } arrays=[${freqHrg.start.numerators}]/[${freqHrg.start.denominators}]`,
      );
    }
    if (freqHrg?.end) {
      console.log(
        `🎲 frequency HRG end: idx=${freqHrg.end.indexN} val=${
          freqHrg.end.numerators?.[freqHrg.end.indexN]
        }/${
          freqHrg.end.denominators?.[freqHrg.end.indexD]
        } arrays=[${freqHrg.end.numerators}]/[${freqHrg.end.denominators}]`,
      );
    }
    console.log("");

    // USE NEW AUDIOPARAM PATH
    // Apply via AudioParam scheduling instead of messages
    this._applyResolvedProgram(resolvedParams, portamentoMs);

    // Reset phasor if playing (immediate audible change)
    if (this.isPlaying && this.phasorWorklet) {
      console.log("🔄 Resetting phasor for immediate audible change");
      this.phasorWorklet.port.postMessage({ type: "reset" });
    }

    console.log(
      `⚡ Sent re-initialization to voice worklet: ${
        Object.keys(resolvedParams).length
      } parameters with ${portamentoMs}ms portamento`,
    );

    // Update status
    this.updateSynthesisStatus(
      "re-resolved",
      "Stochastic state re-initialized",
    );
  }

  // AudioParam Scheduling Methods

  /**
   * Apply resolved program using AudioParam scheduling
   * This is the new path that replaces SET_ALL_ENV messages
   */
  _applyResolvedProgram(resolved, portamentoMs = 0) {
    applyResolvedProgram(this, resolved, portamentoMs);
  }

  // Scene Memory Methods

  handleSaveScene(payload) {
    captureSceneSnapshot(this, payload.memoryLocation);
  }

  captureScene(bank) {
    captureSceneSnapshot(this, bank);
  }

  loadScene(snapshot, memoryLocation = null) {
    restoreSceneFromSnapshot(snapshot, this);
  }

  handleLoadScene(payload) {
    // Delegate to external handler - no need to notify controller
    // as it initiated the load and already knows the state
    handleSceneCommand(payload, this);
  }

  clearAllBanks() {
    clearAllScenes(this);
  }

  clearBank(bank) {
    clearSingleSceneBank(this, bank);
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
          // Keep end generator present (will be ignored for step interpolation)
        } else if (this.isCosInterp(message.interpolation)) {
          // Disc/cont interpolation - preserve both generators, create end generator if missing
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
            // Create end generator based on start generator type if missing
            console.log(
              `📋 Creating missing end generator for ${message.param} cosine interpolation`,
            );

            if (existingConfig.startValueGenerator?.type === "periodic") {
              // Create periodic neutral end selector
              this.programConfig[message.param].endValueGenerator = {
                type: "periodic",
                numerators: "1",
                denominators: "1",
                numeratorBehavior: "static",
                denominatorBehavior: "static",
              };
            } else {
              // Create normalised end generator
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
          portamentoMs: message.portamentoTime || 0,
        });
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

        // For disc/cont interpolation, update both generators
        if (this.isCosInterp(message.interpolation)) {
          if (config.endValueGenerator?.type === "normalised") {
            config.endValueGenerator.range = message.endValue;
            delete this.rbgState[`${message.param}_end`];
          }
        }

        // For periodic params (HRG), prefer SUB_PARAM_UPDATE - don't overwrite generators
        // Unified updates for periodic are rare and should preserve HRG state

        console.log(
          `⚡ Updated programConfig.${message.param} to persist paused change`,
        );
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

      // All parameters go to voice worklet via SET_ALL_ENV
      voiceParams[paramName] = {
        startValue: v,
        endValue: v,
        interpolation: "step",
        portamentoMs: 15, // Convert 0.015s to ms
      };
      if (this.verbose) {
        console.log(`🎚️ Scene apply: ${paramName} -> ${v} (via SET_ALL_ENV)`);
      }
    }

    // Send all voice parameters in a single SET_ALL_ENV message
    if (this.voiceNode && Object.keys(voiceParams).length > 0) {
      this.voiceNode.port.postMessage({
        type: "SET_ALL_ENV",
        v: 1,
        params: voiceParams,
      });
      if (this.verbose) {
        console.log(
          "📦 SET_ALL_ENV sent for scene state with parameters:",
          Object.keys(voiceParams),
        );
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

      // All parameters go to voice worklet via SET_ALL_ENV
      voiceParams[paramName] = {
        startValue: v,
        endValue: v,
        interpolation: "step",
        portamentoMs: 15, // Convert 0.015s to ms
      };
      if (this.verbose) {
        console.log(`🎚️ Scene apply: ${paramName} -> ${v} (via SET_ALL_ENV)`);
      }
    }

    // Send all voice parameters in a single SET_ALL_ENV message
    if (this.voiceNode && Object.keys(voiceParams).length > 0) {
      this.voiceNode.port.postMessage({
        type: "SET_ALL_ENV",
        v: 1,
        params: voiceParams,
      });
      if (this.verbose) {
        console.log(
          "📦 SET_ALL_ENV sent for resolved scene values with parameters:",
          Object.keys(voiceParams),
        );
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

    // Prefer arrays if available, fall back to parsing strings
    const numerators = Array.isArray(generator.numerators)
      ? [...generator.numerators]
      : this._parseSIN(generator.numerators || "1");
    const denominators = Array.isArray(generator.denominators)
      ? [...generator.denominators]
      : this._parseSIN(generator.denominators || "1");

    console.log(
      `🎲 HRG init for ${param}: nums=${
        Array.isArray(generator.numerators) ? "array" : "string"
      } [${numerators}], denoms=${
        Array.isArray(generator.denominators) ? "array" : "string"
      } [${denominators}]`,
    );
    const numeratorBehavior = generator.numeratorBehavior || "static";
    const denominatorBehavior = generator.denominatorBehavior || "static";

    this.hrgState[param] = {
      start: {
        numerators,
        denominators,
        numeratorBehavior,
        denominatorBehavior,
        indexN: numeratorBehavior === "static" || numeratorBehavior === "random"
          ? Math.floor(Math.random() * numerators.length)
          : 0,
        indexD:
          denominatorBehavior === "static" || denominatorBehavior === "random"
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

    // Initialize end state if disc/cont interpolation
    if (
      this.isCosInterp(config.interpolation) &&
      config.endValueGenerator?.type === "periodic"
    ) {
      const endGen = config.endValueGenerator;
      // Prefer arrays if available, fall back to parsing strings
      const endNumerators = Array.isArray(endGen.numerators)
        ? [...endGen.numerators]
        : this._parseSIN(endGen.numerators || "1");
      const endDenominators = Array.isArray(endGen.denominators)
        ? [...endGen.denominators]
        : this._parseSIN(endGen.denominators || "1");
      const endNumBehavior = endGen.numeratorBehavior || "static";
      const endDenBehavior = endGen.denominatorBehavior || "static";

      this.hrgState[param].end = {
        numerators: endNumerators,
        denominators: endDenominators,
        numeratorBehavior: endNumBehavior,
        denominatorBehavior: endDenBehavior,
        indexN: endNumBehavior === "static" || endNumBehavior === "random"
          ? Math.floor(Math.random() * endNumerators.length)
          : 0,
        indexD: endDenBehavior === "static" || endDenBehavior === "random"
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

    // Check if HRG state already exists (e.g., loaded from scene)
    const existingState = this.hrgState[param]?.[position];

    // If state exists, only randomize indices, preserve arrays
    if (existingState && existingState.numerators?.length) {
      const numeratorBehavior = generator.numeratorBehavior || "static";
      const denominatorBehavior = generator.denominatorBehavior || "static";

      // Update behaviors
      existingState.numeratorBehavior = numeratorBehavior;
      existingState.denominatorBehavior = denominatorBehavior;

      // Randomize indices only
      if (numeratorBehavior === "static" || numeratorBehavior === "random") {
        existingState.indexN = Math.floor(
          Math.random() * existingState.numerators.length,
        );
        existingState.orderN = null;
      } else if (numeratorBehavior === "shuffle") {
        existingState.orderN = this._shuffleArray([
          ...existingState.numerators,
        ]);
        existingState.indexN = 0;
      } else {
        existingState.indexN = 0;
        existingState.orderN = null;
      }

      if (
        denominatorBehavior === "static" || denominatorBehavior === "random"
      ) {
        existingState.indexD = Math.floor(
          Math.random() * existingState.denominators.length,
        );
        existingState.orderD = null;
      } else if (denominatorBehavior === "shuffle") {
        existingState.orderD = this._shuffleArray([
          ...existingState.denominators,
        ]);
        existingState.indexD = 0;
      } else {
        existingState.indexD = 0;
        existingState.orderD = null;
      }

      console.log(
        `🔄 Re-randomized HRG indices for ${param}.${position}: N=[${existingState.indexN}], D=[${existingState.indexD}] (arrays preserved)`,
      );
      return;
    }

    // No existing state - generate fresh arrays
    // Prefer arrays if available, fall back to parsing strings
    const numerators = Array.isArray(generator.numerators)
      ? [...generator.numerators]
      : this._parseSIN(generator.numerators || "1");
    const denominators = Array.isArray(generator.denominators)
      ? [...generator.denominators]
      : this._parseSIN(generator.denominators || "1");
    const numeratorBehavior = generator.numeratorBehavior || "static";
    const denominatorBehavior = generator.denominatorBehavior || "static";

    // Ensure HRG state exists
    if (!this.hrgState[param]) {
      this.hrgState[param] = {};
    }

    // Create new state
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
      `🔄 Generated fresh HRG ${position} for ${param}: N=[${
        this.hrgState[param][position].indexN
      }] from [${numerators}], D=[${
        this.hrgState[param][position].indexD
      }] from [${denominators}]`,
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
    // Prefer arrays if available
    const newNumerators = Array.isArray(generator.numerators)
      ? [...generator.numerators]
      : this._parseSIN(generator.numerators || "1");

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
    // Prefer arrays if available
    const newDenominators = Array.isArray(generator.denominators)
      ? [...generator.denominators]
      : this._parseSIN(generator.denominators || "1");

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
      // Don't reset indexN for ascending/descending - preserve sequence continuity
      // This allows proper LCM emergence when numerators/denominators have different lengths
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
      // Don't reset indexD for ascending/descending - preserve sequence continuity
      // This allows proper LCM emergence when numerators/denominators have different lengths
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
      // Prefer arrays if available
      numerators = Array.isArray(generator.numerators)
        ? [...generator.numerators]
        : this._parseSIN(generator.numerators || "1");
    }

    if (denominatorBehavior === "shuffle" && seqState.orderD) {
      denominators = seqState.orderD; // Use saved shuffled array
    } else {
      // Prefer arrays if available
      denominators = Array.isArray(generator.denominators)
        ? [...generator.denominators]
        : this._parseSIN(generator.denominators || "1");
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

    // Initialize end state if disc/cont interpolation
    if (
      this.isCosInterp(config.interpolation) &&
      config.endValueGenerator?.type === "periodic"
    ) {
      const endGen = config.endValueGenerator;
      // Prefer arrays if available, fall back to parsing strings
      const endNumerators = Array.isArray(endGen.numerators)
        ? [...endGen.numerators]
        : this._parseSIN(endGen.numerators || "1");
      const endDenominators = Array.isArray(endGen.denominators)
        ? [...endGen.denominators]
        : this._parseSIN(endGen.denominators || "1");
      const endNumBehavior = endGen.numeratorBehavior || "static";
      const endDenBehavior = endGen.denominatorBehavior || "static";

      this.hrgState[param].end = {
        numerators: endNumerators,
        denominators: endDenominators,
        numeratorBehavior: endNumBehavior,
        denominatorBehavior: endDenBehavior,
        indexN: endNumBehavior === "static" || endNumBehavior === "random"
          ? Math.floor(Math.random() * endNumerators.length)
          : 0,
        indexD: endDenBehavior === "static" || endDenBehavior === "random"
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

  /**
   * Check if programConfig has all required parameters
   * Updates this.programConfigComplete flag
   */
  checkProgramConfigCompleteness() {
    const currentParams = Object.keys(this.programConfig);
    const missingParams = this.REQUIRED_PARAMS.filter((param) =>
      !currentParams.includes(param)
    );

    const wasComplete = this.programConfigComplete;
    this.programConfigComplete = missingParams.length === 0;

    if (!this.programConfigComplete) {
      console.warn(
        `🚫 programConfig incomplete: ${currentParams.length}/10 params, missing: [${
          missingParams.join(", ")
        }]`,
      );
    } else if (!wasComplete) {
      console.log(
        `✅ programConfig now complete: [${currentParams.join(", ")}]`,
      );
    }

    return this.programConfigComplete;
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
      startValue: this._resolveParameterValue(
        cfg.startValueGenerator,
        paramName,
        "start",
      ),
      endValue: cfg.interpolation === "step"
        ? this._resolveParameterValue(
          cfg.startValueGenerator,
          paramName,
          "start",
        )
        : this._resolveParameterValue(cfg.endValueGenerator, paramName, "end"),
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
  }

  // GRANULAR UPDATE METHODS - Minimal Re-Resolution Architecture

  // Apply only start value update (preserves end value)
  applyStartValueUpdate(paramName, portamentoMs) {
    const cfg = this.programConfig[paramName];
    if (!cfg) {
      throw new Error(`CRITICAL: Missing config for ${paramName}`);
    }

    // Resolve only the start value
    const newStartValue = this._resolveParameterValue(
      cfg.startValueGenerator,
      paramName,
      "start",
    );

    // Preserve existing end value
    const preservedEndValue = this.peekHRGValue(paramName, "end");

    console.log(
      `⚡ START-ONLY update for ${paramName}: start=${newStartValue}, preserving end=${preservedEndValue}`,
    );

    // Send targeted SET_ENV message
    this.voiceNode.port.postMessage({
      type: "SET_ENV",
      v: 1,
      param: paramName,
      startValue: newStartValue,
      endValue: preservedEndValue,
      interpolation: cfg.interpolation,
      portamentoMs: portamentoMs,
    });
  }

  // Apply only end value update (preserves start value)
  applyEndValueUpdate(paramName, portamentoMs) {
    const cfg = this.programConfig[paramName];
    if (!cfg) {
      throw new Error(`CRITICAL: Missing config for ${paramName}`);
    }

    // Preserve existing start value
    const preservedStartValue = this.peekHRGValue(paramName, "start");

    // Resolve only the end value (if cosine interpolation)
    const newEndValue = cfg.interpolation === "step"
      ? preservedStartValue // Step mode: end = start
      : this._resolveParameterValue(cfg.endValueGenerator, paramName, "end");

    console.log(
      `⚡ END-ONLY update for ${paramName}: preserving start=${preservedStartValue}, end=${newEndValue}`,
    );

    // Send targeted SET_ENV message
    this.voiceNode.port.postMessage({
      type: "SET_ENV",
      v: 1,
      param: paramName,
      startValue: preservedStartValue,
      endValue: newEndValue,
      interpolation: cfg.interpolation,
      portamentoMs: portamentoMs,
    });
  }

  // Apply base value change without re-resolving HRG (preserves ratios)
  applyBaseValueUpdate(paramName, newBaseValue, portamentoMs) {
    const cfg = this.programConfig[paramName];
    if (!cfg) {
      throw new Error(`CRITICAL: Missing config for ${paramName}`);
    }

    // Get stored HRG components (not absolute values!)
    if (!hrgState) {
      console.warn(
        `⚠️ No HRG state for ${paramName}, falling back to full resolution`,
      );
      return this.applySingleParamWithPortamento(paramName, portamentoMs);
    }

    // Recalculate frequencies using NEW base but SAME ratios
    const newStartValue = newBaseValue *
      (hrgState.start.numerator / hrgState.start.denominator);
    const newEndValue = this.isCosInterp(cfg.interpolation) && hrgState.end
      ? newBaseValue * (hrgState.end.numerator / hrgState.end.denominator)
      : newStartValue; // For step interpolation, end = start

    console.log(
      `⚡ BASE-ONLY update for ${paramName}: base=${newBaseValue}, ` +
        `start=${
          newStartValue.toFixed(3)
        } (${hrgState.start.numerator}/${hrgState.start.denominator}), ` +
        `end=${newEndValue.toFixed(3)} ${
          hrgState.end
            ? `(${hrgState.end.numerator}/${hrgState.end.denominator})`
            : "(step)"
        }`,
    );

    // Apply via AudioParam scheduling
    const resolved = {
      [paramName]: {
        startValue: newStartValue,
        endValue: newEndValue,
        interpolation: cfg.interpolation,
      },
    };

    applyResolvedProgram(this, resolved, portamentoMs);

    // Update stored state with new base and computed frequencies
    hrgState.baseValue = newBaseValue;
    hrgState.start.frequency = newStartValue;
    if (hrgState.end) {
      hrgState.end.frequency = newEndValue;
    }

    // Also update the config
    cfg.baseValue = newBaseValue;
  }

  // Apply interpolation change (may need to resolve end value)
  applyInterpolationChange(paramName, newInterpolation, portamentoMs) {
    const cfg = this.programConfig[paramName];
    if (!cfg) {
      throw new Error(`CRITICAL: Missing config for ${paramName}`);
    }

    // Preserve start value
    const preservedStartValue = this.peekHRGValue(paramName, "start");
    let endValue;

    if (newInterpolation === "step") {
      // Step mode: end = start
      endValue = preservedStartValue;
    } else {
      // Cosine mode: may need to resolve end value if not already available
      endValue = this.peekHRGValue(paramName, "end") ||
        this._resolveParameterValue(cfg.endValueGenerator, paramName, "end");
    }

    console.log(
      `⚡ INTERPOLATION change for ${paramName}: ${cfg.interpolation}→${newInterpolation}, start=${preservedStartValue}, end=${endValue}`,
    );

    // Send SET_ENV with new interpolation
    this.voiceNode.port.postMessage({
      type: "SET_ENV",
      v: 1,
      param: paramName,
      startValue: preservedStartValue,
      endValue: endValue,
      interpolation: newInterpolation,
      portamentoMs: portamentoMs,
    });
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
    } else if (this.isCosInterp(config.interpolation)) {
      const startGen = config.startValueGenerator;
      const endGen = config.endValueGenerator;
      if (!startGen) {
        throw new Error(
          `CRITICAL: Missing startValueGenerator for ${paramName}`,
        );
      }
      if (!endGen) {
        throw new Error(
          `CRITICAL: Missing endValueGenerator for disc/cont ${paramName}`,
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
      numerator = numerators[state.indexN] || numerators[0] || 1;
    } else if (numeratorBehavior === "ascending") {
      numerator = numerators[state.indexN % numerators.length];
    } else if (numeratorBehavior === "descending") {
      numerator =
        numerators[(numerators.length - 1 - state.indexN) % numerators.length];
    } else if (numeratorBehavior === "shuffle") {
      numerator = state.orderN[state.indexN % state.orderN.length];
    } else if (numeratorBehavior === "random") {
      // For random, use the stored index (last random selection)
      // If no index stored, default to first element
      numerator = numerators[state.indexN] || numerators[0] || 1;
    }

    // Get current denominator without advancing
    if (denominatorBehavior === "static") {
      denominator = denominators[state.indexD] || denominators[0] || 1;
    } else if (denominatorBehavior === "ascending") {
      denominator = denominators[state.indexD % denominators.length];
    } else if (denominatorBehavior === "descending") {
      denominator = denominators[
        (denominators.length - 1 - state.indexD) % denominators.length
      ];
    } else if (denominatorBehavior === "shuffle") {
      denominator = state.orderD[state.indexD % state.orderD.length];
    } else if (denominatorBehavior === "random") {
      // For random, use the stored index (last random selection)
      // If no index stored, default to first element
      denominator = denominators[state.indexD] || denominators[0] || 1;
    }

    const base = Number(cfg.baseValue);
    const frequency = base * (numerator / (denominator || 1));

    // Debug logging for mismatch investigation
    if (paramName === "frequency") {
      console.log(
        `🔬 peekHRGValue(${paramName}, ${position}): base=${base}, num=${numerator}, denom=${denominator}, result=${frequency}`,
      );
    }

    return frequency;
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
      const randomIndex = Math.floor(Math.random() * numerators.length);
      numerator = numerators[randomIndex];
      state.indexN = randomIndex; // Store for peekHRGValue
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
      const randomIndex = Math.floor(Math.random() * denominators.length);
      denominator = denominators[randomIndex];
      state.indexD = randomIndex; // Store for peekHRGValue
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
    const frequency = base * (numerator / (denominator || 1));

    return frequency;
  }

  // Resolve RBG value with behavior support
  _resolveRBG(generator, paramName = null, position = null, peek = false) {
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
    } else if (stateKey) {
      // Random behavior: store value for save/load
      if (peek && this.rbgState[stateKey] !== undefined) {
        // Peek mode: return existing value without generating new one
        result = this.rbgState[stateKey];
      } else {
        // Generate new value and store it
        const range = generator.range.max - generator.range.min;
        result = generator.range.min + (Math.random() * range);
        this.rbgState[stateKey] = result; // Store for peeking
        // RBG resolved (random)
      }
    } else {
      // No state key - just generate random value (backwards compat)
      const range = generator.range.max - generator.range.min;
      result = generator.range.min + (Math.random() * range);
    }

    return result;
  }

  // Apply direct value to parameter via unified messaging
  _setDirectValue(paramName, value) {
    if (this.voiceNode) {
      // Route to voice worklet via SET_ENV message
      this.voiceNode.port.postMessage({
        type: "SET_ENV",
        v: 1,
        param: paramName,
        startValue: value,
        endValue: value,
        interpolation: "step",
        portamentoMs: 15, // Convert 0.015s to ms
      });
    }

    if (this.verbose) {
      console.log(
        `🎚️ Applied direct parameter: ${paramName} = ${value} (unified messaging)`,
      );
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
            portamentoMs: 0, // Instant for re-resolve
          };
        }
      } else if (this.isCosInterp(config.interpolation)) {
        // Disc/cont interpolation - resolve start and end values
        let startValue, endValue;

        // Disc vs Cont semantics for start value
        if (config.interpolation === "cont") {
          // CONT mode: use previous end as current start (smooth morphing)
          if (config.startValueGenerator?.type === "periodic") {
            // For cont mode, we should use the previous end value
            // Since cache is removed, we need to resolve fresh
            startValue = this._resolveHRG(paramName, "start");
            console.log(
              `🔄 CONT: ${paramName} start resolved = ${startValue}`,
            );
          } else if (config.startValueGenerator?.type === "normalised") {
            // For RBG, we need to check if we have cached end value
            const cachedEndValue = this.rbgState[`${paramName}_end`];
            if (cachedEndValue !== undefined) {
              startValue = cachedEndValue;
              console.log(
                `🔄 CONT: ${paramName} start = previous RBG end = ${startValue}`,
              );
            } else {
              // Fallback to fresh resolution
              startValue = this._resolveRBG(
                config.startValueGenerator,
                paramName,
                "start",
              );
            }
          }
        } else {
          // DISC mode or first cycle: fresh resolution for start
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
        }

        if (config.endValueGenerator?.type === "periodic") {
          endValue = this._resolveHRG(paramName, "end");
        } else if (config.endValueGenerator?.type === "normalised") {
          endValue = this._resolveRBG(
            config.endValueGenerator,
            paramName,
            "end",
          );
        } else {
          throw new Error(
            `CRITICAL: Unknown end generator type for ${paramName}: ${config.endValueGenerator?.type}`,
          );
        }

        if (Number.isFinite(startValue) && Number.isFinite(endValue)) {
          resolvedParams[paramName] = {
            interpolation: config.interpolation, // Send actual interpolation mode (disc or cont)
            startValue: startValue,
            endValue: endValue,
            portamentoMs: 0, // Instant for re-resolve
          };

          // Store end values for cont mode persistence
          if (config.interpolation === "cont") {
            if (config.endValueGenerator?.type === "normalised") {
              // Store RBG end value for next cycle
              this.rbgState[`${paramName}_end`] = endValue;
              console.log(
                `💾 CONT: Stored ${paramName} RBG end value = ${endValue}`,
              );
            } else if (config.endValueGenerator?.type === "periodic") {
              // HRG values stored in hrgState already
              console.log(
                `💾 CONT: HRG ${paramName} end value = ${endValue}`,
              );
            }
          }
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
      // Special handling for range values that may be sent as JSON strings
      if (finalKey === "range" && typeof value === "string") {
        try {
          target[finalKey] = JSON.parse(value);
        } catch (e) {
          console.warn(`⚠️ Failed to parse range JSON: ${value}`);
          target[finalKey] = value; // Fall back to original value
        }
      } else {
        target[finalKey] = value;
      }
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
