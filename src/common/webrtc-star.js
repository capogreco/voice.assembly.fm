/**
 * WebRTC Star Network Manager for Voice.Assembly.FM
 * Handles peer-to-peer connections and data channels in star topology
 */

import {
  MessageBuilder,
  MessageTypes,
  validateMessage,
} from "./message-protocol.js";

export class WebRTCStar extends EventTarget {
  constructor(peerId, peerType) {
    super();
    this.peerId = peerId;
    this.peerType = peerType; // 'ctrl' or 'synth'
    this.verbose = false; // toggle for noisy logs
    this.forceTakeover = false; // will be set by connect()

    // Network state
    this.peers = new Map(); // peerId -> PeerConnection
    this.signalingSocket = null;
    this.isConnectedToSignaling = false;

    // Network health tracking
    this.pingInterval = null;
    this.pingTimeouts = new Map();

    // Ctrl list retry mechanism (for synths)
    this.ctrlRetryCount = 0;
    this.maxCtrlRetries = 3;
    this.ctrlRetryTimeout = null;

    // ICE servers configuration
    this.iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];

    console.log(
      `🔗 WebRTC Star initialized: ${this.peerId} (${this.peerType})`,
    );

    // Fetch ICE servers from server
    this.fetchIceServers();
  }

  async fetchIceServers() {
    try {
      if (this.verbose) {
        console.log("🔍 Fetching ICE servers from /ice-servers...");
      }
      const response = await fetch("/ice-servers");
      if (response.ok) {
        const data = await response.json();
        if (data.ice_servers && data.ice_servers.length > 0) {
          this.iceServers = data.ice_servers;
          if (this.verbose) {
            console.log(
              `✅ Successfully fetched ${this.iceServers.length} ICE servers`,
            );
          }
        } else {
          if (this.verbose) {
            console.log("⚠️ No ICE servers returned, using fallback STUN");
          }
        }
      } else {
        throw new Error(
          `Failed to fetch ICE servers: ${response.status} ${response.statusText}`,
        );
      }
    } catch (error) {
      if (this.verbose) {
        console.log(`⚠️ ICE server fetch failed: ${error.message}`);
        console.log("Using fallback STUN servers");
      }
      // Keep default STUN servers as fallback
    }
  }

  /**
   * Determine if we should connect to a peer based on star topology
   * Star topology: ctrl connects to synths, synths connect to ctrl
   */
  shouldConnectToPeer(peerType) {
    if (this.peerType === "ctrl") {
      return peerType === "synth"; // Ctrl connects to synths
    } else if (this.peerType === "synth") {
      return peerType === "ctrl"; // Synths connect to ctrl
    }
    return false;
  }

  /**
   * Connect to signaling server and register
   */
  async connect(
    signalingUrl = "ws://localhost:8000/ws",
    forceTakeover = false,
  ) {
    this.forceTakeover = forceTakeover;
    return new Promise((resolve, reject) => {
      this.signalingSocket = new WebSocket(signalingUrl);

      this.signalingSocket.addEventListener("open", () => {
        if (this.verbose) console.log("📡 Connected to signaling server");

        // Register with server - include force_takeover for ctrl clients
        const registerMessage = {
          type: "register",
          client_id: this.peerId,
        };

        if (this.peerType === "ctrl" && forceTakeover) {
          registerMessage.force_takeover = true;
        }

        this.sendSignalingMessage(registerMessage);

        // If we're a synth, immediately request ctrl list
        if (this.peerType === "synth") {
          setTimeout(() => {
            this.sendSignalingMessage({
              type: "request-ctrls",
            });
          }, 100); // Small delay to ensure registration is processed
        }
      });

      this.signalingSocket.addEventListener("message", async (event) => {
        const message = JSON.parse(event.data);
        await this.handleSignalingMessage(message);

        // Handle successful connection for simplified protocol
        if (message.type === "ctrls-list" || message.type === "ctrl-joined") {
          this.isConnectedToSignaling = true;
          // Delay ping timer to allow data channels to establish
          setTimeout(() => this.startPingTimer(), 3000);
          resolve(true);
        } else if (this.peerType === "ctrl") {
          // Ctrl clients resolve immediately after registration
          this.isConnectedToSignaling = true;
          setTimeout(() => this.startPingTimer(), 3000);
          resolve(true);
        }
      });

      this.signalingSocket.addEventListener("error", (error) => {
        console.error("❌ Signaling connection error:", error);
        reject(error);
      });

      this.signalingSocket.addEventListener("close", () => {
        console.log("🔌 Signaling connection closed");
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
      case "ctrls-list":
        if (this.peerType === "synth") {
          if (this.verbose) {
            console.log("📋 Received ctrls list:", message.ctrls);
          }
          
          // Clear any pending retry
          if (this.ctrlRetryTimeout) {
            clearTimeout(this.ctrlRetryTimeout);
            this.ctrlRetryTimeout = null;
          }
          
          if (message.ctrls.length === 0) {
            // Empty controller list - schedule retry if we haven't exceeded max attempts
            if (this.ctrlRetryCount < this.maxCtrlRetries) {
              this.ctrlRetryCount++;
              const retryDelay = 1000 + Math.random() * 500; // 1-1.5s with jitter
              
              if (this.verbose) {
                console.log(`🔄 No controllers found, retrying in ${Math.round(retryDelay)}ms (attempt ${this.ctrlRetryCount}/${this.maxCtrlRetries})`);
              }
              
              this.ctrlRetryTimeout = setTimeout(() => {
                if (this.signalingSocket && this.signalingSocket.readyState === WebSocket.OPEN) {
                  this.signalingSocket.send(JSON.stringify({ type: "request-ctrls" }));
                }
              }, retryDelay);
            } else {
              if (this.verbose) {
                console.log(`⚠️ No controllers found after ${this.maxCtrlRetries} attempts, giving up`);
              }
            }
          } else {
            // Reset retry counter on successful response
            this.ctrlRetryCount = 0;
            
            // Synths initiate connections to all available ctrls
            for (const ctrlId of message.ctrls) {
              if (!this.peers.has(ctrlId)) {
                if (this.verbose) console.log(`🎛️ Connecting to ctrl: ${ctrlId}`);
                await this.createPeerConnection(ctrlId, true); // Synth initiates
              }
            }
          }
        }
        break;

      case "ctrl-joined":
        if (this.peerType === "synth") {
          // Reset retry counter since a controller is now available
          this.ctrlRetryCount = 0;
          if (this.ctrlRetryTimeout) {
            clearTimeout(this.ctrlRetryTimeout);
            this.ctrlRetryTimeout = null;
          }
          
          if (this.verbose) {
            console.log(`🎛️ New ctrl joined: ${message.ctrl_id}`);
          }
          // Synth initiates connection to new ctrl
          if (!this.peers.has(message.ctrl_id)) {
            await this.createPeerConnection(message.ctrl_id, true);
          }
        }
        break;

      case "ctrl-left":
        if (message.ctrl_id !== this.peerId) {
          if (this.verbose) console.log(`👋 Ctrl left: ${message.ctrl_id}`);
          this.removePeer(message.ctrl_id);
        }
        break;

      case "synth-joined":
        if (this.peerType === "ctrl") {
          if (this.verbose) {
            console.log(`🎤 New synth joined: ${message.synth_id}`);
          }
          // Ctrl initiates connection to new synth
          if (!this.peers.has(message.synth_id)) {
            await this.createPeerConnection(message.synth_id, true);
          }
        }
        break;

      case "synth-left":
        if (message.synth_id !== this.peerId) {
          if (this.verbose) console.log(`👋 Synth left: ${message.synth_id}`);
          this.removePeer(message.synth_id);
        }
        break;

      case "offer":
        await this.handleOffer(message);
        break;

      case "answer":
        await this.handleAnswer(message);
        break;

      case "ice-candidate":
        await this.handleIceCandidate(message);
        break;

      case "error":
        console.error("❌ Signaling error:", message.message);
        break;

      case "kicked":
        console.error(`❌ Kicked from network: ${message.reason}`);
        this.dispatchEvent(
          new CustomEvent("kicked", {
            detail: { reason: message.reason },
          }),
        );
        this.cleanup();
        break;

      case "join-rejected":
        console.error(`❌ Join rejected: ${message.reason}`);
        this.dispatchEvent(
          new CustomEvent("join-rejected", {
            detail: { reason: message.reason },
          }),
        );
        this.signalingSocket.close();
        break;
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
    if (this.peerType === "ctrl") {
      targetPeerType = "synth"; // Ctrl connects to synths
    } else {
      targetPeerType = "ctrl"; // Synths connect to ctrl
    }

    const peerConnection = new RTCPeerConnection({
      iceServers: this.iceServers,
    });

    // Create peer record first
    this.peers.set(peerId, {
      connection: peerConnection,
      peerType: targetPeerType, // Store the peer type
      syncChannel: null,
      controlChannel: null,
      connectedEventSent: false,
      initiator: shouldInitiate, // Track who initiated for reconnection
      reconnectAttempted: false, // Track if we've already attempted reconnection  
      reconnectTimer: null, // Store reconnection timer
      pendingCandidates: [], // Buffer ICE candidates when no remote description
    });

    // Create data channels if we're initiating
    let syncChannel, controlChannel;

    if (shouldInitiate) {
      if (this.verbose) {
        console.log(`📡 Creating data channels for ${peerId} (initiator)`);
      }

      syncChannel = peerConnection.createDataChannel("sync", {
        ordered: false,
        maxRetransmits: 0,
      });

      controlChannel = peerConnection.createDataChannel("control", {
        ordered: true,
      });

      // Set up channels immediately after creation
      this.setupDataChannel(syncChannel, peerId);
      this.setupDataChannel(controlChannel, peerId);
    }

    // Handle incoming data channels (when we're not the initiator)
    peerConnection.ondatachannel = (event) => {
      const channel = event.channel;
      if (this.verbose) {
        console.log(
          `📡 Received data channel '${channel.label}' from ${peerId}`,
        );
      }

      if (channel.label === "sync") {
        syncChannel = channel;
      } else if (channel.label === "control") {
        controlChannel = channel;
      }

      this.setupDataChannel(channel, peerId);
    };

    // ICE candidate handling
    peerConnection.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        this.sendSignalingMessage({
          type: "ice-candidate",
          targetPeerId: peerId,
          candidate: event.candidate,
        });
      }
    });

    // Connection state monitoring
    peerConnection.addEventListener("connectionstatechange", () => {
      if (this.verbose) {
        console.log(
          `🔗 Connection to ${peerId}: ${peerConnection.connectionState}`,
        );
      }

      if (peerConnection.connectionState === "connected") {
        this.checkPeerReadiness(peerId);
      } else if (peerConnection.connectionState === "failed") {
        this.schedulePeerReconnect(peerId);
      } else if (peerConnection.connectionState === "closed") {
        this.removePeer(peerId);
      } else if (peerConnection.connectionState === "disconnected") {
        console.log(`⚠️ Connection to ${peerId} disconnected, monitoring for recovery...`);
        // Let it recover naturally, no immediate action
      }
    });

    // Also monitor ICE connection state
    peerConnection.addEventListener("iceconnectionstatechange", () => {
      if (this.verbose) {
        console.log(
          `🧊 ICE connection to ${peerId}: ${peerConnection.iceConnectionState}`,
        );
      }

      if (
        peerConnection.iceConnectionState === "connected" ||
        peerConnection.iceConnectionState === "completed"
      ) {
        this.checkPeerReadiness(peerId);
      }
    });

    // Initiate connection if we should
    if (shouldInitiate) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      this.sendSignalingMessage({
        type: "offer",
        targetPeerId: peerId,
        offer: offer,
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
    if (channel.label === "sync") {
      peer.syncChannel = channel;
    } else if (channel.label === "control") {
      peer.controlChannel = channel;
    }

    channel.addEventListener("open", () => {
      console.log(`📡 ${channel.label} channel open to ${peerId}`);

      // Check if peer is now ready (both connection and sync channel)
      this.checkPeerReadiness(peerId);
    });

    // Debug: Log channel state immediately
    console.log(
      `📡 Channel '${channel.label}' for ${peerId} initial state: ${channel.readyState}`,
    );

    channel.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        validateMessage(message);
        this.handleDataChannelMessage(peerId, channel.label, message);
      } catch (error) {
        console.error("❌ Invalid data channel message:", error);
      }
    });

    channel.addEventListener("error", (error) => {
      console.error(
        `❌ Data channel error (${channel.label} to ${peerId}):`,
        error,
      );
    });

    channel.addEventListener("close", () => {
      console.log(`📡 ${channel.label} channel closed to ${peerId}`);
    });
  }

  /**
   * Handle WebRTC offer
   */
  async handleOffer(message) {
    const { fromPeerId, offer } = message;

    // If this is an unknown peer, create a connection for it now
    if (!this.peers.has(fromPeerId)) {
      if (this.verbose) {
        console.log(
          `🤝 Received offer from new peer ${fromPeerId}, creating connection`,
        );
      }
      // Create a peer connection, but DO NOT initiate (isInitiator = false)
      await this.createPeerConnection(fromPeerId, false);
    }

    const peer = this.peers.get(fromPeerId);
    if (!peer) {
      console.error(
        `❌ Could not get peer connection for ${fromPeerId} after creation attempt`,
      );
      return;
    }

    try {
      const pc = peer.connection;

      if (pc.signalingState !== "stable") {
        if (this.verbose) {
          console.log(
            `🔄 Received offer while signaling state is ${pc.signalingState}, rolling back`,
          );
        }
        await Promise.all([
          pc.setLocalDescription({ type: "rollback" }),
          pc.setRemoteDescription(offer),
        ]);
      } else {
        await pc.setRemoteDescription(offer);
      }

      // Drain any buffered ICE candidates after setting remote description
      await this.drainPendingCandidates(fromPeerId);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.sendSignalingMessage({
        type: "answer",
        targetPeerId: fromPeerId,
        answer: pc.localDescription,
      });

      if (this.verbose) console.log(`✅ Sent answer to ${fromPeerId}`);
    } catch (error) {
      console.error(`❌ Error handling offer from ${fromPeerId}:`, error);
    }
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

    try {
      await peer.connection.setRemoteDescription(answer);
      
      // Drain any buffered ICE candidates after setting remote description
      await this.drainPendingCandidates(fromPeerId);
      
      if (this.verbose) console.log(`✅ Set answer from ${fromPeerId}`);
    } catch (error) {
      // Log but don't fail - let WebRTC handle signaling issues gracefully
      if (this.verbose) {
        console.warn(`⚠️ Non-fatal error setting answer from ${fromPeerId}:`, error.message);
      }
    }
  }

  /**
   * Handle ICE candidate
   */
  async handleIceCandidate(message) {
    const { fromPeerId, candidate } = message;

    // If we get a candidate before the offer, we need to create the peer connection
    // This can happen due to network timing
    if (!this.peers.has(fromPeerId)) {
      if (this.verbose) {
        console.log(
          `🤝 Received ICE candidate from new peer ${fromPeerId}, creating placeholder connection`,
        );
      }
      await this.createPeerConnection(fromPeerId, false);
    }

    const peer = this.peers.get(fromPeerId);
    if (!peer) {
      console.error(
        `❌ Could not get peer connection for ICE candidate from ${fromPeerId}`,
      );
      return;
    }

    try {
      if (candidate) {
        const pc = peer.connection;
        
        // Check if we have a remote description before adding the candidate
        if (!pc.remoteDescription) {
          if (this.verbose) {
            console.log(
              `⏳ Buffering ICE candidate from ${fromPeerId} (no remote description yet)`,
            );
          }
          // Buffer the candidate for later
          peer.pendingCandidates.push(candidate);
          return;
        }
        
        // Add the ICE candidate
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        
        if (this.verbose) console.log(`✅ Added ICE candidate from ${fromPeerId}`);
      }
      // A null candidate indicates the end of the gathering process
    } catch (error) {
      if (this.verbose) {
        console.warn(`⚠️ Non-fatal error adding ICE candidate for ${fromPeerId}:`, error.message);
      }
      // Non-fatal error - let connection continue
    }
  }

  /**
   * Drain buffered ICE candidates after remote description is set
   */
  async drainPendingCandidates(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.pendingCandidates.length === 0) return;

    if (this.verbose) {
      console.log(`🔄 Draining ${peer.pendingCandidates.length} buffered ICE candidates for ${peerId}`);
    }

    const candidates = [...peer.pendingCandidates];
    peer.pendingCandidates = []; // Clear buffer

    for (const candidate of candidates) {
      try {
        await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
        if (this.verbose) console.log(`✅ Added buffered ICE candidate for ${peerId}`);
      } catch (error) {
        if (this.verbose) {
          console.warn(`⚠️ Non-fatal error adding buffered ICE candidate for ${peerId}:`, error.message);
        }
      }
    }
  }

  /**
   * Handle data channel messages
   */
  handleDataChannelMessage(peerId, channelType, message) {
    try {
      // Validate message before processing
      validateMessage(message);
    } catch (error) {
      console.error(`❌ Invalid message from ${peerId}:`, error.message);
      return; // Discard invalid message
    }

    // Handle ping/pong at network level
    if (message.type === MessageTypes.PING) {
      // Respond to ping automatically
      const pongMessage = MessageBuilder.pong(message.id, message.timestamp);
      this.sendToPeer(peerId, pongMessage, channelType);
      return; // Don't emit ping messages to application layer
    }

    if (message.type === MessageTypes.PONG) {
      this.handlePongMessage(peerId, message);
      return; // Don't emit pong messages to application layer
    }

    // Emit event for upper layers to handle
    this.dispatchEvent(
      new CustomEvent("data-message", {
        detail: { peerId, channelType, message },
      }),
    );
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

      // Calculate RTT for basic connectivity (suppress noisy logs unless verbose)
      const rtt = performance.now() - pongMessage.pingTimestamp;
      if (this.verbose) {
        console.log(`🏓 Pong from ${peerId}: ${Math.round(rtt)}ms`);
      }
    }
  }

  /**
   * Send message via signaling server
   */
  sendSignalingMessage(message) {
    if (
      this.signalingSocket && this.signalingSocket.readyState === WebSocket.OPEN
    ) {
      this.signalingSocket.send(JSON.stringify(message));
    }
  }

  /**
   * Send message to specific peer via data channel
   */
  sendToPeer(peerId, message, channelType = "sync") {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.warn(`⚠️ Cannot send to unknown peer: ${peerId}`);
      return false;
    }

    const channel = channelType === "sync"
      ? peer.syncChannel
      : peer.controlChannel;
    if (!channel || channel.readyState !== "open") {
      // Only log first few warnings to avoid spam
      if (!peer.channelWarningCount) peer.channelWarningCount = {};
      peer.channelWarningCount[channelType] =
        (peer.channelWarningCount[channelType] || 0) + 1;

      if (peer.channelWarningCount[channelType] <= 3) {
        console.warn(
          `⚠️ Channel ${channelType} to ${peerId} not ready (${
            channel?.readyState || "none"
          })`,
        );
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
  broadcast(message, channelType = "sync") {
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
  broadcastToType(targetType, message, channelType = "sync") {
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
    if (!peer || !peer.syncChannel || peer.syncChannel.readyState !== "open") {
      // Skip ping if channel not ready
      return;
    }

    const pingMessage = MessageBuilder.ping();

    // Set timeout for ping response
    const timeout = setTimeout(() => {
      console.log(`⚠️ Ping timeout for ${peerId}`);
      this.pingTimeouts.delete(pingMessage.id);

      // Don't automatically remove peers on ping timeout - let WebRTC connection state handle disconnections
      // This prevents booting peers due to temporary network hiccups
    }, 5000); // 5 second timeout

    this.pingTimeouts.set(pingMessage.id, timeout);
    this.sendToPeer(peerId, pingMessage, "sync");
  }

  /**
   * Check if peer is ready (connection established and both channels open)
   */
  checkPeerReadiness(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Simplified readiness: just check if both channels are open
    const isSyncChannelReady = peer.syncChannel?.readyState === "open";
    const isControlChannelReady = peer.controlChannel?.readyState === "open";

    // Debug info
    if (this.verbose) {
      console.log(`🔍 Peer ${peerId} readiness check:`, {
        syncChannelState: peer.syncChannel?.readyState,
        controlChannelState: peer.controlChannel?.readyState,
        ready: isSyncChannelReady && isControlChannelReady,
      });
    }

    if (isSyncChannelReady && isControlChannelReady) {
      if (this.verbose) {
        console.log(`✅ Connection and both channels ready for ${peerId}`);
      }
      // Prevent duplicate events
      if (!peer.connectedEventSent) {
        peer.connectedEventSent = true;
        this.dispatchEvent(
          new CustomEvent("peer-connected", {
            detail: {
              peerId,
              syncChannel: peer.syncChannel,
              controlChannel: peer.controlChannel,
            },
          }),
        );
      }
    } else {
      if (this.verbose) {
        console.log(
          `⏳ Peer ${peerId} - Connection: ${
            isConnectionReady ? "ready" : "waiting"
          }, Sync channel: ${
            isSyncChannelReady ? "ready" : "waiting"
          }, Control channel: ${isControlChannelReady ? "ready" : "waiting"}`,
        );
      }
    }
  }

  /**
   * Schedule a single reconnection attempt for a failed peer
   */
  schedulePeerReconnect(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.reconnectAttempted) {
      console.log(`🔄 Skipping reconnection for ${peerId} (no peer or already attempted)`);
      this.removePeer(peerId);
      return;
    }
    
    peer.reconnectAttempted = true;
    console.log(`🔄 Scheduling reconnection to ${peerId} in 2-3s...`);
    
    // Clear any existing timer
    if (peer.reconnectTimer) {
      clearTimeout(peer.reconnectTimer);
    }
    
    peer.reconnectTimer = setTimeout(() => {
      this.attemptPeerReconnect(peerId);
    }, 2000 + Math.random() * 1000); // 2-3s with jitter
  }

  /**
   * Attempt to reconnect to a failed peer
   */
  attemptPeerReconnect(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.log(`🔄 Cannot reconnect to ${peerId} - peer no longer exists`);
      return;
    }
    
    const wasInitiator = peer.initiator;
    console.log(`🔄 Attempting reconnection to ${peerId}...`);
    this.removePeer(peerId);
    this.createPeerConnection(peerId, wasInitiator);
  }

  /**
   * Remove peer from mesh
   */
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Clear any reconnection timer
    if (peer.reconnectTimer) {
      clearTimeout(peer.reconnectTimer);
    }

    // Clear pending candidates buffer
    peer.pendingCandidates = [];

    // Close connection
    if (peer.connection.connectionState !== "closed") {
      peer.connection.close();
    }

    this.peers.delete(peerId);
    if (this.verbose) console.log(`🗑️ Removed peer ${peerId}`);

    this.dispatchEvent(
      new CustomEvent("peer-removed", {
        detail: { peerId },
      }),
    );
  }

  /**
   * Get network statistics
   */
  getNetworkStats() {
    const peerStats = {};

    for (const [peerId, peer] of this.peers) {
      peerStats[peerId] = {
        connectionState: peer.connection.connectionState,
        peerType: peer.peerType,
      };
    }

    return {
      peerId: this.peerId,
      peerType: this.peerType,
      connectedPeers: this.peers.size,
      peerStats,
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

    // Clear ctrl retry timeout
    if (this.ctrlRetryTimeout) {
      clearTimeout(this.ctrlRetryTimeout);
      this.ctrlRetryTimeout = null;
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

    if (this.verbose) console.log("🧹 WebRTC mesh cleaned up");
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
