/**
 * WebRTC Star Network Manager for Voice.Assembly.FM
 * Handles peer-to-peer connections and data channels in star topology
 */

import { MessageBuilder, MessageTypes, validateMessage } from './message-protocol.js';

export class WebRTCStar extends EventTarget {
  constructor(peerId, peerType, roomId = 'voice-assembly-default') {
    super();
    this.peerId = peerId;
    this.peerType = peerType; // 'ctrl' or 'synth'
    this.roomId = roomId;
    
    // Network state
    this.peers = new Map(); // peerId -> PeerConnection
    this.signalingSocket = null;
    this.isConnectedToSignaling = false;
    
    // Network health tracking
    this.pingInterval = null;
    this.pingTimeouts = new Map();
    
    console.log(`🔗 WebRTC Star initialized: ${this.peerId} (${this.peerType})`);
  }

  /**
   * Determine if we should connect to a peer based on star topology
   * Star topology: ctrl connects to synths, synths connect to ctrl
   */
  shouldConnectToPeer(peerType) {
    if (this.peerType === 'ctrl') {
      return peerType === 'synth'; // Ctrl connects to synths
    } else if (this.peerType === 'synth') {
      return peerType === 'ctrl'; // Synths connect to ctrl
    }
    return false;
  }

  /**
   * Connect to signaling server and join room
   */
  async connect(signalingUrl = 'ws://localhost:8000/ws', forceTakeover = false) {
    return new Promise((resolve, reject) => {
      this.signalingSocket = new WebSocket(signalingUrl);
      
      this.signalingSocket.addEventListener('open', () => {
        console.log('📡 Connected to signaling server');
        
        // Join room
        this.sendSignalingMessage({
          type: 'join',
          peerId: this.peerId,
          peerType: this.peerType,
          roomId: this.roomId,
          forceTakeover: forceTakeover
        });
      });

      this.signalingSocket.addEventListener('message', async (event) => {
        const message = JSON.parse(event.data);
        await this.handleSignalingMessage(message);
        
        if (message.type === 'join-success') {
          this.isConnectedToSignaling = true;
          // Delay ping timer to allow data channels to establish
          setTimeout(() => this.startPingTimer(), 3000);
          resolve(true);
        }
      });

      this.signalingSocket.addEventListener('error', (error) => {
        console.error('❌ Signaling connection error:', error);
        reject(error);
      });

      this.signalingSocket.addEventListener('close', () => {
        console.log('🔌 Signaling connection closed');
        this.isConnectedToSignaling = false;
        this.cleanup();
      });
    });
  }

  /**
   * Handle signaling server messages
   */
  async handleSignalingMessage(message) {
    switch (message.type) {
      case 'join-success':
        console.log(`✅ Successfully joined room ${this.roomId}`);
        break;

      case 'peer-list':
        console.log('📋 Received peer-list message:', message.peers);
        await this.handlePeerList(message.peers);
        break;

      case 'synth-available':
        if (this.peerType === 'ctrl') {
          console.log(`🎵 Synth available: ${message.synthId}`);
          await this.createPeerConnection(message.synthId, true); // Ctrl initiates
        }
        break;

      case 'ctrl-available':
        if (this.peerType === 'synth') {
          console.log(`🎛️ Ctrl available: ${message.ctrlId}`);
          await this.createPeerConnection(message.ctrlId, false); // Ctrl initiates
        }
        break;

      case 'peer-left':
        if (message.peerId !== this.peerId) {
          console.log(`👋 Peer left: ${message.peerId}`);
          this.removePeer(message.peerId);
        }
        break;

      case 'offer':
        await this.handleOffer(message);
        break;

      case 'answer':
        await this.handleAnswer(message);
        break;

      case 'ice-candidate':
        await this.handleIceCandidate(message);
        break;

      case 'error':
        console.error('❌ Signaling error:', message.message);
        break;

      case 'kicked':
        console.error(`❌ Kicked from network: ${message.reason}`);
        this.dispatchEvent(new CustomEvent('kicked', {
          detail: { reason: message.reason }
        }));
        this.cleanup();
        break;
        
      case 'join-rejected':
        console.error(`❌ Join rejected: ${message.reason}`);
        this.dispatchEvent(new CustomEvent('join-rejected', {
          detail: { reason: message.reason }
        }));
        this.signalingSocket.close();
        break;
    }
  }

  /**
   * Handle initial peer list from signaling server
   */
  async handlePeerList(peers) {
    console.log('📋 Received peer list:', peers.length, 'peers');
    
    // Star topology: only connect to appropriate peer types
    for (const peer of peers) {
      if (peer.id !== this.peerId && this.shouldConnectToPeer(peer.type)) {
        // In star topology: ctrl always initiates connections to synths
        const shouldInitiate = (this.peerType === 'ctrl' && peer.type === 'synth');
        console.log(`🔗 Creating connection to ${peer.id} (initiating: ${shouldInitiate})`);
        await this.createPeerConnection(peer.id, shouldInitiate);
      }
    }

  }

  /**
   * Create RTCPeerConnection for a peer
   */
  async createPeerConnection(peerId, shouldInitiate) {
    if (this.peers.has(peerId)) {
      console.warn(`⚠️ Peer connection already exists for ${peerId}`);
      return;
    }

    // Determine peer type based on star topology
    let targetPeerType;
    if (this.peerType === 'ctrl') {
      targetPeerType = 'synth'; // Ctrl connects to synths
    } else {
      targetPeerType = 'ctrl'; // Synths connect to ctrl
    }

    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    // Create peer record first
    this.peers.set(peerId, {
      connection: peerConnection,
      peerType: targetPeerType, // Store the peer type
      syncChannel: null,
      controlChannel: null,
      connectedEventSent: false
    });

    // Create data channels if we're initiating
    let syncChannel, controlChannel;
    
    if (shouldInitiate) {
      console.log(`📡 Creating data channels for ${peerId} (initiator)`);
      
      syncChannel = peerConnection.createDataChannel('sync', {
        ordered: false,
        maxRetransmits: 0
      });
      
      controlChannel = peerConnection.createDataChannel('control', {
        ordered: true
      });
      
      // Set up channels immediately after creation
      this.setupDataChannel(syncChannel, peerId);
      this.setupDataChannel(controlChannel, peerId);
    }

    // Handle incoming data channels (when we're not the initiator)
    peerConnection.ondatachannel = (event) => {
      const channel = event.channel;
      console.log(`📡 Received data channel '${channel.label}' from ${peerId}`);
      
      if (channel.label === 'sync') {
        syncChannel = channel;
      } else if (channel.label === 'control') {
        controlChannel = channel;
      }
      
      this.setupDataChannel(channel, peerId);
    };

    // ICE candidate handling
    peerConnection.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this.sendSignalingMessage({
          type: 'ice-candidate',
          targetPeerId: peerId,
          candidate: event.candidate
        });
      }
    });

    // Connection state monitoring
    peerConnection.addEventListener('connectionstatechange', () => {
      console.log(`🔗 Connection to ${peerId}: ${peerConnection.connectionState}`);
      
      if (peerConnection.connectionState === 'connected') {
        // Use a small delay to allow channels to stabilize
        setTimeout(() => {
          this.checkPeerReadiness(peerId);
        }, 100);
      } else if (peerConnection.connectionState === 'failed' || 
                 peerConnection.connectionState === 'disconnected') {
        this.removePeer(peerId);
      }
    });

    // Also monitor ICE connection state
    peerConnection.addEventListener('iceconnectionstatechange', () => {
      console.log(`🧊 ICE connection to ${peerId}: ${peerConnection.iceConnectionState}`);
      
      if (peerConnection.iceConnectionState === 'connected' || 
          peerConnection.iceConnectionState === 'completed') {
        // Use a small delay to allow channels to stabilize
        setTimeout(() => {
          this.checkPeerReadiness(peerId);
        }, 100);
      }
    });

    // Initiate connection if we should
    if (shouldInitiate) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      
      this.sendSignalingMessage({
        type: 'offer',
        targetPeerId: peerId,
        offer: offer
      });
    }
  }

  /**
   * Set up data channel event handlers
   */
  setupDataChannel(channel, peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Store channel reference
    if (channel.label === 'sync') {
      peer.syncChannel = channel;
    } else if (channel.label === 'control') {
      peer.controlChannel = channel;
    }

    channel.addEventListener('open', () => {
      console.log(`📡 ${channel.label} channel open to ${peerId}`);
      
      // Check if peer is now ready (both connection and sync channel)
      this.checkPeerReadiness(peerId);
    });

    // Debug: Log channel state immediately
    console.log(`📡 Channel '${channel.label}' for ${peerId} initial state: ${channel.readyState}`);

    channel.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        validateMessage(message);
        this.handleDataChannelMessage(peerId, channel.label, message);
      } catch (error) {
        console.error('❌ Invalid data channel message:', error);
      }
    });

    channel.addEventListener('error', (error) => {
      console.error(`❌ Data channel error (${channel.label} to ${peerId}):`, error);
    });

    channel.addEventListener('close', () => {
      console.log(`📡 ${channel.label} channel closed to ${peerId}`);
    });
  }

  /**
   * Handle WebRTC offer
   */
  async handleOffer(message) {
    const { fromPeerId, offer } = message;
    const peer = this.peers.get(fromPeerId);
    
    if (!peer) {
      console.error(`❌ Received offer from unknown peer: ${fromPeerId}`);
      return;
    }

    await peer.connection.setRemoteDescription(offer);
    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);

    this.sendSignalingMessage({
      type: 'answer',
      targetPeerId: fromPeerId,
      answer: answer
    });
  }

  /**
   * Handle WebRTC answer
   */
  async handleAnswer(message) {
    const { fromPeerId, answer } = message;
    const peer = this.peers.get(fromPeerId);
    
    if (!peer) {
      console.error(`❌ Received answer from unknown peer: ${fromPeerId}`);
      return;
    }

    await peer.connection.setRemoteDescription(answer);
  }

  /**
   * Handle ICE candidate
   */
  async handleIceCandidate(message) {
    const { fromPeerId, candidate } = message;
    const peer = this.peers.get(fromPeerId);
    
    if (!peer) {
      console.error(`❌ Received ICE candidate from unknown peer: ${fromPeerId}`);
      return;
    }

    try {
      await peer.connection.addIceCandidate(candidate);
    } catch (error) {
      console.error('❌ Error adding ICE candidate:', error);
    }
  }

  /**
   * Handle data channel messages
   */
  handleDataChannelMessage(peerId, channelType, message) {
    // Record network health metrics
    if (message.type === MessageTypes.PONG) {
      this.handlePongMessage(peerId, message);
    }

    // Emit event for upper layers to handle
    this.dispatchEvent(new CustomEvent('data-message', {
      detail: { peerId, channelType, message }
    }));
  }

  /**
   * Handle pong message for network health tracking
   */
  handlePongMessage(peerId, pongMessage) {
    const pingId = pongMessage.pingId;
    const timeout = this.pingTimeouts.get(pingId);
    
    if (timeout) {
      clearTimeout(timeout);
      this.pingTimeouts.delete(pingId);
      
      // Calculate RTT for basic connectivity
      const rtt = performance.now() - pongMessage.pingTimestamp;
      console.log(`🏓 Pong from ${peerId}: ${Math.round(rtt)}ms`);
    }
  }

  /**
   * Send message via signaling server
   */
  sendSignalingMessage(message) {
    if (this.signalingSocket && this.signalingSocket.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify(message));
    }
  }

  /**
   * Send message to specific peer via data channel
   */
  sendToPeer(peerId, message, channelType = 'sync') {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.warn(`⚠️ Cannot send to unknown peer: ${peerId}`);
      return false;
    }

    const channel = channelType === 'sync' ? peer.syncChannel : peer.controlChannel;
    if (!channel || channel.readyState !== 'open') {
      // Only log first few warnings to avoid spam
      if (!peer.channelWarningCount) peer.channelWarningCount = {};
      peer.channelWarningCount[channelType] = (peer.channelWarningCount[channelType] || 0) + 1;
      
      if (peer.channelWarningCount[channelType] <= 3) {
        console.warn(`⚠️ Channel ${channelType} to ${peerId} not ready (${channel?.readyState || 'none'})`);
      }
      return false;
    }

    try {
      channel.send(JSON.stringify(message));
      
      // Reset warning count on successful send
      if (peer.channelWarningCount) {
        peer.channelWarningCount[channelType] = 0;
      }
      
      return true;
    } catch (error) {
      console.error(`❌ Failed to send message to ${peerId}:`, error);
      return false;
    }
  }

  /**
   * Broadcast message to all connected peers
   */
  broadcast(message, channelType = 'sync') {
    let successCount = 0;
    
    for (const [peerId] of this.peers) {
      if (this.sendToPeer(peerId, message, channelType)) {
        successCount++;
      }
    }
    
    return successCount;
  }

  /**
   * Broadcast message to peers of a specific type (e.g., 'synth', 'ctrl')
   */
  broadcastToType(targetType, message, channelType = 'sync') {
    let successCount = 0;
    
    for (const [peerId, peer] of this.peers) {
      if (peer.peerType === targetType) {
        if (this.sendToPeer(peerId, message, channelType)) {
          successCount++;
        }
      }
    }
    
    return successCount;
  }

  /**
   * Start periodic ping timer
   */
  startPingTimer() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    this.pingInterval = setInterval(() => {
      this.pingAllPeers();
    }, 1000); // Ping every second
  }

  /**
   * Ping all connected peers
   */
  pingAllPeers() {
    for (const [peerId] of this.peers) {
      this.pingPeer(peerId);
    }
  }

  /**
   * Ping specific peer
   */
  pingPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.syncChannel || peer.syncChannel.readyState !== 'open') {
      // Skip ping if channel not ready
      return;
    }

    const pingMessage = MessageBuilder.ping();
    
    // Set timeout for ping response
    const timeout = setTimeout(() => {
      console.log(`⚠️ Ping timeout for ${peerId}`);
      this.pingTimeouts.delete(pingMessage.id);
    }, 5000); // 5 second timeout
    
    this.pingTimeouts.set(pingMessage.id, timeout);
    this.sendToPeer(peerId, pingMessage, 'sync');
  }


  /**
   * Check if peer is ready (connection established and both channels open)
   */
  checkPeerReadiness(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    const peerConnection = peer.connection;
    const isConnectionReady = peerConnection && 
      (peerConnection.connectionState === 'connected' || 
       peerConnection.iceConnectionState === 'connected' ||
       peerConnection.iceConnectionState === 'completed');
    
    const isSyncChannelReady = peer.syncChannel && peer.syncChannel.readyState === 'open';
    const isControlChannelReady = peer.controlChannel && peer.controlChannel.readyState === 'open';
    
    // Debug info
    console.log(`🔍 Peer ${peerId} readiness check:`, {
      connectionState: peerConnection?.connectionState,
      iceConnectionState: peerConnection?.iceConnectionState,
      hasSyncChannel: !!peer.syncChannel,
      syncChannelState: peer.syncChannel?.readyState,
      hasControlChannel: !!peer.controlChannel,
      controlChannelState: peer.controlChannel?.readyState,
      isConnectionReady,
      isSyncChannelReady,
      isControlChannelReady
    });
    
    if (isConnectionReady && isSyncChannelReady && isControlChannelReady) {
      console.log(`✅ Connection and both channels ready for ${peerId}`);
      // Prevent duplicate events
      if (!peer.connectedEventSent) {
        peer.connectedEventSent = true;
        this.dispatchEvent(new CustomEvent('peer-connected', {
          detail: { 
            peerId, 
            syncChannel: peer.syncChannel, 
            controlChannel: peer.controlChannel 
          }
        }));
      }
    } else {
      console.log(`⏳ Peer ${peerId} - Connection: ${isConnectionReady ? 'ready' : 'waiting'}, Sync channel: ${isSyncChannelReady ? 'ready' : 'waiting'}, Control channel: ${isControlChannelReady ? 'ready' : 'waiting'}`);
    }
  }

  /**
   * Remove peer from mesh
   */
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Close connection
    if (peer.connection.connectionState !== 'closed') {
      peer.connection.close();
    }

    this.peers.delete(peerId);
    console.log(`🗑️ Removed peer ${peerId}`);

    this.dispatchEvent(new CustomEvent('peer-removed', {
      detail: { peerId }
    }));
  }

  /**
   * Get network statistics
   */
  getNetworkStats() {
    const peerStats = {};
    
    for (const [peerId, peer] of this.peers) {
      peerStats[peerId] = {
        connectionState: peer.connection.connectionState,
        peerType: peer.peerType
      };
    }

    return {
      peerId: this.peerId,
      peerType: this.peerType,
      connectedPeers: this.peers.size,
      peerStats
    };
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    // Clear timers
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Clear ping timeouts
    for (const timeout of this.pingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.pingTimeouts.clear();

    // Close all peer connections
    for (const [peerId] of this.peers) {
      this.removePeer(peerId);
    }

    // Close signaling connection
    if (this.signalingSocket) {
      this.signalingSocket.close();
      this.signalingSocket = null;
    }

    this.isConnectedToSignaling = false;
    
    console.log('🧹 WebRTC mesh cleaned up');
  }
}

/**
 * Generate unique peer ID
 */
export function generatePeerId(peerType) {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${peerType}-${timestamp}-${random}`;
}