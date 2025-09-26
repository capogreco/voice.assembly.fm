/**
 * Voice Worklet - Pure DSP Synthesis
 *
 * Handles formant synthesis combining PM (Phase/Frequency Modulation) and Zing paths.
 * Receives parameter values from the main thread or program worklet via _in parameters.
 *
 * No timing logic, no control logic, no message handling - just pure synthesis.
 */

class VoiceWorkletProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Core parameters with _in suffix
      {
        name: "frequency_in",
        defaultValue: 220,
        minValue: 20,
        maxValue: 2000,
        automationRate: "k-rate",
      },
      {
        name: "vowelX_in",
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
      {
        name: "vowelY_in",
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
      {
        name: "zingAmount_in",
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: "a-rate",
      },
      {
        name: "zingMorph_in",
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: "a-rate",
      },
      {
        name: "symmetry_in",
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: "a-rate",
      },
      {
        name: "amplitude_in",
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },

      // System control (no suffix)
      {
        name: "active",
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();

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
  }

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

  process(inputs, outputs, parameters) {
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

    // Read parameters - either from AudioParams (direct) or inputs (program)
    const input = inputs[0]; // Program worklet control signals
    const active = parameters.active[0];

    let frequency, vowelX, vowelY, amplitude, zingAmount, zingMorph, symmetry;

    if (input && input.length >= 7) {
      // Program mode - read from input channels
      frequency = input[0]?.[0] || parameters.frequency_in[0];
      zingMorph = input[1]?.[0] || parameters.zingMorph_in[0];
      zingAmount = input[2]?.[0] || parameters.zingAmount_in[0];
      vowelX = input[3]?.[0] || parameters.vowelX_in[0];
      vowelY = input[4]?.[0] || parameters.vowelY_in[0];
      symmetry = input[5]?.[0] || parameters.symmetry_in[0];
      amplitude = input[6]?.[0] || parameters.amplitude_in[0];
    } else {
      // Direct mode - read from AudioParams
      frequency = parameters.frequency_in[0];
      vowelX = parameters.vowelX_in[0];
      vowelY = parameters.vowelY_in[0];
      amplitude = parameters.amplitude_in[0];
      zingAmount = parameters.zingAmount_in[0];
      zingMorph = parameters.zingMorph_in[0];
      symmetry = parameters.symmetry_in[0];
    }

    // Convert single values to arrays for a-rate processing
    const zingAmountArray = Array(blockSize).fill(zingAmount);
    const zingMorphArray = Array(blockSize).fill(zingMorph);
    const symmetryArray = Array(blockSize).fill(symmetry);

    // Debug frequency every ~1 second
    this.debugCounter++;
    if (this.debugCounter % 44100 === 0) {
      console.log(`🎵 Voice: frequency=${frequency}Hz, active=${active}`);
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

registerProcessor("voice-worklet", VoiceWorkletProcessor);
