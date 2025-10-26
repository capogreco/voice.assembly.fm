// @ts-check

/**
 * Phasor scheduling helper for Voice.Assembly.FM Synth
 * Schedules AudioParam automation for phasor synchronization
 */

/**
 * Schedule a phasor ramp using AudioParam automation
 * @param {Object} context - Synth context with phasorWorklet and audioContext
 * @param {Object} schedule - Schedule parameters
 * @param {number} schedule.startTime - Start time in controller's AudioContext time
 * @param {number} schedule.cycleLength - Duration of one cycle in seconds
 * @param {number} schedule.phase - Starting phase (0-1)
 * @param {number} [latencyOffset] - Optional latency compensation in seconds
 */
export function schedulePhasorRamp(context, schedule, latencyOffset = 0) {
  if (!context.phasorWorklet) {
    console.warn("⚠️ Cannot schedule phasor: worklet not ready");
    return;
  }

  const phaseParam = context.phasorWorklet.parameters.get("phase");
  if (!phaseParam) {
    console.warn("⚠️ Cannot schedule phasor: phase parameter not found");
    return;
  }

  // Convert controller time to local audio context time
  // Account for any clock drift and network latency
  const localStartTime = schedule.startTime - latencyOffset;
  const { currentTime } = context.audioContext;

  // If the start time is in the past, adjust to start immediately
  const effectiveStartTime = Math.max(localStartTime, currentTime);

  // Calculate end phase (start + 1 full cycle)
  const endPhase = schedule.phase + 1;
  const endTime = effectiveStartTime + schedule.cycleLength;

  // Cancel any existing automation
  phaseParam.cancelScheduledValues(effectiveStartTime);

  // Schedule the ramp for this cycle only
  phaseParam.setValueAtTime(schedule.phase, effectiveStartTime);
  phaseParam.linearRampToValueAtTime(endPhase, endTime);

  console.log(
    `📐 Scheduled phasor ramp: phase ${schedule.phase.toFixed(3)} @ t=${
      effectiveStartTime.toFixed(3)
    } → ${endPhase.toFixed(3)} @ t=${
      endTime.toFixed(3)
    } (${schedule.cycleLength}s cycle)`,
  );
}

/**
 * Schedule immediate phasor jump (for scrubbing)
 * @param {Object} context - Synth context
 * @param {number} targetPhase - Target phase to jump to (0-1)
 */
export function schedulePhasorJump(context, targetPhase) {
  if (!context.phasorWorklet) {
    console.warn("⚠️ Cannot jump phasor: worklet not ready");
    return;
  }

  const phaseParam = context.phasorWorklet.parameters.get("phase");
  if (!phaseParam) {
    console.warn("⚠️ Cannot jump phasor: phase parameter not found");
    return;
  }

  const currentTime = context.audioContext.currentTime;

  // Cancel existing automation and set immediate value
  phaseParam.cancelScheduledValues(currentTime);
  phaseParam.setValueAtTime(targetPhase, currentTime);

  console.log(
    `⏩ Phasor jump to ${targetPhase.toFixed(3)} @ t=${currentTime.toFixed(3)}`,
  );
}

/**
 * Stop phasor automation (for pause/stop)
 * @param {Object} context - Synth context
 */
export function cancelPhasorAutomation(context) {
  if (!context.phasorWorklet) {
    return;
  }

  const phaseParam = context.phasorWorklet.parameters.get("phase");
  if (!phaseParam) {
    return;
  }

  const currentTime = context.audioContext.currentTime;

  // Cancel all future automation and hold current value
  phaseParam.cancelScheduledValues(currentTime);
  const currentPhase = phaseParam.value;
  phaseParam.setValueAtTime(currentPhase, currentTime);

  console.log(
    `⏸️ Phasor automation cancelled at phase ${currentPhase.toFixed(3)}`,
  );
}

/**
 * Estimate latency between controller and synth
 * @param {Object} context - Synth context with RTT measurements
 * @returns {number} Estimated latency in seconds
 */
export function estimateControllerLatency(context) {
  // Use RTT/2 as a basic estimate
  const rttMs = context.lastRTT || 0;
  const networkLatency = rttMs / 2000; // Convert to seconds

  // Add audio context base latency
  const audioLatency = context.audioContext.baseLatency || 0;

  return networkLatency + audioLatency;
}
