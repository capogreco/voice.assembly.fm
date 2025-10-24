/**
 * Scene management helpers for Voice.Assembly.FM Synth Client
 */

import {
  buildResolvedFromSnapshot,
  resolveProgramSnapshot,
} from "./resolve.js";

// Helper for deep cloning
function deepClone(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (obj instanceof Array) return obj.map((item) => deepClone(item));
  const cloned = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone(obj[key]);
    }
  }
  return cloned;
}

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

  const rbg = deepClone(context.rbgState || {});

  return {
    v: 2,
    program,
    stochastic: { hrg, rbg },
    // No resolved values - will recompute on load
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
  for (
    const [param, positions] of Object.entries(snapshot.stochastic?.hrg || {})
  ) {
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
  // Resolved values are now stored directly in snapshot.resolved
  // No need to restore old cache fields
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
// buildResolvedFromCache removed - using buildResolvedFromSnapshot from resolve.js instead
/**
 * Apply a snapshot to the synth, honouring paused vs playing transport.
 * @param {SceneSnapshotV2} snapshot
 * @param {any} context
 * @param {number|null} [portamentoNorm] - Portamento time normalized 0-1
 */
export function loadScene(snapshot, context, portamentoNorm = null) {
  if (!snapshot) {
    console.warn("⚠️ loadScene called without snapshot");
    return;
  }

  restoreSceneSnapshot(snapshot, context);

  // Always recompute from generator state with PEEK mode to preserve indices
  const resolved = resolveProgramSnapshot({
    programConfig: context.programConfig,
    hrgState: context.hrgState,
    rbgState: context.rbgState,
    isCosInterp: context.isCosInterp.bind(context),
    resolveHRG: (param, pos) => context.peekHRGValue(param, pos), // Always peek on load
    resolveRBG: context._resolveRBG.bind(context),
  });

  // Diagnostic logging for generator state
  const freqHrg = context.hrgState?.frequency;
  if (freqHrg?.start) {
    console.log(
      `📥 load scene: frequency HRG start = [${freqHrg.start.indexN}] ${
        freqHrg.start.numerators?.[freqHrg.start.indexN]
      }/${freqHrg.start.denominators?.[freqHrg.start.indexD]}`,
    );
  }
  if (freqHrg?.end) {
    console.log(
      `📥 load scene: frequency HRG end = [${freqHrg.end.indexN}] ${
        freqHrg.end.numerators?.[freqHrg.end.indexN]
      }/${freqHrg.end.denominators?.[freqHrg.end.indexD]}`,
    );
  }

  // Log the computed values
  const freqResolved = resolved.frequency;
  console.log(
    `📥 computed frequency values =`,
    freqResolved?.startValue,
    freqResolved?.endValue,
  );

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
    // Log exact payload being sent
    console.log("➡️ SET_ALL_ENV (loadScene)", Object.fromEntries(
      Object.entries(envPayload).map(([param, cfg]) => [
        param,
        { start: cfg.startValue, end: cfg.endValue, interp: cfg.interpolation }
      ])
    ));
    
    context.voiceNode?.port.postMessage({
      type: "SET_ALL_ENV",
      v: 1,
      params: envPayload,
    });
    console.log(
      `⚡ Scene loaded immediately with ${portamentoMs}ms portamento`,
    );
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
  // CRITICAL: Always use saved arrays if they exist, never regenerate
  // If arrays are missing, this is a fallback - but should rarely happen
  const numerators = serialized.numerators?.length
    ? [...serialized.numerators]
    : parseSequence(generator?.numerators || "1");
  const denominators = serialized.denominators?.length
    ? [...serialized.denominators]
    : parseSequence(generator?.denominators || "1");
  
  console.log(
    `🔍 deserializeHRG: nums=[${numerators}], denoms=[${denominators}], indexN=${serialized.indexN}, indexD=${serialized.indexD}`
  );

  const clamp = (value, arr) =>
    Math.max(0, Math.min(value ?? 0, arr.length - 1));

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

// deepClone already defined above

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

  // Log exact payload being sent
  console.log("➡️ SET_ALL_ENV (applyPending)", Object.fromEntries(
    Object.entries(context._pendingSceneAtEoc).map(([param, cfg]) => [
      param,
      { start: cfg.startValue, end: cfg.endValue, interp: cfg.interpolation }
    ])
  ));
  
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
