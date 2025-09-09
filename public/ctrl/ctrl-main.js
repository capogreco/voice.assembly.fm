/**
 * Voice.Assembly.FM Control Client Main Application
 */

import { WebRTCStar, generatePeerId } from '../../src/common/webrtc-star.js';
import { MessageTypes, MessageBuilder } from '../../src/common/message-protocol.js';

class ControlClient {
  constructor() {
    // Check for force takeover mode
    const urlParams = new URLSearchParams(window.location.search);
    this.forceTakeover = urlParams.get('force') === 'true';
    
    this.peerId = generatePeerId('ctrl');
    this.star = null;
    this.isCalibrationMode = false;
    this.isManualMode = false;
    
    // Calibration settings
    this.calibrationAmplitude = 0.1;
    
    // Phasor state
    this.phasor = 0.0;              // Current phasor position (0.0 to 1.0)
    this.cpm = 30;                  // Cycles per minute
    this.stepsPerCycle = 16;        // Number of steps per cycle
    this.cycleLength = 2.0;         // Seconds per cycle (calculated from CPM)
    this.lastPhasorTime = 0;        // For delta time calculation
    this.phasorUpdateId = null;     // RequestAnimationFrame ID
    this.lastBroadcastTime = 0;     // For phasor broadcast rate limiting
    this.phasorBroadcastRate = 30;  // Hz - how often to broadcast phasor
    
    // ES-8 Integration
    this.audioContext = null;       // AudioContext for ES-8 CV output
    this.es8Enabled = false;        // Enable/disable ES-8 output
    this.cvOutputs = {};            // CV output nodes (8 channels)
    this.gateOutputs = {};          // Gate output nodes
    
    
    // UI Elements
    this.elements = {
      connectionStatus: document.getElementById('connection-status'),
      connectionValue: document.getElementById('connection-value'),
      peersStatus: document.getElementById('peers-status'),
      peersValue: document.getElementById('peers-value'),
      
      calibrationBtn: document.getElementById('calibration-btn'),
      manualModeBtn: document.getElementById('manual-mode-btn'),
      
      // Musical controls
      // Simplified musical controls
      frequencySlider: document.getElementById('frequency-slider'),
      frequencyValue: document.getElementById('frequency-value'),
      
      // Phasor controls
      cpmSlider: document.getElementById('cpm-slider'),
      cpmValue: document.getElementById('cpm-value'),
      stepsPerCycleSlider: document.getElementById('steps-per-cycle-slider'),
      stepsPerCycleValue: document.getElementById('steps-per-cycle-value'),
      phasorDisplay: document.getElementById('phasor-display'),
      phasorBar: document.getElementById('phasor-bar'),
      
      // ES-8 controls
      es8EnableBtn: document.getElementById('es8-enable-btn'),
      
      peerList: document.getElementById('peer-list'),
      debugLog: document.getElementById('debug-log'),
      clearLogBtn: document.getElementById('clear-log-btn')
    };
    
    this.setupEventHandlers();
    this.calculateCycleLength();
    this.initializePhasor();
    this.log('Control client initialized', 'info');
    
    // Auto-connect on page load
    this.connectToNetwork();
  }

  setupEventHandlers() {
    
    // Calibration
    this.elements.calibrationBtn.addEventListener('click', () => this.toggleCalibration());
    
    // Manual mode
    this.elements.manualModeBtn.addEventListener('click', () => this.toggleManualMode());
    
    // Debug log
    this.elements.clearLogBtn.addEventListener('click', () => this.clearLog());
    
    // Musical controls
    this.setupMusicalControls();
  }
  
  setupMusicalControls() {
    // Frequency slider
    this.elements.frequencySlider.addEventListener('input', (e) => {
      const frequency = parseFloat(e.target.value);
      this.elements.frequencyValue.textContent = `${frequency} Hz`;
      this.broadcastMusicalParameters();
    });
    
    // Vowel X slider
    document.getElementById('vowelX-slider').addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      document.getElementById('vowelX-value').textContent = value.toFixed(2);
      this.broadcastMusicalParameters();
    });
    
    // Vowel Y slider
    document.getElementById('vowelY-slider').addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      document.getElementById('vowelY-value').textContent = value.toFixed(2);
      this.broadcastMusicalParameters();
    });
    
    // Zing Morph slider
    document.getElementById('zingMorph-slider').addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      document.getElementById('zingMorph-value').textContent = value.toFixed(2);
      this.broadcastMusicalParameters();
    });
    
    // Symmetry slider
    document.getElementById('symmetry-slider').addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      document.getElementById('symmetry-value').textContent = value.toFixed(2);
      this.broadcastMusicalParameters();
    });
    
    // Amplitude slider
    document.getElementById('amplitude-slider').addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      document.getElementById('amplitude-value').textContent = value.toFixed(2);
      this.broadcastMusicalParameters();
    });
    
    // Zing Amount slider (master blend control)
    document.getElementById('zingAmount-slider').addEventListener('input', (e) => {
      const zingAmount = parseFloat(e.target.value);
      document.getElementById('zingAmount-value').textContent = zingAmount.toFixed(2);
      this.broadcastMusicalParameters();
    });
    
    // CPM slider
    if (this.elements.cpmSlider) {
      this.elements.cpmSlider.addEventListener('input', (e) => {
        this.cpm = parseFloat(e.target.value);
        this.elements.cpmValue.textContent = `${this.cpm} CPM`;
        this.calculateCycleLength();
        this.log(`CPM changed to ${this.cpm}`, 'info');
      });
    }
    
    // Steps per cycle slider
    if (this.elements.stepsPerCycleSlider) {
      this.elements.stepsPerCycleSlider.addEventListener('input', (e) => {
        this.stepsPerCycle = parseFloat(e.target.value);
        this.elements.stepsPerCycleValue.textContent = `${this.stepsPerCycle} steps`;
        this.log(`Steps per cycle changed to ${this.stepsPerCycle}`, 'info');
      });
    }
    
    // ES-8 enable button
    if (this.elements.es8EnableBtn) {
      this.elements.es8EnableBtn.addEventListener('click', () => this.toggleES8());
    }
  }
  
  
  getMusicalParameters() {
    const frequencyValue = parseFloat(this.elements.frequencySlider.value);
    const vowelXValue = parseFloat(document.getElementById('vowelX-slider').value);
    const vowelYValue = parseFloat(document.getElementById('vowelY-slider').value);
    const zingMorphValue = parseFloat(document.getElementById('zingMorph-slider').value);
    const symmetryValue = parseFloat(document.getElementById('symmetry-slider').value);
    const amplitudeValue = parseFloat(document.getElementById('amplitude-slider').value);
    const zingAmountValue = parseFloat(document.getElementById('zingAmount-slider').value);
    
    return {
        frequency: isNaN(frequencyValue) ? 220 : frequencyValue,
        vowelX: isNaN(vowelXValue) ? 0.5 : vowelXValue,
        vowelY: isNaN(vowelYValue) ? 0.5 : vowelYValue,
        zingMorph: isNaN(zingMorphValue) ? 0 : zingMorphValue,
        symmetry: isNaN(symmetryValue) ? 0.5 : symmetryValue,
        amplitude: isNaN(amplitudeValue) ? 1.0 : amplitudeValue,
        zingAmount: isNaN(zingAmountValue) ? 0 : zingAmountValue,
        isManualMode: this.isManualMode,
    };
  }

  broadcastMusicalParameters() {
    if (!this.star) return;
    
    const params = this.getMusicalParameters();
    const message = MessageBuilder.musicalParameters(params);
    
    
    // Send to all connected synth peers
    const sent = this.star.broadcastToType('synth', message, 'control');
  }

  // Phasor Management Methods
  calculateCycleLength() {
    // Calculate cycle length: 60 seconds/minute / CPM
    // Example: 30 CPM = 60/30 = 2.0 seconds per cycle
    this.cycleLength = 60.0 / this.cpm;
  }

  initializePhasor() {
    this.phasor = 0.0;
    this.lastPhasorTime = performance.now() / 1000.0;
    this.startPhasorUpdate();
    this.updatePhasorDisplay();
  }

  updatePhasor() {
    const currentTime = performance.now() / 1000.0;
    const deltaTime = currentTime - this.lastPhasorTime;
    
    // Update phasor
    const phasorIncrement = deltaTime / this.cycleLength;
    this.phasor += phasorIncrement;
    
    // Wrap around at 1.0
    if (this.phasor >= 1.0) {
      this.phasor -= 1.0;
    }
    
    this.lastPhasorTime = currentTime;
    this.updatePhasorDisplay();
    
    // Update ES-8 CV outputs
    this.updateES8Outputs();
    
    // Broadcast phasor at specified rate
    this.broadcastPhasor(currentTime);
  }

  updatePhasorDisplay() {
    if (this.elements.phasorDisplay) {
      this.elements.phasorDisplay.textContent = this.phasor.toFixed(3);
    }
    
    if (this.elements.phasorBar) {
      const percentage = (this.phasor * 100).toFixed(1);
      this.elements.phasorBar.style.width = `${percentage}%`;
    }
  }

  startPhasorUpdate() {
    const updateLoop = () => {
      this.updatePhasor();
      this.phasorUpdateId = requestAnimationFrame(updateLoop);
    };
    updateLoop();
  }

  stopPhasorUpdate() {
    if (this.phasorUpdateId) {
      cancelAnimationFrame(this.phasorUpdateId);
      this.phasorUpdateId = null;
    }
  }

  broadcastPhasor(currentTime) {
    if (!this.star) return;
    
    // Rate limiting - only broadcast at the specified rate
    const timeSinceLastBroadcast = currentTime - this.lastBroadcastTime;
    const broadcastInterval = 1.0 / this.phasorBroadcastRate;
    
    if (timeSinceLastBroadcast >= broadcastInterval) {
      const message = MessageBuilder.phasorSync(
        this.phasor,
        this.cpm,
        this.stepsPerCycle,
        this.cycleLength
      );
      
      const sent = this.star.broadcastToType('synth', message, 'sync');
      this.lastBroadcastTime = currentTime;
    }
  }

  // ES-8 Integration Methods
  async toggleES8() {
    this.es8Enabled = !this.es8Enabled;
    
    if (this.es8Enabled) {
      await this.initializeES8();
      this.elements.es8EnableBtn.textContent = 'Disable ES-8';
      this.elements.es8EnableBtn.classList.add('primary');
      this.log('ES-8 enabled - CV output active', 'success');
    } else {
      this.shutdownES8();
      this.elements.es8EnableBtn.textContent = 'Enable ES-8';
      this.elements.es8EnableBtn.classList.remove('primary');
      this.log('ES-8 disabled', 'info');
    }
  }

  async initializeES8() {
    try {
      // Create audio context if not exists
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      
      // Resume if suspended
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      
      // Create CV and gate outputs for ES-8 (8 channels)
      this.createES8Outputs();
      
      this.log('ES-8 audio context initialized', 'info');
      
    } catch (error) {
      this.log(`ES-8 initialization failed: ${error.message}`, 'error');
      this.es8Enabled = false;
    }
  }

  createES8Outputs() {
    // Create 8 channels for ES-8 output
    for (let i = 0; i < 8; i++) {
      // CV output (constant source + gain for voltage control)
      const cvSource = this.audioContext.createConstantSource();
      const cvGain = this.audioContext.createGain();
      
      cvSource.connect(cvGain);
      cvGain.connect(this.audioContext.destination);
      cvSource.start();
      
      this.cvOutputs[i] = { source: cvSource, gain: cvGain };
    }
    
    // Initialize with basic pattern
    this.updateES8Outputs();
  }

  updateES8Outputs() {
    if (!this.es8Enabled || !this.audioContext) return;
    
    const now = this.audioContext.currentTime;
    
    // Channel 0: Phasor CV (0-5V scale)
    const phasorCV = this.phasor * 5.0; // 0.0-1.0 → 0-5V
    this.cvOutputs[0].gain.gain.setValueAtTime(phasorCV, now);
    
    // Channel 1: Beat clock (square wave)
    const beatsPerCycle = this.beatsPerCycle;
    const currentBeat = Math.floor(this.phasor * beatsPerCycle);
    const beatPhase = (this.phasor * beatsPerCycle) % 1.0;
    
    // Gate high for first half of each beat
    const gateValue = beatPhase < 0.5 ? 5.0 : 0.0;
    this.cvOutputs[1].gain.gain.setValueAtTime(gateValue, now);
    
    // Channel 2: Downbeat trigger (high only on cycle start)
    const downbeatValue = (currentBeat === 0 && beatPhase < 0.1) ? 5.0 : 0.0;
    this.cvOutputs[2].gain.gain.setValueAtTime(downbeatValue, now);
  }

  shutdownES8() {
    // Stop all CV outputs
    Object.values(this.cvOutputs).forEach(output => {
      if (output.source) {
        output.source.stop();
      }
    });
    
    this.cvOutputs = {};
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  async connectToNetwork() {
    try {
      this.updateConnectionStatus('connecting');
      
      this.log('Connecting to network...', 'info');
      
      // Create star network
      this.star = new WebRTCStar(this.peerId, 'ctrl');
      this.setupStarEventHandlers();
      
      // Connect to signaling server - use current host
      const signalingUrl = `ws://${window.location.hostname}:8000/ws`;
      await this.star.connect(signalingUrl, this.forceTakeover);
      
      
      this.updateConnectionStatus('connected');
      this._updateUIState();
      
      this.log('Connected to network successfully', 'success');
      
    } catch (error) {
      this.log(`Connection failed: ${error.message}`, 'error');
      this.updateConnectionStatus('disconnected');
      this._updateUIState();
    }
  }


  _updateUIState() {
    const isConnected = this.star && this.star.isConnectedToSignaling;
    
    // Update any remaining UI state based on connection
  }

  setupStarEventHandlers() {
    this.star.addEventListener('became-leader', () => {
      this.log('Became network leader', 'success');
      this._updateUIState();
    });
    
    this.star.addEventListener('peer-connected', (event) => {
      const { peerId } = event.detail;
      this.log(`Peer connected: ${peerId}`, 'info');
      this.updatePeerList();
      this._updateUIState();
      
      // Send complete current state to new synths
      if (peerId.startsWith('synth-')) {
        this.sendCompleteStateToSynth(peerId);
      }
    });
    
    this.star.addEventListener('peer-removed', (event) => {
      this.log(`Peer disconnected: ${event.detail.peerId}`, 'info');
      this.updatePeerList();
      this._updateUIState();
    });
    
    this.star.addEventListener('kicked', (event) => {
      this.log(`Kicked: ${event.detail.reason}`, 'error');
      this.updateConnectionStatus('error');
      this._updateUIState();
      alert('You have been disconnected: Another control client has taken over.');
    });
    
    this.star.addEventListener('join-rejected', (event) => {
      this.log(`Cannot join: ${event.detail.reason}`, 'error');
      this.updateConnectionStatus('error');
      this._updateUIState();
      
      if (event.detail.reason.includes('Add ?force=true')) {
        if (confirm('Another control client is already connected. Force takeover?')) {
          window.location.href = window.location.href + '?force=true';
        }
      }
    });
    
    this.star.addEventListener('data-message', (event) => {
      const { peerId, channelType, message } = event.detail;
      
      // Handle ping messages
      if (message.type === MessageTypes.PING) {
        const pong = MessageBuilder.pong(message.id, message.timestamp);
        this.star.sendToPeer(peerId, pong, 'sync');
      }
      
      // Log other messages for debugging
      if (message.type !== MessageTypes.PING && message.type !== MessageTypes.PONG) {
        this.log(`Received ${message.type} from ${peerId}`, 'debug');
      }
    });
  }



  toggleCalibration() {
    this.isCalibrationMode = !this.isCalibrationMode;
    
    
    if (this.isCalibrationMode) {
      this.elements.calibrationBtn.textContent = 'Disable Calibration Mode';
      this.elements.calibrationBtn.classList.add('primary');
      this.log('Calibration mode enabled', 'info');
    } else {
      this.elements.calibrationBtn.textContent = 'Enable Calibration Mode';
      this.elements.calibrationBtn.classList.remove('primary');
      this.log('Calibration mode disabled', 'info');
    }
    
    // Broadcast calibration mode to all peers
    if (this.star) {
      const message = MessageBuilder.calibrationMode(this.isCalibrationMode);
      const sent = this.star.broadcast(message, 'control');
      this.log(`Broadcast calibration mode to ${sent} peers`, 'debug');
    }
  }

  toggleManualMode() {
    this.isManualMode = !this.isManualMode;
    
    if (this.isManualMode) {
      this.elements.manualModeBtn.textContent = 'Stop Test';
      this.elements.manualModeBtn.classList.add('active');
      this.log('Test audio enabled - real-time parameter control active', 'info');
    } else {
      this.elements.manualModeBtn.textContent = 'Test Audio';
      this.elements.manualModeBtn.classList.remove('active');
      this.log('Test audio disabled', 'info');
    }
    
    // Immediately broadcast parameters with new mode
    this.broadcastMusicalParameters();
  }



  sendCompleteStateToSynth(synthId) {
    this.log(`Sending complete state to new synth: ${synthId}`, 'info');
    
    // 1. Send calibration mode if active
    if (this.isCalibrationMode) {
      const calibrationMsg = MessageBuilder.calibrationMode(
        this.isCalibrationMode,
        this.calibrationAmplitude
      );
      const success = this.star.sendToPeer(synthId, calibrationMsg, 'control');
      if (success) {
        this.log(`✅ Sent calibration mode to ${synthId}`, 'debug');
      } else {
        this.log(`❌ Failed to send calibration mode to ${synthId}`, 'error');
      }
    }
    
    // 2. Send current musical parameters (includes test mode state)
    const params = this.getMusicalParameters();
    const musicalMsg = MessageBuilder.musicalParameters(params);
    const musicalSuccess = this.star.sendToPeer(synthId, musicalMsg, 'control');
    if (musicalSuccess) {
      this.log(`✅ Sent musical parameters to ${synthId} (test mode: ${params.isManualMode})`, 'debug');
    } else {
      this.log(`❌ Failed to send musical parameters to ${synthId}`, 'error');
    }
  }


  updateConnectionStatus(status) {
    const statusElement = this.elements.connectionStatus;
    const valueElement = this.elements.connectionValue;
    
    statusElement.classList.remove('connected', 'syncing');
    
    switch (status) {
      case 'connected':
        valueElement.textContent = 'Connected';
        statusElement.classList.add('connected');
        break;
      case 'connecting':
        valueElement.textContent = 'Connecting...';
        statusElement.classList.add('syncing');
        break;
      default:
        valueElement.textContent = 'Disconnected';
    }
  }

  updatePeerCount(count) {
    this.elements.peersValue.textContent = count.toString();
    
    // Update peers status color
    if (count > 0) {
      this.elements.peersStatus.classList.add('connected');
    } else {
      this.elements.peersStatus.classList.remove('connected');
    }
  }

  updateTimingStatus(isRunning) {
    const statusElement = this.elements.timingStatus;
    const valueElement = this.elements.timingValue;
    
    if (isRunning) {
      valueElement.textContent = 'Running';
      statusElement.classList.add('syncing');
    } else {
      valueElement.textContent = 'Stopped';
      statusElement.classList.remove('syncing');
    }
  }

  updatePhasorVisualization(phasor) {
    const percentage = (phasor * 100).toFixed(1);
    this.elements.phasorBar.style.width = `${percentage}%`;
    this.elements.phasorText.textContent = phasor.toFixed(3);
  }

  updatePeerList() {
    if (!this.star) {
      this.clearPeerList();
      return;
    }
    
    const stats = this.star.getNetworkStats();
    const peers = Object.keys(stats.peerStats);
    
    this.updatePeerCount(peers.length);
    
    if (peers.length === 0) {
      this.clearPeerList();
      return;
    }
    
    const listHTML = peers.map(peerId => {
      const peerStats = stats.peerStats[peerId];
      const peerType = peerStats.peerType || peerId.split('-')[0]; // Use stored type or extract from peerId
      
      return `
        <div class="peer-item">
          <div class="peer-info">
            <div class="peer-id">${peerId}</div>
            <div class="peer-type">${peerType}</div>
          </div>
          <div class="peer-stats">
            <div>Status: ${peerStats.connectionState}</div>
          </div>
        </div>
      `;
    }).join('');
    
    this.elements.peerList.innerHTML = listHTML;
  }

  clearPeerList() {
    this.elements.peerList.innerHTML = `
      <div style="color: #888; font-style: italic; text-align: center; padding: 20px;">
        No peers connected
      </div>
    `;
  }

  log(message, level = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = {
      'info': 'ℹ️',
      'success': '✅', 
      'error': '❌',
      'debug': '🔍'
    }[level] || 'ℹ️';
    
    const logEntry = `[${timestamp}] ${prefix} ${message}\n`;
    this.elements.debugLog.textContent += logEntry;
    this.elements.debugLog.scrollTop = this.elements.debugLog.scrollHeight;
    
    // Also log to console
  }

  clearLog() {
    this.elements.debugLog.textContent = '';
  }
}

// Initialize the control client
const controlClient = new ControlClient();

// Make it globally available for debugging
window.controlClient = controlClient;