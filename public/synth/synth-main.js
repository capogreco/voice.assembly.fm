/**
 * Voice.Assembly.FM Synth Client Main Application
 */

import { WebRTCStar, generatePeerId } from '../../src/common/webrtc-star.js';
import { ClientPhasorSynchronizer } from '../../src/common/phasor-sync.js';
import { MessageTypes, MessageBuilder } from '../../src/common/message-protocol.js';
import { FormantSynthesisService } from './src/synthesis/zing-synthesis-service.js';

class SynthClient {
  constructor() {
    this.peerId = generatePeerId('synth');
    this.star = null;
    this.phasorSync = null;
    this.audioContext = null;
    this.oscilloscope = null;
    
    // Audio synthesis
    this.masterGain = null;
    this.formantSynth = null;
    this.isCalibrationMode = false;
    this.isManualControlMode = false; // Track if we're using manual ctrl parameters
    this.noiseNode = null;
    
    // UI state
    this.currentState = 'join'; // 'join', 'connecting', 'active'
    this.volume = 0.1;
    this.testSynthActive = false;
    
    // UI Elements
    this.elements = {
      joinState: document.getElementById('join-state'),
      activeState: document.getElementById('active-state'),
      joinButton: document.getElementById('join-button'),
      connectionStatus: document.getElementById('connection-status'),
      loading: document.getElementById('loading'),
      canvas: document.getElementById('oscilloscope-canvas'),
      syncPhasorDisplay: document.getElementById('sync-phasor-display'),
      syncPhasorFill: document.getElementById('sync-phasor-fill'),
      testSynthBtn: document.getElementById('test-synth-btn')
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
    console.log(`🎤 Synth client initialized: ${this.peerId}`);
    
    // Auto-connect to network on page load
    this.autoConnect();
  }

  setupEventHandlers() {
    // Join button
    this.elements.joinButton.addEventListener('click', () => this.joinChoir());
    
    // Test synthesis button
    this.elements.testSynthBtn.addEventListener('click', () => this.toggleTestSynth());
    
    
    // Handle window resize for canvas
    window.addEventListener('resize', () => {
      if (this.oscilloscope) {
        this.oscilloscope.resize();
      }
    });
    
  }

  async autoConnect() {
    try {
      console.log('📡 Auto-connecting to network...');
      
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
      this.setState('connecting');
      
      console.log('🎤 Joining choir...');
      
      // Initialize audio context (requires user gesture)
      await this.initializeAudio();
      
      // Initialize oscilloscope
      this.initializeOscilloscope();
      
      this.setState('active');
      
      console.log('🎤 Successfully joined choir');
      this._startLocalPhasorLoop();
      
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
    console.log('🔊 Initializing audio context...');
    
    this.audioContext = new AudioContext();
    
    // Resume context if suspended
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    
    // Load white noise AudioWorklet processor
    try {
      await this.audioContext.audioWorklet.addModule('./worklets/white-noise-processor.js');
      console.log('🎵 White noise processor loaded successfully');
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
      console.log('🔧 Applying pending calibration mode');
      
      // Disconnect formant synthesis during calibration
      if (this.formantNode) {
        this.formantNode.disconnect();
      }
      
      this.startWhiteNoise(0.1);
      this.updateConnectionStatus('syncing', 'Calibration mode');
    }
    
    console.log('🔊 Audio context initialized');
  }

  async initializeFormantSynthesis() {
    console.log('🎵 Initializing formant synthesis...');
    
    this.formantSynth = new FormantSynthesisService(this.audioContext);
    
    try {
      this.formantNode = await this.formantSynth.initialize();
      
      // Connect directly to master gain - amplitude controlled by internal envelope
      this.formantNode.connect(this.masterGain);
      
      console.log('🎤 Formant synthesis initialized and connected');
    } catch (error) {
      console.error('❌ Failed to initialize formant synthesis:', error);
      throw error;
    }
  }

  async connectToNetwork() {
    console.log('📡 Connecting to network...');
    
    // Create star network
    this.star = new WebRTCStar(this.peerId, 'synth');
    this.setupStarEventHandlers();
    
    // Connect to signaling server - use current host
    const signalingUrl = `ws://${window.location.hostname}:8000/ws`;
    await this.star.connect(signalingUrl);
    
    // Create phasor synchronizer
    this.phasorSync = new ClientPhasorSynchronizer(this.star);
    this.setupPhasorEventHandlers();
    
    console.log('📡 Connected to network');
  }

  setupStarEventHandlers() {
    this.star.addEventListener('peer-connected', (event) => {
      console.log(`👋 Peer connected: ${event.detail.peerId}`);
      this.updateConnectionStatus('connected', 'Connected to network');
    });
    
    this.star.addEventListener('peer-removed', (event) => {
      console.log(`👋 Peer disconnected: ${event.detail.peerId}`);
    });
    
    this.star.addEventListener('data-message', (event) => {
      const { peerId, channelType, message } = event.detail;
      this.handleDataMessage(peerId, channelType, message);
    });
  }

  setupPhasorEventHandlers() {
    this.phasorSync.addEventListener('sync-update', (event) => {
      const { phasor: syncPhasor, health } = event.detail;

      // The local phasor loop now handles updating the synth.
      // This handler's only job is to update the UI status.

      // Update connection status based on sync health
      if (health.confidence > 0.5) {
        this.updateConnectionStatus('syncing', `Synced (${syncPhasor.toFixed(3)})`);
      }

      // Update sync phasor display
      this.updateSyncPhasorDisplay(syncPhasor, health.confidence);
      
      // Update formant synthesis based on sync phasor (only when not in manual control mode)
      if (this.formantSynth && this.formantSynth.isReady() && !this.isCalibrationMode && !this.isManualControlMode) {
        // Map sync phasor to frequency and vowel position
        const baseFreq = 220;
        const freq = baseFreq + (syncPhasor * 220); // Sweep from 220Hz to 440Hz
        
        // Map sync phasor to vowel space (u -> ɔ -> i -> æ cycle)
        const vowelX = (Math.sin(syncPhasor * Math.PI * 2) + 1) / 2; // 0-1 oscillation
        const vowelY = (Math.cos(syncPhasor * Math.PI * 2) + 1) / 2; // 0-1 oscillation
        
        this.formantSynth.setFrequency(freq);
        this.formantSynth.setVowelPosition(vowelX, vowelY);
      }
    });
    
    this.phasorSync.addEventListener('cycle-start', (event) => {
      console.log(`🔄 Cycle start: ${event.detail.phasor.toFixed(3)}`);
    });
    
    this.phasorSync.addEventListener('sync-lost', (event) => {
      console.warn('⚠️ Lost synchronization with master');
      this.updateConnectionStatus('error', 'Sync lost');
      
      // Disconnect formant synthesis
      if (this.formantNode) {
        this.formantNode.disconnect();
      }
    });
  }

  _startLocalPhasorLoop() {
    const update = () => {
      if (this.phasorSync && this.formantSynth && this.formantSynth.isReady()) {
        // Get the latest predicted phasor value from our corrected logic
        const predictedPhasor = this.phasorSync.getCurrentPhasor();
        
        // Continuously update the AudioWorklet's phasor parameter
        this.formantSynth.setSyncPhasor(predictedPhasor);
      }
      // Schedule the next frame to continue the loop
      requestAnimationFrame(update);
    };
    // Start the loop for the first time
    update();
  }

  handleDataMessage(peerId, channelType, message) {
    switch (message.type) {
      case MessageTypes.PING:
        // Respond to ping
        const pong = MessageBuilder.pong(message.id, message.timestamp);
        this.star.sendToPeer(peerId, pong, 'sync');
        break;
        
      case MessageTypes.CALIBRATION_MODE:
        this.handleCalibrationMode(message);
        break;
        
      case MessageTypes.MUSICAL_PARAMETERS:
        this.handleMusicalParameters(message);
        break;
        
      default:
        // Log other messages for debugging
        if (message.type !== MessageTypes.PONG) {
          console.log(`📨 Received ${message.type} from ${peerId}`);
        }
    }
  }

  handleCalibrationMode(message) {
    this.isCalibrationMode = message.enabled;
    
    if (this.isCalibrationMode) {
      console.log('🔧 Entering calibration mode');
      
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
        console.log('⚠️ Audio context not initialized, cannot start white noise');
        this.updateConnectionStatus('syncing', 'Calibration mode (no audio)');
      }
    } else {
      console.log('🔧 Exiting calibration mode');
      this.stopWhiteNoise();
      
      // Reconnect formant synthesis to master gain
      if (this.formantNode) {
        this.formantNode.connect(this.masterGain);
      }
      
      // Reconnect oscilloscope to formant synthesis
      this.connectOscilloscopeToFormant();
      
      // Formant synthesis will resume automatically via phasor sync
      this.updateConnectionStatus('connected', 'Connected');
    }
  }

  handleMusicalParameters(message) {
    console.log('🎵 Received musical parameters:', message);
    
    if (!this.formantSynth || !this.formantSynth.isReady()) {
      console.warn('⚠️ Cannot apply musical parameters: formant synthesis not ready');
      return;
    }
    
    // Switch to manual control mode
    this.isManualControlMode = true;
    
    // In manual mode, extract static values from envelope objects
    const extractValue = (param) => {
      return (param && typeof param === 'object' && param.static) ? param.value : param;
    };
    
    // Apply the received parameters to the synthesis engine
    const synthParams = {
      frequency: message.frequency,
      zingMorph: message.zingMorph,    // Pass full envelope objects
      zingAmount: message.zingAmount,
      vowelX: message.vowelX,          // Pass full envelope objects
      vowelY: message.vowelY,          // Pass full envelope objects  
      symmetry: message.symmetry,      // Pass full envelope objects
      amplitude: message.amplitude     // Pass full envelope objects
    };
    
    // First, ensure audio context is running and worklet is active
    console.log('🎯 Manual mode - activating synthesis engine');
    console.log(`🔊 Audio context state: ${this.audioContext.state}`);
    
    // Resume audio context if needed
    if (this.audioContext.state === 'suspended') {
      console.log('🔊 Resuming suspended audio context...');
      this.audioContext.resume().then(() => {
        console.log('✅ Audio context resumed');
      }).catch(err => {
        console.error('❌ Failed to resume audio context:', err);
      });
    }
    
    this.formantSynth.setActive(true);
    
    // Then apply all the manual mode parameters (including amplitude)
    console.log('🎛️ Manual mode - extracted values:', synthParams);
    this.formantSynth.updateParameters(synthParams);
    
    // In manual mode, set a default syncPhasor value since we don't have timing sync
    console.log('🎯 Manual mode - setting default syncPhasor for envelope calculations');
    this.formantSynth.setSyncPhasor(0.5); // Use middle of cycle
    
    // Store amplitude envelope for future use (if needed)
    if (message.amplitude) {
      this.amplitudeEnvelope = message.amplitude;
    }
    
    console.log(`🎛️ Applied parameters: f=${message.frequency}Hz, zingMorph=${message.zingMorph.static ? message.zingMorph.value.toFixed(2) : 'envelope'}, vowel=(${message.vowelX.static ? message.vowelX.value.toFixed(2) : 'envelope'},${message.vowelY.static ? message.vowelY.value.toFixed(2) : 'envelope'}), symmetry=${message.symmetry.static ? message.symmetry.value.toFixed(2) : 'envelope'}`);
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
      
      console.log('🎵 White noise started');
      
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
    
    console.log('🎵 White noise stopped');
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
    } else if (this.formantSynth && this.formantSynth.isReady()) {
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
        
      case 'active':
        this.elements.loading.style.display = 'none';
        break;
    }
  }

  connectOscilloscopeToFormant() {
    if (!this.oscilloscope || !this.formantNode) return;
    
    console.log('🔬 Connecting oscilloscope to formant synthesis formant channels');
    
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
    
    console.log('🔬 Connecting oscilloscope to white noise');
    
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

  updateSyncPhasorDisplay(syncPhasor, confidence) {
    if (!this.elements.syncPhasorDisplay) return;
    
    const label = this.elements.syncPhasorDisplay.querySelector('.sync-phasor-label');
    const fill = this.elements.syncPhasorFill;
    
    if (confidence > 0.1) {
      // Active sync signal
      label.textContent = `Sync: ${(syncPhasor * 100).toFixed(1)}%`;
      fill.style.width = `${syncPhasor * 100}%`;
      this.elements.syncPhasorDisplay.style.borderColor = '#00ff88';
    } else {
      // No sync signal
      label.textContent = 'Sync: No Signal';
      fill.style.width = '0%';
      this.elements.syncPhasorDisplay.style.borderColor = '#333';
    }
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

  toggleTestSynth() {
    this.testAudio();
  }

  testAudio() {
    console.log('🔧 Debug - audioContext:', !!this.audioContext, 'formantSynth:', !!this.formantSynth, 'formantNode:', !!this.formantNode);

    if (!this.audioContext || !this.formantSynth || !this.formantNode) {
        console.log('❌ Cannot run test: audio components not initialized.');
        return;
    }

    console.log('🔊 Starting syncPhasor synchronization test...');
    const now = this.audioContext.currentTime;
    
    // Get the actual AudioWorklet node
    const node = this.formantSynth.formantSynthNode;
    if (!node) {
        console.log('❌ AudioWorklet node not available');
        return;
    }

    // Set basic synthesis parameters
    node.parameters.get('active').setValueAtTime(1, now);
    node.parameters.get('frequency').setValueAtTime(330, now);
    node.parameters.get('zingAmount').setValueAtTime(0, now); // Pure formant
    
    // Test envelope system: vowel morphing from 'a' to 'i' sound  
    node.parameters.get('vowelXStart').setValueAtTime(0.1, now);  // Start: more 'a' 
    node.parameters.get('vowelXEnd').setValueAtTime(0.9, now);    // End: more 'i'
    node.parameters.get('vowelYStart').setValueAtTime(0.3, now);  // Start: lower formant
    node.parameters.get('vowelYEnd').setValueAtTime(0.8, now);    // End: higher formant
    
    // Use linear envelope (type=0, morph=0.5 for linear progression)
    node.parameters.get('vowelXType').setValueAtTime(0, now);     // Linear
    node.parameters.get('vowelXMorph').setValueAtTime(0.5, now);  // Linear progression
    node.parameters.get('vowelYType').setValueAtTime(0, now);
    node.parameters.get('vowelYMorph').setValueAtTime(0.5, now);
    
    // Set symmetry to default (no envelope)
    node.parameters.get('symmetryStart').setValueAtTime(0.5, now);
    node.parameters.get('symmetryEnd').setValueAtTime(0.5, now);
    
    // Test amplitude envelope: fade in and out
    node.parameters.get('amplitudeStart').setValueAtTime(0.0, now);   // Start: silent
    node.parameters.get('amplitudeEnd').setValueAtTime(0.6, now);     // End: audible
    node.parameters.get('amplitudeType').setValueAtTime(0, now);      // Linear envelope
    node.parameters.get('amplitudeMorph').setValueAtTime(0.5, now);   // Linear progression
    
    console.log('🎵 Set envelope parameters for distributed sync test');
    console.log('🌐 Envelopes will be driven by syncPhasor from control client');
    console.log('📡 Press "Start Timing" in control client to begin synchronized envelope test');
    
    // NOTE: syncPhasor will be controlled by the control client via phasor sync broadcasts
    // No local syncPhasor ramp - we wait for network synchronization
    console.log('⏰ Waiting for syncPhasor from control client...');
  }
}

/**
 * Simple XY Oscilloscope for visualizing formant outputs
 */
class XYOscilloscope {
  constructor(canvas, audioContext, inputNode) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.audioContext = audioContext;
    this.inputNode = inputNode;
    
    // Create channel splitter to separate stereo channels
    this.channelSplitter = audioContext.createChannelSplitter(2);
    
    // Create separate analysers for left (X) and right (Y) channels
    this.leftAnalyser = audioContext.createAnalyser();
    this.rightAnalyser = audioContext.createAnalyser();
    
    this.leftAnalyser.fftSize = 1024;
    this.rightAnalyser.fftSize = 1024;
    this.bufferLength = this.leftAnalyser.fftSize;
    
    // Data arrays for each channel
    this.leftData = new Float32Array(this.bufferLength);
    this.rightData = new Float32Array(this.bufferLength);
    
    // Connect: Input -> ChannelSplitter -> Separate Analysers
    this.inputNode.connect(this.channelSplitter);
    this.channelSplitter.connect(this.leftAnalyser, 0);  // Left channel
    this.channelSplitter.connect(this.rightAnalyser, 1); // Right channel
    
    // Animation and trail effect
    this.isRunning = false;
    this.animationId = null;
    this.trailFactor = 0.05; // How much trail to leave (0-1)
    this.calibrationMode = false; // Track if we're in calibration mode for proper scaling
    
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    
    this.ctx.scale(dpr, dpr);
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    
    this.width = rect.width;
    this.height = rect.height;
    this.centerX = this.width / 2;
    this.centerY = this.height / 2;
  }

  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.draw();
  }

  stop() {
    this.isRunning = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  disconnect() {
    // Disconnect existing connections to allow reconnection
    try {
      // Disconnect input to channelSplitter
      if (this.inputNode) {
        this.inputNode.disconnect(this.channelSplitter);
      }
      // Disconnect channelSplitter outputs  
      if (this.channelSplitter) {
        this.channelSplitter.disconnect();
      }
    } catch (e) {
      // Ignore if already disconnected
    }
  }

  draw() {
    if (!this.isRunning) return;
    
    this.animationId = requestAnimationFrame(() => this.draw());
    
    // Get audio data from separate analysers
    this.leftAnalyser.getFloatTimeDomainData(this.leftData);
    this.rightAnalyser.getFloatTimeDomainData(this.rightData);
    
    // Clear canvas with dark background (like euclidean reference)
    this.ctx.fillStyle = '#1a1a1a';
    this.ctx.fillRect(0, 0, this.width, this.height);
    
    // Plot consecutive instantaneous sample points per frame
    const maxRadius = Math.min(this.centerX, this.centerY) * 0.8;
    const samplesPerFrame = 256; // Match euclidean reference
    
    // Create frame points array (like euclidean reference)
    const framePoints = [];
    
    for (let i = 0; i < Math.min(samplesPerFrame, this.bufferLength); i++) {
      let xSample = this.leftData[i];
      let ySample = this.rightData[i];
      
      // Clamp samples to avoid extreme values
      
      // Convert to screen coordinates with appropriate scaling
      // White noise: 1x amplification 
      // Formant synthesis: 0.3x amplification
      const amplification = this.calibrationMode ? 1.0 : 0.3;
      const x = this.centerX + (xSample * amplification * maxRadius);
      const y = this.centerY - (ySample * amplification * maxRadius); // Negative for correct orientation
      
      framePoints.push({ x, y });
    }
    
    // Draw the frame as a continuous path (euclidean style)
    if (framePoints.length >= 2) {
      this.ctx.strokeStyle = '#ffffff'; // White lines for clean visibility
      this.ctx.lineWidth = 1;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      
      this.ctx.beginPath();
      this.ctx.moveTo(framePoints[0].x, framePoints[0].y);
      
      for (let i = 1; i < framePoints.length; i++) {
        this.ctx.lineTo(framePoints[i].x, framePoints[i].y);
      }
      
      this.ctx.stroke();
    }
  }

  drawGrid() {
    // Clean background - no grid elements (like euclidean reference)
    // Just a plain dark background for minimal distraction
  }
}

// Initialize the synth client
const synthClient = new SynthClient();

// Make it globally available for debugging
window.synthClient = synthClient;