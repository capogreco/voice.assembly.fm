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
      
      connectBtn: document.getElementById('connect-btn'),
      disconnectBtn: document.getElementById('disconnect-btn'),
      startTimingBtn: document.getElementById('start-timing-btn'),
      stopTimingBtn: document.getElementById('stop-timing-btn'),
      calibrationBtn: document.getElementById('calibration-btn'),
      
      cycleDuration: document.getElementById('cycle-duration'),
      phasorViz: document.getElementById('phasor-viz'),
      phasorBar: document.getElementById('phasor-bar'),
      phasorText: document.getElementById('phasor-text'),
      
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
    // Network control
    this.elements.connectBtn.addEventListener('click', () => this.connectToNetwork());
    this.elements.disconnectBtn.addEventListener('click', () => this.disconnectFromNetwork());
    
    // Timing control
    this.elements.startTimingBtn.addEventListener('click', () => this.startTiming());
    this.elements.stopTimingBtn.addEventListener('click', () => this.stopTiming());
    
    // Calibration
    this.elements.calibrationBtn.addEventListener('click', () => this.toggleCalibration());
    
    // Cycle duration updates
    this.elements.cycleDuration.addEventListener('change', () => {
      if (this.phasorController && this.phasorController.isRunning) {
        const duration = parseFloat(this.elements.cycleDuration.value);
        this.phasorController.setCycleDuration(duration);
      }
    });
    
    // Debug log
    this.elements.clearLogBtn.addEventListener('click', () => this.clearLog());
  }

  async connectToNetwork() {
    try {
      this.updateConnectionStatus('connecting');
      this.elements.connectBtn.disabled = true;
      
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
      this.elements.disconnectBtn.disabled = false;
      
      this.log('Connected to network successfully', 'success');
      
    } catch (error) {
      this.log(`Connection failed: ${error.message}`, 'error');
      this.updateConnectionStatus('disconnected');
      this.elements.connectBtn.disabled = false;
    }
  }

  disconnectFromNetwork() {
    this.log('Disconnecting from network...', 'info');
    
    if (this.phasorController) {
      this.phasorController.stop();
      this.phasorController = null;
    }
    
    if (this.star) {
      this.star.cleanup();
      this.star = null;
    }
    
    this.updateConnectionStatus('disconnected');
    this.updatePeerCount(0);
    this.updateTimingStatus(false);
    this.clearPeerList();
    
    this.elements.connectBtn.disabled = false;
    this.elements.disconnectBtn.disabled = true;
    this.elements.startTimingBtn.disabled = true;
    this.elements.stopTimingBtn.disabled = true;
    
    this.log('Disconnected from network', 'info');
  }

  setupStarEventHandlers() {
    this.star.addEventListener('became-leader', () => {
      this.elements.startTimingBtn.disabled = false;
      this.log('Became network leader', 'success');
    });
    
    this.star.addEventListener('peer-connected', (event) => {
      const { peerId } = event.detail;
      this.log(`Peer connected: ${peerId}`, 'info');
      this.updatePeerList();
      
      // Send current settings to new synths (will handle channel readiness internally)
      if (peerId.startsWith('synth-')) {
        this.sendCurrentSettingsToSynth(peerId);
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
    });
    
    this.star.addEventListener('kicked', (event) => {
      this.log(`Kicked: ${event.detail.reason}`, 'error');
      this.updateConnectionStatus('error');
      alert('You have been disconnected: Another control client has taken over.');
      this.disconnectFromNetwork();
    });
    
    this.star.addEventListener('join-rejected', (event) => {
      this.log(`Cannot join: ${event.detail.reason}`, 'error');
      this.updateConnectionStatus('error');
      
      if (event.detail.reason.includes('Add ?force=true')) {
        if (confirm('Another control client is already connected. Force takeover?')) {
          window.location.href = window.location.href + '?force=true';
        }
      }
      this.disconnectFromNetwork();
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
    if (!this.phasorController || !this.star.isLeader) {
      this.log('Cannot start timing: not leader or no phasor controller', 'error');
      return;
    }
    
    const duration = parseFloat(this.elements.cycleDuration.value);
    
    // Update tracked settings
    this.currentSettings.timingActive = true;
    this.currentSettings.cycleDuration = duration;
    
    this.phasorController.start(duration);
  }

  stopTiming() {
    if (this.phasorController) {
      // Update tracked settings
      this.currentSettings.timingActive = false;
      
      this.phasorController.stop();
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
    
    // Future: Add other settings as needed
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
    
    // Future: Add other pending settings as needed
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