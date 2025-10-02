// @ts-check

/**
 * Parameter handling for Voice.Assembly.FM Synth Client
 */

/**
 * Handle program update message
 * @param {Object} message - Program update message
 * @param {Object} context - Synth context
 * @param {AudioWorkletNode} context.voiceNode - Voice worklet node
 * @param {boolean} context.verbose - Verbose logging
 * @param {Object} context.programConfig - Program configuration
 * @param {boolean} context.synthesisActive - Synthesis active state
 * @param {boolean} context.receivedIsPlaying - Playing state
 * @param {function} context.initializeHRGState - HRG state initializer
 * @param {function} context.activateImmediateSynthesis - Synthesis activator
 * @param {function} context.applyProgramParameters - Parameter applicator
 * @returns {Object} - Updated context
 */
export function handleProgramUpdate(message, context) {
  if (context.verbose) console.log("📨 PROGRAM_UPDATE received:", message);

  if (!context.voiceNode) {
    // Cache and apply after audio/worklets are initialized
    console.warn("⚠️ Worklets not ready; caching PROGRAM_UPDATE for later");
    return { lastProgramUpdate: message };
  }

  // Check if this update includes portamento time for paused parameter changes
  const hasPortamento = message.portamentoTime !== undefined;

  // Store program config in main thread (we are the musical brain now)
  const programConfig = {};

  // Handle synthesis active state
  let synthesisActive = context.synthesisActive;
  if (message.synthesisActive !== undefined) {
    if (context.voiceNode && context.voiceNode.parameters.has("active")) {
      const activeParam = context.voiceNode.parameters.get("active");
      activeParam.value = message.synthesisActive ? 1 : 0;
      if (context.verbose) {
        console.log(
          `🎵 Synthesis ${message.synthesisActive ? "enabled" : "disabled"}`,
        );
      }
    }
    synthesisActive = !!message.synthesisActive;
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
      ].includes(paramName)
    ) continue;

    const paramData = message[paramName];

    // Store parameter config
    programConfig[paramName] = paramData;

    // Error guard: reject messages with scope field
    if ("scope" in paramData) {
      console.error(
        `BREAKING: Parameter '${paramName}' contains forbidden 'scope' field. Ignoring message.`,
      );
      throw new Error(
        `Parameter '${paramName}' has scope field - this is forbidden`,
      );
    }

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
    context.initializeHRGState(paramName, paramData);

    if (context.verbose) {
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
  if (!context.receivedIsPlaying) {
    // Nothing to do now; handleCycleReset will push start/end AudioParams
  } else {
    const pt = message.portamentoTime ?? 0;
    console.log(
      `⚡ Applying program update now with ${pt}ms portamento (paused)`,
    );

    // Call activateImmediateSynthesis only when synthesis is being enabled for the first time
    if (message.synthesisActive && !context.synthesisActive) {
      context.activateImmediateSynthesis();
    }

    // Apply changed parameters with portamento (for all paused updates, regardless of synthesis state)
    context.applyProgramParameters(message, pt);
  }

  return {
    programConfig,
    synthesisActive,
  };
}

/**
 * Handle sub-parameter update
 * @param {Object} message - Sub-parameter update message
 * @param {Object} context - Synth context
 * @param {AudioWorkletNode} context.voiceNode - Voice worklet node
 * @param {boolean} context.verbose - Verbose logging
 * @param {Object} context.programConfig - Program configuration
 * @param {Object} context.lastResolvedValues - Last resolved values
 * @param {function} context.setNestedProperty - Property setter
 * @param {function} context.resolveParameterValue - Parameter resolver
 */
export function handleSubParameterUpdate(message, context) {
  if (context.verbose) {
    console.log("📧 SUB_PARAM_UPDATE received:", message);
  }

  if (!context.voiceNode) {
    console.warn("⚠️ Worklets not ready; ignoring SUB_PARAM_UPDATE");
    return;
  }

  const { paramPath, value, portamentoTime } = message;

  // Update local program config
  if (context.programConfig) {
    context.setNestedProperty(context.programConfig, paramPath, value);
  }

  // Parse parameter path (e.g., "frequency.baseValue")
  const pathParts = paramPath.split(".");
  const paramName = pathParts[0];

  if (pathParts.length === 2 && pathParts[1] === "baseValue") {
    // Direct baseValue update - apply to voice worklet immediately
    const portamentoMs = portamentoTime || 0;

    context.voiceNode.port.postMessage({
      type: "SET_ENV",
      param: paramName,
      startValue: value,
      endValue: value,
      interpolation: "step",
      portamentoMs: portamentoMs,
    });

    // Track resolved value
    context.lastResolvedValues[paramName] = value;

    if (context.verbose) {
      console.log(
        `🎚️ Direct baseValue update: ${paramName} = ${value} (${portamentoMs}ms)`,
      );
    }
  } else {
    // Complex sub-parameter update - resolve and apply
    const paramState = context.programConfig[paramName];
    if (paramState) {
      const resolvedValue = context.resolveParameterValue(
        paramState.startValueGenerator,
        paramName,
        "start",
      );

      const portamentoMs = portamentoTime || 0;

      context.voiceNode.port.postMessage({
        type: "SET_ENV",
        param: paramName,
        startValue: resolvedValue,
        endValue: resolvedValue,
        interpolation: "step",
        portamentoMs: portamentoMs,
      });

      // Track resolved value
      context.lastResolvedValues[paramName] = resolvedValue;

      if (context.verbose) {
        console.log(
          `🎚️ Resolved sub-param update: ${paramPath} -> ${paramName} = ${resolvedValue} (${portamentoMs}ms)`,
        );
      }
    }
  }
}

/**
 * Apply program parameters with portamento
 * @param {Object} message - Program message
 * @param {number} portamentoTime - Portamento time in ms
 * @param {Object} context - Synth context
 * @param {AudioWorkletNode} context.voiceNode - Voice worklet node
 * @param {boolean} context.verbose - Verbose logging
 * @param {Object} context.lastResolvedValues - Last resolved values
 * @param {function} context.resolveParameterValue - Parameter resolver
 */
export function applyProgramParameters(message, portamentoTime, context) {
  const voiceParams = {};

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
    const paramData = message[paramName];

    // Resolve current parameter value
    const resolvedValue = context.resolveParameterValue(
      paramData.startValueGenerator,
      paramName,
      "start",
    );

    // Add to voice parameters batch
    voiceParams[paramName] = {
      startValue: resolvedValue,
      endValue: resolvedValue,
      interpolation: "step",
      portamentoMs: portamentoTime,
    };

    // Track resolved value
    context.lastResolvedValues[paramName] = resolvedValue;

    if (context.verbose) {
      console.log(
        `🎚️ Paused param apply: ${paramName} = ${resolvedValue} (${portamentoTime}ms)`,
      );
    }
  }

  // Send all voice parameters in a single batch
  if (context.voiceNode && Object.keys(voiceParams).length > 0) {
    context.voiceNode.port.postMessage({
      type: "SET_ALL_ENV",
      params: voiceParams,
    });
  }
}

/**
 * Apply resolved state values (for scenes)
 * @param {Object} resolvedState - Resolved state values
 * @param {Object} context - Synth context
 * @param {AudioWorkletNode} context.voiceNode - Voice worklet node
 * @param {boolean} context.verbose - Verbose logging
 * @param {boolean} context.synthesisActive - Synthesis active state
 */
export function applyResolvedStateValues(resolvedState, context) {
  if (context.verbose) {
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
    if (context.verbose) {
      console.log(`🎚️ Scene apply: ${paramName} -> ${v} (via SET_ALL_ENV)`);
    }
  }

  // Send all voice parameters in a single SET_ALL_ENV message
  if (context.voiceNode && Object.keys(voiceParams).length > 0) {
    context.voiceNode.port.postMessage({
      type: "SET_ALL_ENV",
      params: voiceParams,
    });
  }

  // Handle synthesis active state separately via direct AudioParam
  if (context.voiceNode && context.synthesisActive !== undefined) {
    const activeValue = context.synthesisActive ? 1 : 0;
    context.voiceNode.parameters.get("active").value = activeValue;
  }
}

/**
 * Activate immediate synthesis (for first-time activation)
 * @param {AudioWorkletNode} voiceNode - Voice worklet node
 * @param {boolean} verbose - Verbose logging
 */
export function activateImmediateSynthesis(voiceNode, verbose = false) {
  if (!voiceNode) return;

  if (verbose) {
    console.log("🚀 Activating synthesis for the first time");
  }

  // Send activation message to voice worklet
  voiceNode.port.postMessage({
    type: "ACTIVATE",
    timestamp: performance.now(),
  });

  // Set active parameter
  if (voiceNode.parameters.has("active")) {
    voiceNode.parameters.get("active").value = 1;
  }
}

/**
 * Set nested property by path
 * @param {Object} obj - Target object
 * @param {string} path - Property path (e.g., "frequency.baseValue")
 * @param {any} value - Value to set
 */
export function setNestedProperty(obj, path, value) {
  const parts = path.split(".");
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current)) {
      current[part] = {};
    }
    current = current[part];
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * Initialize parameter output mapping
 * @returns {Object} - Parameter to output channel mapping
 */
export function createParameterOutputMapping() {
  return {
    frequency: 0,
    zingMorph: 1,
    zingAmount: 2,
    vowelX: 3,
    vowelY: 4,
    symmetry: 5,
    amplitude: 6,
    whiteNoise: 7,
  };
}