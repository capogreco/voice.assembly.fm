/**
 * Voice.Assembly.FM Synth Client Main Application
 */

import { WebRTCStar, generatePeerId } from '../../src/common/webrtc-star.js';
import { MessageTypes, MessageBuilder } from '../../src/common/message-protocol.js';
import { XYOscilloscope } from './src/visualization/xy-oscilloscope.js';

class SynthClient {
  constructor() {
    this.peerId = generatePeerId('synth');
    this.star = null;
    this.audioContext = null;
    this.oscilloscope = null;
    
    // Audio synthesis
    this.masterGain = null;
    this.formantNode = null;
    this.isCalibrationMode = false;
    this.isManualControlMode = false; // Track if we're using manual ctrl parameters
    this.noiseNode = null;
    
    // UI state
    this.currentState = 'join'; // 'join', 'connecting', 'active'
    this.volume = 0.1;
    
    // Store received state for application after audio init
    this.lastMusicalParams = null;
    
    // Phasor synchronization
    this.receivedPhasor = 0.0;
    this.receivedBpm = 120;
    this.receivedBeatsPerCycle = 4;
    this.receivedCycleLength = 2.0;
    this.lastPhasorMessage = 0;
    
    // UI Elements
    this.elements = {
      joinState: document.getElementById('join-state'),
      activeState: document.getElementById('active-state'),
      joinButton: document.getElementById('join-button'),
      connectionStatus: document.getElementById('connection-status'),
      loading: document.getElementById('loading'),
      canvas: document.getElementById('oscilloscope-canvas')
    };
    
    this.amplitudeEnvelope = null;

    // Envelope calculation helpers needed for real-time gain control
    this._lerp = (a, b, mix) => a * (1 - mix) + b * mix;

    this._getLinTypeEnvelope = (t, p) => {
      const t_clamped = Math.max(0, Math.min(1, t));
      const p_clamped = Math.max(0, Math.min(1, p));
      let exponent;
      const minExponent = 1 / 8;
      const maxExponent = 8;
      if (p_clamped < 0.5) {
        exponent = 1 + (p_clamped - 0.5) * 2 * (1 - minExponent);
      } else {
        exponent = 1 + (p_clamped - 0.5) * 2 * (maxExponent - 1);
      }
      if (t_clamped === 0) return 0;
      return Math.pow(t_clamped, exponent);
    };

    this._getCosTypeEnvelope = (t, p) => {
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
    };

    this.setupEventHandlers();
    
    // Auto-connect to network on page load
    this.autoConnect();
  }

  setupEventHandlers() {
    // Join button
    this.elements.joinButton.addEventListener('click', () => this.joinChoir());
    
    // Handle window resize for canvas
    window.addEventListener('resize', () => {
      if (this.oscilloscope) {
        this.oscilloscope.resize();
      }
    });
    
  }

  async autoConnect() {
    try {
      
      // Connect to network immediately
      await this.connectToNetwork();
      
      // Show join button for audio initialization
      this.setState('join');
      this.updateConnectionStatus('connected', 'Connected - Tap to join');
      
    } catch (error) {
      console.error('❌ Auto-connect failed:', error);
      this.updateConnectionStatus('error', `Error: ${error.message}`);
      this.setState('join');
    }
  }

  async joinChoir() {
    try {
      this.setState('initializing-audio');
      
      
      // Initialize audio context (requires user gesture)
      await this.initializeAudio();
      
      // Show active state first so canvas container has proper dimensions
      this.setState('active');
      
      // Initialize oscilloscope after DOM is updated
      // Use requestAnimationFrame to ensure DOM changes are applied
      requestAnimationFrame(() => {
        this.initializeOscilloscope();
      });
      
    } catch (error) {
      console.error('❌ Failed to join choir:', error);
      this.updateConnectionStatus('error', `Error: ${error.message}`);
      
      // Return to join state after 3 seconds
      setTimeout(() => {
        this.setState('join');
      }, 3000);
    }
  }

  async initializeAudio() {
    
    this.audioContext = new AudioContext();
    
    // Resume context if suspended
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    
    // Load white noise AudioWorklet processor
    try {
      await this.audioContext.audioWorklet.addModule('./worklets/white-noise-processor.js');
    } catch (error) {
      console.error('❌ Failed to load white noise processor:', error);
      throw error;
    }
    
    // Create master gain node
    this.masterGain = this.audioContext.createGain();
    this.masterGain.connect(this.audioContext.destination);
    this.updateVolume();
    
    // Initialize formant synthesis
    await this.initializeFormantSynthesis();
    
    // Apply any pending calibration state
    if (this.isCalibrationMode) {
      
      // Disconnect formant synthesis during calibration
      if (this.formantNode) {
        this.formantNode.disconnect();
      }
      
      this.startWhiteNoise(0.1);
      this.updateConnectionStatus('syncing', 'Calibration mode');
    }
    
  }

  async initializeFormantSynthesis() {
    try {
      // Load the worklet module
      await this.audioContext.audioWorklet.addModule('./worklets/vowel-synth.worklet.js');
      
      // Create the worklet node with 5 channels output (main + duplicate + F1 + F2 + F3)
      this.formantNode = new AudioWorkletNode(this.audioContext, 'vowel-synth', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [5]  // Main, duplicate, F1, F2, F3
      });
      
      // Connect directly to master gain
      this.formantNode.connect(this.masterGain);
      
      // Apply any stored state that was received before audio was ready
      this.applyStoredState();
      
    } catch (error) {
      console.error('❌ Failed to initialize formant synthesis:', error);
      throw error;
    }
  }

  applyStoredState() {
    console.log('🔄 Applying stored state after audio initialization');
    
    // Apply calibration mode if it was received before audio was ready
    if (this.isCalibrationMode) {
      console.log('📢 Applying stored calibration mode');
      this.startWhiteNoise(0.1);
      this.connectOscilloscopeToWhiteNoise();
      this.updateConnectionStatus('syncing', 'Calibration mode');
    }
    
    // Apply musical parameters if they were received before audio was ready
    if (this.lastMusicalParams) {
      console.log('🎵 Applying stored musical parameters');
      this.handleMusicalParameters(this.lastMusicalParams);
    }
  }

  async connectToNetwork() {
    
    // Create star network
    this.star = new WebRTCStar(this.peerId, 'synth');
    this.setupStarEventHandlers();
    
    // Connect to signaling server - use current host
    const signalingUrl = `ws://${window.location.hostname}:8000/ws`;
    await this.star.connect(signalingUrl);
    
    
  }

  setupStarEventHandlers() {
    this.star.addEventListener('peer-connected', (event) => {
      // Hide loading indicator and update status
      this.elements.loading.style.display = 'none';
      this.updateConnectionStatus('connected', 'Connected to network');
    });
    
    this.star.addEventListener('peer-removed', (event) => {
    });
    
    this.star.addEventListener('data-message', (event) => {
      const { peerId, channelType, message } = event.detail;
      this.handleDataMessage(peerId, channelType, message);
    });
  }



  handleDataMessage(peerId, channelType, message) {
    switch (message.type) {
      case MessageTypes.CALIBRATION_MODE:
        this.handleCalibrationMode(message);
        break;
        
      case MessageTypes.MUSICAL_PARAMETERS:
        this.handleMusicalParameters(message);
        break;
        
      case MessageTypes.PHASOR_SYNC:
        this.handlePhasorSync(message);
        break;
        
      default:
        break;
    }
  }

  handleCalibrationMode(message) {
    this.isCalibrationMode = message.enabled;
    
    if (this.isCalibrationMode) {
      
      // Disconnect formant synthesis during calibration
      if (this.formantNode) {
        this.formantNode.disconnect();
      }
      
      // Only start white noise if audio context is initialized
      if (this.audioContext) {
        this.startWhiteNoise(message.amplitude || 0.1);
        // Connect oscilloscope to white noise for calibration
        this.connectOscilloscopeToWhiteNoise();
        this.updateConnectionStatus('syncing', 'Calibration mode');
      } else {
        this.updateConnectionStatus('syncing', 'Calibration mode (no audio)');
      }
    } else {
      this.stopWhiteNoise();
      
      // Reconnect formant synthesis to master gain
      if (this.formantNode) {
        this.formantNode.connect(this.masterGain);
      }
      
      // Reconnect oscilloscope to formant synthesis
      this.connectOscilloscopeToFormant();
      
      // Formant synthesis ready for parameter control
      this.updateConnectionStatus('connected', 'Connected');
    }
  }

  handleMusicalParameters(message) {
    // Always store the latest parameters for application after audio init
    this.lastMusicalParams = message;
    
    if (!this.formantNode) {
      console.warn('⚠️ Cannot apply musical parameters: formant synthesis not ready');
      return;
    }
    
    // Handle manual mode state changes
    const wasManualMode = this.isManualControlMode;
    this.isManualControlMode = message.isManualMode;
    
    // If exiting manual mode, stop synthesis
    if (wasManualMode && !this.isManualControlMode) {
      this.formantNode.parameters.get('active').value = 0;
      return;
    }
    
    // If not in manual mode, don't apply parameters
    if (!this.isManualControlMode) {
      return;
    }
    
    // Extract parameter values (handle both static values and envelope objects)
    const extractValue = (param) => {
      return (param && typeof param === 'object' && param.static) ? param.value : param;
    };
    
    // Resume audio context if needed
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().then(() => {
      }).catch(err => {
        console.error('❌ Failed to resume audio context:', err);
      });
    }
    
    // Apply parameters directly to AudioWorklet
    this.formantNode.parameters.get('frequency').value = message.frequency;
    this.formantNode.parameters.get('vowelX').value = extractValue(message.vowelX);
    this.formantNode.parameters.get('vowelY').value = extractValue(message.vowelY);
    this.formantNode.parameters.get('zingAmount').value = message.zingAmount;
    this.formantNode.parameters.get('zingMorph').value = extractValue(message.zingMorph);
    this.formantNode.parameters.get('symmetry').value = extractValue(message.symmetry);
    this.formantNode.parameters.get('amplitude').value = extractValue(message.amplitude);
    this.formantNode.parameters.get('active').value = 1;
    
    
    // Store amplitude envelope for future use (if needed)
    if (message.amplitude) {
      this.amplitudeEnvelope = message.amplitude;
    }
    
  }

  handlePhasorSync(message) {
    this.receivedPhasor = message.phasor;
    this.receivedBpm = message.bpm;
    this.receivedBeatsPerCycle = message.beatsPerCycle;
    this.receivedCycleLength = message.cycleLength;
    this.lastPhasorMessage = performance.now();
    
    // Update connection status to show we're receiving phasor sync
    if (this.elements.connectionStatus) {
      this.elements.connectionStatus.textContent = `connected (${this.receivedBpm} bpm, ${this.receivedBeatsPerCycle}/cycle, φ=${this.receivedPhasor.toFixed(3)})`;
    }
  }

  startWhiteNoise(amplitude = 0.3) {
    if (this.whiteNoiseWorklet) {
      this.stopWhiteNoise();
    }
    
    try {
      // Create white noise AudioWorklet node (stereo output for XY oscilloscope)
      this.whiteNoiseWorklet = new AudioWorkletNode(this.audioContext, 'white-noise-processor', {
        outputChannelCount: [2] // Ensure stereo output
      });
      
      // Create gain node for volume control
      this.noiseGain = this.audioContext.createGain();
      this.noiseGain.gain.setValueAtTime(amplitude, this.audioContext.currentTime);
      
      // Connect: WhiteNoise -> Gain -> MasterGain
      this.whiteNoiseWorklet.connect(this.noiseGain);
      this.noiseGain.connect(this.masterGain);
      
      
      // Disconnect formant synthesis during calibration
      if (this.formantNode) {
        this.formantNode.disconnect();
      }
      
    } catch (error) {
      console.error('❌ Failed to start white noise:', error);
      throw error;
    }
  }


  stopWhiteNoise() {
    if (this.whiteNoiseWorklet) {
      this.whiteNoiseWorklet.disconnect();
      this.whiteNoiseWorklet = null;
    }
    
    if (this.noiseGain) {
      this.noiseGain.disconnect();
      this.noiseGain = null;
    }
    
  }

  initializeOscilloscope() {
    this.oscilloscope = new XYOscilloscope(
      this.elements.canvas,
      this.audioContext,
      this.masterGain  // Will connect to white noise during calibration
    );
    
    // Connect to appropriate source based on current mode
    if (this.isCalibrationMode && this.whiteNoiseWorklet) {
      this.connectOscilloscopeToWhiteNoise();
    } else if (this.formantNode) {
      this.connectOscilloscopeToFormant();
    }
    
    this.oscilloscope.start();
  }

  updateVolume() {
    if (this.masterGain) {
      // Hardcoded volume at 0.1
      const gainValue = 0.1;
      this.masterGain.gain.setValueAtTime(gainValue, this.audioContext.currentTime);
    }
  }

  setState(newState) {
    this.currentState = newState;
    
    switch (newState) {
      case 'join':
        this.elements.joinState.style.display = 'flex';
        this.elements.activeState.classList.remove('visible');
        break;
        
      case 'connecting':
        this.elements.joinState.style.display = 'none';
        this.elements.activeState.classList.add('visible');
        this.elements.loading.style.display = 'block';
        this.updateConnectionStatus('syncing', 'Connecting...');
        break;
        
      case 'initializing-audio':
        this.elements.joinState.style.display = 'none';
        this.elements.activeState.classList.add('visible');
        this.elements.loading.style.display = 'block';
        // Don't change connection status - keep showing network connection status
        break;
        
      case 'active':
        this.elements.loading.style.display = 'none';
        break;
    }
  }

  connectOscilloscopeToFormant() {
    if (!this.oscilloscope || !this.formantNode) return;
    
    
    // Disconnect current oscilloscope connections
    this.oscilloscope.disconnect();
    
    // Set normal amplification for formant visualization
    this.oscilloscope.calibrationMode = false;
    
    // Create channel splitter for 5-channel formant output
    if (this.formantSplitter) {
      this.formantSplitter.disconnect();
    }
    this.formantSplitter = this.audioContext.createChannelSplitter(5);
    this.formantNode.connect(this.formantSplitter);
    
    // Connect F1 (channel 2) to left, F2 (channel 3) to right for XY scope
    this.formantSplitter.connect(this.oscilloscope.leftAnalyser, 2);  // F1 -> X axis
    this.formantSplitter.connect(this.oscilloscope.rightAnalyser, 3); // F2 -> Y axis
    
    // Note: We don't reconnect masterGain to oscilloscope.channelSplitter 
    // because we're using direct formant channel connections
  }
  
  connectOscilloscopeToWhiteNoise() {
    if (!this.oscilloscope || !this.whiteNoiseWorklet) return;
    
    
    // Disconnect any formant connections
    if (this.formantSplitter) {
      this.formantSplitter.disconnect();
    }
    
    // Disconnect current oscilloscope input
    this.oscilloscope.disconnect();
    
    // Set high amplification for low-volume white noise
    this.oscilloscope.calibrationMode = true;
    
    // Connect white noise to oscilloscope channel splitter
    this.whiteNoiseWorklet.connect(this.oscilloscope.channelSplitter);
    // Reconnect splitter to analysers
    this.oscilloscope.channelSplitter.connect(this.oscilloscope.leftAnalyser, 0);
    this.oscilloscope.channelSplitter.connect(this.oscilloscope.rightAnalyser, 1);
  }


  updateConnectionStatus(status, message = '') {
    const element = this.elements.connectionStatus;
    
    element.classList.remove('connected', 'syncing', 'error');
    element.classList.add(status);
    
    const statusText = {
      'connected': message || 'Connected',
      'syncing': message || 'Syncing...',
      'error': message || 'Error'
    }[status] || message;
    
    element.textContent = statusText;
  }

}

/**
 * Simple XY Oscilloscope for visualizing formant outputs
 */

// Initialize the synth client
const synthClient = new SynthClient();

// Make it globally available for debugging
window.synthClient = synthClient;