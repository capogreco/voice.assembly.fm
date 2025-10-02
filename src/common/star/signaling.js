/**
 * WebSocket signaling functionality for WebRTC Star Network
 */

import { MessageTypes } from "../message-protocol.js";

/**
 * Connect to signaling server and register
 * @param {string} signalingUrl - WebSocket URL
 * @param {boolean} forceTakeover - Force takeover for ctrl clients
 * @param {Object} context - WebRTC Star context
 * @returns {Promise<boolean>} - Connection success
 */
export async function connect(signalingUrl, forceTakeover, context) {
  context.forceTakeover = forceTakeover;
  context.signalingUrl = signalingUrl; // Save for reconnection
  
  return new Promise((resolve, reject) => {
    context.signalingSocket = new WebSocket(signalingUrl);

    context.signalingSocket.addEventListener("open", () => {
      if (context.verbose) console.log("📡 Connected to signaling server");

      // Reset backoff on successful connection
      context.signalingBackoffMs = 1000;

      // Register with server - include force_takeover for ctrl clients
      const registerMessage = {
        type: "register",
        client_id: context.peerId,
      };

      if (context.peerType === "ctrl" && forceTakeover) {
        registerMessage.force_takeover = true;
      }

      sendSignalingMessage(registerMessage, context);

      // Request peer lists after registration
      setTimeout(() => {
        if (context.peerType === "synth") {
          sendSignalingMessage({
            type: "request-ctrls",
          }, context);
        } else if (context.peerType === "ctrl") {
          if (context.verbose) {
            console.log(
              "CTRL-DISCOVERY: Connection open, requesting synth list.",
            );
          }
          sendSignalingMessage({
            type: "request-synths",
          }, context);
        }
      }, 100); // Small delay to ensure registration is processed
    });

    context.signalingSocket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      await handleSignalingMessage(message, context);

      // Handle successful connection for simplified protocol
      if (message.type === "ctrls-list" || message.type === "ctrl-joined") {
        context.isConnectedToSignaling = true;
        // Delay ping timer to allow data channels to establish
        setTimeout(() => startPingTimer(context), 3000);
        resolve(true);
      } else if (context.peerType === "ctrl") {
        // Ctrl clients resolve immediately after registration
        context.isConnectedToSignaling = true;
        setTimeout(() => startPingTimer(context), 3000);
        resolve(true);
      }
    });

    context.signalingSocket.addEventListener("error", (error) => {
      console.error("❌ Signaling connection error:", error);
      if (!context.wasKicked) {
        scheduleSignalingReconnect(context);
      }
      // DO NOT REJECT - the reconnection logic will handle this.
    });

    context.signalingSocket.addEventListener("close", () => {
      console.log("🔌 Signaling connection closed");
      context.isConnectedToSignaling = false;
      // Don't cleanup peers - they can survive signaling downtime
      // Schedule reconnection instead
      if (!context.wasKicked) {
        scheduleSignalingReconnect(context);
      }
    });
  });
}

/**
 * Send message to signaling server
 * @param {Object} message - Message to send
 * @param {Object} context - WebRTC Star context
 */
export function sendSignalingMessage(message, context) {
  if (context.signalingSocket && context.signalingSocket.readyState === WebSocket.OPEN) {
    context.signalingSocket.send(JSON.stringify(message));
  } else {
    console.warn("⚠️ Cannot send signaling message - not connected");
  }
}

/**
 * Schedule signaling reconnection with exponential backoff
 * @param {Object} context - WebRTC Star context
 */
export function scheduleSignalingReconnect(context) {
  if (context.wasKicked) {
    if (context.verbose) {
      console.log(
        "🚫 Not scheduling reconnection - was kicked:",
        context.kickedReason,
      );
    }
    return;
  }

  if (context.signalingReconnectTimer) return; // Already scheduled

  if (context.verbose) {
    console.log(
      `🔄 Scheduling signaling reconnection in ${context.signalingBackoffMs}ms`,
    );
  }

  context.signalingReconnectTimer = setTimeout(() => {
    context.signalingReconnectTimer = null;
    if (context.verbose) {
      console.log("🔄 Attempting signaling reconnection...");
    }
    connect(context.signalingUrl, context.forceTakeover, context);
  }, context.signalingBackoffMs);

  // Exponential backoff
  context.signalingBackoffMs = Math.min(
    context.signalingBackoffMs * 2,
    context.signalingMaxBackoffMs,
  );
}

/**
 * Handle signaling server messages
 * @param {Object} message - Signaling message
 * @param {Object} context - WebRTC Star context
 */
export async function handleSignalingMessage(message, context) {
  switch (message.type) {
    case "ctrls-list":
      await handleCtrlsList(message, context);
      break;

    case "synths-list":
      await handleSynthsList(message, context);
      break;

    case "ctrl-joined":
      await handleCtrlJoined(message, context);
      break;

    case "synth-joined":
      await handleSynthJoined(message, context);
      break;

    case "peer-left":
      handlePeerLeft(message, context);
      break;

    case "ice-candidate":
      await handleIceCandidate(message, context);
      break;

    case "offer":
      await handleOffer(message, context);
      break;

    case "answer":
      await handleAnswer(message, context);
      break;

    case "error":
      handleSignalingError(message, context);
      break;

    case "takeover-success":
      if (context.verbose) {
        console.log("✅ Takeover successful - we are now the active ctrl");
      }
      break;

    case "kicked":
      handleKicked(message, context);
      break;

    default:
      if (context.verbose) {
        console.log("🔍 Unknown signaling message:", message);
      }
      break;
  }
}

/**
 * Handle controllers list message
 * @param {Object} message - Ctrls list message
 * @param {Object} context - WebRTC Star context
 */
async function handleCtrlsList(message, context) {
  if (context.peerType === "synth") {
    if (context.verbose) {
      console.log("SYNTH-DISCOVERY: Received ctrls list:", message.ctrls);
    }

    // Clear any pending retry
    if (context.ctrlRetryTimeout) {
      clearTimeout(context.ctrlRetryTimeout);
      context.ctrlRetryTimeout = null;
    }

    if (message.ctrls.length === 0) {
      // If we get an empty list, a ctrl client may be in the process of reconnecting.
      // We will retry requesting the list a few times.
      if (context.ctrlRetryCount < context.maxCtrlRetries) {
        context.ctrlRetryCount++;
        // Use a reasonable retry delay with jitter to avoid busy loops.
        const retryDelay = 1000 + Math.random() * 1000; // 1-2s with jitter

        if (context.verbose) {
          console.log(
            `[SYNTH-RETRY] No controllers found. Retrying in ${
              Math.round(retryDelay)
            }ms (attempt ${context.ctrlRetryCount}/${context.maxCtrlRetries})`,
          );
        }

        context.ctrlRetryTimeout = setTimeout(() => {
          if (
            context.signalingSocket &&
            context.signalingSocket.readyState === WebSocket.OPEN
          ) {
            if (context.verbose) {
              console.log(
                "[SYNTH-RETRY] Executing retry request for controllers.",
              );
            }
            sendSignalingMessage({ type: "request-ctrls" }, context);
          }
        }, retryDelay);
      } else {
        if (context.verbose) {
          console.warn(
            `[SYNTH-RETRY] No controllers found after ${context.maxCtrlRetries} attempts. Giving up.`,
          );
        }
      }
    } else {
      // Reset retry counter on successful response
      context.ctrlRetryCount = 0;
      // Deterministic role: ctrl is initiator. Synth does NOT initiate.
      // We simply ensure a placeholder peer record exists and wait for ctrl to offer.
      for (const ctrlId of message.ctrls) {
        if (!context.peers.has(ctrlId)) {
          if (context.verbose) {
            console.log(
              `[SYNTH-HANDSHAKE] Discovered new controller ${ctrlId}. Creating placeholder peer connection.`,
            );
          }
          await context.createPeerConnection(ctrlId, false);
        } else {
          if (context.verbose) {
            console.log(
              `[SYNTH-HANDSHAKE] Controller ${ctrlId} already exists.`,
            );
          }
        }
      }
    }
  }
}

/**
 * Handle synths list message
 * @param {Object} message - Synths list message
 * @param {Object} context - WebRTC Star context
 */
async function handleSynthsList(message, context) {
  if (context.peerType === "ctrl") {
    if (context.verbose) {
      console.log("CTRL-DISCOVERY: Received synths list:", message.synths);
    }
    
    for (const synthId of message.synths) {
      if (!context.peers.has(synthId)) {
        if (context.verbose) {
          console.log(
            `[CTRL-HANDSHAKE] Discovered new synth ${synthId}. Creating and initiating connection.`,
          );
        }
        await context.createPeerConnection(synthId, true);
      } else {
        if (context.verbose) {
          console.log(
            `[CTRL-HANDSHAKE] Synth ${synthId} already exists.`,
          );
        }
      }
    }
  }
}

/**
 * Handle controller joined message
 * @param {Object} message - Ctrl joined message
 * @param {Object} context - WebRTC Star context
 */
async function handleCtrlJoined(message, context) {
  if (context.peerType === "synth") {
    const ctrlId = message.client_id;
    if (context.verbose) {
      console.log(
        `[SYNTH-EVENT] Controller ${ctrlId} joined. Creating placeholder peer connection.`,
      );
    }
    if (!context.peers.has(ctrlId)) {
      await context.createPeerConnection(ctrlId, false);
    }
  }
}

/**
 * Handle synth joined message
 * @param {Object} message - Synth joined message
 * @param {Object} context - WebRTC Star context
 */
async function handleSynthJoined(message, context) {
  if (context.peerType === "ctrl") {
    const synthId = message.client_id;
    if (context.verbose) {
      console.log(
        `[CTRL-EVENT] Synth ${synthId} joined. Creating and initiating connection.`,
      );
    }
    if (!context.peers.has(synthId)) {
      await context.createPeerConnection(synthId, true);
    }
  }
}

/**
 * Handle peer left message
 * @param {Object} message - Peer left message
 * @param {Object} context - WebRTC Star context
 */
function handlePeerLeft(message, context) {
  const peerId = message.client_id;
  if (context.verbose) {
    console.log(`👋 Peer ${peerId} left`);
  }
  context.removePeer(peerId);
}

/**
 * Handle ICE candidate message
 * @param {Object} message - ICE candidate message
 * @param {Object} context - WebRTC Star context
 */
async function handleIceCandidate(message, context) {
  const peer = context.peers.get(message.from);
  if (peer && peer.connection) {
    try {
      await peer.connection.addIceCandidate(
        new RTCIceCandidate(message.candidate),
      );
      if (context.verbose) {
        console.log(`🧊 Added ICE candidate from ${message.from}`);
      }
    } catch (error) {
      console.error(`❌ Failed to add ICE candidate from ${message.from}:`, error);
    }
  }
}

/**
 * Handle WebRTC offer message
 * @param {Object} message - Offer message
 * @param {Object} context - WebRTC Star context
 */
async function handleOffer(message, context) {
  const peerId = message.from;
  if (context.verbose) {
    console.log(`📞 Received offer from ${peerId}`);
  }

  let peer = context.peers.get(peerId);
  if (!peer) {
    // Create peer connection if it doesn't exist
    await context.createPeerConnection(peerId, false);
    peer = context.peers.get(peerId);
  }

  if (peer && peer.connection) {
    try {
      await peer.connection.setRemoteDescription(
        new RTCSessionDescription(message.offer),
      );

      // Create and send answer
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);

      sendSignalingMessage({
        type: "answer",
        to: peerId,
        answer: answer,
      }, context);

      if (context.verbose) {
        console.log(`📱 Sent answer to ${peerId}`);
      }
    } catch (error) {
      console.error(`❌ Failed to handle offer from ${peerId}:`, error);
    }
  }
}

/**
 * Handle WebRTC answer message
 * @param {Object} message - Answer message
 * @param {Object} context - WebRTC Star context
 */
async function handleAnswer(message, context) {
  const peer = context.peers.get(message.from);
  if (peer && peer.connection) {
    try {
      await peer.connection.setRemoteDescription(
        new RTCSessionDescription(message.answer),
      );
      if (context.verbose) {
        console.log(`✅ Received answer from ${message.from}`);
      }
    } catch (error) {
      console.error(`❌ Failed to handle answer from ${message.from}:`, error);
    }
  }
}

/**
 * Handle signaling error message
 * @param {Object} message - Error message
 * @param {Object} context - WebRTC Star context
 */
function handleSignalingError(message, context) {
  console.error("❌ Signaling error:", message.error);
  if (message.error === "duplicate_client_id") {
    console.error("🚫 Duplicate client ID - cannot register");
    context.wasKicked = true;
    context.kickedReason = "duplicate_client_id";
  }
}

/**
 * Handle kicked message
 * @param {Object} message - Kicked message
 * @param {Object} context - WebRTC Star context
 */
function handleKicked(message, context) {
  console.warn(`🚫 Kicked from network: ${message.reason}`);
  context.wasKicked = true;
  context.kickedReason = message.reason;
  
  // Don't attempt reconnection when kicked
  if (context.signalingReconnectTimer) {
    clearTimeout(context.signalingReconnectTimer);
    context.signalingReconnectTimer = null;
  }
}

/**
 * Start ping timer for connection health monitoring
 * @param {Object} context - WebRTC Star context
 */
function startPingTimer(context) {
  if (context.pingInterval) return; // Already started

  context.pingInterval = setInterval(() => {
    for (const [peerId, peer] of context.peers.entries()) {
      if (peer.dataChannel && peer.dataChannel.readyState === "open") {
        // Send ping and set timeout for pong
        const pingId = Math.random().toString(36).substr(2, 9);
        peer.dataChannel.send(JSON.stringify({
          type: "ping",
          id: pingId,
          timestamp: Date.now(),
        }));

        // Set timeout for pong response
        const timeoutId = setTimeout(() => {
          console.warn(`⚠️ Ping timeout for peer ${peerId}`);
          context.removePeer(peerId);
        }, 5000); // 5 second timeout

        context.pingTimeouts.set(peerId, timeoutId);
      }
    }
  }, 30000); // Ping every 30 seconds
}