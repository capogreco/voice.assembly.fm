// @ts-check

/**
 * Application Initialization for Voice.Assembly.FM Control Client
 * Handles boot sequence, property initialization, and DOM element wiring
 */

import { generatePeerId } from "../../../src/common/webrtc-star.js";
import { createDefaultState } from "../state/defaults.js";
import { setupEventHandlers } from "../ui/controls.js";

/**
 * Initialize ControlClient properties and state
 * @param {Object} ctrl - The ControlClient instance
 */
export function initializeProperties(ctrl) {
  // Initialize properties with JSDoc types

  /** @type {string} */
  ctrl.peerId = generatePeerId("ctrl");

  /** @type {any} WebRTC star connection */
  ctrl.star = null;

  /** @type {IControlState} */
  ctrl.liveState = createDefaultState();

  /** @type {IControlState} */
  ctrl.stagedState = createDefaultState();

  /** @type {boolean} */
  ctrl.synthesisActive = false;

  // Audio context for phasor scheduling
  /** @type {AudioContext|null} */
  ctrl.audioContext = null;

  // Phasor state
  ctrl.phasor = 0.0; // Current phasor position (0.0 to 1.0)
  ctrl.isPlaying = false; // Global transport state - starts paused
  ctrl.periodSec = 2.0; // Period in seconds (default 2.0)
  ctrl.stepsPerCycle = 16; // Number of steps per cycle
  ctrl.cycleLength = 2.0; // Seconds per cycle (same)
  ctrl.lastPhasorTime = 0; // For delta time calculation
  ctrl.phasorUpdateId = null; // RequestAnimationFrame ID
  ctrl.lastBroadcastTime = 0; // For phasor broadcast rate limiting
  ctrl.phasorBroadcastRate = 10; // Hz - legacy (now EOC-only)
  ctrl.lastPausedHeartbeat = 0; // Track paused heartbeat timing

  // EOC-staged timing changes
  ctrl.pendingPeriodSec = null; // Pending period change
  ctrl.pendingStepsPerCycle = null; // Pending steps change

  // Period-Steps linkage system
  ctrl.stepRefSec = 0.2; // Reference step interval (≥0.2s)
  ctrl.linkStepsToPeriod = true; // Auto-compute steps from period
  ctrl.currentStepIndex = 0; // Track current step for boundary detection
  ctrl.previousStepIndex = 0; // For detecting step transitions
  ctrl.lastPausedBeaconAt = 0; // Track last paused beacon time

  // Beacon stride constants
  ctrl.MIN_BEACON_INTERVAL_SEC = 0.2;

  // ES-8 Integration
  ctrl.audioContext = null; // AudioContext for ES-8 CV output
  ctrl.es8Enabled = false; // Enable/disable ES-8 output
  ctrl.es8Node = null; // ES-8 AudioWorklet node

  // Parameter staging for EOC application
  ctrl.hasPendingChanges = false; // Track if there are pending parameter changes
  ctrl.pendingParameterChanges = new Set(); // Track which specific parameters have pending changes

  // Bulk mode initialization
  ctrl.bulkModeEnabled = false;
  ctrl.bulkChanges = [];

  // Kicked state tracking
  /** @type {boolean} */
  ctrl.wasKicked = false;

  /** @type {string | null} */
  ctrl.kickedReason = null;
}

/**
 * Wire up DOM element references
 * @param {Object} ctrl - The ControlClient instance
 */
export function wireUpDOMElements(ctrl) {
  // UI Elements
  ctrl.elements = {
    connectionStatus: document.getElementById("connection-status"),
    connectionValue: document.getElementById("connection-status"), // Same element
    synthesisStatus: document.getElementById("synthesis-status"),
    networkDiagnostics: document.getElementById("network-diagnostics"),
    // Removed peers status - now using synth count in connected synths panel

    manualModeBtn: document.getElementById("manual-mode-btn"),

    // Musical controls
    // Simplified control surface inputs
    frequencyValue: document.getElementById("frequency-base"),

    // Phasor controls
    periodInput: document.getElementById("period-seconds"),
    stepsInput: document.getElementById("steps-per-cycle"),

    // Transport controls
    playBtn: document.getElementById("play-btn"),
    stopBtn: document.getElementById("stop-btn"),
    resetBtn: document.getElementById("reset-btn"),
    stepsPerCycleSlider: document.getElementById("steps-per-cycle-slider"),
    stepsPerCycleValue: document.getElementById("steps-per-cycle-value"),
    phasorDisplay: document.getElementById("phasor-display"),
    phasorBar: document.getElementById("phasor-bar"),
    phasorTicks: document.getElementById("phasor-ticks"),

    // ES-8 controls
    es8EnableBtn: document.getElementById("es8-enable-btn"),
    es8Status: document.getElementById("es8-status"),

    // Parameter controls
    portamentoTime: document.getElementById("portamento-time"),
    portamentoValue: document.getElementById("portamento-value"),
    reresolveBtn: document.getElementById("reresolve-btn"),
    bulkModeCheckbox: document.getElementById("bulk-mode-checkbox"),
    applyBulkBtn: document.getElementById("apply-bulk-btn"),

    peerList: document.getElementById("peer-list"),
    synthCount: document.getElementById("synth-count"),
    debugLog: document.getElementById("debug-log"),
    clearLogBtn: document.getElementById("clear-log-btn"), // Note: removed from layout

    // Period-Steps linkage controls
    linkStepsCheckbox: document.getElementById("link-steps"),

    // Scene memory
    clearBanksBtn: document.getElementById("clear-banks-btn"),

    // Preset buttons
    presetDefault: document.getElementById("preset-default"),
    presetFullStep: document.getElementById("preset-full-step"),
    presetFullDisc: document.getElementById("preset-full-disc"),
    presetFullCont: document.getElementById("preset-full-cont"),
    presetCalibration: document.getElementById("preset-calibration"),
  };

  console.log("reresolveBtn element:", ctrl.elements.reresolveBtn);
  console.log("portamentoTime element:", ctrl.elements.portamentoTime);
}

/**
 * Complete application initialization sequence
 * @param {Object} ctrl - The ControlClient instance
 */
export function initializeApplication(ctrl) {
  console.log("ControlClient constructor starting");

  // Step 1: Initialize all properties and state
  initializeProperties(ctrl);

  // Step 2: Wire up DOM elements
  wireUpDOMElements(ctrl);

  // Step 3: Setup event handlers
  setupEventHandlers(ctrl);

  // Step 4: Initialize timing and phasor
  ctrl.calculateCycleLength();
  ctrl.initializePhasor();
  ctrl.updatePlayPauseButton(); // Set initial button text

  // Step 5: Initialize UI to match default parameter state
  Object.keys(ctrl.liveState).forEach((paramName) => {
    ctrl._updateUIFromState(paramName);
  });

  ctrl.log("Control client initialized", "info");

  // Step 6: Auto-connect on page load
  ctrl.connectToNetwork();
}
