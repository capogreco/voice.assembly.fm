/**
 * White Noise AudioWorklet Processor
 * Generates stereo white noise with two independent channels for XY oscilloscope
 */

class WhiteNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    
    // Ensure we have at least 2 channels for stereo
    if (output.length < 2) return true;
    
    const leftChannel = output[0];
    const rightChannel = output[1];
    
    // Generate 128 samples for each channel
    for (let i = 0; i < leftChannel.length; i++) {
      // Generate independent white noise samples [-1.0, 1.0]
      const whiteL = Math.random() * 2 - 1;
      const whiteR = Math.random() * 2 - 1;
      
      // Output at full amplitude - master gain will handle volume control
      leftChannel[i] = whiteL;
      rightChannel[i] = whiteR;
    }
    
    // Keep processor alive
    return true;
  }
}

// Register the processor
registerProcessor('white-noise-processor', WhiteNoiseProcessor);