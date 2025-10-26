/**
 * Phasor AudioWorklet Processor
 * Generates sample-accurate phasor (0.0 to 1.0 sawtooth) for timing synchronization
 * Now driven by AudioParam automation instead of accumulator
 */

class PhasorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "phase",
        defaultValue: 0.0,
        minValue: 0.0,
        maxValue: 1.0,
        automationRate: "a-rate", // Audio-rate for sample-accurate automation
      },
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

    // Previous phase for edge detection
    this.prevPhase = 0.0;

    // Step tracking for rhythmic events
    this.lastStep = -1;
    this.currentStep = 0;

    // Listen for messages from main thread (minimal now)
    this.port.onmessage = (event) => {
      const { type } = event.data;

      // Most control is now via AudioParam automation
      // Keep minimal message handling for debugging/status
      switch (type) {
        case "status":
          // Report current state if needed
          this.port.postMessage({
            type: "status-response",
            phase: this.prevPhase,
          });
          break;
      }
    };

    // Send phasor updates back to main thread periodically
    this.updateCounter = 0;
    this.updateInterval = 64; // Send update every 64 samples (~1.3ms at 48kHz) for smoother display
  }

  onStepTrigger(stepNumber, stepsPerCycle, phase) {
    // Send step trigger event to main thread
    this.port.postMessage({
      type: "step-trigger",
      step: stepNumber,
      stepsPerCycle: stepsPerCycle,
      phase: phase,
    });
  }

  process(_inputs, outputs, parameters) {
    const bufferSize = outputs[0][0].length;
    const cycleLength = parameters.cycleLength[0];
    const stepsPerCycle = parameters.stepsPerCycle[0];
    const enableRhythm = parameters.enableRhythm[0] > 0.5;

    // Get phase AudioParam values (a-rate, so one per sample)
    const phaseValues = parameters.phase;

    for (let i = 0; i < bufferSize; i++) {
      // Get current phase from AudioParam
      const currentPhase = phaseValues.length > 1
        ? phaseValues[i]
        : phaseValues[0];

      // Apply modulo to keep in [0, 1) range
      const wrappedPhase = ((currentPhase % 1) + 1) % 1;

      // Output wrapped phase
      if (outputs[0][0]) {
        outputs[0][0][i] = wrappedPhase;
      }

      // Detect cycle boundary (phase wrap from near 1 to near 0)
      if (this.prevPhase > 0.9 && wrappedPhase < 0.1) {
        console.log(
          `🔄 CYCLE BOUNDARY: ${this.prevPhase.toFixed(6)} → ${
            wrappedPhase.toFixed(6)
          } at sample ${i}/${bufferSize}`,
        );

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
        this.currentStep = Math.floor(wrappedPhase * stepsPerCycle);

        // Trigger on step boundary
        if (this.currentStep !== this.lastStep) {
          this.onStepTrigger(this.currentStep, stepsPerCycle, wrappedPhase);
          this.lastStep = this.currentStep;
        }
      }

      // Store for next iteration
      this.prevPhase = wrappedPhase;
    }

    // Periodically send phasor value back to main thread for display
    this.updateCounter += bufferSize;
    if (this.updateCounter >= this.updateInterval) {
      this.port.postMessage({
        type: "phasor-update",
        phase: this.prevPhase,
        cycleLength: cycleLength,
      });
      this.updateCounter = 0;
    }

    return true;
  }
}

registerProcessor("phasor-processor", PhasorProcessor);
