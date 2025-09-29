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

    // Signaling reconnection with exponential backoff
    this.signalingUrl = null;
    this.signalingReconnectTimer = null;
    this.signalingBackoffMs = 1000; // 1s initial
    this.signalingMaxBackoffMs = 10000; // 10s max

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
   * Schedule signaling reconnection with exponential backoff
   */
  scheduleSignalingReconnect() {
    if (this.signalingReconnectTimer) return; // Already scheduled

    if (this.verbose) {
      console.log(`🔄 Scheduling signaling reconnection in ${this.signalingBackoffMs}ms`);
    }

    this.signalingReconnectTimer = setTimeout(() => {
      this.signalingReconnectTimer = null;
      if (this.verbose) {
        console.log("🔄 Attempting signaling reconnection...");
      }
      this.connect(this.signalingUrl, this.forceTakeover);
    }, this.signalingBackoffMs);

    // Exponential backoff
    this.signalingBackoffMs = Math.min(
      this.signalingBackoffMs * 2,
      this.signalingMaxBackoffMs
    );
  }

  /**
   * Connect to signaling server and register
   */
  async connect(
    signalingUrl = "ws://localhost:8000/ws",
    forceTakeover = false,
  ) {
    this.forceTakeover = forceTakeover;
    this.signalingUrl = signalingUrl; // Save for reconnection
    return new Promise((resolve, reject) => {
      this.signalingSocket = new WebSocket(signalingUrl);

      this.signalingSocket.addEventListener("open", () => {
        if (this.verbose) console.log("📡 Connected to signaling server");
        
        // Reset backoff on successful connection
        this.signalingBackoffMs = 1000;

        // Register with server - include force_takeover for ctrl clients
        const registerMessage = {
          type: "register",
          client_id: this.peerId,
        };

        if (this.peerType === "ctrl" && forceTakeover) {
          registerMessage.force_takeover = true;
        }

        this.sendSignalingMessage(registerMessage);

        // Request peer lists after registration
        setTimeout(() => {
          if (this.peerType === "synth") {
            this.sendSignalingMessage({
              type: "request-ctrls",
            });
          } else if (this.peerType === "ctrl") {
            if (this.verbose) console.log("CTRL-DISCOVERY: Connection open, requesting synth list.");
            this.sendSignalingMessage({
              type: "request-synths",
            });
          }
        }, 100); // Small delay to ensure registration is processed
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
        this.scheduleSignalingReconnect();
        // DO NOT REJECT - the reconnection logic will handle this.
      });

      this.signalingSocket.addEventListener("close", () => {
        console.log("🔌 Signaling connection closed");
        this.isConnectedToSignaling = false;
        // Don't cleanup peers - they can survive signaling downtime
        // Schedule reconnection instead
        this.scheduleSignalingReconnect();
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
          if (this.verbose) console.log("SYNTH-DISCOVERY: Received ctrls list:", message.ctrls);
          if (this.verbose) {
            console.log("📋 Received ctrls list:", message.ctrls);
          }
          
          // Clear any pending retry
          if (this.ctrlRetryTimeout) {
            clearTimeout(this.ctrlRetryTimeout);
            this.ctrlRetryTimeout = null;
          }
          
          if (message.ctrls.length === 0) {
            // If we get an empty list, a ctrl client may be in the process of reconnecting.
            // We will retry requesting the list a few times.
            if (this.ctrlRetryCount < this.maxCtrlRetries) {
              this.ctrlRetryCount++;
              // Use a reasonable retry delay with jitter to avoid busy loops.
              const retryDelay = 1000 + Math.random() * 1000; // 1-2s with jitter

              if (this.verbose) {
                console.log(`[SYNTH-RETRY] No controllers found. Retrying in ${Math.round(retryDelay)}ms (attempt ${this.ctrlRetryCount}/${this.maxCtrlRetries})`);
              }
              
              this.ctrlRetryTimeout = setTimeout(() => {
                if (this.signalingSocket && this.signalingSocket.readyState === WebSocket.OPEN) {
                  if (this.verbose) console.log("[SYNTH-RETRY] Executing retry request for controllers.");
                  this.sendSignalingMessage({ type: "request-ctrls" });
                }
              }, retryDelay);
            } else {
              if (this.verbose) console.warn(`[SYNTH-RETRY] No controllers found after ${this.maxCtrlRetries} attempts. Giving up.`);
            }
          } else {
            // Reset retry counter on successful response
            this.ctrlRetryCount = 0;
            // Deterministic role: ctrl is initiator. Synth does NOT initiate.
            // We simply ensure a placeholder peer record exists and wait for ctrl to offer.
            for (const ctrlId of message.ctrls) {
              if (!this.peers.has(ctrlId)) {
                if (this.verbose) console.log(`[SYNTH-HANDSHAKE] Discovered new controller ${ctrlId}. Creating placeholder peer connection.`);
                await this.createPeerConnection(ctrlId, false);
              } else {
                if (this.verbose) console.log(`[SYNTH-HANDSHAKE] Discovered controller ${ctrlId}, but a peer record already exists. Skipping creation.`);
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
          if (this.verbose) console.log(`🎛️ Ctrl joined: ${message.ctrl_id} (waiting for offer)`);
          if (!this.peers.has(message.ctrl_id)) {
            await this.createPeerConnection(message.ctrl_id, false);
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

      case "synths-list":
        if (this.peerType === "ctrl") {
          if (this.verbose) console.log("CTRL-DISCOVERY: Received synths list:", message.synths);
          if (this.verbose) {
            console.log("📋 Received synths list:", message.synths);
          }
          // Ctrl initiates connections to all synths
          for (const synthId of message.synths) {
            if (!this.peers.has(synthId)) {
              if (this.verbose) console.log(`[CTRL-HANDSHAKE] Discovered new synth ${synthId}. Creating peer connection and sending offer.`);
              await this.createPeerConnection(synthId, true);
            } else {
              if (this.verbose) console.log(`[CTRL-HANDSHAKE] Discovered synth ${synthId}, but a peer record already exists. Skipping creation.`);
            }
          }
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
      pendingCandidates: [], // Buffer ICE candidates when no remote description
      
      // ICE restart tracking
      restartAttempted: false,
      restartTimer: null,
      disconnectedSince: null, // Track disconnected duration
      
      // Full rebuild tracking  
      reconnectAttempted: false,
      reconnectTimer: null,
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

    // Set up all connection event handlers
    this.setupConnectionEventHandlers(peerConnection, peerId);

    // Initiate connection if we should
    if (shouldInitiate) {
      // Set initiator flag before sending offer
      const peer = this.peers.get(peerId);
      if (peer) {
        peer.initiator = true;
      }
      
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
   * Set up connection event handlers for a peer connection
   */
  setupConnectionEventHandlers(peerConnection, peerId) {
    // Capture current connection for stale guard
    const currentPc = peerConnection;
    
    // ICE candidate handling
    peerConnection.addEventListener("icecandidate", (event) => {
      if (this.peers.get(peerId)?.connection !== currentPc) return; // stale guard
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
      if (this.peers.get(peerId)?.connection !== currentPc) return; // stale guard
      
      if (this.verbose) {
        console.log(
          `🔗 Connection to ${peerId}: ${peerConnection.connectionState}`,
        );
      }

      if (peerConnection.connectionState === "connected") {
        // Clear all failure tracking on successful connection
        const peer = this.peers.get(peerId);
        if (peer) {
          peer.disconnectedSince = null;
          peer.restartAttempted = false;
          peer.reconnectAttempted = false;
          if (peer.restartTimer) {
            clearTimeout(peer.restartTimer);
            peer.restartTimer = null;
          }
          if (peer.reconnectTimer) {
            clearTimeout(peer.reconnectTimer);
            peer.reconnectTimer = null;
          }
        }
        this.checkPeerReadiness(peerId);
      } else if (peerConnection.connectionState === "failed") {
        this.scheduleIceRestart(peerId);
      } else if (peerConnection.connectionState === "closed") {
        this.removePeer(peerId);
      } else if (peerConnection.connectionState === "disconnected") {
        const peer = this.peers.get(peerId);
        if (peer) {
          if (!peer.disconnectedSince) {
            peer.disconnectedSince = Date.now();
            if (this.verbose) console.log(`⚠️ Connection to ${peerId} disconnected, monitoring for recovery...`);
          }
          // After 3s continuous disconnection, try ICE restart
          if (!peer.restartAttempted && peer.initiator && 
              Date.now() - peer.disconnectedSince > 3000) {
            this.scheduleIceRestart(peerId);
          }
        }
      }
    });

    // Also monitor ICE connection state
    peerConnection.addEventListener("iceconnectionstatechange", () => {
      if (this.peers.get(peerId)?.connection !== currentPc) return; // stale guard
      
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

    // Handle incoming data channels (when we're not the initiator)
    peerConnection.ondatachannel = (event) => {
      if (this.peers.get(peerId)?.connection !== currentPc) return; // stale guard
      
      const channel = event.channel;
      if (this.verbose) {
        console.log(
          `📡 Received data channel '${channel.label}' from ${peerId}`,
        );
      }

      this.setupDataChannel(channel, peerId);
    };
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

    // Set initiator role correctly - we are receiving an offer, so we are not the initiator
    peer.initiator = false;

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
   * Check if peer is ready (strict 4-condition check)
   */
  checkPeerReadiness(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Strict readiness: require ALL 4 conditions
    const isConnectionReady = peer.connection.connectionState === "connected";
    const isIceReady = peer.connection.iceConnectionState === "connected" || 
                       peer.connection.iceConnectionState === "completed";
    const isSyncChannelReady = peer.syncChannel?.readyState === "open";
    const isControlChannelReady = peer.controlChannel?.readyState === "open";
    
    const ready = isConnectionReady && isIceReady && isSyncChannelReady && isControlChannelReady;

    // Debug info
    if (this.verbose) {
      console.log(`🔍 Peer ${peerId} readiness check:`, {
        connectionState: peer.connection.connectionState,
        iceState: peer.connection.iceConnectionState,
        syncChannelState: peer.syncChannel?.readyState,
        controlChannelState: peer.controlChannel?.readyState,
        ready: ready,
      });
    }

    if (ready) {
      if (this.verbose) {
        console.log(`✅ All conditions met for ${peerId} - fully ready`);
      }
      
      // Clear ALL failure tracking on full readiness
      peer.disconnectedSince = null;
      peer.restartAttempted = false;
      peer.reconnectAttempted = false;
      if (peer.restartTimer) {
        clearTimeout(peer.restartTimer);
        peer.restartTimer = null;
      }
      if (peer.reconnectTimer) {
        clearTimeout(peer.reconnectTimer);
        peer.reconnectTimer = null;
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
          }, ICE: ${
            isIceReady ? "ready" : "waiting"
          }, Sync: ${
            isSyncChannelReady ? "ready" : "waiting"
          }, Control: ${isControlChannelReady ? "ready" : "waiting"}`,
        );
      }
    }
  }

  /**
   * Schedule an ICE restart attempt for a peer
   */
  scheduleIceRestart(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.initiator || peer.restartAttempted) {
      return; // Only initiator can restart, and only once
    }
    
    peer.restartAttempted = true;
    const delay = 1000 + Math.random() * 500; // 1-1.5s with jitter
    if (this.verbose) console.log(`🔄 Scheduling ICE restart to ${peerId} in ${Math.round(delay)}ms...`);
    
    // Clear any existing timer
    if (peer.restartTimer) {
      clearTimeout(peer.restartTimer);
    }
    
    peer.restartTimer = setTimeout(() => {
      this.attemptIceRestart(peerId);
    }, delay);
  }

  /**
   * Attempt ICE restart for a failed peer
   */
  async attemptIceRestart(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.initiator) return;
    
    if (peer.restartTimer) {
      clearTimeout(peer.restartTimer);
      peer.restartTimer = null;
    }
    
    if (this.verbose) console.log(`🔄 Attempting ICE restart to ${peerId}...`);
    
    try {
      const pc = peer.connection;
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      
      this.sendSignalingMessage({
        type: "offer",
        targetPeerId: peerId,
        offer: offer,
      });
      
      if (this.verbose) console.log(`📤 Sent ICE restart offer to ${peerId}`);
      
      // Schedule fallback rebuild if no recovery in 10s
      peer.reconnectTimer = setTimeout(() => {
        const currentPeer = this.peers.get(peerId);
        if (!currentPeer?.connection || 
            currentPeer.connection.connectionState !== "connected") {
          this.schedulePeerReconnect(peerId);
        }
      }, 10000);
      
    } catch (error) {
      console.error(`❌ ICE restart failed for ${peerId}:`, error);
      this.schedulePeerReconnect(peerId); // Fallback to rebuild
    }
  }

  /**
   * Schedule a single reconnection attempt for a failed peer
   */
  schedulePeerReconnect(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      this.removePeer(peerId);
      return;
    }
    if (peer.reconnectAttempted) {
      if (this.verbose) console.log(`↩️ Reconnect already attempted for ${peerId}`);
      return; // Do NOT remove peer here - prevents deletion loops
    }
    
    peer.reconnectAttempted = true;
    const delay = 2000 + Math.random() * 1000;
    if (this.verbose) console.log(`🔄 Scheduling reconnection to ${peerId} in ${Math.round(delay)}ms...`);
    
    // Clear any existing timer
    if (peer.reconnectTimer) {
      clearTimeout(peer.reconnectTimer);
    }
    
    peer.reconnectTimer = setTimeout(() => {
      this.attemptPeerReconnect(peerId);
    }, delay);
  }

  /**
   * Attempt to reconnect to a failed peer in-place
   */
  async attemptPeerReconnect(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    const wasInitiator = peer.initiator;
    if (peer.reconnectTimer) { 
      clearTimeout(peer.reconnectTimer); 
      peer.reconnectTimer = null; 
    }
    if (this.verbose) console.log(`🔄 Attempting reconnection to ${peerId} (initiator=${wasInitiator})...`);

    try {
      // Close old pc; don't act on its events due to stale guard
      try { peer.connection.close(); } catch {}

      // New pc
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      peer.connection = pc;
      peer.syncChannel = null;
      peer.controlChannel = null;
      peer.connectedEventSent = false; // Allow "peer-connected" to fire again
      peer.pendingCandidates = []; // Reset ICE buffer for new pc
      
      // Clear disconnected tracking
      peer.disconnectedSince = null;
      
      // Stale guards via captured pc
      const currentPc = pc;

      pc.ondatachannel = (event) => {
        if (this.peers.get(peerId)?.connection !== currentPc) return;
        this.setupDataChannel(event.channel, peerId);
      };
      
      pc.addEventListener("icecandidate", (event) => {
        if (this.peers.get(peerId)?.connection !== currentPc) return;
        if (event.candidate) {
          this.sendSignalingMessage({ 
            type: "ice-candidate", 
            targetPeerId: peerId, 
            candidate: event.candidate 
          });
        }
      });
      
      pc.addEventListener("connectionstatechange", () => {
        if (this.peers.get(peerId)?.connection !== currentPc) return;
        const state = pc.connectionState;
        if (this.verbose) console.log(`🔗(re) ${peerId}: ${state}`);
        if (state === "connected") {
          // Reset retry flags on success
          peer.reconnectAttempted = false;
          if (peer.reconnectTimer) { 
            clearTimeout(peer.reconnectTimer); 
            peer.reconnectTimer = null; 
          }
          this.checkPeerReadiness(peerId);
        } else if (state === "failed") {
          // Only one retry allowed; if we're here, give up and remove
          this.removePeer(peerId);
        } else if (state === "closed") {
          this.removePeer(peerId);
        } else if (state === "disconnected") {
          if (this.verbose) console.log(`⚠️ ${peerId} disconnected; waiting for recovery`);
        }
      });
      
      pc.addEventListener("iceconnectionstatechange", () => {
        if (this.peers.get(peerId)?.connection !== currentPc) return;
        const ice = pc.iceConnectionState;
        if (ice === "connected" || ice === "completed") this.checkPeerReadiness(peerId);
      });

      if (wasInitiator) {
        peer.initiator = true;
        
        // Create data channels exactly once
        const syncChannel = pc.createDataChannel("sync", { ordered: false, maxRetransmits: 0 });
        const controlChannel = pc.createDataChannel("control", { ordered: true });
        this.setupDataChannel(syncChannel, peerId);
        this.setupDataChannel(controlChannel, peerId);

        // Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.sendSignalingMessage({ 
          type: "offer", 
          targetPeerId: peerId, 
          offer 
        });
        if (this.verbose) console.log(`📤 Sent reconnection offer to ${peerId}`);
      } else {
        peer.initiator = false; // wait for remote offer
      }

    } catch (e) {
      console.error(`❌ Reconnect setup failed for ${peerId}:`, e);
      this.removePeer(peerId);
    }
  }

  /**
   * Remove peer from mesh
   */
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Clear all timers
    if (peer.restartTimer) {
      clearTimeout(peer.restartTimer);
    }
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

    // If synth loses its last controller, proactively request new list
    if (this.peerType === 'synth' && peerId.startsWith('ctrl-')) {
      const remainingCtrlPeers = [...this.peers.keys()].filter(id => id.startsWith('ctrl-'));
      if (remainingCtrlPeers.length === 0) {
        if (this.verbose) {
          console.log("🔌 Last controller disconnected. Proactively requesting a new list.");
        }
        setTimeout(() => {
          if (this.signalingSocket && this.signalingSocket.readyState === WebSocket.OPEN) {
            this.sendSignalingMessage({ type: 'request-ctrls' });
          }
        }, 250);
      }
    }
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

    // Close all peer connections and clear timers
    for (const [peerId, peer] of this.peers) {
      if (peer.restartTimer) {
        clearTimeout(peer.restartTimer);
      }
      if (peer.reconnectTimer) {
        clearTimeout(peer.reconnectTimer);
      }
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
