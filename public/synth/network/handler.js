/**
 * Network message routing for Voice.Assembly.FM Synth Client
 */

import { MessageTypes } from "../../../src/common/message-protocol.js";

/**
 * Set up WebRTC star event handlers
 * @param {WebRTCStar} star - WebRTC star instance
 * @param {Object} elements - UI elements
 * @param {function} updateConnectionStatus - Status update function
 * @param {function} handleDataMessage - Data message handler
 */
export function setupStarEventHandlers(
  star,
  elements,
  updateConnectionStatus,
  handleDataMessage,
) {
  star.addEventListener("peer-connected", (event) => {
    // Hide loading indicator and update status
    elements.loading.style.display = "none";
    updateConnectionStatus("connected", "Connected to network");
  });

  star.addEventListener("peer-removed", (event) => {
    // Peer disconnection handling
  });

  star.addEventListener("data-message", (event) => {
    const { peerId, channelType, message } = event.detail;
    handleDataMessage(peerId, channelType, message);
  });
}

/**
 * Handle incoming data messages
 * @param {string} peerId - Peer ID
 * @param {string} channelType - Channel type
 * @param {Object} message - Message data
 * @param {Object} context - Synth context
 */
export function handleDataMessage(peerId, channelType, message, context) {
  switch (message.type) {
    case MessageTypes.PROGRAM_UPDATE:
      context.handleProgramUpdate(message);
      break;

    case MessageTypes.SUB_PARAM_UPDATE:
      context.handleSubParameterUpdate(message);
      break;

    case MessageTypes.UNIFIED_PARAM_UPDATE:
      context.handleUnifiedParamUpdate(message);
      break;

    case MessageTypes.PHASOR_SYNC:
      context.handlePhasorSync(message);
      break;

    case MessageTypes.PROGRAM:
      context.handleProgramConfig(message);
      break;

    case MessageTypes.RERESOLVE_AT_EOC:
      console.log(
        "🔀 RERESOLVE_AT_EOC received - will re-randomize static HRG indices at next EOC",
      );
      context.reresolveAtNextEOC = true;
      break;

    case MessageTypes.IMMEDIATE_REINITIALIZE:
      context.handleImmediateReinitialize();
      break;

    case MessageTypes.SAVE_SCENE:
      context.handleSaveScene(message);
      break;

    case MessageTypes.LOAD_SCENE:
      context.handleLoadScene(message);
      break;

    case MessageTypes.CLEAR_BANKS:
      context.clearAllBanks();
      break;

    case MessageTypes.CLEAR_SCENE:
      context.clearBank(message.memoryLocation);
      break;

    case MessageTypes.TRANSPORT:
      context.handleTransport(message);
      break;

    case MessageTypes.JUMP_TO_EOC:
      context.handleJumpToEOC(message);
      break;

    default:
      break;
  }
}

/**
 * Handle direct parameter updates
 * @param {Object} message - Parameter update message
 * @param {Object} context - Synth context
 */
export function handleDirectParamUpdate(message, context) {
  console.log(
    `🎛️ Direct parameter update: ${message.param} = ${message.value}`,
  );

  // Handle single direct parameter updates (e.g., from blur events)
  if (!isReadyToReceiveParameters(context)) {
    return;
  }

  // Note: Routing changes are now handled by handleProgramUpdate staging
  // Direct value updates only - routing changes happen at EOC

  if (context.voiceNode) {
    // Route to voice worklet via SET_ENV message
    context.voiceNode.port.postMessage({
      type: "SET_ENV",
      v: 1,
      param: message.param,
      startValue: message.value,
      endValue: message.value,
      interpolation: "step",
      portamentoMs: 15, // Convert 0.015s to ms
    });
    console.log(
      `🔌 Route for '${message.param}': Main Thread -> Voice (SET_ENV)`,
    );
  }
}

/**
 * Check if synth is ready to receive parameters
 * @param {Object} context - Synth context
 * @returns {boolean} - Ready state
 */
export function isReadyToReceiveParameters(context) {
  if (!context.voiceNode) {
    console.warn(
      "⚠️ Cannot apply control state: voice worklet not ready",
    );
    return false;
  }

  return true;
}

/**
 * Handle legacy synth parameters (deprecated)
 * @param {Object} message - Synth parameters message
 * @param {Object} context - Synth context
 */

/**
 * Connect to network via WebRTC star
 * @param {WebRTCStar} star - WebRTC star instance
 * @returns {Promise<void>}
 */
export async function connectToNetwork(star) {
  // Connect to signaling server - use current host
  // Dynamic WebSocket URL that works in production and development
  const protocol = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
  const port = globalThis.location.port ? `:${globalThis.location.port}` : "";
  const signalingUrl = `${protocol}//${globalThis.location.hostname}${port}/ws`;
  await star.connect(signalingUrl);
}
