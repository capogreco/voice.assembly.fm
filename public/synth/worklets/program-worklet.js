/**
 * ProgramWorklet - Timing and Control Logic
 * Handles master phasor, EOC detection, envelope generation
 * Outputs control signals for VoiceWorklet parameters
 */

class ProgramWorklet extends AudioWorkletProcessor {
  constructor() {
    super();

    // Phase tracking for EOC detection (driven by AudioParam)
    this.lastPhase = 0;

    // Program state
    this.programState = null;
    this.envelopes = new Map();
    this.programCounters = new Map(); // Track indices for behavior sequences
    this.shuffledSequences = new Map(); // Store shuffled sequences
    this.lastProgramConfig = new Map(); // Detect config changes

    // Program staging for EOC application
    this.pendingProgramState = null;
    this.programDirty = false;

    // Output parameter mapping
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

    this.port.onmessage = this.handleMessage.bind(this);

    // Per-synth identity (for optional deterministic behavior) and caches
    this.synthId = "unknown";
    this.staticSelections = new Map(); // key -> index
  }

  handleMessage(event) {
    const message = event.data;

    switch (message.type) {
      case "SET_PROGRAM":
        if (message.synthId) {
          this.synthId = message.synthId;
        }
        this.pendingProgramState = message.config;
        this.programDirty = true;
        // Do NOT call initializeEnvelopes() here - defer to EOC
        break;

      case "SET_DIRECT_VALUE":
        if (Object.hasOwn(this.currentValues, message.param)) {
          this.currentValues[message.param] = message.value;
        }
        break;

      case "RESEED_RANDOMIZATION":
        // Clear caches so next EOC regenerates selections
        this.staticSelections.clear();
        this.programCounters.clear();
        this.shuffledSequences.clear();
        break;

      case "RESTORE_SEQUENCES":
        for (const [param, seq] of Object.entries(message.sequences || {})) {
          this.programCounters.set(`${param}_start_numerator`, seq.numeratorIndex);
          this.programCounters.set(`${param}_start_denominator`, seq.denominatorIndex);
          if (seq.numeratorShuffle) {
            this.shuffledSequences.set(`${param}_start_numerator_sequence`, seq.numeratorShuffle);
          }
          if (seq.denominatorShuffle) {
            this.shuffledSequences.set(`${param}_start_denominator_sequence`, seq.denominatorShuffle);
          }
        }
        break;
    }
  }

  // Deterministic helper (kept for potential future needs)
  _stableIndex(key, length) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = (hash +
        ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) +
          (hash << 24))) >>> 0;
    }
    if (length <= 0) return 0;
    return hash % length;
  }

  initializeEnvelopes() {
    if (!this.programState) return;

    this.envelopes.clear();

    for (const [paramName, paramState] of Object.entries(this.programState)) {
      if (typeof paramState === "object" && paramState.interpolationType) {
        if (paramState.interpolationType !== "step") {
          this.envelopes.set(paramName, {
            startValue: this.generateValue(
              paramState.startValueGenerator,
              paramName,
            ),
            endValue: this.generateValue(
              paramState.endValueGenerator,
              paramName,
            ),
            currentValue: 0,
            active: false,
            interpolationType: paramState.interpolationType || "cosine",
          });
        } else if (paramState.interpolationType === "step") {
          this.currentValues[paramName] = this.generateValue(
            paramState.startValueGenerator,
            paramName,
          );
        }
      }
    }
  }

  /**
   * Parse SIN (Simple Integer Notation) strings like "1,3,5" or "1-6"
   */
  parseSIN(sinString) {
    if (!sinString || typeof sinString !== "string") return [1];

    const results = [];
    const parts = sinString.split(",");

    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.includes("-")) {
        // Handle ranges like "1-6"
        const [start, end] = trimmed.split("-").map((n) => parseInt(n.trim()));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            results.push(i);
          }
        }
      } else {
        // Handle single numbers
        const num = parseInt(trimmed);
        if (!isNaN(num)) results.push(num);
      }
    }

    return results.length > 0 ? results : [1];
  }

  _shuffleArray(array) {
    const shuffled = [...array]; // Create a copy
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  _selectValue(part, paramName, behavior, values) {
    const counterKey = `${paramName}_${part}`;
    const sequenceKey = `${paramName}_${part}_sequence`;
    const lastConfigKey = `${paramName}_${part}_config`;

    // Detect if values changed - reset shuffle if so
    const currentConfigString = values.join(",");
    if (this.lastProgramConfig.get(lastConfigKey) !== currentConfigString) {
      this.shuffledSequences.delete(sequenceKey);
      this.lastProgramConfig.set(lastConfigKey, currentConfigString);
    }

    // Initialize counter if needed
    if (!this.programCounters.has(counterKey)) {
      // Randomize starting offset for ascending/descending; 0 for others
      if (behavior === "ascending" || behavior === "descending") {
        const startIdx = values.length > 0
          ? Math.floor(Math.random() * values.length)
          : 0;
        this.programCounters.set(counterKey, startIdx);
      } else {
        this.programCounters.set(counterKey, 0);
      }
    }
    const index = this.programCounters.get(counterKey);

    switch (behavior) {
      case "static": {
        // Choose a per-synth random value, stable until reseed or program change
        const currentConfigString = JSON.stringify(values);
        const key =
          `${this.synthId}|${paramName}|${part}|${currentConfigString}`;
        if (!this.staticSelections.has(key)) {
          const idx = values.length > 0
            ? Math.floor(Math.random() * values.length)
            : 0;
          this.staticSelections.set(key, idx);
        }
        const idx = this.staticSelections.get(key) || 0;
        return values[idx];
      }

      case "ascending": {
        const ascValue = values[index % values.length];
        this.programCounters.set(counterKey, index + 1);
        return ascValue;
      }

      case "descending": {
        const descValue = values[(values.length - 1 - index) % values.length];
        this.programCounters.set(counterKey, index + 1);
        return descValue;
      }

      case "random": {
        return values[Math.floor(Math.random() * values.length)];
      }

      case "shuffle": {
        // Create shuffled sequence if not exists
        if (!this.shuffledSequences.has(sequenceKey)) {
          const newShuffledSequence = this._shuffleArray(values);
          this.shuffledSequences.set(sequenceKey, newShuffledSequence);
        }

        const sequence = this.shuffledSequences.get(sequenceKey);
        const shuffleValue = sequence[index % sequence.length];
        this.programCounters.set(counterKey, index + 1);
        return shuffleValue;
      }

      default:
        return values[0];
    }
  }

  generateValue(generator, paramName) {
    if (!generator) return 0;

    switch (generator.type) {
      case "periodic": {
        // Parse numerators and denominators
        const numerators = this.parseSIN(generator.numerators || "1");
        const denominators = this.parseSIN(generator.denominators || "1");
        const numeratorBehavior = generator.numeratorBehavior || "static";
        const denominatorBehavior = generator.denominatorBehavior || "static";
        const baseValue = generator.baseValue || 440;

        // Use the new helper method for both numerator and denominator selection
        const selectedNumerator = this._selectValue(
          "numerator",
          paramName,
          numeratorBehavior,
          numerators,
        );
        const selectedDenominator = this._selectValue(
          "denominator",
          paramName,
          denominatorBehavior,
          denominators,
        ) || 1;

        const ratio = selectedNumerator / selectedDenominator;

        return baseValue * ratio;
      }

      case "normalised": {
        // Handle normalised (RBG) generators
        if (typeof generator.range === "number") {
          return generator.range;
        } else if (generator.range && typeof generator.range === "object") {
          const range = generator.range.max - generator.range.min;
          return generator.range.min + (Math.random() * range);
        }
        return Math.random() * 0.5; // Default range
      }

      default: {
        return generator.value || 0;
      }
    }
  }

  detectEOC(currentPhase, lastPhase) {
    return currentPhase < lastPhase;
  }

  updateEnvelopes() {
    for (const [paramName, envelope] of this.envelopes) {
      if (envelope.active) {
        const rawProgress = this.lastPhase; // Use the phase read from AudioParam
        let shapedProgress = rawProgress;

        // Apply interpolation curve
        switch (envelope.interpolationType) {
          case "cosine":
            shapedProgress = 0.5 - Math.cos(rawProgress * Math.PI) * 0.5;
            break;
          default:
            // Fallback for safety
            shapedProgress = rawProgress;
        }

        envelope.currentValue = envelope.startValue +
          (envelope.endValue - envelope.startValue) * shapedProgress;
        this.currentValues[paramName] = envelope.currentValue;
      }
    }
  }

  triggerEnvelopes() {
    if (!this.programState) return;

    for (const [paramName, paramState] of Object.entries(this.programState)) {
      if (
        typeof paramState === "object" &&
        paramState.interpolationType && paramState.interpolationType !== "step"
      ) {
        const envelope = this.envelopes.get(paramName);
        if (envelope) {
          envelope.startValue = this.generateValue(
            paramState.startValueGenerator,
            paramName,
          );
          envelope.endValue = this.generateValue(
            paramState.endValueGenerator,
            paramName,
          );
          envelope.interpolationType = paramState.interpolationType || "cosine";
          envelope.active = true;
        }
      } else if (
        typeof paramState === "object" &&
        paramState.interpolationType === "step"
      ) {
        this.currentValues[paramName] = this.generateValue(
          paramState.startValueGenerator,
          paramName,
        );
      }
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

      // Detect EOC by comparing with last phase
      const eoc = this.detectEOC(currentPhase, this.lastPhase);
      this.lastPhase = currentPhase;

      if (eoc) {
        // Apply pending program changes at cycle boundary
        if (this.programDirty && this.pendingProgramState) {
          this.programState = this.pendingProgramState;
          this.pendingProgramState = null;
          this.programDirty = false;
          
          // Clear all caches for fresh generation
          this.staticSelections.clear();
          this.programCounters.clear();
          this.shuffledSequences.clear();
          
          // Reinitialize envelopes with new program
          this.initializeEnvelopes();
        }
        
        // EOC detected - trigger envelope updates
        this.triggerEnvelopes();
        
        // Report step values and sequence positions at EOC
        const report = { type: 'EOC_REPORT', values: {}, sequences: {} };

        for (const [param, state] of Object.entries(this.programState || {})) {
          if (state.interpolationType === "step") {
            report.values[param] = this.currentValues[param];
            
            // Save sequence positions for HRG
            if (state.startValueGenerator?.type === "periodic") {
              const numeratorKey = `${param}_start_numerator`;
              const denominatorKey = `${param}_start_denominator`;
              
              // Get the actual indices used (counter was incremented after use)
              const numCounter = this.programCounters.get(numeratorKey) || 0;
              const denCounter = this.programCounters.get(denominatorKey) || 0;

              // For behaviors that increment, report the index that was used
              const numBehavior = state.startValueGenerator?.numeratorBehavior || "static";
              const denBehavior = state.startValueGenerator?.denominatorBehavior || "static";

              const numerators = this.parseSIN(state.startValueGenerator?.numerators || "1");
              const denominators = this.parseSIN(state.startValueGenerator?.denominators || "1");

              let numIndex = numCounter;
              let denIndex = denCounter;

              // Adjust for behaviors that increment after use
              if (numBehavior === "ascending" || numBehavior === "descending" || numBehavior === "shuffle") {
                numIndex = numCounter > 0 ? (numCounter - 1) % numerators.length : 0;
              }
              if (denBehavior === "ascending" || denBehavior === "descending" || denBehavior === "shuffle") {
                denIndex = denCounter > 0 ? (denCounter - 1) % denominators.length : 0;
              }
              
              report.sequences[param] = {
                numeratorIndex: numIndex,
                denominatorIndex: denIndex,
                numeratorShuffle: this.shuffledSequences.get(`${numeratorKey}_sequence`),
                denominatorShuffle: this.shuffledSequences.get(`${denominatorKey}_sequence`)
              };
            }
          }
        }

        this.port.postMessage(report);
      }

      // Update envelopes using current phase as progress
      this.updateEnvelopes();

      // Output current parameter values on separate channels
      for (
        const [paramName, outputIndex] of Object.entries(this.parameterOutputs)
      ) {
        if (output[outputIndex]) {
          output[outputIndex][i] = this.currentValues[paramName];
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
