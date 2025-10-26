/**
 * Message Protocol for Voice.Assembly.FM
 * Defines message types and validation for network communication
 * Updated: Added MUSICAL_PARAMETERS support - v2024.1
 */

export const MessageTypes = {
  // WebRTC Signaling
  OFFER: "offer",
  ANSWER: "answer",
  ICE_CANDIDATE: "ice-candidate",

  // Network Coordination
  PING: "ping",
  PONG: "pong",

  // Parameter Control
  PROGRAM_UPDATE: "program-update",
  SUB_PARAM_UPDATE: "sub-param-update",
  UNIFIED_PARAM_UPDATE: "unified-param-update",
  PARAM_APPLIED: "param-applied",

  // Timing Control
  PHASOR_BEACON: "phasor-beacon",
  JUMP_TO_EOC: "jump-to-eoc",

  // New Transport Commands
  PLAY: "play",
  PAUSE: "pause",
  STOP: "stop",
  SCRUB_PHASE: "scrub-phase",

  // System Control
  CALIBRATION_MODE: "calibration-mode",
  SYNTH_READY: "synth-ready",
  PROGRAM: "program",

  // Worklet Control (obsolete message types removed - now using SET_ENV/SET_ALL_ENV)
  RERESOLVE_AT_EOC: "reresolve-at-eoc",
  IMMEDIATE_REINITIALIZE: "immediate-reinitialize",

  // Scene Memory
  SAVE_SCENE: "save-scene",
  LOAD_SCENE: "load-scene",
  CLEAR_BANKS: "clear-banks",
  CLEAR_SCENE: "clear-scene",
};

export class MessageBuilder {
  static ping(timestamp = performance.now()) {
    return {
      type: MessageTypes.PING,
      timestamp,
      id: Math.random().toString(36).substring(2),
    };
  }

  static pong(pingId, pingTimestamp, timestamp = performance.now()) {
    return {
      type: MessageTypes.PONG,
      pingId,
      pingTimestamp,
      timestamp,
    };
  }

  static createParameterUpdate(type, params) {
    return {
      type,
      frequency: params.frequency,
      zingMorph: params.zingMorph,
      zingAmount: params.zingAmount,
      vowelX: params.vowelX,
      vowelY: params.vowelY,
      symmetry: params.symmetry,
      amplitude: params.amplitude,
      whiteNoise: params.whiteNoise,
      vibratoWidth: params.vibratoWidth,
      vibratoRate: params.vibratoRate,
      synthesisActive: params.synthesisActive,
      portamentoTime: params.portamentoTime,
      timestamp: performance.now(),
    };
  }

  static jumpToEOC() {
    return {
      type: MessageTypes.JUMP_TO_EOC,
      timestamp: performance.now(),
    };
  }

  static calibrationMode(enabled, amplitude = 0.1) {
    return {
      type: MessageTypes.CALIBRATION_MODE,
      enabled,
      amplitude,
      timestamp: performance.now(),
    };
  }

  static synthReady() {
    return {
      type: MessageTypes.SYNTH_READY,
      timestamp: performance.now(),
    };
  }

  static program(config) {
    return {
      type: MessageTypes.PROGRAM,
      config,
      timestamp: performance.now(),
    };
  }

  // setStepValues and setCosSegments removed - use SET_ENV/SET_ALL_ENV instead
  // restoreSequenceState removed - obsolete message type

  static reresolveAtEOC() {
    return {
      type: MessageTypes.RERESOLVE_AT_EOC,
      timestamp: performance.now(),
    };
  }

  static immediateReinitialize(portamento) {
    return {
      type: MessageTypes.IMMEDIATE_REINITIALIZE,
      portamento,
      timestamp: performance.now(),
    };
  }

  static saveScene(memoryLocation) {
    return {
      type: MessageTypes.SAVE_SCENE,
      memoryLocation,
      timestamp: performance.now(),
    };
  }

  static loadScene(
    memoryLocation,
    program,
    snapshot = null,
    portamento = null,
  ) {
    return {
      type: MessageTypes.LOAD_SCENE,
      memoryLocation,
      program,
      snapshot,
      portamento,
      timestamp: performance.now(),
    };
  }

  static clearBanks() {
    return {
      type: MessageTypes.CLEAR_BANKS,
      timestamp: performance.now(),
    };
  }

  static clearScene(memoryLocation) {
    return {
      type: MessageTypes.CLEAR_SCENE,
      memoryLocation,
      timestamp: performance.now(),
    };
  }

  static subParamUpdate(paramPath, value, portamentoTime) {
    return {
      type: MessageTypes.SUB_PARAM_UPDATE,
      paramPath,
      value,
      portamentoTime,
      timestamp: performance.now(),
    };
  }

  static unifiedParamUpdate(
    param,
    startValue,
    endValue,
    interpolation,
    isPlaying,
    portamentoTime,
    currentPhase,
  ) {
    return {
      type: MessageTypes.UNIFIED_PARAM_UPDATE,
      param,
      startValue,
      endValue,
      interpolation,
      isPlaying,
      portamentoTime,
      currentPhase,
      timestamp: performance.now(),
    };
  }

  // New Transport Commands
  static play(phase, startTime) {
    return {
      type: MessageTypes.PLAY,
      phase,
      startTime,
      timestamp: performance.now(),
    };
  }

  static pause(phase) {
    return {
      type: MessageTypes.PAUSE,
      phase,
      timestamp: performance.now(),
    };
  }

  static stop() {
    return {
      type: MessageTypes.STOP,
      timestamp: performance.now(),
    };
  }

  static phasorBeacon(startTime, cycleLength, phase = 0, stepsPerCycle = null) {
    return {
      type: MessageTypes.PHASOR_BEACON,
      startTime,
      cycleLength,
      phase,
      stepsPerCycle,
      timestamp: performance.now(),
    };
  }

  static scrubPhase(phase, portamentoMs) {
    return {
      type: MessageTypes.SCRUB_PHASE,
      phase,
      portamentoMs,
      timestamp: performance.now(),
    };
  }
}

export function validateMessage(message) {
  if (!message || typeof message !== "object") {
    throw new Error("Message must be an object");
  }

  if (!message.type || typeof message.type !== "string") {
    throw new Error("Message must have a type field");
  }

  if (!Object.values(MessageTypes).includes(message.type)) {
    throw new Error(`Unknown message type: ${message.type}`);
  }

  // Type-specific validation
  switch (message.type) {
    case MessageTypes.PING:
      if (typeof message.timestamp !== "number") {
        throw new Error("Ping message must have numeric timestamp");
      }
      break;

    case MessageTypes.PONG:
      if (
        typeof message.pingId !== "string" ||
        typeof message.pingTimestamp !== "number" ||
        typeof message.timestamp !== "number"
      ) {
        throw new Error("Pong message missing required fields");
      }
      break;

    case MessageTypes.PROGRAM_UPDATE:
      // Enforce unified parameter structure - no scope field allowed
      for (const [key, value] of Object.entries(message)) {
        if (
          [
            "type",
            "timestamp",
            "synthesisActive",
            "isManualMode",
            "portamentoTime",
          ].includes(key)
        ) {
          continue; // Skip non-parameter fields
        }

        if (value && typeof value === "object") {
          // Check for forbidden scope field
          if ("scope" in value) {
            throw new Error(
              `BREAKING: Parameter '${key}' contains forbidden 'scope' field. Use interpolation + generators instead.`,
            );
          }

          // Validate unified parameter structure
          if (
            !value.interpolation ||
            !["step", "disc", "cont"].includes(value.interpolation)
          ) {
            throw new Error(
              `Parameter '${key}' must have interpolation: 'step', 'disc', or 'cont'`,
            );
          }

          if (
            !value.startValueGenerator ||
            typeof value.startValueGenerator !== "object"
          ) {
            throw new Error(`Parameter '${key}' must have startValueGenerator`);
          }

          if (
            value.interpolation === "cosine" &&
            (!value.endValueGenerator ||
              typeof value.endValueGenerator !== "object")
          ) {
            throw new Error(
              `Parameter '${key}' with cosine interpolation must have endValueGenerator`,
            );
          }

          // For periodic generators, require baseValue
          if (
            value.startValueGenerator.type === "periodic" &&
            value.baseValue === undefined
          ) {
            throw new Error(
              `Parameter '${key}' with periodic generator must have baseValue`,
            );
          }
        }
      }
      break;

    case MessageTypes.JUMP_TO_EOC:
      // No additional fields required
      break;

    case MessageTypes.PROGRAM:
      if (!message.config || typeof message.config !== "object") {
        throw new Error("Program message must have config object");
      }
      break;

    // SET_STEP_VALUES, SET_COS_SEGMENTS, and RESTORE_SEQUENCE_STATE validation removed - obsolete message types

    case MessageTypes.RERESOLVE_AT_EOC:
      // No required fields - simple trigger message
      break;

    case MessageTypes.IMMEDIATE_REINITIALIZE:
      // No required fields - simple trigger message
      break;

    case MessageTypes.SAVE_SCENE:
      if (
        typeof message.memoryLocation !== "number" ||
        message.memoryLocation < 0 || message.memoryLocation > 9
      ) {
        throw new Error("Save scene message requires memoryLocation (0-9)");
      }
      break;

    case MessageTypes.LOAD_SCENE:
      if (
        typeof message.memoryLocation !== "number" ||
        message.memoryLocation < 0 || message.memoryLocation > 9 ||
        !message.program || typeof message.program !== "object"
      ) {
        throw new Error(
          "Load scene message requires memoryLocation (0-9) and program object",
        );
      }
      break;

    case MessageTypes.CLEAR_BANKS:
      // No required fields
      break;

    case MessageTypes.CLEAR_SCENE:
      if (
        typeof message.memoryLocation !== "number" ||
        message.memoryLocation < 0 || message.memoryLocation > 9
      ) {
        throw new Error("Clear scene message requires memoryLocation (0-9)");
      }
      break;

    case MessageTypes.SUB_PARAM_UPDATE:
      if (
        typeof message.paramPath !== "string" ||
        message.value === undefined ||
        typeof message.portamentoTime !== "number"
      ) {
        throw new Error(
          "Sub param update message missing required fields: paramPath, value, portamentoTime",
        );
      }
      // Validate paramPath format (param.subparam or param.subparam.subsubparam)
      if (
        !/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(
          message.paramPath,
        )
      ) {
        throw new Error(`Invalid paramPath format: ${message.paramPath}`);
      }
      break;

    case MessageTypes.UNIFIED_PARAM_UPDATE:
      if (
        typeof message.param !== "string" ||
        typeof message.startValue !== "number" ||
        (message.endValue !== undefined &&
          typeof message.endValue !== "number") ||
        typeof message.interpolation !== "string" ||
        typeof message.isPlaying !== "boolean" ||
        typeof message.portamentoTime !== "number" ||
        typeof message.currentPhase !== "number"
      ) {
        throw new Error("Unified param update message missing required fields");
      }
      break;

    case MessageTypes.PHASOR_BEACON:
      if (
        typeof message.startTime !== "number" ||
        typeof message.cycleLength !== "number" ||
        typeof message.phase !== "number"
      ) {
        throw new Error(
          "PHASOR_BEACON missing required fields: startTime, cycleLength, phase",
        );
      }
      if (message.phase < 0 || message.phase >= 1) {
        throw new Error("PHASOR_BEACON phase must be in range [0, 1)");
      }
      if (
        message.stepsPerCycle !== undefined &&
        message.stepsPerCycle !== null
      ) {
        if (typeof message.stepsPerCycle !== "number") {
          throw new Error(
            "PHASOR_BEACON stepsPerCycle must be a number if set",
          );
        }
        if (message.stepsPerCycle <= 0) {
          throw new Error("PHASOR_BEACON stepsPerCycle must be positive");
        }
      }
      break;

    case MessageTypes.SCRUB_PHASE:
      if (
        typeof message.phase !== "number" ||
        typeof message.portamentoMs !== "number"
      ) {
        throw new Error(
          "SCRUB_PHASE missing required fields: phase, portamentoMs",
        );
      }
      if (message.phase < 0 || message.phase > 1) {
        throw new Error("SCRUB_PHASE phase must be in range [0, 1]");
      }
      if (message.portamentoMs < 0) {
        throw new Error("SCRUB_PHASE portamentoMs must be non-negative");
      }
      break;
  }

  return true;
}

/**
 * Calculate round-trip time from ping/pong messages
 */
export function calculateRTT(pongMessage, currentTime = performance.now()) {
  return currentTime - pongMessage.pingTimestamp;
}
