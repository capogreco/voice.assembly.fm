/**
 * Phasor AudioWorklet Processor
 * Generates sample-accurate phasor (0.0 to 1.0 sawtooth) for timing synchronization
 */

class PhasorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "cycleLength",
        defaultValue: 2.0,
        minValue: 0.1,
        maxValue: 300.0, // 5 minutes for slow cycles
        automationRate: "k-rate",
      },
      {
        name: "stepsPerCycle",
        defaultValue: 16,
        minValue: 1,
        maxValue: 64,
        automationRate: "k-rate",
      },
      {
        name: "enableRhythm",
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();

    // Phasor state
    this.phase = 0.0;
    this.isRunning = false;

    // Step tracking for rhythmic events
    this.lastStep = -1;
    this.currentStep = 0;

    // Listen for messages from main thread
    this.port.onmessage = (event) => {
      const { type, ...params } = event.data;

      switch (type) {
        case "start":
          this.isRunning = true;
          break;

        case "stop":
          this.isRunning = false;
          break;

        case "reset":
          this.phase = 0.0;
          break;

        case "set-phase":
          this.phase = params.phase;
          break;

        case "phase-correction":
          this.applyPhaseCorrection(
            params.targetPhase,
            params.correctionFactor,
          );
          break;
      }
    };

    // Send phasor updates back to main thread periodically
    this.updateCounter = 0;
    this.updateInterval = 128; // Send update every 128 samples (~2.7ms at 48kHz)
  }

  applyPhaseCorrection(targetPhase, correctionFactor = 0.1) {
    // Calculate phase error (accounting for wrap-around)
    let phaseError = targetPhase - this.phase;

    // Handle wrap-around cases
    if (phaseError > 0.5) {
      phaseError -= 1.0; // Target is behind, we're ahead
    } else if (phaseError < -0.5) {
      phaseError += 1.0; // Target is ahead, we're behind
    }

    // Apply gentle correction (PLL behavior)
    const correction = phaseError * correctionFactor;
    this.phase += correction;

    // Ensure phase stays in [0, 1) range
    if (this.phase >= 1.0) {
      this.phase -= 1.0;
    } else if (this.phase < 0.0) {
      this.phase += 1.0;
    }
  }

  onStepTrigger(stepNumber, stepsPerCycle) {
    // Send step trigger event to main thread
    this.port.postMessage({
      type: "step-trigger",
      step: stepNumber,
      stepsPerCycle: stepsPerCycle,
      phase: this.phase,
    });
  }

  process(_inputs, outputs, parameters) {
    const bufferSize = outputs[0][0].length;
    const cycleLength = parameters.cycleLength[0];
    const stepsPerCycle = parameters.stepsPerCycle[0];
    const enableRhythm = parameters.enableRhythm[0] > 0.5;

    if (!this.isRunning) {
      return true;
    }

    // Calculate phase increment per sample
    const phaseIncrement = 1.0 / (cycleLength * sampleRate);

    for (let i = 0; i < bufferSize; i++) {
      // Update phase
      this.phase += phaseIncrement;

      // Wrap around at 1.0 and send cycle reset
      if (this.phase >= 1.0) {
        this.phase -= 1.0;

        // Send cycle reset message immediately
        this.port.postMessage({
          type: "cycle-reset",
          sampleIndex: i,
          blockSize: bufferSize,
          cycleLength: cycleLength,
        });
      }

      // Step boundary detection
      if (enableRhythm) {
        this.currentStep = Math.floor(this.phase * stepsPerCycle);

        // Trigger on step boundary
        if (this.currentStep !== this.lastStep) {
          this.onStepTrigger(this.currentStep, stepsPerCycle);
          this.lastStep = this.currentStep;
        }
      }

      // Output phasor (optional - can be used for audio-rate modulation)
      if (outputs[0][0]) {
        outputs[0][0][i] = this.phase;
      }
    }

    // Periodically send phasor value back to main thread
    this.updateCounter += bufferSize;
    if (this.updateCounter >= this.updateInterval) {
      this.port.postMessage({
        type: "phasor-update",
        phase: this.phase,
        cycleLength: cycleLength,
      });
      this.updateCounter = 0;
    }

    return true;
  }
}

registerProcessor("phasor-processor", PhasorProcessor);
