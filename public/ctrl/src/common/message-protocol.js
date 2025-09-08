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
  LEADER_ELECTION: 'leader-election',
  LEADER_ANNOUNCEMENT: 'leader-announcement',
  
  // Timing Synchronization
  PHASOR_SYNC: 'phasor-sync',
  CYCLE_START: 'cycle-start',
  
  // Parameter Control
  PARAMETER_UPDATE: 'parameter-update',
  ENVELOPE_UPDATE: 'envelope-update',
  MUSICAL_PARAMETERS: 'musical-parameters',
  
  // System Control
  CALIBRATION_MODE: 'calibration-mode',
  SYSTEM_STATUS: 'system-status'
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

  static leaderElection(peerId, averageRTT, score) {
    return {
      type: MessageTypes.LEADER_ELECTION,
      peerId,
      averageRTT,
      score,
      timestamp: performance.now()
    };
  }

  static leaderAnnouncement(leaderId) {
    return {
      type: MessageTypes.LEADER_ANNOUNCEMENT,
      leaderId,
      timestamp: performance.now()
    };
  }

  static phasorSync(phasor, cycleFreq, audioTime) {
    return {
      type: MessageTypes.PHASOR_SYNC,
      phasor,
      cycleFreq,
      audioTime,
      timestamp: performance.now()
    };
  }

  static parameterUpdate(synthId, parameters, envelopes) {
    return {
      type: MessageTypes.PARAMETER_UPDATE,
      synthId,
      parameters,
      envelopes,
      timestamp: performance.now()
    };
  }

  static musicalParameters(params) {
    console.log('🎵 Building musical parameters message'); // Temporary debug log
    return {
      type: MessageTypes.MUSICAL_PARAMETERS,
      frequency: params.frequency,
      zingMorph: params.zingMorph,
      zingAmount: params.zingAmount,
      vowelX: params.vowelX,
      vowelY: params.vowelY,
      symmetry: params.symmetry,
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

    case MessageTypes.PHASOR_SYNC:
      if (typeof message.phasor !== 'number' ||
          typeof message.cycleFreq !== 'number' ||
          typeof message.audioTime !== 'number') {
        throw new Error('Phasor sync message missing required numeric fields');
      }
      break;

    case MessageTypes.PARAMETER_UPDATE:
      if (!message.synthId || !message.parameters) {
        throw new Error('Parameter update message missing required fields');
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

/**
 * Calculate clock offset using NTP-style algorithm
 */
export function calculateClockOffset(pongMessage, currentTime = performance.now()) {
  const t0 = pongMessage.pingTimestamp;  // local send time
  const t1 = pongMessage.timestamp;      // remote receive time  
  const t2 = pongMessage.timestamp;      // remote send time (same for pong)
  const t3 = currentTime;                // local receive time

  const rtt = (t3 - t0);
  const offset = t1 - t0 - rtt/2;
  
  return { rtt, offset };
}