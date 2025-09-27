/**
 * ProgramWorklet - Simple Multi-Channel Envelope Generator
 * Outputs constant values (step) and cosine envelopes driven by main thread
 * Phase-driven cosine envelopes: 0.5 - cos(phase * π) * 0.5
 */

class ProgramWorklet extends AudioWorkletProcessor {
  constructor() {
    super();

    // Phase tracking for sample-accurate envelope generation
    this.lastPhase = 0;

    // Output parameter mapping (8 channels)
    this.parameterOutputs = {
      frequency: 0,
      zingMorph: 1,
      zingAmount: 2,
      vowelX: 3,
      vowelY: 4,
      symmetry: 5,
      amplitude: 6,
      whiteNoise: 7,
    };

    // Current parameter values for outputs
    this.currentValues = {
      frequency: 440,
      zingMorph: 0,
      zingAmount: 0,
      vowelX: 0.5,
      vowelY: 0.5,
      symmetry: 0.5,
      amplitude: 0.1,
      whiteNoise: 0,
    };

    // Values set by main thread per cycle
    this.stepValues = {}; // Constant values for step parameters
    this.cosSegments = {}; // { param: { start, end } } for cosine envelopes

    this.port.onmessage = this.handleMessage.bind(this);
  }

  handleMessage(event) {
    const message = event.data;

    switch (message.type) {
      case "SET_STEP_VALUES":
        this.stepValues = message.params || {};
        break;

      case "SET_COS_SEGMENTS":
        this.cosSegments = message.params || {};
        break;

      case "SET_DIRECT_VALUE":
        // Legacy support for direct value updates
        if (Object.hasOwn(this.currentValues, message.param)) {
          this.currentValues[message.param] = message.value;
        }
        break;

      case "SET_INTERPOLATED_VALUE":
        // Set a parameter to a specific interpolated value from current phase
        if (message.param && Number.isFinite(message.value)) {
          this.currentValues[message.param] = message.value;
          // Remove from step and cos segments so it uses the direct value
          delete this.stepValues[message.param];
          delete this.cosSegments[message.param];
        }
        break;
    }
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0];
    const blockSize = output[0].length;
    const phaseValues = parameters.phase; // Read the phase AudioParam

    // Debug: Check if we have 8 output channels
    if (output.length !== 8) {
      console.error(
        `❌ Program worklet: Expected 8 output channels, got ${output.length}`,
      );
    }

    for (let i = 0; i < blockSize; i++) {
      // Read current phase from AudioParam (sample-accurate)
      const currentPhase = phaseValues.length > 1
        ? phaseValues[i]
        : phaseValues[0];

      // Update last phase for potential future use
      this.lastPhase = currentPhase;

      // Output parameter values on separate channels
      for (const [paramName, outputIndex] of Object.entries(this.parameterOutputs)) {
        if (output[outputIndex]) {
          let value;

          if (paramName in this.cosSegments) {
            // Cosine envelope: 0.5 - cos(phase * π) * 0.5
            const segment = this.cosSegments[paramName];
            const shapedProgress = 0.5 - Math.cos(currentPhase * Math.PI) * 0.5;
            value = segment.start + (segment.end - segment.start) * shapedProgress;
          } else if (paramName in this.stepValues) {
            // Constant step value
            value = this.stepValues[paramName];
          } else {
            // Hold last current value
            value = this.currentValues[paramName];
          }

          output[outputIndex][i] = value;
          this.currentValues[paramName] = value;
        }
      }
    }

    return true;
  }

  static get parameterDescriptors() {
    return [
      {
        name: "phase",
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: "a-rate", // Sample-accurate for smooth ramping
      },
    ];
  }
}

registerProcessor("program-worklet", ProgramWorklet);