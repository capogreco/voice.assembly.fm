// @ts-check

/**
 * WebRTC Star integration for Voice.Assembly.FM Control Client
 */

import { generatePeerId, WebRTCStar } from "../../../src/common/webrtc-star.js";
import {
  MessageBuilder,
  MessageTypes,
} from "../../../src/common/message-protocol.js";

/**
 * Initialize WebRTC star connection
 * @param {string} peerId - Peer ID
 * @returns {Promise<WebRTCStar>} - WebRTC star instance
 */
export async function initializeWebRTCStar(peerId) {
  const star = new WebRTCStar(peerId, "ctrl");
  
  // Connect to signaling server - use current host
  // Dynamic WebSocket URL that works in production and development
  const protocol = globalThis.location.protocol === "https:"
    ? "wss:"
    : "ws:";
  const port = globalThis.location.port
    ? ":" + globalThis.location.port
    : "";
  const signalingUrl = protocol + "//" + globalThis.location.hostname + port + "/ws";
  
  await star.connect(signalingUrl);
  
  return star;
}

/**
 * Setup WebRTC star event handlers
 * @param {WebRTCStar} star - WebRTC star instance
 * @param {Object} callbacks - Event callbacks
 * @param {function} callbacks.onBecameLeader - Became leader callback
 * @param {function} callbacks.onControllerActive - Controller active callback
 * @param {function} callbacks.onPeerConnected - Peer connected callback
 * @param {function} callbacks.onPeerRemoved - Peer removed callback
 * @param {function} callbacks.onKicked - Kicked callback
 * @param {function} callbacks.onJoinRejected - Join rejected callback
 * @param {function} callbacks.onDataMessage - Data message callback
 * @param {function} callbacks.onDataChannelMessage - Data channel message callback
 * @param {function} callbacks.log - Logging function
 */
export function setupStarEventHandlers(star, callbacks) {
  star.addEventListener("became-leader", () => {
    callbacks.log("Became network leader", "success");
    callbacks.onBecameLeader();
  });

  star.addEventListener("controller-active", (event) => {
    callbacks.log("Controller is now active", "success");
    callbacks.onControllerActive();
  });

  star.addEventListener("peer-connected", (event) => {
    const { peerId } = event.detail;
    callbacks.log("Peer connected", "info");
    callbacks.onPeerConnected(peerId);
  });

  star.addEventListener("peer-removed", (event) => {
    callbacks.log("Peer disconnected", "info");
    callbacks.onPeerRemoved();
  });

  star.addEventListener("kicked", (event) => {
    callbacks.onKicked(event.detail.reason);
  });

  star.addEventListener("join-rejected", (event) => {
    callbacks.log("Cannot join", "error");
    callbacks.onJoinRejected(event.detail.reason);
  });

  star.addEventListener("data-message", (event) => {
    const { peerId, channelType, message } = event.detail;

    // Handle ping messages
    if (message.type === MessageTypes.PING) {
      const pong = MessageBuilder.pong(message.id, message.timestamp);
      star.sendToPeer(peerId, pong, "sync");
    }

    callbacks.onDataMessage(peerId, channelType, message);
  });

  star.addEventListener("data-channel-message", (event) => {
    callbacks.onDataChannelMessage(event.detail);
  });
}

/**
 * Connect to network with error handling
 * @param {Object} context - Connection context
 * @param {string} context.peerId - Peer ID
 * @param {boolean} context.wasKicked - Was kicked flag
 * @param {string} context.kickedReason - Kicked reason
 * @param {function} context.updateConnectionStatus - Status update function
 * @param {function} context.log - Logging function
 * @param {Object} callbacks - Event callbacks for setupStarEventHandlers
 * @returns {Promise<WebRTCStar|null>} - WebRTC star instance or null if failed
 */
export async function connectToNetwork(context, callbacks) {
  try {
    // Prevent reconnection if we were kicked
    if (context.wasKicked) {
      context.log("Not reconnecting - was kicked: " + context.kickedReason, "error");
      return null;
    }

    context.updateConnectionStatus("connecting");
    context.log("Connecting to network...", "info");

    const star = await initializeWebRTCStar(context.peerId);
    setupStarEventHandlers(star, callbacks);

    // Initially connected - status will be determined by server response
    context.updateConnectionStatus("connected");
    context.log("Connected to network successfully", "success");
    
    return star;
  } catch (error) {
    context.log("Connection failed", "error");
    context.updateConnectionStatus("disconnected");
    return null;
  }
}

/**
 * Handle being kicked from network
 * @param {string} reason - Kick reason
 * @param {function} updateConnectionStatus - Status update function
 * @param {function} log - Logging function
 * @returns {Object} - Updated kick state
 */
export function handleKicked(reason, updateConnectionStatus, log) {
  log("Kicked from network: " + reason, "error");
  updateConnectionStatus("kicked");
  
  return {
    wasKicked: true,
    kickedReason: reason,
  };
}

/**
 * Handle join rejection with force takeover option
 * @param {string} reason - Rejection reason
 * @param {function} updateConnectionStatus - Status update function
 * @param {function} reconnectCallback - Callback to reconnect with force
 */
export function handleJoinRejected(reason, updateConnectionStatus, reconnectCallback) {
  updateConnectionStatus("error");
  
  if (reason.includes("Add ?force=true")) {
    if (confirm("Another control client is already connected. Force takeover?")) {
      // Add force parameter and reconnect
      const url = new URL(globalThis.location);
      url.searchParams.set("force", "true");
      globalThis.location.href = url.toString();
    }
  }
}

/**
 * Send complete state to new synth
 * @param {WebRTCStar} star - WebRTC star instance
 * @param {string} peerId - Peer ID
 * @param {Object} musicalState - Current musical state
 * @param {boolean} synthesisActive - Synthesis active flag
 * @param {function} log - Logging function
 */
export function sendCompleteStateToNewSynth(star, peerId, musicalState, synthesisActive, log) {
  if (!star || !peerId.startsWith("synth-")) return;

  log("Sending complete state to new synth", "info");

  const wirePayload = {
    synthesisActive: synthesisActive,
  };

  // Convert each parameter to wire format
  Object.keys(musicalState).forEach((paramName) => {
    const paramState = musicalState[paramName];
    
    // Create deep copies to avoid mutation
    const startGen = { ...paramState.startValueGenerator };
    let endGen = undefined;
    
    if ((paramState.interpolation === "disc" || paramState.interpolation === "cont") && paramState.endValueGenerator) {
      endGen = { ...paramState.endValueGenerator };
    }

    wirePayload[paramName] = {
      interpolation: paramState.interpolation,
      startValueGenerator: startGen,
      endValueGenerator: endGen,
      baseValue: paramState.baseValue,
    };
  });

  const message = MessageBuilder.createParameterUpdate(
    MessageTypes.PROGRAM_UPDATE,
    wirePayload,
  );
  
  star.sendToPeer(peerId, message, "control");
}

/**
 * Update peer list display
 * @param {WebRTCStar} star - WebRTC star instance
 * @param {HTMLElement} peerListElement - Peer list element
 */
export function updatePeerList(star, peerListElement) {
  if (!star || !peerListElement) return;

  const peers = Array.from(star.peers.keys()).sort();
  const stats = star.getNetworkDiagnostics();

  if (peers.length === 0) {
    clearPeerList(peerListElement);
    return;
  }

  const listHTML = peers.map((peerId) => {
    const peerStats = stats.peerStats[peerId];
    const peerType = peerStats.peerType || peerId.split("-")[0];

    return '<div class="peer-item">' +
      '<div class="peer-info">' +
      '<div class="peer-id">' + peerId + '</div>' +
      '<div class="peer-type">' + peerType + '</div>' +
      '</div>' +
      '<div class="peer-stats">' +
      '<div>Status: ' + peerStats.connectionState + '</div>' +
      '</div>' +
      '</div>';
  }).join("");

  peerListElement.innerHTML = listHTML;
}

/**
 * Clear peer list display
 * @param {HTMLElement} peerListElement - Peer list element
 */
export function clearPeerList(peerListElement) {
  if (!peerListElement) return;
  
  peerListElement.innerHTML = '<div style="color: #888; font-style: italic; text-align: center; padding: 20px;">No peers connected</div>';
}

/**
 * Handle parameter applied message from synth
 * @param {Set} pendingParameterChanges - Set of pending parameter changes
 * @param {string} param - Parameter name
 * @param {function} updateParameterVisualFeedback - Update visual feedback function
 * @param {function} log - Logging function
 */
export function handleParameterApplied(pendingParameterChanges, param, updateParameterVisualFeedback, log) {
  pendingParameterChanges.delete(param);
  updateParameterVisualFeedback(param);
  log("Cleared pending asterisk for " + param, "debug");
}

/**
 * Generate a new controller peer ID
 * @returns {string} - New peer ID
 */
export function generateControllerPeerId() {
  return generatePeerId("ctrl");
}