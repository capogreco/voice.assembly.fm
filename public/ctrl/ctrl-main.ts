/**
 * Voice.Assembly.FM Control Client Main Application
 */

import { generatePeerId, WebRTCStar } from "../../src/common/webrtc-star.js";
import {
  MessageBuilder,
  MessageTypes,
} from "../../src/common/message-protocol.js";
import {
  GeneratorConfig,
  IMusicalState,
  ParameterState,
} from "../../src/common/parameter-types.ts";

// Define action types for state management
type ControlAction =
  | {
    type: "SET_SCOPE";
    param: keyof IMusicalState;
    scope: "direct" | "program";
  }
  | { type: "SET_DIRECT_VALUE"; param: keyof IMusicalState; value: number }
  | {
    type: "SET_INTERPOLATION";
    param: keyof IMusicalState;
    interpolation: "step" | "cosine";
  }
  | {
    type: "SET_GENERATOR_CONFIG";
    param: keyof IMusicalState;
    position: "start" | "end";
    config: GeneratorConfig;
  };

class ControlClient {
  // Typed state management
  musicalState: IMusicalState;
  pendingMusicalState: IMusicalState;
  star: any; // WebRTC star connection
  forceTakeover: boolean;
  peerId: string;
  phasor: number;
  periodSec: number;
  stepsPerCycle: number;
  cycleLength: number;
  lastPhasorTime: number;
  phasorUpdateId: any;
  lastBroadcastTime: number;
  phasorBroadcastRate: number;
  audioContext: any;
  es8Enabled: boolean;
  es8Node: any;
  hasPendingChanges: boolean;
  elements: any;
  synthesisActive: boolean;

  private _createDefaultState(): IMusicalState {
    // Helper for a default normalised generator
    const defaultNormalisedGenerator = (): GeneratorConfig => ({
      type: "normalised",
      range: 0.5,
      sequenceBehavior: "static",
    });

    // Helper for a default periodic generator
    const defaultPeriodicGenerator = (): GeneratorConfig => ({
      type: "periodic",
      numerators: "1",
      denominators: "1",
      sequenceBehavior: "static",
    });

    // Helper for a default direct state
    const defaultDirectState = (value: number): ParameterState => ({
      scope: "direct",
      directValue: value,
    });

    // Helper for program mode with cosine 0-1
    const defaultProgramState = (): ParameterState => ({
      scope: "program",
      interpolation: "cosine",
      startValueGenerator: {
        type: "normalised",
        range: { min: 0, max: 1 },
        sequenceBehavior: "static",
      },
      endValueGenerator: {
        type: "normalised",
        range: { min: 0, max: 1 },
        sequenceBehavior: "static",
      },
    });

    return {
      frequency: { scope: "direct", directValue: 220 },
      vowelX: defaultProgramState(),
      vowelY: defaultProgramState(),
      zingAmount: defaultProgramState(),
      zingMorph: defaultProgramState(),
      symmetry: defaultProgramState(),
      amplitude: defaultDirectState(0.8),
      whiteNoise: defaultDirectState(0),
    };
  }

  private _updatePendingState(action: ControlAction) {
    console.log("Action dispatched:", action);

    // Create a deep copy of current pending state
    const newState = JSON.parse(JSON.stringify(this.pendingMusicalState));

    switch (action.type) {
      case "SET_SCOPE": {
        if (action.scope === "direct") {
          // Convert to direct mode - set to null to signal blank and focus input
          newState[action.param] = {
            scope: "direct",
            directValue: null,
          };
        } else {
          // Convert to program mode - preserve current directValue for baseValue
          const currentParam = newState[action.param];
          const directValue = currentParam.scope === "direct"
            ? currentParam.directValue
            : (action.param === "frequency" ? 220 : 0.5); // Fallback defaults

          newState[action.param] = {
            scope: "program",
            interpolation: "step", // Default to step (constant values)
            directValue, // Preserve for use as baseValue
            startValueGenerator: action.param === "frequency"
              ? {
                type: "periodic",
                numerators: "1",
                denominators: "1",
                sequenceBehavior: "static",
                baseValue: directValue,
              }
              : { type: "normalised", range: 0.5, sequenceBehavior: "static" },
          };
        }
        break;
      }

      case "SET_DIRECT_VALUE": {
        const param = newState[action.param];
        if (param.scope === "direct") {
          param.directValue = action.value;
        }
        break;
      }

      case "SET_INTERPOLATION": {
        const param = newState[action.param];
        if (param.scope === "program") {
          if (action.interpolation === "step") {
            // Step interpolation - only needs start generator
            newState[action.param] = {
              scope: "program",
              interpolation: "step",
              directValue: param.directValue,
              startValueGenerator: param.startValueGenerator,
            };
          } else {
            // Linear/cosine/parabolic interpolation - needs start and end generators
            newState[action.param] = {
              scope: "program",
              interpolation: action.interpolation,
              directValue: param.directValue,
              startValueGenerator: param.startValueGenerator,
              endValueGenerator: param.endValueGenerator || {
                ...param.startValueGenerator, // Copy start generator as default
              },
            };
          }
        }
        break;
      }

      case "SET_GENERATOR_CONFIG": {
        const param = newState[action.param];
        if (param.scope === "program") {
          if (action.position === "start") {
            // Merge config properties into existing generator
            param.startValueGenerator = {
              ...param.startValueGenerator,
              ...action.config,
            };
            // Update baseValue if this is a periodic generator
            if (param.startValueGenerator.type === "periodic") {
              param.startValueGenerator.baseValue = param.directValue;
            }
          } else if (
            action.position === "end" && param.interpolation !== "step" &&
            param.endValueGenerator
          ) {
            // Merge config properties into existing generator
            param.endValueGenerator = {
              ...param.endValueGenerator,
              ...action.config,
            };
            // Update baseValue if this is a periodic generator
            if (param.endValueGenerator.type === "periodic") {
              param.endValueGenerator.baseValue = param.directValue;
            }
          }
        }
        break;
      }
    }

    this.pendingMusicalState = newState;

    // Update UI to reflect the state change
    if (action.param) {
      this._updateUIFromState(action.param);
    }

    this.markPendingChanges();
  }

  /**
   * Apply a single direct parameter immediately and broadcast it
   * Used for immediate feedback when user leaves an input field in direct mode
   */
  private _applyDirectParameter(param: keyof IMusicalState) {
    const paramState = this.pendingMusicalState[param];

    // Only proceed if parameter is in direct mode
    if (paramState.scope !== "direct") {
      return;
    }

    // Commit this parameter from pending to main state
    this.musicalState[param] = JSON.parse(JSON.stringify(paramState));

    // Log for debugging
    console.log(
      `📍 Applying direct parameter: ${param} = ${paramState.directValue}`,
    );
    this.log(`Direct broadcast: ${param} = ${paramState.directValue}`, "info");

    // Broadcast just this parameter update using dedicated message type
    if (this.star) {
      const message = MessageBuilder.directParamUpdate(
        param,
        paramState.directValue,
      );
      this.star.broadcastToType("synth", message, "control");
    }
  }

  constructor() {
    console.log("ControlClient constructor starting");
    // Check for force takeover mode
    const urlParams = new URLSearchParams(globalThis.location.search);
    this.forceTakeover = urlParams.get("force") === "true";

    this.peerId = generatePeerId("ctrl");
    this.star = null;
    // Moved to this.synthesisActive (defined in state management section)

    // Phasor state
    this.phasor = 0.0; // Current phasor position (0.0 to 1.0)
    this.isPlaying = false; // Global transport state - starts paused
    this.periodSec = 2.0; // Period in seconds (default 2.0)
    this.stepsPerCycle = 16; // Number of steps per cycle
    this.cycleLength = 2.0; // Seconds per cycle (same as periodSec)
    this.lastPhasorTime = 0; // For delta time calculation
    this.phasorUpdateId = null; // RequestAnimationFrame ID
    this.lastBroadcastTime = 0; // For phasor broadcast rate limiting
    this.phasorBroadcastRate = 30; // Hz - how often to broadcast phasor

    // EOC-staged timing changes
    this.pendingPeriodSec = null; // Pending period change
    this.pendingStepsPerCycle = null; // Pending steps change
    this.applyTimingAtEOC = true; // Apply timing changes at EOC flag

    // ES-8 Integration
    this.audioContext = null; // AudioContext for ES-8 CV output
    this.es8Enabled = false; // Enable/disable ES-8 output
    this.es8Node = null; // ES-8 AudioWorklet node

    // Parameter staging for EOC application
    this.hasPendingChanges = false; // Track if there are pending parameter changes

    // Centralized State Management - replaced old program/directState with typed state

    // Synthesis active state
    this.synthesisActive = false;

    // Initialize typed state management
    this.musicalState = this._createDefaultState();
    this.pendingMusicalState = this._createDefaultState();

    // UI Elements
    this.elements = {
      connectionStatus: document.getElementById("connection-status"),
      connectionValue: document.getElementById("connection-status"), // Same element as connectionStatus
      synthesisStatus: document.getElementById("synthesis-status"),
      // Removed peers status - now using synth count in connected synths panel

      takeoverSection: document.getElementById("takeover-section"),
      takeoverBtn: document.getElementById("force-takeover-btn"),

      manualModeBtn: document.getElementById("manual-mode-btn"),

      // Musical controls
      // Simplified musical controls
      frequencyValue: document.getElementById("frequency-value"),

      // Phasor controls
      periodInput: document.getElementById("period-seconds"),
      stepsInput: document.getElementById("steps-per-cycle"),
      applyTempoAtEOCCheckbox: document.getElementById("apply-tempo-at-eoc"),
      
      // Transport controls
      playBtn: document.getElementById("play-btn"),
      pauseBtn: document.getElementById("pause-btn"),
      stopBtn: document.getElementById("stop-btn"),
      jumpEOCBtn: document.getElementById("jump-eoc-btn"),
      stepsPerCycleSlider: document.getElementById("steps-per-cycle-slider"),
      stepsPerCycleValue: document.getElementById("steps-per-cycle-value"),
      phasorDisplay: document.getElementById("phasor-display"),
      phasorBar: document.getElementById("phasor-bar"),
      phasorTicks: document.getElementById("phasor-ticks"),

      // ES-8 controls
      es8EnableBtn: document.getElementById("es8-enable-btn"),

      // Parameter controls
      applyParamsBtn: document.getElementById("apply-params-btn"),
      reresolveBtn: document.getElementById("reresolve-btn"),

      peerList: document.getElementById("peer-list"),
      synthCount: document.getElementById("synth-count"),
      debugLog: document.getElementById("debug-log"),
      clearLogBtn: document.getElementById("clear-log-btn"), // Note: removed from layout
      
      // Scene memory
      clearBanksBtn: document.getElementById("clear-banks-btn"),
    };

    console.log("applyParamsBtn element:", this.elements.applyParamsBtn);
    console.log("reresolveBtn element:", this.elements.reresolveBtn);

    this.setupEventHandlers();
    this.calculateCycleLength();
    this.initializePhasor();
    this.log("Control client initialized", "info");

    // Auto-connect on page load
    this.connectToNetwork();
  }

  setupEventHandlers() {
    console.log(
      "Setting up handlers, button exists:",
      !!this.elements.applyParamsBtn,
    );

    // Manual mode (button doesn't exist in current layout)
    if (this.elements.manualModeBtn) {
      this.elements.manualModeBtn.addEventListener(
        "click",
        () => this.toggleSynthesis(),
      );
    }

    // Takeover button
    this.elements.takeoverBtn.addEventListener("click", () => {
      if (confirm("Take control from the current active controller?")) {
        const currentUrl = globalThis.location.href.split("?")[0];
        globalThis.location.href = currentUrl + "?force=true";
      }
    });

    // Debug log
    // Clear log button (removed from layout)
    if (this.elements.clearLogBtn) {
      this.elements.clearLogBtn.addEventListener("click", () => this.clearLog());
    }
    
    // Clear banks button
    if (this.elements.clearBanksBtn) {
      this.elements.clearBanksBtn.addEventListener("click", () => this.clearSceneBanks());
    }

    // Apply button
    this.elements.applyParamsBtn.addEventListener("click", () => {
      console.log("Apply Parameter Changes button clicked!");
      this.applyParameterChanges();
    });

    // Re-resolve button
    if (this.elements.reresolveBtn) {
      console.log("✅ Re-resolve button found, adding click handler");
      this.elements.reresolveBtn.addEventListener("click", () => {
        console.log("🔀 Re-resolve button clicked!");
        this.reresolveAtEOC();
      });
    } else {
      console.error("❌ Re-resolve button not found in DOM");
    }

    // Musical controls
    this.setupMusicalControls();
  }

  reresolveAtEOC() {
    console.log("🔀 reresolveAtEOC() called");
    if (!this.star) {
      console.error("❌ No WebRTC star available for re-resolve");
      return;
    }
    console.log("📡 Creating re-resolve message...");
    const message = MessageBuilder.reresolveAtEOC();
    console.log("📤 Broadcasting re-resolve message:", message);
    const sent = this.star.broadcastToType("synth", message, "control");
    console.log(`✅ Re-resolve message sent to ${sent} synths`);
    this.log(
      `🔀 Re-resolve requested for ${sent} synths at next EOC`,
      "info",
    );
  }

  setupMusicalControls() {
    // Note: All synthesis parameters are now handled by setupEnvelopeControls()

    // Envelope controls for all parameters that support them
    this.setupEnvelopeControls();

    // Period and steps inputs
    if (this.elements.periodInput) {
      this.elements.periodInput.addEventListener("input", (e) => {
        const newPeriod = parseFloat(e.target.value);
        if (this.applyTimingAtEOC) {
          this.pendingPeriodSec = newPeriod;
          this.log(`Period staged for EOC: ${newPeriod}s (pending)`, "info");
        } else {
          this.periodSec = newPeriod;
          this.cycleLength = this.periodSec;
          this.log(`Period changed to ${this.periodSec}s (immediate)`, "info");
        }
      });
    }

    if (this.elements.stepsInput) {
      this.elements.stepsInput.addEventListener("input", (e) => {
        const newSteps = parseInt(e.target.value);
        if (this.applyTimingAtEOC) {
          this.pendingStepsPerCycle = newSteps;
          this.log(`Steps staged for EOC: ${newSteps} (pending)`, "info");
        } else {
          this.stepsPerCycle = newSteps;
          this.updatePhasorTicks();
          this.log(`Steps per cycle changed to ${this.stepsPerCycle} (immediate)`, "info");
        }
      });
    }

    // Apply at EOC checkbox
    if (this.elements.applyTempoAtEOCCheckbox) {
      this.elements.applyTempoAtEOCCheckbox.addEventListener("change", (e) => {
        this.applyTimingAtEOC = e.target.checked;
        this.log(`Apply timing at EOC: ${this.applyTimingAtEOC}`, "info");
      });
    }

    // Transport controls
    if (this.elements.playBtn) {
      this.elements.playBtn.addEventListener("click", () => {
        this.handleTransport("play");
      });
    }

    if (this.elements.pauseBtn) {
      this.elements.pauseBtn.addEventListener("click", () => {
        this.handleTransport("pause");
      });
    }

    if (this.elements.stopBtn) {
      this.elements.stopBtn.addEventListener("click", () => {
        this.handleTransport("stop");
      });
    }

    if (this.elements.jumpEOCBtn) {
      this.elements.jumpEOCBtn.addEventListener("click", () => {
        this.handleJumpToEOC();
      });
    }

    // Steps per cycle slider
    if (this.elements.stepsPerCycleSlider) {
      this.elements.stepsPerCycleSlider.addEventListener("input", (e) => {
        this.stepsPerCycle = parseFloat(e.target.value);
        this.elements.stepsPerCycleValue.textContent =
          `${this.stepsPerCycle} steps`;
        this.log(`Steps per cycle changed to ${this.stepsPerCycle}`, "info");
      });
    }

    // ES-8 enable button
    if (this.elements.es8EnableBtn) {
      this.elements.es8EnableBtn.addEventListener(
        "click",
        () => this.toggleES8(),
      );
    }

    // Scene Memory UI
    this.setupSceneMemoryUI();

    // Global keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      // Cmd+Enter (Mac) or Ctrl+Enter (PC) triggers Send Program
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        this.log("⌨️ Cmd+Enter pressed", "info");
        this.log(
          `  applyParamsBtn exists: ${!!this.elements.applyParamsBtn}`,
          "info",
        );
        this.log(
          `  applyParamsBtn disabled: ${this.elements.applyParamsBtn?.disabled}`,
          "info",
        );

        if (
          this.elements.applyParamsBtn && !this.elements.applyParamsBtn.disabled
        ) {
          e.preventDefault();
          this.log("⌨️ Calling applyParameterChanges()", "info");
          this.applyParameterChanges();
        } else {
          this.log(
            "⌨️ Button check failed - not calling applyParameterChanges()",
            "info",
          );
        }
      }

      // Scene Memory keyboard shortcuts (0-9 to load, Shift+0-9 to save)
      // Only intercept if user is not typing in an input field
      if (/^[0-9]$/.test(e.key) && e.target?.tagName !== "INPUT") {
        e.preventDefault();
        const location = parseInt(e.key);
        if (e.shiftKey) {
          this.saveScene(location);
        } else {
          this.loadScene(location);
        }
      }
    });
  }

  setupEnvelopeControls() {
    // All parameters now use the new compact format

    // Setup compact parameter controls (new format)
    this.setupCompactParameterControls("frequency");
    this.setupCompactParameterControls("vowelX");
    this.setupCompactParameterControls("vowelY");
    this.setupCompactParameterControls("zingAmount");
    this.setupCompactParameterControls("zingMorph");
    this.setupCompactParameterControls("symmetry");
    this.setupCompactParameterControls("amplitude");
    this.setupCompactParameterControls("whiteNoise");

    // Initialize all parameter UIs using unified state/UI sync
    Object.keys(this.musicalState).forEach((paramName) => {
      this.setParameterState(
        paramName as keyof IMusicalState,
        this.musicalState[paramName],
      );
    });
  }

  setupCompactParameterControls(paramName) {
    // Get the new compact control elements
    const modeSelect = document.getElementById(`${paramName}-mode`);
    const interpSelect = document.getElementById(`${paramName}-interpolation`);
    const textInput = document.getElementById(`${paramName}-value`);

    // Get inline control elements based on parameter type
    const startHrg = document.getElementById(`${paramName}-start-hrg`);
    const endHrg = document.getElementById(`${paramName}-end-hrg`);
    const hrgArrow = document.getElementById(`${paramName}-hrg-arrow`);
    const endValueInput = document.getElementById(`${paramName}-end-value`);

    if (!modeSelect) return;

    // Handle direct/program mode changes
    modeSelect.addEventListener("change", () => {
      const isDirect = modeSelect.value === "direct";

      // Dispatch action to update state
      this._updatePendingState({
        type: "SET_SCOPE",
        param: paramName as keyof IMusicalState,
        scope: isDirect ? "direct" : "program",
      });

      // UI will be updated automatically by _updatePendingState → _updateUIFromState
    });

    // Handle interpolation changes
    if (interpSelect) {
      interpSelect.addEventListener("change", () => {
        const interpolation = interpSelect.value as
          | "step"
          | "linear"
          | "cosine"
          | "parabolic";

        // Dispatch interpolation change
        this._updatePendingState({
          type: "SET_INTERPOLATION",
          param: paramName,
          interpolation: interpolation,
        });

        // UI will be updated automatically by _updatePendingState → _updateUIFromState

        this.markPendingChanges();
      });
    }

    // Handle end value input changes
    if (endValueInput) {
      // Use 'change' event for final state update (fires when user commits value)
      endValueInput.addEventListener("change", () => {
        this._handleValueInput(paramName, endValueInput.value, "end");
        this.markPendingChanges();
      });

      // Optional: Add 'input' listener for validation feedback only
      endValueInput.addEventListener("input", () => {
        const isValid = /^-?\d*\.?\d*(\s*-\s*-?\d*\.?\d*)?$/.test(
          endValueInput.value,
        );
        endValueInput.classList.toggle(
          "invalid-input",
          !isValid && endValueInput.value !== "",
        );
      });
    }

    // Handle text input changes
    if (textInput) {
      // Use 'change' event for final state update (fires when user commits value)
      textInput.addEventListener("change", () => {
        this._handleValueInput(paramName, textInput.value, "start");
        this.markPendingChanges();
      });

      // Handle blur for immediate broadcast in direct mode
      textInput.addEventListener("blur", () => {
        if (modeSelect && modeSelect.value === "direct") {
          // Check if input is empty and apply appropriate default
          if (textInput.value.trim() === "") {
            // Determine the correct default based on the parameter name
            let defaultValue: number;

            switch (paramName) {
              case "vowelX":
              case "vowelY":
              case "symmetry":
              case "zingMorph":
              case "zingAmount":
                defaultValue = 0.5;
                break;

              case "frequency":
                defaultValue = 220;
                break;

              case "amplitude":
                defaultValue = 0.8;
                break;

              case "whiteNoise":
              default: // Safe fallback
                defaultValue = 0;
                break;
            }

            console.log(
              `Input for '${paramName}' was empty on blur, defaulting to ${defaultValue}`,
            );

            // Update the state with the determined default value
            this._updatePendingState({
              type: "SET_DIRECT_VALUE",
              param: paramName as keyof IMusicalState,
              value: defaultValue,
            });
            // The UI will automatically update to show this new value because
            // _updatePendingState calls _updateUIFromState
          }

          // Always apply and broadcast the current state on blur for direct mode
          // If the field was empty, this will broadcast the default we just set
          // If the field had a value, it will broadcast that value
          this._applyDirectParameter(paramName as keyof IMusicalState);
        }
      });

      // Optional: Add 'input' listener for validation feedback only
      textInput.addEventListener("input", () => {
        const isValid = /^-?\d*\.?\d*(\s*-\s*-?\d*\.?\d*)?$/.test(
          textInput.value,
        );
        textInput.classList.toggle(
          "invalid-input",
          !isValid && textInput.value !== "",
        );
      });
    }

    // Add input handlers for HRG fields (frequency only)
    if (paramName === "frequency") {
      // Start HRG inputs
      const startNumeratorsInput = document.getElementById(
        "frequency-start-numerators",
      );
      const startDenominatorsInput = document.getElementById(
        "frequency-start-denominators",
      );
      const startNumBehaviorSelect = document.getElementById(
        "frequency-start-numerators-behavior",
      );
      const startDenBehaviorSelect = document.getElementById(
        "frequency-start-denominators-behavior",
      );

      if (startNumeratorsInput) {
        startNumeratorsInput.addEventListener("input", () => {
          const { ok } = this._validateSINString(startNumeratorsInput.value);
          startNumeratorsInput.classList.toggle("invalid-input", !ok);
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: { numerators: startNumeratorsInput.value },
          });
          this.markPendingChanges();
        });
      }

      if (startDenominatorsInput) {
        startDenominatorsInput.addEventListener("input", () => {
          const { ok } = this._validateSINString(startDenominatorsInput.value);
          startDenominatorsInput.classList.toggle("invalid-input", !ok);
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: { denominators: startDenominatorsInput.value },
          });
          this.markPendingChanges();
        });
      }

      if (startNumBehaviorSelect) {
        startNumBehaviorSelect.addEventListener("change", () => {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: { numeratorBehavior: startNumBehaviorSelect.value },
          });
          this.markPendingChanges();
        });
      }

      if (startDenBehaviorSelect) {
        startDenBehaviorSelect.addEventListener("change", () => {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: { denominatorBehavior: startDenBehaviorSelect.value },
          });
          this.markPendingChanges();
        });
      }

      // End HRG inputs
      const endNumeratorsInput = document.getElementById(
        "frequency-end-numerators",
      );
      const endDenominatorsInput = document.getElementById(
        "frequency-end-denominators",
      );
      const endNumBehaviorSelect = document.getElementById(
        "frequency-end-numerators-behavior",
      );
      const endDenBehaviorSelect = document.getElementById(
        "frequency-end-denominators-behavior",
      );

      if (endNumeratorsInput) {
        endNumeratorsInput.addEventListener("input", () => {
          const { ok } = this._validateSINString(endNumeratorsInput.value);
          endNumeratorsInput.classList.toggle("invalid-input", !ok);
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: { numerators: endNumeratorsInput.value },
          });
          this.markPendingChanges();
        });
      }

      if (endDenominatorsInput) {
        endDenominatorsInput.addEventListener("input", () => {
          const { ok } = this._validateSINString(endDenominatorsInput.value);
          endDenominatorsInput.classList.toggle("invalid-input", !ok);
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: { denominators: endDenominatorsInput.value },
          });
          this.markPendingChanges();
        });
      }

      if (endNumBehaviorSelect) {
        endNumBehaviorSelect.addEventListener("change", () => {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: { numeratorBehavior: endNumBehaviorSelect.value },
          });
          this.markPendingChanges();
        });
      }

      if (endDenBehaviorSelect) {
        endDenBehaviorSelect.addEventListener("change", () => {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: { denominatorBehavior: endDenBehaviorSelect.value },
          });
          this.markPendingChanges();
        });
      }
    }

    // Initialize UI to reflect the current typed state
    this._updateUIFromState(paramName);
  }

  /**
   * Handle value input changes with smart range detection
   */
  private _handleValueInput(
    paramName: string,
    inputValue: string,
    position: "start" | "end",
  ) {
    const modeSelect = document.getElementById(
      `${paramName}-mode`,
    ) as HTMLSelectElement;
    const currentMode = modeSelect?.value || "direct";
    const trimmedValue = inputValue.trim();

    // Auto-switch to program mode if range detected
    if (trimmedValue.includes("-") && currentMode === "direct") {
      modeSelect.value = "program";
      modeSelect.dispatchEvent(new Event("change"));
      // The mode change will trigger UI updates
      return;
    }

    if (currentMode === "direct") {
      // Parse direct value from input
      let directValue;
      if (trimmedValue.includes("-")) {
        // Range format: use average of range
        const [min, max] = trimmedValue.split("-").map((v) =>
          parseFloat(v.trim())
        );
        if (!isNaN(min) && !isNaN(max)) {
          directValue = (min + max) / 2;
        }
      } else {
        // Single value format
        const value = parseFloat(trimmedValue);
        if (!isNaN(value)) {
          directValue = value;
        }
      }

      if (directValue !== undefined) {
        this._updatePendingState({
          type: "SET_DIRECT_VALUE",
          param: paramName,
          value: directValue,
        });
      }
    } else {
      // Program mode: update generator configuration based on value type
      this._updateProgramGenerator(paramName, trimmedValue, position);
    }
  }

  /**
   * Update program generator based on input value (single value or range)
   */
  private _updateProgramGenerator(
    paramName: string,
    inputValue: string,
    position: "start" | "end",
  ) {
    if (inputValue.includes("-")) {
      // Range format: create RBG generator
      const [min, max] = inputValue.split("-").map((v) => parseFloat(v.trim()));
      if (!isNaN(min) && !isNaN(max)) {
        this._updatePendingState({
          type: "SET_GENERATOR_CONFIG",
          param: paramName,
          position: position,
          config: {
            type: "normalised",
            range: { min: Math.min(min, max), max: Math.max(min, max) },
            sequenceBehavior: "static",
          },
        });
      }
    } else {
      // Single value: create constant generator
      const value = parseFloat(inputValue);
      if (!isNaN(value)) {
        this._updatePendingState({
          type: "SET_GENERATOR_CONFIG",
          param: paramName,
          position: position,
          config: {
            type: "normalised",
            range: value,
            sequenceBehavior: "static",
          },
        });
      }
    }
  }

  /**
   * Update UI visibility based on current interpolation type
   */

  /**
   * Update UI elements to reflect the current typed state
   * This is the reverse of the old DOM-based state management
   * State is now the master, UI is just a reflection of it
   */
  private _updateUIFromState(paramName: keyof IMusicalState) {
    const paramState = this.pendingMusicalState[paramName];

    // Get all UI components for this parameter
    const modeSelect = document.getElementById(
      `${paramName}-mode`,
    ) as HTMLSelectElement;
    const valueInput = document.getElementById(
      `${paramName}-value`,
    ) as HTMLInputElement;
    const interpSelect = document.getElementById(
      `${paramName}-interpolation`,
    ) as HTMLSelectElement;
    const hrgStartControls = document.getElementById(`${paramName}-start-hrg`);
    const hrgEndControls = document.getElementById(`${paramName}-end-hrg`);
    const hrgArrow = document.getElementById(`${paramName}-hrg-arrow`);
    const endValueInput = document.getElementById(
      `${paramName}-end-value`,
    ) as HTMLInputElement;

    if (!modeSelect) return;

    // --- START NEW, CORRECTED LOGIC ---

    // 1. The main value input is ALWAYS visible. Display based on mode and parameter type.
    if (valueInput) {
      valueInput.style.display = "inline-block"; // Ensure it's always visible
      if (paramState.scope === "direct" && paramState.directValue !== null) {
        valueInput.value = paramState.directValue.toString();
      } else if (
        paramState.scope === "program" && paramState.startValueGenerator
      ) {
        // Display range for program mode normalised parameters
        const startGen = paramState.startValueGenerator;
        if (startGen.type === "normalised") {
          if (typeof startGen.range === "number") {
            valueInput.value = startGen.range.toString();
          } else if (typeof startGen.range === "object") {
            valueInput.value = `${startGen.range.min}-${startGen.range.max}`;
          }
        } else if (
          startGen.type === "periodic" && paramState.directValue !== null
        ) {
          // For periodic (frequency), still use directValue as baseValue
          valueInput.value = paramState.directValue.toString();
        }
      } else if (paramState.directValue === null) {
        valueInput.value = ""; // Handle the blank-and-focus case
        valueInput.focus();
      }
    }

    // 2. Set the mode dropdown's value from state.
    modeSelect.value = paramState.scope;

    // 3. The 'scope' now ONLY controls the visibility of the program-related controls.
    const isProgramMode = paramState.scope === "program";

    if (interpSelect) {
      interpSelect.style.display = isProgramMode ? "inline-block" : "none";
    }
    if (hrgStartControls) {
      hrgStartControls.style.display = isProgramMode ? "inline" : "none";
    }

    // 4. If in program mode, handle the interpolation-dependent controls.
    if (isProgramMode) {
      if (interpSelect) {
        interpSelect.value = paramState.interpolation;
      }

      const isEnvelope = paramState.interpolation !== "step";
      if (hrgEndControls) {
        hrgEndControls.style.display = isEnvelope ? "inline" : "none";
      }
      if (hrgArrow) hrgArrow.style.display = isEnvelope ? "inline" : "none";
      if (endValueInput) {
        endValueInput.style.display = isEnvelope ? "inline" : "none";
      }

      // Update end value input based on generator for non-HRG parameters
      if (
        endValueInput && isEnvelope && paramState.endValueGenerator &&
        paramState.endValueGenerator.type === "normalised"
      ) {
        const endGen = paramState.endValueGenerator;
        if (typeof endGen.range === "number") {
          endValueInput.value = endGen.range.toString();
        } else if (typeof endGen.range === "object") {
          endValueInput.value = `${endGen.range.min}-${endGen.range.max}`;
        }
      }

      // Ensure HRG UI reflects state (frequency only)
      if (paramName === "frequency") {
        const startGen = (paramState as any).startValueGenerator;
        if (startGen && startGen.type === "periodic") {
          const startNums = document.getElementById(
            "frequency-start-numerators",
          ) as HTMLInputElement | null;
          const startDens = document.getElementById(
            "frequency-start-denominators",
          ) as HTMLInputElement | null;
          const startNumBeh = document.getElementById(
            "frequency-start-numerators-behavior",
          ) as HTMLSelectElement | null;
          const startDenBeh = document.getElementById(
            "frequency-start-denominators-behavior",
          ) as HTMLSelectElement | null;
          if (startNums) startNums.value = startGen.numerators ?? "1";
          if (startDens) startDens.value = startGen.denominators ?? "1";
          if (startNumBeh) {
            startNumBeh.value = startGen.numeratorBehavior ?? "static";
          }
          if (startDenBeh) {
            startDenBeh.value = startGen.denominatorBehavior ?? "static";
          }
        }

        if (isEnvelope) {
          const endGen = (paramState as any).endValueGenerator;
          if (endGen && endGen.type === "periodic") {
            const endNums = document.getElementById(
              "frequency-end-numerators",
            ) as HTMLInputElement | null;
            const endDens = document.getElementById(
              "frequency-end-denominators",
            ) as HTMLInputElement | null;
            const endNumBeh = document.getElementById(
              "frequency-end-numerators-behavior",
            ) as HTMLSelectElement | null;
            const endDenBeh = document.getElementById(
              "frequency-end-denominators-behavior",
            ) as HTMLSelectElement | null;
            if (endNums) endNums.value = endGen.numerators ?? "1";
            if (endDens) endDens.value = endGen.denominators ?? "1";
            if (endNumBeh) {
              endNumBeh.value = endGen.numeratorBehavior ?? "static";
            }
            if (endDenBeh) {
              endDenBeh.value = endGen.denominatorBehavior ?? "static";
            }
          }
        }
      }
    } else {
      // Ensure end HRG controls, arrow, and envelope controls are hidden when not in program mode.
      if (hrgEndControls) hrgEndControls.style.display = "none";
      if (hrgArrow) hrgArrow.style.display = "none";
      if (endValueInput) endValueInput.style.display = "none";
    }
  }

  // Capture current HRG inputs into pending state before apply
  private _syncHRGStateFromInputs() {
    const freqState = this.pendingMusicalState.frequency as any;
    if (!freqState || freqState.scope !== "program") return;

    let anyInvalid = false;

    // Helper to validate and mark
    const validateField = (el: HTMLInputElement | null, label: string) => {
      if (!el) return true;
      const { ok } = this._validateSINString(el.value);
      el.classList.toggle("invalid-input", !ok);
      if (!ok) {
        this.log(
          `Invalid ${label}: "${el.value}" (use numbers, commas, and ranges like 1-6)`,
          "error",
        );
      }
      return ok;
    };

    // Validate all four fields first
    const v1 = validateField(
      document.getElementById("frequency-start-numerators") as
        | HTMLInputElement
        | null,
      "start numerators",
    );
    const v2 = validateField(
      document.getElementById("frequency-start-denominators") as
        | HTMLInputElement
        | null,
      "start denominators",
    );
    const v3 = validateField(
      document.getElementById("frequency-end-numerators") as
        | HTMLInputElement
        | null,
      "end numerators",
    );
    const v4 = validateField(
      document.getElementById("frequency-end-denominators") as
        | HTMLInputElement
        | null,
      "end denominators",
    );
    anyInvalid = !(v1 && v2 && v3 && v4);

    if (anyInvalid) {
      return false;
    }

    // Start generator
    if (freqState.startValueGenerator?.type === "periodic") {
      const startNums =
        (document.getElementById("frequency-start-numerators") as
          | HTMLInputElement
          | null)?.value;
      const startDens =
        (document.getElementById("frequency-start-denominators") as
          | HTMLInputElement
          | null)?.value;
      const startNumBeh =
        (document.getElementById("frequency-start-numerators-behavior") as
          | HTMLSelectElement
          | null)?.value;
      const startDenBeh =
        (document.getElementById("frequency-start-denominators-behavior") as
          | HTMLSelectElement
          | null)?.value;
      freqState.startValueGenerator.numerators = startNums ??
        freqState.startValueGenerator.numerators;
      freqState.startValueGenerator.denominators = startDens ??
        freqState.startValueGenerator.denominators;
      freqState.startValueGenerator.numeratorBehavior = startNumBeh ??
        freqState.startValueGenerator.numeratorBehavior;
      freqState.startValueGenerator.denominatorBehavior = startDenBeh ??
        freqState.startValueGenerator.denominatorBehavior;
    }

    // End generator (if envelope)
    if (
      freqState.interpolation !== "step" &&
      freqState.endValueGenerator?.type === "periodic"
    ) {
      const endNums = (document.getElementById("frequency-end-numerators") as
        | HTMLInputElement
        | null)?.value;
      const endDens = (document.getElementById("frequency-end-denominators") as
        | HTMLInputElement
        | null)?.value;
      const endNumBeh =
        (document.getElementById("frequency-end-numerators-behavior") as
          | HTMLSelectElement
          | null)?.value;
      const endDenBeh =
        (document.getElementById("frequency-end-denominators-behavior") as
          | HTMLSelectElement
          | null)?.value;
      freqState.endValueGenerator.numerators = endNums ??
        freqState.endValueGenerator.numerators;
      freqState.endValueGenerator.denominators = endDens ??
        freqState.endValueGenerator.denominators;
      freqState.endValueGenerator.numeratorBehavior = endNumBeh ??
        freqState.endValueGenerator.numeratorBehavior;
      freqState.endValueGenerator.denominatorBehavior = endDenBeh ??
        freqState.endValueGenerator.denominatorBehavior;
    }

    return true;
  }

  markPendingChanges() {
    console.log(
      "markPendingChanges called, button:",
      this.elements.applyParamsBtn,
    );
    this.hasPendingChanges = true;
    if (this.elements.applyParamsBtn) {
      this.elements.applyParamsBtn.disabled = false;
      this.elements.applyParamsBtn.textContent = "apply changes*";
    }
  }

  clearPendingChanges() {
    this.hasPendingChanges = false;
    if (this.elements.applyParamsBtn) {
      this.elements.applyParamsBtn.disabled = true;
      this.elements.applyParamsBtn.textContent = "apply changes";
    }
  }

  /**
   * Unified method to set parameter state and update UI
   */
  setParameterState(paramName: keyof IMusicalState, newState: ParameterState) {
    // Update both state objects
    this.musicalState[paramName] = newState;
    this.pendingMusicalState[paramName] = { ...newState };

    // Update UI to match using the centralized function
    this._updateUIFromState(paramName);
  }

  applyParameterChanges() {
    // Sync visible HRG UI inputs into pending state before committing; abort on invalid
    const ok = this._syncHRGStateFromInputs();
    if (ok === false) {
      this.log("Fix invalid HRG inputs before applying.", "error");
      return;
    }
    this.musicalState = JSON.parse(JSON.stringify(this.pendingMusicalState));
    console.log("Applying new state:", this.musicalState);
    this.broadcastMusicalParameters();
    this.clearPendingChanges();
  }

  // Validate a SIN string like "1-3,5,7-9"
  private _validateSINString(str: string): { ok: boolean; error?: string } {
    if (str == null) return { ok: false, error: "empty" };
    const s = String(str).trim();
    if (s.length === 0) return { ok: false, error: "empty" };
    // Quick format check: numbers, optional ranges, comma separated
    const basic = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;
    if (!basic.test(s)) return { ok: false, error: "format" };
    // Semantic check: ranges ascending, all positive
    const parts = s.split(",");
    for (const p of parts) {
      const t = p.trim();
      if (t.includes("-")) {
        const [aStr, bStr] = t.split("-").map((v) => v.trim());
        const a = parseInt(aStr, 10);
        const b = parseInt(bStr, 10);
        if (
          !Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0 ||
          a > b
        ) {
          return { ok: false, error: "range" };
        }
      } else {
        const n = parseInt(t, 10);
        if (!Number.isFinite(n) || n <= 0) {
          return { ok: false, error: "number" };
        }
      }
    }
    return { ok: true };
  }

  /**
   * Central method for translating IMusicalState to wire format
   * Used by both broadcastMusicalParameters and sendCompleteStateToSynth
   */
  private _getWirePayload(): any {
    const wirePayload: any = {
      synthesisActive: this.synthesisActive,
      isManualMode: this.isManualControlMode,
    };

    // Send discriminated union format directly
    for (const key in this.musicalState) {
      const paramKey = key as keyof IMusicalState;
      const paramState = this.musicalState[paramKey];

      if (paramState.scope === "direct") {
        // Send direct parameters as-is
        wirePayload[paramKey] = paramState;
      } else { // scope is 'program'
        // Prepare generators with proper baseValue for program parameters
        const startGen = { ...paramState.startValueGenerator };
        if (startGen.type === "periodic") {
          startGen.baseValue = paramState.directValue;
        }

        let endGen = undefined;
        if (
          paramState.interpolation !== "step" && paramState.endValueGenerator
        ) {
          endGen = { ...paramState.endValueGenerator };
          if (endGen.type === "periodic") {
            endGen.baseValue = paramState.directValue;
          }
        }

        // Send program parameters with discriminated union format
        wirePayload[paramKey] = {
          scope: "program",
          interpolation: paramState.interpolation,
          startValueGenerator: startGen,
          endValueGenerator: endGen,
          directValue: paramState.directValue,
        };
      }
    }
    return wirePayload;
  }

  broadcastMusicalParameters() {
    if (!this.star) return;

    const wirePayload = this._getWirePayload();
    console.log("Broadcasting translated payload:", wirePayload);

    const message = MessageBuilder.createParameterUpdate(
      MessageTypes.PROGRAM_UPDATE,
      wirePayload,
    );
    this.star.broadcast(message);
    this.log("📡 Broadcasted musical parameters", "info");
  }

  // Removed splitParametersByMode - no longer needed with separated state

  broadcastDirectParameters() {
    if (!this.star) return;

    // Extract direct values from the typed state
    const directParams: any = { synthesisActive: this.synthesisActive };

    for (const key in this.musicalState) {
      const paramKey = key as keyof IMusicalState;
      const paramState = this.musicalState[paramKey];

      if (paramState.scope === "direct") {
        directParams[paramKey] = paramState.directValue;
      }
    }

    // Send direct parameters
    const message = MessageBuilder.createParameterUpdate(
      MessageTypes.SYNTH_PARAMS,
      directParams,
    );
    const sent = this.star.broadcastToType("synth", message, "control");

    this.log(`Sent direct parameters to ${sent} synths`, "info");

    // Also send to ES-8 if enabled
    this.sendSynthParametersToES8();
  }

  // Phasor Management Methods
  calculateCycleLength() {
    // Period-based: cycle length equals period in seconds
    this.cycleLength = this.periodSec;
  }

  applyPendingTimingChanges() {
    let changed = false;
    
    if (this.pendingPeriodSec !== null) {
      this.periodSec = this.pendingPeriodSec;
      this.cycleLength = this.periodSec;
      this.log(`Applied period change: ${this.periodSec}s`, "info");
      this.pendingPeriodSec = null;
      changed = true;
    }
    
    if (this.pendingStepsPerCycle !== null) {
      this.stepsPerCycle = this.pendingStepsPerCycle;
      this.updatePhasorTicks();
      this.log(`Applied steps change: ${this.stepsPerCycle}`, "info");
      this.pendingStepsPerCycle = null;
      changed = true;
    }
    
    if (changed) {
      // Update UI to reflect changes
      if (this.elements.periodInput) {
        this.elements.periodInput.value = this.periodSec.toString();
      }
      if (this.elements.stepsInput) {
        this.elements.stepsInput.value = this.stepsPerCycle.toString();
      }
    }
  }

  initializePhasor() {
    this.phasor = 0.0;
    this.lastPhasorTime = performance.now() / 1000.0;
    this.updatePhasorTicks();
    this.startPhasorUpdate();
    this.updatePhasorDisplay();
  }

  updatePhasorTicks() {
    if (!this.elements.phasorTicks) return;

    // Clear existing ticks
    this.elements.phasorTicks.innerHTML = '';

    // Generate new ticks based on stepsPerCycle
    for (let i = 0; i < this.stepsPerCycle; i++) {
      const tick = document.createElement('div');
      tick.className = 'phasor-tick';
      tick.style.left = `${(i / this.stepsPerCycle) * 100}%`;
      this.elements.phasorTicks.appendChild(tick);
    }
  }

  updatePhasor() {
    const currentTime = performance.now() / 1000.0;
    const deltaTime = currentTime - this.lastPhasorTime;

    // Only advance phasor when playing
    if (this.isPlaying) {
      // Update phasor
      const phasorIncrement = deltaTime / this.cycleLength;
      const previousPhasor = this.phasor;
      this.phasor += phasorIncrement;

      // Detect EOC (End of Cycle)
      const eocCrossed = this.phasor >= 1.0;

      // Wrap around at 1.0
      if (this.phasor >= 1.0) {
        this.phasor -= 1.0;
        
        // Apply pending timing changes at EOC
        this.applyPendingTimingChanges();
      }
    }

    this.lastPhasorTime = currentTime;
    this.updatePhasorDisplay();

    // Update ES-8 with current phasor state
    this.updateES8State();

    // Broadcast phasor at specified rate
    this.broadcastPhasor(currentTime);
  }

  updatePhasorDisplay() {
    if (this.elements.phasorDisplay) {
      this.elements.phasorDisplay.textContent = this.phasor.toFixed(3);
    }

    if (this.elements.phasorBar) {
      const percentage = (this.phasor * 100).toFixed(1);
      this.elements.phasorBar.style.width = `${percentage}%`;
    }
  }

  startPhasorUpdate() {
    const updateLoop = () => {
      this.updatePhasor();
      this.phasorUpdateId = requestAnimationFrame(updateLoop);
    };
    updateLoop();
  }

  stopPhasorUpdate() {
    if (this.phasorUpdateId) {
      cancelAnimationFrame(this.phasorUpdateId);
      this.phasorUpdateId = null;
    }
  }

  broadcastPhasor(currentTime) {
    if (!this.star) return;

    // Rate limiting - only broadcast at the specified rate
    const timeSinceLastBroadcast = currentTime - this.lastBroadcastTime;
    const broadcastInterval = 1.0 / this.phasorBroadcastRate;

    if (timeSinceLastBroadcast >= broadcastInterval) {
      const message = MessageBuilder.phasorSync(
        this.phasor,
        null, // cpm omitted (legacy)
        this.stepsPerCycle,
        this.cycleLength,
        this.isPlaying,
      );

      const sent = this.star.broadcastToType("synth", message, "sync");
      this.lastBroadcastTime = currentTime;
    }
  }

  // ES-8 Integration Methods
  async toggleES8() {
    this.es8Enabled = !this.es8Enabled;

    if (this.es8Enabled) {
      await this.initializeES8();
      this.elements.es8EnableBtn.textContent = "disable es-8";
      this.elements.es8EnableBtn.classList.add("active");
      this.log("ES-8 enabled - CV output active", "success");
    } else {
      this.shutdownES8();
      this.elements.es8EnableBtn.textContent = "enable es-8";
      this.elements.es8EnableBtn.classList.remove("active");
      this.log("ES-8 disabled", "info");
    }
  }

  async initializeES8() {
    try {
      // Create audio context if it doesn't exist
      if (!this.audioContext) {
        this.audioContext = new AudioContext({ sampleRate: 48000 });
        await this.audioContext.resume();
      }

      // Configure destination for 8 channels (like the es_8_test reference)
      if (this.audioContext.destination.maxChannelCount >= 8) {
        this.audioContext.destination.channelCount = 8;
        this.audioContext.destination.channelCountMode = "explicit";
        this.audioContext.destination.channelInterpretation = "discrete";
        this.log("Configured audio destination for 8 channels", "info");
      } else {
        this.log(
          `Only ${this.audioContext.destination.maxChannelCount} channels available`,
          "warning",
        );
      }

      // Load the ES-8 worklet
      await this.audioContext.audioWorklet.addModule(
        "/ctrl/worklets/es8-processor.worklet.js",
      );

      // Create ES-8 AudioWorkletNode
      this.es8Node = new AudioWorkletNode(this.audioContext, "es8-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [8],
        channelCount: 8,
        channelCountMode: "explicit",
        channelInterpretation: "discrete",
      });

      // Connect to destination
      this.es8Node.connect(this.audioContext.destination);

      // Enable the worklet
      this.es8Node.port.postMessage({
        type: "enable",
        enabled: true,
      });

      // Send initial state
      this.updateES8State();
      this.sendSynthParametersToES8();

      this.log("ES-8 AudioWorklet initialized", "info");
    } catch (error) {
      this.log(`ES-8 initialization failed: ${error.message}`, "error");
      this.es8Enabled = false;
    }
  }

  updateES8State() {
    if (!this.es8Enabled || !this.es8Node) return;

    // Send phasor state to worklet
    this.es8Node.port.postMessage({
      type: "phasor-update",
      phasor: this.phasor,
      periodSec: this.periodSec,
      stepsPerCycle: this.stepsPerCycle,
      cycleLength: this.cycleLength,
    });
  }

  sendSynthParametersToES8() {
    if (!this.es8Enabled || !this.es8Node) return;

    const params = this.musicalState;
    this.es8Node.port.postMessage({
      type: "synth-parameters",
      frequency: params.frequency,
      vowelX: params.vowelX,
      vowelY: params.vowelY,
      zingAmount: params.zingAmount,
      amplitude: params.amplitude,
    });
  }

  shutdownES8() {
    if (this.es8Node) {
      // Disable the worklet
      this.es8Node.port.postMessage({
        type: "enable",
        enabled: false,
      });

      // Disconnect and clean up
      this.es8Node.disconnect();
      this.es8Node = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  // Transport control methods
  handleTransport(action) {
    console.log(`Transport: ${action}`);
    
    switch (action) {
      case 'play':
        this.isPlaying = true;
        this.lastPhasorTime = performance.now() / 1000.0; // Reset time tracking
        this.log("Global phasor started", "info");
        break;
      case 'pause':
        this.isPlaying = false;
        this.log("Global phasor paused", "info");
        break;
      case 'stop':
        this.isPlaying = false;
        this.phasor = 0.0;
        this.lastPhasorTime = performance.now() / 1000.0;
        this.updatePhasorDisplay();
        this.log("Global phasor stopped and reset", "info");
        break;
    }
    
    // Broadcast current phasor state immediately with new playing state
    this.broadcastPhasor(performance.now() / 1000.0);
  }

  handleJumpToEOC() {
    console.log("Jump to EOC");
    if (this.star) {
      const message = MessageBuilder.jumpToEOC();
      this.star.broadcastToType("synth", message, "control");
    }
  }

  async connectToNetwork() {
    try {
      this.updateConnectionStatus("connecting");

      this.log("Connecting to network...", "info");

      // Create star network
      this.star = new WebRTCStar(this.peerId, "ctrl");
      this.setupStarEventHandlers();

      // Connect to signaling server - use current host
      // Dynamic WebSocket URL that works in production and development
      const protocol = globalThis.location.protocol === "https:"
        ? "wss:"
        : "ws:";
      const port = globalThis.location.port
        ? `:${globalThis.location.port}`
        : "";
      const signalingUrl =
        `${protocol}//${globalThis.location.hostname}${port}/ws`;
      await this.star.connect(signalingUrl, this.forceTakeover);

      // Determine controller status based on force takeover flag
      if (this.forceTakeover) {
        // If we used force takeover and weren't kicked, we're the active controller
        this.updateConnectionStatus("active");
      } else {
        // Connected without force takeover means we're inactive (view-only)
        this.updateConnectionStatus("inactive");
      }

      this._updateUIState();

      this.log("Connected to network successfully", "success");
    } catch (error) {
      this.log(`Connection failed: ${error.message}`, "error");
      this.updateConnectionStatus("disconnected");
      this._updateUIState();
    }
  }

  _updateUIState() {
    const isConnected = this.star && this.star.isConnectedToSignaling;

    // Update any remaining UI state based on connection
  }

  setupStarEventHandlers() {
    this.star.addEventListener("became-leader", () => {
      this.log("Became network leader", "success");
      this._updateUIState();
    });

    this.star.addEventListener("peer-connected", (event) => {
      const { peerId } = event.detail;
      this.log(`Peer connected: ${peerId}`, "info");
      this.updatePeerList();
      this._updateUIState();

      // Send complete current state to new synths
      if (peerId.startsWith("synth-")) {
        this.sendCompleteStateToSynth(peerId);
      }
    });

    this.star.addEventListener("peer-removed", (event) => {
      this.log(`Peer disconnected: ${event.detail.peerId}`, "info");
      this.updatePeerList();
      this._updateUIState();
    });

    this.star.addEventListener("kicked", (event) => {
      this.log(`Kicked: ${event.detail.reason}`, "error");
      this.updateConnectionStatus("kicked");
      this._updateUIState();
      alert(
        "You have been disconnected: Another control client has taken over.",
      );
    });

    this.star.addEventListener("join-rejected", (event) => {
      this.log(`Cannot join: ${event.detail.reason}`, "error");
      this.updateConnectionStatus("error");
      this._updateUIState();

      if (event.detail.reason.includes("Add ?force=true")) {
        if (
          confirm(
            "Another control client is already connected. Force takeover?",
          )
        ) {
          globalThis.location.href = globalThis.location.href + "?force=true";
        }
      }
    });

    this.star.addEventListener("data-message", (event) => {
      const { peerId, channelType, message } = event.detail;

      // Handle ping messages
      if (message.type === MessageTypes.PING) {
        const pong = MessageBuilder.pong(message.id, message.timestamp);
        this.star.sendToPeer(peerId, pong, "sync");
      }

      // Log other messages for debugging
      if (
        message.type !== MessageTypes.PING && message.type !== MessageTypes.PONG
      ) {
        this.log(`Received ${message.type} from ${peerId}`, "debug");
      }
    });
  }

  toggleSynthesis() {
    this.synthesisActive = !this.synthesisActive;

    if (this.synthesisActive) {
      this.elements.manualModeBtn.textContent = "Disable Synthesis";
      this.elements.manualModeBtn.classList.add("active");
      if (this.elements.synthesisStatus) {
        this.elements.synthesisStatus.textContent = "active";
      }
      this.log(
        "Synthesis enabled - real-time parameter control active",
        "info",
      );
    } else {
      this.elements.manualModeBtn.textContent = "Enable Synthesis";
      this.elements.manualModeBtn.classList.remove("active");
      if (this.elements.synthesisStatus) {
        this.elements.synthesisStatus.textContent = "inactive";
      }
      this.log("Synthesis disabled", "info");
    }

    // Broadcast current state to all synths
    this.broadcastDirectParameters(); // Send direct parameters with synthesis state

    // Send current musical state using new typed system
    this.broadcastMusicalParameters();
  }

  // Deprecated - use toggleSynthesis instead
  toggleManualMode() {
    this.toggleSynthesis();
  }

  sendCompleteStateToSynth(synthId) {
    this.log(`Sending complete state to new synth: ${synthId}`, "info");

    // Send current musical state using unified payload function
    const wirePayload = this._getWirePayload();

    const message = MessageBuilder.createParameterUpdate(
      MessageTypes.PROGRAM_UPDATE,
      wirePayload,
    );
    const success = this.star.sendToPeer(synthId, message, "control");
    if (success) {
      this.log(`✅ Sent typed musical state to ${synthId}`, "debug");
    } else {
      this.log(`❌ Failed to send typed musical state to ${synthId}`, "error");
    }
  }

  updateConnectionStatus(status) {
    const statusElement = this.elements.connectionStatus;
    const valueElement = this.elements.connectionValue;
    const takeoverSection = this.elements.takeoverSection;

    // Remove all status classes
    statusElement.classList.remove(
      "connected",
      "syncing",
      "active",
      "inactive",
      "kicked",
      "error",
    );

    // Hide takeover section by default (if it exists)
    if (takeoverSection) {
      takeoverSection.style.display = "none";
    }

    switch (status) {
      case "active":
        valueElement.textContent = "Active Controller ✓";
        statusElement.classList.add("active");
        break;
      case "inactive":
        valueElement.textContent = "Inactive (view only)";
        statusElement.classList.add("inactive");
        takeoverSection.style.display = "block";
        break;
      case "kicked":
        valueElement.textContent = "Kicked (reload to retry)";
        statusElement.classList.add("kicked");
        takeoverSection.style.display = "block";
        break;
      case "connected":
        valueElement.textContent = "Connected";
        statusElement.classList.add("connected");
        break;
      case "connecting":
        valueElement.textContent = "Connecting...";
        statusElement.classList.add("syncing");
        break;
      case "error":
        valueElement.textContent = "Connection Error";
        statusElement.classList.add("error");
        break;
      default:
        valueElement.textContent = "Disconnected";
    }
  }

  updatePeerCount(count) {
    if (this.elements.synthCount) {
      this.elements.synthCount.textContent = count.toString();
    }

    // Update synth count color
    if (this.elements.synthCount) {
      if (count > 0) {
        this.elements.synthCount.classList.add("good");
      } else {
        this.elements.synthCount.classList.remove("good");
      }
    }
  }

  updateTimingStatus(isRunning) {
    const statusElement = this.elements.timingStatus;
    const valueElement = this.elements.timingValue;

    if (isRunning) {
      valueElement.textContent = "Running";
      statusElement.classList.add("syncing");
    } else {
      valueElement.textContent = "Stopped";
      statusElement.classList.remove("syncing");
    }
  }

  updatePhasorVisualization(phasor) {
    const percentage = (phasor * 100).toFixed(1);
    this.elements.phasorBar.style.width = `${percentage}%`;
    this.elements.phasorText.textContent = phasor.toFixed(3);
  }

  updatePeerList() {
    if (!this.star) {
      this.clearPeerList();
      return;
    }

    const stats = this.star.getNetworkStats();
    const peers = Object.keys(stats.peerStats);

    this.updatePeerCount(peers.length);

    if (peers.length === 0) {
      this.clearPeerList();
      return;
    }

    const listHTML = peers.map((peerId) => {
      const peerStats = stats.peerStats[peerId];
      const peerType = peerStats.peerType || peerId.split("-")[0]; // Use stored type or extract from peerId

      return `
        <div class="peer-item">
          <div class="peer-info">
            <div class="peer-id">${peerId}</div>
            <div class="peer-type">${peerType}</div>
          </div>
          <div class="peer-stats">
            <div>Status: ${peerStats.connectionState}</div>
          </div>
        </div>
      `;
    }).join("");

    this.elements.peerList.innerHTML = listHTML;
  }

  clearPeerList() {
    this.elements.peerList.innerHTML = `
      <div style="color: #888; font-style: italic; text-align: center; padding: 20px;">
        No peers connected
      </div>
    `;
  }

  log(message, level = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = {
      "info": "ℹ️",
      "success": "✅",
      "error": "❌",
      "debug": "🔍",
    }[level] || "ℹ️";

    const logEntry = `[${timestamp}] ${prefix} ${message}\n`;
    
    if (this.elements.debugLog) {
      this.elements.debugLog.textContent += logEntry;
      this.elements.debugLog.scrollTop = this.elements.debugLog.scrollHeight;
    }
    
    // Also log to console since debug panel was removed
    console.log(`[CTRL] ${message}`);
  }

  clearLog() {
    if (this.elements.debugLog) {
      this.elements.debugLog.textContent = "";
    }
  }

  setupSceneMemoryUI() {
    // Set up click handlers for scene buttons
    const sceneButtons = document.querySelectorAll(".scene-btn");
    sceneButtons.forEach((button) => {
      button.addEventListener("click", (e) => {
        const location = parseInt(button.getAttribute("data-location"));
        if (e.shiftKey) {
          this.saveScene(location);
        } else {
          this.loadScene(location);
        }
      });
    });

    // Update visual indicators for which slots have saved scenes
    this.updateSceneMemoryIndicators();
  }

  updateSceneMemoryIndicators() {
    const sceneButtons = document.querySelectorAll(".scene-btn");
    sceneButtons.forEach((button) => {
      const location = parseInt(button.getAttribute("data-location"));
      const key = `scene_${location}_controller`;
      const hasScene = localStorage.getItem(key) !== null;

      if (hasScene) {
        button.classList.add("has-scene");
      } else {
        button.classList.remove("has-scene");
      }
    });
  }

  saveScene(memoryLocation: number) {
    console.log(`💾 Saving scene to memory location ${memoryLocation}...`);

    try {
      // 1. Get the current applied program state.
      const programToSave = {
        ...this.musicalState,
        savedAt: Date.now()
      };

      // 2. Save it to the controller's local storage.
      localStorage.setItem(
        `scene_${memoryLocation}_controller`,
        JSON.stringify(programToSave),
      );

      // 3. Broadcast the command to all synths.
      if (this.star) {
        const message = MessageBuilder.saveScene(memoryLocation);
        this.star.broadcastToType("synth", message, "control");
      }

      this.log(`Scene ${memoryLocation} saved.`, "success");
      this.updateSceneMemoryIndicators();
    } catch (error) {
      console.error("Error saving scene:", error);
      this.log(
        `Failed to save scene ${memoryLocation}: ${error.message}`,
        "error",
      );
    }
  }

  loadScene(memoryLocation: number) {
    console.log(`📂 Loading scene from memory location ${memoryLocation}...`);

    try {
      const savedProgramString = localStorage.getItem(
        `scene_${memoryLocation}_controller`,
      );
      if (!savedProgramString) {
        this.log(`No scene found at location ${memoryLocation}.`, "error");
        return;
      }

      // 1. Load and parse the saved program.
      const loadedProgram = JSON.parse(savedProgramString);

      // 2. Update the controller's internal state.
      this.pendingMusicalState = loadedProgram;
      this.musicalState = JSON.parse(JSON.stringify(loadedProgram));

      // 3. Update the entire UI to match the loaded state.
      Object.keys(this.musicalState).forEach((paramName) => {
        this._updateUIFromState(paramName as keyof IMusicalState);
      });

      // 4. Broadcast LOAD_SCENE only (contains full program config)
      if (this.star) {
        const message = MessageBuilder.loadScene(memoryLocation, loadedProgram);
        this.star.broadcastToType("synth", message, "control");
      }

      this.log(`Scene ${memoryLocation} loaded and broadcast.`, "success");
      this.updateSceneMemoryIndicators();
    } catch (error) {
      console.error("Error loading scene:", error);
      this.log(
        `Failed to load scene ${memoryLocation}: ${error.message}`,
        "error",
      );
    }
  }

  clearSceneBanks() {
    // 1) Clear controller banks
    for (let i = 0; i <= 9; i++) {
      localStorage.removeItem(`scene_${i}_controller`);
    }
    this.updateSceneMemoryIndicators();
    this.log('Cleared all scene banks', 'success');
    
    // 2) Broadcast clear to synths
    if (this.star) {
      const msg = MessageBuilder.clearBanks();
      this.star.broadcastToType('synth', msg, 'control');
    }
  }

  clearBank(memoryLocation: number) {
    // Clear single bank
    localStorage.removeItem(`scene_${memoryLocation}_controller`);
    this.updateSceneMemoryIndicators();
    this.log(`Cleared scene bank ${memoryLocation}`, 'success');
    
    // Broadcast to synths
    if (this.star) {
      const msg = MessageBuilder.clearScene(memoryLocation);
      this.star.broadcastToType('synth', msg, 'control');
    }
  }

  // Legacy setupParameterRandomizer method removed - now handled by compact controls

  // Close all randomizer modals when clicking outside

  // Update the visual state of randomizer buttons

  // Apply random value to specific start or end

  setupHRGKeyboardNavigation(controlsElement) {
    if (!controlsElement) return;

    // Get all focusable elements within the controls
    const getFocusableElements = () => {
      return controlsElement.querySelectorAll(
        'input[type="text"], select, input[type="checkbox"]',
      );
    };

    // Add Tab navigation and Enter-to-close to all focusable elements
    const setupElementNavigation = () => {
      const focusableElements = getFocusableElements();

      focusableElements.forEach((element, index) => {
        element.addEventListener("keydown", (e) => {
          if (e.key === "Tab") {
            e.preventDefault();
            const nextIndex = e.shiftKey
              ? (index - 1 + focusableElements.length) %
                focusableElements.length
              : (index + 1) % focusableElements.length;
            focusableElements[nextIndex].focus();
          } else if (e.key === "Enter") {
            e.preventDefault();
            // Close the controls
            controlsElement.style.display = "none";
            // Remove active state from associated button
            const button = controlsElement.closest(".parameter-line")
              ?.querySelector(".randomizer-btn");
            if (button) {
              button.classList.remove("active");
              button.focus();
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            // Close the controls
            controlsElement.style.display = "none";
            // Remove active state from associated button
            const button = controlsElement.closest(".parameter-line")
              ?.querySelector(".randomizer-btn");
            if (button) {
              button.classList.remove("active");
              button.focus();
            }
          }
        });
      });
    };

    // Setup navigation when controls become visible
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.type === "attributes" && mutation.attributeName === "style"
        ) {
          if (controlsElement.style.display !== "none") {
            setTimeout(setupElementNavigation, 0);
          }
        }
      });
    });

    observer.observe(controlsElement, { attributes: true });

    // Initial setup if already visible
    if (controlsElement.style.display !== "none") {
      setupElementNavigation();
    }
  }
}

// Initialize the control client
console.log("About to create ControlClient");
const controlClient = new ControlClient();
console.log("ControlClient created successfully");

// Make it globally available for debugging
globalThis.controlClient = controlClient;
