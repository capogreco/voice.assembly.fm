/**
 * Timing and Synchronization Mathematics for Voice.Assembly.FM
 * High-precision timing calculations for distributed audio
 */

/**
 * Exponential Moving Average for clock offset filtering
 */
export class ClockFilter {
  constructor(smoothingFactor = 0.1) {
    this.alpha = smoothingFactor;
    this.offset = 0;
    this.rtt = 0;
    this.initialized = false;
  }

  update(newOffset, newRTT) {
    if (!this.initialized) {
      this.offset = newOffset;
      this.rtt = newRTT;
      this.initialized = true;
    } else {
      this.offset = this.alpha * newOffset + (1 - this.alpha) * this.offset;
      this.rtt = this.alpha * newRTT + (1 - this.alpha) * this.rtt;
    }
  }

  getEstimate() {
    return {
      offset: this.offset,
      rtt: this.rtt,
      confidence: this.initialized ? Math.min(1.0, Math.abs(this.alpha * 10)) : 0
    };
  }
}

/**
 * Phasor synchronization with drift compensation
 */
export class PhasorSync {
  constructor() {
    this.localPhasor = 0;
    this.cycleFreq = 0.5; // Default: 2-second cycles
    this.lastUpdateTime = 0;
    this.driftRate = 0; // Estimated local clock drift rate
    this.clockFilter = new ClockFilter(0.1);
  }

  /**
   * Update from master phasor sync message
   */
  updateFromMaster(masterPhasor, cycleFreq, audioTime, currentTime = performance.now()) {
    // Calculate how much time has passed since the message was created
    const messageAge = (currentTime - audioTime) / 1000; // Convert to seconds
    
    // Estimate where the master phasor should be now
    const estimatedMasterPhasor = (masterPhasor + cycleFreq * messageAge) % 1.0;
    
    // Calculate phasor difference
    const phasorDiff = this.calculatePhasorDifference(estimatedMasterPhasor, this.localPhasor);
    
    // Apply gentle correction
    const correctionStrength = 0.05; // 5% correction per update
    this.localPhasor = (this.localPhasor + phasorDiff * correctionStrength) % 1.0;
    if (this.localPhasor < 0) this.localPhasor += 1.0;
    
    // Update cycle frequency
    this.cycleFreq = cycleFreq;
    this.lastUpdateTime = currentTime;
  }

  /**
   * Calculate the shortest angular distance between two phasors
   */
  calculatePhasorDifference(target, current) {
    const diff = target - current;
    
    // Handle wraparound (choose shortest path around the circle)
    if (diff > 0.5) {
      return diff - 1.0;
    } else if (diff < -0.5) {
      return diff + 1.0;
    }
    return diff;
  }

  /**
   * Update local phasor based on elapsed time
   */
  updateLocal(currentTime = performance.now()) {
    if (this.lastUpdateTime === 0) {
      this.lastUpdateTime = currentTime;
      return this.localPhasor;
    }

    const deltaTime = (currentTime - this.lastUpdateTime) / 1000; // Convert to seconds
    this.localPhasor = (this.localPhasor + this.cycleFreq * deltaTime) % 1.0;
    this.lastUpdateTime = currentTime;
    
    return this.localPhasor;
  }

  /**
   * Get current synchronized phasor position
   */
  getCurrentPhasor(currentTime = performance.now()) {
    return this.updateLocal(currentTime);
  }

  /**
   * Check if we're at a cycle boundary (phasor wrapped around)
   */
  detectCycleStart(threshold = 0.05) {
    const currentPhasor = this.getCurrentPhasor();
    const wasAtEnd = this.localPhasor > (1 - threshold);
    const isAtStart = currentPhasor < threshold;
    
    return wasAtEnd && isAtStart;
  }
}

/**
 * Leader election scoring - lower scores are better (become leader)
 */
export function calculateLeadershipScore(averageRTT, peerCount, stability = 1.0) {
  // Primary factor: network centrality (lower RTT = better)
  const rttScore = averageRTT;
  
  // Secondary factor: connection stability
  const stabilityScore = (1.0 - stability) * 10; // Penalty for instability
  
  // Small random tiebreaker to prevent deterministic ties
  const tiebreaker = Math.random() * 0.1;
  
  return rttScore + stabilityScore + tiebreaker;
}

/**
 * Network health assessment
 */
export class NetworkHealth {
  constructor(windowSize = 20) {
    this.rttHistory = [];
    this.packetLossCount = 0;
    this.totalPackets = 0;
    this.windowSize = windowSize;
  }

  recordRTT(rtt) {
    this.rttHistory.push(rtt);
    this.totalPackets++;
    
    if (this.rttHistory.length > this.windowSize) {
      this.rttHistory.shift();
    }
  }

  recordPacketLoss() {
    this.packetLossCount++;
  }

  getMetrics() {
    if (this.rttHistory.length === 0) {
      return {
        averageRTT: 0,
        rttVariance: 0,
        packetLoss: 0,
        health: 0
      };
    }

    const avgRTT = this.rttHistory.reduce((a, b) => a + b) / this.rttHistory.length;
    const variance = this.rttHistory.reduce((acc, rtt) => acc + Math.pow(rtt - avgRTT, 2), 0) / this.rttHistory.length;
    const packetLoss = this.totalPackets > 0 ? this.packetLossCount / this.totalPackets : 0;
    
    // Health score (0-1, where 1 is perfect)
    const rttHealth = Math.max(0, 1 - avgRTT / 100); // Penalize high RTT
    const jitterHealth = Math.max(0, 1 - Math.sqrt(variance) / 50); // Penalize jitter
    const lossHealth = Math.max(0, 1 - packetLoss * 10); // Heavily penalize packet loss
    
    const overallHealth = (rttHealth + jitterHealth + lossHealth) / 3;

    return {
      averageRTT: avgRTT,
      rttVariance: variance,
      packetLoss: packetLoss,
      health: overallHealth
    };
  }
}

/**
 * Utility functions for high-precision timing
 */
export const TimingUtils = {
  /**
   * Get current time in the most precise format available
   */
  now: () => {
    if (typeof performance !== 'undefined' && performance.now) {
      return performance.now();
    }
    return Date.now();
  },

  /**
   * Sleep with high precision (for testing/calibration)
   */
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

  /**
   * Convert milliseconds to audio samples at given sample rate
   */
  msToSamples: (ms, sampleRate = 48000) => Math.round((ms / 1000) * sampleRate),

  /**
   * Convert audio samples to milliseconds
   */
  samplesToMs: (samples, sampleRate = 48000) => (samples / sampleRate) * 1000,

  /**
   * Quantize timing to nearest sample boundary
   */
  quantizeToSample: (timeMs, sampleRate = 48000) => {
    const samples = TimingUtils.msToSamples(timeMs, sampleRate);
    return TimingUtils.samplesToMs(samples, sampleRate);
  }
};