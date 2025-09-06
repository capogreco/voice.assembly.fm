/**
 * Zing Synthesis Service for Voice.Assembly.FM
 * 
 * Service for managing the Morphing Zing AudioWorklet
 * Based on formant-synth-service.js from euclidean sequencer reference
 */

export class ZingSynthesisService {
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.zingSynthNode = null;
    this.isInitialized = false;
    
    // Current synthesis parameters
    this.parameters = {
      frequency: 220,
      harmonicRatio: 2,
      morph: 0,
      modDepth: 0.5,
      symmetry: 0.5,
      gain: 0,  // Start silent
      sync: 1,
      vowelX: 0.5,
      vowelY: 0.5,
      vowelBlend: 0.5,  // Blend between zing and vowel modes
      f1PhaseOffset: 0,
      f2PhaseOffset: 0
    };
    
    console.log('🎤 Zing synthesis service created');
  }
  
  /**
   * Initialize the Zing synthesis AudioWorklet
   */
  async initialize() {
    if (this.isInitialized) {
      return this.zingSynthNode;
    }
    
    try {
      console.log('🎵 Initializing Morphing Zing AudioWorklet...');
      
      // Load the worklet module
      await this.audioContext.audioWorklet.addModule('./worklets/morphing-zing.worklet.js');
      
      // Create the worklet node with 6 channels output (main + duplicate + F1 + F2 + F3 + unused)
      this.zingSynthNode = new AudioWorkletNode(this.audioContext, 'morphing-zing', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [6]  // Main, duplicate, F1, F2, F3, unused
      });
      
      // Set initial parameters
      this.updateAllParameters();
      
      this.isInitialized = true;
      console.log('✅ Morphing Zing AudioWorklet initialized successfully');
      
      return this.zingSynthNode;
      
    } catch (error) {
      console.error('❌ Zing synthesis initialization failed:', error);
      
      if (error.name === 'InvalidStateError') {
        console.error('Audio context might not be running.');
      } else if (error.message.includes('addModule')) {
        console.error('Failed to load morphing-zing worklet module. Check file path.');
      }
      
      throw error;
    }
  }
  
  /**
   * Connect synthesis output to a destination node
   */
  connect(destinationNode) {
    if (this.zingSynthNode) {
      this.zingSynthNode.connect(destinationNode);
    }
  }
  
  /**
   * Disconnect synthesis output
   */
  disconnect() {
    if (this.zingSynthNode) {
      this.zingSynthNode.disconnect();
    }
  }
  
  /**
   * Update synthesis parameters
   */
  updateParameters(newParams) {
    // Update stored parameters
    Object.assign(this.parameters, newParams);
    
    // Update AudioWorklet parameters if initialized
    if (this.zingSynthNode) {
      for (const [paramName, value] of Object.entries(newParams)) {
        if (this.zingSynthNode.parameters.has(paramName)) {
          this.zingSynthNode.parameters.get(paramName).setValueAtTime(
            value,
            this.audioContext.currentTime
          );
        }
      }
    }
  }
  
  /**
   * Update all parameters (used during initialization)
   * @private
   */
  updateAllParameters() {
    if (this.zingSynthNode) {
      for (const [paramName, value] of Object.entries(this.parameters)) {
        if (this.zingSynthNode.parameters.has(paramName)) {
          this.zingSynthNode.parameters.get(paramName).setValueAtTime(
            value,
            this.audioContext.currentTime
          );
        }
      }
    }
  }
  
  /**
   * Get current parameters
   */
  getParameters() {
    return { ...this.parameters };
  }
  
  /**
   * Set vowel position in 2D space
   */
  setVowelPosition(x, y) {
    this.updateParameters({
      vowelX: Math.max(0, Math.min(1, x)),
      vowelY: Math.max(0, Math.min(1, y))
    });
  }
  
  /**
   * Set morphing parameter (-1 to 1)
   */
  setMorph(morph) {
    this.updateParameters({
      morph: Math.max(-1, Math.min(1, morph))
    });
  }
  
  /**
   * Set fundamental frequency
   */
  setFrequency(freq) {
    this.updateParameters({
      frequency: Math.max(20, Math.min(20000, freq))
    });
  }
  
  /**
   * Set gain/amplitude (0 to 1)
   */
  setGain(gain) {
    this.updateParameters({
      gain: Math.max(0, Math.min(1, gain))
    });
  }
  
  /**
   * Set harmonic ratio for zing synthesis
   */
  setHarmonicRatio(ratio) {
    this.updateParameters({
      harmonicRatio: Math.max(0.5, Math.min(16, ratio))
    });
  }
  
  /**
   * Set blend between zing and vowel modes (0 = zing, 1 = vowel)
   */
  setVowelBlend(blend) {
    this.updateParameters({
      vowelBlend: Math.max(0, Math.min(1, blend))
    });
  }
  
  /**
   * Check if synthesis is ready
   */
  isReady() {
    return this.isInitialized && this.zingSynthNode !== null;
  }
  
  /**
   * Get the worklet node for advanced usage
   */
  getNode() {
    return this.zingSynthNode;
  }
}