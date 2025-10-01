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
  | { type: "SET_BASE_VALUE"; param: keyof IMusicalState; value: number }
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
  lastPausedHeartbeat: number;
  diagnosticsUpdateId: any;
  hasPendingChanges: boolean;
  pendingParameterChanges: Set<keyof IMusicalState>; // Track which parameters have pending changes
  elements: any;
  synthesisActive: boolean;

  // Kicked state tracking
  wasKicked: boolean;
  kickedReason: string | null;

  // Bulk mode properties
  bulkModeEnabled: boolean;
  bulkChanges: Array<
    {
      type: string;
      paramPath?: string;
      param?: string;
      value?: any;
      portamentoTime?: number;
    }
  >;

  private _createDefaultState(): IMusicalState {
    // Helper for frequency (uses HRG with both start and end generators)
    const defaultFrequencyState = (): ParameterState => ({
      interpolation: "step",
      baseValue: 220,
      startValueGenerator: {
        type: "periodic",
        numerators: "1",
        denominators: "1",
        numeratorBehavior: "static",
        denominatorBehavior: "static",
      },
      endValueGenerator: {
        type: "periodic",
        numerators: "1",
        denominators: "1",
        numeratorBehavior: "static",
        denominatorBehavior: "static",
      },
    });

    // Helper for normalized parameters (0-1 range)
    const defaultNormalizedState = (): ParameterState => ({
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

    // Helper for simple constant parameters
    const defaultConstantState = (value: number): ParameterState => ({
      interpolation: "step",
      baseValue: value,
      startValueGenerator: {
        type: "normalised",
        range: value,
        sequenceBehavior: "static",
      },
    });

    return {
      frequency: defaultFrequencyState(),
      vowelX: defaultNormalizedState(),
      vowelY: defaultNormalizedState(),
      zingAmount: defaultNormalizedState(),
      zingMorph: defaultNormalizedState(),
      symmetry: defaultNormalizedState(),
      amplitude: defaultConstantState(0.8),
      whiteNoise: defaultConstantState(0),
      vibratoWidth: {
        interpolation: "step",
        startValueGenerator: {
          type: "normalised",
          range: 0,
          sequenceBehavior: "static",
        },
      },
      vibratoRate: {
        interpolation: "step",
        baseValue: 5,
        startValueGenerator: {
          type: "periodic",
          numerators: "1",
          denominators: "1",
          numeratorBehavior: "static",
          denominatorBehavior: "static",
        },
        endValueGenerator: {
          type: "periodic",
          numerators: "1",
          denominators: "1",
          numeratorBehavior: "static",
          denominatorBehavior: "static",
        },
      },
    };
  }

  private _updatePendingState(action: ControlAction) {
    console.log("Action dispatched:", action);

    // Create a deep copy of current pending state
    const newState = JSON.parse(JSON.stringify(this.pendingMusicalState));

    switch (action.type) {
      case "SET_BASE_VALUE": {
        const param = newState[action.param];
        param.baseValue = action.value;
        break;
      }

      case "SET_INTERPOLATION": {
        const param = newState[action.param];
        if (action.interpolation === "step") {
          // Step interpolation - only needs start generator
          newState[action.param] = {
            interpolation: "step",
            baseValue: param.baseValue,
            startValueGenerator: param.startValueGenerator,
          };
        } else {
          // Cosine interpolation - needs start and end generators
          newState[action.param] = {
            interpolation: action.interpolation,
            baseValue: param.baseValue,
            startValueGenerator: param.startValueGenerator,
            endValueGenerator: param.endValueGenerator || {
              ...param.startValueGenerator, // Copy start generator as default
            },
          };
        }
        break;
      }

      case "SET_GENERATOR_CONFIG": {
        const param = newState[action.param];
        if (action.position === "start") {
          // Merge config properties into existing generator
          param.startValueGenerator = {
            ...param.startValueGenerator,
            ...action.config,
          };
        } else if (
          action.position === "end" && param.interpolation !== "step" &&
          param.endValueGenerator
        ) {
          // Merge config properties into existing generator
          param.endValueGenerator = {
            ...param.endValueGenerator,
            ...action.config,
          };
        }

        break;
      }
    }

    // Update state before broadcasting to ensure fresh values are read
    this.pendingMusicalState = newState;

    // Broadcast the parameter change if playing (after state update)
    if (action.type === "SET_GENERATOR_CONFIG" && this.isPlaying) {
      this.broadcastSingleParameterStaged(action.param);
    }

    // Update UI to reflect the state change
    if (action.param) {
      this._updateUIFromState(action.param);
    }

    this.markPendingChanges();
  }

  /**
   * Apply HRG changes when paused
   * Updates active state directly and broadcasts only the changed parameter with portamento
   */
  private _applyHRGChangeWithPortamento(action: any) {
    // Update active state with the HRG change (no pending state when paused)
    this._updateActiveState(action);

    // Get portamento time from UI (exponential mapping)
    const portamentoTime = this.elements.portamentoTime
      ? this._mapPortamentoNormToMs(
        parseFloat(this.elements.portamentoTime.value),
      )
      : 100;

    // Use unified broadcast method that respects bulk mode
    this._broadcastParameterChange({
      type: "single",
      param: action.param,
      portamentoTime: portamentoTime,
    });
  }

  /**
   * Check if an input value represents a range (contains hyphen between numbers)
   * @param value The input value to check
   * @returns true if the value represents a range
   */
  private _isRangeValue(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed.includes("-")) return false;

    // Simple range detection: split on hyphen and check if both parts are numbers
    const parts = trimmed.split("-");
    if (parts.length !== 2) return false;

    const [min, max] = parts.map((p) => p.trim());
    const minNum = parseFloat(min);
    const maxNum = parseFloat(max);

    return !isNaN(minNum) && !isNaN(maxNum);
  }

  /**
   * Send sub-parameter update message with staging logic
   * @param paramPath Dot notation path (e.g., "frequency.startValueGenerator.numerators")
   * @param value New value to set
   * @param portamentoTime Optional portamento duration (defaults to UI value)
   */
  private _sendSubParameterUpdate(
    paramPath: string,
    value: any,
    portamentoTime?: number,
  ) {
    const finalPortamentoTime = portamentoTime ??
      (this.elements.portamentoTime
        ? this._mapPortamentoNormToMs(
          parseFloat(this.elements.portamentoTime.value),
        )
        : 100);

    // Check if we should accumulate this change for bulk mode
    if (
      this.addToBulkChanges({
        type: "sub-param-update",
        paramPath: paramPath,
        value: value,
        portamentoTime: finalPortamentoTime,
      })
    ) {
      // Successfully added to bulk queue, don't send immediately
      return;
    }

    // Not in bulk mode, send immediately
    const message = MessageBuilder.subParamUpdate(
      paramPath,
      value,
      finalPortamentoTime,
    );

    // Send to all connected synths
    if (this.star) {
      this.star.broadcastToType("synth", message, "control");
    }
  }

  /**
   * Update the active musical state directly (bypassing pending state)
   * Used when transport is paused for immediate parameter updates
   */
  private _updateActiveState(action: any) {
    // Clone the current active state
    const newState = JSON.parse(JSON.stringify(this.musicalState));

    // Apply the same logic as _updatePendingState but to active state
    switch (action.type) {
      case "SET_BASE_VALUE": {
        const param = newState[action.param];
        param.baseValue = action.value;
        break;
      }

      case "SET_INTERPOLATION": {
        const param = newState[action.param];
        if (action.interpolation === "step") {
          // Step interpolation - only needs start generator
          newState[action.param] = {
            interpolation: "step",
            baseValue: param.baseValue,
            startValueGenerator: param.startValueGenerator,
          };
        } else {
          // Cosine interpolation - needs start and end generators
          newState[action.param] = {
            interpolation: action.interpolation,
            baseValue: param.baseValue,
            startValueGenerator: param.startValueGenerator,
            endValueGenerator: param.endValueGenerator || {
              ...param.startValueGenerator, // Copy start generator as default
            },
          };
        }
        break;
      }

      case "SET_GENERATOR_CONFIG": {
        const param = newState[action.param];
        if (action.position === "start") {
          // Merge config properties into existing generator
          param.startValueGenerator = {
            ...param.startValueGenerator,
            ...action.config,
          };
        } else if (
          action.position === "end" && param.interpolation !== "step" &&
          param.endValueGenerator
        ) {
          // Merge config properties into existing generator
          param.endValueGenerator = {
            ...param.endValueGenerator,
            ...action.config,
          };
        }
        break;
      }
    }

    // Update the active state
    this.musicalState = newState;
    // Also update pending state to keep them in sync
    this.pendingMusicalState = JSON.parse(JSON.stringify(newState));

    // Update UI to reflect the state change
    if (action.param) {
      this._updateUIFromState(action.param);
    }
  }

  constructor() {
    console.log("ControlClient constructor starting");

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
    this.phasorBroadcastRate = 10; // Hz - legacy (now EOC-only)
    this.lastPausedHeartbeat = 0; // Track paused heartbeat timing

    // EOC-staged timing changes
    this.pendingPeriodSec = null; // Pending period change
    this.pendingStepsPerCycle = null; // Pending steps change

    // Period-Steps linkage system
    this.stepRefSec = 0.2; // Reference step interval (≥0.2s)
    this.linkStepsToPeriod = true; // Auto-compute steps from period
    this.currentStepIndex = 0; // Track current step for boundary detection
    this.previousStepIndex = 0; // For detecting step transitions
    this.lastPausedBeaconAt = 0; // Track last paused beacon time

    // Beacon stride constants
    this.MIN_BEACON_INTERVAL_SEC = 0.2;

    // ES-8 Integration
    this.audioContext = null; // AudioContext for ES-8 CV output
    this.es8Enabled = false; // Enable/disable ES-8 output
    this.es8Node = null; // ES-8 AudioWorklet node

    // Parameter staging for EOC application
    this.hasPendingChanges = false; // Track if there are pending parameter changes
    this.pendingParameterChanges = new Set(); // Track which specific parameters have pending changes

    // Bulk mode initialization
    this.bulkModeEnabled = false;
    this.bulkChanges = [];

    // Centralized State Management - replaced old program/directState with typed state

    // Synthesis active state
    this.synthesisActive = false;

    // Initialize kicked state tracking
    this.wasKicked = false;
    this.kickedReason = null;

    // Initialize typed state management
    this.musicalState = this._createDefaultState();
    this.pendingMusicalState = this._createDefaultState();

    // UI Elements
    this.elements = {
      connectionStatus: document.getElementById("connection-status"),
      connectionValue: document.getElementById("connection-status"), // Same element as connectionStatus
      synthesisStatus: document.getElementById("synthesis-status"),
      networkDiagnostics: document.getElementById("network-diagnostics"),
      // Removed peers status - now using synth count in connected synths panel


      manualModeBtn: document.getElementById("manual-mode-btn"),

      // Musical controls
      // Simplified musical controls
      frequencyValue: document.getElementById("frequency-base"),

      // Phasor controls
      periodInput: document.getElementById("period-seconds"),
      stepsInput: document.getElementById("steps-per-cycle"),

      // Transport controls
      playBtn: document.getElementById("play-btn"),
      stopBtn: document.getElementById("stop-btn"),
      resetBtn: document.getElementById("reset-btn"),
      stepsPerCycleSlider: document.getElementById("steps-per-cycle-slider"),
      stepsPerCycleValue: document.getElementById("steps-per-cycle-value"),
      phasorDisplay: document.getElementById("phasor-display"),
      phasorBar: document.getElementById("phasor-bar"),
      phasorTicks: document.getElementById("phasor-ticks"),

      // ES-8 controls
      es8EnableBtn: document.getElementById("es8-enable-btn"),
      es8Status: document.getElementById("es8-status"),

      // Parameter controls
      portamentoTime: document.getElementById("portamento-time"),
      portamentoValue: document.getElementById("portamento-value"),
      reresolveBtn: document.getElementById("reresolve-btn"),
      bulkModeCheckbox: document.getElementById("bulk-mode-checkbox"),
      applyBulkBtn: document.getElementById("apply-bulk-btn"),

      peerList: document.getElementById("peer-list"),
      synthCount: document.getElementById("synth-count"),
      debugLog: document.getElementById("debug-log"),
      clearLogBtn: document.getElementById("clear-log-btn"), // Note: removed from layout

      // Period-Steps linkage controls
      linkStepsCheckbox: document.getElementById("link-steps"),

      // Scene memory
      clearBanksBtn: document.getElementById("clear-banks-btn"),
    };

    console.log("reresolveBtn element:", this.elements.reresolveBtn);
    console.log("portamentoTime element:", this.elements.portamentoTime);

    this.setupEventHandlers();
    this.calculateCycleLength();
    this.initializePhasor();
    this.updatePlayPauseButton(); // Set initial button text

    // Initialize UI to match default parameter state
    Object.keys(this.musicalState).forEach((paramName) => {
      this._updateUIFromState(paramName as keyof IMusicalState);
    });

    this.log("Control client initialized", "info");

    // Auto-connect on page load
    this.connectToNetwork();
  }

  setupEventHandlers() {
    console.log("Setting up event handlers...");

    // Manual mode (button doesn't exist in current layout)
    if (this.elements.manualModeBtn) {
      this.elements.manualModeBtn.addEventListener(
        "click",
        () => this.toggleSynthesis(),
      );
    }


    // Debug log
    // Clear log button (removed from layout)
    if (this.elements.clearLogBtn) {
      this.elements.clearLogBtn.addEventListener(
        "click",
        () => this.clearLog(),
      );
    }

    // Clear banks button
    if (this.elements.clearBanksBtn) {
      this.elements.clearBanksBtn.addEventListener(
        "click",
        () => this.clearSceneBanks(),
      );
    }

    // Portamento controls
    if (this.elements.portamentoTime) {
      this.elements.portamentoTime.addEventListener("input", (e) => {
        const norm = parseFloat((e.target as HTMLInputElement).value);
        const ms = this._mapPortamentoNormToMs(norm);
        const displayMs = ms < 10 ? ms.toFixed(1) : Math.round(ms);
        this.elements.portamentoValue.textContent = `${displayMs}ms`;
      });
    }

    // Re-resolve button
    if (this.elements.reresolveBtn) {
      console.log("✅ Re-resolve button found, adding click handler");
      this.elements.reresolveBtn.addEventListener("click", () => {
        console.log("⚡ Re-resolve button clicked!");
        this.triggerImmediateReinitialize();
      });
    } else {
      console.error("❌ Re-resolve button not found in DOM");
    }

    // Period-Steps linkage controls
    if (this.elements.linkStepsCheckbox) {
      this.elements.linkStepsCheckbox.addEventListener("change", (e) => {
        this.linkStepsToPeriod = e.target.checked;
        this.log(`Period-steps linkage: ${this.linkStepsToPeriod ? 'ON' : 'OFF'}`, "info");
      });
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

  triggerImmediateReinitialize() {
    console.log("⚡ Triggering immediate re-initialization");
    if (!this.star) {
      this.log("No network available", "error");
      return;
    }
    const message = MessageBuilder.immediateReinitialize();
    const sent = this.star.broadcastToType("synth", message, "control");
    this.log(`Sent IMMEDIATE_REINITIALIZE to ${sent} synth(s)`, "info");
  }

  setupMusicalControls() {
    // Note: All synthesis parameters are now handled by setupEnvelopeControls()

    // Envelope controls for all parameters that support them
    this.setupEnvelopeControls();

    // Period and steps inputs
    if (this.elements.periodInput) {
      this.elements.periodInput.addEventListener("blur", (e) => {
        const newPeriod = parseFloat(e.target.value);

        // Validate period is within safe bounds (now 0.2s minimum)
        if (isNaN(newPeriod) || newPeriod < 0.2 || newPeriod > 60) {
          this.log(
            `Invalid period: ${e.target.value}s (must be 0.2-60s)`,
            "error",
          );
          return;
        }

        // Period→Steps linkage
        if (this.linkStepsToPeriod) {
          let targetSteps = Math.round(newPeriod / this.stepRefSec);
          
          // Clamp to [1, 256] - no step interval clamping (beacon stride handles network protection)
          targetSteps = Math.max(1, Math.min(256, targetSteps));
          
          // Update steps input to show computed value
          if (this.elements.stepsInput) {
            this.elements.stepsInput.value = targetSteps.toString();
          }
          
          // Stage both period and computed steps
          this.pendingPeriodSec = newPeriod;
          this.pendingStepsPerCycle = targetSteps;
          
          this.log(`Period staged: ${newPeriod}s, computed steps: ${targetSteps} (pending)`, "info");
        } else {
          // Only stage period change
          this.pendingPeriodSec = newPeriod;
          
          this.log(`Period staged for EOC: ${newPeriod}s (pending)`, "info");
        }
      });
    }

    if (this.elements.stepsInput) {
      this.elements.stepsInput.addEventListener("blur", (e) => {
        let newSteps = parseInt(e.target.value);
        
        // Validate and clamp steps to [1, 256] - no step interval clamping
        if (isNaN(newSteps) || newSteps < 1) {
          newSteps = 1;
        } else if (newSteps > 256) {
          newSteps = 256;
        }
        
        // Update input field if clamped
        if (newSteps !== parseInt(e.target.value)) {
          e.target.value = newSteps.toString();
        }
        
        // Get current or pending period
        const currentPeriod = this.pendingPeriodSec || this.periodSec;
        
        // Update reference step duration based on manual edit
        this.stepRefSec = Math.max(0.2, currentPeriod / newSteps);
        
        // Stage steps change
        this.pendingStepsPerCycle = newSteps;
        
        this.log(`Steps staged: ${newSteps} (step ref: ${this.stepRefSec.toFixed(3)}s) (pending)`, "info");
      });
    }

    // Transport controls
    if (this.elements.playBtn) {
      this.elements.playBtn.addEventListener("click", () => {
        // Toggle between play and pause based on current state
        if (this.isPlaying) {
          this.handleTransport("pause");
        } else {
          this.handleTransport("play");
        }
      });
    }

    if (this.elements.stopBtn) {
      this.elements.stopBtn.addEventListener("click", () => {
        this.handleTransport("stop");
      });
    }

    if (this.elements.resetBtn) {
      this.elements.resetBtn.addEventListener("click", () => {
        this.handleReset();
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

    // Bulk mode controls
    if (this.elements.bulkModeCheckbox) {
      this.elements.bulkModeCheckbox.addEventListener("change", () => {
        this.bulkModeEnabled = this.elements.bulkModeCheckbox.checked;

        // Show/hide apply bulk button
        if (this.elements.applyBulkBtn) {
          this.elements.applyBulkBtn.style.display = this.bulkModeEnabled
            ? "inline-block"
            : "none";
        }

        // Clear any accumulated changes when toggling mode
        this.bulkChanges = [];
        this.updateBulkButtonState();

        console.log(
          `🔄 Bulk mode ${this.bulkModeEnabled ? "enabled" : "disabled"}`,
        );
      });
    }

    if (this.elements.applyBulkBtn) {
      this.elements.applyBulkBtn.addEventListener("click", () => {
        this.applyBulkChanges();
      });
    }

    // Scene Memory UI
    this.setupSceneMemoryUI();

    // Global keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      // Cmd+Enter (Mac) or Ctrl+Enter (PC) triggers Send Program
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        this.log("⌨️ Cmd+Enter pressed", "info");
        // Apply Changes button removed - no longer needed in unified system
        this.log(
          "⌨️ Cmd+Enter no longer triggers Apply Changes (unified system)",
          "info",
        );
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
    this.setupHrgParameterControls("frequency");
    this.setupHrgParameterControls("vibratoRate");
    this.setupCompactParameterControls("vowelX");
    this.setupCompactParameterControls("vowelY");
    this.setupCompactParameterControls("zingAmount");
    this.setupCompactParameterControls("zingMorph");
    this.setupCompactParameterControls("symmetry");
    this.setupCompactParameterControls("amplitude");
    this.setupCompactParameterControls("whiteNoise");
    this.setupCompactParameterControls("vibratoWidth");

    // Initialize all parameter UIs using unified state/UI sync
    Object.keys(this.musicalState).forEach((paramName) => {
      this.setParameterState(
        paramName as keyof IMusicalState,
        this.musicalState[paramName],
      );
    });
  }

  setupCompactParameterControls(paramName) {
    // Get unified parameter control elements
    const interpSelect = document.getElementById(`${paramName}-interpolation`);
    const textInput = document.getElementById(`${paramName}-value`);

    // Get inline control elements for HRG
    const startHrg = document.getElementById(`${paramName}-start-hrg`);
    const endHrg = document.getElementById(`${paramName}-end-hrg`);
    const hrgArrow = document.getElementById(`${paramName}-hrg-arrow`);
    const endValueInput = document.getElementById(`${paramName}-end-value`);

    if (!textInput) return;

    // Handle unified parameter updates on blur
    textInput.addEventListener("blur", () => {
      // First, update the program generator from the input value
      // so that single values become constants (not ranges)
      this._handleValueInput(paramName, textInput.value, "start");

      // Then broadcast the unified update (staged if playing, immediate if paused)
      this.handleUnifiedParameterUpdate(
        paramName as keyof IMusicalState,
        textInput.value,
      );
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
        this._updateUIFromState(paramName);

        this.markPendingChanges();

        // Send unified parameter update during playback
        if (this.isPlaying) {
          this.broadcastSingleParameterStaged(paramName);
        }
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

        // Show/hide end RBG behavior selector based on range detection
        const endBehaviorSelect = document.getElementById(
          `${paramName}-end-rbg-behavior`,
        ) as HTMLSelectElement;
        if (endBehaviorSelect) {
          endBehaviorSelect.style.display =
            this._isRangeValue(endValueInput.value) ? "inline-block" : "none";
        }
      });
    }

    // Add dynamic show/hide logic for start value RBG behavior selector
    if (textInput) {
      textInput.addEventListener("input", () => {
        const startBehaviorSelect = document.getElementById(
          `${paramName}-start-rbg-behavior`,
        ) as HTMLSelectElement;
        if (startBehaviorSelect) {
          startBehaviorSelect.style.display =
            this._isRangeValue(textInput.value) ? "inline-block" : "none";
        }
      });
    }

    // Handle position-specific RBG behavior changes
    const startRbgBehaviorSelect = document.getElementById(
      `${paramName}-start-rbg-behavior`,
    ) as HTMLSelectElement;
    const endRbgBehaviorSelect = document.getElementById(
      `${paramName}-end-rbg-behavior`,
    ) as HTMLSelectElement;

    // Handle start RBG behavior changes
    if (startRbgBehaviorSelect) {
      startRbgBehaviorSelect.addEventListener("change", () => {
        // Send sub-parameter update for the behavior change
        this._sendSubParameterUpdate(
          `${paramName}.startValueGenerator.sequenceBehavior`,
          startRbgBehaviorSelect.value,
        );

        // Re-apply the current start value with the new behavior
        const currentValue = textInput.value;
        this._handleValueInput(paramName, currentValue, "start");
        this.markPendingChanges();
      });
    }

    // Handle end RBG behavior changes
    if (endRbgBehaviorSelect) {
      endRbgBehaviorSelect.addEventListener("change", () => {
        // Send sub-parameter update for the behavior change
        this._sendSubParameterUpdate(
          `${paramName}.endValueGenerator.sequenceBehavior`,
          endRbgBehaviorSelect.value,
        );

        // Re-apply the current end value with the new behavior
        const currentValue = endValueInput.value;
        this._handleValueInput(paramName, currentValue, "end");
        this.markPendingChanges();
      });
    }

    // Initialize behavior selector visibility based on current input values
    if (textInput) {
      const startBehaviorSelect = document.getElementById(
        `${paramName}-start-rbg-behavior`,
      ) as HTMLSelectElement;
      if (startBehaviorSelect) {
        startBehaviorSelect.style.display = this._isRangeValue(textInput.value)
          ? "inline-block"
          : "none";
      }
    }

    if (endValueInput) {
      const endBehaviorSelect = document.getElementById(
        `${paramName}-end-rbg-behavior`,
      ) as HTMLSelectElement;
      if (endBehaviorSelect) {
        endBehaviorSelect.style.display =
          this._isRangeValue(endValueInput.value) ? "inline-block" : "none";
      }
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
        if (false) { // Direct mode merged into unified system
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
              type: "SET_BASE_VALUE",
              param: paramName as keyof IMusicalState,
              value: defaultValue,
            });
            // The UI will automatically update to show this new value because
            // _updatePendingState calls _updateUIFromState
          }

          // With unified format, parameter updates are handled through normal program updates
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

    // HRG parameter controls now handled by setupHrgParameterControls()
    if (false && paramName === "frequency") {
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

          // Only update state when playing (for EOC staging)
          if (this.isPlaying) {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "start",
              config: { numerators: startNumeratorsInput.value },
            });
            this.markPendingChanges();
          }
        });

        // Commit complete value on blur
        startNumeratorsInput.addEventListener("blur", () => {
          if (!this.isPlaying) {
            // When paused: update active state and send with portamento
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "start",
              config: { numerators: startNumeratorsInput.value },
            });
          } else {
            // When playing: update pending state for EOC
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "start",
              config: { numerators: startNumeratorsInput.value },
            });
            this.markPendingChanges();
          }
        });
      }

      if (startDenominatorsInput) {
        startDenominatorsInput.addEventListener("input", () => {
          const { ok } = this._validateSINString(startDenominatorsInput.value);
          startDenominatorsInput.classList.toggle("invalid-input", !ok);

          // Only update state when playing (for EOC staging)
          if (this.isPlaying) {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "start",
              config: { denominators: startDenominatorsInput.value },
            });
            this.markPendingChanges();
          }
        });

        // Commit complete value on blur
        startDenominatorsInput.addEventListener("blur", () => {
          if (!this.isPlaying) {
            // When paused: update active state and send with portamento
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "start",
              config: { denominators: startDenominatorsInput.value },
            });
          } else {
            // When playing: update pending state for EOC
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "start",
              config: { denominators: startDenominatorsInput.value },
            });
            this.markPendingChanges();
          }
        });
      }

      if (startNumBehaviorSelect) {
        startNumBehaviorSelect.addEventListener("change", () => {
          if (!this.isPlaying) {
            // When paused: update active state and send with portamento
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "start",
              config: { numeratorBehavior: startNumBehaviorSelect.value },
            });
          } else {
            // When playing: update pending state for EOC
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "start",
              config: { numeratorBehavior: startNumBehaviorSelect.value },
            });
            this.markPendingChanges();
          }
        });
      }

      if (startDenBehaviorSelect) {
        startDenBehaviorSelect.addEventListener("change", () => {
          if (!this.isPlaying) {
            // When paused: update active state and send with portamento
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "start",
              config: { denominatorBehavior: startDenBehaviorSelect.value },
            });
          } else {
            // When playing: update pending state for EOC
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "start",
              config: { denominatorBehavior: startDenBehaviorSelect.value },
            });
            this.markPendingChanges();
          }
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

          // Only update state when playing (for EOC staging)
          if (this.isPlaying) {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "end",
              config: { numerators: endNumeratorsInput.value },
            });
            this.markPendingChanges();
          }
        });

        // Commit complete value on blur
        endNumeratorsInput.addEventListener("blur", () => {
          if (!this.isPlaying) {
            // When paused: update active state and send with portamento
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "end",
              config: { numerators: endNumeratorsInput.value },
            });
          } else {
            // When playing: update pending state for EOC
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "end",
              config: { numerators: endNumeratorsInput.value },
            });
            this.markPendingChanges();
          }
        });
      }

      if (endDenominatorsInput) {
        endDenominatorsInput.addEventListener("input", () => {
          const { ok } = this._validateSINString(endDenominatorsInput.value);
          endDenominatorsInput.classList.toggle("invalid-input", !ok);

          // Only update state when playing (for EOC staging)
          if (this.isPlaying) {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "end",
              config: { denominators: endDenominatorsInput.value },
            });
            this.markPendingChanges();
          }
        });

        // Commit complete value on blur
        endDenominatorsInput.addEventListener("blur", () => {
          if (!this.isPlaying) {
            // When paused: update active state and send with portamento
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "end",
              config: { denominators: endDenominatorsInput.value },
            });
          } else {
            // When playing: update pending state for EOC
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "end",
              config: { denominators: endDenominatorsInput.value },
            });
            this.markPendingChanges();
          }
        });
      }

      if (endNumBehaviorSelect) {
        endNumBehaviorSelect.addEventListener("change", () => {
          if (!this.isPlaying) {
            // When paused: update active state and send with portamento
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "end",
              config: { numeratorBehavior: endNumBehaviorSelect.value },
            });
          } else {
            // When playing: update pending state for EOC
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "end",
              config: { numeratorBehavior: endNumBehaviorSelect.value },
            });
            this.markPendingChanges();
          }
        });
      }

      if (endDenBehaviorSelect) {
        endDenBehaviorSelect.addEventListener("change", () => {
          if (!this.isPlaying) {
            // When paused: update active state and send with portamento
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "end",
              config: { denominatorBehavior: endDenBehaviorSelect.value },
            });
          } else {
            // When playing: update pending state for EOC
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: paramName,
              position: "end",
              config: { denominatorBehavior: endDenBehaviorSelect.value },
            });
            this.markPendingChanges();
          }
        });
      }
    }

    // Initialize UI to reflect the current typed state
    this._updateUIFromState(paramName);
  }

  setupHrgParameterControls(paramName: keyof IMusicalState) {
    const baseInput = document.getElementById(`${paramName}-base`) as
      | HTMLInputElement
      | null;
    const interpSelect = document.getElementById(
      `${paramName}-interpolation`,
    ) as
      | HTMLSelectElement
      | null;

    // HRG controls are managed identically to before
    // Reuse the HRG listeners from setupCompactParameterControls
    // Start HRG inputs
    const startNumeratorsInput = document.getElementById(
      `${paramName}-start-numerators`,
    ) as HTMLInputElement | null;
    const startDenominatorsInput = document.getElementById(
      `${paramName}-start-denominators`,
    ) as HTMLInputElement | null;
    const startNumBehaviorSelect = document.getElementById(
      `${paramName}-start-numerators-behavior`,
    ) as HTMLSelectElement | null;
    const startDenBehaviorSelect = document.getElementById(
      `${paramName}-start-denominators-behavior`,
    ) as HTMLSelectElement | null;
    // End HRG inputs
    const endNumeratorsInput = document.getElementById(
      `${paramName}-end-numerators`,
    ) as HTMLInputElement | null;
    const endDenominatorsInput = document.getElementById(
      `${paramName}-end-denominators`,
    ) as HTMLInputElement | null;
    const endNumBehaviorSelect = document.getElementById(
      `${paramName}-end-numerators-behavior`,
    ) as HTMLSelectElement | null;
    const endDenBehaviorSelect = document.getElementById(
      `${paramName}-end-denominators-behavior`,
    ) as HTMLSelectElement | null;

    // Base frequency input (Hz)
    if (baseInput) {
      // Validation feedback
      baseInput.addEventListener("input", () => {
        const v = parseFloat(baseInput.value);
        const isValid = Number.isFinite(v);
        baseInput.classList.toggle(
          "invalid-input",
          !isValid && baseInput.value.trim() !== "",
        );
      });

      const applyBase = () => {
        let v = parseFloat(baseInput.value);
        if (!Number.isFinite(v)) return;

        // Parameter-specific clamping
        let min: number, max: number;
        if (paramName === "frequency") {
          min = 16;
          max = 16384;
        } else if (paramName === "vibratoRate") {
          min = 0;
          max = 1024;
        } else {
          // Default fallback for other periodic parameters
          min = 0;
          max = 1000;
        }

        v = Math.max(min, Math.min(max, v));
        baseInput.value = String(v);

        if (this.isPlaying) {
          // Playing: update pending state and send sub-parameter update for staging
          this._updatePendingState({
            type: "SET_BASE_VALUE",
            param: paramName,
            value: v,
          });
          const portamentoTime = this.elements.portamentoTime
            ? this._mapPortamentoNormToMs(
              parseFloat(this.elements.portamentoTime.value),
            )
            : 100;
          this._sendSubParameterUpdate(
            `${paramName}.baseValue`,
            v,
            portamentoTime,
          );

          this.pendingParameterChanges.add(paramName);
          this.updateParameterVisualFeedback(paramName);
        } else {
          // Paused: update active state directly for immediate application
          this._updateActiveState({
            type: "SET_BASE_VALUE",
            param: paramName,
            value: v,
          });
          const portamentoTime = this.elements.portamentoTime
            ? this._mapPortamentoNormToMs(
              parseFloat(this.elements.portamentoTime.value),
            )
            : 100;
          this.broadcastSubParameterUpdate(
            `${paramName}.baseValue`,
            v,
            portamentoTime,
          );

          this.pendingParameterChanges.delete(paramName);
          this.updateParameterVisualFeedback(paramName);
        }
      };

      baseInput.addEventListener("blur", applyBase);
    }

    // Interpolation changes (step/cosine) still apply to frequency envelopes
    if (interpSelect) {
      interpSelect.addEventListener("change", () => {
        const interpolation = interpSelect.value as
          | "step"
          | "linear"
          | "cosine"
          | "parabolic";
        this._updatePendingState({
          type: "SET_INTERPOLATION",
          param: paramName,
          interpolation,
        });
        this.markPendingChanges();

        // Send appropriate update based on playback state
        if (this.isPlaying) {
          // During playback: stage change for EOC
          this.broadcastSingleParameterStaged(paramName);
        } else {
          // When paused: apply immediately
          this.broadcastMusicalParameters();
        }

        // Refresh HRG visibility immediately when interpolation changes
        refreshHrgVisibility();
      });
    }

    // HRG inputs using sub-parameter updates
    if (startNumeratorsInput) {
      startNumeratorsInput.addEventListener("input", () => {
        const { ok } = this._validateSINString(startNumeratorsInput.value);
        startNumeratorsInput.classList.toggle("invalid-input", !ok);
        if (this.isPlaying) {
          // Stage change for EOC during play
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "start",
            config: { numerators: startNumeratorsInput.value },
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged(paramName);
        }
      });
      startNumeratorsInput.addEventListener("blur", () => {
        // Send sub-parameter update for immediate application or staging
        this._sendSubParameterUpdate(
          `${paramName}.startValueGenerator.numerators`,
          startNumeratorsInput.value,
        );

        if (!this.isPlaying) {
          // Update local state immediately when paused
          this._updateActiveState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "start",
            config: { numerators: startNumeratorsInput.value },
          });
        } else {
          // Update pending state for EOC application when playing
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "start",
            config: { numerators: startNumeratorsInput.value },
          });
          this.markPendingChanges();
        }
      });
    }
    if (startDenominatorsInput) {
      startDenominatorsInput.addEventListener("input", () => {
        const { ok } = this._validateSINString(startDenominatorsInput.value);
        startDenominatorsInput.classList.toggle("invalid-input", !ok);
        if (this.isPlaying) {
          // Stage change for EOC during play
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "start",
            config: { denominators: startDenominatorsInput.value },
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged(paramName);
        }
      });
      startDenominatorsInput.addEventListener("blur", () => {
        // Send sub-parameter update for immediate application or staging
        this._sendSubParameterUpdate(
          `${paramName}.startValueGenerator.denominators`,
          startDenominatorsInput.value,
        );

        if (!this.isPlaying) {
          // Update local state immediately when paused
          this._updateActiveState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "start",
            config: { denominators: startDenominatorsInput.value },
          });
        } else {
          // Update pending state for EOC application when playing
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "start",
            config: { denominators: startDenominatorsInput.value },
          });
          this.markPendingChanges();
        }
      });
    }
    if (startNumBehaviorSelect) {
      startNumBehaviorSelect.addEventListener("change", () => {
        // Send sub-parameter update for immediate application or staging
        this._sendSubParameterUpdate(
          `${paramName}.startValueGenerator.numeratorBehavior`,
          startNumBehaviorSelect.value,
        );

        if (!this.isPlaying) {
          // Update local state immediately when paused
          this._updateActiveState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "start",
            config: { numeratorBehavior: startNumBehaviorSelect.value },
          });
        } else {
          // Update pending state for EOC application when playing
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "start",
            config: { numeratorBehavior: startNumBehaviorSelect.value },
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged(paramName);
        }
      });
    }
    if (startDenBehaviorSelect) {
      startDenBehaviorSelect.addEventListener("change", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "start",
            config: { denominatorBehavior: startDenBehaviorSelect.value },
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "start",
            config: { denominatorBehavior: startDenBehaviorSelect.value },
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged(paramName);
        }
      });
    }

    if (endNumeratorsInput) {
      endNumeratorsInput.addEventListener("input", () => {
        const { ok } = this._validateSINString(endNumeratorsInput.value);
        endNumeratorsInput.classList.toggle("invalid-input", !ok);
        if (this.isPlaying) {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "end",
            config: { numerators: endNumeratorsInput.value },
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged(paramName);
        }
      });
      endNumeratorsInput.addEventListener("blur", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "end",
            config: { numerators: endNumeratorsInput.value },
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "end",
            config: { numerators: endNumeratorsInput.value },
          });
          this.markPendingChanges();
        }
      });
    }
    if (endDenominatorsInput) {
      endDenominatorsInput.addEventListener("input", () => {
        const { ok } = this._validateSINString(endDenominatorsInput.value);
        endDenominatorsInput.classList.toggle("invalid-input", !ok);
        if (this.isPlaying) {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "end",
            config: { denominators: endDenominatorsInput.value },
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged(paramName);
        }
      });
      endDenominatorsInput.addEventListener("blur", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "end",
            config: { denominators: endDenominatorsInput.value },
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "end",
            config: { denominators: endDenominatorsInput.value },
          });
          this.markPendingChanges();
        }
      });
    }
    if (endNumBehaviorSelect) {
      endNumBehaviorSelect.addEventListener("change", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "end",
            config: { numeratorBehavior: endNumBehaviorSelect.value },
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "end",
            config: { numeratorBehavior: endNumBehaviorSelect.value },
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged(paramName);
        }
      });
    }
    if (endDenBehaviorSelect) {
      endDenBehaviorSelect.addEventListener("change", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "end",
            config: { denominatorBehavior: endDenBehaviorSelect.value },
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: paramName,
            position: "end",
            config: { denominatorBehavior: endDenBehaviorSelect.value },
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged(paramName);
        }
      });
    }

    // Refresh HRG visibility based on interpolation
    const refreshHrgVisibility = () => {
      const state = this.pendingMusicalState[paramName] ||
        this.musicalState[paramName];
      const isCosine = state?.interpolation === "cosine";

      // Always show the start HRG for HRG params
      const startHrg = document.getElementById(`${paramName}-start-hrg`);
      if (startHrg) startHrg.style.display = "inline-block";

      // Arrow and end HRG are cosine-only
      const arrow = document.getElementById(`${paramName}-hrg-arrow`);
      const endHrg = document.getElementById(`${paramName}-end-hrg`);

      if (arrow) arrow.style.display = isCosine ? "inline-block" : "none";
      if (endHrg) endHrg.style.display = isCosine ? "inline-block" : "none";
    };

    // Call refresh on initialization
    refreshHrgVisibility();

    // Initialize UI for frequency
    this._updateUIFromState("frequency");
  }

  /**
   * Handle value input changes with smart range detection
   */
  private _handleValueInput(
    paramName: string,
    inputValue: string,
    position: "start" | "end",
  ) {
    // Mode select removed - using unified parameter system
    const currentMode = "program";
    const trimmedValue = inputValue.trim();

    // Range detection handled in unified system - no mode switching needed
    if (trimmedValue.includes("-")) {
      // Parse range and continue with unified parameter handling
      // The unified system will handle this appropriately
    }

    if (currentMode === "direct") {
      // Parse direct value from input
      let baseValue;
      if (trimmedValue.includes("-")) {
        // Range format: use average of range
        const [min, max] = trimmedValue.split("-").map((v) =>
          parseFloat(v.trim())
        );
        if (!isNaN(min) && !isNaN(max)) {
          baseValue = (min + max) / 2;
        }
      } else {
        // Single value format
        const value = parseFloat(trimmedValue);
        if (!isNaN(value)) {
          baseValue = value;
        }
      }

      if (baseValue !== undefined) {
        this._updatePendingState({
          type: "SET_BASE_VALUE",
          param: paramName,
          value: baseValue,
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
    // Do not alter HRG (periodic) generators from the base value input
    if (paramName === "frequency" || paramName === "vibratoRate") return;

    if (inputValue.includes("-")) {
      // Range format: create RBG generator
      const [min, max] = inputValue.split("-").map((v) => parseFloat(v.trim()));
      if (!isNaN(min) && !isNaN(max)) {
        // Get behavior from position-specific dropdown (default to "static" if not found)
        const behaviorSelect = document.getElementById(
          `${paramName}-${position}-rbg-behavior`,
        ) as HTMLSelectElement;
        const behavior = behaviorSelect ? behaviorSelect.value : "static";

        this._updatePendingState({
          type: "SET_GENERATOR_CONFIG",
          param: paramName,
          position: position,
          config: {
            type: "normalised",
            range: { min: Math.min(min, max), max: Math.max(min, max) },
            sequenceBehavior: behavior as "static" | "random",
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

        // Start and end RBG inputs are completely independent - no mirroring
      }
    }
  }

  /**
   * Update UI visibility based on current interpolation type
   */

  /**
   * Map normalized portamento value [0,1] to exponential milliseconds
   * 0.5 → 100ms, 1 → 20000ms, 0 → 0.5ms
   */
  private _mapPortamentoNormToMs(norm: number): number {
    const clamped = Math.min(Math.max(norm, 0), 1);
    return 0.5 * Math.pow(40000, clamped);
  }

  /**
   * Serialize normalised generator range to string for UI display
   */
  private _stringifyNormalised(gen: any): string {
    if (!gen) return "";
    const r = gen.range;
    if (typeof r === "number") return String(r);
    if (r && typeof r === "object") {
      const min = Number(r.min), max = Number(r.max);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        return min === max ? String(min) : `${min}-${max}`;
      }
    }
    return "";
  }

  /**
   * Update UI elements to reflect the current typed state
   * This is the reverse of the old DOM-based state management
   * State is now the master, UI is just a reflection of it
   */
  private _updateUIFromState(paramName: keyof IMusicalState) {
    const paramState = this.pendingMusicalState[paramName];

    // Get all UI components for this parameter
    const valueInput =
      (paramName === "frequency" || paramName === "vibratoRate")
        ? (document.getElementById(`${paramName}-base`) as HTMLInputElement)
        : (document.getElementById(`${paramName}-value`) as HTMLInputElement);
    const interpSelect = document.getElementById(
      `${paramName}-interpolation`,
    ) as HTMLSelectElement;
    const hrgStartControls = document.getElementById(`${paramName}-start-hrg`);
    const hrgEndControls = document.getElementById(`${paramName}-end-hrg`);
    const hrgArrow = document.getElementById(`${paramName}-hrg-arrow`);
    const endValueInput = document.getElementById(
      `${paramName}-end-value`,
    ) as HTMLInputElement;

    if (!valueInput) return; // Skip if parameter doesn't exist in UI

    // --- START NEW, CORRECTED LOGIC ---

    // 1. The main value input is ALWAYS visible. Display based on mode and parameter type.
    if (valueInput) {
      valueInput.style.display = "inline-block"; // Ensure it's always visible
      if (paramState.startValueGenerator?.type === "normalised") {
        valueInput.value = this._stringifyNormalised(
          paramState.startValueGenerator,
        );
      } else if (paramState.startValueGenerator?.type === "periodic") {
        valueInput.value = (paramState.baseValue ?? "").toString();
      } else if (paramState.baseValue !== null) {
        valueInput.value = paramState.baseValue.toString();
      } else {
        valueInput.value = ""; // Handle the blank-and-focus case
        valueInput.focus();
      }
    }

    // 2. In unified system, always show interpolation controls
    if (interpSelect) {
      interpSelect.style.display = "inline-block";
      interpSelect.value = paramState.interpolation;
    }

    if (hrgStartControls) {
      hrgStartControls.style.display = "inline";
    }

    // 4. Handle interpolation-dependent controls (end value fields)
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
      endValueInput.value = this._stringifyNormalised(endGen);
    }

    // Ensure HRG UI reflects state (frequency and vibratoRate)
    if (paramName === "frequency" || paramName === "vibratoRate") {
      const startGen = (paramState as any).startValueGenerator;
      if (startGen && startGen.type === "periodic") {
        const startNums = document.getElementById(
          `${paramName}-start-numerators`,
        ) as HTMLInputElement | null;
        const startDens = document.getElementById(
          `${paramName}-start-denominators`,
        ) as HTMLInputElement | null;
        const startNumBeh = document.getElementById(
          `${paramName}-start-numerators-behavior`,
        ) as HTMLSelectElement | null;
        const startDenBeh = document.getElementById(
          `${paramName}-start-denominators-behavior`,
        ) as HTMLSelectElement | null;

        // Only update input values if they're not currently being edited
        if (startNums && document.activeElement !== startNums) {
          startNums.value = startGen.numerators ?? "1";
        }
        if (startDens && document.activeElement !== startDens) {
          startDens.value = startGen.denominators ?? "1";
        }
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
            `${paramName}-end-numerators`,
          ) as HTMLInputElement | null;
          const endDens = document.getElementById(
            `${paramName}-end-denominators`,
          ) as HTMLInputElement | null;
          const endNumBeh = document.getElementById(
            `${paramName}-end-numerators-behavior`,
          ) as HTMLSelectElement | null;
          const endDenBeh = document.getElementById(
            `${paramName}-end-denominators-behavior`,
          ) as HTMLSelectElement | null;
          // Only update input values if they're not currently being edited
          if (endNums && document.activeElement !== endNums) {
            endNums.value = endGen.numerators ?? "1";
          }
          if (endDens && document.activeElement !== endDens) {
            endDens.value = endGen.denominators ?? "1";
          }
          if (endNumBeh) {
            endNumBeh.value = endGen.numeratorBehavior ?? "static";
          }
          if (endDenBeh) {
            endDenBeh.value = endGen.denominatorBehavior ?? "static";
          }
        }
      }

      // Re-sync HRG visibility after updating state
      const isCosine = paramState.interpolation === "cosine";
      if (hrgArrow) hrgArrow.style.display = isCosine ? "inline-block" : "none";
      if (hrgEndControls) {
        hrgEndControls.style.display = isCosine ? "inline-block" : "none";
      }
    }

    // Update RBG behavior selector visibility based on current input values
    // This needs to happen AFTER input fields are populated with actual values
    if (paramName !== "frequency") { // frequency uses HRG, not RBG
      const valueInput = document.getElementById(
        `${paramName}-value`,
      ) as HTMLInputElement;
      const endValueInput = document.getElementById(
        `${paramName}-end-value`,
      ) as HTMLInputElement;

      if (valueInput) {
        const startBehaviorSelect = document.getElementById(
          `${paramName}-start-rbg-behavior`,
        ) as HTMLSelectElement;
        if (startBehaviorSelect) {
          const isRange = this._isRangeValue(valueInput.value);
          startBehaviorSelect.style.display = isRange ? "inline-block" : "none";
        }
      }

      if (endValueInput) {
        const endBehaviorSelect = document.getElementById(
          `${paramName}-end-rbg-behavior`,
        ) as HTMLSelectElement;
        if (endBehaviorSelect) {
          // Hide end behavior selector if interpolation is "step" (no end value) OR if end value is not a range
          const isEnvelope = paramState.interpolation !== "step";
          const isRange = isEnvelope && this._isRangeValue(endValueInput.value);
          endBehaviorSelect.style.display = isRange ? "inline-block" : "none";
        }
      }
    }
  }

  // Capture current HRG inputs into pending state before apply
  private _syncHRGStateFromInputs() {
    const freqState = this.pendingMusicalState.frequency as any;
    if (!freqState || freqState.startValueGenerator?.type !== "periodic") {
      return;
    }

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
    console.log("markPendingChanges called");
    this.hasPendingChanges = true;
    // Apply button removed - staging handled by transport state
  }

  clearPendingChanges() {
    this.hasPendingChanges = false;
    // Apply button removed - staging handled by transport state
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
   * Central method for translating IMusicalState to wire format (unified, scope-free)
   * Used by both broadcastMusicalParameters and sendCompleteStateToSynth
   */
  private _getWirePayload(portamentoTime?: number): any {
    // Strict validation: reject any state with forbidden fields
    for (const key in this.pendingMusicalState) {
      const paramState = this
        .pendingMusicalState[key as keyof IMusicalState] as any;

      // Debug: Check if paramState is an object
      if (typeof paramState !== "object" || paramState === null) {
        throw new Error(
          `CRITICAL: Parameter '${key}' is not an object, got: ${typeof paramState} (${paramState})`,
        );
      }

      if ("scope" in paramState) {
        throw new Error(
          `CRITICAL: Parameter '${key}' has forbidden 'scope' field`,
        );
      }
    }

    const wirePayload: any = {
      synthesisActive: this.synthesisActive,
      isManualMode: this.isManualControlMode,
    };

    // Include portamento time when provided (for paused updates)
    if (portamentoTime !== undefined) {
      wirePayload.portamentoTime = portamentoTime;
    }

    // Send unified parameter format - interpolation + generators only
    for (const key in this.pendingMusicalState) {
      const paramKey = key as keyof IMusicalState;
      const paramState = this.pendingMusicalState[paramKey];

      // Strict validation: require all necessary fields
      if (
        !paramState.interpolation ||
        !["step", "cosine"].includes(paramState.interpolation)
      ) {
        throw new Error(
          `CRITICAL: Parameter '${paramKey}' missing valid interpolation`,
        );
      }

      if (!paramState.startValueGenerator) {
        throw new Error(
          `CRITICAL: Parameter '${paramKey}' missing startValueGenerator`,
        );
      }

      if (
        paramState.interpolation === "cosine" && !paramState.endValueGenerator
      ) {
        throw new Error(
          `CRITICAL: Parameter '${paramKey}' cosine interpolation missing endValueGenerator`,
        );
      }

      if (
        paramState.startValueGenerator.type === "periodic" &&
        paramState.baseValue === undefined
      ) {
        throw new Error(
          `CRITICAL: Parameter '${paramKey}' periodic generator missing baseValue`,
        );
      }

      // Prepare generators
      const startGen = { ...paramState.startValueGenerator };

      let endGen = undefined;
      if (
        paramState.interpolation === "cosine" && paramState.endValueGenerator
      ) {
        endGen = { ...paramState.endValueGenerator };
      }

      // Send unified parameter format (no scope field)
      wirePayload[paramKey] = {
        interpolation: paramState.interpolation,
        startValueGenerator: startGen,
        endValueGenerator: endGen,
        baseValue: paramState.baseValue,
      };
    }
    return wirePayload;
  }

  broadcastMusicalParameters(portamentoTime?: number) {
    // Check if we should accumulate this change for bulk mode
    if (
      this.addToBulkChanges({
        type: "full-program-update",
        portamentoTime: portamentoTime || 100,
      })
    ) {
      // Successfully added to bulk queue, don't send immediately
      return;
    }

    // Not in bulk mode, send immediately
    this._sendFullProgramImmediate(portamentoTime);
  }

  /**
   * Send full program update immediately (extracted from broadcastMusicalParameters)
   */
  private _sendFullProgramImmediate(portamentoTime?: number) {
    if (!this.star) return;

    const wirePayload = this._getWirePayload(portamentoTime);
    console.log("Broadcasting translated payload:", wirePayload);

    const message = MessageBuilder.createParameterUpdate(
      MessageTypes.PROGRAM_UPDATE,
      wirePayload,
    );
    this.star.broadcast(message);
    this.log(
      `📡 Broadcasted musical parameters${
        portamentoTime ? ` with ${portamentoTime}ms portamento` : ""
      }`,
      "info",
    );
  }

  /**
   * Broadcast update for a single parameter with portamento
   * More efficient than broadcasting entire state when only one parameter changed
   */
  broadcastSingleParameterUpdate(
    paramName: keyof IMusicalState,
    portamentoTime: number,
  ) {
    this._broadcastParameterChange({
      type: "single",
      param: paramName,
      portamentoTime: portamentoTime,
    });
  }

  /**
   * Broadcast a sub-parameter update (e.g., frequency.baseValue)
   */
  broadcastSubParameterUpdate(
    paramPath: string,
    value: any,
    portamentoTime: number,
  ) {
    this._broadcastParameterChange({
      type: "sub",
      paramPath: paramPath,
      value: value,
      portamentoTime: portamentoTime,
    });
  }

  // Broadcast a single parameter update for staging at EOC (no portamento field)
  private broadcastSingleParameterStaged(paramName: keyof IMusicalState) {
    if (!this.star) return;

    // Use pending state to get the latest changes (interpolation changes, etc.)
    const paramState = this.pendingMusicalState[paramName] as any;
    if ("scope" in paramState) {
      throw new Error(
        `CRITICAL: Parameter '${paramName}' has forbidden 'scope' field`,
      );
    }

    const wirePayload: any = {
      synthesisActive: this.synthesisActive,
    };

    // Emit unified format with interpolation + generators
    const startGen = { ...paramState.startValueGenerator };
    if (startGen.type === "periodic") {
      startGen.baseValue = paramState.baseValue;
    }

    let endGen = undefined;
    if (paramState.interpolation === "cosine" && paramState.endValueGenerator) {
      endGen = { ...paramState.endValueGenerator };
      if (endGen.type === "periodic") {
        endGen.baseValue = paramState.baseValue;
      }
    }

    wirePayload[paramName] = {
      interpolation: paramState.interpolation,
      startValueGenerator: startGen,
      endValueGenerator: endGen,
      baseValue: paramState.baseValue,
    };

    // For staged updates during playback, we need to send UNIFIED_PARAM_UPDATE messages
    // Get resolved values for this parameter
    const resolvedValues = this.resolveParameterValues(paramName, paramState);

    const message = MessageBuilder.unifiedParamUpdate(
      paramName,
      resolvedValues.start,
      resolvedValues.end,
      paramState.interpolation,
      this.isPlaying,
      100, // default portamento time
      this.phasor, // current phase
    );

    this.star.broadcastToType("synth", message, "control");
    this.log(`📡 Broadcasted staged ${paramName} interpolation change`, "info");
  }

  // Removed splitParametersByMode - no longer needed with separated state

  // Phasor Management Methods
  calculateCycleLength() {
    // Period-based: cycle length equals period in seconds
    this.cycleLength = this.periodSec;
  }

  applyPendingTimingChanges() {
    let changed = false;

    if (this.pendingPeriodSec !== null) {
      // Validate pending period is within safe bounds
      if (
        isNaN(this.pendingPeriodSec) || this.pendingPeriodSec < 0.2 ||
        this.pendingPeriodSec > 60
      ) {
        this.log(
          `Rejected invalid pending period: ${this.pendingPeriodSec}s`,
          "error",
        );
        this.pendingPeriodSec = null;
        return false;
      }

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
    
    // Initialize step indices to avoid spurious initial beacon
    this.currentStepIndex = 0;
    this.previousStepIndex = Math.floor(this.phasor * this.stepsPerCycle);
    
    this.updatePhasorTicks();
    this.startPhasorUpdate();
    this.updatePhasorDisplay();
  }

  updatePhasorTicks() {
    if (!this.elements.phasorTicks) return;

    // Clear existing ticks
    this.elements.phasorTicks.innerHTML = "";

    // Generate new ticks based on stepsPerCycle
    for (let i = 0; i < this.stepsPerCycle; i++) {
      const tick = document.createElement("div");
      tick.className = "phasor-tick";
      tick.style.left = `${(i / this.stepsPerCycle) * 100}%`;
      this.elements.phasorTicks.appendChild(tick);
    }
  }

  updatePhasor() {
    const currentTime = performance.now() / 1000.0;
    const deltaTime = currentTime - this.lastPhasorTime;

    // Only advance phasor when playing
    if (this.isPlaying) {
      // Update phasor with safety checks
      if (this.cycleLength <= 0) {
        console.error(
          `Invalid cycleLength: ${this.cycleLength}, using fallback`,
        );
        this.cycleLength = 0.05; // Fallback to minimum safe value
      }

      const phasorIncrement = deltaTime / this.cycleLength;

      // Safety check for infinity or NaN
      if (!isFinite(phasorIncrement)) {
        console.error(
          `Invalid phasorIncrement: ${phasorIncrement}, deltaTime: ${deltaTime}, cycleLength: ${this.cycleLength}`,
        );
        return; // Skip this frame
      }

      const previousPhasor = this.phasor;
      this.phasor += phasorIncrement;

      // Robust step boundary detection using integer indices
      const prevStepIndex = Math.floor(previousPhasor * this.stepsPerCycle);
      const currStepIndexBeforeWrap = Math.floor(this.phasor * this.stepsPerCycle);

      // Detect EOC (End of Cycle)
      const eocCrossed = this.phasor >= 1.0;

      // Wrap around at 1.0
      if (eocCrossed) {
        this.phasor -= 1.0;
      }

      // Calculate step index after wrapping for display purposes
      const currStepIndex = Math.floor(this.phasor * this.stepsPerCycle);

      // Handle step boundary crossings (use pre-wrap indices for EOC detection)
      if (eocCrossed || currStepIndexBeforeWrap < prevStepIndex) {
        // EOC wrapped - treat as step 0
        this.currentStepIndex = 0;
        
        // Apply timing changes at EOC
        this.applyPendingTimingChanges();
        this.clearAllPendingChanges();
        
        // Send EOC beacon
        this.sendStepBeacon(0);
        
      } else if (currStepIndex !== prevStepIndex) {
        // Normal step boundary crossing
        this.currentStepIndex = currStepIndex;
        
        
        // Calculate stride with current timing (post-apply)
        const stepSec = this.cycleLength / this.stepsPerCycle;
        const stride = Math.max(1, Math.ceil(this.MIN_BEACON_INTERVAL_SEC / stepSec));
        
        // Find latest boundary divisible by stride (handle large jumps)
        const latestStridedStep = Math.floor(currStepIndex / stride) * stride;
        if (latestStridedStep >= prevStepIndex && latestStridedStep <= currStepIndex) {
          this.sendStepBeacon(latestStridedStep);
        }
      }
      
      // Update previous step index
      this.previousStepIndex = currStepIndex;
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

  sendStepBeacon(stepIndex: number) {
    if (!this.star) return;
    
    const boundaryPhasor = stepIndex / this.stepsPerCycle;
    const message = MessageBuilder.phasorSync(
      boundaryPhasor,
      null, // cpm omitted (legacy)
      this.stepsPerCycle,
      this.cycleLength,
      this.isPlaying
    );
    
    this.star.broadcastToType("synth", message, "sync");
    this.lastBroadcastTime = performance.now() / 1000;
  }

  broadcastPhasor(currentTime, reason = "continuous", explicitPhasor = null) {
    if (!this.star) return;

    // Determine phasor value to use
    const phasorToSend = explicitPhasor !== null ? explicitPhasor : this.phasor;

    // EOC-only broadcasting: only send at specific events, not continuously
    if (reason === "continuous") {
      // Send paused heartbeat at 1 Hz when not playing
      if (!this.isPlaying) {
        const timeSinceLastHeartbeat = currentTime - this.lastPausedBeaconAt;
        if (timeSinceLastHeartbeat >= 1.0) { // 1 Hz heartbeat
          const message = MessageBuilder.phasorSync(
            phasorToSend,
            null, // cpm omitted (legacy)
            this.stepsPerCycle,
            this.cycleLength,
            this.isPlaying, // false when paused
          );

          const sent = this.star.broadcastToType("synth", message, "sync");
          this.lastPausedBeaconAt = currentTime;
        }
      }
      return; // No continuous broadcasts while playing
    }

    // Send beacon for specific events (step, EOC, bootstrap, transport changes)
    const message = MessageBuilder.phasorSync(
      phasorToSend,
      null, // cpm omitted (legacy)
      this.stepsPerCycle,
      this.cycleLength,
      this.isPlaying,
    );

    const sent = this.star.broadcastToType("synth", message, "sync");
    this.lastBroadcastTime = currentTime;
  }

  // ES-8 Integration Methods
  async toggleES8() {
    this.es8Enabled = !this.es8Enabled;

    if (this.es8Enabled) {
      await this.initializeES8();
      this.elements.es8EnableBtn.textContent = "disable es-8";
      this.elements.es8EnableBtn.classList.add("active");
      if (this.elements.es8Status) {
        this.elements.es8Status.textContent = "enabled";
        this.elements.es8Status.style.color = "#8f8";
      }
      this.log("ES-8 enabled - CV output active", "success");
    } else {
      this.shutdownES8();
      this.elements.es8EnableBtn.textContent = "enable es-8";
      this.elements.es8EnableBtn.classList.remove("active");
      if (this.elements.es8Status) {
        this.elements.es8Status.textContent = "disabled";
        this.elements.es8Status.style.color = "#f0f0f0";
      }
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

    const wasAtZero = this.phasor === 0.0;

    switch (action) {
      case "play":
        this.isPlaying = true;
        this.lastPhasorTime = performance.now() / 1000.0; // Reset time tracking
        this.log("Global phasor started", "info");

        // Fire EOC event if starting from 0.0 (reset position or initial load)
        if (wasAtZero && this.star) {
          console.log("🔄 Triggering EOC event - playing from reset position");
          const eocMessage = MessageBuilder.jumpToEOC();
          this.star.broadcastToType("synth", eocMessage, "control");

          // Send bootstrap beacon immediately (ignore stride)
          this.sendStepBeacon(Math.floor(this.phasor * this.stepsPerCycle));
        }
        break;
      case "pause":
        this.isPlaying = false;
        // Clear all pending changes when paused (changes apply immediately when paused)
        this.clearAllPendingChanges();
        this.log("Global phasor paused", "info");
        break;
      case "stop":
        this.isPlaying = false;
        this.phasor = 0.0;
        this.lastPhasorTime = performance.now() / 1000.0;
        // Clear all pending changes when stopped
        this.clearAllPendingChanges();
        this.updatePhasorDisplay();
        this.log("Global phasor stopped and reset", "info");
        break;
    }

    // Update play/pause button text
    this.updatePlayPauseButton();

    // Send immediate transport message to synths for instant response
    if (this.star) {
      const transportMessage = MessageBuilder.transport(action);
      this.star.broadcastToType("synth", transportMessage, "control");
    }

    // Broadcast current phasor state immediately with new playing state
    this.broadcastPhasor(performance.now() / 1000.0, "transport");
  }

  updatePlayPauseButton() {
    if (this.elements.playBtn) {
      this.elements.playBtn.textContent = this.isPlaying ? "pause" : "play";
    }
  }

  handleUnifiedParameterUpdate(paramName: keyof IMusicalState, value: string) {
    console.log(`🎛️ Unified parameter update: ${paramName} = ${value}`);

    // Get portamento time (exponential mapping)
    const portamentoTime = this.elements.portamentoTime
      ? this._mapPortamentoNormToMs(
        parseFloat(this.elements.portamentoTime.value),
      )
      : 100;

    // Use unified broadcast method that respects bulk mode
    this._broadcastParameterChange({
      type: "full",
      param: paramName,
      value: value,
      portamentoTime: portamentoTime,
    });
  }

  updateParameterVisualFeedback(paramName: keyof IMusicalState) {
    // Find the parameter label and add/remove asterisk for pending changes
    const paramLabels = document.querySelectorAll(".param-label");
    for (const label of paramLabels) {
      const labelElement = label as HTMLElement;
      const labelText = labelElement.textContent || "";

      // Check if this label is for the parameter we're updating
      const cleanText = labelText.replace("*", "").trim();
      const paramDisplayNames: Record<keyof IMusicalState, string> = {
        frequency: "freq",
        vowelX: "vowel x",
        vowelY: "vowel y",
        symmetry: "symmetry",
        zingAmount: "z amount",
        zingMorph: "z morph",
        amplitude: "amp",
        whiteNoise: "noise",
        vibratoWidth: "vib width",
        vibratoRate: "vib rate",
      };

      if (cleanText === paramDisplayNames[paramName]) {
        const hasPendingChanges = this.pendingParameterChanges.has(paramName);
        const shouldShowAsterisk = hasPendingChanges && this.isPlaying;

        if (shouldShowAsterisk && !labelText.includes("*")) {
          labelElement.textContent = cleanText + "*";
        } else if (!shouldShowAsterisk && labelText.includes("*")) {
          labelElement.textContent = cleanText;
        }
        break;
      }
    }
  }

  clearAllPendingChanges() {
    // Clear all pending parameter changes and update visual feedback
    for (const paramName of this.pendingParameterChanges) {
      this.updateParameterVisualFeedback(paramName);
    }
    this.pendingParameterChanges.clear();
    
    // Clear pending timing changes
    this.pendingPeriodSec = null;
    this.pendingStepsPerCycle = null;
  }

  resolveParameterValues(
    paramName: keyof IMusicalState,
    paramState: ParameterState,
  ) {
    // For step interpolation, only resolve start value
    if (paramState.interpolation === "step") {
      return {
        start: this.resolveGeneratorValue(
          paramState.startValueGenerator,
          paramState.baseValue,
        ),
        end: undefined,
      };
    }

    // For cosine interpolation, resolve both start and end
    const startValue = this.resolveGeneratorValue(
      paramState.startValueGenerator,
      paramState.baseValue,
    );
    const endValue = this.resolveGeneratorValue(
      paramState.endValueGenerator!,
      paramState.baseValue,
    );

    // Debug logging for white noise
    if (paramName === "whiteNoise") {
      console.log(
        `🔍 Resolving whiteNoise: start=${startValue}, end=${endValue}, endGen=${
          JSON.stringify(paramState.endValueGenerator)
        }`,
      );
    }

    return {
      start: startValue,
      end: endValue,
    };
  }

  resolveGeneratorValue(generator: GeneratorConfig, baseValue: number): number {
    if (generator.type === "periodic") {
      // Parse HRG numerators and denominators
      const numerators = this.parseHRGString(generator.numerators || "1");
      const denominators = this.parseHRGString(generator.denominators || "1");

      // Select random values based on behavior
      const numerator = this.selectHRGValue(
        numerators,
        generator.sequenceBehavior,
      );
      const denominator = this.selectHRGValue(
        denominators,
        generator.sequenceBehavior,
      );

      // Calculate ratio and apply to base value
      return (baseValue || 220) * (numerator / denominator);
    } else {
      // Normalized generator - return random value in range
      if (typeof generator.range === "number") {
        return generator.range;
      } else {
        const min = generator.range?.min || 0;
        const max = generator.range?.max || 1;
        return Math.random() * (max - min) + min;
      }
    }
  }

  parseHRGString(input: string): number[] {
    // Parse "1-3,5,7-9" format into [1,2,3,5,7,8,9]
    const result: number[] = [];
    const parts = input.split(",");

    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.includes("-")) {
        const [start, end] = trimmed.split("-").map(Number);
        for (let i = start; i <= end; i++) {
          result.push(i);
        }
      } else {
        result.push(Number(trimmed));
      }
    }

    return result;
  }

  selectHRGValue(values: number[], behavior: string): number {
    // For now, just return random selection
    // TODO: Implement proper sequence behaviors (static, ascending, etc.)
    return values[Math.floor(Math.random() * values.length)];
  }

  handleReset() {
    console.log("Reset phasor");
    
    // Apply any pending timing changes immediately
    this.applyPendingTimingChanges();
    
    // Reset global phasor to 0.0
    this.phasor = 0.0;
    this.currentStepIndex = 0;
    this.previousStepIndex = 0;
    this.lastPhasorTime = performance.now() / 1000.0;
    this.updatePhasorDisplay();

    // Reset stops playback
    this.isPlaying = false;
    this.updatePlayPauseButton();

    // Broadcast reset to synths
    if (this.star) {
      const message = MessageBuilder.jumpToEOC();
      this.star.broadcastToType("synth", message, "control");
    }

    // Send beacon for immediate reset
    this.sendStepBeacon(0);

    this.log("Global phasor reset to 0.0", "info");
  }

  async connectToNetwork() {
    try {
      // Prevent reconnection if we were kicked
      if (this.wasKicked) {
        this.log(
          `Not reconnecting - was kicked: ${this.kickedReason}`,
          "error",
        );
        return;
      }

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
      await this.star.connect(signalingUrl);

      // Initially connected - status will be determined by server response
      this.updateConnectionStatus("connected");

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

    this.star.addEventListener("controller-active", (event) => {
      this.log("Controller is now active", "success");
      this.updateConnectionStatus("active");
      this._updateUIState();
    });

    this.star.addEventListener("peer-connected", (event) => {
      const { peerId } = event.detail;
      this.log(`Peer connected: ${peerId}`, "info");
      this.updatePeerList();
      this._updateUIState();

      // Start network diagnostics updates
      this.startNetworkDiagnostics();

      // Send complete current state to new synths
      if (peerId.startsWith("synth-")) {
        this.sendCompleteStateToSynth(peerId);
      }
    });

    this.star.addEventListener("peer-removed", (event) => {
      this.log(`Peer disconnected: ${event.detail.peerId}`, "info");
      this.updatePeerList();
      this._updateUIState();

      // Update diagnostics or stop if no peers
      if (this.star.peers.size === 0) {
        this.stopNetworkDiagnostics();
      }
    });

    this.star.addEventListener("kicked", (event) => {
      this.handleKicked(event.detail.reason);
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

    // Handle control channel messages (like param-applied from synth)
    this.star.addEventListener("data-channel-message", (event) => {
      if (
        event.detail.channel === "control" &&
        event.detail.data.type === MessageTypes.PARAM_APPLIED
      ) {
        const { param } = event.detail.data;
        this.pendingParameterChanges.delete(param as keyof IMusicalState);
        this.updateParameterVisualFeedback(param as keyof IMusicalState);
        this.log(`Cleared pending asterisk for ${param}`, "debug");
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

    // Broadcast current state to all synths - using unified payload system
    this.broadcastMusicalParameters();

    // Send current phasor state so synths know the current phase position
    this.broadcastPhasor(performance.now() / 1000.0, "transport");
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

    // Remove all status classes
    statusElement.classList.remove(
      "connected",
      "syncing",
      "active",
      "inactive",
      "kicked",
      "error",
    );


    switch (status) {
      case "active":
        valueElement.textContent = "Active Controller ✓";
        statusElement.classList.add("active");
        break;
      case "inactive":
        valueElement.textContent = "Inactive (view only)";
        statusElement.classList.add("inactive");
        break;
      case "kicked":
        valueElement.textContent = "Kicked (reload to retry)";
        statusElement.classList.add("kicked");
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

  handleKicked(reason: string) {
    console.error(`❌ Kicked from network: ${reason}`);

    // Set kicked state to prevent reconnection
    this.wasKicked = true;
    this.kickedReason = reason;

    // Update UI to show kicked status
    this.updateConnectionStatus("kicked");
    this._updateUIState();

    // Show user notification
    alert("You have been disconnected: Another control client has taken over.");

    // Clean up star connection but don't attempt reconnection
    if (this.star) {
      this.star.cleanup();
      this.star = null;
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

  startNetworkDiagnostics() {
    if (this.diagnosticsUpdateId) {
      return; // Already running
    }

    this.diagnosticsUpdateId = setInterval(async () => {
      await this.updateNetworkDiagnostics();
    }, 3000); // Update every 3 seconds

    // Update immediately
    this.updateNetworkDiagnostics();
  }

  stopNetworkDiagnostics() {
    if (this.diagnosticsUpdateId) {
      clearInterval(this.diagnosticsUpdateId);
      this.diagnosticsUpdateId = null;
    }

    // Clear diagnostics display
    if (this.elements.networkDiagnostics) {
      this.elements.networkDiagnostics.innerHTML =
        '<div style="color: #666;">no peers</div>';
    }
  }

  async updateNetworkDiagnostics() {
    if (!this.star || !this.elements.networkDiagnostics) {
      return;
    }

    try {
      const diagnostics = await this.star.getPeerDiagnostics();

      if (diagnostics.length === 0) {
        this.elements.networkDiagnostics.innerHTML =
          '<div style="color: #666;">no peers</div>';
        return;
      }

      const diagnosticsHTML = diagnostics.map((diag) => {
        const connectionColor = diag.connectionState === "connected"
          ? "#8f8"
          : "#f88";
        const iceColor = diag.iceType === "host"
          ? "#8f8"
          : diag.iceType === "srflx"
          ? "#ff8"
          : diag.iceType === "relay"
          ? "#f88"
          : "#888";

        const rttDisplay = diag.rtt !== null ? `${diag.rtt}ms` : "?";
        const droppedWarning = diag.droppedSyncMessages > 0
          ? ` ⚠${diag.droppedSyncMessages}`
          : "";

        return `<div style="margin-bottom: 1px;">
          <span style="color: ${connectionColor};">${
          diag.peerId.split("-")[0]
        }</span>
          <span style="color: ${iceColor}; margin-left: 4px;">${diag.iceType}</span>
          <span style="color: #ccc; margin-left: 4px;">${rttDisplay}</span>${droppedWarning}
        </div>`;
      }).join("");

      this.elements.networkDiagnostics.innerHTML = diagnosticsHTML;
    } catch (error) {
      console.warn("Failed to update network diagnostics:", error);
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
        savedAt: Date.now(),
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

      // Filter out metadata fields like savedAt when loading scene
      const validParams = [
        "frequency",
        "vowelX",
        "vowelY",
        "zingAmount",
        "zingMorph",
        "symmetry",
        "amplitude",
        "whiteNoise",
        "vibratoWidth",
        "vibratoRate",
      ];
      const filteredProgram: Partial<IMusicalState> = {};
      validParams.forEach((param) => {
        if (loadedProgram[param] !== undefined) {
          filteredProgram[param] = loadedProgram[param];
        }
      });

      // 2. Update the controller's internal state.
      this.pendingMusicalState = filteredProgram;
      this.musicalState = JSON.parse(JSON.stringify(filteredProgram));

      // 3. Update the entire UI to match the loaded state.
      Object.keys(this.musicalState).forEach((paramName) => {
        this._updateUIFromState(paramName as keyof IMusicalState);
      });

      // 4. Broadcast LOAD_SCENE only (contains full program config)
      if (this.star) {
        const message = MessageBuilder.loadScene(
          memoryLocation,
          filteredProgram,
        );
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
    this.log("Cleared all scene banks", "success");

    // 2) Broadcast clear to synths
    if (this.star) {
      const msg = MessageBuilder.clearBanks();
      this.star.broadcastToType("synth", msg, "control");
    }
  }

  clearBank(memoryLocation: number) {
    // Clear single bank
    localStorage.removeItem(`scene_${memoryLocation}_controller`);
    this.updateSceneMemoryIndicators();
    this.log(`Cleared scene bank ${memoryLocation}`, "success");

    // Broadcast to synths
    if (this.star) {
      const msg = MessageBuilder.clearScene(memoryLocation);
      this.star.broadcastToType("synth", msg, "control");
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

  /**
   * Update the state of the apply bulk button based on accumulated changes
   */
  updateBulkButtonState() {
    if (this.elements.applyBulkBtn) {
      const hasChanges = this.bulkChanges.length > 0;
      this.elements.applyBulkBtn.disabled = !hasChanges;
      this.elements.applyBulkBtn.textContent = hasChanges
        ? `apply bulk (${this.bulkChanges.length})`
        : "apply bulk";
    }
  }

  /**
   * Apply all accumulated bulk changes at once
   */
  applyBulkChanges() {
    if (this.bulkChanges.length === 0) {
      console.log("🔄 No bulk changes to apply");
      return;
    }

    console.log(`🔄 Applying ${this.bulkChanges.length} bulk changes`);

    // Send all accumulated changes
    this.bulkChanges.forEach((change) => {
      switch (change.type) {
        case "sub-param-update":
          // Send sub-parameter update
          this._sendImmediateParameterChange({
            type: "sub",
            paramPath: change.paramPath!,
            value: change.value,
            portamentoTime: change.portamentoTime!,
          });
          break;

        case "single-param-update":
          // Send single parameter update
          this._sendImmediateParameterChange({
            type: "single",
            param: change.param as keyof IMusicalState,
            portamentoTime: change.portamentoTime!,
          });
          break;

        case "unified-param-update":
          // Send unified parameter update
          this._sendImmediateParameterChange({
            type: "full",
            param: change.param as keyof IMusicalState,
            value: change.value,
            portamentoTime: change.portamentoTime!,
          });
          break;

        case "full-program-update":
          // Send full program update
          this._sendFullProgramImmediate(change.portamentoTime);
          break;

        default:
          console.warn(`🔄 Unknown bulk change type: ${change.type}`);
      }
    });

    // Clear the accumulated changes
    this.bulkChanges = [];
    this.updateBulkButtonState();

    console.log("🔄 Bulk changes applied and cleared");
  }

  /**
   * Add a change to the bulk accumulation queue
   */
  addToBulkChanges(
    change: {
      type: string;
      paramPath?: string;
      value?: any;
      portamentoTime?: number;
    },
  ) {
    if (!this.bulkModeEnabled) {
      return false; // Not in bulk mode
    }

    // Remove any existing change for the same path to avoid duplicates
    if (change.paramPath) {
      this.bulkChanges = this.bulkChanges.filter((c) =>
        c.paramPath !== change.paramPath
      );
    }

    this.bulkChanges.push(change);
    this.updateBulkButtonState();

    console.log(
      `📋 Added to bulk queue: ${change.paramPath} = ${change.value} (${this.bulkChanges.length} total)`,
    );
    return true; // Successfully added to bulk queue
  }

  /**
   * Unified method for broadcasting parameter changes that respects bulk mode
   */
  private _broadcastParameterChange(change: {
    type: "full" | "single" | "sub";
    param?: keyof IMusicalState;
    paramPath?: string;
    value?: any;
    portamentoTime: number;
    payload?: any;
  }) {
    if (!this.star) return;

    // For sub-parameter updates, try to add to bulk mode first
    if (change.type === "sub" && change.paramPath) {
      if (
        this.addToBulkChanges({
          type: "sub-param-update",
          paramPath: change.paramPath,
          value: change.value,
          portamentoTime: change.portamentoTime,
        })
      ) {
        // Successfully added to bulk queue, don't send immediately
        return;
      }
    }

    // For single parameter updates, create bulk change format
    if (change.type === "single" && change.param) {
      if (
        this.addToBulkChanges({
          type: "single-param-update",
          param: change.param,
          portamentoTime: change.portamentoTime,
        })
      ) {
        // Successfully added to bulk queue, don't send immediately
        return;
      }
    }

    // For full parameter updates
    if (change.type === "full" && change.param && change.value !== undefined) {
      if (
        this.addToBulkChanges({
          type: "unified-param-update",
          param: change.param,
          value: change.value,
          portamentoTime: change.portamentoTime,
        })
      ) {
        // Successfully added to bulk queue, don't send immediately
        return;
      }
    }

    // Not in bulk mode or bulk mode disabled, send immediately
    this._sendImmediateParameterChange(change);
  }

  /**
   * Send parameter change immediately (bypassing bulk mode)
   */
  private _sendImmediateParameterChange(change: {
    type: "full" | "single" | "sub";
    param?: keyof IMusicalState;
    paramPath?: string;
    value?: any;
    portamentoTime: number;
    payload?: any;
  }) {
    if (!this.star) return;

    switch (change.type) {
      case "sub":
        if (change.paramPath && change.value !== undefined) {
          const message = MessageBuilder.subParamUpdate(
            change.paramPath,
            change.value,
            change.portamentoTime,
          );
          this.star.broadcastToType("synth", message, "control");
          this.log(
            `📡 Sub-param: ${change.paramPath} = ${change.value} (${change.portamentoTime}ms)`,
            "info",
          );
        }
        break;

      case "single":
        if (change.param) {
          // Use existing broadcastSingleParameterUpdate logic
          this._sendSingleParameterImmediate(
            change.param,
            change.portamentoTime,
          );
        }
        break;

      case "full":
        if (change.param && change.value !== undefined) {
          // Use existing handleUnifiedParameterUpdate logic
          this._sendUnifiedParameterImmediate(
            change.param,
            change.value,
            change.portamentoTime,
          );
        }
        break;
    }
  }

  /**
   * Send single parameter update immediately (extracted from broadcastSingleParameterUpdate)
   */
  private _sendSingleParameterImmediate(
    paramName: keyof IMusicalState,
    portamentoTime: number,
  ) {
    const paramState = this.pendingMusicalState[paramName];

    // Strict validation: reject forbidden scope field
    if ("scope" in (paramState as any)) {
      throw new Error(
        `CRITICAL: Parameter '${paramName}' has forbidden 'scope' field`,
      );
    }

    // Create minimal payload with only the changed parameter
    const wirePayload: any = {
      synthesisActive: this.synthesisActive,
      portamentoTime: portamentoTime,
    };

    // Prepare unified parameter format (no scope)
    const startGen = { ...paramState.startValueGenerator };

    let endGen = undefined;
    if (paramState.interpolation === "cosine" && paramState.endValueGenerator) {
      endGen = { ...paramState.endValueGenerator };
    }

    wirePayload[paramName] = {
      interpolation: paramState.interpolation,
      startValueGenerator: startGen,
      endValueGenerator: endGen,
      baseValue: paramState.baseValue,
    };

    const message = MessageBuilder.createParameterUpdate(
      MessageTypes.PROGRAM_UPDATE,
      wirePayload,
    );
    this.star.broadcastToType("synth", message, "control");
    this.log(
      `📡 Broadcasted ${paramName} update with ${portamentoTime}ms portamento`,
      "info",
    );
  }

  /**
   * Send unified parameter update immediately (extracted from handleUnifiedParameterUpdate)
   */
  private _sendUnifiedParameterImmediate(
    paramName: keyof IMusicalState,
    value: string,
    portamentoTime: number,
  ) {
    // Update the baseValue in our state
    this._updatePendingState({
      type: "SET_BASE_VALUE",
      param: paramName,
      value: parseFloat(value) || 0,
    });

    // Resolve HRG values here in controller
    const paramState = this.pendingMusicalState[paramName];
    const resolvedValues = this.resolveParameterValues(paramName, paramState);

    // Create unified parameter message using message builder
    const message = MessageBuilder.unifiedParamUpdate(
      paramName,
      resolvedValues.start,
      resolvedValues.end,
      paramState.interpolation,
      this.isPlaying,
      portamentoTime,
      this.phasor, // Include current phase for interpolation
    );

    this.star.broadcastToType("synth", message, "control");

    // Track pending changes when playing for visual feedback
    if (this.isPlaying) {
      this.pendingParameterChanges.add(paramName);
      this.updateParameterVisualFeedback(paramName);
    } else {
      // When paused, changes are immediate, so clear any pending status
      this.pendingParameterChanges.delete(paramName);
      this.updateParameterVisualFeedback(paramName);
    }

    const statusIcon = this.isPlaying ? "📋*" : "⚡";
    this.log(
      `${statusIcon} ${paramName}: ${resolvedValues.start}${
        resolvedValues.end !== undefined ? ` → ${resolvedValues.end}` : ""
      } (${portamentoTime}ms)`,
      "info",
    );
  }
}

// Initialize the control client
console.log("About to create ControlClient");
const controlClient = new ControlClient();
console.log("ControlClient created successfully");

// Make it globally available for debugging
globalThis.controlClient = controlClient;
