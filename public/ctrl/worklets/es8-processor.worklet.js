/**
 * ES-8 AudioWorklet Processor
 * Generates sample-accurate CV and gate signals for Expert Sleepers ES-8
 * Based on the es_8_test reference implementation
 */

class ES8Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    // ES-8 state
    this.phasor = 0.0;
    this.cpm = 30;
    this.stepsPerCycle = 16;
    this.cycleLength = 2.0;
    this.isEnabled = false;
    
    // Musical parameters
    this.frequency = 220;
    this.vowelX = 0.5;
    this.vowelY = 0.5;
    this.zingAmount = 0.0;
    this.amplitude = 1.0;
    
    // Gate/trigger states
    this.previousStep = -1;
    this.gateStates = new Array(8).fill(false);
    this.triggerSamples = new Array(8).fill(0);
    this.triggerDuration = 960; // ~20ms at 48kHz
    
    // Listen for messages from main thread
    this.port.onmessage = (event) => {
      const { type, ...params } = event.data;
      
      switch (type) {
        case 'enable':
          this.isEnabled = params.enabled;
          break;
          
        case 'phasor-update':
          this.phasor = params.phasor;
          this.cpm = params.cpm;
          this.stepsPerCycle = params.stepsPerCycle;
          this.cycleLength = params.cycleLength;
          break;
          
        case 'musical-parameters':
          this.frequency = params.frequency || this.frequency;
          this.vowelX = params.vowelX || this.vowelX;
          this.vowelY = params.vowelY || this.vowelY;
          this.zingAmount = params.zingAmount || this.zingAmount;
          this.amplitude = params.amplitude || this.amplitude;
          break;
      }
    };
  }

  generateTrigger(channel, active) {
    if (active && this.triggerSamples[channel] < this.triggerDuration) {
      this.triggerSamples[channel]++;
      return 1.0; // +10V equivalent
    } else if (!active) {
      this.triggerSamples[channel] = 0;
    }
    return 0.0;
  }

  process(inputs, outputs, parameters) {
    if (!this.isEnabled || !outputs[0] || outputs[0].length < 8) {
      return true;
    }

    const output = outputs[0];
    const bufferSize = output[0].length;

    for (let sampleIndex = 0; sampleIndex < bufferSize; sampleIndex++) {
      // Calculate current step position
      const currentStep = Math.floor(this.phasor * this.stepsPerCycle);
      const stepPhase = (this.phasor * this.stepsPerCycle) % 1.0;
      
      // Detect step changes for trigger generation
      const stepChanged = currentStep !== this.previousStep;
      if (stepChanged) {
        this.previousStep = currentStep;
        
        // Reset trigger counters for new triggers
        // Reset pulse (channel 7) - cycle start
        if (currentStep === 0) {
          this.triggerSamples[7] = 0;
        }
        
        // Step clock gate (channel 5) - reset on every step
        this.triggerSamples[5] = 0;
      }

      // Generate output for each channel
      for (let ch = 0; ch < 8 && ch < output.length; ch++) {
        let value = 0.0;
        
        switch (ch) {
          case 0: // Empty
            value = 0.0;
            break;
            
          case 1: // Empty
            value = 0.0;
            break;
            
          case 2: // Empty
            value = 0.0;
            break;
            
          case 3: // Empty
            value = 0.0;
            break;
            
          case 4: // Empty
            value = 0.0;
            break;
            
          case 5: // Step clock (gate high for first half of each step)
            value = this.generateTrigger(5, stepPhase < 0.5);
            break;
            
          case 6: // Phasor CV (0-1V sawtooth)
            value = this.phasor;
            break;
            
          case 7: // Reset pulse (cycle start trigger)
            value = this.generateTrigger(7, currentStep === 0);
            break;
        }
        
        // Ensure value stays in valid range
        output[ch][sampleIndex] = Math.max(-1, Math.min(1, value));
      }
    }
    
    return true;
  }
}

registerProcessor('es8-processor', ES8Processor);