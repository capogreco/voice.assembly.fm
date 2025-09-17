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
    this.formantNode = null; // Legacy - will be replaced by voiceNode
    this.voiceNode = null;   // New voice worklet for pure DSP
    this.programNode = null; // New program worklet for timing/control
    this.isCalibrationMode = false;
    this.synthesisActive = false; // Track if synthesis is active
    this.noiseNode = null;
    
    // Parameter output mapping for routing
    this.paramOutputMapping = {
      frequency: 0,
      zingMorph: 1,
      zingAmount: 2,
      vowelX: 3,
      vowelY: 4,
      symmetry: 5,
      amplitude: 6
    };
    
    // Audio graph components for parameter routing
    this.parameterSwitches = null;
    this.channelSplitter = null;
    this.channelMerger = null;
    
    // UI state
    this.currentState = 'join'; // 'join', 'connecting', 'active'
    this.volume = 0.1;
    
    // Store received state for application after audio init
    this.lastSynthParams = null;
    
    // Program configuration
    this.program = null;
    this.randomSeed = this.hashString(this.peerId); // Unique seed per synth
    
    // Phasor synchronization
    this.receivedPhasor = 0.0;
    this.receivedBpm = 120;
    this.receivedBeatsPerCycle = 4;
    this.receivedCycleLength = 2.0;
    this.lastPhasorMessage = 0;
    this.phasorRate = 0.5;              // Phasor increment per second (1.0 / cycleLength)
    this.interpolatedPhasor = 0.0;      // Current interpolated phasor value
    this.phasorUpdateId = null;         // RequestAnimationFrame ID for interpolation
    
    // AudioWorklet phasor
    this.phasorWorklet = null;          // AudioWorkletNode for sample-accurate phasor
    this.workletPhasor = 0.0;           // Current phasor from AudioWorklet
    
    // Screen wake lock
    this.wakeLock = null;
    
    // Long press handling
    this.longPressTimer = null;
    this.pressStartTime = 0;
    
    // PLL (Phase-Locked Loop) settings
    this.pllCorrectionFactor = 0.1;     // How aggressively to correct phase errors (0.1 = gentle)
    this.pllEnabled = true;             // Enable/disable phase correction
    
    // Look-ahead scheduler settings
    this.timingConfig = null;           // Official timing from controller
    this.schedulerLookahead = 0.1;      // Schedule ramps 100ms ahead
    this.schedulerInterval = 25;        // Check every 25ms
    this.nextCycleTime = null;          // When the next cycle should start
    this.schedulerTimerId = null;       // setTimeout ID for scheduler
    
    // Rhythm settings
    this.rhythmEnabled = false;         // Enable/disable rhythmic events
    this.stepsPerCycle = 16;            // Number of steps per cycle (16 = 16th notes)
    this.clickVolume = 0.3;             // Volume for rhythmic click sounds
    this.receivedBeatsPerCycle = 4;     // Store beats per cycle from ctrl for rhythm
    
    // UI Elements
    this.elements = {
      joinState: document.getElementById('join-state'),
      activeState: document.getElementById('active-state'),
      joinButton: document.getElementById('join-button'),
      connectionStatus: document.getElementById('connection-status'),
      synthId: document.getElementById('synth-id'),
      synthesisStatus: document.getElementById('synthesis-status'),
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
    this.setupKeyboardShortcuts();
    
    // Display synth ID (but it won't be visible until after joinChoir)
    this.updateSynthIdDisplay();
    
    // Auto-connect to network on page load
    this.autoConnect();
  }

  /**
   * Core routing logic - the "switchboard operator"
   * Manages whether parameters come from main thread or program worklet
   */
  _updateParameterRouting(paramName, mode) {
    if (!this.voiceNode || !this.programNode || !this.parameterSwitches) return;
    
    const gainNode = this.parameterSwitches[paramName];
    if (!gainNode) return;
    
    if (mode === 'direct') {
      // Turn off program worklet input for this parameter (use AudioParam)
      gainNode.gain.setTargetAtTime(0, this.audioContext.currentTime, 0.015);
      console.log(`🔌 Route for '${paramName}': Main Thread -> Voice`);
    } else { // mode is 'program'
      // Turn on program worklet input for this parameter
      gainNode.gain.setTargetAtTime(1, this.audioContext.currentTime, 0.015);
      console.log(`🔌 Route for '${paramName}': Program -> Voice`);
    }
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
    
    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
      this.cleanup();
    });
    
  }

  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
      // Only respond if no input fields are focused
      if (document.activeElement.tagName === 'INPUT') return;
      
      switch (event.key.toLowerCase()) {
        case 'r':
          if (this.audioContext) {
            this.toggleRhythm();
            event.preventDefault();
          }
          break;
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
      
      // Initialize oscilloscope and long press after DOM is updated
      // Use requestAnimationFrame to ensure DOM changes are applied
      requestAnimationFrame(() => {
        this.initializeOscilloscope();
        
        // Set up long press now that the synth-id is visible
        this.setupLongPress();
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
    
    // Load phasor AudioWorklet processor
    try {
      await this.audioContext.audioWorklet.addModule('./worklets/phasor-processor.worklet.js');
    } catch (error) {
      console.error('❌ Failed to load phasor processor:', error);
      throw error;
    }
    
    // Create master gain node
    this.masterGain = this.audioContext.createGain();
    this.masterGain.connect(this.audioContext.destination);
    this.updateVolume();
    
    // Create phasor worklet for sample-accurate timing
    this.initializePhasorWorklet();
    
    // Initialize formant synthesis
    await this.initializeFormantSynthesis();
    
    // Request screen wake lock to keep screen awake during performance
    await this.requestWakeLock();
    
    // Apply any pending calibration state
    if (this.isCalibrationMode) {
      
      // Disconnect voice synthesis during calibration
      if (this.voiceNode) {
        this.voiceNode.disconnect();
      }
      
      this.startWhiteNoise(0.1);
      this.updateConnectionStatus('syncing', 'Calibration mode');
    }
    
  }

  async initializeFormantSynthesis() {
    try {
      // Load both worklet modules
      await this.audioContext.audioWorklet.addModule('./worklets/program-worklet.js');
      await this.audioContext.audioWorklet.addModule('./worklets/voice-worklet.js');
      
      // Create program worklet with 7 outputs (one per parameter)
      this.programNode = new AudioWorkletNode(this.audioContext, 'program-worklet', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [7]  // frequency, zingMorph, zingAmount, vowelX, vowelY, symmetry, amplitude
      });
      
      // Create voice worklet with 5 channels output (main + duplicate + F1 + F2 + F3)
      this.voiceNode = new AudioWorkletNode(this.audioContext, 'voice-worklet', {
        numberOfInputs: 1,   // Accept control inputs from program worklet
        numberOfOutputs: 1,
        inputChannelCount: [7],   // 7 control channels from program worklet
        outputChannelCount: [5]   // Main, duplicate, F1, F2, F3
      });
      
      // Create gain node switches for each parameter channel
      this.parameterSwitches = {};
      this.channelSplitter = this.audioContext.createChannelSplitter(7);
      this.channelMerger = this.audioContext.createChannelMerger(7);
      
      // Connect program worklet to channel splitter
      this.programNode.connect(this.channelSplitter);
      
      // Create a gain node switch for each parameter
      const paramNames = ['frequency', 'zingMorph', 'zingAmount', 'vowelX', 'vowelY', 'symmetry', 'amplitude'];
      paramNames.forEach((paramName, index) => {
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = 0; // Default to off (direct mode)
        this.parameterSwitches[paramName] = gainNode;
        
        // Connect: splitter → gain switch → merger
        this.channelSplitter.connect(gainNode, index);
        gainNode.connect(this.channelMerger, 0, index);
      });
      
      // Connect merger to voice worklet
      this.channelMerger.connect(this.voiceNode);
      
      // Connect voice worklet to master gain
      this.voiceNode.connect(this.masterGain);
      
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
    
    // Apply synth parameters if they were received before audio was ready
    if (this.lastSynthParams) {
      console.log('🎵 Applying stored synth parameters');
      this.handleSynthParams(this.lastSynthParams);
    }
  }

  async connectToNetwork() {
    
    // Create star network
    this.star = new WebRTCStar(this.peerId, 'synth');
    this.setupStarEventHandlers();
    
    // Connect to signaling server - use current host
    // Dynamic WebSocket URL that works in production and development
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = window.location.port ? `:${window.location.port}` : '';
    const signalingUrl = `${protocol}//${window.location.hostname}${port}/ws`;
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
        
      case MessageTypes.SYNTH_PARAMS:
        this.handleSynthParams(message);
        break;

      case MessageTypes.PROGRAM_UPDATE:
        this.handleProgramUpdate(message);
        break;
      
      case MessageTypes.DIRECT_PARAM_UPDATE:
        this.handleDirectParamUpdate(message);
        break;
        
      case MessageTypes.PHASOR_SYNC:
        this.handlePhasorSync(message);
        break;
        
      case MessageTypes.PROGRAM:
        this.handleProgramConfig(message);
        break;
        
      default:
        break;
    }
  }

  handleCalibrationMode(message) {
    this.isCalibrationMode = message.enabled;
    
    if (this.isCalibrationMode) {
      
      // Disconnect voice synthesis during calibration
      if (this.voiceNode) {
        this.voiceNode.disconnect();
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
      
      // Reconnect voice synthesis to master gain
      if (this.voiceNode) {
        this.voiceNode.connect(this.masterGain);
      }
      
      // Reconnect oscilloscope to voice synthesis
      this.connectOscilloscopeToFormant();
      
      // Formant synthesis ready for parameter control
      this.updateConnectionStatus('connected', 'Connected');
    }
  }

  handleDirectParamUpdate(message) {
    console.log(`🎛️ Direct parameter update: ${message.param} = ${message.value}`);
    
    // Handle single direct parameter updates (e.g., from blur events)
    if (!this.isReadyToReceiveParameters()) {
      return;
    }

    this._updateParameterRouting(message.param, 'direct');
    
    if (this.voiceNode && this.voiceNode.parameters.has(`${message.param}_in`)) {
      const audioParam = this.voiceNode.parameters.get(`${message.param}_in`);
      audioParam.setTargetAtTime(message.value, this.audioContext.currentTime, 0.015);
      console.log(`🔌 Route for '${message.param}': Main Thread -> Voice`);
    }
  }

  isReadyToReceiveParameters() {
    if (!this.voiceNode || !this.programNode) {
      console.warn('⚠️ Cannot apply musical parameters: worklets not ready');
      return false;
    }
    
    if (this.isCalibrationMode) {
      return false;
    }
    
    return true;
  }

  handleSynthParams(message) {
    // Always store the latest parameters for application after audio init
    this.lastSynthParams = message;
    
    // Handle manual mode state changes
    const wasSynthesisActive = this.synthesisActive;
    this.synthesisActive = message.synthesisActive;
    
    // Update synthesis status display
    this.updateSynthesisStatus(this.synthesisActive);
    
    // If exiting manual mode, stop synthesis
    if (wasSynthesisActive && !this.synthesisActive) {
      if (this.voiceNode) {
        this.voiceNode.parameters.get('active').value = 0;
      }
      return;
    }
    
    // Check if we're ready to receive parameters
    if (!this.isReadyToReceiveParameters()) {
      return;
    }
    
    // If not in manual mode, don't apply parameters
    if (!this.synthesisActive) {
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
    
    // Legacy handleSynthParams - parameters now handled by PROGRAM_UPDATE
    console.log('⚠️ handleSynthParams is deprecated - use PROGRAM_UPDATE instead');
    
  }

  /**
   * OBSOLETE - Apply a parameter value that may be static or have envelope configuration
   * This method is deprecated in the two-worklet architecture
   */
  // applyParameterWithEnvelope(paramName, paramValue) {
  //   // Method removed - parameters now handled by direct routing or program worklet
  // }

  handleProgramUpdate(message) {
    console.log('📨 PROGRAM_UPDATE received:', message);
    if (!this.voiceNode || !this.programNode) {
      console.warn('⚠️ Cannot handle program update: worklets not ready');
      return;
    }

    const program = message;
    const programmaticConfigs = {};

    // Handle synthesis active state
    if (message.synthesisActive !== undefined) {
      if (this.voiceNode && this.voiceNode.parameters.has('active')) {
        const activeParam = this.voiceNode.parameters.get('active');
        activeParam.value = message.synthesisActive ? 1 : 0;
        console.log(`🎵 Synthesis ${message.synthesisActive ? 'enabled' : 'disabled'}`);
      }
    }

    for (const paramName in program) {
      // Skip non-parameter fields
      if (['type', 'timestamp', 'synthesisActive', 'isManualMode'].includes(paramName)) continue;
      
      const paramData = program[paramName];
      
      // Handle discriminated union format based on scope
      if (paramData.scope === 'direct') {
        this._updateParameterRouting(paramName, 'direct');
        
        if (this.voiceNode.parameters.has(`${paramName}_in`)) {
          const audioParam = this.voiceNode.parameters.get(`${paramName}_in`);
          audioParam.setTargetAtTime(paramData.directValue, this.audioContext.currentTime, 0.015);
          console.log(`🎚️ Applied direct parameter: ${paramName} = ${paramData.directValue}`);
        }
        
      } else if (paramData.scope === 'program') {
        this._updateParameterRouting(paramName, 'program');
        
        // Convert discriminated union to program worklet format
        if (paramData.interpolation === 'step') {
          // Step interpolation - constant values between EOCs
          programmaticConfigs[paramName] = {
            temporalBehavior: 'static',
            startValueGenerator: paramData.startValueGenerator
          };
          console.log(`🎯 Step interpolation for ${paramName}`);
        } else {
          // Linear/cosine/parabolic interpolation - envelope behavior
          programmaticConfigs[paramName] = {
            temporalBehavior: 'envelope',
            startValueGenerator: paramData.startValueGenerator,
            endValueGenerator: paramData.endValueGenerator,
            interpolationType: paramData.interpolation,
            intensity: paramData.intensity
          };
          console.log(`📈 ${paramData.interpolation} interpolation for ${paramName}`);
        }
      }
    }

    // Send programmatic configs to program worklet
    if (Object.keys(programmaticConfigs).length > 0) {
      this.programNode.port.postMessage({
        type: 'SET_PROGRAM',
        config: programmaticConfigs
      });
      console.log('✅ Forwarded programmatic configs to program worklet:', programmaticConfigs);
    }
  }

  // OBSOLETE - These methods were used by the old monolithic worklet
  // applyProgramUpdateFromWorklet(parameters) {
  //   // Method removed - worklet communication now handled differently
  // }

  // applyRandomizedParametersFromWorklet(parameters) {
  //   // Method removed - randomization now handled in program worklet
  // }

  handlePhasorSync(message) {
    this.receivedPhasor = message.phasor;
    this.receivedCpm = message.cpm;
    this.receivedStepsPerCycle = message.stepsPerCycle;
    this.receivedCycleLength = message.cycleLength;
    this.lastPhasorMessage = performance.now();
    
    // Calculate phasor rate
    this.phasorRate = 1.0 / this.receivedCycleLength;
    
    // Store official timing and start look-ahead scheduler if needed
    if (this.programNode) {
      console.log(`⏰ Received phasor sync: ${message.cpm} CPM`);
      
      // Check if timing has changed significantly
      const newTimingConfig = {
        cpm: message.cpm,
        stepsPerCycle: message.stepsPerCycle,
        cycleLength: message.cycleLength,
        phasor: message.phasor
      };
      
      const timingChanged = !this.timingConfig || 
        this.timingConfig.cpm !== newTimingConfig.cpm ||
        this.timingConfig.cycleLength !== newTimingConfig.cycleLength;
      
      // Store the new timing config
      this.timingConfig = newTimingConfig;
      
      // Only restart scheduler if timing changed or not running
      if (timingChanged || !this.schedulerTimerId) {
        console.log(`🔄 Timing changed or scheduler not running - restarting`);
        this._stopScheduler(); // Stop any existing scheduler
        this._startScheduler(); // Start new one
      }
    }
    
    // Update legacy phasor worklet (if still needed)
    this.updatePhasorWorklet();
    
    // Send phase correction to worklet (PLL behavior)
    this.sendPhaseCorrection();
    
    // Start interpolation if not already running (for fallback display)
    if (!this.phasorUpdateId) {
      this.startPhasorInterpolation();
    }
  }

  handleProgramConfig(message) {
    this.program = message.config;
    
    // Send config to program worklet for randomization handling
    if (this.programNode && this.program) {
      this.programNode.port.postMessage({
        type: 'SET_PROGRAM',
        config: this.program,
        synthId: this.peerId
      });
    }
  }

  startPhasorInterpolation() {
    const updateLoop = () => {
      this.updateInterpolatedPhasor();
      this.phasorUpdateId = requestAnimationFrame(updateLoop);
    };
    updateLoop();
  }

  updateInterpolatedPhasor() {
    const currentTime = performance.now();
    const timeSinceMessage = (currentTime - this.lastPhasorMessage) / 1000.0; // Convert to seconds
    
    // Interpolate phasor position
    this.interpolatedPhasor = this.receivedPhasor + (timeSinceMessage * this.phasorRate);
    
    // Wrap around at 1.0
    if (this.interpolatedPhasor >= 1.0) {
      this.interpolatedPhasor -= Math.floor(this.interpolatedPhasor);
    }
    
    // Update connection status display
    if (this.elements.connectionStatus) {
      this.elements.connectionStatus.textContent = `connected (${this.receivedBpm} bpm, ${this.receivedBeatsPerCycle}/cycle, φ=${this.interpolatedPhasor.toFixed(3)})`;
    }
  }

  stopPhasorInterpolation() {
    if (this.phasorUpdateId) {
      cancelAnimationFrame(this.phasorUpdateId);
      this.phasorUpdateId = null;
    }
  }

  initializePhasorWorklet() {
    try {
      // Create phasor AudioWorkletNode
      this.phasorWorklet = new AudioWorkletNode(this.audioContext, 'phasor-processor', {
        outputChannelCount: [1]
      });
      
      // Set initial cycle length
      this.phasorWorklet.parameters.get('cycleLength').value = this.receivedCycleLength;
      
      // Listen for phasor updates from the worklet
      this.phasorWorklet.port.onmessage = (event) => {
        if (event.data.type === 'phasor-update') {
          this.workletPhasor = event.data.phase;
          
          // Forward phasor to program worklet for envelope calculations
          if (this.programNode) {
            this.programNode.port.postMessage({
              type: 'PHASOR_UPDATE',
              phase: event.data.phase
            });
          }
          
          // Calculate phase error for display (optional monitoring)
          const currentTime = performance.now();
          const timeSinceMessage = (currentTime - this.lastPhasorMessage) / 1000.0;
          const expectedCtrlPhasor = (this.receivedPhasor + (timeSinceMessage * this.phasorRate)) % 1.0;
          const phaseError = this.calculatePhaseError(expectedCtrlPhasor, this.workletPhasor);
          
          // Update display to show worklet phasor with error info
          if (this.elements.connectionStatus) {
            const errorDisplay = Math.abs(phaseError) > 0.001 ? ` Δ${(phaseError * 1000).toFixed(0)}ms` : '';
            const rhythmDisplay = this.rhythmEnabled ? ' 🥁' : '';
            this.elements.connectionStatus.textContent = `connected (${this.receivedBpm} bpm, ${this.receivedBeatsPerCycle}/cycle, ♪=${this.workletPhasor.toFixed(3)}${errorDisplay}${rhythmDisplay})`;
          }
        } else if (event.data.type === 'step-trigger') {
          this.onStepTrigger(event.data.step, event.data.stepsPerCycle);
        }
      };
      
      // Start the worklet phasor
      this.phasorWorklet.port.postMessage({ type: 'start' });
      
      console.log('✅ Phasor worklet initialized');
      
    } catch (error) {
      console.error('❌ Failed to initialize phasor worklet:', error);
    }
  }

  updatePhasorWorklet() {
    if (this.phasorWorklet) {
      // Update cycle length and steps per cycle in worklet
      this.phasorWorklet.parameters.get('cycleLength').value = this.receivedCycleLength;
      this.phasorWorklet.parameters.get('stepsPerCycle').value = this.receivedStepsPerCycle;
    }
    
    // Also update program worklet with phasor timing
    if (this.programNode) {
      this.programNode.port.postMessage({
        type: 'SET_PHASOR',
        cpm: this.receivedCpm,
        stepsPerCycle: this.receivedStepsPerCycle,
        cycleLength: this.receivedCycleLength,
        phase: this.receivedPhasor
      });
    }
  }

  calculatePhaseError(targetPhase, currentPhase) {
    // Calculate phase error (accounting for wrap-around)
    let phaseError = targetPhase - currentPhase;
    
    // Handle wrap-around cases
    if (phaseError > 0.5) {
      phaseError -= 1.0;  // Target is behind, we're ahead
    } else if (phaseError < -0.5) {
      phaseError += 1.0;  // Target is ahead, we're behind
    }
    
    return phaseError;
  }



  _scheduler() {
    if (!this.timingConfig || !this.nextCycleTime) {
      return; // No timing config yet
    }

    const now = this.audioContext.currentTime;
    const timeUntilNextCycle = this.nextCycleTime - now;

    // If the next cycle is within our lookahead window, schedule it
    if (timeUntilNextCycle <= this.schedulerLookahead) {
      this._schedulePhaseRampAtTime(this.nextCycleTime);
      
      // Calculate the time for the cycle after that
      this.nextCycleTime += this.timingConfig.cycleLength;
      
      console.log(`⏰ Ramp PRE-SCHEDULED for ${this.nextCycleTime.toFixed(3)}s (${timeUntilNextCycle.toFixed(3)}s ahead)`);
    }

    // Schedule the next scheduler check
    this.schedulerTimerId = setTimeout(() => this._scheduler(), this.schedulerInterval);
  }

  _schedulePhaseRampAtTime(startTime) {
    if (!this.programNode || !this.timingConfig) return;

    const phaseParam = this.programNode.parameters.get('phase');
    const cycleDuration = this.timingConfig.cycleLength;
    const endTime = startTime + cycleDuration;

    // Schedule the ramp at the precise time
    phaseParam.setValueAtTime(0, startTime);
    phaseParam.linearRampToValueAtTime(1.0, endTime);
    
    console.log(`🎯 Ramp SCHEDULED: ${startTime.toFixed(3)}s → ${endTime.toFixed(3)}s`);
  }

  _startScheduler() {
    // Stop any existing scheduler
    if (this.schedulerTimerId) {
      clearTimeout(this.schedulerTimerId);
    }

    // Set the first cycle time and start the scheduler
    this.nextCycleTime = this.audioContext.currentTime + 0.1; // Start 100ms from now
    this._scheduler();
    
    console.log(`🎬 Look-ahead scheduler started, first cycle at ${this.nextCycleTime.toFixed(3)}s`);
  }

  _stopScheduler() {
    if (this.schedulerTimerId) {
      clearTimeout(this.schedulerTimerId);
      this.schedulerTimerId = null;
      console.log(`🛑 Look-ahead scheduler stopped`);
    }
  }

  sendPhaseCorrection() {
    if (!this.phasorWorklet || !this.pllEnabled) {
      return;
    }
    
    // Calculate what the ctrl's phasor should be right now
    const currentTime = performance.now();
    const timeSinceMessage = (currentTime - this.lastPhasorMessage) / 1000.0;
    const expectedCtrlPhasor = (this.receivedPhasor + (timeSinceMessage * this.phasorRate)) % 1.0;
    
    // Send phase correction to worklet
    this.phasorWorklet.port.postMessage({
      type: 'phase-correction',
      targetPhase: expectedCtrlPhasor,
      correctionFactor: this.pllCorrectionFactor
    });
  }

  onStepTrigger(stepNumber, stepsPerCycle) {
    if (!this.rhythmEnabled || !this.audioContext) {
      return;
    }
    
    // Generate a simple click sound for each step
    this.playClickSound(stepNumber, stepsPerCycle);
  }

  playClickSound(stepNumber, stepsPerCycle) {
    const now = this.audioContext.currentTime;
    
    // With CPM paradigm, we work directly with steps
    // High click at cycle start (step 0), low clicks on all other steps
    const isCycleStart = stepNumber === 0;
    
    // Play clicks on all steps
    
    // Create a simple click using oscillator + envelope
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    
    // High click for cycle start, low click for all other steps
    if (isCycleStart) {
      osc.frequency.value = 1200;  // High click for cycle start
      osc.type = 'sine';
    } else {
      osc.frequency.value = 600;   // Lower click for all other steps
      osc.type = 'triangle';
    }
    
    // Slightly different volumes
    const volume = isCycleStart ? this.clickVolume : this.clickVolume * 0.7;
    
    // Quick envelope for click sound
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    
    // Connect and play
    osc.connect(gain);
    gain.connect(this.masterGain);
    
    osc.start(now);
    osc.stop(now + 0.05);
  }

  toggleRhythm() {
    this.rhythmEnabled = !this.rhythmEnabled;
    
    if (this.phasorWorklet) {
      // Update worklet rhythm settings
      this.phasorWorklet.parameters.get('enableRhythm').value = this.rhythmEnabled ? 1 : 0;
      this.phasorWorklet.parameters.get('stepsPerCycle').value = this.stepsPerCycle;
    }
    
    console.log(`Rhythm ${this.rhythmEnabled ? 'enabled' : 'disabled'}`);
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
      
      
      // Disconnect voice synthesis during calibration
      if (this.voiceNode) {
        this.voiceNode.disconnect();
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
    } else if (this.voiceNode) {
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
    if (!this.oscilloscope || !this.voiceNode) return;
    
    
    // Disconnect current oscilloscope connections
    this.oscilloscope.disconnect();
    
    // Set normal amplification for formant visualization
    this.oscilloscope.calibrationMode = false;
    
    // Create channel splitter for 5-channel voice output
    if (this.formantSplitter) {
      this.formantSplitter.disconnect();
    }
    this.formantSplitter = this.audioContext.createChannelSplitter(5);
    this.voiceNode.connect(this.formantSplitter);
    
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

  updateSynthesisStatus(isActive) {
    const element = this.elements.synthesisStatus;
    if (!element) return;
    
    if (isActive) {
      element.classList.add('active');
      element.textContent = 'synthesis on';
    } else {
      element.classList.remove('active');
      element.textContent = 'synthesis off';
    }
  }

  updateSynthIdDisplay() {
    console.log('🔍 Updating synth ID display, element:', this.elements.synthId);
    if (this.elements.synthId) {
      // Extract just the last part of the peer ID for cleaner display
      const shortId = this.peerId.split('-').slice(-2).join('-');
      const rhythmIndicator = this.rhythmEnabled ? ' 🎵' : '';
      this.elements.synthId.textContent = shortId + rhythmIndicator;
      console.log('✅ Synth ID updated to:', shortId + rhythmIndicator);
      
      // Apply CSS class for visual indication
      if (this.rhythmEnabled) {
        this.elements.synthId.classList.add('rhythm-active');
      } else {
        this.elements.synthId.classList.remove('rhythm-active');
      }
    } else {
      console.error('❌ Synth ID element not found in updateSynthIdDisplay');
    }
  }

  setupLongPress() {
    const synthIdElement = this.elements.synthId;
    console.log('🔍 Setting up long press, synthId element:', synthIdElement);
    console.log('🔍 All elements:', this.elements);
    
    if (!synthIdElement) {
      console.error('❌ Synth ID element not found for long press setup');
      // Try to find the element directly
      const directElement = document.getElementById('synth-id');
      console.log('🔍 Trying direct getElementById:', directElement);
      if (directElement) {
        this.elements.synthId = directElement;
        this.setupLongPressOnElement(directElement);
      }
      return;
    }
    
    this.setupLongPressOnElement(synthIdElement);
  }

  setupLongPressOnElement(synthIdElement) {
    console.log('✅ Setting up long press on element:', synthIdElement);
    
    let pressTimer = null;
    let isLongPress = false;

    const startPress = (e) => {
      console.log('👆 Press started on synth ID');
      e.preventDefault();
      isLongPress = false;
      synthIdElement.classList.add('pressing');
      
      pressTimer = setTimeout(() => {
        console.log('⏰ Long press triggered - toggling rhythm');
        isLongPress = true;
        this.toggleRhythm();
        this.updateSynthIdDisplay();
        
        // Haptic feedback if available
        if (navigator.vibrate) {
          navigator.vibrate(50);
        }
      }, 500); // 500ms long press threshold
    };

    const endPress = (e) => {
      console.log('👆 Press ended on synth ID');
      e.preventDefault();
      synthIdElement.classList.remove('pressing');
      
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    const cancelPress = (e) => {
      console.log('❌ Press cancelled on synth ID');
      synthIdElement.classList.remove('pressing');
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    // Touch events
    synthIdElement.addEventListener('touchstart', startPress, { passive: false });
    synthIdElement.addEventListener('touchend', endPress, { passive: false });
    synthIdElement.addEventListener('touchcancel', cancelPress, { passive: false });
    synthIdElement.addEventListener('touchmove', cancelPress, { passive: false });

    // Mouse events (for desktop testing)
    synthIdElement.addEventListener('mousedown', startPress);
    synthIdElement.addEventListener('mouseup', endPress);
    synthIdElement.addEventListener('mouseleave', cancelPress);
    
    console.log('✅ Long press event listeners attached');
  }

  async requestWakeLock() {
    // Check if Wake Lock API is supported
    if (!('wakeLock' in navigator)) {
      console.log('⚠️ Wake Lock API not supported');
      return;
    }

    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      console.log('✅ Screen wake lock acquired');
      
      // Handle wake lock release
      this.wakeLock.addEventListener('release', () => {
        console.log('🔓 Screen wake lock released');
      });
      
      // Handle visibility changes to re-acquire wake lock
      document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));
      
    } catch (err) {
      console.error(`❌ Wake Lock failed: ${err.name}, ${err.message}`);
    }
  }

  async handleVisibilityChange() {
    if (this.wakeLock !== null && document.visibilityState === 'visible') {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        console.log('✅ Screen wake lock re-acquired after visibility change');
      } catch (err) {
        console.error(`❌ Wake Lock re-acquisition failed: ${err.name}, ${err.message}`);
      }
    }
  }

  releaseWakeLock() {
    if (this.wakeLock !== null) {
      this.wakeLock.release().then(() => {
        this.wakeLock = null;
        console.log('🔓 Screen wake lock manually released');
      });
    }
  }

  cleanup() {
    // Release wake lock
    this.releaseWakeLock();
    
    // Clean up WebRTC connections
    if (this.star) {
      this.star.cleanup();
    }
    
    // Stop audio worklets
    if (this.phasorWorklet) {
      this.phasorWorklet.disconnect();
    }
    
    if (this.voiceNode) {
      this.voiceNode.disconnect();
    }
    
    if (this.programNode) {
      this.programNode.disconnect();
    }
    
    this.stopWhiteNoise();
    
    console.log('🧹 Synth client cleaned up');
  }

  // Randomization utility methods
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  generateRandomValueInRange(min, max, key) {
    // Generate a deterministic but unique random value for this synth and parameter
    // Use a stable seed that doesn't change between parameter broadcasts
    const seed = this.randomSeed ^ this.hashString(key);
    const random = Math.abs(Math.sin(seed)) % 1;
    return min + (max - min) * random;
  }

}

/**
 * Simple XY Oscilloscope for visualizing formant outputs
 */

// Initialize the synth client
const synthClient = new SynthClient();

// Make it globally available for debugging
window.synthClient = synthClient;