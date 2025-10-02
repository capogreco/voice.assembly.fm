/**
 * Data channel handling for WebRTC Star Network
 */

import { MessageTypes, MessageBuilder, validateMessage } from "../message-protocol.js";

/**
 * Handle data channel messages
 * @param {string} peerId - Peer ID
 * @param {string} channelType - Channel type ('sync' or 'control')
 * @param {Object} message - Message data
 * @param {Object} context - WebRTC Star context
 */
export function handleDataChannelMessage(peerId, channelType, message, context) {
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
    sendToPeer(peerId, pongMessage, channelType, context);
    return; // Don't emit ping messages to application layer
  }

  if (message.type === MessageTypes.PONG) {
    handlePongMessage(peerId, message, context);
    return; // Don't emit pong messages to application layer
  }

  // Emit event for upper layers to handle
  context.dispatchEvent(
    new CustomEvent("data-message", {
      detail: { peerId, channelType, message },
    }),
  );
}

/**
 * Handle pong message for network health tracking
 * @param {string} peerId - Peer ID
 * @param {Object} pongMessage - Pong message
 * @param {Object} context - WebRTC Star context
 */
export function handlePongMessage(peerId, pongMessage, context) {
  const pingId = pongMessage.pingId;
  const timeout = context.pingTimeouts.get(pingId);

  if (timeout) {
    clearTimeout(timeout);
    context.pingTimeouts.delete(pingId);

    // Calculate RTT for basic connectivity (suppress noisy logs unless verbose)
    const rtt = performance.now() - pongMessage.pingTimestamp;

    // Store RTT for diagnostics
    const peer = context.peers.get(peerId);
    if (peer) {
      peer.lastPingRtt = rtt;
    }

    if (context.verbose) {
      console.log(`🏓 Pong from ${peerId}: ${Math.round(rtt)}ms`);
    }
  }
}

/**
 * Send message to specific peer via data channel
 * @param {string} peerId - Peer ID
 * @param {Object} message - Message to send
 * @param {string} channelType - Channel type ('sync' or 'control')
 * @param {Object} context - WebRTC Star context
 * @returns {boolean} - Success status
 */
export function sendToPeer(peerId, message, channelType = "sync", context) {
  const peer = context.peers.get(peerId);
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

  // Adaptive pacing for sync channel only - never drop control messages
  if (channelType === "sync") {
    const threshold = channel.bufferedAmountLowThreshold || 16384; // Fallback to 16KB
    if (channel.bufferedAmount > threshold) {
      // Track dropped messages for diagnostics
      if (!peer.droppedSyncCount) peer.droppedSyncCount = 0;
      peer.droppedSyncCount++;

      // Log only first few drops to avoid spam
      if (peer.droppedSyncCount <= 3) {
        console.warn(
          `⏸️ Sync channel to ${peerId} buffered ${channel.bufferedAmount} bytes > ${threshold}, dropping message`,
        );
      }
      return false; // Skip this sync message
    }
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
 * @param {Object} message - Message to broadcast
 * @param {string} channelType - Channel type ('sync' or 'control')
 * @param {Object} context - WebRTC Star context
 * @returns {number} - Number of successful sends
 */
export function broadcast(message, channelType = "sync", context) {
  let successCount = 0;

  for (const [peerId] of context.peers) {
    if (sendToPeer(peerId, message, channelType, context)) {
      successCount++;
    }
  }

  return successCount;
}

/**
 * Broadcast message to peers of a specific type (e.g., 'synth', 'ctrl')
 * @param {string} targetType - Target peer type
 * @param {Object} message - Message to broadcast
 * @param {string} channelType - Channel type ('sync' or 'control')
 * @param {Object} context - WebRTC Star context
 * @returns {number} - Number of successful sends
 */
export function broadcastToType(targetType, message, channelType = "sync", context) {
  let successCount = 0;

  for (const [peerId, peer] of context.peers) {
    if (peer.peerType === targetType) {
      if (sendToPeer(peerId, message, channelType, context)) {
        successCount++;
      }
    }
  }

  return successCount;
}

/**
 * Get list of connected peers of a specific type
 * @param {string} peerType - Peer type to filter
 * @param {Object} context - WebRTC Star context
 * @returns {Array} - Array of peer IDs
 */
export function getConnectedPeersOfType(peerType, context) {
  const connectedPeers = [];

  for (const [peerId, peer] of context.peers) {
    if (
      peer.peerType === peerType &&
      peer.connection.connectionState === "connected" &&
      peer.syncChannel?.readyState === "open"
    ) {
      connectedPeers.push(peerId);
    }
  }

  return connectedPeers;
}

/**
 * Check if any peers of a specific type are connected
 * @param {string} peerType - Peer type to check
 * @param {Object} context - WebRTC Star context
 * @returns {boolean} - True if any peers of type are connected
 */
export function hasConnectedPeersOfType(peerType, context) {
  for (const [peerId, peer] of context.peers) {
    if (
      peer.peerType === peerType &&
      peer.connection.connectionState === "connected" &&
      peer.syncChannel?.readyState === "open"
    ) {
      return true;
    }
  }
  return false;
}