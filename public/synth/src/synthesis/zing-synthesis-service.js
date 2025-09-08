/**
 * Formant Synthesis Service for Voice.Assembly.FM
 * 
 * Service for managing the dual-path Formant Synthesizer AudioWorklet
 * Combines PM (Phase Modulation) formant synthesis with Zing formant augmentation
 * 
 * The synthesizer provides two synthesis paths:
 * - Primary Path: Clean PM formant synthesis (baseline)
 * - Augmentation Path: Zing formant synthesis (adds harmonic complexity)
 * 
 * Both paths maintain formant structure and respond to vowel space morphing.
 * The zingAmount parameter blends between pure PM (0) and max zing augmentation (1).
 */

export class FormantSynthesisService {
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.formantSynthNode = null;
    this.isInitialized = false;
    
    // Current synthesis parameters (simplified to match new worklet)
    this.parameters = {
      frequency: 220,
      active: 0,        // Start inactive
      vowelX: 0.5,
      vowelY: 0.5,
      zingAmount: 0.5,  // Blend between PM (0) and Zing (1)
      zingMorph: 0,     // Zing character control
      symmetry: 0.5,
      gain: 1.0
    };
    
    console.log('🎤 Formant synthesis service created');
  }
  
  /**
   * Initialize the Formant synthesis AudioWorklet
   */
  async initialize() {
    if (this.isInitialized) {
      return this.formantSynthNode;
    }
    
    try {
      console.log('🎵 Initializing Formant Synthesizer AudioWorklet...');
      
      // Load the worklet module
      await this.audioContext.audioWorklet.addModule('./worklets/vowel-synth.worklet.js');
      
      // Create the worklet node with 5 channels output (main + duplicate + F1 + F2 + F3)
      this.formantSynthNode = new AudioWorkletNode(this.audioContext, 'vowel-synth', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [5]  // Main, duplicate, F1, F2, F3
      });
      
      // Set initial parameters
      this.updateAllParameters();
      
      this.isInitialized = true;
      console.log('✅ Formant Synthesizer AudioWorklet initialized successfully');
      
      return this.formantSynthNode;
      
    } catch (error) {
      console.error('❌ Formant synthesis initialization failed:', error);
      
      if (error.name === 'InvalidStateError') {
        console.error('Audio context might not be running.');
      } else if (error.message.includes('addModule')) {
        console.error('Failed to load formant synthesizer worklet module. Check file path.');
      }
      
      throw error;
    }
  }
  
  /**
   * Connect synthesis output to a destination node
   */
  connect(destinationNode) {
    if (this.formantSynthNode) {
      this.formantSynthNode.connect(destinationNode);
    }
  }
  
  /**
   * Disconnect synthesis output
   */
  disconnect() {
    if (this.formantSynthNode) {
      this.formantSynthNode.disconnect();
    }
  }
  
  /**
   * Update synthesis parameters
   */
  updateParameters(params) {
    if (!this.formantSynthNode) return;
    const now = this.audioContext.currentTime;

    // Helper to set a parameter if it exists in the received params
    const setParam = (paramName, value) => {
        if (value !== undefined && this.formantSynthNode.parameters.has(paramName)) {
            this.formantSynthNode.parameters.get(paramName).setValueAtTime(value, now);
        }
    };
    
    setParam('frequency', params.frequency);
    setParam('zingAmount', params.zingAmount);

    // Process envelope parameters
    const processEnvelope = (paramName, envelope) => {
        if (!envelope) return;
        if (envelope.static) {
            setParam(`${paramName}Start`, envelope.value);
            setParam(`${paramName}End`, envelope.value);
        } else {
            setParam(`${paramName}Start`, envelope.start);
            setParam(`${paramName}End`, envelope.end);
            setParam(`${paramName}Type`, envelope.type === 'cos' ? 1.0 : 0.0);
            setParam(`${paramName}Morph`, envelope.morph);
        }
    };

    processEnvelope('vowelX', params.vowelX);
    processEnvelope('vowelY', params.vowelY);
    processEnvelope('zingMorph', params.zingMorph);
    processEnvelope('symmetry', params.symmetry);

    // Update stored parameters for compatibility
    Object.assign(this.parameters, params);
  }
  
  /**
   * Update all parameters (used during initialization)
   * @private
   */
  updateAllParameters() {
    if (this.formantSynthNode) {
      for (const [paramName, value] of Object.entries(this.parameters)) {
        if (this.formantSynthNode.parameters.has(paramName)) {
          this.formantSynthNode.parameters.get(paramName).setValueAtTime(
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
   * Set zing morphing parameter (-1 to 1)
   */
  setZingMorph(zingMorph) {
    this.updateParameters({
      zingMorph: Math.max(-1, Math.min(1, zingMorph))
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
   * Set synthesis active state (0 or 1)
   */
  setActive(active) {
    this.updateParameters({
      active: active ? 1 : 0
    });
  }
  
  /**
   * Set amount of zing augmentation (0 = pure PM formants, 1 = max zing augmentation)
   */
  setZingAmount(amount) {
    this.updateParameters({
      zingAmount: Math.max(0, Math.min(1, amount))
    });
  }
  
  /**
   * Check if synthesis is ready
   */
  isReady() {
    return this.isInitialized && this.formantSynthNode !== null;
  }
  
  /**
   * Set the sync phasor value for envelope synchronization
   */
  setSyncPhasor(syncPhasorValue) {
    if (this.formantSynthNode) {
        // Use a short ramp to avoid clicks if the sync phasor jumps
        const now = this.audioContext.currentTime;
        this.formantSynthNode.parameters.get('syncPhasor').linearRampToValueAtTime(syncPhasorValue, now + 0.01);
    }
  }

  /**
   * Get the worklet node for advanced usage
   */
  getNode() {
    return this.formantSynthNode;
  }
}