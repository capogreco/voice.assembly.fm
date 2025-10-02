/**
 * Connection health monitoring for WebRTC Star Network
 */

import { MessageBuilder } from "../message-protocol.js";

/**
 * Start ping timer for connection health monitoring
 * @param {Object} context - WebRTC Star context
 */
export function startPingTimer(context) {
  if (context.pingInterval) {
    clearInterval(context.pingInterval);
  }

  context.pingInterval = setInterval(() => {
    pingAllPeers(context);
  }, 1000); // Ping every second
}

/**
 * Stop ping timer
 * @param {Object} context - WebRTC Star context
 */
export function stopPingTimer(context) {
  if (context.pingInterval) {
    clearInterval(context.pingInterval);
    context.pingInterval = null;
  }

  // Clear all ping timeouts
  for (const timeout of context.pingTimeouts.values()) {
    clearTimeout(timeout);
  }
  context.pingTimeouts.clear();
}

/**
 * Ping all connected peers
 * @param {Object} context - WebRTC Star context
 */
export function pingAllPeers(context) {
  for (const [peerId] of context.peers) {
    pingPeer(peerId, context);
  }
}

/**
 * Ping specific peer
 * @param {string} peerId - Peer ID
 * @param {Object} context - WebRTC Star context
 */
export function pingPeer(peerId, context) {
  const peer = context.peers.get(peerId);
  if (!peer || !peer.syncChannel || peer.syncChannel.readyState !== "open") {
    // Skip ping if channel not ready
    return;
  }

  const pingMessage = MessageBuilder.ping();

  // Set timeout for ping response
  const timeout = setTimeout(() => {
    console.log(`⚠️ Ping timeout for ${peerId}`);
    context.pingTimeouts.delete(pingMessage.id);

    // Don't automatically remove peers on ping timeout - let WebRTC connection state handle disconnections
    // This prevents booting peers due to temporary network hiccups
  }, 5000); // 5 second timeout

  context.pingTimeouts.set(pingMessage.id, timeout);
  context.sendToPeer(peerId, pingMessage, "sync");
}

/**
 * Check if peer is ready (strict 4-condition check)
 * @param {string} peerId - Peer ID
 * @param {Object} context - WebRTC Star context
 */
export function checkPeerReadiness(peerId, context) {
  const peer = context.peers.get(peerId);
  if (!peer) return;

  // Strict readiness: require ALL 4 conditions
  const isConnectionReady = peer.connection.connectionState === "connected";
  const isIceReady = peer.connection.iceConnectionState === "connected" ||
    peer.connection.iceConnectionState === "completed";
  const isSyncChannelReady = peer.syncChannel?.readyState === "open";
  const isControlChannelReady = peer.controlChannel?.readyState === "open";

  const ready = isConnectionReady && isIceReady && isSyncChannelReady &&
    isControlChannelReady;

  // Debug info
  if (context.verbose) {
    console.log(`🔍 Peer ${peerId} readiness check:`, {
      connectionState: peer.connection.connectionState,
      iceState: peer.connection.iceConnectionState,
      syncChannelState: peer.syncChannel?.readyState,
      controlChannelState: peer.controlChannel?.readyState,
      ready: ready,
    });
  }

  if (ready) {
    if (context.verbose) {
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
      context.dispatchEvent(
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
    if (context.verbose) {
      console.log(
        `⏳ Peer ${peerId} - Connection: ${
          isConnectionReady ? "ready" : "waiting"
        }, ICE: ${isIceReady ? "ready" : "waiting"}, Sync: ${
          isSyncChannelReady ? "ready" : "waiting"
        }, Control: ${isControlChannelReady ? "ready" : "waiting"}`,
      );
    }
  }
}

/**
 * Get network statistics
 * @param {Object} context - WebRTC Star context
 * @returns {Object} - Network statistics
 */
export function getNetworkStats(context) {
  const peerStats = {};

  for (const [peerId, peer] of context.peers) {
    peerStats[peerId] = {
      connectionState: peer.connection.connectionState,
      peerType: peer.peerType,
    };
  }

  return {
    peerId: context.peerId,
    peerType: context.peerType,
    connectedPeers: context.peers.size,
    peerStats,
  };
}

/**
 * Get detailed peer diagnostics including ICE type and RTT
 * @param {Object} context - WebRTC Star context
 * @returns {Array} - Array of peer diagnostics
 */
export async function getPeerDiagnostics(context) {
  const diagnostics = [];

  for (const [peerId, peer] of context.peers) {
    const diag = {
      peerId,
      peerType: peer.peerType,
      connectionState: peer.connection.connectionState,
      iceConnectionState: peer.connection.iceConnectionState,
      syncChannelState: peer.syncChannel?.readyState || "none",
      controlChannelState: peer.controlChannel?.readyState || "none",
      droppedSyncMessages: peer.droppedSyncCount || 0,
      iceType: "unknown",
      rtt: null,
    };

    // Try to get WebRTC stats for ICE type and RTT
    try {
      const stats = await peer.connection.getStats();

      // Find the selected candidate pair
      let selectedPair = null;
      let transport = null;

      stats.forEach((stat) => {
        if (stat.type === "transport") {
          transport = stat;
        }
        if (stat.type === "candidate-pair") {
          // Chrome uses nominated, modern spec uses selectedCandidatePairId
          if (
            stat.nominated ||
            (transport && stat.id === transport.selectedCandidatePairId)
          ) {
            if (stat.state === "succeeded" || !selectedPair) {
              selectedPair = stat;
            }
          }
        }
      });

      if (selectedPair) {
        // Get RTT from candidate pair
        if (selectedPair.currentRoundTripTime !== undefined) {
          diag.rtt = Math.round(selectedPair.currentRoundTripTime * 1000); // Convert to ms
        }

        // Find remote candidate to get ICE type
        stats.forEach((stat) => {
          if (
            stat.type === "remote-candidate" &&
            stat.id === selectedPair.remoteCandidateId
          ) {
            // candidateType: host, srflx, prflx, relay
            diag.iceType = stat.candidateType || "unknown";
          }
        });
      }
    } catch (error) {
      if (context.verbose) {
        console.warn(`⚠️ Could not get stats for ${peerId}:`, error.message);
      }
    }

    // Fallback RTT from ping/pong if WebRTC stats unavailable
    if (diag.rtt === null && peer.lastPingRtt !== undefined) {
      diag.rtt = Math.round(peer.lastPingRtt);
    }

    diagnostics.push(diag);
  }

  return diagnostics;
}

/**
 * Cleanup health monitoring resources
 * @param {Object} context - WebRTC Star context
 */
export function cleanup(context) {
  // Stop ping timer
  stopPingTimer(context);

  // Clear ctrl retry timeout
  if (context.ctrlRetryTimeout) {
    clearTimeout(context.ctrlRetryTimeout);
    context.ctrlRetryTimeout = null;
  }

  // Clear signaling reconnection timer
  if (context.signalingReconnectTimer) {
    clearTimeout(context.signalingReconnectTimer);
    context.signalingReconnectTimer = null;
  }

  if (context.verbose) console.log("🧹 Health monitoring cleaned up");
}