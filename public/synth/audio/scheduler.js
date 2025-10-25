// @ts-check

/**
 * AudioParam scheduling facade for Voice.Assembly.FM Synth
 * Provides direct AudioParam control for envelope parameters
 */

/**
 * Schedule a single envelope parameter using AudioParams
 * @param {AudioWorkletNode} voiceNode - Voice worklet node
 * @param {string} paramName - Parameter name (e.g., "frequency")
 * @param {number} startValue - Start value
 * @param {number} endValue - End value
 * @param {number} contextTime - AudioContext time for scheduling
 * @param {number} [portamentoMs] - Optional portamento time in milliseconds
 */
export function scheduleEnvelope(
  voiceNode,
  paramName,
  startValue,
  endValue,
  contextTime,
  portamentoMs = 0,
) {
  const startParam = voiceNode.parameters.get(`${paramName}_start`);
  const endParam = voiceNode.parameters.get(`${paramName}_end`);

  if (!startParam || !endParam) {
    console.warn(`⚠️ AudioParams not found for ${paramName}`);
    return;
  }

  // Cancel any scheduled changes
  startParam.cancelScheduledValues(contextTime);
  endParam.cancelScheduledValues(contextTime);

  if (portamentoMs > 0) {
    // Apply portamento as a smooth transition
    const portamentoTime = portamentoMs / 1000; // Convert to seconds
    startParam.setTargetAtTime(startValue, contextTime, portamentoTime / 3);
    endParam.setTargetAtTime(endValue, contextTime, portamentoTime / 3);
  } else {
    // Instant change
    startParam.setValueAtTime(startValue, contextTime);
    endParam.setValueAtTime(endValue, contextTime);
  }
}

/**
 * Schedule all resolved envelope parameters
 * @param {AudioWorkletNode} voiceNode - Voice worklet node
 * @param {AudioContext} audioContext - Audio context
 * @param {Record<string, {startValue: number, endValue: number, interpolation: string}>} resolved - Resolved parameters
 * @param {number} [portamentoMs] - Optional portamento time
 */
export function scheduleAllEnvelopes(
  voiceNode,
  audioContext,
  resolved,
  portamentoMs = 0,
) {
  const contextTime = audioContext.currentTime;

  // Schedule each parameter
  for (const [paramName, values] of Object.entries(resolved)) {
    if (
      values && typeof values.startValue === "number" &&
      typeof values.endValue === "number"
    ) {
      scheduleEnvelope(
        voiceNode,
        paramName,
        values.startValue,
        values.endValue,
        contextTime,
        portamentoMs,
      );
    }
  }

  console.log(
    `📅 Scheduled ${Object.keys(resolved).length} envelopes at t=${
      contextTime.toFixed(3)
    } with ${portamentoMs}ms portamento`,
  );
}

/**
 * Reset envelope state in the worklet
 * @param {AudioWorkletNode} voiceNode - Voice worklet node
 * @param {Record<string, string>} [interpolations] - Optional interpolation types for each parameter
 */
export function resetEnvelopes(voiceNode, interpolations = {}) {
  voiceNode.port.postMessage({
    type: "RESET_ENV",
    interpolations,
  });
}

/**
 * Apply resolved program using AudioParam scheduling
 * @param {Object} context - Synth context
 * @param {Record<string, {startValue: number, endValue: number, interpolation: string}>} resolved - Resolved parameters
 * @param {number} [portamentoMs] - Portamento time in milliseconds
 * @param {Object} [options] - Additional options
 * @param {boolean} [options.stageForEoc] - If true and playing, stage for EOC instead of immediate apply
 */
export function applyResolvedProgram(
  context,
  resolved,
  portamentoMs = 0,
  { stageForEoc = false } = {},
) {
  if (!context.voiceNode) {
    console.warn("⚠️ Cannot apply resolved program: voice node not ready");
    return;
  }

  // Check if we should stage for EOC
  if (stageForEoc && (context.isPlaying || context.receivedIsPlaying)) {
    // Convert resolved to envelope payload format and stage it
    const envPayload = {};
    for (const [param, cfg] of Object.entries(resolved)) {
      if (cfg) {
        envPayload[param] = {
          startValue: cfg.startValue,
          endValue: cfg.endValue,
          interpolation: cfg.interpolation,
          portamentoMs,
        };
      }
    }

    context._pendingSceneAtEoc = envPayload;
    console.log("📋 Staged changes for next EOC boundary");
    return;
  }

  // Extract interpolation types for worklet
  const interpolations = {};
  for (const [param, cfg] of Object.entries(resolved)) {
    if (cfg && cfg.interpolation) {
      interpolations[param] = cfg.interpolation;
    }
  }

  // Reset worklet envelope state with interpolation info
  resetEnvelopes(context.voiceNode, interpolations);

  // Schedule AudioParam updates
  scheduleAllEnvelopes(
    context.voiceNode,
    context.audioContext,
    resolved,
    portamentoMs,
  );

  console.log("✅ Applied resolved program via AudioParams");
}
