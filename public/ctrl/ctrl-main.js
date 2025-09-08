/**
 * Voice.Assembly.FM Control Client Main Application
 */

import { WebRTCStar, generatePeerId } from '../../src/common/webrtc-star.js';
import { MasterPhasorController } from '../../src/common/phasor-sync.js';
import { MessageTypes, MessageBuilder } from '../../src/common/message-protocol.js';

class ControlClient {
  constructor() {
    // Check for force takeover mode
    const urlParams = new URLSearchParams(window.location.search);
    this.forceTakeover = urlParams.get('force') === 'true';
    
    this.peerId = generatePeerId('ctrl');
    this.star = null;
    this.phasorController = null;
    this.isCalibrationMode = false;
    this.isManualMode = false;
    
    // Track current settings to send to new synths
    this.currentSettings = {
      calibrationMode: false,
      calibrationAmplitude: 0.1,
      timingActive: false,
      cycleDuration: 2.0
    };
    
    // Store pending settings for peers whose control channels aren't ready yet
    this.pendingSettings = new Map();
    
    // UI Elements
    this.elements = {
      connectionStatus: document.getElementById('connection-status'),
      connectionValue: document.getElementById('connection-value'),
      peersStatus: document.getElementById('peers-status'),
      peersValue: document.getElementById('peers-value'),
      timingStatus: document.getElementById('timing-status'),
      timingValue: document.getElementById('timing-value'),
      
      startTimingBtn: document.getElementById('start-timing-btn'),
      stopTimingBtn: document.getElementById('stop-timing-btn'),
      calibrationBtn: document.getElementById('calibration-btn'),
      manualModeBtn: document.getElementById('manual-mode-btn'),
      
      cycleDuration: document.getElementById('cycle-duration'),
      phasorViz: document.getElementById('phasor-viz'),
      phasorBar: document.getElementById('phasor-bar'),
      phasorText: document.getElementById('phasor-text'),
      
      // Musical controls
      // Simplified musical controls
      frequencySlider: document.getElementById('frequency-slider'),
      frequencyValue: document.getElementById('frequency-value'),
      
      peerList: document.getElementById('peer-list'),
      debugLog: document.getElementById('debug-log'),
      clearLogBtn: document.getElementById('clear-log-btn')
    };
    
    this.setupEventHandlers();
    this.log('Control client initialized', 'info');
    
    // Auto-connect on page load
    this.connectToNetwork();
  }

  setupEventHandlers() {
    
    // Timing control
    this.elements.startTimingBtn.addEventListener('click', () => this.startTiming());
    this.elements.stopTimingBtn.addEventListener('click', () => this.stopTiming());
    
    // Calibration
    this.elements.calibrationBtn.addEventListener('click', () => this.toggleCalibration());
    
    // Manual mode
    this.elements.manualModeBtn.addEventListener('click', () => this.toggleManualMode());
    
    // Cycle duration updates
    this.elements.cycleDuration.addEventListener('change', () => {
      if (this.phasorController && this.phasorController.isRunning) {
        const duration = parseFloat(this.elements.cycleDuration.value);
        this.phasorController.setCycleDuration(duration);
      }
    });
    
    // Debug log
    this.elements.clearLogBtn.addEventListener('click', () => this.clearLog());
    
    // Musical controls
    this.setupMusicalControls();
  }
  
  setupMusicalControls() {
    // Frequency slider (remains simple)
    this.elements.frequencySlider.addEventListener('input', (e) => {
      const frequency = parseFloat(e.target.value);
      this.currentSettings.frequency = frequency;
      this.elements.frequencyValue.textContent = `${frequency} Hz`;
      this.broadcastMusicalParameters();
    });
    
    // Zing Amount slider (master blend control)
    document.getElementById('zingAmount-slider').addEventListener('input', (e) => {
      const zingAmount = parseFloat(e.target.value);
      const percentage = Math.round(zingAmount * 100);
      document.getElementById('zingAmount-value').textContent = `${percentage}%`;
      this.broadcastMusicalParameters();
    });
    
    // Setup envelope parameter controls
    this.setupParameterControls();
  }
  
  setupParameterControls() {
    const paramNames = ['vowelX', 'vowelY', 'zingMorph', 'symmetry', 'amplitude'];

    paramNames.forEach(name => {
        const staticCheckbox = document.getElementById(`${name}-static`);
        const valueControl = document.getElementById(`${name}-value`).parentElement;
        const envelopeControls = document.getElementById(`${name}-envelope`);

        // Function to toggle UI state
        const updateUIState = () => {
            if (staticCheckbox.checked) {
                valueControl.style.display = 'block';
                envelopeControls.disabled = true;
            } else {
                valueControl.style.display = 'none';
                envelopeControls.disabled = false;
            }
            this.broadcastMusicalParameters(); // Broadcast on change
        };

        // Add event listeners to all controls
        const controls = document.querySelectorAll(`#${name}-panel input, #${name}-panel select`);
        controls.forEach(control => {
            control.addEventListener('input', updateUIState);
        });

        // Special handling for value sliders in manual mode - immediate broadcast
        const valueSlider = document.getElementById(`${name}-value`);
        if (valueSlider) {
            valueSlider.addEventListener('input', () => {
                if (this.isManualMode) {
                    // In manual mode, broadcast immediately for real-time control
                    this.broadcastMusicalParameters();
                }
            });
        }

        // Initial UI setup
        updateUIState();
    });
  }
  
  getMusicalParameters() {
    const params = {
        frequency: parseFloat(this.elements.frequencySlider.value) || 220,
        zingAmount: parseFloat(document.getElementById('zingAmount-slider').value) || 0.5,
    };
    const paramNames = ['vowelX', 'vowelY', 'zingMorph', 'symmetry', 'amplitude'];

    paramNames.forEach(name => {
        const staticCheckbox = document.getElementById(`${name}-static`);
        const valueInput = document.getElementById(`${name}-value`);
        
        if (this.isManualMode) {
          // In manual mode, force static and use the value slider for real-time control
          params[name] = {
            static: true,
            value: parseFloat(valueInput.value),
            start: parseFloat(valueInput.value), // Use current value as start too
            end: parseFloat(valueInput.value),   // Use current value as end too
            type: 'linear',
            morph: 0.5,
          };
        } else {
          // Normal envelope mode
          params[name] = {
            static: staticCheckbox.checked,
            value: parseFloat(valueInput.value),
            start: parseFloat(document.getElementById(`${name}-start`).value),
            end: parseFloat(document.getElementById(`${name}-end`).value),
            type: document.getElementById(`${name}-type`).value,
            morph: parseFloat(document.getElementById(`${name}-morph`).value),
          };
        }
    });
    return params;
  }

  broadcastMusicalParameters() {
    if (!this.star) return;
    
    const params = this.getMusicalParameters();
    const message = MessageBuilder.musicalParameters(params);
    
    console.log('🎵 Broadcasting musical parameters:', params);
    
    // Send to all connected synth peers
    const sent = this.star.broadcastToType('synth', message, 'control');
    console.log(`📤 Sent to ${sent} synth peers`);
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
      
      // Create phasor controller
      this.phasorController = new MasterPhasorController(this.star);
      this.setupPhasorEventHandlers();
      
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
    const isTiming = this.phasorController && this.phasorController.isRunning;

    // Timing buttons are enabled only when connected, and toggle based on timing state.
    this.elements.startTimingBtn.disabled = !isConnected || isTiming;
    this.elements.stopTimingBtn.disabled = !isConnected || !isTiming;
    
    // Update status text
    if (isConnected) {
        this.elements.timingValue.textContent = isTiming ? 'Running' : 'Stopped';
    } else {
        this.elements.timingValue.textContent = 'N/A';
    }
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
      
      // Send current musical parameters to new synths
      if (peerId.startsWith('synth-')) {
        this.log(`Sending current state to new synth: ${peerId}`, 'info');
        const params = this.getMusicalParameters();
        const message = MessageBuilder.musicalParameters(params);
        this.star.sendToPeer(peerId, message, 'control');
      }
    });
    
    // Listen for control channel opening to send pending settings
    this.star.addEventListener('channel-opened', (event) => {
      const { peerId, channelType } = event.detail;
      if (channelType === 'control' && peerId.startsWith('synth-') && this.pendingSettings.has(peerId)) {
        const settings = this.pendingSettings.get(peerId);
        this.pendingSettings.delete(peerId);
        this.log(`Control channel opened for ${peerId}, sending pending settings`, 'debug');
        this.sendSettingsToSynth(peerId, settings);
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

  setupPhasorEventHandlers() {
    this.phasorController.addEventListener('started', () => {
      this.updateTimingStatus(true);
      this.elements.startTimingBtn.disabled = true;
      this.elements.stopTimingBtn.disabled = false;
      this.log('Timing started', 'success');
    });
    
    this.phasorController.addEventListener('stopped', () => {
      this.updateTimingStatus(false);
      this.elements.startTimingBtn.disabled = false;
      this.elements.stopTimingBtn.disabled = true;
      this.log('Timing stopped', 'info');
    });
    
    this.phasorController.addEventListener('cycle-start', (event) => {
      this.log(`Cycle start: ${event.detail.phasor.toFixed(3)}`, 'debug');
    });
    
    this.phasorController.addEventListener('phasor-update', (event) => {
      this.updatePhasorVisualization(event.detail.phasor);
    });
  }

  startTiming() {
    if (this.phasorController) {
      const duration = parseFloat(this.elements.cycleDuration.value);
      this.phasorController.start(duration);
      this.log('Master timing started', 'info');
      this._updateUIState();
      
      // Broadcast current parameters to activate synthesis on all synths
      this.broadcastMusicalParameters();
    }
  }

  stopTiming() {
    if (this.phasorController) {
      this.phasorController.stop();
      this.log('Master timing stopped', 'info');
      this._updateUIState();
    }
  }

  toggleCalibration() {
    this.isCalibrationMode = !this.isCalibrationMode;
    
    // Update tracked settings
    this.currentSettings.calibrationMode = this.isCalibrationMode;
    this.currentSettings.calibrationAmplitude = 0.1;
    
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
      this.elements.manualModeBtn.textContent = 'Exit Manual Mode';
      this.elements.manualModeBtn.classList.add('active');
      this.log('Manual mode enabled - real-time parameter control active', 'info');
    } else {
      this.elements.manualModeBtn.textContent = 'Manual Mode';
      this.elements.manualModeBtn.classList.remove('active');
      this.log('Manual mode disabled', 'info');
    }
    
    // Update UI state for all parameters
    this.updateParameterControlsForManualMode();
    
    // Immediately broadcast parameters with new mode
    this.broadcastMusicalParameters();
  }

  updateParameterControlsForManualMode() {
    const paramNames = ['vowelX', 'vowelY', 'zingMorph', 'symmetry', 'amplitude'];
    
    paramNames.forEach(name => {
      const staticCheckbox = document.getElementById(`${name}-static`);
      const valueControl = document.getElementById(`${name}-value`).parentElement;
      const envelopeControls = document.getElementById(`${name}-envelope`);
      
      if (this.isManualMode) {
        // Force static mode
        staticCheckbox.checked = true;
        staticCheckbox.disabled = true;
        
        // Show value controls, hide/disable envelope controls
        valueControl.style.display = 'block';
        envelopeControls.style.opacity = '0.3';
        envelopeControls.style.pointerEvents = 'none';
        
        const envelopeInputs = envelopeControls.querySelectorAll('input, select');
        envelopeInputs.forEach(input => input.disabled = true);
      } else {
        // Restore normal mode
        staticCheckbox.disabled = false;
        envelopeControls.style.opacity = '1';
        envelopeControls.style.pointerEvents = 'auto';
        
        const envelopeInputs = envelopeControls.querySelectorAll('input, select');
        envelopeInputs.forEach(input => input.disabled = false);
        
        // Restore UI state based on checkbox
        if (staticCheckbox.checked) {
          valueControl.style.display = 'block';
        } else {
          valueControl.style.display = 'none';
        }
      }
    });
  }

  sendCurrentSettingsToSynth(synthId) {
    if (!this.star) {
      this.log('Cannot send settings: not connected to network', 'warn');
      return;
    }
    
    // Check if control channel is ready, if not store for later
    const peer = this.star.peers.get(synthId);
    if (!peer || !peer.controlChannel || peer.controlChannel.readyState !== 'open') {
      // Store pending settings to send when channel opens
      if (!this.pendingSettings) this.pendingSettings = new Map();
      this.pendingSettings.set(synthId, { ...this.currentSettings });
      this.log(`Control channel not ready for ${synthId}, settings stored for later`, 'debug');
      return;
    }
    
    // Send calibration mode if active
    if (this.currentSettings.calibrationMode) {
      const calibrationMsg = MessageBuilder.calibrationMode(
        this.currentSettings.calibrationMode,
        this.currentSettings.calibrationAmplitude
      );
      const success = this.star.sendToPeer(synthId, calibrationMsg, 'control');
      if (success) {
        this.log(`Sent calibration mode to ${synthId}`, 'debug');
      } else {
        this.log(`Failed to send calibration mode to ${synthId}`, 'error');
      }
    }
    
    // Send timing state if active
    if (this.currentSettings.timingActive && this.phasorController && this.phasorController.isRunning) {
      // The phasor sync messages will automatically be sent by the running controller
      this.log(`${synthId} will receive timing via phasor sync`, 'debug');
    }
    
    // Send current musical parameters
    const params = this.getMusicalParameters();
    const musicalMsg = MessageBuilder.musicalParameters(params);
    const musicalSuccess = this.star.sendToPeer(synthId, musicalMsg, 'control');
    if (musicalSuccess) {
      this.log(`Sent musical parameters to ${synthId}`, 'debug');
    } else {
      this.log(`Failed to send musical parameters to ${synthId}`, 'error');
    }
  }

  sendSettingsToSynth(synthId, settings) {
    // Send calibration mode if was active
    if (settings.calibrationMode) {
      const calibrationMsg = MessageBuilder.calibrationMode(
        settings.calibrationMode,
        settings.calibrationAmplitude
      );
      const success = this.star.sendToPeer(synthId, calibrationMsg, 'control');
      if (success) {
        this.log(`Sent pending calibration mode to ${synthId}`, 'debug');
      } else {
        this.log(`Failed to send pending calibration mode to ${synthId}`, 'error');
      }
    }
    
    // Send pending musical parameters - use current envelope settings
    const params = this.getMusicalParameters();
    const musicalMsg = MessageBuilder.musicalParameters(params);
    const musicalSuccess = this.star.sendToPeer(synthId, musicalMsg, 'control');
    if (musicalSuccess) {
      this.log(`Sent pending musical parameters to ${synthId}`, 'debug');
    } else {
      this.log(`Failed to send pending musical parameters to ${synthId}`, 'error');
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
      const health = peerStats.health;
      const peerType = peerId.split('-')[0]; // Extract type from peerId
      
      return `
        <div class="peer-item">
          <div class="peer-info">
            <div class="peer-id">${peerId}</div>
            <div class="peer-type">${peerType}</div>
          </div>
          <div class="peer-stats">
            <div>RTT: ${health.averageRTT ? health.averageRTT.toFixed(1) : '?'}ms</div>
            <div>Health: ${(health.health * 100).toFixed(0)}%</div>
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
    console.log(`[VoiceAssembly] ${message}`);
  }

  clearLog() {
    this.elements.debugLog.textContent = '';
  }
}

// Initialize the control client
const controlClient = new ControlClient();

// Make it globally available for debugging
window.controlClient = controlClient;