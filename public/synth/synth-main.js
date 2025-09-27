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

    // Routing state management for EOC-safe scope changes
    this.currentRouting = {};  // Current active routing per parameter
    this.pendingRouting = {};  // Routing changes to apply at next EOC

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
    this.pendingCaptureBank = null;  // Bank to capture on next EOC

    // Musical brain state (main thread owns resolution)
    this.programConfig = {}; // Current program configuration from controller
    this.hrgState = {}; // HRG sequence state per parameter
    this.reresolveAtNextEOC = false; // Flag to re-randomize static HRG indices

    // Note: No persistent synth ID - using ephemeral session

    // Auto-connect to network on page load
    this.autoConnect();
  }

  /**
   * Core routing logic - the "switchboard operator"
   * Manages whether parameters come from main thread or program worklet
   */
  _updateParameterRouting(paramName, mode) {
    // Parameter routing is now handled internally by the unified worklet
    // No complex routing needed - just log for debugging
    if (this.verbose) {
      console.log(`🔌 Parameter '${paramName}' mode: ${mode} (handled by unified worklet)`);
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
      // Load unified synth worklet and white noise processor
      await this.audioContext.audioWorklet.addModule(
        "./worklets/unified-synth-worklet.js",
      );
      await this.audioContext.audioWorklet.addModule(
        "./worklets/white-noise-processor.js",
      );

      // Create unified synth worklet with 5 channels output (main + duplicate + F1 + F2 + F3)
      this.unifiedSynthNode = new AudioWorkletNode(
        this.audioContext,
        "unified-synth-worklet",
        {
          numberOfInputs: 0, // Phase input via AudioParam
          numberOfOutputs: 1,
          outputChannelCount: [5], // Main, duplicate, F1, F2, F3
        },
      );

      // Store references for backward compatibility (some methods may still reference these)
      this.voiceNode = this.unifiedSynthNode; // Main audio node
      this.programNode = this.unifiedSynthNode; // Same node handles program logic
      
      // Track current parameter values for portamento (no longer need complex routing)
      this.lastResolvedValues = {
        frequency: 440,
        zingMorph: 0,
        zingAmount: 0,
        vowelX: 0.5,
        vowelY: 0.5,
        symmetry: 0.5,
        amplitude: 0.1,
        whiteNoise: 0,
      };

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

      // Create white noise gain control
      this.whiteNoiseAudioGain = this.audioContext.createGain();
      this.whiteNoiseAudioGain.gain.value = 0; // Default to silent

      // Create mixer for combining voice and white noise
      this.mixer = this.audioContext.createGain();

      // Create channel splitter for unified synth worklet's 5 outputs
      this.voiceSplitter = this.audioContext.createChannelSplitter(5);
      this.unifiedSynthNode.connect(this.voiceSplitter);

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

      // Connect phasor worklet to unified synth worklet if both exist
      if (this.phasorWorklet && this.unifiedSynthNode) {
        this.phasorWorklet.connect(this.unifiedSynthNode.parameters.get("phase"));
        if (this.verbose) console.log("🔗 Phasor worklet connected to unified synth worklet phase parameter");
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
        console.log("🔀 RERESOLVE_AT_EOC received - will re-randomize static HRG indices at next EOC");
        this.reresolveAtNextEOC = true;
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
    
    // Ensure unified synth worklet is active
    if (this.unifiedSynthNode && this.unifiedSynthNode.parameters.has("active")) {
      this.unifiedSynthNode.parameters.get("active").value = 1;
    }
    
    // Send interpolation types and resolve values to AudioParams
    if (this.programConfig && this.unifiedSynthNode) {
      console.log("🎼 Setting parameter values and interpolation types for immediate synthesis");
      
      // Send interpolation types configuration
      const interpolationTypes = {};
      for (const [paramName, paramConfig] of Object.entries(this.programConfig)) {
        if (paramConfig.scope === "program" && paramConfig.interpolation) {
          interpolationTypes[paramName] = paramConfig.interpolation;
        }
      }
      
      this.unifiedSynthNode.port.postMessage({
        type: "SET_INTERPOLATION_TYPES",
        params: interpolationTypes
      });
      
      // Resolve and set parameter values to AudioParams immediately
      for (const [paramName, paramConfig] of Object.entries(this.programConfig)) {
        if (this.lastResolvedValues.hasOwnProperty(paramName)) {
          let startValue, endValue;
          
          if (paramConfig.scope === "direct") {
            // Use direct value for direct parameters
            startValue = endValue = paramConfig.directValue;
          } else if (paramConfig.scope === "program") {
            // Resolve program parameter values
            if (paramConfig.interpolation === "step") {
              // Step interpolation - only need start value
              startValue = this._resolveParameterValue(paramConfig.startValueGenerator, paramName, 'start');
              endValue = startValue;
            } else {
              // Cosine/other interpolation - need start and end values
              startValue = this._resolveParameterValue(paramConfig.startValueGenerator, paramName, 'start');
              endValue = paramConfig.endValueGenerator ? 
                this._resolveParameterValue(paramConfig.endValueGenerator, paramName, 'end') : 
                startValue;
            }
          }
          
          if (startValue !== undefined) {
            // Set AudioParam values directly (no ramping for immediate activation)
            const startParam = this.unifiedSynthNode.parameters.get(`${paramName}_start`);
            const endParam = this.unifiedSynthNode.parameters.get(`${paramName}_end`);
            
            if (startParam) {
              startParam.value = startValue;
              this.lastResolvedValues[paramName] = startValue;
            }
            if (endParam) {
              endParam.value = endValue;
            }
          }
        }
      }
      
      console.log("🎛️ Updated AudioParam values for immediate synthesis:", this.lastResolvedValues);
    } else {
      console.log("⚠️ No program config available for immediate synthesis");
    }
  }

  /**
   * Apply program parameters with portamento when paused
   * Resolves parameter values at current phase and applies with smooth transitions
   */
  applyProgramWithPortamento(portamentoTime) {
    if (!this.programConfig || !this.unifiedSynthNode) {
      console.log("⚠️ No program config available for portamento application");
      return;
    }

    console.log(`🎵 Applying parameter changes with ${portamentoTime}ms portamento`);
    
    // Send interpolation types configuration
    const interpolationTypes = {};
    for (const [paramName, paramConfig] of Object.entries(this.programConfig)) {
      if (paramConfig.scope === "program" && paramConfig.interpolation) {
        interpolationTypes[paramName] = paramConfig.interpolation;
      }
    }
    
    this.unifiedSynthNode.port.postMessage({
      type: "SET_INTERPOLATION_TYPES",
      params: interpolationTypes
    });
    
    // Calculate portamento duration in seconds
    const portamentoDurationSec = portamentoTime / 1000;
    const targetTime = this.audioContext.currentTime + portamentoDurationSec;
    
    // For each parameter, resolve new values and apply with AudioParam ramping
    for (const [paramName, paramData] of Object.entries(this.programConfig)) {
      if (this.lastResolvedValues.hasOwnProperty(paramName)) {
        let startValue, endValue;
        
        if (paramData.scope === "direct") {
          // Use direct value for direct parameters
          startValue = endValue = paramData.directValue;
        } else if (paramData.scope === "program") {
          // Resolve program parameter values
          if (paramData.interpolation === "step") {
            // Step interpolation - only need start value
            startValue = this._resolveParameterValue(paramData.startValueGenerator, paramName, 'start');
            endValue = startValue;
          } else {
            // Cosine/other interpolation - need start and end values
            startValue = this._resolveParameterValue(paramData.startValueGenerator, paramName, 'start');
            endValue = paramData.endValueGenerator ? 
              this._resolveParameterValue(paramData.endValueGenerator, paramName, 'end') : 
              startValue;
          }
        }
        
        if (startValue !== undefined) {
          const startParam = this.unifiedSynthNode.parameters.get(`${paramName}_start`);
          const endParam = this.unifiedSynthNode.parameters.get(`${paramName}_end`);
          
          if (startParam) {
            // Get current value as starting point for ramping
            const currentValue = this.lastResolvedValues[paramName] || startParam.value || 440;
            
            // Set starting point for ramp
            startParam.setValueAtTime(currentValue, this.audioContext.currentTime);
            
            // Use exponential ramping for frequency (if > 0), linear for normalized parameters
            if (paramName === 'frequency' && startValue > 0 && currentValue > 0) {
              startParam.exponentialRampToValueAtTime(startValue, targetTime);
            } else {
              startParam.linearRampToValueAtTime(startValue, targetTime);
            }
            
            console.log(`🎵 Portamento ${paramName}: ${currentValue.toFixed(3)} → ${startValue.toFixed(3)} over ${portamentoTime}ms`);
            this.lastResolvedValues[paramName] = startValue;
          }
          
          if (endParam) {
            // Get current end value as starting point
            const currentEndValue = endParam.value || endValue;
            
            // Set starting point for end parameter ramp
            endParam.setValueAtTime(currentEndValue, this.audioContext.currentTime);
            
            if (paramName === 'frequency' && endValue > 0 && currentEndValue > 0) {
              endParam.exponentialRampToValueAtTime(endValue, targetTime);
            } else {
              endParam.linearRampToValueAtTime(endValue, targetTime);
            }
          }
        }
      }
    }
  }

  // _resolveParameterAtPhase method removed - using AudioParams directly

  handleProgramUpdate(message) {
    if (this.verbose) console.log("📨 PROGRAM_UPDATE received:", message);
    
    if (!this.voiceNode || !this.programNode) {
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
    }

    for (const paramName in message) {
      // Skip non-parameter fields
      if (
        ["type", "timestamp", "synthesisActive", "isManualMode", "portamentoTime"].includes(
          paramName,
        )
      ) continue;

      const paramData = message[paramName];

      // Store parameter config
      this.programConfig[paramName] = paramData;

      // Handle discriminated union format based on scope
      if (paramData.scope === "direct") {
        // Stage routing change if different from current
        const desiredMode = 'direct';
        if (this.currentRouting[paramName] !== desiredMode) {
          this.pendingRouting[paramName] = desiredMode;
          console.log(`📋 Staging routing change: ${paramName} → ${desiredMode} (at next EOC)`);
        }

        // Apply direct value immediately
        this._setDirectValue(paramName, paramData.directValue);
        
      } else if (paramData.scope === "program") {
        // Stage routing change if different from current
        const desiredMode = 'program';
        if (this.currentRouting[paramName] !== desiredMode) {
          this.pendingRouting[paramName] = desiredMode;
          console.log(`📋 Staging routing change: ${paramName} → ${desiredMode} (at next EOC)`);
        }

        // Initialize HRG state for periodic generators
        this._initializeHRGState(paramName, paramData);
        
        if (this.verbose) {
          console.log(`🎼 ${paramData.interpolation} interpolation for ${paramName}`);
        }
      }
    }

    console.log("✅ Program config stored in main thread, HRG states initialized");
    
    // If synthesis is active, handle audio output based on whether portamento is requested
    if (this.synthesisActive) {
      if (hasPortamento) {
        // Apply program parameters with portamento (for paused updates)
        console.log(`🎵 Applying program update with ${message.portamentoTime}ms portamento`);
        this.applyProgramWithPortamento(message.portamentoTime);
      } else {
        // Immediate synthesis (for initial activation or when playing)
        this.activateImmediateSynthesis();
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
    this.receivedIsPlaying = message.isPlaying !== undefined ? message.isPlaying : true; // Default to true for backward compatibility
    this.lastPhasorMessage = performance.now();

    // Calculate phasor rate
    this.phasorRate = 1.0 / this.receivedCycleLength;

    // Update phasor worklet parameters
    if (this.phasorWorklet) {
      this.phasorWorklet.parameters.get('cycleLength').value = this.receivedCycleLength;
      this.phasorWorklet.parameters.get('stepsPerCycle').value = this.receivedStepsPerCycle;
      
      // Control phasor playback based on global playing state
      if (this.receivedIsPlaying) {
        this.phasorWorklet.port.postMessage({ type: "start" });
      } else {
        this.phasorWorklet.port.postMessage({ type: "stop" });
      }
    }

    // Store official timing and start look-ahead scheduler if needed
    if (this.programNode) {
      const periodDisplay = message.cpm ? `${message.cpm} CPM` : `${this.receivedCycleLength}s period`;
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

      // Connect phasor worklet output to unified synth worklet phase parameter
      if (this.unifiedSynthNode) {
        this.phasorWorklet.connect(this.unifiedSynthNode.parameters.get("phase"));
        if (this.verbose) console.log("🔗 Phasor worklet connected to unified synth worklet phase parameter");
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

    // Handle re-resolve request (re-randomize static HRG indices)
    if (this.reresolveAtNextEOC) {
      console.log(`🔀 Re-randomizing static HRG indices at EOC`);
      for (const [param, hrgData] of Object.entries(this.hrgState)) {
        if (hrgData.start?.numeratorBehavior === 'static') {
          const numerators = hrgData.start.numerators;
          hrgData.start.indexN = Math.floor(Math.random() * numerators.length);
          console.log(`🎲 ${param} numerator: new static index ${hrgData.start.indexN} (value: ${numerators[hrgData.start.indexN]})`);
        }
        if (hrgData.start?.denominatorBehavior === 'static') {
          const denominators = hrgData.start.denominators;
          hrgData.start.indexD = Math.floor(Math.random() * denominators.length);
          console.log(`🎲 ${param} denominator: new static index ${hrgData.start.indexD} (value: ${denominators[hrgData.start.indexD]})`);
        }
      }
      this.reresolveAtNextEOC = false;
    }

    // Resolve values for this cycle (main thread is the musical brain)
    const stepValues = {};
    const cosSegments = {};

    for (const [param, config] of Object.entries(this.programConfig)) {
      if (config.scope === 'program') {
        if (config.interpolation === 'step') {
          // Step interpolation - resolve single value
          if (config.startValueGenerator?.type === 'periodic') {
            // HRG - use sequence state
            stepValues[param] = this._resolveHRG(param, 'start');
          } else if (config.startValueGenerator?.type === 'normalised') {
            // RBG - resolve scalar
            stepValues[param] = this._resolveRBG(config.startValueGenerator);
          }
        } else if (config.interpolation === 'cosine') {
          // Cosine interpolation - resolve start and end values
          let startValue, endValue;
          
          if (config.startValueGenerator?.type === 'periodic') {
            startValue = this._resolveHRG(param, 'start');
          } else if (config.startValueGenerator?.type === 'normalised') {
            startValue = this._resolveRBG(config.startValueGenerator);
          } else {
            startValue = config.startValueGenerator?.value || 0;
          }

          if (config.endValueGenerator?.type === 'periodic') {
            endValue = this._resolveHRG(param, 'end');
          } else if (config.endValueGenerator?.type === 'normalised') {
            endValue = this._resolveRBG(config.endValueGenerator);
          } else {
            endValue = config.endValueGenerator?.value || startValue;
          }

          cosSegments[param] = { start: startValue, end: endValue };
        }
      }
    }

    // Log resolved values for debugging
    if (Object.keys(stepValues).length > 0) {
      console.log(`[EOC] stepValues:`, stepValues);
      // Specific frequency step scalar logging
      if ('frequency' in stepValues) {
        console.log(`[EOC] frequency step scalar: ${stepValues.frequency}`);
      }
    }
    if (Object.keys(cosSegments).length > 0) {
      console.log(`[EOC] cosSegments:`, cosSegments);
    }

    // Send values to worklet
    if (Object.keys(stepValues).length > 0) {
      this.programNode.port.postMessage({
        type: 'SET_STEP_VALUES',
        params: stepValues
      });
    }

    if (Object.keys(cosSegments).length > 0) {
      this.programNode.port.postMessage({
        type: 'SET_COS_SEGMENTS',
        params: cosSegments
      });
    }

    // Handle scene loading and routing (simplified)
    if (this.pendingSceneState) {
      const snapshot = this.pendingSceneState;
      this.pendingSceneState = null;
      
      // Apply direct values for snapshot params
      for (const [param, value] of Object.entries(snapshot)) {
        this._setDirectValue(param, value);
      }
      
      console.log(`📋 Applied scene snapshot:`, snapshot);
    }

    // Apply any pending routing changes
    if (Object.keys(this.pendingRouting).length > 0) {
      for (const [paramName, mode] of Object.entries(this.pendingRouting)) {
        this._updateParameterRouting(paramName, mode);
        this.currentRouting[paramName] = mode;
      }
      this.pendingRouting = {};
    }

    // Capture scene if requested
    if (this.pendingCaptureBank !== null) {
      this.captureScene(this.pendingCaptureBank);
      this.pendingCaptureBank = null;
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

  handleSaveScene(payload) {
    console.log(`💾 Will capture scene ${payload.memoryLocation} at next EOC`);
    this.pendingCaptureBank = payload.memoryLocation;
  }

  captureScene(bank) {
    const snapshot = {};
    const sequences = {};
    
    // Capture minimal scene state based on parameter mode and generator type
    for (const param of ['frequency', 'vowelX', 'vowelY', 'zingAmount', 
                          'zingMorph', 'symmetry', 'amplitude', 'whiteNoise']) {
      const paramConfig = this.programConfig[param];
      
      if (!paramConfig || paramConfig.scope === 'direct') {
        // Direct mode - capture scalar value
        let value;
        if (param === 'whiteNoise') {
          value = this.whiteNoiseAudioGain?.gain.value || 0;
        } else {
          const key = `${param}_in`;
          if (this.voiceNode?.parameters.has(key)) {
            value = this.voiceNode.parameters.get(key).value;
          }
        }
        
        if (value !== undefined) {
          snapshot[param] = value;
        }
        
      } else if (paramConfig.scope === 'program' && paramConfig.interpolation === 'step') {
        // Program step mode - check generator type
        if (paramConfig.startValueGenerator?.type === 'periodic') {
          // HRG - save sequence state (not values)
          const hrgState = this.hrgState[param]?.start;
          if (hrgState) {
            sequences[param] = {
              numeratorBehavior: hrgState.numeratorBehavior,
              denominatorBehavior: hrgState.denominatorBehavior,
              indexN: hrgState.indexN,
              indexD: hrgState.indexD,
              orderN: hrgState.orderN,
              orderD: hrgState.orderD
            };
          }
        } else if (paramConfig.startValueGenerator?.type === 'normalised') {
          // RBG - determine if stat or rand mode
          const generator = paramConfig.startValueGenerator;
          if (typeof generator.range === 'number') {
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
    
    console.log(`[SCENE] saved to memory slot ${bank}, sequences.frequency:`, sequences.frequency, `snapshot.frequency:`, snapshot.frequency);
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
        if (!["type", "timestamp", "synthesisActive", "isManualMode"].includes(paramName)) {
          this.programConfig[paramName] = program[paramName];
        }
      }
    }
    
    if (saved) {
      const { snapshot, sequences } = saved;
      
      console.log(`[SCENE] load from memory slot ${memoryLocation}, snapshotKeys:`, Object.keys(snapshot), `hasHRG:`, Object.keys(sequences).length > 0);
      
      // Initialize HRG state - but only for params without saved sequences
      for (const paramName in this.programConfig) {
        if (sequences[paramName]) {
          // Use saved sequence data to restore complete HRG state
          this._restoreHRGState(paramName, sequences[paramName], this.programConfig[paramName]);
          
          // Detailed frequency HRG state logging
          if (paramName === 'frequency') {
            const hrgState = this.hrgState[paramName]?.start;
            console.log(`[LOAD_SCENE] frequency HRG state - behavior: ${hrgState.numeratorBehavior}/${hrgState.denominatorBehavior}, index: ${hrgState.indexN}/${hrgState.indexD}, arrays: [${hrgState.numerators?.slice(0,3).join(',')}...] / [${hrgState.denominators?.slice(0,3).join(',')}...]`);
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
          console.log(`⚡ Applying scene snapshot immediately (paused):`, snapshot);
          for (const [param, value] of Object.entries(snapshot)) {
            // Use portamento for smooth transitions when paused
            const portamentoTime = 100; // Default portamento time
            this.applyWithPortamento(param, value, portamentoTime);
          }
        }
      }
    } else {
      console.log(`[SCENE] load, no data in memory slot ${memoryLocation} - initializing fresh`);
      // No saved scene - initialize fresh HRG state with per-synth randomization
      for (const paramName in this.programConfig) {
        this._initializeHRGState(paramName, this.programConfig[paramName]);
      }
    }
  }

  clearAllBanks() {
    // Clear all in-memory scene snapshots
    const clearedCount = this.sceneSnapshots.filter(s => s).length;
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
    if (!this.phasorWorklet) return;

    switch (message.action) {
      case 'play':
        this.phasorWorklet.port.postMessage({ type: 'start' });
        
        if (this.isPaused) {
          // Resume from paused position
          console.log(`🎯 Resuming from paused phase: ${this.pausedPhase}`);
          const phaseParam = this.programNode.parameters.get("phase");
          const currentTime = this.audioContext.currentTime;
          const remainingCycleTime = (1.0 - this.pausedPhase) * this.receivedCycleLength;
          
          phaseParam.cancelScheduledValues(currentTime);
          phaseParam.setValueAtTime(this.pausedPhase, currentTime);
          phaseParam.linearRampToValueAtTime(1.0, currentTime + remainingCycleTime);
          
          this.isPaused = false;
        } else if (this.receivedPhasor === 0.0 || this.receivedPhasor === undefined) {
          // Starting from beginning
          console.log("🎯 Starting from phase 0.0 - triggering immediate cycle reset");
          this.triggerImmediateCycleReset();
        }
        break;
        
      case 'pause':
        this.phasorWorklet.port.postMessage({ type: 'stop' });
        this.pauseEnvelopes();
        break;
        
      case 'stop':
        this.phasorWorklet.port.postMessage({ type: 'stop' });
        this.phasorWorklet.port.postMessage({ type: 'reset' });
        this.stopEnvelopes();
        break;
    }
  }

  handleJumpToEOC(message) {
    console.log("🎮 Jump to EOC / Reset");
    if (this.phasorWorklet) {
      this.phasorWorklet.port.postMessage({ type: 'reset' });
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
      blockSize: 128
    };
    
    // Call handleCycleReset to start envelopes immediately
    this.handleCycleReset(resetData);
  }

  handleUnifiedParamUpdate(message) {
    const statusIcon = message.isPlaying ? "📋*" : "⚡";
    console.log(`${statusIcon} Unified param update: ${message.param} = ${message.startValue}${message.endValue !== undefined ? ` → ${message.endValue}` : ''}`);
    
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
    } else {
      // Paused/stopped: Apply immediately at current phase with portamento
      console.log(`⚡ Applying ${message.param} immediately with ${message.portamentoTime}ms portamento`);
      this.applyParameterUpdate(
        message.param, 
        message.startValue, 
        message.endValue, 
        message.interpolation, 
        message.portamentoTime,
        message.currentPhase
      );
    }
  }

  applyParameterUpdate(param, startValue, endValue, interpolation, portamentoTime = 0, currentPhase = null) {
    if (!this.programNode) return;

    const phaseParam = this.programNode.parameters.get("phase");
    const phase = currentPhase !== null ? currentPhase : phaseParam.value;
    
    if (interpolation === "step") {
      // Step interpolation - use constant value with portamento
      if (portamentoTime > 0) {
        this.applyWithPortamento(param, startValue, portamentoTime);
      } else {
        this.programNode.port.postMessage({
          type: "SET_STEP_VALUES",
          params: { [param]: startValue }
        });
      }
    } else if (!this.isPlaying && endValue !== undefined) {
      // Paused with cosine interpolation - calculate interpolated value at current phase
      const shapedProgress = 0.5 - Math.cos(phase * Math.PI) * 0.5;
      const interpolatedValue = startValue + (endValue - startValue) * shapedProgress;
      
      console.log(`🎯 Interpolating ${param} at phase ${phase.toFixed(3)}: ${startValue} → ${endValue} = ${interpolatedValue.toFixed(3)}`);
      
      if (portamentoTime > 0) {
        this.applyWithPortamento(param, interpolatedValue, portamentoTime);
      } else {
        this.programNode.port.postMessage({
          type: "SET_INTERPOLATED_VALUE",
          param: param,
          value: interpolatedValue
        });
      }
    } else {
      // Playing with cosine interpolation - set up envelope for next cycle
      if (endValue !== undefined) {
        this.programNode.port.postMessage({
          type: "SET_COS_SEGMENTS", 
          params: { 
            [param]: { 
              start: startValue, 
              end: endValue 
            } 
          }
        });
      }
    }
  }

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
    
    for (const [paramName, value] of Object.entries(resolvedState)) {
      const v = Number.isFinite(value) ? value : 0;
      
      // Always route snapshot values to direct
      const desiredMode = "direct";
      if (this.currentRouting[paramName] !== desiredMode) {
        this.pendingRouting[paramName] = desiredMode;
        if (this.verbose) console.log(`📋 Scene staging routing: ${paramName} → direct`);
      }
      
      // Set the value
      if (paramName === "whiteNoise") {
        if (this.whiteNoiseAudioGain) {
          this.whiteNoiseAudioGain.gain.setTargetAtTime(v, this.audioContext.currentTime, 0.015);
          if (this.whiteNoiseVizGain) {
            this.whiteNoiseVizGain.gain.setTargetAtTime(v, this.audioContext.currentTime, 0.015);
          }
          if (this.verbose) console.log(`🎚️ Scene apply: whiteNoise -> ${v}`);
        }
      } else if (this.voiceNode) {
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

    // Ensure synthesis is active if desired
    if (this.voiceNode && this.voiceNode.parameters.has("active")) {
      const activeParam = this.voiceNode.parameters.get("active");
      activeParam.value = this.synthesisActive ? 1 : 0;
      if (this.verbose) {
        console.log(`🔈 Voice active = ${this.synthesisActive ? 1 : 0}`);
      }
    }
  }

  applyResolvedStateValues(resolvedState) {
    if (this.verbose) {
      console.log("🧩 Applying resolved scene values:", resolvedState);
    }
    
    for (const [paramName, value] of Object.entries(resolvedState)) {
      const v = Number.isFinite(value) ? value : 0;
      
      // Just set the value - routing was already handled
      if (paramName === "whiteNoise") {
        if (this.whiteNoiseAudioGain) {
          this.whiteNoiseAudioGain.gain.setTargetAtTime(v, this.audioContext.currentTime, 0.015);
          if (this.whiteNoiseVizGain) {
            this.whiteNoiseVizGain.gain.setTargetAtTime(v, this.audioContext.currentTime, 0.015);
          }
          if (this.verbose) console.log(`🎚️ Scene apply: whiteNoise -> ${v}`);
        }
      } else if (this.voiceNode) {
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
    
    // Ensure synthesis is active if desired
    if (this.voiceNode && this.voiceNode.parameters.has("active")) {
      const activeParam = this.voiceNode.parameters.get("active");
      activeParam.value = this.synthesisActive ? 1 : 0;
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
    if (!generator || generator.type !== 'periodic') return;

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
        indexN: numeratorBehavior === 'static' ? Math.floor(Math.random() * numerators.length) : 0,
        indexD: denominatorBehavior === 'static' ? Math.floor(Math.random() * denominators.length) : 0,
        orderN: numeratorBehavior === 'shuffle' ? this._shuffleArray([...numerators]) : null,
        orderD: denominatorBehavior === 'shuffle' ? this._shuffleArray([...denominators]) : null
      }
    };

    // Initialize end state if cosine interpolation
    if (config.interpolation === 'cosine' && config.endValueGenerator?.type === 'periodic') {
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
        indexN: endNumBehavior === 'static' ? Math.floor(Math.random() * endNumerators.length) : 0,
        indexD: endDenBehavior === 'static' ? Math.floor(Math.random() * endDenominators.length) : 0,
        orderN: endNumBehavior === 'shuffle' ? this._shuffleArray([...endNumerators]) : null,
        orderD: endDenBehavior === 'shuffle' ? this._shuffleArray([...endDenominators]) : null
      };
    }
  }

  // Restore HRG state from saved sequence data (preserves per-synth uniqueness)
  _restoreHRGState(param, seqState, config) {
    const generator = config.startValueGenerator;
    if (!generator || generator.type !== 'periodic') return;

    // Use saved behaviors if available, otherwise fall back to config
    const numeratorBehavior = seqState.numeratorBehavior || generator.numeratorBehavior || "static";
    const denominatorBehavior = seqState.denominatorBehavior || generator.denominatorBehavior || "static";

    // For shuffle behavior, the saved orderN/orderD ARE the arrays to use
    // For other behaviors, parse from config but use saved indices
    let numerators, denominators;

    if (numeratorBehavior === 'shuffle' && seqState.orderN) {
      numerators = seqState.orderN; // Use saved shuffled array
    } else {
      numerators = this._parseSIN(generator.numerators || "1");
    }

    if (denominatorBehavior === 'shuffle' && seqState.orderD) {
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
        orderD: seqState.orderD
      }
    };

    // Initialize end state if cosine interpolation
    if (config.interpolation === 'cosine' && config.endValueGenerator?.type === 'periodic') {
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
        indexN: endNumBehavior === 'static' ? Math.floor(Math.random() * endNumerators.length) : 0,
        indexD: endDenBehavior === 'static' ? Math.floor(Math.random() * endDenominators.length) : 0,
        orderN: endNumBehavior === 'shuffle' ? this._shuffleArray([...endNumerators]) : null,
        orderD: endDenBehavior === 'shuffle' ? this._shuffleArray([...endDenominators]) : null
      };
    }

    console.log(`🔄 Restored HRG state for ${param} using saved sequences - behavior: ${numeratorBehavior}/${denominatorBehavior}, index: ${seqState.indexN}/${seqState.indexD}`);
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
    if (!generator) return this.lastResolvedValues[paramName] || 440;
    
    if (generator.type === 'periodic') {
      // HRG - use sequence state
      return this._resolveHRG(paramName, position);
    } else if (generator.type === 'normalised') {
      // RBG - resolve scalar
      return this._resolveRBG(generator);
    } else if (generator.value !== undefined) {
      // Direct value
      return generator.value;
    } else {
      // Fallback
      return this.lastResolvedValues[paramName] || 440;
    }
  }

  // Resolve HRG value and advance sequence
  _resolveHRG(param, position = 'start') {
    const state = this.hrgState[param]?.[position];
    if (!state) return 440; // Default frequency

    const { numerators, denominators, numeratorBehavior, denominatorBehavior } = state;
    
    // Get current values
    let numerator, denominator;
    
    if (numeratorBehavior === 'static') {
      numerator = numerators[state.indexN];
    } else if (numeratorBehavior === 'ascending') {
      numerator = numerators[state.indexN % numerators.length];
      state.indexN++;
    } else if (numeratorBehavior === 'descending') {
      numerator = numerators[(numerators.length - 1 - state.indexN) % numerators.length];
      state.indexN++;
    } else if (numeratorBehavior === 'shuffle') {
      numerator = state.orderN[state.indexN % state.orderN.length];
      state.indexN++;
      if (state.indexN >= state.orderN.length) {
        state.orderN = this._shuffleArray([...numerators]);
        state.indexN = 0;
      }
    } else if (numeratorBehavior === 'random') {
      numerator = numerators[Math.floor(Math.random() * numerators.length)];
    }

    if (denominatorBehavior === 'static') {
      denominator = denominators[state.indexD];
    } else if (denominatorBehavior === 'ascending') {
      denominator = denominators[state.indexD % denominators.length];
      state.indexD++;
    } else if (denominatorBehavior === 'descending') {
      denominator = denominators[(denominators.length - 1 - state.indexD) % denominators.length];
      state.indexD++;
    } else if (denominatorBehavior === 'shuffle') {
      denominator = state.orderD[state.indexD % state.orderD.length];
      state.indexD++;
      if (state.indexD >= state.orderD.length) {
        state.orderD = this._shuffleArray([...denominators]);
        state.indexD = 0;
      }
    } else if (denominatorBehavior === 'random') {
      denominator = denominators[Math.floor(Math.random() * denominators.length)];
    }

    const baseValue = this.programConfig[param]?.startValueGenerator?.baseValue || 440;
    return baseValue * (numerator / (denominator || 1));
  }

  // Resolve RBG value
  _resolveRBG(generator) {
    if (typeof generator.range === "number") {
      return generator.range;
    } else if (generator.range && typeof generator.range === "object") {
      const range = generator.range.max - generator.range.min;
      return generator.range.min + (Math.random() * range);
    }
    return Math.random() * 0.5;
  }

  // Apply direct value to parameter
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
    } else if (this.voiceNode?.parameters.has(`${paramName}_in`)) {
      const audioParam = this.voiceNode.parameters.get(`${paramName}_in`);
      audioParam.setTargetAtTime(
        value,
        this.audioContext.currentTime,
        0.015,
      );
    }
    
    if (this.verbose) {
      console.log(`🎚️ Applied direct parameter: ${paramName} = ${value}`);
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
