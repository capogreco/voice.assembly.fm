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
  SYNTH_PARAMS: "synth-params",
  PROGRAM_UPDATE: "program-update",
  DIRECT_PARAM_UPDATE: "direct-param-update",

  // Timing Control
  PHASOR_SYNC: "phasor-sync",

  // System Control
  CALIBRATION_MODE: "calibration-mode",
  SYNTH_READY: "synth-ready",
  PROGRAM: "program",
  RESEED_RANDOMIZATION: "reseed-randomization",

  // Scene Memory
  SAVE_SCENE: "save-scene",
  LOAD_SCENE: "load-scene",
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
      synthesisActive: params.synthesisActive,
      timestamp: performance.now(),
    };
  }

  static phasorSync(phasor, cpm, stepsPerCycle, cycleLength) {
    return {
      type: MessageTypes.PHASOR_SYNC,
      phasor,
      cpm,
      stepsPerCycle,
      cycleLength,
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

  static reseedRandomization() {
    return {
      type: MessageTypes.RESEED_RANDOMIZATION,
      timestamp: performance.now(),
    };
  }

  static directParamUpdate(paramName, value) {
    return {
      type: MessageTypes.DIRECT_PARAM_UPDATE,
      param: paramName,
      value: value,
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

  static loadScene(memoryLocation, program) {
    return {
      type: MessageTypes.LOAD_SCENE,
      memoryLocation,
      program,
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

    case MessageTypes.SYNTH_PARAMS:
      validateSynthParameters(message);
      break;

    case MessageTypes.PROGRAM_UPDATE:
      // Program updates can have any parameter structure
      break;

    case MessageTypes.PHASOR_SYNC:
      if (
        typeof message.phasor !== "number" ||
        typeof message.cpm !== "number" ||
        typeof message.stepsPerCycle !== "number" ||
        typeof message.cycleLength !== "number"
      ) {
        throw new Error("Phasor sync message missing required numeric fields");
      }
      break;

    case MessageTypes.PROGRAM:
      if (!message.config || typeof message.config !== "object") {
        throw new Error("Program message must have config object");
      }
      break;

    case MessageTypes.RESEED_RANDOMIZATION:
      // No required fields; used to trigger stochastic re-resolution
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
  }

  return true;
}

/**
 * Validates a synth parameters message against the new, canonical format.
 * No backward compatibility.
 */
function validateSynthParameters(message) {
  // --- START NEW, STRICT VALIDATION LOGIC ---

  // A synth parameters message must have a frequency property.
  if (message.frequency === undefined) {
    throw new Error("Synth parameters message must have a frequency property.");
  }

  // Iterate over all own properties of the message that are parameters.
  for (const paramName of Object.keys(message)) {
    // Skip non-parameter properties.
    if (
      ["type", "timestamp", "synthesisActive", "isManualMode"].includes(
        paramName,
      )
    ) continue;

    const paramState = message[paramName];

    // Every parameter must be a number (direct) or an object (program).
    if (typeof paramState !== "number" && typeof paramState !== "object") {
      throw new Error(
        `Parameter '${paramName}' has invalid type. Must be number or object.`,
      );
    }

    if (typeof paramState === "object" && paramState !== null) {
      // If it's an object, it MUST be a programmatic parameter.
      if (!paramState.isProgrammatic) {
        throw new Error(
          `Parameter '${paramName}' is an object but is missing 'isProgrammatic' flag.`,
        );
      }

      // It must have a valid interpolation type.
      if (
        !paramState.interpolation ||
        typeof paramState.interpolation !== "string"
      ) {
        throw new Error(
          `Programmatic parameter '${paramName}' has invalid interpolation.`,
        );
      }

      // It must have a start generator.
      if (typeof paramState.startValueGenerator !== "object") {
        throw new Error(
          `Programmatic parameter '${paramName}' is missing a valid startValueGenerator.`,
        );
      }

      // If it's not step interpolation, it must have an end generator.
      if (
        paramState.interpolation !== "step" &&
        typeof paramState.endValueGenerator !== "object"
      ) {
        throw new Error(
          `Non-step parameter '${paramName}' is missing an endValueGenerator.`,
        );
      }
    }
  }
  // --- END NEW, STRICT VALIDATION LOGIC ---
}

/**
 * Calculate round-trip time from ping/pong messages
 */
export function calculateRTT(pongMessage, currentTime = performance.now()) {
  return currentTime - pongMessage.pingTimestamp;
}
