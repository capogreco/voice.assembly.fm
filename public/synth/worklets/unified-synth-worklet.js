/**
 * Unified Synth Worklet - Combined Parameter Generation and Audio Synthesis
 *
 * Combines the functionality of program-worklet.js and voice-worklet.js:
 * - Receives phase input and program configurations from main thread
 * - Generates parameter values based on phase and interpolation curves
 * - Handles portamento smoothly within the worklet
 * - Synthesizes audio using formant synthesis (PM + Zing paths)
 * - Reports current parameter values back to main thread
 */

class UnifiedSynthWorklet extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Phase input from phasor worklet
      {
        name: "phase",
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: "a-rate", // Sample-accurate for smooth ramping
      },
      // System control
      {
        name: "active",
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
      // Parameter start values (for step or cosine start)
      { name: "frequency_start", defaultValue: 440, automationRate: "a-rate" },
      { name: "zingMorph_start", defaultValue: 0, automationRate: "a-rate" },
      { name: "zingAmount_start", defaultValue: 0, automationRate: "a-rate" },
      { name: "vowelX_start", defaultValue: 0.5, automationRate: "a-rate" },
      { name: "vowelY_start", defaultValue: 0.5, automationRate: "a-rate" },
      { name: "symmetry_start", defaultValue: 0.5, automationRate: "a-rate" },
      { name: "amplitude_start", defaultValue: 0.1, automationRate: "a-rate" },
      { name: "whiteNoise_start", defaultValue: 0, automationRate: "a-rate" },
      // Parameter end values (for cosine interpolation)
      { name: "frequency_end", defaultValue: 440, automationRate: "a-rate" },
      { name: "zingMorph_end", defaultValue: 0, automationRate: "a-rate" },
      { name: "zingAmount_end", defaultValue: 0, automationRate: "a-rate" },
      { name: "vowelX_end", defaultValue: 0.5, automationRate: "a-rate" },
      { name: "vowelY_end", defaultValue: 0.5, automationRate: "a-rate" },
      { name: "symmetry_end", defaultValue: 0.5, automationRate: "a-rate" },
      { name: "amplitude_end", defaultValue: 0.1, automationRate: "a-rate" },
      { name: "whiteNoise_end", defaultValue: 0, automationRate: "a-rate" },
      // Transport state for portamento behavior
      { name: "isPlaying", defaultValue: 0, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();

    // ===== PARAMETER GENERATION (from program-worklet) =====
    
    // Current parameter values (reported to main thread and used for synthesis)
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

    // Program configuration from main thread (interpolation types)
    this.programConfig = {};
    
    // Parameter interpolation types (set via message)
    this.interpolationTypes = {
      frequency: "step",
      zingMorph: "step",
      zingAmount: "step",
      vowelX: "step",
      vowelY: "step",
      symmetry: "step",
      amplitude: "step",
      whiteNoise: "step",
    };
    
    // Phase tracking
    this.lastPhase = 0;
    
    // Error logging (rate-limited)
    this.errorLogged = false;

    // ===== AUDIO SYNTHESIS (from voice-worklet) =====
    
    // Shared UPHO master phase for both synthesis paths
    this.masterPhase = 0.0;
    this.fundamentalFreq = 220.0;
    this.sampleRate = 48000; // Will be updated from global scope

    // Performance constants
    this.twoPi = 2 * Math.PI;
    this.halfPi = Math.PI / 2;

    // Shared vowel formant frequency table (F1, F2, F3 in Hz)
    this.vowelFreqCorners = {
      backClose: [240, 596, 2400], // 'u' - back, close
      backOpen: [730, 1090, 2440], // 'ɔ' - back, open
      frontClose: [270, 2290, 3010], // 'i' - front, close
      frontOpen: [850, 1610, 2850], // 'æ' - front, open
    };

    // Vowel-specific formant amplitude corners (F1, F2, F3 relative amplitudes)
    this.vowelAmpCorners = {
      backClose: [0.3, 0.2, 0.1], // 'u' - low formants, weak F2/F3
      backOpen: [1.0, 0.5, 0.2], // 'ɔ' - strong F1, moderate F2
      frontClose: [0.4, 1.0, 0.3], // 'i' - strong F2, weak F1
      frontOpen: [0.8, 0.7, 0.3], // 'æ' - strong F1 and F2
    };

    // Q factor corners for vowel formants (affects resonance sharpness)
    this.vowelQCorners = {
      backClose: [12, 15, 20], // 'u' - moderate Q
      backOpen: [8, 12, 18], // 'ɔ' - lower Q, more breathy
      frontClose: [10, 25, 30], // 'i' - high Q for sharp F2/F3
      frontOpen: [6, 15, 25], // 'æ' - moderate Q
    };

    // Current interpolated formant frequencies and amplitudes
    this.formantFreqs = [800, 1150, 2900]; // Default to neutral vowel
    this.formantAmps = [0.6, 0.6, 0.25]; // Default amplitudes

    // Formant synthesis parameters
    this.formants = [
      {
        targetFreq: 800, // F1
        bandwidth: 80,
        amplitude: 0.8,
        carrierEven: { harmonicNum: 4, amplitude: 0.0 },
        carrierOdd: { harmonicNum: 3, amplitude: 0.8 },
      },
      {
        targetFreq: 1150, // F2
        bandwidth: 90,
        amplitude: 0.6,
        carrierEven: { harmonicNum: 6, amplitude: 0.0 },
        carrierOdd: { harmonicNum: 5, amplitude: 0.6 },
      },
      {
        targetFreq: 2900, // F3
        bandwidth: 120,
        amplitude: 0.2,
        carrierEven: { harmonicNum: 14, amplitude: 0.0 },
        carrierOdd: { harmonicNum: 13, amplitude: 0.2 },
      },
    ];

    // Debug counter
    this.debugCounter = 0;

    // Initialize formant carriers
    this.updateFormantCarriers();

    // Message handling for program configuration
    this.port.onmessage = this.handleMessage.bind(this);
  }

  handleMessage(event) {
    const message = event.data;

    switch (message.type) {
      case "SET_PROGRAM_CONFIG":
        // Receive full program configuration from main thread
        this.programConfig = message.config || {};
        break;
        
      case "SET_INTERPOLATION_TYPES":
        // Receive per-parameter interpolation types (e.g., step, cosine)
        if (message.params && typeof message.params === 'object') {
          this.interpolationTypes = {
            ...this.interpolationTypes,
            ...message.params,
          };
        }
        break;

      // SET_STEP_VALUES and SET_COS_SEGMENTS are obsolete
      // Values are now set directly via AudioParams

      case "SET_INTERPOLATED_VALUE":
        // Set a parameter to a specific interpolated value from current phase
        if (message.param && Number.isFinite(message.value)) {
          this.currentValues[message.param] = message.value;
        }
        break;
        
      // Portamento is now handled by AudioParam ramping
        
      case "GET_CURRENT_VALUES":
        // Report current values back to main thread
        this.port.postMessage({
          type: "CURRENT_VALUES",
          values: { ...this.currentValues }
        });
        break;
    }
  }

  // ===== PARAMETER GENERATION METHODS =====
  
  // generateParameters method removed - now using AudioParams directly
  
  // Parameter resolution methods removed - using AudioParams directly

  // ===== AUDIO SYNTHESIS METHODS (from voice-worklet) =====
  
  /**
   * Update vowel formants based on morphing position
   */
  updateVowelFormants(vowelX, vowelY) {
    const freqCorners = this.vowelFreqCorners;
    const ampCorners = this.vowelAmpCorners;

    // Bilinear interpolation between corner vowels
    for (let f = 0; f < 3; f++) { // F1, F2, F3
      // Interpolate frequencies
      const backFreqInterp = freqCorners.backClose[f] * (1 - vowelY) +
        freqCorners.backOpen[f] * vowelY;
      const frontFreqInterp = freqCorners.frontClose[f] * (1 - vowelY) +
        freqCorners.frontOpen[f] * vowelY;
      const finalFreq = backFreqInterp * (1 - vowelX) +
        frontFreqInterp * vowelX;

      // Interpolate amplitudes
      const backAmpInterp = ampCorners.backClose[f] * (1 - vowelY) +
        ampCorners.backOpen[f] * vowelY;
      const frontAmpInterp = ampCorners.frontClose[f] * (1 - vowelY) +
        ampCorners.frontOpen[f] * vowelY;
      const finalAmp = backAmpInterp * (1 - vowelX) + frontAmpInterp * vowelX;

      // Update both frequency and amplitude
      this.formantFreqs[f] = finalFreq;
      this.formantAmps[f] = finalAmp;
      this.formants[f].targetFreq = finalFreq;
      this.formants[f].amplitude = finalAmp;
    }

    this.updateFormantCarriers();
  }

  /**
   * Update formant carrier assignments using Le Brun's cross-fade method
   */
  updateFormantCarriers(fundamentalFreq = this.fundamentalFreq) {
    if (fundamentalFreq <= 0) return;

    this.formants.forEach((formant, _formantIndex) => {
      const targetRatio = formant.targetFreq / fundamentalFreq;

      // Find bracketing harmonics
      const lowerHarmonic = Math.floor(targetRatio);
      const upperHarmonic = Math.ceil(targetRatio);

      // Determine which carrier gets which harmonic based on even/odd
      let evenHarmonic, oddHarmonic;
      if (lowerHarmonic % 2 === 0) {
        evenHarmonic = lowerHarmonic;
        oddHarmonic = upperHarmonic;
      } else {
        oddHarmonic = lowerHarmonic;
        evenHarmonic = upperHarmonic;
      }

      // Ensure valid harmonics
      evenHarmonic = Math.max(2, evenHarmonic + (evenHarmonic % 2));
      oddHarmonic = Math.max(1, oddHarmonic - ((oddHarmonic + 1) % 2));

      // Calculate cross-fade weights based on proximity to target
      const evenFreq = evenHarmonic * fundamentalFreq;
      const oddFreq = oddHarmonic * fundamentalFreq;
      const evenDistance = Math.abs(formant.targetFreq - evenFreq);
      const oddDistance = Math.abs(formant.targetFreq - oddFreq);
      const totalDistance = evenDistance + oddDistance;

      let evenWeight = 0;
      let oddWeight = 1;
      if (totalDistance > 0) {
        evenWeight = oddDistance / totalDistance;
        oddWeight = evenDistance / totalDistance;
      }

      // Update carrier assignments
      formant.carrierEven.harmonicNum = evenHarmonic;
      formant.carrierEven.amplitude = evenWeight * formant.amplitude;
      formant.carrierOdd.harmonicNum = oddHarmonic;
      formant.carrierOdd.amplitude = oddWeight * formant.amplitude;
    });
  }

  /**
   * Generate shared modulator signal (fundamental frequency)
   */
  generateModulator(phasor) {
    return Math.sin(this.twoPi * phasor);
  }

  /**
   * Generate formant synthesis output (FM path)
   */
  generateFormantSynthesis(phasor, modulator, symmetryValue = 0.5) {
    let totalOutput = 0;
    let f1Output = 0;
    let f2Output = 0;
    let f3Output = 0;

    this.formants.forEach((formant, formantIndex) => {
      // Apply symmetry to formant synthesis phasor
      const symmetricalPhasor = this.applySymmetry(phasor, symmetryValue);

      // Generate both cross-faded carriers for this formant
      const evenCarrier = this.generateFMCarrier(
        symmetricalPhasor,
        formant.carrierEven.harmonicNum,
        formant.carrierEven.amplitude,
        formant.bandwidth / 100.0,
        modulator,
        0,
        formantIndex === 1, // Use cosine for F2 (index 1)
      );

      const oddCarrier = this.generateFMCarrier(
        symmetricalPhasor,
        formant.carrierOdd.harmonicNum,
        formant.carrierOdd.amplitude,
        formant.bandwidth / 100.0,
        modulator,
        0,
        formantIndex === 1, // Use cosine for F2 (index 1)
      );

      const formantOutput = evenCarrier + oddCarrier;
      totalOutput += formantOutput;

      // Store individual formant outputs for visualization
      if (formantIndex === 0) f1Output = formantOutput;
      if (formantIndex === 1) f2Output = formantOutput;
      if (formantIndex === 2) f3Output = formantOutput;
    });

    return {
      total: totalOutput * 0.1, // Scale to prevent clipping
      f1: f1Output * 0.1,
      f2: f2Output * 0.1,
      f3: f3Output * 0.1,
    };
  }

  /**
   * Generate FM carrier for formant synthesis
   */
  generateFMCarrier(
    phasor,
    harmonicNum,
    amplitude,
    modulationIndex,
    modulator,
    phaseOffset = 0,
    useCosine = false,
  ) {
    if (amplitude <= 0 || harmonicNum <= 0) return 0;

    // UPHO: Carrier phase derived from shared master phasor with phase offset
    const carrierPhasor = (phasor * harmonicNum) % 1.0;
    const carrierPhase = this.twoPi * carrierPhasor + phaseOffset;
    const modulatedPhase = carrierPhase + modulationIndex * modulator;

    // Use cosine for F2, sine for F1 and F3
    return amplitude *
      (useCosine ? Math.cos(modulatedPhase) : Math.sin(modulatedPhase));
  }

  /**
   * Generate zing synthesis output (ring modulation path)
   */
  generateZingSynthesis(phasor, morphValue, modDepthValue, symmetryValue) {
    const fundamental = this.generateWaveform(
      this.applySymmetry(phasor, symmetryValue),
    );

    // Generate three formant-based harmonics for vowel-aware zing
    const f1Harmonic = this.generateFormantUPL(0, symmetryValue);
    const f2Harmonic = this.generateFormantUPL(1, symmetryValue);
    const f3Harmonic = this.generateFormantUPL(2, symmetryValue);

    // Ring modulate fundamental with each formant harmonic
    const f1Ring = this.applyMorphingSynthesis(
      fundamental,
      f1Harmonic,
      morphValue,
      modDepthValue,
    );
    const f2Ring = this.applyMorphingSynthesis(
      fundamental,
      f2Harmonic,
      morphValue,
      modDepthValue,
    );
    const f3Ring = this.applyMorphingSynthesis(
      fundamental,
      f3Harmonic,
      morphValue,
      modDepthValue,
    );

    // Mix the three formant rings with vowel-specific amplitudes
    const totalOutput = f1Ring * this.formantAmps[0] +
      f2Ring * this.formantAmps[1] + f3Ring * this.formantAmps[2];

    return {
      total: totalOutput,
      f1: f1Ring,
      f2: f2Ring,
      f3: f3Ring,
    };
  }

  /**
   * Generate UPL harmonic for specific formant (zing synthesis path)
   */
  generateFormantUPL(formantIndex, symmetryValue) {
    const targetFreq = this.formantFreqs[formantIndex];
    const targetRatio = targetFreq / this.fundamentalFreq;

    // Anti-aliasing: limit to Nyquist
    const maxRatio = Math.floor(
      (this.sampleRate * 0.45) / this.fundamentalFreq,
    );
    const safeRatio = Math.min(targetRatio, maxRatio);

    const lowerHarmonic = Math.floor(safeRatio);
    const upperHarmonic = lowerHarmonic + 1;
    const crossfadeAmount = safeRatio - lowerHarmonic;

    // UPHO: Phase-locked formant harmonics
    let lowerPhase = (this.masterPhase * lowerHarmonic) % 1.0;
    let upperPhase = (this.masterPhase * upperHarmonic) % 1.0;

    // Apply symmetry and generate waveforms (use cosine for F2)
    const shapedLowerPhase = this.applySymmetry(lowerPhase, symmetryValue);
    const shapedUpperPhase = this.applySymmetry(upperPhase, symmetryValue);
    const useCosine = formantIndex === 1; // F2 uses cosine

    const lowerWave = this.generateWaveform(shapedLowerPhase, useCosine);
    const upperWave = this.generateWaveform(shapedUpperPhase, useCosine);

    // UPL cross-fade
    return lowerWave * (1.0 - crossfadeAmount) + upperWave * crossfadeAmount;
  }

  /**
   * Apply Morphing Zing synthesis (ring mod + AM morphing)
   */
  applyMorphingSynthesis(fundamental, harmonic, morphValue, modDepthValue) {
    // AM compensation factor: reduce AM to match ring mod level
    const amCompensation = 2.0 / 3.0;

    if (Math.abs(morphValue) < 0.001) {
      return fundamental * harmonic;
    } else if (morphValue > 0) {
      const ringWeight = Math.cos(morphValue * this.halfPi);
      const amWeight = Math.sin(morphValue * this.halfPi);
      const ring = fundamental * harmonic;
      const am = (1 + fundamental * modDepthValue) * harmonic * amCompensation;

      // Simple scaling to prevent bulge
      const totalWeight = ringWeight + amWeight;
      const scaleFactor = 1.0 / Math.max(totalWeight, 1.0);

      return (ring * ringWeight + am * amWeight) * scaleFactor;
    } else {
      const absMorph = Math.abs(morphValue);
      const ringWeight = Math.cos(absMorph * this.halfPi);
      const amWeight = Math.sin(absMorph * this.halfPi);
      const ring = fundamental * harmonic;
      const am = fundamental * (1 + harmonic * modDepthValue) * amCompensation;

      // Simple scaling to prevent bulge
      const totalWeight = ringWeight + amWeight;
      const scaleFactor = 1.0 / Math.max(totalWeight, 1.0);

      return (ring * ringWeight + am * amWeight) * scaleFactor;
    }
  }

  /**
   * Symmetry control: continuous phase warping for sine waves
   */
  applySymmetry(phase, symmetry) {
    const skew = Math.max(0.01, Math.min(0.99, symmetry));

    // Piecewise linear phase warping
    if (phase < 0.5) {
      return (phase / 0.5) * skew;
    } else {
      return skew + ((phase - 0.5) / 0.5) * (1.0 - skew);
    }
  }

  /**
   * Generate basic waveform
   */
  generateWaveform(phase, useCosine = false) {
    return useCosine
      ? Math.cos(this.twoPi * phase)
      : Math.sin(this.twoPi * phase);
  }

  // ===== MAIN PROCESS METHOD =====
  
  process(_inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outputChannel = output[0]; // Main audio output (scaled)
    const outputDuplicate = output.length > 1 ? output[1] : null; // Main duplicate
    const f1FullChannel = output.length > 2 ? output[2] : null; // F1 full amplitude
    const f2FullChannel = output.length > 3 ? output[3] : null; // F2 full amplitude
    const f3FullChannel = output.length > 4 ? output[4] : null; // F3 full amplitude
    const blockSize = outputChannel.length;

    // Update sample rate from global scope if available
    if (typeof sampleRate !== "undefined") {
      this.sampleRate = sampleRate;
    }

    // Get parameters
    const phaseValues = parameters.phase;
    const activeValues = parameters.active;
    
    // Get current phase and active state (sample-accurate)
    const currentPhase = phaseValues.length > 1 ? phaseValues[0] : phaseValues[0];
    const active = activeValues.length > 1 ? activeValues[0] : activeValues[0];
    this.lastPhase = currentPhase;
    this.currentValues.active = active;
    
    // Generate parameter values using AudioParams and interpolation types
    const paramNames = ['frequency', 'zingMorph', 'zingAmount', 'vowelX', 'vowelY', 'symmetry', 'amplitude', 'whiteNoise'];
    
    for (const paramName of paramNames) {
      const startParam = parameters[`${paramName}_start`];
      const endParam = parameters[`${paramName}_end`];
      const interpolationType = this.interpolationTypes[paramName];
      
      // Strict validation: require proper AudioParam values
      if (!startParam || startParam[0] === undefined) {
        if (!this.errorLogged) {
          console.error(`CRITICAL: Worklet missing ${paramName}_start parameter - outputting silence`);
          this.errorLogged = true;
        }
        this.currentValues[paramName] = 0;
        continue;
      }
      
      const startValue = startParam[0];
      let value;
      
      if (interpolationType === 'step') {
        value = startValue;
      } else if (interpolationType === 'cosine') {
        if (!endParam || endParam[0] === undefined) {
          if (!this.errorLogged) {
            console.error(`CRITICAL: Worklet missing ${paramName}_end for cosine interpolation - using start value`);
            this.errorLogged = true;
          }
          value = startValue;
        } else {
          const endValue = endParam[0];
          const shapedProgress = 0.5 - Math.cos(currentPhase * Math.PI) * 0.5;
          value = startValue + (endValue - startValue) * shapedProgress;
        }
      } else {
        if (!this.errorLogged) {
          console.error(`CRITICAL: Unknown interpolation type '${interpolationType}' for ${paramName} - using step`);
          this.errorLogged = true;
        }
        value = startValue;
      }
      
      this.currentValues[paramName] = value;
    }
    
    // Get generated parameter values
    const frequency = this.currentValues.frequency;
    const vowelX = this.currentValues.vowelX;
    const vowelY = this.currentValues.vowelY;
    const amplitude = this.currentValues.amplitude;
    const zingAmount = this.currentValues.zingAmount;
    const zingMorph = this.currentValues.zingMorph;
    const symmetry = this.currentValues.symmetry;

    // Convert single values to arrays for a-rate processing
    const zingAmountArray = Array(blockSize).fill(zingAmount);
    const zingMorphArray = Array(blockSize).fill(zingMorph);
    const symmetryArray = Array(blockSize).fill(symmetry);

    // Debug frequency every ~1 second
    this.debugCounter++;
    if (this.debugCounter % 44100 === 0) {
      console.log(`🎵 Unified Voice: frequency=${frequency}Hz, active=${active}`);
    }

    // Internal gain compensation constants
    const formantGain = 3.0;
    const zingGain = 0.4;
    const modDepth = 0.5; // Fixed at optimal value

    // Update frequency-dependent calculations
    if (frequency !== this.fundamentalFreq) {
      this.fundamentalFreq = frequency;
      this.updateFormantCarriers(frequency);
    }

    if (!active || frequency <= 0 || amplitude <= 0) {
      outputChannel.fill(0);
      if (outputDuplicate) outputDuplicate.fill(0);
      if (f1FullChannel) f1FullChannel.fill(0);
      if (f2FullChannel) f2FullChannel.fill(0);
      if (f3FullChannel) f3FullChannel.fill(0);
      return true;
    }

    // Update vowel formants once per block
    this.updateVowelFormants(vowelX, vowelY);

    // Calculate frequency increment per sample
    const freqIncrement = frequency / this.sampleRate;

    for (let sample = 0; sample < blockSize; sample++) {
      // Update shared master phasor (UPHO architecture)
      this.masterPhase = (this.masterPhase + freqIncrement) % 1.0;

      // Generate shared modulator signal
      const modulator = this.generateModulator(this.masterPhase);

      // Generate both synthesis paths with individual formant tracking
      const {
        total: formantOutput,
        f1: formantF1,
        f2: formantF2,
        f3: formantF3,
      } = this.generateFormantSynthesis(
        this.masterPhase,
        modulator,
        symmetryArray[sample],
      );

      // Convert normalized zingMorph (0-1) to bipolar (-1 to 1)
      const bipolarZingMorph = (zingMorphArray[sample] - 0.5) * 2.0;

      const { total: zingOutput, f1: zingF1, f2: zingF2, f3: zingF3 } = this
        .generateZingSynthesis(
          this.masterPhase,
          bipolarZingMorph,
          modDepth,
          symmetryArray[sample],
        );

      // Apply individual synthesis path gains
      const scaledFormantOutput = formantOutput * formantGain;
      const scaledZingOutput = zingOutput * zingGain;
      const scaledFormantF1 = formantF1 * formantGain;
      const scaledFormantF2 = formantF2 * formantGain;
      const scaledFormantF3 = formantF3 * formantGain;
      const scaledZingF1 = zingF1 * zingGain;
      const scaledZingF2 = zingF2 * zingGain;
      const scaledZingF3 = zingF3 * zingGain;

      // Blend between synthesis paths
      const blend = zingAmountArray[sample];
      const blendedOutput = scaledFormantOutput * (1.0 - blend) +
        scaledZingOutput * blend;
      const blendedF1 = scaledFormantF1 * (1.0 - blend) + scaledZingF1 * blend;
      const blendedF2 = scaledFormantF2 * (1.0 - blend) + scaledZingF2 * blend;
      const blendedF3 = scaledFormantF3 * (1.0 - blend) + scaledZingF3 * blend;

      // Apply overall level adjustment and amplitude envelope
      const finalOutput = blendedOutput * 10.0 * amplitude;
      outputChannel[sample] = finalOutput;

      // Duplicate main output on channel 1
      if (outputDuplicate) outputDuplicate[sample] = finalOutput;

      // Output amplitude-modulated formants for visualization
      if (f1FullChannel) f1FullChannel[sample] = blendedF1 * 10.0 * amplitude;
      if (f2FullChannel) f2FullChannel[sample] = blendedF2 * 10.0 * amplitude;
      if (f3FullChannel) f3FullChannel[sample] = blendedF3 * 10.0 * amplitude;
    }

    return true;
  }
}

registerProcessor("unified-synth-worklet", UnifiedSynthWorklet);
