// @ts-check

/**
 * Network broadcasting utilities for Voice.Assembly.FM Control Client
 */

// JSDoc type imports
/** @typedef {import('../../../src/common/parameter-types.js').IMusicalState} IMusicalState */

// Import message types
import {
  MessageBuilder,
  MessageTypes,
} from "../../../src/common/message-protocol.js";

/**
 * Create wire payload for parameter broadcast
 * @param {IMusicalState} musicalState - Current musical state
 * @param {boolean} synthesisActive - Synthesis active flag
 * @param {number} [portamentoTime] - Portamento time in ms
 * @returns {Object} - Wire payload
 */
export function createWirePayload(musicalState, synthesisActive, portamentoTime = null) {
  const wirePayload = {
    synthesisActive: synthesisActive,
  };

  if (portamentoTime !== null) {
    wirePayload.portamentoTime = portamentoTime;
  }

  // Convert each parameter to wire format
  Object.keys(musicalState).forEach((paramName) => {
    const paramState = musicalState[paramName];
    
    if ("scope" in paramState) {
      throw new Error(
        "CRITICAL: Parameter '" + paramName + "' has forbidden 'scope' field",
      );
    }

    // Create deep copies to avoid mutation
    const startGen = { ...paramState.startValueGenerator };
    let endGen = undefined;
    
    if ((paramState.interpolation === "disc" || paramState.interpolation === "cont") && paramState.endValueGenerator) {
      endGen = { ...paramState.endValueGenerator };
    }

    wirePayload[paramName] = {
      interpolation: paramState.interpolation,
      startValueGenerator: startGen,
      endValueGenerator: endGen,
      baseValue: paramState.baseValue,
    };
  });

  return wirePayload;
}

/**
 * Broadcast full musical parameters
 * @param {Object} star - WebRTC star instance
 * @param {IMusicalState} musicalState - Current musical state
 * @param {boolean} synthesisActive - Synthesis active flag
 * @param {function} logFn - Logging function
 * @param {number} [portamentoTime] - Portamento time in ms
 */
export function broadcastMusicalParameters(star, musicalState, synthesisActive, logFn, portamentoTime) {
  if (!star) return;

  const wirePayload = createWirePayload(musicalState, synthesisActive, portamentoTime);
  console.log("Broadcasting translated payload:", wirePayload);

  const message = MessageBuilder.createParameterUpdate(
    MessageTypes.PROGRAM_UPDATE,
    wirePayload,
  );
  
  star.broadcast(message);
  logFn("Sent full program update to synths", "debug");
}

/**
 * Broadcast single parameter update
 * @param {Object} star - WebRTC star instance
 * @param {string} paramName - Parameter name
 * @param {IMusicalState} musicalState - Current musical state
 * @param {boolean} synthesisActive - Synthesis active flag
 * @param {function} logFn - Logging function
 * @param {number} [portamentoTime] - Portamento time in ms
 */
export function broadcastSingleParameter(star, paramName, musicalState, synthesisActive, logFn, portamentoTime) {
  if (!star) return;

  const paramState = musicalState[paramName];
  if ("scope" in paramState) {
    throw new Error(
      "CRITICAL: Parameter '" + paramName + "' has forbidden 'scope' field",
    );
  }

  const wirePayload = {
    synthesisActive: synthesisActive,
  };

  if (portamentoTime !== null && portamentoTime !== undefined) {
    wirePayload.portamentoTime = portamentoTime;
  }

  // Emit unified format with interpolation + generators
  const startGen = { ...paramState.startValueGenerator };
  let endGen = undefined;
  
  if ((paramState.interpolation === "disc" || paramState.interpolation === "cont") && paramState.endValueGenerator) {
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
  
  star.broadcast(message);
  logFn("Sent single parameter (" + paramName + ") to synths", "debug");
}

/**
 * Broadcast sub-parameter update
 * @param {Object} star - WebRTC star instance
 * @param {string} paramPath - Parameter path (e.g., "frequency.baseValue")
 * @param {any} value - New value
 * @param {number} portamentoTime - Portamento time in ms
 * @param {function} logFn - Logging function
 */
export function broadcastSubParameterUpdate(star, paramPath, value, portamentoTime, logFn) {
  if (!star) return;

  const message = MessageBuilder.createParameterUpdate(
    MessageTypes.SUB_PARAM_UPDATE,
    {
      paramPath: paramPath,
      value: value,
      portamentoTime: portamentoTime,
    },
  );
  
  star.broadcast(message);
  logFn("Sent sub-parameter update: " + paramPath + " = " + value, "debug");
}

/**
 * Broadcast phasor sync message
 * @param {Object} star - WebRTC star instance
 * @param {number} phasor - Current phasor value
 * @param {number} stepsPerCycle - Steps per cycle
 * @param {number} cycleLength - Cycle length
 * @param {boolean} isPlaying - Playing state
 * @param {string} reason - Reason for broadcast
 * @param {number} currentTime - Current time
 * @param {number} lastPausedBeaconAt - Last paused beacon time
 * @returns {number} - Updated last paused beacon time
 */
export function broadcastPhasor(star, phasor, stepsPerCycle, cycleLength, isPlaying, reason, currentTime, lastPausedBeaconAt) {
  if (!star) return lastPausedBeaconAt;

  // EOC-only broadcasting: only send at specific events, not continuously
  if (reason === "continuous") {
    // Send paused heartbeat at 1 Hz when not playing
    if (!isPlaying) {
      const timeSinceLastHeartbeat = currentTime - lastPausedBeaconAt;
      if (timeSinceLastHeartbeat >= 1.0) { // 1 Hz heartbeat
        const message = MessageBuilder.phasorSync(
          phasor,
          null, // cpm omitted (legacy)
          stepsPerCycle,
          cycleLength,
          isPlaying, // false when paused
        );

        star.broadcastToType("synth", message, "sync");
        return currentTime; // Updated lastPausedBeaconAt
      }
    }
    return lastPausedBeaconAt; // No continuous broadcasts while playing
  }

  // Send beacon for specific events (step, EOC, bootstrap, transport changes)
  const message = MessageBuilder.phasorSync(
    phasor,
    null, // cpm omitted (legacy)
    stepsPerCycle,
    cycleLength,
    isPlaying,
  );

  const sent = star.broadcastToType("synth", message, "sync");
  console.log("Phasor broadcast (" + reason + "): " + phasor.toFixed(3) + " to " + sent + " synths");
  
  return lastPausedBeaconAt;
}

/**
 * Send scene save command to synths
 * @param {Object} star - WebRTC star instance
 * @param {number} memoryLocation - Memory location (1-8)
 * @param {Object} sceneData - Scene data to save
 * @param {function} logFn - Logging function
 */
export function broadcastSceneSave(star, memoryLocation, sceneData, logFn) {
  if (!star) return;

  const message = MessageBuilder.sceneCommand("save", memoryLocation, sceneData);
  const sent = star.broadcastToType("synth", message);
  logFn("Scene save command sent to " + sent + " synths", "success");
}

/**
 * Send scene load command to synths
 * @param {Object} star - WebRTC star instance
 * @param {number} memoryLocation - Memory location (1-8)
 * @param {function} logFn - Logging function
 */
export function broadcastSceneLoad(star, memoryLocation, logFn) {
  if (!star) return;

  const message = MessageBuilder.sceneCommand("load", memoryLocation, null);
  const sent = star.broadcastToType("synth", message);
  logFn("Scene load command sent to " + sent + " synths", "success");
}

/**
 * Send scene clear command to synths
 * @param {Object} star - WebRTC star instance
 * @param {number} memoryLocation - Memory location (1-8)
 * @param {function} logFn - Logging function
 */
export function broadcastSceneClear(star, memoryLocation, logFn) {
  if (!star) return;

  const message = MessageBuilder.sceneCommand("clear", memoryLocation, null);
  const sent = star.broadcastToType("synth", message);
  logFn("Scene clear command sent to " + sent + " synths", "success");
}

/**
 * Send re-resolve command to all synths
 * @param {Object} star - WebRTC star instance
 * @param {function} logFn - Logging function
 */
export function broadcastReResolve(star, logFn) {
  if (!star) {
    console.error("No WebRTC star available for re-resolve");
    return;
  }

  const message = MessageBuilder.createGeneral("re-resolve", {
    timestamp: Date.now(),
  });
  
  const sent = star.broadcastToType("synth", message);
  console.log("Re-resolve message sent to " + sent + " synths");
  logFn("Re-resolve sent to " + sent + " synths", "info");
}