/**
 * Voice.Assembly.FM Synth Client Main Application
 */

import { WebRTCStar, generatePeerId } from '../../src/common/webrtc-star.js';
import { ClientPhasorSynchronizer } from '../../src/common/phasor-sync.js';
import { MessageTypes, MessageBuilder } from '../../src/common/message-protocol.js';
import { ZingSynthesisService } from './src/synthesis/zing-synthesis-service.js';

class SynthClient {
  constructor() {
    this.peerId = generatePeerId('synth');
    this.star = null;
    this.phasorSync = null;
    this.audioContext = null;
    this.oscilloscope = null;
    
    // Audio synthesis
    this.masterGain = null;
    this.zingSynth = null;
    this.isCalibrationMode = false;
    this.noiseNode = null;
    
    // UI state
    this.currentState = 'join'; // 'join', 'connecting', 'active'
    this.volume = 0.1;
    
    // UI Elements
    this.elements = {
      joinState: document.getElementById('join-state'),
      activeState: document.getElementById('active-state'),
      joinButton: document.getElementById('join-button'),
      connectionStatus: document.getElementById('connection-status'),
      loading: document.getElementById('loading'),
      canvas: document.getElementById('oscilloscope-canvas')
    };
    
    this.setupEventHandlers();
    console.log(`🎤 Synth client initialized: ${this.peerId}`);
    
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
    
    // Initialize zing synthesis
    await this.initializeZingSynthesis();
    
    // Apply any pending calibration state
    if (this.isCalibrationMode) {
      console.log('🔧 Applying pending calibration mode');
      
      // Disconnect zing synthesis during calibration
      if (this.zingGain) {
        this.zingGain.disconnect();
      }
      
      this.startWhiteNoise(0.1);
      this.updateConnectionStatus('syncing', 'Calibration mode');
    }
    
    console.log('🔊 Audio context initialized');
  }

  async initializeZingSynthesis() {
    console.log('🎵 Initializing zing synthesis...');
    
    this.zingSynth = new ZingSynthesisService(this.audioContext);
    
    try {
      this.zingNode = await this.zingSynth.initialize();
      
      // Create separate gain node for zing synthesis to control independently
      this.zingGain = this.audioContext.createGain();
      this.zingGain.gain.setValueAtTime(1, this.audioContext.currentTime);
      
      this.zingNode.connect(this.zingGain);
      this.zingGain.connect(this.masterGain);
      
      console.log('🎤 Zing synthesis initialized and connected');
    } catch (error) {
      console.error('❌ Failed to initialize zing synthesis:', error);
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
      const { phasor, health } = event.detail;
      
      // Update connection status based on sync health
      if (health.confidence > 0.5) {
        this.updateConnectionStatus('syncing', `Synced (${phasor.toFixed(3)})`);
      }
      
      // Update zing synthesis based on phasor
      if (this.zingSynth && this.zingSynth.isReady() && !this.isCalibrationMode) {
        // Map phasor to frequency and vowel position
        const baseFreq = 220;
        const freq = baseFreq + (phasor * 220); // Sweep from 220Hz to 440Hz
        
        // Map phasor to vowel space (u -> ɔ -> i -> æ cycle)
        const vowelX = (Math.sin(phasor * Math.PI * 2) + 1) / 2; // 0-1 oscillation
        const vowelY = (Math.cos(phasor * Math.PI * 2) + 1) / 2; // 0-1 oscillation
        
        this.zingSynth.setFrequency(freq);
        this.zingSynth.setVowelPosition(vowelX, vowelY);
        this.zingSynth.setGain(0.3); // Active synthesis
      }
    });
    
    this.phasorSync.addEventListener('cycle-start', (event) => {
      console.log(`🔄 Cycle start: ${event.detail.phasor.toFixed(3)}`);
    });
    
    this.phasorSync.addEventListener('sync-lost', (event) => {
      console.warn('⚠️ Lost synchronization with master');
      this.updateConnectionStatus('error', 'Sync lost');
      
      // Disconnect zing synthesis
      if (this.zingGain) {
        this.zingGain.disconnect();
      }
    });
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
      
      // Disconnect zing synthesis during calibration
      if (this.zingGain) {
        this.zingGain.disconnect();
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
      
      // Reconnect zing synthesis to master gain
      if (this.zingGain) {
        this.zingGain.connect(this.masterGain);
      }
      
      // Reconnect oscilloscope to zing synthesis
      this.connectOscilloscopeToZing();
      
      // Zing synthesis will resume automatically via phasor sync
      this.updateConnectionStatus('connected', 'Connected');
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
      
      console.log('🎵 White noise started');
      
      // Disconnect zing synthesis during calibration
      if (this.zingGain) {
        this.zingGain.disconnect();
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
    } else if (this.zingSynth && this.zingSynth.isReady()) {
      this.connectOscilloscopeToZing();
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

  connectOscilloscopeToZing() {
    if (!this.oscilloscope || !this.zingNode) return;
    
    console.log('🔬 Connecting oscilloscope to zing synthesis formant channels');
    
    // Disconnect current oscilloscope connections
    this.oscilloscope.disconnect();
    
    // Set normal amplification for formant visualization
    this.oscilloscope.calibrationMode = false;
    
    // Create channel splitter for 6-channel zing output
    if (this.zingSplitter) {
      this.zingSplitter.disconnect();
    }
    this.zingSplitter = this.audioContext.createChannelSplitter(6);
    this.zingNode.connect(this.zingSplitter);
    
    // Connect F1 (channel 2) to left, F2 (channel 3) to right for XY scope
    this.zingSplitter.connect(this.oscilloscope.leftAnalyser, 2);  // F1 -> X axis
    this.zingSplitter.connect(this.oscilloscope.rightAnalyser, 3); // F2 -> Y axis
    
    // Note: We don't reconnect masterGain to oscilloscope.channelSplitter 
    // because we're using direct formant channel connections
  }
  
  connectOscilloscopeToWhiteNoise() {
    if (!this.oscilloscope || !this.whiteNoiseWorklet) return;
    
    console.log('🔬 Connecting oscilloscope to white noise');
    
    // Disconnect any zing connections
    if (this.zingSplitter) {
      this.zingSplitter.disconnect();
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
      xSample = Math.max(-1, Math.min(1, xSample));
      ySample = Math.max(-1, Math.min(1, ySample));
      
      // Convert to screen coordinates with appropriate scaling
      // White noise: 1x amplification (10x smaller than before)
      // Formant synthesis: 0.6x amplification (2x larger than before)
      const amplification = this.calibrationMode ? 1.0 : 0.6;
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