/**
 * ICE server handling for WebRTC Star Network
 */

/**
 * Fetch ICE servers from server endpoint
 * @param {Object} context - WebRTC Star context
 */
export async function fetchIceServers(context) {
  try {
    if (context.verbose) {
      console.log("🔍 Fetching ICE servers from /ice-servers...");
    }
    const response = await fetch("/ice-servers");
    if (response.ok) {
      const data = await response.json();
      if (data.ice_servers && data.ice_servers.length > 0) {
        context.iceServers = data.ice_servers;
        if (context.verbose) {
          console.log(
            `✅ Successfully fetched ${context.iceServers.length} ICE servers`,
          );
        }
      } else {
        if (context.verbose) {
          console.log("⚠️ No ICE servers returned, using fallback STUN");
        }
      }
    } else {
      throw new Error(
        `Failed to fetch ICE servers: ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    if (context.verbose) {
      console.log(`⚠️ ICE server fetch failed: ${error.message}`);
      console.log("Using fallback STUN servers");
    }
    // Keep default STUN servers as fallback
  }
}

/**
 * Handle ICE candidate message
 * @param {Object} message - ICE candidate message
 * @param {Object} context - WebRTC Star context
 */
export async function handleIceCandidate(message, context) {
  const { fromPeerId, candidate } = message;

  // If we get a candidate before the offer, we need to create the peer connection
  // This can happen due to network timing
  if (!context.peers.has(fromPeerId)) {
    if (context.verbose) {
      console.log(
        `🤝 Received ICE candidate from new peer ${fromPeerId}, creating placeholder connection`,
      );
    }
    await context.createPeerConnection(fromPeerId, false);
  }

  const peer = context.peers.get(fromPeerId);
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
        if (context.verbose) {
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

      if (context.verbose) {
        console.log(`✅ Added ICE candidate from ${fromPeerId}`);
      }
    }
    // A null candidate indicates the end of the gathering process
  } catch (error) {
    if (context.verbose) {
      console.warn(
        `⚠️ Non-fatal error adding ICE candidate for ${fromPeerId}:`,
        error.message,
      );
    }
    // Non-fatal error - let connection continue
  }
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

/**
 * Schedule ICE restart for a peer connection
 * @param {string} peerId - Peer ID
 * @param {Object} context - WebRTC Star context
 */
export function scheduleIceRestart(peerId, context) {
  const peer = context.peers.get(peerId);
  if (!peer) return;

  // Only allow ICE restart for initiating peers to prevent both sides trying
  if (!peer.initiator) {
    if (context.verbose) {
      console.log(`⚠️ Not restarting ICE for ${peerId} - not initiator`);
    }
    return;
  }

  // Check if ICE restart already attempted
  if (peer.restartAttempted) {
    if (context.verbose) {
      console.log(`⚠️ ICE restart already attempted for ${peerId}`);
    }
    return;
  }

  peer.restartAttempted = true;

  // Clear any existing timer
  if (peer.restartTimer) {
    clearTimeout(peer.restartTimer);
    peer.restartTimer = null;
  }

  if (context.verbose) console.log(`🔄 Attempting ICE restart to ${peerId}...`);

  try {
    const pc = peer.connection;
    const delayMs = 1000 + Math.random() * 1000; // 1-2s with jitter

    peer.restartTimer = setTimeout(async () => {
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);

        context.sendSignalingMessage({
          type: "offer",
          targetPeerId: peerId,
          offer: offer,
        });

        if (context.verbose) console.log(`📤 Sent ICE restart offer to ${peerId}`);

        // Schedule fallback rebuild if no recovery in 10s
        peer.reconnectTimer = setTimeout(() => {
          const currentPeer = context.peers.get(peerId);
          if (
            !currentPeer?.connection ||
            currentPeer.connection.connectionState !== "connected"
          ) {
            context.schedulePeerReconnect(peerId);
          }
        }, 10000);
      } catch (error) {
        console.error(`❌ ICE restart failed for ${peerId}:`, error);
        context.schedulePeerReconnect(peerId); // Fallback to rebuild
      }
    }, delayMs);
  } catch (error) {
    console.error(`❌ ICE restart setup failed for ${peerId}:`, error);
    context.schedulePeerReconnect(peerId); // Fallback to rebuild
  }
}

/**
 * Get ICE connection statistics for diagnostics
 * @param {string} peerId - Peer ID
 * @param {Object} context - WebRTC Star context
 * @returns {Object|null} - ICE stats or null if unavailable
 */
export async function getIceStats(peerId, context) {
  const peer = context.peers.get(peerId);
  if (!peer?.connection) return null;

  try {
    const stats = await peer.connection.getStats();
    const iceStats = {
      iceConnectionState: peer.connection.iceConnectionState,
      iceGatheringState: peer.connection.iceGatheringState,
      selectedCandidate: null,
      candidateType: "unknown",
      rtt: null,
    };

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
      iceStats.selectedCandidate = selectedPair;
      
      // Get RTT from candidate pair
      if (selectedPair.currentRoundTripTime !== undefined) {
        iceStats.rtt = Math.round(selectedPair.currentRoundTripTime * 1000); // Convert to ms
      }

      // Find remote candidate to get ICE type
      stats.forEach((stat) => {
        if (
          stat.type === "remote-candidate" &&
          stat.id === selectedPair.remoteCandidateId
        ) {
          // candidateType: host, srflx, prflx, relay
          iceStats.candidateType = stat.candidateType || "unknown";
        }
      });
    }

    return iceStats;
  } catch (error) {
    if (context.verbose) {
      console.warn(`⚠️ Could not get ICE stats for ${peerId}:`, error.message);
    }
    return null;
  }
}