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
    
    // Output parameter mapping
    this.parameterOutputs = {
      frequency: 0,
      zingMorph: 1,
      zingAmount: 2,
      vowelX: 3,
      vowelY: 4,
      symmetry: 5,
      amplitude: 6
    };
    
    // Current parameter values for outputs
    this.currentValues = {
      frequency: 440,
      zingMorph: 0,
      zingAmount: 0,
      vowelX: 0.5,
      vowelY: 0.5,
      symmetry: 0.5,
      amplitude: 0.1
    };
    
    this.port.onmessage = this.handleMessage.bind(this);
  }
  
  handleMessage(event) {
    const message = event.data;
    
    switch (message.type) {
      case 'SET_PROGRAM':
        this.programState = message.config;
        this.initializeEnvelopes();
        break;
        
      case 'SET_DIRECT_VALUE':
        if (this.currentValues.hasOwnProperty(message.param)) {
          this.currentValues[message.param] = message.value;
        }
        break;
    }
  }
  
  initializeEnvelopes() {
    if (!this.programState) return;
    
    this.envelopes.clear();
    
    for (const [paramName, paramState] of Object.entries(this.programState)) {
      if (typeof paramState === 'object' && paramState.temporalBehavior) {
        if (paramState.temporalBehavior === 'envelope') {
          this.envelopes.set(paramName, {
            startValue: this.generateValue(paramState.startValueGenerator, paramName),
            endValue: this.generateValue(paramState.endValueGenerator, paramName),
            currentValue: 0,
            active: false,
            interpolationType: paramState.interpolationType || 'linear',
            intensity: paramState.intensity || 0.5
          });
        } else if (paramState.temporalBehavior === 'static') {
          this.currentValues[paramName] = this.generateValue(paramState.startValueGenerator, paramName);
          console.log(`📊 Program: Set ${paramName} = ${this.currentValues[paramName]} (static)`);
        }
      }
    }
  }
  
  /**
   * Parse SIN (Simple Integer Notation) strings like "1,3,5" or "1-6"
   */
  parseSIN(sinString) {
    if (!sinString || typeof sinString !== 'string') return [1];
    
    const results = [];
    const parts = sinString.split(',');
    
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.includes('-')) {
        // Handle ranges like "1-6"
        const [start, end] = trimmed.split('-').map(n => parseInt(n.trim()));
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

  generateValue(generator, paramName) {
    if (!generator) return 0;
    
    switch (generator.type) {
      case 'periodic': {
        // Parse numerators and denominators
        const numerators = this.parseSIN(generator.numerators || '1');
        const denominators = this.parseSIN(generator.denominators || '1');
        const numeratorBehavior = generator.numeratorBehavior || 'static';
        const denominatorBehavior = generator.denominatorBehavior || 'static';
        const baseValue = generator.baseValue || 440;
        
        // Get or initialize counter for this parameter
        const counterKey = `${paramName}_numerator`;
        if (!this.programCounters.has(counterKey)) {
          this.programCounters.set(counterKey, 0);
        }
        
        let numIndex = this.programCounters.get(counterKey);
        
        // Select numerator based on behavior
        let selectedNumerator;
        switch (numeratorBehavior) {
          case 'static':
            selectedNumerator = numerators[0];
            break;
          case 'ascending':
            selectedNumerator = numerators[numIndex % numerators.length];
            this.programCounters.set(counterKey, numIndex + 1);
            break;
          case 'descending':
            selectedNumerator = numerators[(numerators.length - 1 - numIndex) % numerators.length];
            this.programCounters.set(counterKey, numIndex + 1);
            break;
          case 'random':
            selectedNumerator = numerators[Math.floor(Math.random() * numerators.length)];
            break;
          case 'shuffle':
            // Implement shuffle by cycling through random permutation
            selectedNumerator = numerators[Math.floor(Math.random() * numerators.length)];
            break;
          default:
            selectedNumerator = numerators[0];
        }
        
        // Get or initialize counter for denominators
        const denomCounterKey = `${paramName}_denominator`;
        if (!this.programCounters.has(denomCounterKey)) {
          this.programCounters.set(denomCounterKey, 0);
        }
        
        let denomIndex = this.programCounters.get(denomCounterKey);
        
        // Select denominator based on behavior
        let selectedDenominator;
        switch (denominatorBehavior) {
          case 'static':
            selectedDenominator = denominators[0];
            break;
          case 'ascending':
            selectedDenominator = denominators[denomIndex % denominators.length];
            this.programCounters.set(denomCounterKey, denomIndex + 1);
            break;
          case 'descending':
            selectedDenominator = denominators[(denominators.length - 1 - denomIndex) % denominators.length];
            this.programCounters.set(denomCounterKey, denomIndex + 1);
            break;
          case 'random':
            selectedDenominator = denominators[Math.floor(Math.random() * denominators.length)];
            break;
          case 'shuffle':
            selectedDenominator = denominators[Math.floor(Math.random() * denominators.length)];
            break;
          default:
            selectedDenominator = denominators[0];
        }
        
        selectedDenominator = selectedDenominator || 1; // Prevent division by zero
        
        const ratio = selectedNumerator / selectedDenominator;
        
        console.log(`🎵 HRG ${paramName}: ${baseValue} × (${selectedNumerator}/${selectedDenominator}) = ${baseValue * ratio}`);
        return baseValue * ratio;
      }
        
      case 'normalised': {
        // Handle normalised (RBG) generators
        if (typeof generator.range === 'number') {
          return Math.random() * generator.range;
        } else if (generator.range && typeof generator.range === 'object') {
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
          case 'linear':
            shapedProgress = rawProgress;
            break;
          case 'cosine':
            shapedProgress = 0.5 - Math.cos(rawProgress * Math.PI) * 0.5;
            break;
          case 'parabolic':
            // Use intensity to control curve shape
            const intensity = Math.max(0.1, Math.min(10, envelope.intensity * 10)); // Map 0-1 to 0.1-10
            shapedProgress = Math.pow(rawProgress, intensity);
            break;
          default:
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
      if (typeof paramState === 'object' && 
          paramState.temporalBehavior === 'envelope') {
        
        const envelope = this.envelopes.get(paramName);
        if (envelope) {
          envelope.startValue = this.generateValue(paramState.startValueGenerator, paramName);
          envelope.endValue = this.generateValue(paramState.endValueGenerator, paramName);
          envelope.interpolationType = paramState.interpolationType || 'linear';
          envelope.intensity = paramState.intensity || 0.5;
          envelope.active = true;
          console.log(`🚀 Triggered ${envelope.interpolationType} envelope for ${paramName}: ${envelope.startValue} → ${envelope.endValue}`);
        }
      } else if (typeof paramState === 'object' && 
                 paramState.temporalBehavior === 'static') {
        this.currentValues[paramName] = this.generateValue(paramState.startValueGenerator, paramName);
        console.log(`📊 Program: Set ${paramName} = ${this.currentValues[paramName]} (static)`);
      }
    }
  }
  
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const blockSize = output[0].length;
    const phaseValues = parameters.phase; // Read the phase AudioParam
    
    for (let i = 0; i < blockSize; i++) {
      // Read current phase from AudioParam (sample-accurate)
      const currentPhase = phaseValues.length > 1 ? phaseValues[i] : phaseValues[0];
      
      // Detect EOC by comparing with last phase
      const eoc = this.detectEOC(currentPhase, this.lastPhase);
      this.lastPhase = currentPhase;
      
      if (eoc) {
        // EOC detected - trigger envelope updates
        this.triggerEnvelopes();
        console.log('🔔 Program EOC detected');
      }
      
      // Update envelopes using current phase as progress
      this.updateEnvelopes();
      
      // Output current parameter values on separate channels
      for (const [paramName, outputIndex] of Object.entries(this.parameterOutputs)) {
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
        name: 'phase',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate' // Sample-accurate for smooth ramping
      }
    ];
  }
}

registerProcessor('program-worklet', ProgramWorklet);