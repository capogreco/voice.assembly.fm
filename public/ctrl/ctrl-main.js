// @ts-check

/**
 * Voice.Assembly.FM Control Client Main Application
 * Converted from TypeScript to JavaScript + JSDoc
 */

// JSDoc type imports (no runtime cost)
/** @typedef {import('../../src/common/parameter-types.js').IMusicalState} IMusicalState */
/** @typedef {import('../../src/common/parameter-types.js').ParameterState} ParameterState */
/** @typedef {import('../../src/common/parameter-types.js').GeneratorConfig} GeneratorConfig */

// Runtime imports
import { generatePeerId, WebRTCStar } from "../../src/common/webrtc-star.js";
import {
  MessageBuilder,
  MessageTypes,
} from "../../src/common/message-protocol.js";
import { setupEventHandlers, setupEnvelopeControls } from "./ui/controls.js";
import { setupCompactParameterControls, setupHrgParameterControls } from "./ui/schema.js";
import { initializeApplication } from "./app/init.js";

/**
 * Control action types for state management
 * @typedef {Object} ControlAction
 * @property {"SET_BASE_VALUE" | "SET_INTERPOLATION" | "SET_GENERATOR_CONFIG"} type
 * @property {string} [param] - Parameter name
 * @property {number} [value] - Parameter value
 * @property {"step" | "cosine"} [interpolation] - Interpolation type
 * @property {"start" | "end"} [position] - Generator position
 * @property {GeneratorConfig} [config] - Generator configuration
 */

class ControlClient {

  /**
   * Create default musical state
   * @returns {IMusicalState}
   */
  _createDefaultState() {
    // Helper for frequency (uses HRG with both start and end generators)
    const defaultFrequencyState = () => ({
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
    const defaultNormalizedState = () => ({
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
    const defaultConstantState = (value) => ({
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

  /**
   * Preset configurations for destructive state replacement
   */
  _createPresetConfigs() {
    // Helper for maximally stochastic normalized step parameters
    const normalizedRandomStep = () => ({
      interpolation: "step",
      startValueGenerator: {
        type: "normalised",
        range: { min: 0, max: 1 },
        sequenceBehavior: "random",
      },
      endValueGenerator: {
        type: "normalised",
        range: { min: 0, max: 1 },
        sequenceBehavior: "random",
      },
    });

    // Helper for maximally stochastic normalized cosine parameters
    const normalizedRandomCosine = () => ({
      interpolation: "cosine",
      startValueGenerator: {
        type: "normalised",
        range: { min: 0, max: 1 },
        sequenceBehavior: "random",
      },
      endValueGenerator: {
        type: "normalised",
        range: { min: 0, max: 1 },
        sequenceBehavior: "random",
      },
    });

    // Helper for maximally stochastic periodic step parameters
    const periodicRandomStep = (baseValue) => ({
      interpolation: "step",
      baseValue,
      startValueGenerator: {
        type: "periodic",
        numerators: "1-12",
        denominators: "1-12",
        numeratorBehavior: "random",
        denominatorBehavior: "random",
      },
      endValueGenerator: {
        type: "periodic",
        numerators: "1-12",
        denominators: "1-12",
        numeratorBehavior: "random",
        denominatorBehavior: "random",
      },
    });

    // Helper for maximally stochastic periodic cosine parameters
    const periodicRandomCosine = (baseValue) => ({
      interpolation: "cosine",
      baseValue,
      startValueGenerator: {
        type: "periodic",
        numerators: "1-12",
        denominators: "1-12",
        numeratorBehavior: "random",
        denominatorBehavior: "random",
      },
      endValueGenerator: {
        type: "periodic",
        numerators: "1-12",
        denominators: "1-12",
        numeratorBehavior: "random",
        denominatorBehavior: "random",
      },
    });

    // Helper for simple constant parameters
    const constantStep = (value) => ({
      interpolation: "step",
      startValueGenerator: {
        type: "normalised",
        range: value,
        sequenceBehavior: "static",
      },
      endValueGenerator: {
        type: "normalised",
        range: value,
        sequenceBehavior: "static",
      },
    });

    return {
      default: this._createDefaultState(),
      
      "full-step": {
        // Periodic parameters - maximum stochasticity with random HRG ranges
        frequency: periodicRandomStep(220),
        vibratoRate: periodicRandomStep(5),
        
        // Normalized parameters - maximum stochasticity across full [0,1] range
        vowelX: normalizedRandomStep(),
        vowelY: normalizedRandomStep(),
        zingAmount: normalizedRandomStep(),
        zingMorph: normalizedRandomStep(),
        symmetry: normalizedRandomStep(),
        vibratoWidth: normalizedRandomStep(),
        
        // Fixed levels for consistent loudness
        amplitude: constantStep(0.5),
        whiteNoise: constantStep(0),
      },
      
      "full-cos": {
        // Periodic parameters - maximum stochasticity with random HRG ranges and cosine motion
        frequency: periodicRandomCosine(220),
        vibratoRate: periodicRandomCosine(5),
        
        // Normalized parameters - maximum stochasticity with cosine glides across full [0,1]
        vowelX: normalizedRandomCosine(),
        vowelY: normalizedRandomCosine(),
        zingAmount: normalizedRandomCosine(),
        zingMorph: normalizedRandomCosine(),
        symmetry: normalizedRandomCosine(),
        vibratoWidth: normalizedRandomCosine(),
        
        // Fixed levels for consistent loudness
        amplitude: constantStep(0.5),
        whiteNoise: constantStep(0),
      },
      
      calibration: {
        // Only override amp=0 and noise=0.3, leave others unchanged from current state
        ...this.pendingMusicalState, // Preserve current state
        amplitude: constantStep(0), // Silent
        whiteNoise: constantStep(0.3), // Audible for level matching
      },
    };
  }

  _updatePendingState(action) {
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
              ...param.startValueGenerator, // Copy start generator
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
  _applyHRGChangeWithPortamento(action) {
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
   * Check if value is a range (contains hyphen)
   * @param {string} value
   * @returns {boolean}
   */
  _isRangeValue(value) {
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
   * @param {string} paramPath - Dot notation path (e.g., "frequency.startValueGenerator.numerators")
   * @param {any} value - New value to set
   * @param {number} [portamentoTime] - Optional portamento duration (defaults to UI value)
   */
  _sendSubParameterUpdate(
    paramPath,
    value,
    portamentoTime,
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
  _updateActiveState(action) {
    // Clone the current active state
    const newState = JSON.parse(JSON.stringify(this.musicalState));

    // Apply the same logic_updatePendingState but to active state
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
              ...param.startValueGenerator, // Copy start generator
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

  /**
   * Apply a preset configuration (destructive replacement)
   */
  _applyPreset(presetName) {
    const presets = this._createPresetConfigs();
    const preset = presets[presetName];
    
    if (!preset) {
      console.error("Unknown preset: " + presetName);
      return;
    }

    console.log("Applying preset: " + presetName);
    
    // Debug: Log the preset configuration for frequency
    if (presetName === "full-cos" && preset.frequency) {
      console.log("🐛 full-cos frequency config:", JSON.stringify(preset.frequency, null, 2));
    }

    // Destructively replace both pending and active state
    this.pendingMusicalState = JSON.parse(JSON.stringify(preset));
    this.musicalState = JSON.parse(JSON.stringify(preset));
    
    // Debug: Verify the state was set correctly
    if (presetName === "full-cos" && this.pendingMusicalState.frequency) {
      console.log("🐛 pendingMusicalState.frequency after preset:", JSON.stringify(this.pendingMusicalState.frequency, null, 2));
    }

    // Update all UI elements to reflect new state
    for (const paramName of Object.keys(preset)) {
      this._updateUIFromState(paramName);
    }
    
    // Debug: Check state again after UI update
    if (presetName === "full-cos" && this.pendingMusicalState.frequency) {
      console.log("🐛 pendingMusicalState.frequency after UI update:", JSON.stringify(this.pendingMusicalState.frequency, null, 2));
    }

    // Mark pending changes and always broadcast
    this.markPendingChanges();
    this.broadcastMusicalParameters();
    
    if (this.isPlaying) {
      // During playback: synth will stage PROGRAM_UPDATE and apply at EOC
      console.log("📋 Preset " + presetName + " staged for EOC application");
    } else {
      // When paused: synth will apply immediately
      console.log("📋 Preset " + presetName + " applied immediately");
    }
  }

  constructor() {
    initializeApplication(this);
  }


  reresolveAtEOC() {
    console.log("🔀 reresolveAtEOC() called");
    if (!this.star) {
      console.error("No WebRTC star available for re-resolve");
      return;
    }
    console.log("📡 Creating re-resolve message...");
    const message = MessageBuilder.reresolveAtEOC();
    console.log("📤 Broadcasting re-resolve message:", message);
    const sent = this.star.broadcastToType("synth", message, "control");
    console.log("Re-resolve message sent to " + sent + " synths");
    this.log(
      "🔀 Re-resolve requested for " + sent + " synths at next EOC",
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
    this.log("Sent IMMEDIATE_REINITIALIZE to " + sent + " synth(s)", "info");
  }




  /**
   * Handle value input changes with smart range detection
   * @param {string} paramName
   * @param {string} inputValue  
   * @param {"start" | "end"} position
   */
  _handleValueInput(
    paramName,
    inputValue,
    position,
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
  _updateProgramGenerator(
    paramName,
    inputValue,
    position,
  ) {
    // Do not alter HRG (periodic) generators from the base value input
    if (paramName === "frequency" || paramName === "vibratoRate") return;

    if (inputValue.includes("-")) {
      // Range format: create RBG generator
      const [min, max] = inputValue.split("-").map((v) => parseFloat(v.trim()));
      if (!isNaN(min) && !isNaN(max)) {
        // Get behavior from position-specific dropdown (default to "static" if not found)
        const behaviorSelect = document.getElementById(
          paramName + "-" + position + "-rbg-behavior",
        );
        const behavior = behaviorSelect ? behaviorSelect.value : "static";

        this._updatePendingState({
          type: "SET_GENERATOR_CONFIG",
          param: paramName,
          position: position,
          config: {
            type: "normalised",
            range: { min: Math.min(min, max), max: Math.max(min, max) },
            sequenceBehavior: behavior,
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
  _mapPortamentoNormToMs(norm) {
    const clamped = Math.min(Math.max(norm, 0), 1);
    return 0.5 * Math.pow(40000, clamped);
  }

  /**
   * Serialize normalised generator range to string for UI display
   */
  _stringifyNormalised(gen) {
    if (!gen) return "";
    const r = gen.range;
    if (typeof r === "number") return String(r);
    if (r && typeof r === "object") {
      const min = Number(r.min), max = Number(r.max);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        return min === max ? String(min) : min + "-" + max;
      }
    }
    return "";
  }

  /**
   * Update UI elements to reflect the current typed state
   * This is the reverse of the old DOM-based state management
   * State is now the master, UI is just a reflection of it
   */
  _updateUIFromState(paramName) {
    const paramState = this.pendingMusicalState[paramName];

    // Get all UI components for this parameter
    const valueInput =
      (paramName === "frequency" || paramName === "vibratoRate")
        ? (document.getElementById(paramName + "-base"))
        : (document.getElementById(paramName + "-value"));
    const interpSelect = document.getElementById(
      paramName + "-interpolation",
    );
    const hrgStartControls = document.getElementById(paramName + "-start-hrg");
    const hrgEndControls = document.getElementById(paramName + "-end-hrg");
    const hrgArrow = document.getElementById(paramName + "-hrg-arrow");
    const endValueInput = document.getElementById(
      paramName + "-end-value",
    );

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
      const startGen = (paramState).startValueGenerator;
      if (startGen && startGen.type === "periodic") {
        const startNums = document.getElementById(
          paramName + "-start-numerators",
        ) || null;
        const startDens = document.getElementById(
          paramName + "-start-denominators",
        ) || null;
        const startNumBeh = document.getElementById(
          paramName + "-start-numerators-behavior",
        ) || null;
        const startDenBeh = document.getElementById(
          paramName + "-start-denominators-behavior",
        ) || null;

        // Debug logging for frequency HRG updates
        if (paramName === "frequency") {
          console.log("🐛 Updating frequency HRG UI with startGen:", JSON.stringify(startGen, null, 2));
          console.log("🐛 Current UI values - startNums:", startNums?.value, "startDens:", startDens?.value, "startNumBeh:", startNumBeh?.value, "startDenBeh:", startDenBeh?.value);
        }

        // Only update input values if they're not currently being edited
        if (startNums && document.activeElement !== startNums) {
          const numValue = startGen.numerators ?? "1";
          startNums.value = numValue;
          if (paramName === "frequency") {
            console.log("🐛 Set start numerators to:", numValue);
          }
        } else if (startNums && paramName === "frequency") {
          console.log("🐛 NOT setting start numerators because startNums has focus");
        }
        if (startDens && document.activeElement !== startDens) {
          const denValue = startGen.denominators ?? "1";
          startDens.value = denValue;
          if (paramName === "frequency") {
            console.log("🐛 Set start denominators to:", denValue);
          }
        }
        if (startNumBeh) {
          const numBehValue = startGen.numeratorBehavior ?? "static";
          startNumBeh.value = numBehValue;
          if (paramName === "frequency") {
            console.log("🐛 Set start numerator behavior to:", numBehValue);
          }
        }
        if (startDenBeh) {
          const denBehValue = startGen.denominatorBehavior ?? "static";
          startDenBeh.value = denBehValue;
          if (paramName === "frequency") {
            console.log("🐛 Set start denominator behavior to:", denBehValue);
          }
        }
      }

      if (isEnvelope) {
        const endGen = (paramState).endValueGenerator;
        if (endGen && endGen.type === "periodic") {
          const endNums = document.getElementById(
            paramName + "-end-numerators",
          ) || null;
          const endDens = document.getElementById(
            paramName + "-end-denominators",
          ) || null;
          const endNumBeh = document.getElementById(
            paramName + "-end-numerators-behavior",
          ) || null;
          const endDenBeh = document.getElementById(
            paramName + "-end-denominators-behavior",
          ) || null;

          // Debug logging for frequency HRG end updates
          if (paramName === "frequency") {
            console.log("🐛 Updating frequency HRG end UI with endGen:", JSON.stringify(endGen, null, 2));
          }

          // Only update input values if they're not currently being edited
          if (endNums && document.activeElement !== endNums) {
            const endNumValue = endGen.numerators ?? "1";
            endNums.value = endNumValue;
            if (paramName === "frequency") {
              console.log("🐛 Set end numerators to:", endNumValue);
            }
          }
          if (endDens && document.activeElement !== endDens) {
            const endDenValue = endGen.denominators ?? "1";
            endDens.value = endDenValue;
            if (paramName === "frequency") {
              console.log("🐛 Set end denominators to:", endDenValue);
            }
          }
          if (endNumBeh) {
            const endNumBehValue = endGen.numeratorBehavior ?? "static";
            endNumBeh.value = endNumBehValue;
            if (paramName === "frequency") {
              console.log("🐛 Set end numerator behavior to:", endNumBehValue);
            }
          }
          if (endDenBeh) {
            const endDenBehValue = endGen.denominatorBehavior ?? "static";
            endDenBeh.value = endDenBehValue;
            if (paramName === "frequency") {
              console.log("🐛 Set end denominator behavior to:", endDenBehValue);
            }
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
        paramName + "-value",
      );
      const endValueInput = document.getElementById(
        paramName + "-end-value",
      );

      if (valueInput) {
        const startBehaviorSelect = document.getElementById(
          paramName + "-start-rbg-behavior",
        );
        if (startBehaviorSelect) {
          const isRange = this._isRangeValue(valueInput.value);
          startBehaviorSelect.style.display = isRange ? "inline-block" : "none";
        }
      }

      if (endValueInput) {
        const endBehaviorSelect = document.getElementById(
          paramName + "-end-rbg-behavior",
        );
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
  _syncHRGStateFromInputs() {
    const freqState = this.pendingMusicalState.frequency;
    if (!freqState || freqState.startValueGenerator?.type !== "periodic") {
      return;
    }

    let anyInvalid = false;

    // Helper to validate and mark
    const validateField = (el, label) => {
      if (!el) return true;
      const { ok } = this._validateSINString(el.value);
      el.classList.toggle("invalid-input", !ok);
      if (!ok) {
        this.log(
          "Invalid " + label + ": \"" + el.value + "\" (use numbers, commas, and ranges like 1-6)",
          "error",
        );
      }
      return ok;
    };

    // Validate all four fields first
    const v1 = validateField(
      document.getElementById("frequency-start-numerators"),
      "start numerators",
    );
    const v2 = validateField(
      document.getElementById("frequency-start-denominators"),
      "start denominators",
    );
    const v3 = validateField(
      document.getElementById("frequency-end-numerators"),
      "end numerators",
    );
    const v4 = validateField(
      document.getElementById("frequency-end-denominators"),
      "end denominators",
    );
    anyInvalid = !(v1 && v2 && v3 && v4);

    if (anyInvalid) {
      return false;
    }

    // Start generator
    if (freqState.startValueGenerator?.type === "periodic") {
      const startNums =
        (document.getElementById("frequency-start-numerators")
          | null)?.value;
      const startDens =
        (document.getElementById("frequency-start-denominators")
          | null)?.value;
      const startNumBeh =
        (document.getElementById("frequency-start-numerators-behavior")
          | HTMLSelectElement
          | null)?.value;
      const startDenBeh =
        (document.getElementById("frequency-start-denominators-behavior")
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
      const endNums = (document.getElementById("frequency-end-numerators")
        | null)?.value;
      const endDens = (document.getElementById("frequency-end-denominators")
        | null)?.value;
      const endNumBeh =
        (document.getElementById("frequency-end-numerators-behavior")
          | HTMLSelectElement
          | null)?.value;
      const endDenBeh =
        (document.getElementById("frequency-end-denominators-behavior")
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
  setParameterState(paramName, newState) {
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
  _validateSINString(str) {
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
  _getWirePayload(portamentoTime) {
    // Strict validation: reject any state with forbidden fields
    for (const key in this.pendingMusicalState) {
      const paramState = this
        .pendingMusicalState[key];

      // Debug: Check if paramState is an object
      if (typeof paramState !== "object" || paramState === null) {
        throw new Error(
          "CRITICAL: Parameter '" + key + "' is not an object, got: " + typeof paramState + " (" + paramState + ")",
        );
      }

      if ("scope" in paramState) {
        throw new Error(
          "CRITICAL: Parameter '" + key + "' has forbidden 'scope' field",
        );
      }
    }

    const wirePayload = {
      synthesisActive: this.synthesisActive,
      isManualMode: this.isManualControlMode,
    };

    // Include portamento time when provided (for paused updates)
    if (portamentoTime !== undefined) {
      wirePayload.portamentoTime = portamentoTime;
    }

    // Send unified parameter format - interpolation + generators only
    for (const key in this.pendingMusicalState) {
      const paramKey = key;
      const paramState = this.pendingMusicalState[paramKey];

      // Strict validation: require all necessary fields
      if (
        !paramState.interpolation ||
        !["step", "cosine"].includes(paramState.interpolation)
      ) {
        throw new Error(
          "CRITICAL: Parameter '" + paramKey + "' missing valid interpolation",
        );
      }

      if (!paramState.startValueGenerator) {
        throw new Error(
          "CRITICAL: Parameter '" + paramKey + "' missing startValueGenerator",
        );
      }

      if (
        paramState.interpolation === "cosine" && !paramState.endValueGenerator
      ) {
        throw new Error(
          "CRITICAL: Parameter '" + paramKey + "' cosine interpolation missing endValueGenerator",
        );
      }

      if (
        paramState.startValueGenerator.type === "periodic" &&
        paramState.baseValue === undefined
      ) {
        throw new Error(
          "CRITICAL: Parameter '" + paramKey + "' periodic generator missing baseValue",
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

  broadcastMusicalParameters(portamentoTime) {
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
  _sendFullProgramImmediate(portamentoTime) {
    if (!this.star) return;

    const wirePayload = this._getWirePayload(portamentoTime);
    console.log("Broadcasting translated payload:", wirePayload);

    const message = MessageBuilder.createParameterUpdate(
      MessageTypes.PROGRAM_UPDATE,
      wirePayload,
    );
    this.star.broadcast(message);
    this.log(
      "📡 Broadcasted musical parameters" +
        (portamentoTime ? " with " + portamentoTime + "ms portamento" : ""),
      "info",
    );
  }

  /**
   * Broadcast update for a single parameter with portamento
   * More efficient than broadcasting entire state when only one parameter changed
   */
  broadcastSingleParameterUpdate(
    paramName,
    portamentoTime,
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
    paramPath,
    value,
    portamentoTime,
  ) {
    this._broadcastParameterChange({
      type: "sub",
      paramPath: paramPath,
      value: value,
      portamentoTime: portamentoTime,
    });
  }

  // Broadcast a single parameter update for staging at EOC (no portamento field)
  broadcastSingleParameterStaged(paramName) {
    if (!this.star) return;

    // Use pending state to get the latest changes (interpolation changes, etc.)
    const paramState = this.pendingMusicalState[paramName];
    if ("scope" in paramState) {
      throw new Error(
        "CRITICAL: Parameter '" + paramName + "' has forbidden 'scope' field",
      );
    }

    const wirePayload = {
      synthesisActive: this.synthesisActive,
    };

    // Emit unified format with interpolation + generators (no baseValue injection)
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

    // Send PROGRAM_UPDATE with just this parameter for staging
    const message = MessageBuilder.createParameterUpdate(
      MessageTypes.PROGRAM_UPDATE,
      wirePayload
    );
    this.star.broadcastToType("synth", message, "control");
    this.log("📡 Broadcasted staged " + paramName + " parameter change", "info");
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
          "Rejected invalid pending period: " + this.pendingPeriodSec + "s",
          "error",
        );
        this.pendingPeriodSec = null;
        return false;
      }

      this.periodSec = this.pendingPeriodSec;
      this.cycleLength = this.periodSec;
      this.log("Applied period change", "info");
      this.pendingPeriodSec = null;
      changed = true;
    }

    if (this.pendingStepsPerCycle !== null) {
      this.stepsPerCycle = this.pendingStepsPerCycle;
      this.updatePhasorTicks();
      this.log("Applied steps change", "info");
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
      tick.style.left = (i / this.stepsPerCycle) * 100 + "%";
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
          "Invalid cycleLength: " + this.cycleLength + ", using fallback",
        );
        this.cycleLength = 0.05; // Fallback to minimum safe value
      }

      const phasorIncrement = deltaTime / this.cycleLength;

      // Safety check for infinity or NaN
      if (!isFinite(phasorIncrement)) {
        console.error(
          "Invalid phasorIncrement: " + phasorIncrement + ", deltaTime: " + deltaTime + ", cycleLength: " + this.cycleLength,
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
        // EOC wrapped - treat 0
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
      this.elements.phasorBar.style.width = percentage + "%";
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

  sendStepBeacon(stepIndex) {
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
        this.audioContext = new AudioContext();
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
          "Only " + this.audioContext.destination.maxChannelCount + " channels available",
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
      this.log("ES-8 initialization failed", "error");
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
    console.log("Transport action: " + action);

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


  updateParameterVisualFeedback(paramName) {
    // Find the parameter label and add/remove asterisk for pending changes
    const paramLabels = document.querySelectorAll(".param-label");
    for (const label of paramLabels) {
      const labelElement = label;
      const labelText = labelElement.textContent || "";

      // Check if this label is for the parameter we're updating
      const cleanText = labelText.replace("*", "").trim();
      const paramDisplayNames = {
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
    paramName,
    paramState,
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
      paramState.endValueGenerator,
      paramState.baseValue,
    );

    // Debug logging for white noise
    if (paramName === "whiteNoise") {
      console.log("Resolving whiteNoise: start=" + startValue + ", end=" + endValue + ", endGen=" + JSON.stringify(paramState.endValueGenerator));
    }

    return {
      start: startValue,
      end: endValue,
    };
  }

  resolveGeneratorValue(generator, baseValue) {
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

  parseHRGString(input) {
    // Parse "1-3,5,7-9" format into [1,2,3,5,7,8,9]
    const result = [];
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

  selectHRGValue(values, behavior) {
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

    // Reset does NOT stop playback - it just resets phasor and continues playing
    // Keep current play state unchanged

    // Broadcast reset to synths
    if (this.star) {
      const message = MessageBuilder.jumpToEOC();
      this.star.broadcastToType("synth", message, "control");
    }

    // Send beacon for immediate reset
    this.sendStepBeacon(0);

    this.log("Global phasor reset to 0.0 (continuing playback)", "info");
  }

  async connectToNetwork() {
    try {
      // Prevent reconnection if we were kicked
      if (this.wasKicked) {
        this.log("Not reconnecting - was kicked: " + this.kickedReason, "error");
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
        ? ":" + globalThis.location.port
        : "";
      const signalingUrl = protocol + "//" + globalThis.location.hostname + port + "/ws";
      await this.star.connect(signalingUrl);

      // Initially connected - status will be determined by server response
      this.updateConnectionStatus("connected");

      this._updateUIState();

      this.log("Connected to network successfully", "success");
    } catch (error) {
      this.log("Connection failed", "error");
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
      this.log("Peer connected", "info");
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
      this.log("Peer disconnected", "info");
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
      this.log("Cannot join", "error");
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
        this.log("Received " + message.type + " from " + peerId, "debug");
      }
    });

    // Handle control channel messages (like param-applied from synth)
    this.star.addEventListener("data-channel-message", (event) => {
      if (
        event.detail.channel === "control" &&
        event.detail.data.type === MessageTypes.PARAM_APPLIED
      ) {
        const { param } = event.detail.data;
        this.pendingParameterChanges.delete(param);
        this.updateParameterVisualFeedback(param);
        this.log("Cleared pending asterisk for " + param, "debug");
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
    this.log("Sending complete state to new synth", "info");

    // Send current musical state using unified payload function
    const wirePayload = this._getWirePayload();

    const message = MessageBuilder.createParameterUpdate(
      MessageTypes.PROGRAM_UPDATE,
      wirePayload,
    );
    const success = this.star.sendToPeer(synthId, message, "control");
    if (success) {
      this.log("Sent typed musical state to " + synthId, "debug");
    } else {
      this.log("Failed to send typed musical state to " + synthId, "error");
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

  handleKicked(reason) {
    console.error("Kicked from network");

    // Set kicked state to prevent reconnection
    this.wasKicked = true;
    this.kickedReason = reason;

    // Update UI to show kicked status
    this.updateConnectionStatus("kicked");
    this._updateUIState();

    // Show user notification
    alert("You have been disconnected");

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
    this.elements.phasorBar.style.width = percentage + "%";
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

      return '<div class="peer-item">' +
        '<div class="peer-info">' +
        '<div class="peer-id">' + peerId + '</div>' +
        '<div class="peer-type">' + peerType + '</div>' +
        '</div>' +
        '<div class="peer-stats">' +
        '<div>Status: ' + peerStats.connectionState + '</div>' +
        '</div>' +
        '</div>';
    }).join("");

    this.elements.peerList.innerHTML = listHTML;
  }

  clearPeerList() {
    this.elements.peerList.innerHTML = '<div style="color: #888; font-style: italic; text-align: center; padding: 20px;">No peers connected</div>';
  }

  log(message, level = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = {
      "info": "INFO",
      "success": "SUCCESS",
      "error": "ERROR",
      "debug": "DEBUG",
    }[level] || "INFO";

    const logEntry = "[" + timestamp + "] " + prefix + " " + message + "\n";

    if (this.elements.debugLog) {
      this.elements.debugLog.textContent += logEntry;
      this.elements.debugLog.scrollTop = this.elements.debugLog.scrollHeight;
    }

    // Also log to console since debug panel was removed
    console.log("[CTRL] " + message);
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

        const rttDisplay = diag.rtt !== null ? diag.rtt + "ms" : "?";
        const droppedWarning = diag.droppedSyncMessages > 0
          ? " ⚠" + diag.droppedSyncMessages
          : "";

        return '<div style="margin-bottom: 1px;">' +
          '<span style="color: ' + connectionColor + ';">' + diag.peerId.split("-")[0] + '</span>' +
          '<span style="color: ' + iceColor + '; margin-left: 4px;">' + diag.iceType + '</span>' +
          '<span style="color: #ccc; margin-left: 4px;">' + rttDisplay + '</span>' + droppedWarning +
          '</div>';
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
      const key = "scene_" + location + "_controller";
      const hasScene = localStorage.getItem(key) !== null;

      if (hasScene) {
        button.classList.add("has-scene");
      } else {
        button.classList.remove("has-scene");
      }
    });
  }

  saveScene(memoryLocation) {
    console.log("Saving scene to memory location " + memoryLocation + "...");

    try {
      // 1. Get the current applied program state.
      const programToSave = {
        ...this.musicalState,
        savedAt: Date.now(),
      };

      // 2. Save it to the controller's local storage.
      localStorage.setItem(
        "scene_" + memoryLocation + "_controller",
        JSON.stringify(programToSave),
      );

      // 3. Broadcast the command to all synths.
      if (this.star) {
        const message = MessageBuilder.saveScene(memoryLocation);
        this.star.broadcastToType("synth", message, "control");
      }

      this.log("Scene " + memoryLocation + " saved.", "success");
      this.updateSceneMemoryIndicators();
    } catch (error) {
      console.error("Error saving scene:", error);
      this.log(
        "Failed to save scene " + memoryLocation + ": " + error.message,
        "error",
      );
    }
  }

  loadScene(memoryLocation) {
    console.log("📂 Loading scene from memory location " + memoryLocation + "...");

    try {
      const savedProgramString = localStorage.getItem(
        "scene_" + memoryLocation + "_controller",
      );
      if (!savedProgramString) {
        this.log("No scene found at location " + memoryLocation + ".", "error");
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
      const filteredProgram = {};
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
        this._updateUIFromState(paramName);
      });

      // 4. Broadcast LOAD_SCENE only (contains full program config)
      if (this.star) {
        const message = MessageBuilder.loadScene(
          memoryLocation,
          filteredProgram,
        );
        this.star.broadcastToType("synth", message, "control");
      }

      this.log("Scene " + memoryLocation + " loaded and broadcast.", "success");
      this.updateSceneMemoryIndicators();
    } catch (error) {
      console.error("Error loading scene:", error);
      this.log(
        "Failed to load scene " + memoryLocation + ": " + error.message,
        "error",
      );
    }
  }

  clearSceneBanks() {
    // 1) Clear controller banks
    for (let i = 0; i <= 9; i++) {
      localStorage.removeItem("scene_" + i + "_controller");
    }
    this.updateSceneMemoryIndicators();
    this.log("Cleared all scene banks", "success");

    // 2) Broadcast clear to synths
    if (this.star) {
      const msg = MessageBuilder.clearBanks();
      this.star.broadcastToType("synth", msg, "control");
    }
  }

  clearBank(memoryLocation) {
    // Clear single bank
    localStorage.removeItem("scene_" + memoryLocation + "_controller");
    this.updateSceneMemoryIndicators();
    this.log("Cleared scene bank " + memoryLocation, "success");

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
        ? "apply bulk (" + this.bulkChanges.length + ")"
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

    console.log("🔄 Applying " + this.bulkChanges.length + " bulk changes");

    // Send all accumulated changes
    this.bulkChanges.forEach((change) => {
      switch (change.type) {
        case "sub-param-update":
          // Send sub-parameter update
          this._sendImmediateParameterChange({
            type: "sub",
            paramPath: change.paramPath,
            value: change.value,
            portamentoTime: change.portamentoTime,
          });
          break;

        case "single-param-update":
          // Send single parameter update
          this._sendImmediateParameterChange({
            type: "single",
            param: change.param,
            portamentoTime: change.portamentoTime,
          });
          break;


        case "full-program-update":
          // Send full program update
          this._sendFullProgramImmediate(change.portamentoTime);
          break;

        default:
          console.warn("🔄 Unknown bulk change type");
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
  addToBulkChanges(change) {
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
      "📋 Added to bulk queue: " + change.paramPath + " = " + change.value + " (" + this.bulkChanges.length + " total)",
    );
    return true; // Successfully added to bulk queue
  }

  /**
   * Unified method for broadcasting parameter changes that respects bulk mode
   */
  _broadcastParameterChange(change) {
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


    // Not in bulk mode or bulk mode disabled, send immediately
    this._sendImmediateParameterChange(change);
  }

  /**
   * Send parameter change immediately (bypassing bulk mode)
   */
  _sendImmediateParameterChange(change) {
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
            "📡 Sub-param: " + change.paramPath + " = " + change.value + " (" + change.portamentoTime + "ms)",
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

    }
  }

  /**
   * Send single parameter update immediately (extracted from broadcastSingleParameterUpdate)
   */
  _sendSingleParameterImmediate(
    paramName,
    portamentoTime,
  ) {
    const paramState = this.pendingMusicalState[paramName];

    // Strict validation: reject forbidden scope field
    if ("scope" in (paramState)) {
      throw new Error(
        "CRITICAL: Parameter '" + paramName + "' has forbidden 'scope' field",
      );
    }

    // Create minimal payload with only the changed parameter
    const wirePayload = {
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
      "📡 Broadcasted " + paramName + " update with " + portamentoTime + "ms portamento",
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
