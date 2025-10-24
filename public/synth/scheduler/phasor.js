/**
 * Phasor synchronization and cycle scheduling for Voice.Assembly.FM Synth Client
 */

/**
 * Handle phasor synchronization messages
 * @param {Object} message - Phasor sync message
 * @param {Object} context - Synth context
 */
export function handlePhasorSync(message, context) {
  context.receivedPhasor = message.phasor;
  context.receivedCpm = message.cpm; // Legacy, may be null
  context.receivedStepsPerCycle = message.stepsPerCycle;
  context.receivedCycleLength = message.cycleLength;
  context.receivedIsPlaying = message.isPlaying !== undefined
    ? message.isPlaying
    : true; // Default to true for backward compatibility
  context.lastPhasorMessage = performance.now();

  // Calculate phasor rate
  context.phasorRate = 1.0 / context.receivedCycleLength;

  // EOC Beacon PLL Implementation
  // Guard against null audioContext during initialization
  if (!context.audioContext) {
    console.log("⏳ Audio context not ready, deferring EOC beacon PLL");
    // Fall back to legacy behavior until audio context is available

    // Update phasor worklet parameters when ready
    if (context.phasorWorklet) {
      context.phasorWorklet.parameters.get("cycleLength").value =
        context.receivedCycleLength;
      context.phasorWorklet.parameters.get("stepsPerCycle").value =
        context.receivedStepsPerCycle;

      if (context.receivedIsPlaying) {
        context.phasorWorklet.port.postMessage({ type: "start" });
      } else {
        context.phasorWorklet.port.postMessage({ type: "stop" });
      }
    }

    // Continue with rest of method for compatibility
    if (
      context.unifiedSynthNode &&
      context.unifiedSynthNode.parameters.has("isPlaying")
    ) {
      context.unifiedSynthNode.parameters.get("isPlaying").value =
        context.receivedIsPlaying ? 1 : 0;
    }

    if (context.programNode) {
      const periodDisplay = message.cpm
        ? `${message.cpm} CPM`
        : `${context.receivedCycleLength}s period`;
      console.log(`⏰ Received phasor sync: ${periodDisplay}`);

      const newTimingConfig = {
        cpm: message.cpm,
        stepsPerCycle: message.stepsPerCycle,
        cycleLength: message.cycleLength,
        phasor: message.phasor,
      };

      context.timingConfig = newTimingConfig;
    }

    updatePhasorWorklet(context);

    if (!context.phasorUpdateId) {
      startPhasorInterpolation(context);
    }
    return;
  }

  const currentAudioTime = context.audioContext.currentTime;
  const messageTimestamp = message.timestamp || performance.now();

  if (context.receivedIsPlaying) {
    // Cache timing for later use
    context.cachedTimingForPause = {
      cycleLength: context.receivedCycleLength,
      stepsPerCycle: context.receivedStepsPerCycle,
    };

    // Estimate message arrival time accounting for network delay
    const estimatedSendTime = messageTimestamp / 1000.0; // Convert to seconds
    const estimatedArrivalDelay = 0.01; // TODO: replace hardcoded guess with per-peer RTT/2 (critical follow-up)
    const beaconAudioTime = currentAudioTime - estimatedArrivalDelay;

    // Store beacon timing for PLL
    context.lastBeaconTime = beaconAudioTime;
    context.lastBeaconPhasor = context.receivedPhasor;

    // Detect beacon type: EOC vs step beacon
    const isEOC = Math.abs(context.receivedPhasor) < 0.001; // phasor ≈ 0

    if (isEOC) {
      // EOC beacon - schedule next cycle reset
      context.nextCycleTime = beaconAudioTime + context.receivedCycleLength;

      // Send EOC scheduling to phasor worklet
      if (context.phasorWorklet) {
        context.phasorWorklet.port.postMessage({
          type: "schedule-eoc-reset",
          nextCycleTime: context.nextCycleTime,
          cycleLength: context.receivedCycleLength,
          correctionFactor: context.pllCorrectionFactor,
        });
      }

      console.log(
        `🎯 EOC beacon: scheduled next cycle at audio time ${
          context.nextCycleTime.toFixed(3)
        }s`,
      );
    } else {
      // Step beacon - apply gentle PLL correction
      const expectedStepIndex = Math.round(
        context.receivedPhasor * context.receivedStepsPerCycle,
      );
      const stepPhase = expectedStepIndex / context.receivedStepsPerCycle;

      // Send step-aligned phase correction to worklet
      if (context.phasorWorklet) {
        context.phasorWorklet.port.postMessage({
          type: "phase-correction",
          targetPhase: stepPhase,
          correctionFactor: context.pllCorrectionFactor * 0.5, // Gentler correction for steps
        });
      }

      console.log(
        `🔄 Step beacon: step ${expectedStepIndex} (phase ${
          stepPhase.toFixed(3)
        })`,
      );
    }
  } else {
    // Paused - stop worklet and cache state
    if (context.phasorWorklet) {
      context.phasorWorklet.port.postMessage({ type: "stop" });
    }

    // Cache current timing configuration for later
    context.cachedTimingForPause = {
      cycleLength: context.receivedCycleLength,
      stepsPerCycle: context.receivedStepsPerCycle,
    };

    console.log("⏸️ Paused - worklet stopped, timing cached");
  }

  // Update transport state in worklets
  updateTransportState(context);

  // Update phasor worklet parameters
  updatePhasorWorklet(context);

  // Start interpolation if not already running
  if (!context.phasorUpdateId) {
    startPhasorInterpolation(context);
  }
}

/**
 * Update transport state in worklets
 * @param {Object} context - Synth context
 */
export function updateTransportState(context) {
  // Update unified synth node if available
  if (
    context.unifiedSynthNode &&
    context.unifiedSynthNode.parameters.has("isPlaying")
  ) {
    context.unifiedSynthNode.parameters.get("isPlaying").value =
      context.receivedIsPlaying ? 1 : 0;
  }

  // Update timing config for program node
  if (context.programNode) {
    const periodDisplay = context.receivedCpm
      ? `${context.receivedCpm} CPM`
      : `${context.receivedCycleLength}s period`;
    console.log(`⏰ Received phasor sync: ${periodDisplay}`);

    const newTimingConfig = {
      cpm: context.receivedCpm,
      stepsPerCycle: context.receivedStepsPerCycle,
      cycleLength: context.receivedCycleLength,
      phasor: context.receivedPhasor,
    };

    context.timingConfig = newTimingConfig;
  }
}

/**
 * Update phasor worklet parameters
 * @param {Object} context - Synth context
 */
export function updatePhasorWorklet(context) {
  if (!context.phasorWorklet) return;

  // Update timing parameters
  context.phasorWorklet.parameters.get("cycleLength").value =
    context.receivedCycleLength;
  context.phasorWorklet.parameters.get("stepsPerCycle").value =
    context.receivedStepsPerCycle;

  // Update transport state
  if (context.receivedIsPlaying) {
    context.phasorWorklet.port.postMessage({ type: "start" });
  } else {
    context.phasorWorklet.port.postMessage({ type: "stop" });
  }
}

/**
 * Start phasor interpolation for smooth visual updates
 * @param {Object} context - Synth context
 */
export function startPhasorInterpolation(context) {
  const interpolateFrame = () => {
    // Calculate time since last phasor message
    const now = performance.now();
    const deltaTimeMs = now - context.lastPhasorMessage;
    const deltaTimeSeconds = deltaTimeMs / 1000;

    // Update interpolated phasor if playing
    if (context.receivedIsPlaying && context.phasorRate > 0) {
      context.interpolatedPhasor =
        (context.receivedPhasor + deltaTimeSeconds * context.phasorRate) % 1.0;
    } else {
      context.interpolatedPhasor = context.receivedPhasor;
    }

    // Update phase display
    context.updatePhaseDisplay();

    // Continue interpolation
    context.phasorUpdateId = requestAnimationFrame(interpolateFrame);
  };

  // Start the interpolation loop
  context.phasorUpdateId = requestAnimationFrame(interpolateFrame);
}

/**
 * Stop phasor interpolation
 * @param {Object} context - Synth context
 */
export function stopPhasorInterpolation(context) {
  if (context.phasorUpdateId) {
    cancelAnimationFrame(context.phasorUpdateId);
    context.phasorUpdateId = null;
  }
}

/**
 * Reset the phasor to a specific phase, keeping UI and worklet in sync.
 * Used after scene load while paused.
 * @param {Object} context - Synth context
 * @param {number} [phase=0] - Target phase (0-1)
 */
export function resetPhasorState(context, phase = 0) {
  if (context.phasorWorklet) {
    context.phasorWorklet.port.postMessage({
      type: "set-phase",
      phase,
    });

    // Honour the paused/playing state after resetting
    context.phasorWorklet.port.postMessage({
      type: context.receivedIsPlaying ? "start" : "stop",
    });
  }

  context.workletPhasor = phase;
  context.receivedPhasor = phase;
  context.interpolatedPhasor = phase;
  context.pausedPhase = phase;
  context.lastPhasorMessage = performance.now();

  if (typeof context.updatePhaseDisplay === "function") {
    context.updatePhaseDisplay();
  }
}

/**
 * Get current phase value
 * @param {Object} context - Synth context
 * @returns {number} - Current phase (0-1)
 */
export function getCurrentPhase(context) {
  // Prioritize worklet phasor for accuracy, fallback to interpolated
  return context.workletPhasor !== undefined
    ? context.workletPhasor
    : context.interpolatedPhasor || 0;
}

/**
 * Handle transport control messages
 * @param {Object} message - Transport message
 * @param {Object} context - Synth context
 */
export function handleTransport(message, context) {
  if (message.action === "play") {
    console.log("▶️ Transport: Play received");

    // Update local state
    context.receivedIsPlaying = true;
    context.isPaused = false;

    // Start phasor worklet
    if (context.phasorWorklet) {
      context.phasorWorklet.port.postMessage({ type: "start" });
    }

    // Update synthesis status
    context.updateSynthesisStatus(context.synthesisActive);
  } else if (message.action === "pause") {
    console.log("⏸️ Transport: Pause received");

    // Update local state
    context.receivedIsPlaying = false;
    context.isPaused = true;
    context.pausedPhase = getCurrentPhase(context);

    // Stop phasor worklet
    if (context.phasorWorklet) {
      context.phasorWorklet.port.postMessage({ type: "stop" });
    }

    // Update synthesis status
    context.updateSynthesisStatus(context.synthesisActive);
  }
}

/**
 * Handle jump to end of cycle
 * @param {Object} message - Jump to EOC message
 * @param {Object} context - Synth context
 */
export function handleJumpToEOC(message, context) {
  console.log("⏭️ Jump to EOC received");

  if (context.phasorWorklet) {
    context.phasorWorklet.port.postMessage({ type: "reset" });
  }

  // Update interpolated phasor
  context.interpolatedPhasor = 0.0;

  // Apply any pending scene changes immediately
  if (context._pendingSceneAtEoc) {
    context.applyPendingScene();
  }
}
