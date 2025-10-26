// @ts-check

/**
 * UI Controls and Event Handlers for Voice.Assembly.FM
 * Handles all DOM event bindings and user interaction logic
 */

import {
  setupCompactParameterControls,
  setupHrgParameterControls,
} from "./schema.js";
import { initializeSchemaBasedUI } from "./generator.js";

/**
 * Setup event handlers for the main UI controls
 * @param {Object} ctrl - The ControlClient instance
 */
export function setupEventHandlers(ctrl) {
  console.log("Setting up event handlers...");

  // Manual mode (button doesn't exist in current layout)
  if (ctrl.elements.manualModeBtn) {
    ctrl.elements.manualModeBtn.addEventListener(
      "click",
      () => ctrl.toggleSynthesis(),
    );
  }

  // Debug log
  // Clear log button (removed from layout)
  if (ctrl.elements.clearLogBtn) {
    ctrl.elements.clearLogBtn.addEventListener(
      "click",
      () => ctrl.clearLog(),
    );
  }

  // Clear banks button
  if (ctrl.elements.clearBanksBtn) {
    ctrl.elements.clearBanksBtn.addEventListener(
      "click",
      () => ctrl.clearSceneBanks(),
    );
  }

  // Portamento controls
  if (ctrl.elements.portamentoTime) {
    ctrl.elements.portamentoTime.addEventListener("input", (e) => {
      const norm = parseFloat(e.target.value);
      const ms = ctrl._mapPortamentoNormToMs(norm);
      const displayMs = ms < 10 ? ms.toFixed(1) : Math.round(ms);
      ctrl.elements.portamentoValue.textContent = displayMs + "ms";
    });
  }

  // Re-resolve button
  if (ctrl.elements.reresolveBtn) {
    console.log("Re-resolve button found, adding click handler");
    ctrl.elements.reresolveBtn.addEventListener("click", () => {
      console.log("⚡ Re-resolve button clicked!");
      ctrl.triggerImmediateReinitialize();
    });
  } else {
    console.error("Re-resolve button not found in DOM");
  }

  // Period-Steps linkage controls
  if (ctrl.elements.linkStepsCheckbox) {
    ctrl.elements.linkStepsCheckbox.addEventListener("change", (e) => {
      ctrl.linkStepsToPeriod = e.target.checked;
      ctrl.log(
        "Period-steps linkage: " + (ctrl.linkStepsToPeriod ? "ON" : "OFF"),
        "info",
      );
    });
  }

  // Preset buttons
  if (ctrl.elements.presetDefault) {
    ctrl.elements.presetDefault.addEventListener("click", () => {
      ctrl._applyPreset("default");
    });
  }
  if (ctrl.elements.presetFullStep) {
    ctrl.elements.presetFullStep.addEventListener("click", () => {
      ctrl._applyPreset("full-step");
    });
  }
  if (ctrl.elements.presetFullDisc) {
    ctrl.elements.presetFullDisc.addEventListener("click", () => {
      ctrl._applyPreset("full-disc");
    });
  }
  if (ctrl.elements.presetFullCont) {
    ctrl.elements.presetFullCont.addEventListener("click", () => {
      ctrl._applyPreset("full-cont");
    });
  }
  if (ctrl.elements.presetCalibration) {
    ctrl.elements.presetCalibration.addEventListener("click", () => {
      ctrl._applyPreset("calibration");
    });
  }

  // Musical controls
  setupMusicalControls(ctrl);
}

/**
 * Setup control parameter controls (timing, transport, etc.)
 * @param {Object} ctrl - The ControlClient instance
 */
export function setupMusicalControls(ctrl) {
  // Note: All synthesis parameters are now handled by setupEnvelopeControls()

  // Envelope controls for all parameters that support them
  setupEnvelopeControls(ctrl);

  // Period and steps inputs
  if (ctrl.elements.periodInput) {
    ctrl.elements.periodInput.addEventListener("blur", (e) => {
      const newPeriod = parseFloat(e.target.value);

      // Validate period is within safe bounds (now 0.2s minimum)
      if (isNaN(newPeriod) || newPeriod < 0.2 || newPeriod > 60) {
        ctrl.log(
          "Invalid period: " + e.target.value + "s (must be 0.2-60s)",
          "error",
        );
        return;
      }

      // Period→Steps linkage
      if (ctrl.linkStepsToPeriod) {
        let targetSteps = Math.round(newPeriod / ctrl.stepRefSec);

        // Clamp to [1, 256] - no step interval clamping (beacon stride handles network protection)
        targetSteps = Math.max(1, Math.min(256, targetSteps));

        // Update steps input to show computed value
        if (ctrl.elements.stepsInput) {
          ctrl.elements.stepsInput.value = targetSteps.toString();
        }

        // Stage both period and computed steps
        ctrl.pendingPeriodSec = newPeriod;
        ctrl.pendingStepsPerCycle = targetSteps;

        ctrl.log("Period staged: " + newPeriod + "s, computed steps)", "info");
      } else {
        // Only stage period change
        ctrl.pendingPeriodSec = newPeriod;

        ctrl.log("Period staged for EOC)", "info");
      }
    });
  }

  if (ctrl.elements.stepsInput) {
    ctrl.elements.stepsInput.addEventListener("blur", (e) => {
      let newSteps = parseInt(e.target.value);

      // Basic validation and clamping
      if (isNaN(newSteps) || newSteps < 1) {
        newSteps = 1;
      }
      if (newSteps > 256) {
        newSteps = 256;
      }

      // Ensure the input reflects the clamped value
      if (e.target.value !== newSteps.toString()) {
        e.target.value = newSteps.toString();
      }

      // Stage steps change (apply at EOC)
      ctrl.pendingStepsPerCycle = newSteps;

      ctrl.log("Steps staged for EOC: " + newSteps, "info");
    });
  }

  // Transport controls
  if (ctrl.elements.playBtn) {
    ctrl.elements.playBtn.addEventListener("click", () => {
      // Toggle between play and pause based on current state
      if (ctrl.isPlaying) {
        ctrl.handleTransport("pause");
      } else {
        ctrl.handleTransport("play");
      }
    });
  }

  if (ctrl.elements.stopBtn) {
    ctrl.elements.stopBtn.addEventListener("click", () => {
      ctrl.handleTransport("stop");
    });
  }

  // Phase bar scrubbing (only when paused)
  if (ctrl.elements.phasorBar && ctrl.elements.phasorBar.parentElement) {
    const phasorContainer = ctrl.elements.phasorBar.parentElement;

    phasorContainer.addEventListener("pointerdown", (e) => {
      ctrl.startScrubbing(e);
      phasorContainer.setPointerCapture(e.pointerId);
    });

    phasorContainer.addEventListener("pointermove", (e) => {
      ctrl.updateScrubbing(e);
    });

    phasorContainer.addEventListener("pointerup", (e) => {
      ctrl.stopScrubbing(e);
      phasorContainer.releasePointerCapture(e.pointerId);
    });

    phasorContainer.addEventListener("pointercancel", (e) => {
      ctrl.stopScrubbing(e);
    });

    // Prevent text selection during scrub
    phasorContainer.style.userSelect = "none";
    phasorContainer.style.touchAction = "none";
  }

  if (ctrl.elements.resetBtn) {
    ctrl.elements.resetBtn.addEventListener("click", () => {
      ctrl.handleReset();
    });
  }

  // Steps per cycle slider
  if (ctrl.elements.stepsPerCycleSlider) {
    ctrl.elements.stepsPerCycleSlider.addEventListener("input", (e) => {
      ctrl.stepsPerCycle = parseFloat(e.target.value);
      ctrl.elements.stepsPerCycleValue.textContent = ctrl.stepsPerCycle
        .toString();
    });
  }

  // ES-8 enable button
  if (ctrl.elements.es8EnableBtn) {
    ctrl.elements.es8EnableBtn.addEventListener(
      "click",
      () => ctrl.toggleES8(),
    );
  }

  // Bulk mode controls
  if (ctrl.elements.bulkModeCheckbox) {
    ctrl.elements.bulkModeCheckbox.addEventListener("change", () => {
      ctrl.bulkModeEnabled = ctrl.elements.bulkModeCheckbox.checked;

      // Toggle visibility of apply bulk button based on bulk mode state
      if (ctrl.elements.applyBulkBtn) {
        ctrl.elements.applyBulkBtn.style.display = ctrl.bulkModeEnabled
          ? "inline-block"
          : "none";
      }

      // Reset pending list when toggling bulk mode
      ctrl.clearPendingChanges();

      ctrl.log(
        "Bulk mode: " + (ctrl.bulkModeEnabled ? "enabled" : "disabled"),
        "info",
      );
    });
  }

  if (ctrl.elements.applyBulkBtn) {
    ctrl.elements.applyBulkBtn.addEventListener("click", () => {
      ctrl.applyBulkChanges();
    });
  }

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    // Cmd+Enter (Mac) or Ctrl+Enter (PC) triggers Send Program
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      ctrl.log("Keyboard shortcut: Broadcasting parameters", "info");
      ctrl.broadcastControlState();
    }
  });

  // Scene button handlers
  setupSceneControls(ctrl);
}

/**
 * Setup envelope controls for all control parameters
 * @param {Object} ctrl - The ControlClient instance
 */
export function setupEnvelopeControls(ctrl) {
  // Initialize schema-based UI generation (if enabled)
  // This will either generate controls dynamically or enhance existing ones
  initializeSchemaBasedUI();

  // All parameters now use the new compact format
  // Setup compact parameter controls (new format)
  setupHrgParameterControls(ctrl, "frequency");
  setupHrgParameterControls(ctrl, "vibratoRate");
  setupCompactParameterControls(ctrl, "vowelX");
  setupCompactParameterControls(ctrl, "vowelY");
  setupCompactParameterControls(ctrl, "zingAmount");
  setupCompactParameterControls(ctrl, "zingMorph");
  setupCompactParameterControls(ctrl, "symmetry");
  setupCompactParameterControls(ctrl, "amplitude");
  setupCompactParameterControls(ctrl, "whiteNoise");
  setupCompactParameterControls(ctrl, "vibratoWidth");

  // Initialize all parameter UIs using unified state/UI sync
  Object.keys(ctrl.liveState).forEach((paramName) => {
    ctrl.setParameterState(
      paramName,
      ctrl.liveState[paramName],
    );
  });
}

/**
 * Setup scene bank controls
 * @param {Object} ctrl - The ControlClient instance
 */
export function setupSceneControls(ctrl) {
  const sceneButtons = document.querySelectorAll(".scene-btn");
  sceneButtons.forEach((button) => {
    button.addEventListener("click", (e) => {
      const location = parseInt(button.getAttribute("data-location"));
      if (e.shiftKey) {
        // Shift+click = save scene
        ctrl.saveScene(location);
      } else {
        // Normal click = load scene
        ctrl.loadScene(location);
      }
    });
  });
}

/**
 * Setup tabindex-based keyboard navigation for focusable elements
 * @param {Object} ctrl - The ControlClient instance
 */
export function setupKeyboardNavigation(ctrl) {
  const focusableElements = document.querySelectorAll(
    'input[type="text"], input[type="number"], input[type="range"], select, button',
  );

  focusableElements.forEach((element, index) => {
    element.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();

        let nextIndex;
        if (e.shiftKey) {
          // Shift+Tab: previous element
          nextIndex = index === 0 ? focusableElements.length - 1 : index - 1;
        } else {
          // Tab: next element
          nextIndex = index === focusableElements.length - 1 ? 0 : index + 1;
        }

        focusableElements[nextIndex].focus();
      }
    });
  });
}
