/**
 * Scene management helpers for Voice.Assembly.FM Synth Client
 */

// ---------------------------------------------------------------------------
// Snapshot creation ---------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Build a complete scene snapshot including minimal recomputation caches.
 * @param {any} context
 * @returns {SceneSnapshotV2}
 */
export function buildSceneSnapshot(context) {
  const program = deepClone(context.programConfig || {});

  const hrg = {};
  for (const [param, state] of Object.entries(context.hrgState || {})) {
    hrg[param] = {};
    if (state.start) {
      hrg[param].start = serializeHRGState(state.start);
    }
    if (state.end) {
      hrg[param].end = serializeHRGState(state.end);
    }
  }

  const caches = {
    lastResolvedHRG: deepClone(context.lastResolvedHRG || {}),
    lastResolvedValues: deepClone(context.lastResolvedValues || {}),
  };

  const rbg = deepClone(context.rbgState || {});

  return {
    v: 2,
    program,
    stochastic: { hrg, rbg },
    caches,
    meta: {
      synthId: context.peerId,
      sampleRate: context.audioContext?.sampleRate || 48000,
      synthesisActive: context.synthesisActive,
      isPlaying: context.isPlaying,
      createdAt: Date.now(),
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot restoration ------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Restore a previously captured scene snapshot into the synth context.
 * @param {SceneSnapshotV2} snapshot
 * @param {any} context
 */
export function restoreSceneSnapshot(snapshot, context) {
  if (!snapshot || snapshot.v !== 2) {
    throw new Error("Unsupported scene snapshot version (expected v2)");
  }

  context.programConfig = deepClone(snapshot.program || {});

  // Restore HRG state (numerators/denominators arrays + indices)
  context.hrgState = {};
  for (const [param, positions] of Object.entries(snapshot.stochastic?.hrg || {})) {
    context.hrgState[param] = {};

    if (positions.start) {
      context.hrgState[param].start = deserializeHRGState(
        positions.start,
        context.programConfig[param]?.startValueGenerator,
      );
    }

    if (positions.end) {
      context.hrgState[param].end = deserializeHRGState(
        positions.end,
        context.programConfig[param]?.endValueGenerator,
      );
    }
  }

  context.rbgState = deepClone(snapshot.stochastic?.rbg || {});
  context.lastResolvedHRG = deepClone(snapshot.caches?.lastResolvedHRG || {});
  context.lastResolvedValues = deepClone(snapshot.caches?.lastResolvedValues || {});
}

// ---------------------------------------------------------------------------
// Scene loading -------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Build resolved envelope values from cached scene data.
 * @param {Record<string, any>} programConfig
 * @param {Record<string, any>} lastResolvedValues
 * @returns {Record<string, {startValue:number,endValue:number,interpolation:string}>}
 */
function buildResolvedFromCache(programConfig, lastResolvedValues) {
  const resolved = {};

  for (const [paramName, cfg] of Object.entries(programConfig || {})) {
    const cached = lastResolvedValues?.[paramName];
    if (!cached) continue;

    const startValue = typeof cached === "number" ? cached : cached.start;
    const endValue = typeof cached === "number"
      ? cached
      : cached.end !== undefined
        ? cached.end
        : cached.start;

    if (startValue === undefined) continue;

    resolved[paramName] = {
      interpolation: cfg.interpolation,
      startValue,
      endValue,
    };
  }

  return resolved;
}

/**
 * Apply a snapshot to the synth, honouring paused vs playing transport.
 * @param {SceneSnapshotV2} snapshot
 * @param {any} context
 */
export function loadScene(snapshot, context, portamentoNorm = null) {
  if (!snapshot) {
    console.warn("⚠️ loadScene called without snapshot");
    return;
  }

  restoreSceneSnapshot(snapshot, context);

  let resolved = buildResolvedFromCache(
    context.programConfig,
    context.lastResolvedValues,
  );

  const missingParams = new Set(
    Object.keys(context.programConfig || {}),
  );
  for (const key of Object.keys(resolved)) missingParams.delete(key);

  if (missingParams.size > 0) {
    console.warn(
      `⚠️ Scene cache missing ${missingParams.size} parameter(s); falling back to resolve`,
    );
    const fallbackResolved = context._resolveProgram(context.programConfig);
    for (const param of missingParams) {
      if (fallbackResolved[param]) {
        resolved[param] = {
          interpolation: fallbackResolved[param].interpolation,
          startValue: fallbackResolved[param].startValue,
          endValue: fallbackResolved[param].endValue,
        };
      }
    }

    // Update caches with fallback values so subsequent edits behave correctly
    for (const param of missingParams) {
      if (!context.lastResolvedValues[param] && resolved[param]) {
        context.lastResolvedValues[param] = {
          start: resolved[param].startValue,
          end: resolved[param].endValue,
        };
      }
    }
  }

  let portamentoMs = 0;
  if (context.isPlaying) {
    portamentoMs = 0;
  } else if (typeof portamentoNorm === "number") {
    portamentoMs = context._mapPortamentoNormToMs(portamentoNorm);
  } else if (context.elements?.portamentoTime) {
    portamentoMs = context._mapPortamentoNormToMs(
      parseFloat(context.elements.portamentoTime.value),
    );
  }

  const envPayload = toEnvPayload(resolved, context, portamentoMs);

  if (context.isPlaying) {
    context._pendingSceneAtEoc = envPayload;
    context.reresolveAtNextEOC = false;
    console.log("📋 Scene staged for EOC boundary snap");
  } else {
    context.voiceNode?.port.postMessage({
      type: "SET_ALL_ENV",
      v: 1,
      params: envPayload,
    });
    console.log(`⚡ Scene loaded immediately with ${portamentoMs}ms portamento`);
  }
}

/**
 * Handle LOAD_SCENE command from controller or other peers.
 * @param {{memoryLocation:number, program?:object, snapshot?:SceneSnapshotV2}} payload
 * @param {any} context
 */
export function handleLoadScene(payload, context) {
  const { memoryLocation, program, snapshot } = payload;

  const storedSnapshot = snapshot || context.sceneSnapshots[memoryLocation];

  if (storedSnapshot) {
    context.sceneSnapshots[memoryLocation] = storedSnapshot;
    const portNorm = payload.portamento ?? null;
    loadScene(storedSnapshot, context, portNorm);
    return;
  }

  if (!program) {
    console.warn(`⚠️ No scene data found for bank ${memoryLocation}`);
    return;
  }

  console.log(
    `[SCENE] Legacy load for bank ${memoryLocation} (no snapshot)`,
  );

  context.programConfig = deepClone(program);
  context.hrgState = {};
  for (const paramName in context.programConfig) {
    context._initializeHRGState(paramName, context.programConfig[paramName]);
  }

  const resolved = context._resolveProgram(context.programConfig);
  const envPayload = toEnvPayload(resolved, context, 0);

  if (context.isPlaying) {
    context._pendingSceneAtEoc = envPayload;
    context.reresolveAtNextEOC = false;
  } else {
    context.voiceNode?.port.postMessage({
      type: "SET_ALL_ENV",
      v: 1,
      params: envPayload,
    });
  }
}

// ---------------------------------------------------------------------------
// Utility helpers -----------------------------------------------------------
// ---------------------------------------------------------------------------

function serializeHRGState(state) {
  return {
    numerators: [...(state.numerators || [])],
    denominators: [...(state.denominators || [])],
    numeratorBehavior: state.numeratorBehavior,
    denominatorBehavior: state.denominatorBehavior,
    indexN: state.indexN ?? 0,
    indexD: state.indexD ?? 0,
    orderN: state.orderN ? [...state.orderN] : null,
    orderD: state.orderD ? [...state.orderD] : null,
  };
}

function deserializeHRGState(serialized, generator) {
  const numerators = serialized.numerators?.length
    ? [...serialized.numerators]
    : parseSequence(generator?.numerators || "1");
  const denominators = serialized.denominators?.length
    ? [...serialized.denominators]
    : parseSequence(generator?.denominators || "1");

  const clamp = (value, arr) => Math.max(0, Math.min(value ?? 0, arr.length - 1));

  return {
    numerators,
    denominators,
    numeratorBehavior: serialized.numeratorBehavior || "static",
    denominatorBehavior: serialized.denominatorBehavior || "static",
    indexN: clamp(serialized.indexN, numerators),
    indexD: clamp(serialized.indexD, denominators),
    orderN: serialized.orderN ? [...serialized.orderN] : null,
    orderD: serialized.orderD ? [...serialized.orderD] : null,
  };
}

function parseSequence(str) {
  return str.split(",").flatMap((part) => {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      const result = [];
      for (let i = start; i <= end; i++) result.push(i);
      return result;
    }
    return [Number(part)];
  });
}

function deepClone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

/**
 * Convert resolved parameter map into worklet envelope payload.
 * @param {Record<string,{startValue:number,endValue:number,interpolation:string}>} resolved
 * @param {any} context
 * @param {number} portamentoMs
 */
export function toEnvPayload(resolved, context, portamentoMs = 0) {
  const payload = {};

  for (const [param, cfg] of Object.entries(context.programConfig || {})) {
    const resolvedParam = resolved[param];
    if (!resolvedParam) continue;

    if (cfg.interpolation === "step") {
      payload[param] = {
        interpolation: "step",
        startValue: resolvedParam.startValue,
        endValue: resolvedParam.startValue,
        portamentoMs,
      };
    } else {
      payload[param] = {
        interpolation: resolvedParam.interpolation || cfg.interpolation,
        startValue: resolvedParam.startValue,
        endValue: resolvedParam.endValue,
        portamentoMs,
      };
    }
  }

  return payload;
}

/**
 * Clear all in-memory scene banks.
 * @param {any} context
 */
export function clearAllBanks(context) {
  const cleared = context.sceneSnapshots.filter(Boolean).length;
  context.sceneSnapshots = [];
  console.log(`🧹 Cleared ${cleared} synth scene bank(s)`);
}

/**
 * Clear a single bank.
 * @param {number} memoryLocation
 * @param {any} context
 */
export function clearBank(memoryLocation, context) {
  if (context.sceneSnapshots[memoryLocation]) {
    context.sceneSnapshots[memoryLocation] = null;
    console.log(`🧹 Cleared synth scene bank ${memoryLocation}`);
  }
}

/**
 * Apply a pending staged scene at EOC.
 * @param {import("../synth-main.js").default} context
 */
export function applyPendingScene(context) {
  if (!context._pendingSceneAtEoc) return;

  context.voiceNode?.port.postMessage({
    type: "SET_ALL_ENV",
    v: 1,
    params: context._pendingSceneAtEoc,
  });
  context._pendingSceneAtEoc = null;
  console.log("🎬 Applied pending scene at EOC");
}

// ---------------------------------------------------------------------------
// Types ---------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * @typedef {ReturnType<typeof buildSceneSnapshot>} SceneSnapshotV2
 */
