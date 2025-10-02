/**
 * Scene management for Voice.Assembly.FM Synth Client
 */

/**
 * Handle save scene message
 * @param {Object} payload - Save scene payload
 * @param {Object} context - Synth context
 */
export function handleSaveScene(payload, context) {
  // Save immediately regardless of play/pause state
  console.log(`💾 Capturing scene ${payload.memoryLocation} immediately`);
  context.sceneSnapshots[payload.memoryLocation] = buildSceneSnapshot(context);
}

/**
 * Capture scene to memory bank
 * @param {number} bank - Memory bank number
 * @param {Object} context - Synth context
 */
export function captureScene(bank, context) {
  const snapshot = {};
  const sequences = {};

  // Capture minimal scene state based on parameter mode and generator type
  for (
    const param of [
      "frequency",
      "vowelX",
      "vowelY",
      "zingAmount",
      "zingMorph",
      "symmetry",
      "amplitude",
      "whiteNoise",
    ]
  ) {
    const paramConfig = context.programConfig[param];

    if (!paramConfig) {
      // No configuration available
      continue;
    }

    if (paramConfig.interpolation === "step") {
      // Program step mode - check generator type
      if (paramConfig.startValueGenerator?.type === "periodic") {
        // HRG - save sequence state (not values)
        const hrgState = context.hrgState[param]?.start;
        if (hrgState) {
          sequences[param] = {
            numeratorBehavior: hrgState.numeratorBehavior,
            denominatorBehavior: hrgState.denominatorBehavior,
            indexN: hrgState.indexN,
            indexD: hrgState.indexD,
            orderN: hrgState.orderN,
            orderD: hrgState.orderD,
          };
        }
      } else if (paramConfig.startValueGenerator?.type === "normalised") {
        // RBG - determine if stat or rand mode
        const generator = paramConfig.startValueGenerator;
        if (typeof generator.range === "number") {
          // Stat mode - save scalar value
          snapshot[param] = generator.range;
        }
        // Rand mode - save nothing, let it re-randomize
      }
    }
    // Skip cosine parameters - they regenerate from program
  }

  // Save to in-memory array (ephemeral)
  context.sceneSnapshots[bank] = { snapshot, sequences };

  console.log(
    `[SCENE] saved to memory slot ${bank}, sequences.frequency:`,
    sequences.frequency,
    `snapshot.frequency:`,
    snapshot.frequency,
  );
}

/**
 * Build complete scene snapshot with versioned schema
 * @param {Object} context - Synth context
 * @returns {Object} - Scene snapshot
 */
export function buildSceneSnapshot(context) {
  const program = JSON.parse(JSON.stringify(context.programConfig || {}));

  // Capture complete HRG state
  const hrg = {};
  for (const [param, state] of Object.entries(context.hrgState || {})) {
    hrg[param] = {};
    if (state.start) {
      hrg[param].start = {
        numeratorBehavior: state.start.numeratorBehavior,
        denominatorBehavior: state.start.denominatorBehavior,
        indexN: state.start.indexN,
        indexD: state.start.indexD,
        orderN: state.start.orderN || null,
        orderD: state.start.orderD || null,
      };
    }
    if (state.end) {
      hrg[param].end = {
        numeratorBehavior: state.end.numeratorBehavior,
        denominatorBehavior: state.end.denominatorBehavior,
        indexN: state.end.indexN,
        indexD: state.end.indexD,
        orderN: state.end.orderN || null,
        orderD: state.end.orderD || null,
      };
    }
  }

  // Capture RBG cache
  const rbg = { ...(context.rbgState || {}) };

  return {
    v: 1, // Version for future compatibility
    program,
    stochastic: { hrg, rbg },
    meta: {
      synthId: context.peerId,
      sampleRate: context.audioContext?.sampleRate || 48000,
      synthesisActive: context.synthesisActive,
      isPlaying: context.isPlaying,
      createdAt: Date.now(),
    },
  };
}

/**
 * Restore scene snapshot with bounds safety
 * @param {Object} snapshot - Scene snapshot
 * @param {Object} context - Synth context
 */
export function restoreSceneSnapshot(snapshot, context) {
  if (!snapshot || snapshot.v !== 1) {
    throw new Error("Unsupported scene snapshot version");
  }

  // 1) Restore program
  context.programConfig = JSON.parse(JSON.stringify(snapshot.program));

  // 2) Restore HRG with bounds clamping
  context.hrgState = {};
  for (
    const [param, positions] of Object.entries(snapshot.stochastic.hrg || {})
  ) {
    if (!context.programConfig[param]) continue;

    context.hrgState[param] = {};

    // Restore start position
    if (positions.start) {
      const startGen = context.programConfig[param].startValueGenerator;
      const numerators = context._parseSIN(startGen?.numerators || "1");
      const denominators = context._parseSIN(startGen?.denominators || "1");

      context.hrgState[param].start = {
        numerators,
        denominators,
        numeratorBehavior: positions.start.numeratorBehavior,
        denominatorBehavior: positions.start.denominatorBehavior,
        // Clamp indices to array bounds
        indexN: Math.min(positions.start.indexN, numerators.length - 1),
        indexD: Math.min(positions.start.indexD, denominators.length - 1),
        orderN: positions.start.orderN || null,
        orderD: positions.start.orderD || null,
      };
    }

    // Restore end position (for cosine)
    if (positions.end) {
      const endGen = context.programConfig[param].endValueGenerator;
      const numerators = context._parseSIN(endGen?.numerators || "1");
      const denominators = context._parseSIN(endGen?.denominators || "1");

      context.hrgState[param].end = {
        numerators,
        denominators,
        numeratorBehavior: positions.end.numeratorBehavior,
        denominatorBehavior: positions.end.denominatorBehavior,
        // Clamp indices to array bounds
        indexN: Math.min(positions.end.indexN, numerators.length - 1),
        indexD: Math.min(positions.end.indexD, denominators.length - 1),
        orderN: positions.end.orderN || null,
        orderD: positions.end.orderD || null,
      };
    }
  }

  // 3) Restore RBG cache
  context.rbgState = { ...(snapshot.stochastic.rbg || {}) };

  console.log(
    `✅ Restored scene snapshot v${snapshot.v}: ${
      Object.keys(snapshot.program).length
    } params, HRG for [${Object.keys(snapshot.stochastic.hrg).join(",")}]`,
  );
}

/**
 * Convert resolved parameters to worklet envelope payload
 * @param {Object} resolved - Resolved parameters
 * @param {Object} context - Synth context
 * @param {number} portamentoMs - Portamento time in milliseconds
 * @returns {Object} - Envelope payload
 */
export function toEnvPayload(resolved, context, portamentoMs = 0) {
  const payload = {};

  for (const [param, config] of Object.entries(context.programConfig || {})) {
    if (!resolved.hasOwnProperty(param)) continue;

    if (config.interpolation === "step") {
      payload[param] = {
        interpolation: "step",
        startValue: resolved[param].startValue || resolved[param],
        endValue: resolved[param].startValue || resolved[param],
        portamentoMs: portamentoMs, // Always explicit
      };
    } else if (config.interpolation === "cosine") {
      payload[param] = {
        interpolation: "cosine",
        startValue: resolved[param].startValue,
        endValue: resolved[param].endValue,
        portamentoMs: portamentoMs, // Always explicit
      };
    }
  }

  return payload;
}

/**
 * Load scene with proper paused vs playing behavior
 * @param {Object} snapshot - Scene snapshot
 * @param {Object} context - Synth context
 */
export function loadScene(snapshot, context) {
  if (!snapshot) {
    console.warn("⚠️ No snapshot to load");
    return;
  }

  // Restore state
  restoreSceneSnapshot(snapshot, context);

  // Resolve targets from restored state
  const resolved = context._resolveProgram(context.programConfig);

  if (!context.voiceNode) {
    console.error("❌ Voice worklet not ready for scene load");
    return;
  }

  if (context.isPlaying) {
    // Playing: stage for EOC snap (no portamento)
    const payload = toEnvPayload(resolved, context, 0);
    context._pendingSceneAtEoc = payload;
    context.reresolveAtNextEOC = false; // Explicitly not re-resolving
    console.log("📋 Scene staged for EOC boundary snap");
  } else {
    // Paused: glide with portamento
    const portMs = context.elements?.portamentoTime
      ? parseInt(context.elements.portamentoTime.value, 10)
      : 100;
    const payload = toEnvPayload(resolved, context, portMs);
    context.voiceNode.port.postMessage({
      type: "SET_ALL_ENV",
      v: 1,
      params: payload,
    });
    console.log(`⚡ Scene loaded with ${portMs}ms portamento (paused)`);
  }
}

/**
 * Handle load scene message
 * @param {Object} payload - Load scene payload
 * @param {Object} context - Synth context
 */
export function handleLoadScene(payload, context) {
  const { memoryLocation, program } = payload;

  // Check if we have a saved snapshot in memory first
  const saved = context.sceneSnapshots[memoryLocation];

  // Only update program config if we don't have saved state
  // (If we have saved state, we want to keep using the config that was active when we saved)
  if (!saved) {
    context.programConfig = {};
    for (const paramName in program) {
      if (
        !["type", "timestamp", "synthesisActive", "isManualMode"].includes(
          paramName,
        )
      ) {
        context.programConfig[paramName] = program[paramName];
      }
    }
  }

  if (saved) {
    const { snapshot, sequences } = saved;

    console.log(
      `[SCENE] load from memory slot ${memoryLocation}, snapshotKeys:`,
      Object.keys(snapshot),
      `hasHRG:`,
      Object.keys(sequences).length > 0,
    );

    // Initialize HRG state - but only for params without saved sequences
    for (const paramName in context.programConfig) {
      if (sequences[paramName]) {
        // Use saved sequence data to restore complete HRG state
        context._restoreHRGState(
          paramName,
          sequences[paramName],
          context.programConfig[paramName],
        );

        // Detailed frequency HRG state logging
        if (paramName === "frequency") {
          const hrgState = context.hrgState[paramName]?.start;
          console.log(
            `[LOAD_SCENE] frequency HRG state - behavior: ${hrgState.numeratorBehavior}/${hrgState.denominatorBehavior}, index: ${hrgState.indexN}/${hrgState.indexD}, arrays: [${
              hrgState.numerators?.slice(0, 3).join(",")
            }...] / [${hrgState.denominators?.slice(0, 3).join(",")}...]`,
          );
        }
      } else {
        // No saved sequence - initialize fresh with per-synth randomization
        context._initializeHRGState(paramName, context.programConfig[paramName]);
      }
    }

    // Handle scalar values - apply immediately if paused, stage if playing
    if (Object.keys(snapshot).length > 0) {
      if (context.isPlaying) {
        // Playing: stage for next EOC
        context.pendingSceneState = snapshot;
        console.log(`📋 Staged scene snapshot for next EOC:`, snapshot);
      } else {
        // Paused: apply immediately with portamento
        console.log(
          `⚡ Applying scene snapshot immediately (paused):`,
          snapshot,
        );
        for (const [param, value] of Object.entries(snapshot)) {
          // Use portamento for smooth transitions when paused
          const portamentoTime = 100; // Default portamento time
          context.applyWithPortamento(param, value, portamentoTime);
        }
      }
    }
  } else {
    console.log(
      `[SCENE] load, no data in memory slot ${memoryLocation} - initializing fresh`,
    );
    // No saved scene - initialize fresh HRG state with per-synth randomization
    for (const paramName in context.programConfig) {
      context._initializeHRGState(paramName, context.programConfig[paramName]);
    }
  }
}

/**
 * Clear all scene banks
 * @param {Object} context - Synth context
 */
export function clearAllBanks(context) {
  // Clear all in-memory scene snapshots
  const clearedCount = context.sceneSnapshots.filter((s) => s).length;
  context.sceneSnapshots = [];
  console.log(`🧹 Cleared ${clearedCount} synth scene bank(s) from memory`);
}

/**
 * Clear specific scene bank
 * @param {number} memoryLocation - Memory bank to clear
 * @param {Object} context - Synth context
 */
export function clearBank(memoryLocation, context) {
  if (context.sceneSnapshots[memoryLocation]) {
    context.sceneSnapshots[memoryLocation] = null;
    console.log(`🧹 Cleared synth scene bank ${memoryLocation} from memory`);
  } else {
    console.log(`⚠️ Scene bank ${memoryLocation} was already empty`);
  }
}

/**
 * Apply pending scene state at EOC
 * @param {Object} context - Synth context
 */
export function applyPendingScene(context) {
  if (context._pendingSceneAtEoc) {
    context.voiceNode.port.postMessage({
      type: "SET_ALL_ENV",
      v: 1,
      params: context._pendingSceneAtEoc,
    });
    
    console.log("🎬 Applied pending scene at EOC");
    context._pendingSceneAtEoc = null;
  }
}