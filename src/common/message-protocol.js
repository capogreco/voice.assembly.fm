/**
 * Message Protocol for Voice.Assembly.FM
 * Defines message types and validation for network communication
 * Updated: Added MUSICAL_PARAMETERS support - v2024.1
 */

export const MessageTypes = {
  // WebRTC Signaling
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE_CANDIDATE: 'ice-candidate',
  
  // Network Coordination
  PING: 'ping',
  PONG: 'pong',
  
  // Parameter Control
  MUSICAL_PARAMETERS: 'musical-parameters',
  
  // Timing Control
  PHASOR_SYNC: 'phasor-sync',
  
  // System Control
  CALIBRATION_MODE: 'calibration-mode',
  SYNTH_READY: 'synth-ready'
};

export class MessageBuilder {
  static ping(timestamp = performance.now()) {
    return {
      type: MessageTypes.PING,
      timestamp,
      id: Math.random().toString(36).substring(2)
    };
  }

  static pong(pingId, pingTimestamp, timestamp = performance.now()) {
    return {
      type: MessageTypes.PONG,
      pingId,
      pingTimestamp,
      timestamp
    };
  }


  static musicalParameters(params) {
    return {
      type: MessageTypes.MUSICAL_PARAMETERS,
      frequency: params.frequency,
      zingMorph: params.zingMorph,
      zingAmount: params.zingAmount,
      vowelX: params.vowelX,
      vowelY: params.vowelY,
      symmetry: params.symmetry,
      amplitude: params.amplitude,
      isManualMode: params.isManualMode,
      timestamp: performance.now()
    };
  }

  static phasorSync(phasor, bpm, beatsPerCycle, cycleLength) {
    return {
      type: MessageTypes.PHASOR_SYNC,
      phasor,
      bpm,
      beatsPerCycle,
      cycleLength,
      timestamp: performance.now()
    };
  }

  static calibrationMode(enabled, amplitude = 0.1) {
    return {
      type: MessageTypes.CALIBRATION_MODE,
      enabled,
      amplitude,
      timestamp: performance.now()
    };
  }

  static synthReady() {
    return {
      type: MessageTypes.SYNTH_READY,
      timestamp: performance.now()
    };
  }
}

export function validateMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new Error('Message must be an object');
  }

  if (!message.type || typeof message.type !== 'string') {
    throw new Error('Message must have a type field');
  }

  if (!Object.values(MessageTypes).includes(message.type)) {
    throw new Error(`Unknown message type: ${message.type}`);
  }

  // Type-specific validation
  switch (message.type) {
    case MessageTypes.PING:
      if (typeof message.timestamp !== 'number') {
        throw new Error('Ping message must have numeric timestamp');
      }
      break;

    case MessageTypes.PONG:
      if (typeof message.pingId !== 'string' || 
          typeof message.pingTimestamp !== 'number' ||
          typeof message.timestamp !== 'number') {
        throw new Error('Pong message missing required fields');
      }
      break;

    case MessageTypes.MUSICAL_PARAMETERS:
      if (typeof message.frequency !== 'number') {
        throw new Error('Musical parameters message missing frequency');
      }
      break;

    case MessageTypes.PHASOR_SYNC:
      if (typeof message.phasor !== 'number' || 
          typeof message.bpm !== 'number' ||
          typeof message.beatsPerCycle !== 'number' ||
          typeof message.cycleLength !== 'number') {
        throw new Error('Phasor sync message missing required numeric fields');
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

