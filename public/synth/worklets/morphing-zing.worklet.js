// Morphing Zing Synthesis AudioWorklet Processor
// Combines Zing synthesis (ring mod + hard sync) with bipolar morphing between AM modes
// Based on Rossum Electro-Music Triton and Chris Chafe's UPHO technique

class MorphingZingProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'frequency', defaultValue: 440, minValue: 20, maxValue: 20000, automationRate: 'a-rate' },
            { name: 'harmonicRatio', defaultValue: 2, minValue: 0.5, maxValue: 16, automationRate: 'a-rate' },
            { name: 'morph', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'a-rate' },
            { name: 'modDepth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            { name: 'symmetry', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            { name: 'gain', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            { name: 'sync', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            // Vowel formant control parameters
            { name: 'vowelX', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            { name: 'vowelY', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            { name: 'vowelBlend', defaultValue: 0.0, minValue: 0, maxValue: 1, automationRate: 'a-rate' }, // 0=original zing, 1=vowel mode
            
            // Phase offset parameters (in radians, 0 to 2π)
            { name: 'f1PhaseOffset', defaultValue: 0, minValue: 0, maxValue: 6.283185307, automationRate: 'k-rate' },
            { name: 'f2PhaseOffset', defaultValue: 0, minValue: 0, maxValue: 6.283185307, automationRate: 'k-rate' } // F2 uses cosine - no additional offset needed
        ];
    }

    constructor() {
        super();
        
        // UPHO: Single master phase for phase coherence
        this.masterPhase = 0;
        this.lastMasterPhase = 0;
        this.sampleRate = 48000; // Will be updated from global scope if available
        
        // Constants for performance
        this.twoPi = 2 * Math.PI;
        this.halfPi = Math.PI / 2;
        
        // Vowel formant frequency table (F1, F2, F3 in Hz)
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
        
        // Current vowel formant frequencies and amplitudes (will be calculated)
        this.formantFreqs = [800, 1150, 2900]; // Default to neutral vowel
        this.formantAmps = [0.6, 0.6, 0.25];   // Default amplitudes
        
        // Performance optimization: pre-allocated buffers
        this.phaseBuffer = new Float32Array(128);
        this.fundamentalBuffer = new Float32Array(128);
        this.harmonicBuffer = new Float32Array(128);
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0][0];                      // Main audio output (scaled)
        const outputDuplicate = outputs[0].length > 1 ? outputs[0][1] : null;  // Main duplicate
        const f1FullChannel = outputs[0].length > 2 ? outputs[0][2] : null;    // F1 full amplitude
        const f2FullChannel = outputs[0].length > 3 ? outputs[0][3] : null;    // F2 full amplitude
        const f3FullChannel = outputs[0].length > 4 ? outputs[0][4] : null;    // F3 full amplitude
        const bufferSize = output.length;
        
        // Update sample rate from global scope if available
        if (typeof sampleRate !== 'undefined') {
            this.sampleRate = sampleRate;
        }
        
        // Get parameter arrays (expand single values if needed)
        const freq = this.expandParameter(parameters.frequency, bufferSize);
        const harmonicRatio = this.expandParameter(parameters.harmonicRatio, bufferSize);
        const morph = this.expandParameter(parameters.morph, bufferSize);
        const modDepth = this.expandParameter(parameters.modDepth, bufferSize);
        const symmetry = this.expandParameter(parameters.symmetry, bufferSize);
        const gain = this.expandParameter(parameters.gain, bufferSize);
        const sync = parameters.sync[0]; // k-rate parameter
        
        // New vowel parameters
        const vowelX = this.expandParameter(parameters.vowelX, bufferSize);
        const vowelY = this.expandParameter(parameters.vowelY, bufferSize);
        const vowelBlend = this.expandParameter(parameters.vowelBlend, bufferSize);
        
        // Phase offset parameters (k-rate)
        const f1PhaseOffset = parameters.f1PhaseOffset[0];
        const f2PhaseOffset = parameters.f2PhaseOffset[0];
        
        // Update vowel formant frequencies (use first sample for k-rate calculation)
        this.updateVowelFormants(vowelX[0], vowelY[0]);
        
        for (let i = 0; i < bufferSize; i++) {
            // UPHO: Update master phase for phase coherence
            const phaseIncrement = freq[i] / this.sampleRate;
            this.masterPhase += phaseIncrement;
            
            // Hard sync detection (Zing synthesis core feature)
            let syncTrigger = false;
            if (sync > 0.5) {
                if (this.masterPhase >= 1.0 && this.lastMasterPhase < 1.0) {
                    syncTrigger = true;
                }
            }
            this.lastMasterPhase = this.masterPhase;
            
            // Keep master phase in [0, 1) range
            const fundamentalPhase = this.masterPhase % 1.0;
            
            // Generate fundamental oscillator
            const shapedFundPhase = this.applySymmetry(fundamentalPhase, symmetry[i]);
            const fundamental = this.generateWaveform(shapedFundPhase, phaseIncrement);
            
            // Blend between original Zing and vowel-based Zing
            const blend = vowelBlend[i];
            let outputSample = 0;
            
            let f1Output = 0;
            let f2Output = 0;
            let f3Output = 0;
            
            if (blend < 0.001) {
                // Original Zing synthesis: single UPL pair with harmonic ratio
                const safeHarmonicRatio = Math.min(harmonicRatio[i], Math.floor((this.sampleRate * 0.45) / freq[i]));
                const harmonic = this.generateUPLHarmonic(safeHarmonicRatio, syncTrigger, 0.5);
                outputSample = this.applyMorphingSynthesis(fundamental, harmonic, morph[i], modDepth[i], shapedFundPhase);
                
                // For non-vowel mode, output some reasonable signals for visualization
                f1Output = fundamental * 0.5;
                f2Output = harmonic * 0.5;
                f3Output = harmonic * 0.2;
                
            } else {
                // Vowel-based Zing synthesis: three UPL pairs for F1, F2, F3
                const f1Harmonic = this.generateFormantUPL(0, freq[i], syncTrigger, symmetry[i], f1PhaseOffset);
                const f2Harmonic = this.generateFormantUPL(1, freq[i], syncTrigger, symmetry[i], f2PhaseOffset);
                const f3Harmonic = this.generateFormantUPL(2, freq[i], syncTrigger, symmetry[i], 0); // F3 has no phase control
                
                // Ring modulate fundamental with each formant harmonic
                const f1Ring = this.applyMorphingSynthesis(fundamental, f1Harmonic, morph[i], modDepth[i], shapedFundPhase);
                const f2Ring = this.applyMorphingSynthesis(fundamental, f2Harmonic, morph[i], modDepth[i], shapedFundPhase);
                const f3Ring = this.applyMorphingSynthesis(fundamental, f3Harmonic, morph[i], modDepth[i], shapedFundPhase);
                
                // Store individual formant outputs for visualization
                f1Output = f1Ring;
                f2Output = f2Ring;
                f3Output = f3Ring;
                
                // Mix the three formant rings with vowel-specific amplitudes
                const vowelRing = f1Ring * this.formantAmps[0] + f2Ring * this.formantAmps[1] + f3Ring * this.formantAmps[2];
                
                if (blend < 0.999) {
                    // Crossfade between original and vowel modes
                    const originalHarmonic = this.generateUPLHarmonic(harmonicRatio[i], syncTrigger, 0.5);
                    const originalRing = this.applyMorphingSynthesis(fundamental, originalHarmonic, morph[i], modDepth[i], shapedFundPhase);
                    outputSample = originalRing * (1.0 - blend) + vowelRing * blend;
                } else {
                    outputSample = vowelRing;
                }
            }
            
            // Apply gain and write to output
            const finalOutput = outputSample * gain[i] * 0.5;
            output[i] = finalOutput;
            
            // Duplicate main output on channel 1 for compatibility
            if (outputDuplicate) outputDuplicate[i] = finalOutput;
            
            // Output full-amplitude formants for oscilloscope analysis (channels 2-4)
            if (f1FullChannel) f1FullChannel[i] = f1Output;  // No scaling for analysis
            if (f2FullChannel) f2FullChannel[i] = f2Output;  // No scaling for analysis
            if (f3FullChannel) f3FullChannel[i] = f3Output;  // No scaling for analysis
        }
        
        return true;
    }
    
    // Update vowel formant frequencies and amplitudes based on vowel position  
    updateVowelFormants(vowelX, vowelY) {
        const freqCorners = this.vowelFreqCorners;
        const ampCorners = this.vowelAmpCorners;
        
        for (let f = 0; f < 3; f++) { // F1, F2, F3
            // Bilinear interpolation for frequencies
            const backFreqInterp = freqCorners.backClose[f] * (1 - vowelY) + freqCorners.backOpen[f] * vowelY;
            const frontFreqInterp = freqCorners.frontClose[f] * (1 - vowelY) + freqCorners.frontOpen[f] * vowelY;
            const finalFreq = backFreqInterp * (1 - vowelX) + frontFreqInterp * vowelX;
            
            // Bilinear interpolation for amplitudes
            const backAmpInterp = ampCorners.backClose[f] * (1 - vowelY) + ampCorners.backOpen[f] * vowelY;
            const frontAmpInterp = ampCorners.frontClose[f] * (1 - vowelY) + ampCorners.frontOpen[f] * vowelY;
            const finalAmp = backAmpInterp * (1 - vowelX) + frontAmpInterp * vowelX;
            
            this.formantFreqs[f] = finalFreq;
            this.formantAmps[f] = finalAmp;
        }
    }
    
    // Generate UPL harmonic for original Zing synthesis
    generateUPLHarmonic(harmonicRatio, syncTrigger, symmetryValue) {
        const lowerHarmonic = Math.floor(harmonicRatio);
        const upperHarmonic = lowerHarmonic + 1;
        const crossfadeAmount = harmonicRatio - lowerHarmonic;
        
        // UPHO: Phase-locked harmonic oscillators
        let lowerPhase = (this.masterPhase * lowerHarmonic) % 1.0;
        let upperPhase = (this.masterPhase * upperHarmonic) % 1.0;
        
        // Hard sync: Reset phases on fundamental zero-crossing
        if (syncTrigger) {
            lowerPhase = 0;
            upperPhase = 0;
        }
        
        // Apply symmetry and generate waveforms (use sine for original Zing)
        const shapedLowerPhase = this.applySymmetry(lowerPhase, symmetryValue);
        const shapedUpperPhase = this.applySymmetry(upperPhase, symmetryValue);
        
        const lowerWave = this.generateWaveform(shapedLowerPhase, 0, false);
        const upperWave = this.generateWaveform(shapedUpperPhase, 0, false);
        
        // UPL cross-fade
        return lowerWave * (1.0 - crossfadeAmount) + upperWave * crossfadeAmount;
    }
    
    // Generate UPL harmonic for specific formant (F1, F2, or F3)
    generateFormantUPL(formantIndex, fundamentalFreq, syncTrigger, symmetryValue, phaseOffset = 0) {
        // Nudge fundamental frequency for F2 to un-phase-lock it (aggressive test)
        const adjustedFundamental = (formantIndex === 1) ? fundamentalFreq - 5.0 : fundamentalFreq;
        const targetFreq = this.formantFreqs[formantIndex];
        const targetRatio = targetFreq / adjustedFundamental;
        
        // Anti-aliasing: limit to Nyquist
        const maxRatio = Math.floor((this.sampleRate * 0.45) / adjustedFundamental);
        const safeRatio = Math.min(targetRatio, maxRatio);
        
        const lowerHarmonic = Math.floor(safeRatio);
        const upperHarmonic = lowerHarmonic + 1;
        const crossfadeAmount = safeRatio - lowerHarmonic;
        
        // UPHO: Phase-locked formant harmonics with phase offset
        const phaseOffsetNormalized = phaseOffset / this.twoPi; // Convert to 0-1 range
        let lowerPhase = ((this.masterPhase + phaseOffsetNormalized) * lowerHarmonic) % 1.0;
        let upperPhase = ((this.masterPhase + phaseOffsetNormalized) * upperHarmonic) % 1.0;
        
        // Hard sync
        if (syncTrigger) {
            lowerPhase = 0;
            upperPhase = 0;
        }
        
        // Apply symmetry and generate
        const shapedLowerPhase = this.applySymmetry(lowerPhase, symmetryValue);
        const shapedUpperPhase = this.applySymmetry(upperPhase, symmetryValue);
        
        const lowerWave = this.generateWaveform(shapedLowerPhase, 0);
        const upperWave = this.generateWaveform(shapedUpperPhase, 0);
        
        // UPL cross-fade
        return lowerWave * (1.0 - crossfadeAmount) + upperWave * crossfadeAmount;
    }
    
    // Apply Morphing Zing synthesis (PM + Ring Modulation crossfading)
    applyMorphingSynthesis(fundamental, harmonic, morphValue, modDepthValue, shapedPhase) {
        if (Math.abs(morphValue) < 0.001) {
            // Pure Phase Modulation path:
            // Apply phase modulation to the already-shaped phase
            const pmPhase = (shapedPhase + harmonic * modDepthValue * 0.1) % 1.0;
            return this.generateWaveform(pmPhase, 0);
        } else if (morphValue > 0) {
            // Morph from PM towards Ring Modulation
            const pmWeight = Math.cos(morphValue * this.halfPi);
            const rmWeight = Math.sin(morphValue * this.halfPi);
            
            // Phase Modulation path (uses shaped phase)
            const pmPhase = (shapedPhase + harmonic * modDepthValue * 0.1) % 1.0;
            const pmSignal = this.generateWaveform(pmPhase, 0);
            
            // Ring Modulation path (uses shaped fundamental)
            const rmSignal = fundamental * harmonic;
            
            return pmSignal * pmWeight + rmSignal * rmWeight;
        } else {
            // Morph from PM towards inverted Ring Modulation
            const absMorph = Math.abs(morphValue);
            const pmWeight = Math.cos(absMorph * this.halfPi);
            const rmWeight = Math.sin(absMorph * this.halfPi);
            
            // Phase Modulation path (uses shaped phase)
            const pmPhase = (shapedPhase + harmonic * modDepthValue * 0.1) % 1.0;
            const pmSignal = this.generateWaveform(pmPhase, 0);
            
            // Inverted Ring Modulation path
            const rmSignal = fundamental * (-harmonic);
            
            return pmSignal * pmWeight + rmSignal * rmWeight;
        }
    }
    
    // Expand parameter to buffer size if it's a single value
    expandParameter(param, bufferSize) {
        return param.length === 1 ? Array(bufferSize).fill(param[0]) : param;
    }
    
    // Symmetry control: continuous phase warping for sine waves
    // Creates pulse-width-like effect by warping phase timing
    // symmetry = 0.5 naturally produces unmodified phase (neutral)
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
    
    // Generate waveform with basic PolyBLEP anti-aliasing
    generateWaveform(phase, phaseIncrement, useCosine = false) {
        // For now, use sine waves - can be extended to support other waveforms
        // with full PolyBLEP anti-aliasing for sawtooth/square waves
        return useCosine ? Math.cos(this.twoPi * phase) : Math.sin(this.twoPi * phase);
    }
}

registerProcessor('morphing-zing', MorphingZingProcessor);