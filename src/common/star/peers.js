/**
 * Peer connection management for WebRTC Star Network
 */

/**
 * Determine if we should connect to a peer based on star topology
 * Star topology: ctrl connects to synths, synths connect to ctrl
 * @param {string} peerType - Type of peer ('ctrl' or 'synth')
 * @param {Object} context - WebRTC Star context
 * @returns {boolean} - Should connect to this peer type
 */
export function shouldConnectToPeer(peerType, context) {
  if (context.peerType === "ctrl") {
    return peerType === "synth"; // Ctrl connects to synths
  } else if (context.peerType === "synth") {
    return peerType === "ctrl"; // Synths connect to ctrl
  }
  return false;
}

/**
 * Create a new peer connection
 * @param {string} peerId - Peer ID
 * @param {boolean} shouldInitiate - Whether to initiate connection
 * @param {Object} context - WebRTC Star context
 */
export async function createPeerConnection(peerId, shouldInitiate, context) {
  if (context.peers.has(peerId)) {
    if (context.verbose) {
      console.log(`🔗 Peer connection already exists for ${peerId}`);
    }
    return;
  }

  if (context.verbose) {
    console.log(
      `🔗 Creating peer connection to ${peerId} (initiate: ${shouldInitiate})`,
    );
  }

  // Determine peer type based on star topology
  let targetPeerType;
  if (context.peerType === "ctrl") {
    targetPeerType = "synth"; // Ctrl connects to synths
  } else {
    targetPeerType = "ctrl"; // Synths connect to ctrl
  }

  const peerConnection = new RTCPeerConnection({
    iceServers: context.iceServers,
  });

  // Create peer record first
  context.peers.set(peerId, {
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
    if (context.verbose) {
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
    setupDataChannel(syncChannel, peerId, context);
    setupDataChannel(controlChannel, peerId, context);
  }

  // Set up all connection event handlers
  setupConnectionEventHandlers(peerConnection, peerId, context);

  // Initiate connection if we should
  if (shouldInitiate) {
    // Set initiator flag before sending offer
    const peer = context.peers.get(peerId);
    if (peer) {
      peer.initiator = true;
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    context.sendSignalingMessage({
      type: "offer",
      targetPeerId: peerId,
      offer: offer,
    });
  }
}

/**
 * Set up connection event handlers for a peer connection
 * @param {RTCPeerConnection} peerConnection - Peer connection
 * @param {string} peerId - Peer ID
 * @param {Object} context - WebRTC Star context
 */
export function setupConnectionEventHandlers(peerConnection, peerId, context) {
  // Capture current connection for stale guard
  const currentPc = peerConnection;

  // ICE candidate handling
  peerConnection.addEventListener("icecandidate", (event) => {
    if (context.peers.get(peerId)?.connection !== currentPc) return; // stale guard
    if (event.candidate) {
      context.sendSignalingMessage({
        type: "ice-candidate",
        targetPeerId: peerId,
        candidate: event.candidate,
      });
    }
  });

  // Connection state monitoring
  peerConnection.addEventListener("connectionstatechange", () => {
    if (context.peers.get(peerId)?.connection !== currentPc) return; // stale guard

    if (context.verbose) {
      console.log(
        `🔗 Connection to ${peerId}: ${peerConnection.connectionState}`,
      );
    }

    if (peerConnection.connectionState === "connected") {
      // Clear all failure tracking on successful connection
      const peer = context.peers.get(peerId);
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
      checkPeerReadiness(peerId, context);
    } else if (peerConnection.connectionState === "failed") {
      scheduleIceRestart(peerId, context);
    } else if (peerConnection.connectionState === "closed") {
      removePeer(peerId, context);
    } else if (peerConnection.connectionState === "disconnected") {
      const peer = context.peers.get(peerId);
      if (peer) {
        if (!peer.disconnectedSince) {
          peer.disconnectedSince = Date.now();
          if (context.verbose) {
            console.log(
              `⚠️ Connection to ${peerId} disconnected, monitoring for recovery...`,
            );
          }
        }
        // After 3s continuous disconnection, try ICE restart
        if (
          !peer.restartAttempted && peer.initiator &&
          Date.now() - peer.disconnectedSince > 3000
        ) {
          scheduleIceRestart(peerId, context);
        }
      }
    }
  });

  // Also monitor ICE connection state
  peerConnection.addEventListener("iceconnectionstatechange", () => {
    if (context.peers.get(peerId)?.connection !== currentPc) return; // stale guard

    if (context.verbose) {
      console.log(
        `🧊 ICE connection to ${peerId}: ${peerConnection.iceConnectionState}`,
      );
    }
  });

  // Handle incoming data channels (when we're not the initiator)
  peerConnection.addEventListener("datachannel", (event) => {
    if (context.peers.get(peerId)?.connection !== currentPc) return; // stale guard

    const channel = event.channel;
    if (context.verbose) {
      console.log(`📡 Received ${channel.label} channel from ${peerId}`);
    }
    setupDataChannel(channel, peerId, context);
  });
}

/**
 * Set up data channel event handlers
 * @param {RTCDataChannel} channel - Data channel
 * @param {string} peerId - Peer ID
 * @param {Object} context - WebRTC Star context
 */
export function setupDataChannel(channel, peerId, context) {
  const peer = context.peers.get(peerId);
  if (!peer) return;

  // Store channel reference in peer record
  if (channel.label === "sync") {
    peer.syncChannel = channel;
  } else if (channel.label === "control") {
    peer.controlChannel = channel;
  }

  // Also store generic dataChannel reference for backward compatibility
  if (!peer.dataChannel) {
    peer.dataChannel = channel;
  }

  channel.addEventListener("open", () => {
    if (context.verbose) {
      console.log(`📡 ${channel.label} channel to ${peerId} opened`);
    }

    // Optimize sync channel for high-frequency data
    if (channel.label === "sync") {
      try {
        channel.bufferedAmountLowThreshold = 16384; // 16 KB
        if (context.verbose) {
          console.log(
            `✅ Set bufferedAmountLowThreshold to 16KB for sync channel to ${peerId}`,
          );
        }
      } catch (error) {
        // Some browsers may not support this property
        if (context.verbose) {
          console.log(
            `⚠️ Could not set bufferedAmountLowThreshold: ${error.message}`,
          );
        }
      }
    }

    // Check if peer is now ready (both connection and sync channel)
    checkPeerReadiness(peerId, context);
  });

  // Debug: Log channel state immediately
  console.log(
    `📡 Channel '${channel.label}' for ${peerId} initial state: ${channel.readyState}`,
  );

  channel.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      context.validateMessage(message);
      context.handleDataChannelMessage(peerId, channel.label, message);
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
 * Check if peer is ready and emit connection event if needed
 * @param {string} peerId - Peer ID
 * @param {Object} context - WebRTC Star context
 */
export function checkPeerReadiness(peerId, context) {
  const peer = context.peers.get(peerId);
  if (!peer || peer.connectedEventSent) return;

  const connection = peer.connection;
  const syncChannel = peer.syncChannel;

  // Check if both connection and sync channel are ready
  const isConnected = connection.connectionState === "connected";
  const isSyncChannelReady = syncChannel && syncChannel.readyState === "open";

  if (isConnected && isSyncChannelReady && !peer.connectedEventSent) {
    peer.connectedEventSent = true;
    if (context.verbose) {
      console.log(`✅ Peer ${peerId} is fully ready`);
    }

    // Emit peer-connected event
    context.dispatchEvent(
      new CustomEvent("peer-connected", {
        detail: { peerId, peerType: peer.peerType },
      }),
    );
  }
}

/**
 * Schedule ICE restart for a peer connection
 * @param {string} peerId - Peer ID
 * @param {Object} context - WebRTC Star context
 */
export function scheduleIceRestart(peerId, context) {
  const peer = context.peers.get(peerId);
  if (!peer || peer.restartAttempted || !peer.initiator) return;

  peer.restartAttempted = true;

  if (context.verbose) {
    console.log(`🔄 Scheduling ICE restart for ${peerId}`);
  }

  peer.restartTimer = setTimeout(async () => {
    try {
      if (context.verbose) {
        console.log(`🔄 Attempting ICE restart for ${peerId}`);
      }

      const offer = await peer.connection.createOffer({ iceRestart: true });
      await peer.connection.setLocalDescription(offer);

      context.sendSignalingMessage({
        type: "offer",
        targetPeerId: peerId,
        offer: offer,
      });

      // After ICE restart, schedule full reconnection if still failing
      setTimeout(() => {
        if (
          peer.connection.connectionState === "failed" &&
          !peer.reconnectAttempted
        ) {
          scheduleFullReconnection(peerId, context);
        }
      }, 5000);
    } catch (error) {
      console.error(`❌ ICE restart failed for ${peerId}:`, error);
      scheduleFullReconnection(peerId, context);
    }
  }, 1000);
}

/**
 * Schedule full reconnection for a peer
 * @param {string} peerId - Peer ID
 * @param {Object} context - WebRTC Star context
 */
export function scheduleFullReconnection(peerId, context) {
  const peer = context.peers.get(peerId);
  if (!peer || peer.reconnectAttempted || !peer.initiator) return;

  peer.reconnectAttempted = true;

  if (context.verbose) {
    console.log(`🔄 Scheduling full reconnection for ${peerId}`);
  }

  peer.reconnectTimer = setTimeout(async () => {
    try {
      if (context.verbose) {
        console.log(`🔄 Attempting full reconnection to ${peerId}`);
      }

      // Remove the old connection
      removePeer(peerId, context);

      // Create a new connection
      await createPeerConnection(peerId, true, context);
    } catch (error) {
      console.error(`❌ Full reconnection failed for ${peerId}:`, error);
    }
  }, 3000);
}

/**
 * Remove a peer connection
 * @param {string} peerId - Peer ID
 * @param {Object} context - WebRTC Star context
 */
export function removePeer(peerId, context) {
  const peer = context.peers.get(peerId);
  if (!peer) return;

  if (context.verbose) {
    console.log(`🗑️ Removing peer ${peerId}`);
  }

  // Clean up timers
  if (peer.restartTimer) {
    clearTimeout(peer.restartTimer);
  }
  if (peer.reconnectTimer) {
    clearTimeout(peer.reconnectTimer);
  }

  // Close connection
  if (peer.connection) {
    peer.connection.close();
  }

  // Remove from peers map
  context.peers.delete(peerId);

  // Clear ping timeout
  if (context.pingTimeouts.has(peerId)) {
    clearTimeout(context.pingTimeouts.get(peerId));
    context.pingTimeouts.delete(peerId);
  }

  // Emit peer-removed event
  context.dispatchEvent(
    new CustomEvent("peer-removed", {
      detail: { peerId },
    }),
  );
}

/**
 * Drain pending ICE candidates after setting remote description
 * @param {string} peerId - Peer ID
 * @param {Object} context - WebRTC Star context
 */
export async function drainPendingCandidates(peerId, context) {
  const peer = context.peers.get(peerId);
  if (!peer || peer.pendingCandidates.length === 0) return;

  if (context.verbose) {
    console.log(
      `🔄 Draining ${peer.pendingCandidates.length} pending candidates for ${peerId}`,
    );
  }

  for (const candidate of peer.pendingCandidates) {
    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      if (context.verbose) {
        console.warn(
          `⚠️ Failed to add buffered candidate for ${peerId}:`,
          error.message,
        );
      }
    }
  }

  // Clear the buffer
  peer.pendingCandidates = [];
}