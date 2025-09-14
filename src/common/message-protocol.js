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
  SCHEDULE_PARAMETER_UPDATE: 'schedule-parameter-update',
  
  // Timing Control
  PHASOR_SYNC: 'phasor-sync',
  
  // System Control
  CALIBRATION_MODE: 'calibration-mode',
  SYNTH_READY: 'synth-ready',
  RANDOMIZATION_CONFIG: 'randomization-config'
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

  static scheduleParameterUpdate(params) {
    return {
      type: MessageTypes.SCHEDULE_PARAMETER_UPDATE,
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

  static phasorSync(phasor, cpm, stepsPerCycle, cycleLength) {
    return {
      type: MessageTypes.PHASOR_SYNC,
      phasor,
      cpm,
      stepsPerCycle,
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

  static randomizationConfig(config) {
    return {
      type: MessageTypes.RANDOMIZATION_CONFIG,
      config,
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
      // Validate that frequency exists and is either a number (static) or envelope object
      if (!message.frequency || 
          (typeof message.frequency !== 'number' && typeof message.frequency !== 'object')) {
        throw new Error('Musical parameters message missing or invalid frequency');
      }
      
      // Validate envelope object structure if frequency is an object
      if (typeof message.frequency === 'object') {
        if (typeof message.frequency.intensity !== 'number' ||
            typeof message.frequency.envType !== 'string') {
          throw new Error('Musical parameters frequency envelope object missing required fields');
        }
        
        // Validate startValue (can be number or range object)
        if (typeof message.frequency.startValue === 'object') {
          if (typeof message.frequency.startValue.min !== 'number' ||
              typeof message.frequency.startValue.max !== 'number') {
            throw new Error('Musical parameters frequency startValue range missing min/max');
          }
        } else if (typeof message.frequency.startValue !== 'number') {
          throw new Error('Musical parameters frequency startValue must be number or range object');
        }
        
        // Validate endValue (can be number or range object)
        if (typeof message.frequency.endValue === 'object') {
          if (typeof message.frequency.endValue.min !== 'number' ||
              typeof message.frequency.endValue.max !== 'number') {
            throw new Error('Musical parameters frequency endValue range missing min/max');
          }
        } else if (typeof message.frequency.endValue !== 'number') {
          throw new Error('Musical parameters frequency endValue must be number or range object');
        }
      }
      break;

    case MessageTypes.PHASOR_SYNC:
      if (typeof message.phasor !== 'number' || 
          typeof message.cpm !== 'number' ||
          typeof message.stepsPerCycle !== 'number' ||
          typeof message.cycleLength !== 'number') {
        throw new Error('Phasor sync message missing required numeric fields');
      }
      break;

    case MessageTypes.RANDOMIZATION_CONFIG:
      if (!message.config || typeof message.config !== 'object') {
        throw new Error('Randomization config message must have config object');
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

