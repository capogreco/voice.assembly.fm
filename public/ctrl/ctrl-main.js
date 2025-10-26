// @ts-check

/**
 * Voice.Assembly.FM Control Client Main Application
 * Converted from TypeScript to JavaScript + JSDoc
 */

// JSDoc type imports (no runtime cost)
/** @typedef {import('../../src/common/parameter-types.js').IControlState} IControlState */
/** @typedef {import('../../src/common/parameter-types.js').ParameterState} ParameterState */
/** @typedef {import('../../src/common/parameter-types.js').GeneratorConfig} GeneratorConfig */

// Runtime imports
import {
  MessageBuilder,
  MessageTypes,
} from "../../src/common/message-protocol.js";
import { initializeApplication } from "./app/init.js";
import { createDefaultState, createPresetConfigs } from "./state/defaults.js";
import {
  formatSinArray,
  parseSinString,
  validateSinString,
} from "./utils/sin.js";
import {
  clearAllSceneBanks,
  clearSceneBank,
  loadSceneFromLocalStorage,
  markSceneIndicators,
  saveSceneToLocalStorage,
} from "./state/store.js";
import {
  connectToNetwork as connectToNetworkHelper,
  handleJoinRejected as handleJoinRejectedHelper,
  handleKicked as handleKickedHelper,
  sendCompleteStateToNewSynth,
} from "./network/star.js";
import {
  broadcastControlState as broadcastControlStateHelper,
  broadcastSingleParameter as broadcastSingleParameterHelper,
  broadcastSubParameterUpdate as broadcastSubParameterUpdateHelper,
} from "./network/broadcast.js";

/**
 * Control action types for state management
 * @typedef {Object} ControlAction
 * @property {"SET_BASE_VALUE" | "SET_INTERPOLATION" | "SET_GENERATOR_CONFIG"} type
 * @property {string} [param] - Parameter name
 * @property {number} [value] - Parameter value
 * @property {"step" | "disc" | "cont"} [interpolation] - Interpolation type
 * @property {"start" | "end"} [position] - Generator position
 * @property {GeneratorConfig} [config] - Generator configuration
 */

class ControlClient {
  /**
   * Helper predicate: check if interpolation mode requires both start and end generators
   */
  isCosInterp(interp) {
    return interp === "disc" || interp === "cont";
  }

  /**
   * Get default control state from shared module
   * @returns {IControlState}
   */
  _getDefaultState() {
    return createDefaultState();
  }

  /**
   * Get preset configurations from shared module
   */
  _getPresetConfigs() {
    const presets = createPresetConfigs();
    // Add calibration preset with current state preservation
    presets.calibration = {
      ...this.stagedState,
      amplitude: {
        interpolation: "step",
        baseValue: 0,
        startValueGenerator: {
          type: "normalised",
          range: 0,
          sequenceBehavior: "static",
        },
      },
      whiteNoise: {
        interpolation: "step",
        baseValue: 0.3,
        startValueGenerator: {
          type: "normalised",
          range: 0.3,
          sequenceBehavior: "static",
        },
      },
    };
    return presets;
  }

  _updateStagedState(action) {
    console.log("Action dispatched:", action);

    // Handle scalar edits in place to avoid unnecessary cloning and UI refresh
    if (action.type === "SET_BASE_VALUE") {
      this.stagedState[action.param].baseValue = action.value;

      // Update only the base value input, no HRG refresh needed
      const paramName = action.param;
      const valueInput =
        (paramName === "frequency" || paramName === "vibratoRate")
          ? document.getElementById(paramName + "-base")
          : document.getElementById(paramName + "-value");
      if (valueInput) {
        valueInput.value = action.value.toString();
      }

      // Still need to trigger broadcast and mark changes
      if (this.isPlaying) {
        this.broadcastSingleParameterStaged(action.param);
      }
      this.markPendingChanges();
      return; // Exit early, skip full UI refresh
    }

    // Create a deep copy only for structural changes
    const newState = JSON.parse(JSON.stringify(this.stagedState));

    switch (action.type) {
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
    this.stagedState = newState;

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
    // Update the live state with the HRG change (no staged state when paused)
    this._updateLiveState(action);

    // Get portamento time from UI (exponential mapping)
    const portamentoTime = this.elements.portamentoTime
      ? this._mapPortamentoNormToMs(
        parseFloat(this.elements.portamentoTime.value),
      )
      : 100;

    // Use broadcast helper
    this.broadcastSingleParameterUpdate(action.param, portamentoTime);
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
   * Update the live state directly (bypassing staged state)
   * Used when transport is paused for immediate parameter updates
   */
  _updateLiveState(action) {
    // Clone the current active state
    const newState = JSON.parse(JSON.stringify(this.liveState));

    // Apply the same staged-state logic but to the live state snapshot
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
    this.liveState = newState;
    // Also update staged state to keep them in sync
    this.stagedState = JSON.parse(JSON.stringify(newState));

    // Update UI to reflect the state change
    if (action.param) {
      this._updateUIFromState(action.param);
    }
  }

  /**
   * Apply a preset configuration (destructive replacement)
   */
  _applyPreset(presetName) {
    const presets = this._getPresetConfigs();
    const preset = presets[presetName];

    if (!preset) {
      console.error("Unknown preset: " + presetName);
      return;
    }

    console.log("Applying preset: " + presetName);

    // Debug: Log the preset configuration for frequency
    if (presetName === "full-disc" && preset.frequency) {
      console.log(
        "🐛 full-disc frequency config:",
        JSON.stringify(preset.frequency, null, 2),
      );
    }

    // Destructively replace both pending and active state
    this.stagedState = JSON.parse(JSON.stringify(preset));
    this.liveState = JSON.parse(JSON.stringify(preset));

    // Debug: Verify the state was set correctly
    if (presetName === "full-disc" && this.stagedState.frequency) {
      console.log(
        "🐛 stagedState.frequency after preset:",
        JSON.stringify(this.stagedState.frequency, null, 2),
      );
    }

    // Update all UI elements to reflect new state
    for (const paramName of Object.keys(preset)) {
      this._updateUIFromState(paramName);
    }

    // Debug: Check state again after UI update
    if (presetName === "full-disc" && this.stagedState.frequency) {
      console.log(
        "🐛 stagedState.frequency after UI update:",
        JSON.stringify(this.stagedState.frequency, null, 2),
      );
    }

    // Mark pending changes and always broadcast
    this.markPendingChanges();
    this.broadcastControlState();

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

  // Helper predicate for interpolation modes
  isCosInterp(interp) {
    return interp === "disc" || interp === "cont";
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
    const portNorm = this.elements.portamentoTime
      ? parseFloat(this.elements.portamentoTime.value)
      : null;
    const message = MessageBuilder.immediateReinitialize(portNorm);
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
        this._updateStagedState({
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

        this._updateStagedState({
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
        this._updateStagedState({
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
    const paramState = this.stagedState[paramName];

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
    // Check if this is a periodic parameter (frequency or vibratoRate)
    const isPeriodicParameter = paramName === "frequency" ||
      paramName === "vibratoRate";

    // 1. Handle value input visibility based on interpolation mode
    if (valueInput) {
      if (paramState.interpolation === "cont") {
        if (isPeriodicParameter) {
          // For periodic parameters in cont mode, keep base value visible (still needed for HRG)
          valueInput.style.display = "inline-block";
          if (paramState.baseValue !== null) {
            valueInput.value = paramState.baseValue.toString();
          }
        } else {
          // For normalized parameters in cont mode, hide start value input (comes from previous end)
          valueInput.style.display = "none";
          // Add or update placeholder text
          let contIndicator = valueInput.parentNode.querySelector(
            ".cont-indicator",
          );
          if (!contIndicator) {
            contIndicator = document.createElement("span");
            contIndicator.className = "cont-indicator";
            contIndicator.style.color = "#999";
            contIndicator.style.fontSize = "10px";
            contIndicator.style.fontStyle = "italic";
            valueInput.parentNode.insertBefore(
              contIndicator,
              valueInput.nextSibling,
            );
          }
          contIndicator.textContent = "← from prev end";
          contIndicator.style.display = "inline";
        }
      } else {
        // For step and disc modes, show value input normally
        valueInput.style.display = "inline-block";
        // Hide cont indicator if it exists
        let contIndicator = valueInput.parentNode.querySelector(
          ".cont-indicator",
        );
        if (contIndicator) {
          contIndicator.style.display = "none";
        }

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
    }

    // 2. In unified system, always show interpolation controls
    if (interpSelect) {
      interpSelect.style.display = "inline-block";
      interpSelect.value = paramState.interpolation;
    }

    // 3. Handle HRG start controls visibility
    if (hrgStartControls) {
      if (paramState.interpolation === "cont" && isPeriodicParameter) {
        // For periodic parameters in cont mode, hide start HRG controls (start comes from previous end)
        hrgStartControls.style.display = "none";
      } else {
        // For all other cases, show start HRG controls
        hrgStartControls.style.display = "inline";
      }
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
      const startGen = paramState.startValueGenerator;
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

        // Only update input values if they're not currently being edited
        if (startNums && document.activeElement !== startNums) {
          const numValue = startGen.numerators ?? "1";
          startNums.value = numValue;
          if (paramName === "frequency") {
          }
        } else if (startNums && paramName === "frequency") {
          console.log(
            "🐛 NOT setting start numerators because startNums has focus",
          );
        }
        if (startDens && document.activeElement !== startDens) {
          const denValue = startGen.denominators ?? "1";
          startDens.value = denValue;
          if (paramName === "frequency") {
          }
        }
        if (startNumBeh) {
          const numBehValue = startGen.numeratorBehavior ?? "static";
          startNumBeh.value = numBehValue;
          if (paramName === "frequency") {
          }
        }
        if (startDenBeh) {
          const denBehValue = startGen.denominatorBehavior ?? "static";
          startDenBeh.value = denBehValue;
          if (paramName === "frequency") {
          }
        }

        // Hide static behavior options for cont mode on HRG controls
        if (paramState.interpolation === "cont") {
          [startNumBeh, startDenBeh].forEach((selector) => {
            if (selector) {
              const staticOption = selector.querySelector(
                'option[value="static"]',
              );
              if (staticOption) {
                staticOption.style.display = "none";
                // If currently set to static, change to ascending as fallback
                if (selector.value === "static") {
                  selector.value = "ascending";
                }
              }
            }
          });
        } else {
          // Show static option for non-cont modes
          [startNumBeh, startDenBeh].forEach((selector) => {
            if (selector) {
              const staticOption = selector.querySelector(
                'option[value="static"]',
              );
              if (staticOption) {
                staticOption.style.display = "";
              }
            }
          });
        }
      }

      if (isEnvelope) {
        const endGen = paramState.endValueGenerator;
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

          // Only update input values if they're not currently being edited
          if (endNums && document.activeElement !== endNums) {
            const endNumValue = endGen.numerators ?? "1";
            endNums.value = endNumValue;
            if (paramName === "frequency") {
            }
          }
          if (endDens && document.activeElement !== endDens) {
            const endDenValue = endGen.denominators ?? "1";
            endDens.value = endDenValue;
            if (paramName === "frequency") {
            }
          }
          if (endNumBeh) {
            const endNumBehValue = endGen.numeratorBehavior ?? "static";
            endNumBeh.value = endNumBehValue;
            if (paramName === "frequency") {
            }
          }
          if (endDenBeh) {
            const endDenBehValue = endGen.denominatorBehavior ?? "static";
            endDenBeh.value = endDenBehValue;
            if (paramName === "frequency") {
            }
          }

          // Hide static behavior options for cont mode on end HRG controls
          if (paramState.interpolation === "cont") {
            [endNumBeh, endDenBeh].forEach((selector) => {
              if (selector) {
                const staticOption = selector.querySelector(
                  'option[value="static"]',
                );
                if (staticOption) {
                  staticOption.style.display = "none";
                  // If currently set to static, change to ascending as fallback
                  if (selector.value === "static") {
                    selector.value = "ascending";
                  }
                }
              }
            });
          } else {
            // Show static option for non-cont modes
            [endNumBeh, endDenBeh].forEach((selector) => {
              if (selector) {
                const staticOption = selector.querySelector(
                  'option[value="static"]',
                );
                if (staticOption) {
                  staticOption.style.display = "";
                }
              }
            });
          }
        }
      }

      // Re-sync HRG visibility after updating state
      const needsEndGen = this.isCosInterp(paramState.interpolation);
      if (hrgArrow) {
        hrgArrow.style.display = needsEndGen ? "inline-block" : "none";
      }
      if (hrgEndControls) {
        hrgEndControls.style.display = needsEndGen ? "inline-block" : "none";
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
          // For cont mode, hide start behavior selector (start value comes from previous end)
          if (paramState.interpolation === "cont") {
            startBehaviorSelect.style.display = "none";
          } else {
            const isRange = this._isRangeValue(valueInput.value);
            startBehaviorSelect.style.display = isRange
              ? "inline-block"
              : "none";
          }
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

  // Capture current HRG inputs into staged state before apply
  _syncHRGStateFromInputs() {
    const freqState = this.stagedState.frequency;
    if (!freqState || freqState.startValueGenerator?.type !== "periodic") {
      return;
    }

    let anyInvalid = false;

    // Helper to validate and mark
    const validateField = (el, label) => {
      if (!el) return true;
      const validation = validateSinString(el.value);
      el.classList.toggle("invalid-input", !validation.valid);
      if (!validation.valid) {
        this.log(
          "Invalid " + label + ': "' + el.value +
            '" - ' +
            (validation.error || "use numbers, commas, and ranges like 1-6"),
          "error",
        );
      }
      return validation.valid;
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

    // Start generator - parse SIN strings to arrays
    if (freqState.startValueGenerator?.type === "periodic") {
      const startNumsEl = document.getElementById("frequency-start-numerators");
      const startDensEl = document.getElementById(
        "frequency-start-denominators",
      );
      const startNumBeh =
        (document.getElementById("frequency-start-numerators-behavior") |
          HTMLSelectElement |
          null)?.value;
      const startDenBeh =
        (document.getElementById("frequency-start-denominators-behavior") |
          HTMLSelectElement |
          null)?.value;

      // Parse SIN strings to arrays
      if (startNumsEl?.value) {
        try {
          const numsArray = parseSinString(startNumsEl.value);
          freqState.startValueGenerator.numerators = numsArray;
          freqState.startValueGenerator.numeratorsSin = startNumsEl.value
            .trim(); // Keep original for UI
          console.log(
            `🎲 Parsed start numerators "${startNumsEl.value}" -> [${numsArray}]`,
          );
        } catch (e) {
          // Validation already handled above, keep existing value
        }
      }

      if (startDensEl?.value) {
        try {
          const densArray = parseSinString(startDensEl.value);
          freqState.startValueGenerator.denominators = densArray;
          freqState.startValueGenerator.denominatorsSin = startDensEl.value
            .trim();
        } catch (e) {
          // Validation already handled above
        }
      }

      freqState.startValueGenerator.numeratorBehavior = startNumBeh ??
        freqState.startValueGenerator.numeratorBehavior;
      freqState.startValueGenerator.denominatorBehavior = startDenBeh ??
        freqState.startValueGenerator.denominatorBehavior;
    }

    // End generator (if envelope) - parse SIN strings to arrays
    if (
      freqState.interpolation !== "step" &&
      freqState.endValueGenerator?.type === "periodic"
    ) {
      const endNumsEl = document.getElementById("frequency-end-numerators");
      const endDensEl = document.getElementById("frequency-end-denominators");
      const endNumBeh =
        (document.getElementById("frequency-end-numerators-behavior") |
          HTMLSelectElement |
          null)?.value;
      const endDenBeh =
        (document.getElementById("frequency-end-denominators-behavior") |
          HTMLSelectElement |
          null)?.value;

      // Parse SIN strings to arrays
      if (endNumsEl?.value) {
        try {
          const numsArray = parseSinString(endNumsEl.value);
          freqState.endValueGenerator.numerators = numsArray;
          freqState.endValueGenerator.numeratorsSin = endNumsEl.value.trim();
        } catch (e) {
          // Validation already handled above
        }
      }

      if (endDensEl?.value) {
        try {
          const densArray = parseSinString(endDensEl.value);
          freqState.endValueGenerator.denominators = densArray;
          freqState.endValueGenerator.denominatorsSin = endDensEl.value.trim();
        } catch (e) {
          // Validation already handled above
        }
      }

      freqState.endValueGenerator.numeratorBehavior = endNumBeh ??
        freqState.endValueGenerator.numeratorBehavior;
      freqState.endValueGenerator.denominatorBehavior = endDenBeh ??
        freqState.endValueGenerator.denominatorBehavior;
    }

    return true;
  }

  markPendingChanges() {
    this.hasPendingChanges = true;
    // Apply button removed - staging handled by transport state
  }

  clearPendingChanges() {
    this.hasPendingChanges = false;
    // Apply button removed - staging handled by transport state
  }

  /**
   * Handle PROGRAM_UPDATE message from synth (after scene load)
   * Updates controller state and UI to match synth's loaded scene
   */
  _handleProgramUpdateFromSynth(message) {
    // Extract program parameters from message
    const programParams = {};
    for (const key of Object.keys(message)) {
      if (key !== "type" && key !== "synthesisActive" && key !== "isPlaying") {
        programParams[key] = message[key];
      }
    }

    // Update both staged and live state
    this.stagedState = programParams;
    this.liveState = JSON.parse(JSON.stringify(programParams));

    // Update UI for all parameters
    for (const paramName of Object.keys(programParams)) {
      this._updateUIFromState(paramName);
    }

    // Update synthesis state if provided
    if (message.synthesisActive !== undefined) {
      this.synthesisActive = message.synthesisActive;
      this._updateToggleButton();
    }

    console.log(
      `✅ Controller updated with scene from synth: ${
        Object.keys(programParams).length
      } parameters`,
    );
  }

  /**
   * Unified method to set parameter state and update UI
   */
  setParameterState(paramName, newState) {
    // Update both state objects
    this.liveState[paramName] = newState;
    this.stagedState[paramName] = { ...newState };

    // Update UI to match using the centralized function
    this._updateUIFromState(paramName);
  }

  applyParameterChanges() {
    // Sync visible HRG UI inputs into staged state before committing; abort on invalid
    const ok = this._syncHRGStateFromInputs();
    if (ok === false) {
      this.log("Fix invalid HRG inputs before applying.", "error");
      return;
    }
    this.liveState = JSON.parse(JSON.stringify(this.stagedState));
    console.log("Applying new state:", this.liveState);
    this.broadcastControlState();
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
   * Central method for translating the staged control state to wire format (unified, scope-free)
   * Used by both broadcastControlState and sendCompleteStateToSynth
   */

  // Wrapper for broadcast helper
  broadcastControlState(portamentoTime) {
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

    // Use helper for immediate broadcast
    broadcastControlStateHelper(
      this.star,
      this.stagedState,
      this.synthesisActive,
      this.log.bind(this),
      portamentoTime,
    );
  }

  // Wrapper for single parameter broadcast
  broadcastSingleParameterUpdate(paramName, portamentoTime) {
    // Check bulk mode
    if (
      this.addToBulkChanges({
        type: "single-param-update",
        param: paramName,
        portamentoTime: portamentoTime,
      })
    ) {
      return;
    }

    broadcastSingleParameterHelper(
      this.star,
      paramName,
      this.stagedState,
      this.synthesisActive,
      this.log.bind(this),
      portamentoTime,
    );
  }

  // Wrapper for sub-parameter broadcast
  broadcastSubParameterUpdate(paramPath, value, portamentoTime) {
    // Check bulk mode
    if (
      this.addToBulkChanges({
        type: "sub-param-update",
        paramPath: paramPath,
        value: value,
        portamentoTime: portamentoTime,
      })
    ) {
      return;
    }

    broadcastSubParameterUpdateHelper(
      this.star,
      paramPath,
      value,
      portamentoTime,
      this.log.bind(this),
    );
  }

  // Wrapper for single parameter staged broadcast (no portamento)
  broadcastSingleParameterStaged(paramName) {
    broadcastSingleParameterHelper(
      this.star,
      paramName,
      this.stagedState,
      this.synthesisActive,
      this.log.bind(this),
      null, // No portamento for staged updates
    );
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
          "Invalid phasorIncrement: " + phasorIncrement + ", deltaTime: " +
            deltaTime + ", cycleLength: " + this.cycleLength,
        );
        return; // Skip this frame
      }

      const previousPhasor = this.phasor;
      this.phasor += phasorIncrement;

      // Robust step boundary detection using integer indices
      const prevStepIndex = Math.floor(previousPhasor * this.stepsPerCycle);
      const currStepIndexBeforeWrap = Math.floor(
        this.phasor * this.stepsPerCycle,
      );

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
        const stride = Math.max(
          1,
          Math.ceil(this.MIN_BEACON_INTERVAL_SEC / stepSec),
        );

        // Find latest boundary divisible by stride (handle large jumps)
        const latestStridedStep = Math.floor(currStepIndex / stride) * stride;
        if (
          latestStridedStep > prevStepIndex &&
          latestStridedStep <= currStepIndex
        ) {
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

    // Send PHASOR_BEACON at EOC only
    if (stepIndex === 0 && this.isPlaying && this.audioContext) {
      // Schedule next cycle with lookahead
      const lookaheadMs = 100; // 100ms lookahead for network latency
      const startTime = this.audioContext.currentTime + (lookaheadMs / 1000);

      const beaconMessage = MessageBuilder.phasorBeacon(
        startTime,
        this.cycleLength,
        0,
        this.stepsPerCycle,
      );
      this.star.broadcastToType("synth", beaconMessage, "control");

      console.log(
        `🔔 Sent PHASOR_BEACON: startTime ${
          startTime.toFixed(3)
        }, cycleLength ${this.cycleLength}s`,
      );
    }
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
          "Only " + this.audioContext.destination.maxChannelCount +
            " channels available",
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

    const params = this.liveState;
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
  async handleTransport(action) {
    console.log("Transport action: " + action);

    switch (action) {
      case "play":
        // Create audio context on first play if needed
        if (!this.audioContext) {
          this.audioContext = new AudioContext();
          await this.audioContext.resume();
          console.log("🎵 Created AudioContext for phasor scheduling");
        }

        this.isPlaying = true;
        this.lastPhasorTime = performance.now() / 1000.0; // Reset time tracking
        this.log("Global phasor started", "info");

        // Auto-enable synthesis when playing starts
        if (!this.synthesisActive) {
          this.synthesisActive = true;
          console.log("🎵 Auto-enabled synthesis for playback");
          // Update UI button state
          if (this.elements.manualModeBtn) {
            this.elements.manualModeBtn.textContent = "Disable Synthesis";
            this.elements.manualModeBtn.classList.add("active");
          }
        }

        // Send PLAY command
        if (this.star) {
          const playMessage = MessageBuilder.play(
            this.phasor,
            this.audioContext.currentTime,
          );
          this.star.broadcastToType("synth", playMessage, "control");
          console.log(
            `▶️ Sent PLAY command from phase ${this.phasor.toFixed(3)}`,
          );

          if (this.audioContext) {
            const lookaheadMs = 100;
            const startTime = this.audioContext.currentTime +
              (lookaheadMs / 1000);
            const normalizedPhase = ((this.phasor % 1) + 1) % 1;

            const beaconMessage = MessageBuilder.phasorBeacon(
              startTime,
              this.cycleLength,
              normalizedPhase,
              this.stepsPerCycle,
            );
            this.star.broadcastToType("synth", beaconMessage, "control");
            console.log(
              `🔔 Sent bootstrap PHASOR_BEACON: phase ${
                normalizedPhase.toFixed(3)
              } @ t=${startTime.toFixed(3)}`,
            );
          }
        }
        break;

      case "pause":
        this.isPlaying = false;
        // Clear all pending changes when paused (changes apply immediately when paused)
        this.clearAllPendingChanges();
        this.log("Global phasor paused", "info");

        // Send PAUSE command
        if (this.star) {
          const pauseMessage = MessageBuilder.pause(this.phasor);
          this.star.broadcastToType("synth", pauseMessage, "control");
          console.log(
            `⏸️ Sent PAUSE command at phase ${this.phasor.toFixed(3)}`,
          );
        }
        break;

      case "stop":
        this.isPlaying = false;
        this.phasor = 0.0;
        this.lastPhasorTime = performance.now() / 1000.0;
        // Clear all pending changes when stopped
        this.clearAllPendingChanges();
        this.updatePhasorDisplay();
        this.log("Global phasor stopped and reset", "info");

        // Send STOP command
        if (this.star) {
          const stopMessage = MessageBuilder.stop();
          this.star.broadcastToType("synth", stopMessage, "control");
          console.log("⏹️ Sent STOP command");
        }
        break;
    }

    // Update play/pause button text
    this.updatePlayPauseButton();
  }

  updatePlayPauseButton() {
    if (this.elements.playBtn) {
      this.elements.playBtn.textContent = this.isPlaying ? "pause" : "play";
    }
  }

  // Phase scrubbing methods
  mapPointerToPhase(event) {
    if (!this.elements.phasorBar) return 0;

    const rect = this.elements.phasorBar.parentElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const width = rect.width;
    const phase = Math.max(0, Math.min(1, x / width));
    return phase;
  }

  updateScrubPhase(phase) {
    // Update local phasor for UI
    this.phasor = phase;
    this.updatePhasorDisplay();

    // Store for broadcasting
    this.pendingScrubPhase = phase;
  }

  broadcastScrubPhase(phase) {
    if (!this.star) return;

    // Use fixed 0.5ms portamento for scrubbing
    const portamentoMs = 0.5;

    const message = MessageBuilder.scrubPhase(phase, portamentoMs);
    this.star.broadcastToType("synth", message, "control");

    console.log(
      `🎯 Sent SCRUB_PHASE: ${phase.toFixed(3)} with ${
        portamentoMs.toFixed(1)
      }ms portamento`,
    );
  }

  startScrubbing(event) {
    // Only allow scrubbing when paused
    if (this.isPlaying) return;

    this.isScrubbing = true;
    const phase = this.mapPointerToPhase(event);
    this.updateScrubPhase(phase);
    this.broadcastScrubPhase(phase);

    // Start RAF loop for smooth broadcasting
    const scrubLoop = () => {
      if (this.isScrubbing && this.pendingScrubPhase !== null) {
        this.broadcastScrubPhase(this.pendingScrubPhase);
        this.scrubAnimationId = requestAnimationFrame(scrubLoop);
      }
    };
    this.scrubAnimationId = requestAnimationFrame(scrubLoop);

    // Prevent text selection
    event.preventDefault();
  }

  updateScrubbing(event) {
    if (!this.isScrubbing) return;

    const phase = this.mapPointerToPhase(event);
    this.updateScrubPhase(phase);

    // Prevent text selection
    event.preventDefault();
  }

  stopScrubbing(event) {
    if (!this.isScrubbing) return;

    // Send final scrub update
    const phase = this.mapPointerToPhase(event);
    this.updateScrubPhase(phase);
    this.broadcastScrubPhase(phase);

    // Clean up
    this.isScrubbing = false;
    this.pendingScrubPhase = null;
    if (this.scrubAnimationId) {
      cancelAnimationFrame(this.scrubAnimationId);
      this.scrubAnimationId = null;
    }

    console.log(`🎯 Scrubbing finished at phase ${phase.toFixed(3)}`);
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

    // For disc/cont interpolation, resolve both start and end
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
      console.log(
        "Resolving whiteNoise: start=" + startValue + ", end=" + endValue +
          ", endGen=" + JSON.stringify(paramState.endValueGenerator),
      );
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
    // Build context for helper
    const context = {
      peerId: this.peerId,
      wasKicked: this.wasKicked,
      kickedReason: this.kickedReason,
      updateConnectionStatus: this.updateConnectionStatus.bind(this),
      log: this.log.bind(this),
    };

    // Build callbacks for event handlers
    const callbacks = {
      log: this.log.bind(this),
      onBecameLeader: () => {
        this._updateUIState();
      },
      onControllerActive: () => {
        this.updateConnectionStatus("active");
        this._updateUIState();
      },
      onPeerConnected: (peerId) => {
        this.updatePeerList();
        this._updateUIState();
        this.startNetworkDiagnostics();

        // Send complete state to new synths
        if (peerId.startsWith("synth-")) {
          this.sendCompleteStateToSynth(peerId);
        }
      },
      onPeerRemoved: () => {
        this.updatePeerList();
        this._updateUIState();

        if (this.star.peers.size === 0) {
          this.stopNetworkDiagnostics();
        }
      },
      onKicked: (reason) => {
        this.handleKicked(reason);
      },
      onJoinRejected: (reason) => {
        this.updateConnectionStatus("error");
        this._updateUIState();

        handleJoinRejectedHelper(
          reason,
          this.updateConnectionStatus.bind(this),
        );
      },
      onDataMessage: (peerId, channelType, message) => {
        // Handle program updates from synth (after scene load)
        if (
          message.type === MessageTypes.PROGRAM_UPDATE &&
          channelType === "control"
        ) {
          console.log("📨 Received PROGRAM_UPDATE from synth after scene load");
          this._handleProgramUpdateFromSynth(message);
        }

        // Log other messages for debugging
        if (
          message.type !== MessageTypes.PING &&
          message.type !== MessageTypes.PONG &&
          message.type !== MessageTypes.PROGRAM_UPDATE
        ) {
          this.log("Received " + message.type + " from " + peerId, "debug");
        }
      },
      onDataChannelMessage: (detail) => {
        if (
          detail.channel === "control" &&
          detail.data.type === MessageTypes.PARAM_APPLIED
        ) {
          const { param } = detail.data;
          this.pendingParameterChanges.delete(param);
          this.updateParameterVisualFeedback(param);
          this.log("Cleared pending asterisk for " + param, "debug");
        }
      },
    };

    // Use helper to connect
    this.star = await connectToNetworkHelper(context, callbacks);

    if (this.star) {
      this._updateUIState();
    }
  }

  _updateUIState() {
    const isConnected = this.star && this.star.isConnectedToSignaling;

    // Update any remaining UI state based on connection
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
    this.broadcastControlState();
  }

  // Deprecated - use toggleSynthesis instead
  toggleManualMode() {
    this.toggleSynthesis();
  }

  sendCompleteStateToSynth(synthId) {
    sendCompleteStateToNewSynth(
      this.star,
      synthId,
      this.liveState,
      this.synthesisActive,
      this.log.bind(this),
    );
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
    const kickState = handleKickedHelper(
      reason,
      this.updateConnectionStatus.bind(this),
      this.log.bind(this),
    );

    this.wasKicked = kickState.wasKicked;
    this.kickedReason = kickState.kickedReason;
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
        '<div class="peer-id">' + peerId + "</div>" +
        '<div class="peer-type">' + peerType + "</div>" +
        "</div>" +
        '<div class="peer-stats">' +
        "<div>Status: " + peerStats.connectionState + "</div>" +
        "</div>" +
        "</div>";
    }).join("");

    this.elements.peerList.innerHTML = listHTML;
  }

  clearPeerList() {
    this.elements.peerList.innerHTML =
      '<div style="color: #888; font-style: italic; text-align: center; padding: 20px;">No peers connected</div>';
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
          '<span style="color: ' + connectionColor + ';">' +
          diag.peerId.split("-")[0] + "</span>" +
          '<span style="color: ' + iceColor + '; margin-left: 4px;">' +
          diag.iceType + "</span>" +
          '<span style="color: #ccc; margin-left: 4px;">' + rttDisplay +
          "</span>" + droppedWarning +
          "</div>";
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
    markSceneIndicators(sceneButtons, (location) => {
      const controllerKey = `scene_${location}_controller`;
      return localStorage.getItem(controllerKey) !== null;
    });
  }

  saveScene(memoryLocation) {
    console.log("Saving scene to memory location " + memoryLocation + "...");

    try {
      // 1. Get the current applied program state.
      const programToSave = {
        ...this.liveState,
        savedAt: Date.now(),
      };

      // 2. Save it to the controller's local storage using helper.
      saveSceneToLocalStorage(
        memoryLocation,
        programToSave,
        this.log.bind(this),
      );

      // 3. Broadcast the command to all synths.
      if (this.star) {
        const message = MessageBuilder.saveScene(memoryLocation);
        this.star.broadcastToType("synth", message, "control");
      }

      this.updateSceneMemoryIndicators();
    } catch (error) {
      console.error("Error saving scene:", error);
      // Error already logged by helper
    }
  }

  loadScene(memoryLocation) {
    console.log(
      "📂 Loading scene from memory location " + memoryLocation + "...",
    );

    try {
      // 1. Load from local storage using helper
      const loadedProgram = loadSceneFromLocalStorage(
        memoryLocation,
        this.log.bind(this),
      );
      if (!loadedProgram) {
        return; // Helper already logged the error
      }

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
      this.stagedState = filteredProgram;
      this.liveState = JSON.parse(JSON.stringify(filteredProgram));

      // 3. Update the entire UI to match the loaded state.
      Object.keys(this.liveState).forEach((paramName) => {
        this._updateUIFromState(paramName);
      });

      // 4. Broadcast LOAD_SCENE only (contains full program config)
      if (this.star) {
        const portNorm = this.elements.portamentoTime
          ? parseFloat(this.elements.portamentoTime.value)
          : null;
        const message = MessageBuilder.loadScene(
          memoryLocation,
          filteredProgram,
          null, // No snapshot - synth manages its own
          portNorm,
        );
        this.star.broadcastToType("synth", message, "control");
      }

      this.log("Scene " + memoryLocation + " loaded and broadcast.", "success");
      this.updateSceneMemoryIndicators();
    } catch (error) {
      console.error("Error loading scene:", error);
      // Error already logged by helper or above
    }
  }

  clearSceneBanks() {
    // 1) Clear controller banks using helper
    clearAllSceneBanks(this.log.bind(this));
    this.updateSceneMemoryIndicators();

    // 2) Broadcast clear to synths
    if (this.star) {
      const msg = MessageBuilder.clearBanks();
      this.star.broadcastToType("synth", msg, "control");
    }
  }

  clearBank(memoryLocation) {
    // Clear single bank using helper
    clearSceneBank(memoryLocation, this.log.bind(this));
    this.updateSceneMemoryIndicators();

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

    // Send all accumulated changes using helpers
    this.bulkChanges.forEach((change) => {
      switch (change.type) {
        case "sub-param-update":
          // Send sub-parameter update directly (bypass bulk check)
          broadcastSubParameterUpdateHelper(
            this.star,
            change.paramPath,
            change.value,
            change.portamentoTime,
            this.log.bind(this),
          );
          break;

        case "single-param-update":
          // Send single parameter update directly (bypass bulk check)
          broadcastSingleParameterHelper(
            this.star,
            change.param,
            this.stagedState,
            this.synthesisActive,
            this.log.bind(this),
            change.portamentoTime,
          );
          break;

        case "full-program-update":
          // Send full program update directly (bypass bulk check)
          broadcastControlStateHelper(
            this.star,
            this.stagedState,
            this.synthesisActive,
            this.log.bind(this),
            change.portamentoTime,
          );
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
      "📋 Added to bulk queue: " + change.paramPath + " = " + change.value +
        " (" + this.bulkChanges.length + " total)",
    );
    return true; // Successfully added to bulk queue
  }
}

// Initialize the control client
console.log("About to create ControlClient");
const controlClient = new ControlClient();
console.log("ControlClient created successfully");

// Make it globally available for debugging
globalThis.controlClient = controlClient;
