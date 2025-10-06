// @ts-check

/**
 * UI Schema and Parameter Control Setup for Voice.Assembly.FM
 * Handles the creation and binding of individual parameter controls
 */

/**
 * Setup compact parameter controls (for normalized parameters)
 * @param {Object} ctrl - The ControlClient instance
 * @param {string} paramName - Name of the parameter
 */
export function setupCompactParameterControls(ctrl, paramName) {
  // Get unified parameter control elements
  const interpSelect = document.getElementById(paramName + "-interpolation");
  const textInput = document.getElementById(paramName + "-value");

  // Get inline control elements for HRG
  const endValueInput = document.getElementById(paramName + "-end-value");

  const startRbgBehaviorSelect = document.getElementById(
    paramName + "-start-rbg-behavior",
  );
  const endRbgBehaviorSelect = document.getElementById(
    paramName + "-end-rbg-behavior",
  );

  if (!textInput) return; // Skip if parameter doesn't exist in UI

  // Handle normalized parameter updates on blur
  textInput.addEventListener("blur", () => {
    // Update the program generator from the input value (single values become constants)
    ctrl._handleValueInput(paramName, textInput.value, "start");
    
    // Send SUB_PARAM_UPDATE for the start value generator change
    const paramState = ctrl.pendingMusicalState[paramName];
    if (paramState.startValueGenerator?.type === "normalised") {
      if (typeof paramState.startValueGenerator.range === "number") {
        // Single value - send the range value
        ctrl._sendSubParameterUpdate(
          paramName + ".startValueGenerator.range",
          paramState.startValueGenerator.range
        );
      } else {
        // Range value - send the range object as JSON string for now
        ctrl._sendSubParameterUpdate(
          paramName + ".startValueGenerator.range", 
          JSON.stringify(paramState.startValueGenerator.range)
        );
      }
    }
    
    ctrl.markPendingChanges();
  });

  // Handle interpolation changes
  if (interpSelect) {
    interpSelect.addEventListener("change", () => {
      const interpolation = interpSelect.value;

      ctrl._updatePendingState({
        type: "SET_INTERPOLATION",
        param: paramName,
        interpolation: interpolation,
      });

      // Send SUB_PARAM_UPDATE for interpolation change
      ctrl._sendSubParameterUpdate(
        paramName + ".interpolation",
        interpolation
      );

      ctrl.markPendingChanges();
    });
  }

  if (endValueInput) {
    // Use 'change' event for final state update (fires when user commits value)
    endValueInput.addEventListener("change", () => {
      ctrl._handleValueInput(paramName, endValueInput.value, "end");
      
      // Send SUB_PARAM_UPDATE for the end value generator change
      const paramState = ctrl.pendingMusicalState[paramName];
      if (paramState.endValueGenerator?.type === "normalised") {
        if (typeof paramState.endValueGenerator.range === "number") {
          // Single value - send the range value
          ctrl._sendSubParameterUpdate(
            paramName + ".endValueGenerator.range",
            paramState.endValueGenerator.range
          );
        } else {
          // Range value - send the range object as JSON string for now
          ctrl._sendSubParameterUpdate(
            paramName + ".endValueGenerator.range", 
            JSON.stringify(paramState.endValueGenerator.range)
          );
        }
      }
      
      ctrl.markPendingChanges();
    });

    // Optional: Add 'input' listener for validation feedback only
    endValueInput.addEventListener("input", () => {
      const isValid = /^-?\d*\.?\d*(\s*-\s*-?\d*\.?\d*)?$/.test(
        endValueInput.value,
      );
      endValueInput.classList.toggle("invalid-input", !isValid);
    });
  }

  // Add dynamic show/hide logic for end value RBG behavior selector
  if (endValueInput) {
    endValueInput.addEventListener("input", () => {
      const endBehaviorSelect = document.getElementById(
        paramName + "-end-rbg-behavior",
      );
      if (endBehaviorSelect) {
        const isRange = ctrl._isRangeValue(endValueInput.value);
        endBehaviorSelect.style.display = isRange ? "inline-block" : "none";
      }
    });
  }

  // Add dynamic show/hide logic for start value RBG behavior selector
  if (textInput) {
    textInput.addEventListener("input", () => {
      const startBehaviorSelect = document.getElementById(
        paramName + "-start-rbg-behavior",
      );
      if (startBehaviorSelect) {
        const isRange = ctrl._isRangeValue(textInput.value);
        startBehaviorSelect.style.display = isRange ? "inline-block" : "none";
      }
    });
  }

  // Handle start RBG behavior changes
  if (startRbgBehaviorSelect) {
    startRbgBehaviorSelect.addEventListener("change", () => {
      // Update pending state
      const paramState = ctrl.pendingMusicalState[paramName];
      if (paramState.startValueGenerator) {
        paramState.startValueGenerator.sequenceBehavior = startRbgBehaviorSelect.value;
      }
      
      // Send SUB_PARAM_UPDATE - synth will handle staging vs immediate application
      ctrl._sendSubParameterUpdate(
        paramName + ".startValueGenerator.sequenceBehavior",
        startRbgBehaviorSelect.value
      );
      
      ctrl.markPendingChanges();
    });
  }

  // Handle end RBG behavior changes
  if (endRbgBehaviorSelect) {
    endRbgBehaviorSelect.addEventListener("change", () => {
      // Update pending state
      const paramState = ctrl.pendingMusicalState[paramName];
      if (paramState.endValueGenerator) {
        paramState.endValueGenerator.sequenceBehavior = endRbgBehaviorSelect.value;
      }
      
      // Send SUB_PARAM_UPDATE - synth will handle staging vs immediate application
      ctrl._sendSubParameterUpdate(
        paramName + ".endValueGenerator.sequenceBehavior",
        endRbgBehaviorSelect.value
      );
      
      ctrl.markPendingChanges();
    });
  }

  // Initialize parameter UI with current state
  ctrl._updateUIFromState(paramName);
}

/**
 * Setup HRG (Harmonic Ratio Generator) parameter controls (for frequency/vibratoRate)
 * @param {Object} ctrl - The ControlClient instance  
 * @param {string} paramName - Name of the parameter (frequency or vibratoRate)
 */
export function setupHrgParameterControls(ctrl, paramName) {
  const baseInput = document.getElementById(paramName + "-base") || null;
  const interpSelect = document.getElementById(
    paramName + "-interpolation",
  ) || null;

  // HRG controls are managed identically to before
  // Reuse the HRG listeners from setupCompactParameterControls
  // Start HRG inputs
  const startNumeratorsInput = document.getElementById(
    paramName + "-start-numerators",
  ) || null;
  const startDenominatorsInput = document.getElementById(
    paramName + "-start-denominators",
  ) || null;
  const startNumBehaviorSelect = document.getElementById(
    paramName + "-start-numerators-behavior",
  ) || null;
  const startDenBehaviorSelect = document.getElementById(
    paramName + "-start-denominators-behavior",
  ) || null;

  const endNumeratorsInput = document.getElementById(
    paramName + "-end-numerators",
  ) || null;
  const endDenominatorsInput = document.getElementById(
    paramName + "-end-denominators",
  ) || null;
  const endNumBehaviorSelect = document.getElementById(
    paramName + "-end-numerators-behavior",
  ) || null;
  const endDenBehaviorSelect = document.getElementById(
    paramName + "-end-denominators-behavior",
  ) || null;

  // Handle text input (base value updates)
  if (baseInput) {
    // Validation feedback
    baseInput.addEventListener("input", () => {
      const v = parseFloat(baseInput.value);
      const isValid = Number.isFinite(v);
      baseInput.classList.toggle("invalid-input", !isValid);
    });

    const applyBase = () => {
      const baseValue = parseFloat(baseInput.value);

      // Check if value actually changed
      const currentBaseValue = ctrl.pendingMusicalState[paramName]?.baseValue;
      if (baseValue === currentBaseValue) {
        return; // No change, skip everything
      }

      if (!Number.isFinite(baseValue)) {
        ctrl.log("Invalid " + paramName + " base value", "error");
        return;
      }

      // Direct validation based on parameter type
      let min, max;
      if (paramName === "frequency") {
        min = 20;
        max = 20000;
      } else if (paramName === "vibratoRate") {
        min = 0.1;
        max = 1000;
      }

      if (baseValue < min || baseValue > max) {
        ctrl.log(
          "Warning: " + paramName + " base value " + baseValue + " is outside recommended range [" + min + ", " + max + "]",
          "warning",
        );
      }

      // Update internal state for UI consistency
      ctrl._updatePendingState({
        type: "SET_BASE_VALUE",
        param: paramName,
        value: baseValue,
      });

      // Send SUB_PARAM_UPDATE for base value change - synth will handle staging vs immediate application
      ctrl._sendSubParameterUpdate(
        paramName + ".baseValue",
        baseValue
      );

      ctrl.markPendingChanges();
      ctrl.updateParameterVisualFeedback(paramName);
    };

    baseInput.addEventListener("blur", applyBase);
  }

  // Interpolation changes (step/cosine) still apply to frequency envelopes
  if (interpSelect) {
    interpSelect.addEventListener("change", () => {
      const interpolation = interpSelect.value;
      ctrl._updatePendingState({
        type: "SET_INTERPOLATION",
        param: paramName,
        interpolation: interpolation,
      });

      if (!ctrl.isPlaying) {
        // When paused: update active state and broadcast with portamento
        ctrl.musicalState = JSON.parse(JSON.stringify(ctrl.pendingMusicalState));
        ctrl.broadcastMusicalParameters();
      } else {
        // When playing: stage for application at EOC
        ctrl.broadcastSingleParameterStaged(paramName);
      }

      ctrl.markPendingChanges();
    });
  }

  // HRG inputs using sub-parameter updates
  if (startNumeratorsInput) {
    startNumeratorsInput.addEventListener("input", () => {
      const { ok } = ctrl._validateSINString(startNumeratorsInput.value);
      startNumeratorsInput.classList.toggle("invalid-input", !ok);
      
      // Real-time feedback for input validation
      if (ok) {
        // Show green border or other positive feedback
        startNumeratorsInput.style.borderColor = "#4CAF50";
      } else {
        // Show red border for invalid input
        startNumeratorsInput.style.borderColor = "#f44336";
      }
    });
    startNumeratorsInput.addEventListener("blur", () => {
      // Send SUB_PARAM_UPDATE - synth will handle staging vs immediate application
      ctrl._sendSubParameterUpdate(
        paramName + ".startValueGenerator.numerators",
        startNumeratorsInput.value
      );
      ctrl.markPendingChanges();
      
      // Reset border color to default after sending update
      startNumeratorsInput.style.borderColor = "";
    });
  }

  if (startDenominatorsInput) {
    startDenominatorsInput.addEventListener("input", () => {
      const { ok } = ctrl._validateSINString(startDenominatorsInput.value);
      startDenominatorsInput.classList.toggle("invalid-input", !ok);
      
      // Real-time feedback for input validation
      if (ok) {
        // Show green border or other positive feedback
        startDenominatorsInput.style.borderColor = "#4CAF50";
      } else {
        // Show red border for invalid input
        startDenominatorsInput.style.borderColor = "#f44336";
      }
    });
    startDenominatorsInput.addEventListener("blur", () => {
      // Send SUB_PARAM_UPDATE - synth will handle staging vs immediate application
      ctrl._sendSubParameterUpdate(
        paramName + ".startValueGenerator.denominators",
        startDenominatorsInput.value
      );
      ctrl.markPendingChanges();
      
      // Reset border color to default after sending update
      startDenominatorsInput.style.borderColor = "";
    });
  }

  if (startNumBehaviorSelect) {
    startNumBehaviorSelect.addEventListener("change", () => {
      // Send SUB_PARAM_UPDATE - synth will handle staging vs immediate application
      ctrl._sendSubParameterUpdate(
        paramName + ".startValueGenerator.numeratorBehavior",
        startNumBehaviorSelect.value
      );
      ctrl.markPendingChanges();
    });
  }

  if (startDenBehaviorSelect) {
    startDenBehaviorSelect.addEventListener("change", () => {
      if (!ctrl.isPlaying) {
        ctrl._applyHRGChangeWithPortamento({
          type: "SUB_PARAM_UPDATE",
          paramPath: paramName + ".startValueGenerator.denominatorBehavior",
          value: startDenBehaviorSelect.value,
        });
      } else {
        ctrl._sendSubParameterUpdate(
          paramName + ".startValueGenerator.denominatorBehavior",
          startDenBehaviorSelect.value,
        );
      }
      ctrl.markPendingChanges();
    });
  }

  if (endNumeratorsInput) {
    endNumeratorsInput.addEventListener("input", () => {
      const { ok } = ctrl._validateSINString(endNumeratorsInput.value);
      endNumeratorsInput.classList.toggle("invalid-input", !ok);
      
      // Real-time feedback for input validation
      if (ok) {
        endNumeratorsInput.style.borderColor = "#4CAF50";
      } else {
        endNumeratorsInput.style.borderColor = "#f44336";
      }
    });
    endNumeratorsInput.addEventListener("blur", () => {
      // Send SUB_PARAM_UPDATE - synth will handle staging vs immediate application
      ctrl._sendSubParameterUpdate(
        paramName + ".endValueGenerator.numerators",
        endNumeratorsInput.value
      );
      ctrl.markPendingChanges();
      
      // Reset border color to default after sending update
      endNumeratorsInput.style.borderColor = "";
    });
  }

  if (endDenominatorsInput) {
    endDenominatorsInput.addEventListener("input", () => {
      const { ok } = ctrl._validateSINString(endDenominatorsInput.value);
      endDenominatorsInput.classList.toggle("invalid-input", !ok);
      
      // Real-time feedback for input validation
      if (ok) {
        endDenominatorsInput.style.borderColor = "#4CAF50";
      } else {
        endDenominatorsInput.style.borderColor = "#f44336";
      }
    });
    endDenominatorsInput.addEventListener("blur", () => {
      // Send SUB_PARAM_UPDATE - synth will handle staging vs immediate application
      ctrl._sendSubParameterUpdate(
        paramName + ".endValueGenerator.denominators",
        endDenominatorsInput.value
      );
      ctrl.markPendingChanges();
      
      // Reset border color to default after sending update
      endDenominatorsInput.style.borderColor = "";
    });
  }

  if (endNumBehaviorSelect) {
    endNumBehaviorSelect.addEventListener("change", () => {
      if (!ctrl.isPlaying) {
        ctrl._applyHRGChangeWithPortamento({
          type: "SUB_PARAM_UPDATE",
          paramPath: paramName + ".endValueGenerator.numeratorBehavior",
          value: endNumBehaviorSelect.value,
        });
      } else {
        ctrl._sendSubParameterUpdate(
          paramName + ".endValueGenerator.numeratorBehavior",
          endNumBehaviorSelect.value,
        );
      }
      ctrl.markPendingChanges();
    });
  }

  if (endDenBehaviorSelect) {
    endDenBehaviorSelect.addEventListener("change", () => {
      if (!ctrl.isPlaying) {
        ctrl._applyHRGChangeWithPortamento({
          type: "SUB_PARAM_UPDATE",
          paramPath: paramName + ".endValueGenerator.denominatorBehavior",
          value: endDenBehaviorSelect.value,
        });
      } else {
        ctrl._sendSubParameterUpdate(
          paramName + ".endValueGenerator.denominatorBehavior",
          endDenBehaviorSelect.value,
        );
      }
      ctrl.markPendingChanges();
    });
  }

  // Initialize parameter UI with current state
  ctrl._updateUIFromState("frequency");
}