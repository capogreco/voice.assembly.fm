/**
 * Formant Synthesizer AudioWorklet Processor
 * 
 * A formant synthesizer that combines PM (Phase/Frequency Modulation) formant 
 * synthesis with Zing formant augmentation for complex vowel-like timbres.
 * 
 * Mental Model:
 * - Primary Path: PM formant synthesis (the baseline) 
 * - Augmentation Path: Zing formant synthesis (adds harmonic complexity)
 * 
 * Both paths maintain formant structure and respond to vowel space morphing.
 * 
 * Key Features:
 * - Real-time blend between PM and Zing formant synthesis paths
 * - Unified vowel space morphing (vowelX/vowelY controls F1, F2, F3 frequencies)
 * - UPHO (Unified Phase Harmonic Oscillators) architecture for phase coherency
 * - Multi-channel output: main audio + individual formant channels for visualization
 * - F2 hardcoded to use cosine (90° phase offset) for natural formant relationships
 */

class VowelSynthProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            // Core parameters
            { name: 'frequency', defaultValue: 220, minValue: 20, maxValue: 2000, automationRate: 'k-rate' },
            { name: 'active', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            
            // Vowel parameters
            { name: 'vowelX', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'vowelY', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            
            // Synthesis blend and character
            { name: 'zingAmount', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' }, // 0=pure PM formant, 1=max zing augmentation
            { name: 'zingMorph', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'a-rate' }, // Zing character morph parameter
            { name: 'symmetry', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            
            // Master timing control
            { name: 'syncPhasor', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },

            // Envelope controls for Vowel X
            { name: 'vowelXStart', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'vowelXEnd', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'vowelXType', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }, // 0=lin, 1=cos
            { name: 'vowelXMorph', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },

            // Envelope controls for Vowel Y
            { name: 'vowelYStart', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'vowelYEnd', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'vowelYType', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'vowelYMorph', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            
            // Envelope controls for Zing Morph
            { name: 'zingMorphStart', defaultValue: 0.5, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
            { name: 'zingMorphEnd', defaultValue: 0.5, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
            { name: 'zingMorphType', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'zingMorphMorph', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },

            // Envelope controls for Symmetry
            { name: 'symmetryStart', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'symmetryEnd', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'symmetryType', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'symmetryMorph', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },

            // Envelope controls for Amplitude
            { name: 'amplitudeStart', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'amplitudeEnd', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'amplitudeType', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'amplitudeMorph', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        ];
    }

    constructor() {
        super();
        
        // Shared UPHO master phase for both synthesis paths
        this.masterPhase = 0.0;
        this.lastMasterPhase = 0.0;
        this.fundamentalFreq = 220.0;
        this.sampleRate = 48000; // Will be updated from global scope
        
        // Performance constants
        this.twoPi = 2 * Math.PI;
        this.halfPi = Math.PI / 2;
        
        // Shared vowel formant frequency table (F1, F2, F3 in Hz)
        this.vowelFreqCorners = {
            backClose: [240, 596, 2400],   // 'u' - back, close
            backOpen: [730, 1090, 2440],   // 'ɔ' - back, open  
            frontClose: [270, 2290, 3010], // 'i' - front, close
            frontOpen: [850, 1610, 2850]   // 'æ' - front, open
        };
        
        // Vowel-specific formant amplitude corners (F1, F2, F3 relative amplitudes)
        this.vowelAmpCorners = {
            backClose: [0.3, 0.2, 0.1],   // 'u' - low formants, weak F2/F3
            backOpen: [1.0, 0.5, 0.2],    // 'ɔ' - strong F1, moderate F2
            frontClose: [0.4, 1.0, 0.3],  // 'i' - strong F2, weak F1  
            frontOpen: [0.8, 0.7, 0.3]    // 'æ' - strong F1 and F2
        };
        
        // Current interpolated formant frequencies and amplitudes
        this.formantFreqs = [800, 1150, 2900]; // Default to neutral vowel
        this.formantAmps = [0.6, 0.6, 0.25];   // Default amplitudes
        
        // Formant synthesis parameters (copied from formant synth)
        this.formants = [
            { 
                targetFreq: 800,   // F1
                bandwidth: 80,
                amplitude: 0.8,
                carrierEven: { harmonicNum: 4, amplitude: 0.0 },
                carrierOdd: { harmonicNum: 3, amplitude: 0.8 }
            },
            { 
                targetFreq: 1150,  // F2
                bandwidth: 90,
                amplitude: 0.6,
                carrierEven: { harmonicNum: 6, amplitude: 0.0 },
                carrierOdd: { harmonicNum: 5, amplitude: 0.6 }
            },
            { 
                targetFreq: 2900,  // F3
                bandwidth: 120,
                amplitude: 0.2,
                carrierEven: { harmonicNum: 14, amplitude: 0.0 },
                carrierOdd: { harmonicNum: 13, amplitude: 0.2 }
            }
        ];
        
        // Message handling for advanced formant tweaking
        this.port.onmessage = (event) => {
            const { type, payload } = event.data;
            
            if (type === 'setFormant' && payload.formantIndex >= 0 && payload.formantIndex < this.formants.length) {
                const formant = this.formants[payload.formantIndex];
                if (payload.frequency !== undefined) formant.targetFreq = payload.frequency;
                if (payload.bandwidth !== undefined) formant.bandwidth = payload.bandwidth;
                if (payload.amplitude !== undefined) formant.amplitude = payload.amplitude;
                this.updateFormantCarriers();
            }
        };
        
        // Initialize formant carriers
        this.updateFormantCarriers();
    }
    
    /**
     * Linear interpolation helper function
     */
    _lerp(a, b, mix) {
        return a * (1 - mix) + b * mix;
    }

    /**
     * Linear/exponential envelope shape generator
     */
    _getLinTypeEnvelope(t, p) {
        // Clamp parameters to ensure they are within the 0-1 range.
        const t_clamped = Math.max(0, Math.min(1, t));
        const p_clamped = Math.max(0, Math.min(1, p));

        let exponent;
        const minExponent = 1 / 8; // Very logarithmic
        const maxExponent = 8;   // Very exponential

        if (p_clamped < 0.5) {
            // Map p from [0, 0.5] to an exponent from [minExponent, 1]
            exponent = 1 + (p_clamped - 0.5) * 2 * (1 - minExponent);
        } else {
            // Map p from [0.5, 1] to an exponent from [1, maxExponent]
            exponent = 1 + (p_clamped - 0.5) * 2 * (maxExponent - 1);
        }

        if (t_clamped === 0) return 0;
        return Math.pow(t_clamped, exponent);
    }

    /**
     * Cosine-based envelope shape generator
     */
    _getCosTypeEnvelope(t, p) {
        // Clamp parameters to ensure they are within the 0-1 range.
        const t_clamped = Math.max(0, Math.min(1, t));
        const p_clamped = Math.max(0, Math.min(1, p));

        const f_square = t_clamped > 0 ? 1 : 0;
        const f_cosine = 0.5 - Math.cos(t_clamped * Math.PI) * 0.5;
        const f_median = t_clamped < 0.5 ? 0 : 1;

        if (p_clamped < 0.5) {
            const mix = p_clamped * 2;
            return this._lerp(f_square, f_cosine, mix);
        } else {
            const mix = (p_clamped - 0.5) * 2;
            return this._lerp(f_cosine, f_median, mix);
        }
    }
    
    /**
     * Update vowel formants based on morphing position
     * Interpolates both frequencies and amplitudes for authentic vowel modeling
     */
    updateVowelFormants(vowelX, vowelY) {
        const freqCorners = this.vowelFreqCorners;
        const ampCorners = this.vowelAmpCorners;
        
        // Bilinear interpolation between corner vowels
        for (let f = 0; f < 3; f++) { // F1, F2, F3
            // Interpolate frequencies
            const backFreqInterp = freqCorners.backClose[f] * (1 - vowelY) + freqCorners.backOpen[f] * vowelY;
            const frontFreqInterp = freqCorners.frontClose[f] * (1 - vowelY) + freqCorners.frontOpen[f] * vowelY;
            const finalFreq = backFreqInterp * (1 - vowelX) + frontFreqInterp * vowelX;
            
            // Interpolate amplitudes
            const backAmpInterp = ampCorners.backClose[f] * (1 - vowelY) + ampCorners.backOpen[f] * vowelY;
            const frontAmpInterp = ampCorners.frontClose[f] * (1 - vowelY) + ampCorners.frontOpen[f] * vowelY;
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
     * Shared UPL carrier assignment for both synthesis paths
     */
    updateFormantCarriers(fundamentalFreq = this.fundamentalFreq) {
        if (fundamentalFreq <= 0) return;
        
        this.formants.forEach((formant, formantIndex) => {
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
            // F2 uses cosine (90° phase offset), F1 and F3 use sine
            
            // EXPERIMENT: Apply symmetry to formant synthesis phasor
            const symmetricalPhasor = this.applySymmetry(phasor, symmetryValue);
            
            // Generate both cross-faded carriers for this formant
            const evenCarrier = this.generateFMCarrier(
                symmetricalPhasor, // Use symmetry-warped phasor
                formant.carrierEven.harmonicNum,
                formant.carrierEven.amplitude,
                formant.bandwidth / 100.0,
                modulator,
                0, // No phase offset needed
                formantIndex === 1 // Use cosine for F2 (index 1)
            );
            
            const oddCarrier = this.generateFMCarrier(
                symmetricalPhasor, // Use symmetry-warped phasor
                formant.carrierOdd.harmonicNum,
                formant.carrierOdd.amplitude,
                formant.bandwidth / 100.0,
                modulator,
                0, // No phase offset needed
                formantIndex === 1 // Use cosine for F2 (index 1)
            );
            
            const formantOutput = evenCarrier + oddCarrier;
            totalOutput += formantOutput;
            
            // Store individual formant outputs for visualization
            if (formantIndex === 0) f1Output = formantOutput;
            if (formantIndex === 1) f2Output = formantOutput;
            if (formantIndex === 2) f3Output = formantOutput;
        });
        
        return {
            total: totalOutput * 0.1, // Scale to prevent clipping (restore original calibration)
            f1: f1Output * 0.1,
            f2: f2Output * 0.1,
            f3: f3Output * 0.1
        };
    }
    
    /**
     * Generate FM carrier for formant synthesis
     */
    generateFMCarrier(phasor, harmonicNum, amplitude, modulationIndex, modulator, phaseOffset = 0, useCosine = false) {
        if (amplitude <= 0 || harmonicNum <= 0) return 0;
        
        // UPHO: Carrier phase derived from shared master phasor with phase offset
        const carrierPhasor = (phasor * harmonicNum) % 1.0;
        const carrierPhase = this.twoPi * carrierPhasor + phaseOffset;
        const modulatedPhase = carrierPhase + modulationIndex * modulator;
        
        // Use cosine for F2, sine for F1 and F3
        return amplitude * (useCosine ? Math.cos(modulatedPhase) : Math.sin(modulatedPhase));
    }
    
    /**
     * Generate zing synthesis output (ring modulation path)
     */
    generateZingSynthesis(phasor, morphValue, modDepthValue, symmetryValue) {
        const fundamental = this.generateWaveform(this.applySymmetry(phasor, symmetryValue));
        
        // Generate three formant-based harmonics for vowel-aware zing
        const f1Harmonic = this.generateFormantUPL(0, symmetryValue);
        const f2Harmonic = this.generateFormantUPL(1, symmetryValue);
        const f3Harmonic = this.generateFormantUPL(2, symmetryValue);
        
        // Ring modulate fundamental with each formant harmonic
        const f1Ring = this.applyMorphingSynthesis(fundamental, f1Harmonic, morphValue, modDepthValue);
        const f2Ring = this.applyMorphingSynthesis(fundamental, f2Harmonic, morphValue, modDepthValue);
        const f3Ring = this.applyMorphingSynthesis(fundamental, f3Harmonic, morphValue, modDepthValue);
        
        // Mix the three formant rings with vowel-specific amplitudes
        const totalOutput = f1Ring * this.formantAmps[0] + f2Ring * this.formantAmps[1] + f3Ring * this.formantAmps[2];
        
        return {
            total: totalOutput,
            f1: f1Ring,
            f2: f2Ring,
            f3: f3Ring
        };
    }
    
    /**
     * Generate UPL harmonic for specific formant (zing synthesis path)
     */
    generateFormantUPL(formantIndex, symmetryValue) {
        const targetFreq = this.formantFreqs[formantIndex];
        const targetRatio = targetFreq / this.fundamentalFreq;
        
        // Anti-aliasing: limit to Nyquist
        const maxRatio = Math.floor((this.sampleRate * 0.45) / this.fundamentalFreq);
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
     * Simple amplitude scaling approach to prevent volume bulge
     */
    applyMorphingSynthesis(fundamental, harmonic, morphValue, modDepthValue) {
        // AM compensation factor: reduce AM to match ring mod level
        const amCompensation = 2.0 / 3.0; // Reduce AM by 33% to match ring mod
        
        if (Math.abs(morphValue) < 0.001) {
            return fundamental * harmonic;
        } else if (morphValue > 0) {
            const ringWeight = Math.cos(morphValue * this.halfPi);
            const amWeight = Math.sin(morphValue * this.halfPi);
            const ring = fundamental * harmonic;
            const am = (1 + fundamental * modDepthValue) * harmonic * amCompensation;
            
            // Simple scaling to prevent bulge: reduce overall level when both contribute
            const totalWeight = ringWeight + amWeight;
            const scaleFactor = 1.0 / Math.max(totalWeight, 1.0);
            
            return (ring * ringWeight + am * amWeight) * scaleFactor;
        } else {
            const absMorph = Math.abs(morphValue);
            const ringWeight = Math.cos(absMorph * this.halfPi);
            const amWeight = Math.sin(absMorph * this.halfPi);
            const ring = fundamental * harmonic;
            const am = fundamental * (1 + harmonic * modDepthValue) * amCompensation;
            
            // Simple scaling to prevent bulge: reduce overall level when both contribute
            const totalWeight = ringWeight + amWeight;
            const scaleFactor = 1.0 / Math.max(totalWeight, 1.0);
            
            return (ring * ringWeight + am * amWeight) * scaleFactor;
        }
    }
    
    /**
     * Symmetry control: continuous phase warping for sine waves
     * Creates pulse-width-like effect by warping phase timing
     * symmetry = 0.5 naturally produces unmodified phase (neutral)
     */
    applySymmetry(phase, symmetry) {
        // Convert symmetry [0,1] to skew factor 
        // symmetry = 0.5 → skew = 0.5 (neutral)
        // symmetry < 0.5 → skew < 0.5 (compress first half) 
        // symmetry > 0.5 → skew > 0.5 (expand first half)
        const skew = Math.max(0.01, Math.min(0.99, symmetry));
        
        // Piecewise linear phase warping
        if (phase < 0.5) {
            // First half: map [0, 0.5] to [0, skew]
            return (phase / 0.5) * skew;
        } else {
            // Second half: map [0.5, 1] to [skew, 1]  
            return skew + ((phase - 0.5) / 0.5) * (1.0 - skew);
        }
    }
    
    /**
     * Generate basic waveform (currently sine, can be extended)
     */
    generateWaveform(phase, useCosine = false) {
        return useCosine ? Math.cos(this.twoPi * phase) : Math.sin(this.twoPi * phase);
    }
    
    /**
     * Expand parameter to buffer size if it's a single value
     */
    expandParameter(param, bufferSize) {
        return param.length === 1 ? Array(bufferSize).fill(param[0]) : param;
    }
    
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;
        
        const outputChannel = output[0];           // Main audio output (scaled)
        const outputDuplicate = output.length > 1 ? output[1] : null;  // Main duplicate
        const f1FullChannel = output.length > 2 ? output[2] : null;    // F1 full amplitude
        const f2FullChannel = output.length > 3 ? output[3] : null;    // F2 full amplitude  
        const f3FullChannel = output.length > 4 ? output[4] : null;    // F3 full amplitude
        const blockSize = outputChannel.length;
        
        // Update sample rate from global scope if available
        if (typeof sampleRate !== 'undefined') {
            this.sampleRate = sampleRate;
        }
        
        // Read AudioParam values
        const frequency = parameters.frequency[0];
        const active = parameters.active[0];
        
        // Read master sync phasor
        const syncPhasor = parameters.syncPhasor;

        // Read all k-rate envelope parameters once per block
        const vowelXStart = parameters.vowelXStart[0];
        const vowelXEnd = parameters.vowelXEnd[0];
        const vowelXType = parameters.vowelXType[0];
        const vowelXMorph = parameters.vowelXMorph[0];

        const vowelYStart = parameters.vowelYStart[0];
        const vowelYEnd = parameters.vowelYEnd[0];
        const vowelYType = parameters.vowelYType[0];
        const vowelYMorph = parameters.vowelYMorph[0];

        const zingMorphStart = parameters.zingMorphStart[0];
        const zingMorphEnd = parameters.zingMorphEnd[0];
        const zingMorphType = parameters.zingMorphType[0];
        const zingMorphMorph = parameters.zingMorphMorph[0];

        const symmetryStart = parameters.symmetryStart[0];
        const symmetryEnd = parameters.symmetryEnd[0];
        const symmetryType = parameters.symmetryType[0];
        const symmetryMorph = parameters.symmetryMorph[0];

        const amplitudeStart = parameters.amplitudeStart[0];
        const amplitudeEnd = parameters.amplitudeEnd[0];
        const amplitudeType = parameters.amplitudeType[0];
        const amplitudeMorph = parameters.amplitudeMorph[0];

        // Get a-rate parameters (still used for backwards compatibility)
        const zingAmount = this.expandParameter(parameters.zingAmount, blockSize);
        
        // Internal gain compensation constants (empirically balanced)
        const formantGain = 3.0; // Restore original PM path calibration
        const zingGain = 0.4;
        
        // Fixed parameters for vowel-based synthesis
        const modDepth = 0.5; // Fixed at optimal value for vowel synthesis
        
        // Update frequency-dependent calculations
        if (frequency !== this.fundamentalFreq) {
            this.fundamentalFreq = frequency;
            this.updateFormantCarriers(frequency);
        }
        
        if (!active || frequency <= 0) {
            outputChannel.fill(0);
            return true;
        }
        
        // Helper function to calculate envelope values
        const calculateEnvelope = (phasor, type, morph, start, end) => {
            let envelope_t = 0;
            if (type < 0.5) { // 0 = lin
                envelope_t = this._getLinTypeEnvelope(phasor, morph);
            } else { // 1 = cos
                envelope_t = this._getCosTypeEnvelope(phasor, morph);
            }
            return this._lerp(start, end, envelope_t);
        };

        // Calculate frequency increment per sample
        const freqIncrement = frequency / this.sampleRate;
        
        for (let sample = 0; sample < blockSize; sample++) {
            // Update shared master phasor (UPHO architecture)
            this.masterPhase = (this.masterPhase + freqIncrement) % 1.0;
            
            const currentSyncPhasor = syncPhasor[sample];

            // Calculate final parameter values for this sample using envelopes
            const vowelX = calculateEnvelope(currentSyncPhasor, vowelXType, vowelXMorph, vowelXStart, vowelXEnd);
            const vowelY = calculateEnvelope(currentSyncPhasor, vowelYType, vowelYMorph, vowelYStart, vowelYEnd);
            const zingMorph = calculateEnvelope(currentSyncPhasor, zingMorphType, zingMorphMorph, zingMorphStart, zingMorphEnd);
            const symmetry = calculateEnvelope(currentSyncPhasor, symmetryType, symmetryMorph, symmetryStart, symmetryEnd);
            const amplitude = calculateEnvelope(currentSyncPhasor, amplitudeType, amplitudeMorph, amplitudeStart, amplitudeEnd);

            // Update vowel formants based on current envelope values (per-sample for smooth modulation)
            this.updateVowelFormants(vowelX, vowelY);
            
            // Generate shared modulator signal
            const modulator = this.generateModulator(this.masterPhase);
            
            // Generate both synthesis paths with individual formant tracking
            const { total: formantOutput, f1: formantF1, f2: formantF2, f3: formantF3 } = this.generateFormantSynthesis(this.masterPhase, modulator, symmetry);
            const { total: zingOutput, f1: zingF1, f2: zingF2, f3: zingF3 } = this.generateZingSynthesis(
                this.masterPhase, 
                zingMorph, 
                modDepth, 
                symmetry
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
            const blend = zingAmount[sample];
            const blendedOutput = scaledFormantOutput * (1.0 - blend) + scaledZingOutput * blend;
            const blendedF1 = scaledFormantF1 * (1.0 - blend) + scaledZingF1 * blend;
            const blendedF2 = scaledFormantF2 * (1.0 - blend) + scaledZingF2 * blend;
            const blendedF3 = scaledFormantF3 * (1.0 - blend) + scaledZingF3 * blend;
            
            // Apply overall level adjustment and amplitude envelope
            const finalOutput = blendedOutput * 10.0 * amplitude;
            outputChannel[sample] = finalOutput;
            
            // Duplicate main output on channel 1 for compatibility
            if (outputDuplicate) outputDuplicate[sample] = finalOutput;
            
            // Output amplitude-modulated formants for oscilloscope analysis (channels 2-4)
            if (f1FullChannel) f1FullChannel[sample] = blendedF1 * 10.0 * amplitude;  // F1 formant output
            if (f2FullChannel) f2FullChannel[sample] = blendedF2 * 10.0 * amplitude;  // F2 formant output
            if (f3FullChannel) f3FullChannel[sample] = blendedF3 * 10.0 * amplitude;  // F3 formant output
        }
        
        return true;
    }
}

registerProcessor('vowel-synth', VowelSynthProcessor);