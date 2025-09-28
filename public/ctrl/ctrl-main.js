// src/common/message-protocol.js
var MessageTypes = {
  // WebRTC Signaling
  OFFER: "offer",
  ANSWER: "answer",
  ICE_CANDIDATE: "ice-candidate",
  // Network Coordination
  PING: "ping",
  PONG: "pong",
  // Parameter Control
  PROGRAM_UPDATE: "program-update",
  SUB_PARAM_UPDATE: "sub-param-update",
  UNIFIED_PARAM_UPDATE: "unified-param-update",
  // Timing Control
  PHASOR_SYNC: "phasor-sync",
  TRANSPORT: "transport",
  JUMP_TO_EOC: "jump-to-eoc",
  // System Control
  CALIBRATION_MODE: "calibration-mode",
  SYNTH_READY: "synth-ready",
  PROGRAM: "program",
  // Worklet Control
  SET_STEP_VALUES: "set-step-values",
  SET_COS_SEGMENTS: "set-cos-segments",
  RESTORE_SEQUENCE_STATE: "restore-sequence-state",
  RERESOLVE_AT_EOC: "reresolve-at-eoc",
  // Scene Memory
  SAVE_SCENE: "save-scene",
  LOAD_SCENE: "load-scene",
  CLEAR_BANKS: "clear-banks",
  CLEAR_SCENE: "clear-scene"
};
var MessageBuilder = class {
  static ping(timestamp = performance.now()) {
    return {
      type: MessageTypes.PING,
      timestamp,
      id: Math.random().toString(36).substring(2)
    };
  }
  static pong(pingId, pingTimestamp, timestamp = performance.now()) {
    return {
      type: MessageTypes.PONG,
      pingId,
      pingTimestamp,
      timestamp
    };
  }
  static createParameterUpdate(type, params) {
    return {
      type,
      frequency: params.frequency,
      zingMorph: params.zingMorph,
      zingAmount: params.zingAmount,
      vowelX: params.vowelX,
      vowelY: params.vowelY,
      symmetry: params.symmetry,
      amplitude: params.amplitude,
      whiteNoise: params.whiteNoise,
      synthesisActive: params.synthesisActive,
      portamentoTime: params.portamentoTime,
      timestamp: performance.now()
    };
  }
  static phasorSync(phasor, cpm, stepsPerCycle, cycleLength, isPlaying = true) {
    return {
      type: MessageTypes.PHASOR_SYNC,
      phasor,
      cpm,
      stepsPerCycle,
      cycleLength,
      isPlaying,
      timestamp: performance.now()
    };
  }
  static transport(action) {
    return {
      type: MessageTypes.TRANSPORT,
      action,
      timestamp: performance.now()
    };
  }
  static jumpToEOC() {
    return {
      type: MessageTypes.JUMP_TO_EOC,
      timestamp: performance.now()
    };
  }
  static calibrationMode(enabled, amplitude = 0.1) {
    return {
      type: MessageTypes.CALIBRATION_MODE,
      enabled,
      amplitude,
      timestamp: performance.now()
    };
  }
  static synthReady() {
    return {
      type: MessageTypes.SYNTH_READY,
      timestamp: performance.now()
    };
  }
  static program(config) {
    return {
      type: MessageTypes.PROGRAM,
      config,
      timestamp: performance.now()
    };
  }
  static setStepValues(params) {
    return {
      type: MessageTypes.SET_STEP_VALUES,
      params,
      timestamp: performance.now()
    };
  }
  static setCosSegments(params) {
    return {
      type: MessageTypes.SET_COS_SEGMENTS,
      params,
      timestamp: performance.now()
    };
  }
  static restoreSequenceState(sequences) {
    return {
      type: MessageTypes.RESTORE_SEQUENCE_STATE,
      sequences,
      timestamp: performance.now()
    };
  }
  static reresolveAtEOC() {
    return {
      type: MessageTypes.RERESOLVE_AT_EOC,
      timestamp: performance.now()
    };
  }
  static saveScene(memoryLocation) {
    return {
      type: MessageTypes.SAVE_SCENE,
      memoryLocation,
      timestamp: performance.now()
    };
  }
  static loadScene(memoryLocation, program) {
    return {
      type: MessageTypes.LOAD_SCENE,
      memoryLocation,
      program,
      timestamp: performance.now()
    };
  }
  static clearBanks() {
    return {
      type: MessageTypes.CLEAR_BANKS,
      timestamp: performance.now()
    };
  }
  static clearScene(memoryLocation) {
    return {
      type: MessageTypes.CLEAR_SCENE,
      memoryLocation,
      timestamp: performance.now()
    };
  }
  static subParamUpdate(paramPath, value, portamentoTime) {
    return {
      type: MessageTypes.SUB_PARAM_UPDATE,
      paramPath,
      value,
      portamentoTime,
      timestamp: performance.now()
    };
  }
  static unifiedParamUpdate(param, startValue, endValue, interpolation, isPlaying, portamentoTime, currentPhase) {
    return {
      type: MessageTypes.UNIFIED_PARAM_UPDATE,
      param,
      startValue,
      endValue,
      interpolation,
      isPlaying,
      portamentoTime,
      currentPhase,
      timestamp: performance.now()
    };
  }
};
function validateMessage(message) {
  if (!message || typeof message !== "object") {
    throw new Error("Message must be an object");
  }
  if (!message.type || typeof message.type !== "string") {
    throw new Error("Message must have a type field");
  }
  if (!Object.values(MessageTypes).includes(message.type)) {
    throw new Error(`Unknown message type: ${message.type}`);
  }
  switch (message.type) {
    case MessageTypes.PING:
      if (typeof message.timestamp !== "number") {
        throw new Error("Ping message must have numeric timestamp");
      }
      break;
    case MessageTypes.PONG:
      if (typeof message.pingId !== "string" || typeof message.pingTimestamp !== "number" || typeof message.timestamp !== "number") {
        throw new Error("Pong message missing required fields");
      }
      break;
    case MessageTypes.PROGRAM_UPDATE:
      for (const [key, value] of Object.entries(message)) {
        if ([
          "type",
          "timestamp",
          "synthesisActive",
          "isManualMode",
          "portamentoTime"
        ].includes(key)) {
          continue;
        }
        if (value && typeof value === "object") {
          if ("scope" in value) {
            throw new Error(`BREAKING: Parameter '${key}' contains forbidden 'scope' field. Use interpolation + generators instead.`);
          }
          if (!value.interpolation || ![
            "step",
            "cosine"
          ].includes(value.interpolation)) {
            throw new Error(`Parameter '${key}' must have interpolation: 'step' or 'cosine'`);
          }
          if (!value.startValueGenerator || typeof value.startValueGenerator !== "object") {
            throw new Error(`Parameter '${key}' must have startValueGenerator`);
          }
          if (value.interpolation === "cosine" && (!value.endValueGenerator || typeof value.endValueGenerator !== "object")) {
            throw new Error(`Parameter '${key}' with cosine interpolation must have endValueGenerator`);
          }
          if (value.startValueGenerator.type === "periodic" && value.baseValue === void 0) {
            throw new Error(`Parameter '${key}' with periodic generator must have baseValue`);
          }
        }
      }
      break;
    case MessageTypes.PHASOR_SYNC:
      if (typeof message.phasor !== "number" || typeof message.stepsPerCycle !== "number" || typeof message.cycleLength !== "number" || typeof message.isPlaying !== "boolean") {
        throw new Error("PHASOR_SYNC missing required fields: phasor, stepsPerCycle, cycleLength, isPlaying");
      }
      if (!message.isPlaying && message.scrubbing && typeof message.scrubMs !== "number") {
        throw new Error("PHASOR_SYNC scrubbing mode requires scrubMs field");
      }
      const allowedFields = [
        "type",
        "timestamp",
        "phasor",
        "cpm",
        "stepsPerCycle",
        "cycleLength",
        "isPlaying",
        "scrubbing",
        "scrubMs"
      ];
      for (const key of Object.keys(message)) {
        if (!allowedFields.includes(key)) {
          throw new Error(`PHASOR_SYNC contains unknown field: ${key}`);
        }
      }
      break;
    case MessageTypes.TRANSPORT:
      if (typeof message.action !== "string" || ![
        "play",
        "pause",
        "stop"
      ].includes(message.action)) {
        throw new Error("Transport message must have action: play, pause, or stop");
      }
      break;
    case MessageTypes.JUMP_TO_EOC:
      break;
    case MessageTypes.PROGRAM:
      if (!message.config || typeof message.config !== "object") {
        throw new Error("Program message must have config object");
      }
      break;
    case MessageTypes.SET_STEP_VALUES:
    case MessageTypes.SET_COS_SEGMENTS:
      if (!message.params || typeof message.params !== "object") {
        throw new Error(`${message.type} message must have params object`);
      }
      break;
    case MessageTypes.RESTORE_SEQUENCE_STATE:
      if (!message.sequences || typeof message.sequences !== "object") {
        throw new Error("Restore sequence state message must have sequences object");
      }
      break;
    case MessageTypes.RERESOLVE_AT_EOC:
      break;
    case MessageTypes.SAVE_SCENE:
      if (typeof message.memoryLocation !== "number" || message.memoryLocation < 0 || message.memoryLocation > 9) {
        throw new Error("Save scene message requires memoryLocation (0-9)");
      }
      break;
    case MessageTypes.LOAD_SCENE:
      if (typeof message.memoryLocation !== "number" || message.memoryLocation < 0 || message.memoryLocation > 9 || !message.program || typeof message.program !== "object") {
        throw new Error("Load scene message requires memoryLocation (0-9) and program object");
      }
      break;
    case MessageTypes.CLEAR_BANKS:
      break;
    case MessageTypes.CLEAR_SCENE:
      if (typeof message.memoryLocation !== "number" || message.memoryLocation < 0 || message.memoryLocation > 9) {
        throw new Error("Clear scene message requires memoryLocation (0-9)");
      }
      break;
    case MessageTypes.SUB_PARAM_UPDATE:
      if (typeof message.paramPath !== "string" || message.value === void 0 || typeof message.portamentoTime !== "number") {
        throw new Error("Sub param update message missing required fields: paramPath, value, portamentoTime");
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(message.paramPath)) {
        throw new Error(`Invalid paramPath format: ${message.paramPath}`);
      }
      break;
    case MessageTypes.UNIFIED_PARAM_UPDATE:
      if (typeof message.param !== "string" || typeof message.startValue !== "number" || message.endValue !== void 0 && typeof message.endValue !== "number" || typeof message.interpolation !== "string" || typeof message.isPlaying !== "boolean" || typeof message.portamentoTime !== "number" || typeof message.currentPhase !== "number") {
        throw new Error("Unified param update message missing required fields");
      }
      break;
  }
  return true;
}

// src/common/webrtc-star.js
var WebRTCStar = class extends EventTarget {
  constructor(peerId, peerType) {
    super();
    this.peerId = peerId;
    this.peerType = peerType;
    this.verbose = false;
    this.forceTakeover = false;
    this.peers = /* @__PURE__ */ new Map();
    this.signalingSocket = null;
    this.isConnectedToSignaling = false;
    this.pingInterval = null;
    this.pingTimeouts = /* @__PURE__ */ new Map();
    this.ctrlRetryCount = 0;
    this.maxCtrlRetries = 3;
    this.ctrlRetryTimeout = null;
    this.iceServers = [
      {
        urls: "stun:stun.l.google.com:19302"
      },
      {
        urls: "stun:stun1.l.google.com:19302"
      }
    ];
    console.log(`\u{1F517} WebRTC Star initialized: ${this.peerId} (${this.peerType})`);
    this.fetchIceServers();
  }
  async fetchIceServers() {
    try {
      if (this.verbose) {
        console.log("\u{1F50D} Fetching ICE servers from /ice-servers...");
      }
      const response = await fetch("/ice-servers");
      if (response.ok) {
        const data = await response.json();
        if (data.ice_servers && data.ice_servers.length > 0) {
          this.iceServers = data.ice_servers;
          if (this.verbose) {
            console.log(`\u2705 Successfully fetched ${this.iceServers.length} ICE servers`);
          }
        } else {
          if (this.verbose) {
            console.log("\u26A0\uFE0F No ICE servers returned, using fallback STUN");
          }
        }
      } else {
        throw new Error(`Failed to fetch ICE servers: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      if (this.verbose) {
        console.log(`\u26A0\uFE0F ICE server fetch failed: ${error.message}`);
        console.log("Using fallback STUN servers");
      }
    }
  }
  /**
   * Determine if we should connect to a peer based on star topology
   * Star topology: ctrl connects to synths, synths connect to ctrl
   */
  shouldConnectToPeer(peerType) {
    if (this.peerType === "ctrl") {
      return peerType === "synth";
    } else if (this.peerType === "synth") {
      return peerType === "ctrl";
    }
    return false;
  }
  /**
   * Connect to signaling server and register
   */
  async connect(signalingUrl = "ws://localhost:8000/ws", forceTakeover = false) {
    this.forceTakeover = forceTakeover;
    return new Promise((resolve, reject) => {
      this.signalingSocket = new WebSocket(signalingUrl);
      this.signalingSocket.addEventListener("open", () => {
        if (this.verbose) console.log("\u{1F4E1} Connected to signaling server");
        const registerMessage = {
          type: "register",
          client_id: this.peerId
        };
        if (this.peerType === "ctrl" && forceTakeover) {
          registerMessage.force_takeover = true;
        }
        this.sendSignalingMessage(registerMessage);
        if (this.peerType === "synth") {
          setTimeout(() => {
            this.sendSignalingMessage({
              type: "request-ctrls"
            });
          }, 100);
        }
      });
      this.signalingSocket.addEventListener("message", async (event) => {
        const message = JSON.parse(event.data);
        await this.handleSignalingMessage(message);
        if (message.type === "ctrls-list" || message.type === "ctrl-joined") {
          this.isConnectedToSignaling = true;
          setTimeout(() => this.startPingTimer(), 3e3);
          resolve(true);
        } else if (this.peerType === "ctrl") {
          this.isConnectedToSignaling = true;
          setTimeout(() => this.startPingTimer(), 3e3);
          resolve(true);
        }
      });
      this.signalingSocket.addEventListener("error", (error) => {
        console.error("\u274C Signaling connection error:", error);
        reject(error);
      });
      this.signalingSocket.addEventListener("close", () => {
        console.log("\u{1F50C} Signaling connection closed");
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
            console.log("\u{1F4CB} Received ctrls list:", message.ctrls);
          }
          if (this.ctrlRetryTimeout) {
            clearTimeout(this.ctrlRetryTimeout);
            this.ctrlRetryTimeout = null;
          }
          if (message.ctrls.length === 0) {
            if (this.ctrlRetryCount < this.maxCtrlRetries) {
              this.ctrlRetryCount++;
              const retryDelay = 1e3 + Math.random() * 500;
              if (this.verbose) {
                console.log(`\u{1F504} No controllers found, retrying in ${Math.round(retryDelay)}ms (attempt ${this.ctrlRetryCount}/${this.maxCtrlRetries})`);
              }
              this.ctrlRetryTimeout = setTimeout(() => {
                if (this.signalingSocket && this.signalingSocket.readyState === WebSocket.OPEN) {
                  this.signalingSocket.send(JSON.stringify({
                    type: "request-ctrls"
                  }));
                }
              }, retryDelay);
            } else {
              if (this.verbose) {
                console.log(`\u26A0\uFE0F No controllers found after ${this.maxCtrlRetries} attempts, giving up`);
              }
            }
          } else {
            this.ctrlRetryCount = 0;
            for (const ctrlId of message.ctrls) {
              if (!this.peers.has(ctrlId)) {
                if (this.verbose) console.log(`\u{1F39B}\uFE0F Connecting to ctrl: ${ctrlId}`);
                await this.createPeerConnection(ctrlId, true);
              }
            }
          }
        }
        break;
      case "ctrl-joined":
        if (this.peerType === "synth") {
          this.ctrlRetryCount = 0;
          if (this.ctrlRetryTimeout) {
            clearTimeout(this.ctrlRetryTimeout);
            this.ctrlRetryTimeout = null;
          }
          if (this.verbose) {
            console.log(`\u{1F39B}\uFE0F New ctrl joined: ${message.ctrl_id}`);
          }
          if (!this.peers.has(message.ctrl_id)) {
            await this.createPeerConnection(message.ctrl_id, true);
          }
        }
        break;
      case "ctrl-left":
        if (message.ctrl_id !== this.peerId) {
          if (this.verbose) console.log(`\u{1F44B} Ctrl left: ${message.ctrl_id}`);
          this.removePeer(message.ctrl_id);
        }
        break;
      case "synth-joined":
        if (this.peerType === "ctrl") {
          if (this.verbose) {
            console.log(`\u{1F3A4} New synth joined: ${message.synth_id}`);
          }
          if (!this.peers.has(message.synth_id)) {
            await this.createPeerConnection(message.synth_id, true);
          }
        }
        break;
      case "synth-left":
        if (message.synth_id !== this.peerId) {
          if (this.verbose) console.log(`\u{1F44B} Synth left: ${message.synth_id}`);
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
        console.error("\u274C Signaling error:", message.message);
        break;
      case "kicked":
        console.error(`\u274C Kicked from network: ${message.reason}`);
        this.dispatchEvent(new CustomEvent("kicked", {
          detail: {
            reason: message.reason
          }
        }));
        this.cleanup();
        break;
      case "join-rejected":
        console.error(`\u274C Join rejected: ${message.reason}`);
        this.dispatchEvent(new CustomEvent("join-rejected", {
          detail: {
            reason: message.reason
          }
        }));
        this.signalingSocket.close();
        break;
    }
  }
  /**
   * Create RTCPeerConnection for a peer
   */
  async createPeerConnection(peerId, shouldInitiate) {
    if (this.peers.has(peerId)) {
      console.warn(`\u26A0\uFE0F Peer connection already exists for ${peerId}`);
      return;
    }
    let targetPeerType;
    if (this.peerType === "ctrl") {
      targetPeerType = "synth";
    } else {
      targetPeerType = "ctrl";
    }
    const peerConnection = new RTCPeerConnection({
      iceServers: this.iceServers
    });
    this.peers.set(peerId, {
      connection: peerConnection,
      peerType: targetPeerType,
      syncChannel: null,
      controlChannel: null,
      connectedEventSent: false
    });
    let syncChannel, controlChannel;
    if (shouldInitiate) {
      if (this.verbose) {
        console.log(`\u{1F4E1} Creating data channels for ${peerId} (initiator)`);
      }
      syncChannel = peerConnection.createDataChannel("sync", {
        ordered: false,
        maxRetransmits: 0
      });
      controlChannel = peerConnection.createDataChannel("control", {
        ordered: true
      });
      this.setupDataChannel(syncChannel, peerId);
      this.setupDataChannel(controlChannel, peerId);
    }
    peerConnection.ondatachannel = (event) => {
      const channel = event.channel;
      if (this.verbose) {
        console.log(`\u{1F4E1} Received data channel '${channel.label}' from ${peerId}`);
      }
      if (channel.label === "sync") {
        syncChannel = channel;
      } else if (channel.label === "control") {
        controlChannel = channel;
      }
      this.setupDataChannel(channel, peerId);
    };
    peerConnection.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        this.sendSignalingMessage({
          type: "ice-candidate",
          targetPeerId: peerId,
          candidate: event.candidate
        });
      }
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      if (this.verbose) {
        console.log(`\u{1F517} Connection to ${peerId}: ${peerConnection.connectionState}`);
      }
      if (peerConnection.connectionState === "connected") {
        setTimeout(() => {
          this.checkPeerReadiness(peerId);
        }, 100);
      } else if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "disconnected") {
        this.removePeer(peerId);
      }
    });
    peerConnection.addEventListener("iceconnectionstatechange", () => {
      if (this.verbose) {
        console.log(`\u{1F9CA} ICE connection to ${peerId}: ${peerConnection.iceConnectionState}`);
      }
      if (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed") {
        setTimeout(() => {
          this.checkPeerReadiness(peerId);
        }, 100);
      }
    });
    if (shouldInitiate) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      this.sendSignalingMessage({
        type: "offer",
        targetPeerId: peerId,
        offer
      });
    }
  }
  /**
   * Set up data channel event handlers
   */
  setupDataChannel(channel, peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (channel.label === "sync") {
      peer.syncChannel = channel;
    } else if (channel.label === "control") {
      peer.controlChannel = channel;
    }
    channel.addEventListener("open", () => {
      console.log(`\u{1F4E1} ${channel.label} channel open to ${peerId}`);
      this.checkPeerReadiness(peerId);
    });
    console.log(`\u{1F4E1} Channel '${channel.label}' for ${peerId} initial state: ${channel.readyState}`);
    channel.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        validateMessage(message);
        this.handleDataChannelMessage(peerId, channel.label, message);
      } catch (error) {
        console.error("\u274C Invalid data channel message:", error);
      }
    });
    channel.addEventListener("error", (error) => {
      console.error(`\u274C Data channel error (${channel.label} to ${peerId}):`, error);
    });
    channel.addEventListener("close", () => {
      console.log(`\u{1F4E1} ${channel.label} channel closed to ${peerId}`);
    });
  }
  /**
   * Handle WebRTC offer
   */
  async handleOffer(message) {
    const { fromPeerId, offer } = message;
    if (!this.peers.has(fromPeerId)) {
      if (this.verbose) {
        console.log(`\u{1F91D} Received offer from new peer ${fromPeerId}, creating connection`);
      }
      await this.createPeerConnection(fromPeerId, false);
    }
    const peer = this.peers.get(fromPeerId);
    if (!peer) {
      console.error(`\u274C Could not get peer connection for ${fromPeerId} after creation attempt`);
      return;
    }
    try {
      const pc = peer.connection;
      if (pc.signalingState !== "stable") {
        if (this.verbose) {
          console.warn(`\u26A0\uFE0F Received offer while signaling state is ${pc.signalingState}, rolling back`);
        }
        await Promise.all([
          pc.setLocalDescription({
            type: "rollback"
          }),
          pc.setRemoteDescription(offer)
        ]);
      } else {
        await pc.setRemoteDescription(offer);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sendSignalingMessage({
        type: "answer",
        targetPeerId: fromPeerId,
        answer: pc.localDescription
      });
      if (this.verbose) console.log(`\u2705 Sent answer to ${fromPeerId}`);
    } catch (error) {
      console.error(`\u274C Error handling offer from ${fromPeerId}:`, error);
    }
  }
  /**
   * Handle WebRTC answer
   */
  async handleAnswer(message) {
    const { fromPeerId, answer } = message;
    const peer = this.peers.get(fromPeerId);
    if (!peer) {
      console.error(`\u274C Received answer from unknown peer: ${fromPeerId}`);
      return;
    }
    await peer.connection.setRemoteDescription(answer);
  }
  /**
   * Handle ICE candidate
   */
  async handleIceCandidate(message) {
    const { fromPeerId, candidate } = message;
    if (!this.peers.has(fromPeerId)) {
      if (this.verbose) {
        console.log(`\u{1F91D} Received ICE candidate from new peer ${fromPeerId}, creating placeholder connection`);
      }
      await this.createPeerConnection(fromPeerId, false);
    }
    const peer = this.peers.get(fromPeerId);
    if (!peer) {
      console.error(`\u274C Could not get peer connection for ICE candidate from ${fromPeerId}`);
      return;
    }
    try {
      if (candidate) {
        await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (error) {
      if (!error.message.includes("Cannot add ICE candidate before a remote description")) {
        console.error(`\u274C Error adding ICE candidate for ${fromPeerId}:`, error);
      }
    }
  }
  /**
   * Handle data channel messages
   */
  handleDataChannelMessage(peerId, channelType, message) {
    try {
      validateMessage(message);
    } catch (error) {
      console.error(`\u274C Invalid message from ${peerId}:`, error.message);
      return;
    }
    if (message.type === MessageTypes.PING) {
      const pongMessage = MessageBuilder.pong(message.id, message.timestamp);
      this.sendToPeer(peerId, pongMessage, channelType);
      return;
    }
    if (message.type === MessageTypes.PONG) {
      this.handlePongMessage(peerId, message);
      return;
    }
    this.dispatchEvent(new CustomEvent("data-message", {
      detail: {
        peerId,
        channelType,
        message
      }
    }));
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
      const rtt = performance.now() - pongMessage.pingTimestamp;
      if (this.verbose) {
        console.log(`\u{1F3D3} Pong from ${peerId}: ${Math.round(rtt)}ms`);
      }
    }
  }
  /**
   * Send message via signaling server
   */
  sendSignalingMessage(message) {
    if (this.signalingSocket && this.signalingSocket.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify(message));
    }
  }
  /**
   * Send message to specific peer via data channel
   */
  sendToPeer(peerId, message, channelType = "sync") {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.warn(`\u26A0\uFE0F Cannot send to unknown peer: ${peerId}`);
      return false;
    }
    const channel = channelType === "sync" ? peer.syncChannel : peer.controlChannel;
    if (!channel || channel.readyState !== "open") {
      if (!peer.channelWarningCount) peer.channelWarningCount = {};
      peer.channelWarningCount[channelType] = (peer.channelWarningCount[channelType] || 0) + 1;
      if (peer.channelWarningCount[channelType] <= 3) {
        console.warn(`\u26A0\uFE0F Channel ${channelType} to ${peerId} not ready (${channel?.readyState || "none"})`);
      }
      return false;
    }
    try {
      channel.send(JSON.stringify(message));
      if (peer.channelWarningCount) {
        peer.channelWarningCount[channelType] = 0;
      }
      return true;
    } catch (error) {
      console.error(`\u274C Failed to send message to ${peerId}:`, error);
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
    }, 1e3);
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
      return;
    }
    const pingMessage = MessageBuilder.ping();
    const timeout = setTimeout(() => {
      console.log(`\u26A0\uFE0F Ping timeout for ${peerId}`);
      this.pingTimeouts.delete(pingMessage.id);
    }, 5e3);
    this.pingTimeouts.set(pingMessage.id, timeout);
    this.sendToPeer(peerId, pingMessage, "sync");
  }
  /**
   * Check if peer is ready (connection established and both channels open)
   */
  checkPeerReadiness(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const peerConnection = peer.connection;
    const isConnectionReady = peerConnection && (peerConnection.connectionState === "connected" || peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed");
    const isSyncChannelReady = peer.syncChannel && peer.syncChannel.readyState === "open";
    const isControlChannelReady = peer.controlChannel && peer.controlChannel.readyState === "open";
    if (this.verbose) {
      console.log(`\u{1F50D} Peer ${peerId} readiness check:`, {
        connectionState: peerConnection?.connectionState,
        iceConnectionState: peerConnection?.iceConnectionState,
        hasSyncChannel: !!peer.syncChannel,
        syncChannelState: peer.syncChannel?.readyState,
        hasControlChannel: !!peer.controlChannel,
        controlChannelState: peer.controlChannel?.readyState,
        isConnectionReady,
        isSyncChannelReady,
        isControlChannelReady
      });
    }
    if (isConnectionReady && isSyncChannelReady && isControlChannelReady) {
      if (this.verbose) {
        console.log(`\u2705 Connection and both channels ready for ${peerId}`);
      }
      if (!peer.connectedEventSent) {
        peer.connectedEventSent = true;
        this.dispatchEvent(new CustomEvent("peer-connected", {
          detail: {
            peerId,
            syncChannel: peer.syncChannel,
            controlChannel: peer.controlChannel
          }
        }));
      }
    } else {
      if (this.verbose) {
        console.log(`\u23F3 Peer ${peerId} - Connection: ${isConnectionReady ? "ready" : "waiting"}, Sync channel: ${isSyncChannelReady ? "ready" : "waiting"}, Control channel: ${isControlChannelReady ? "ready" : "waiting"}`);
      }
    }
  }
  /**
   * Remove peer from mesh
   */
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (peer.connection.connectionState !== "closed") {
      peer.connection.close();
    }
    this.peers.delete(peerId);
    if (this.verbose) console.log(`\u{1F5D1}\uFE0F Removed peer ${peerId}`);
    this.dispatchEvent(new CustomEvent("peer-removed", {
      detail: {
        peerId
      }
    }));
  }
  /**
   * Get network statistics
   */
  getNetworkStats() {
    const peerStats = {};
    for (const [peerId, peer] of this.peers) {
      peerStats[peerId] = {
        connectionState: peer.connection.connectionState,
        peerType: peer.peerType
      };
    }
    return {
      peerId: this.peerId,
      peerType: this.peerType,
      connectedPeers: this.peers.size,
      peerStats
    };
  }
  /**
   * Cleanup resources
   */
  cleanup() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ctrlRetryTimeout) {
      clearTimeout(this.ctrlRetryTimeout);
      this.ctrlRetryTimeout = null;
    }
    for (const timeout of this.pingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.pingTimeouts.clear();
    for (const [peerId] of this.peers) {
      this.removePeer(peerId);
    }
    if (this.signalingSocket) {
      this.signalingSocket.close();
      this.signalingSocket = null;
    }
    this.isConnectedToSignaling = false;
    if (this.verbose) console.log("\u{1F9F9} WebRTC mesh cleaned up");
  }
};
function generatePeerId(peerType) {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${peerType}-${timestamp}-${random}`;
}

// public/ctrl/ctrl-main.ts
var ControlClient = class {
  // Typed state management
  musicalState;
  pendingMusicalState;
  star;
  forceTakeover;
  peerId;
  phasor;
  periodSec;
  stepsPerCycle;
  cycleLength;
  lastPhasorTime;
  phasorUpdateId;
  lastBroadcastTime;
  phasorBroadcastRate;
  audioContext;
  es8Enabled;
  es8Node;
  hasPendingChanges;
  pendingParameterChanges;
  elements;
  synthesisActive;
  _createDefaultState() {
    const defaultFrequencyState = () => ({
      interpolation: "step",
      baseValue: 220,
      startValueGenerator: {
        type: "periodic",
        numerators: "1",
        denominators: "1",
        sequenceBehavior: "static"
      }
    });
    const defaultNormalizedState = () => ({
      interpolation: "cosine",
      startValueGenerator: {
        type: "normalised",
        range: {
          min: 0,
          max: 1
        },
        sequenceBehavior: "static"
      },
      endValueGenerator: {
        type: "normalised",
        range: {
          min: 0,
          max: 1
        },
        sequenceBehavior: "static"
      }
    });
    const defaultConstantState = (value) => ({
      interpolation: "step",
      baseValue: value,
      startValueGenerator: {
        type: "normalised",
        range: value,
        sequenceBehavior: "static"
      }
    });
    return {
      frequency: defaultFrequencyState(),
      vowelX: defaultNormalizedState(),
      vowelY: defaultNormalizedState(),
      zingAmount: defaultNormalizedState(),
      zingMorph: defaultNormalizedState(),
      symmetry: defaultNormalizedState(),
      amplitude: defaultConstantState(0.8),
      whiteNoise: defaultConstantState(0)
    };
  }
  _updatePendingState(action) {
    console.log("Action dispatched:", action);
    const newState = JSON.parse(JSON.stringify(this.pendingMusicalState));
    switch (action.type) {
      case "SET_BASE_VALUE": {
        const param = newState[action.param];
        param.baseValue = action.value;
        if (param.startValueGenerator?.type === "periodic") {
          param.startValueGenerator.baseValue = action.value;
        }
        if (param.endValueGenerator?.type === "periodic") {
          param.endValueGenerator.baseValue = action.value;
        }
        break;
      }
      case "SET_INTERPOLATION": {
        const param = newState[action.param];
        if (action.interpolation === "step") {
          newState[action.param] = {
            interpolation: "step",
            baseValue: param.baseValue,
            startValueGenerator: param.startValueGenerator
          };
        } else {
          newState[action.param] = {
            interpolation: action.interpolation,
            baseValue: param.baseValue,
            startValueGenerator: param.startValueGenerator,
            endValueGenerator: param.endValueGenerator || {
              ...param.startValueGenerator
            }
          };
        }
        break;
      }
      case "SET_GENERATOR_CONFIG": {
        const param = newState[action.param];
        if (action.position === "start") {
          param.startValueGenerator = {
            ...param.startValueGenerator,
            ...action.config
          };
          if (param.startValueGenerator.type === "periodic") {
            param.startValueGenerator.baseValue = param.baseValue;
          }
        } else if (action.position === "end" && param.interpolation !== "step" && param.endValueGenerator) {
          param.endValueGenerator = {
            ...param.endValueGenerator,
            ...action.config
          };
          if (param.endValueGenerator.type === "periodic") {
            param.endValueGenerator.baseValue = param.baseValue;
          }
        }
        break;
      }
    }
    this.pendingMusicalState = newState;
    if (action.param) {
      this._updateUIFromState(action.param);
    }
    this.markPendingChanges();
  }
  /**
   * Apply HRG changes when paused
   * Updates active state directly and broadcasts only the changed parameter with portamento
   */
  _applyHRGChangeWithPortamento(action) {
    this._updateActiveState(action);
    const portamentoTime = this.elements.portamentoTime ? parseInt(this.elements.portamentoTime.value) : 100;
    this.broadcastSingleParameterUpdate(action.param, portamentoTime);
  }
  /**
   * Update the active musical state directly (bypassing pending state)
   * Used when transport is paused for immediate parameter updates
   */
  _updateActiveState(action) {
    const newState = JSON.parse(JSON.stringify(this.musicalState));
    switch (action.type) {
      case "SET_BASE_VALUE": {
        const param = newState[action.param];
        param.baseValue = action.value;
        if (param.startValueGenerator?.type === "periodic") {
          param.startValueGenerator.baseValue = action.value;
        }
        if (param.endValueGenerator?.type === "periodic") {
          param.endValueGenerator.baseValue = action.value;
        }
        break;
      }
      case "SET_INTERPOLATION": {
        const param = newState[action.param];
        if (action.interpolation === "step") {
          newState[action.param] = {
            interpolation: "step",
            baseValue: param.baseValue,
            startValueGenerator: param.startValueGenerator
          };
        } else {
          newState[action.param] = {
            interpolation: action.interpolation,
            baseValue: param.baseValue,
            startValueGenerator: param.startValueGenerator,
            endValueGenerator: param.endValueGenerator || {
              ...param.startValueGenerator
            }
          };
        }
        break;
      }
      case "SET_GENERATOR_CONFIG": {
        const param = newState[action.param];
        if (action.position === "start") {
          param.startValueGenerator = {
            ...param.startValueGenerator,
            ...action.config
          };
          if (param.startValueGenerator.type === "periodic") {
            param.startValueGenerator.baseValue = param.baseValue;
          }
        } else if (action.position === "end" && param.interpolation !== "step" && param.endValueGenerator) {
          param.endValueGenerator = {
            ...param.endValueGenerator,
            ...action.config
          };
          if (param.endValueGenerator.type === "periodic") {
            param.endValueGenerator.baseValue = param.baseValue;
          }
        }
        break;
      }
    }
    this.musicalState = newState;
    this.pendingMusicalState = JSON.parse(JSON.stringify(newState));
    if (action.param) {
      this._updateUIFromState(action.param);
    }
  }
  constructor() {
    console.log("ControlClient constructor starting");
    const urlParams = new URLSearchParams(globalThis.location.search);
    this.forceTakeover = urlParams.get("force") === "true";
    this.peerId = generatePeerId("ctrl");
    this.star = null;
    this.phasor = 0;
    this.isPlaying = false;
    this.periodSec = 2;
    this.stepsPerCycle = 16;
    this.cycleLength = 2;
    this.lastPhasorTime = 0;
    this.phasorUpdateId = null;
    this.lastBroadcastTime = 0;
    this.phasorBroadcastRate = 30;
    this.pendingPeriodSec = null;
    this.pendingStepsPerCycle = null;
    this.audioContext = null;
    this.es8Enabled = false;
    this.es8Node = null;
    this.hasPendingChanges = false;
    this.pendingParameterChanges = /* @__PURE__ */ new Set();
    this.synthesisActive = false;
    this.musicalState = this._createDefaultState();
    this.pendingMusicalState = this._createDefaultState();
    this.elements = {
      connectionStatus: document.getElementById("connection-status"),
      connectionValue: document.getElementById("connection-status"),
      synthesisStatus: document.getElementById("synthesis-status"),
      // Removed peers status - now using synth count in connected synths panel
      takeoverSection: document.getElementById("takeover-section"),
      takeoverBtn: document.getElementById("force-takeover-btn"),
      manualModeBtn: document.getElementById("manual-mode-btn"),
      // Musical controls
      // Simplified musical controls
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
      // Parameter controls
      portamentoTime: document.getElementById("portamento-time"),
      portamentoValue: document.getElementById("portamento-value"),
      reresolveBtn: document.getElementById("reresolve-btn"),
      peerList: document.getElementById("peer-list"),
      synthCount: document.getElementById("synth-count"),
      debugLog: document.getElementById("debug-log"),
      clearLogBtn: document.getElementById("clear-log-btn"),
      // Scene memory
      clearBanksBtn: document.getElementById("clear-banks-btn")
    };
    console.log("reresolveBtn element:", this.elements.reresolveBtn);
    console.log("portamentoTime element:", this.elements.portamentoTime);
    this.setupEventHandlers();
    this.calculateCycleLength();
    this.initializePhasor();
    this.updatePlayPauseButton();
    Object.keys(this.musicalState).forEach((paramName) => {
      this._updateUIFromState(paramName);
    });
    this.log("Control client initialized", "info");
    this.connectToNetwork();
  }
  setupEventHandlers() {
    console.log("Setting up event handlers...");
    if (this.elements.manualModeBtn) {
      this.elements.manualModeBtn.addEventListener("click", () => this.toggleSynthesis());
    }
    this.elements.takeoverBtn.addEventListener("click", () => {
      if (confirm("Take control from the current active controller?")) {
        const currentUrl = globalThis.location.href.split("?")[0];
        globalThis.location.href = currentUrl + "?force=true";
      }
    });
    if (this.elements.clearLogBtn) {
      this.elements.clearLogBtn.addEventListener("click", () => this.clearLog());
    }
    if (this.elements.clearBanksBtn) {
      this.elements.clearBanksBtn.addEventListener("click", () => this.clearSceneBanks());
    }
    if (this.elements.portamentoTime) {
      this.elements.portamentoTime.addEventListener("input", (e) => {
        const value = e.target.value;
        this.elements.portamentoValue.textContent = `${value}ms`;
      });
    }
    if (this.elements.reresolveBtn) {
      console.log("\u2705 Re-resolve button found, adding click handler");
      this.elements.reresolveBtn.addEventListener("click", () => {
        console.log("\u{1F500} Re-resolve button clicked!");
        this.reresolveAtEOC();
      });
    } else {
      console.error("\u274C Re-resolve button not found in DOM");
    }
    this.setupMusicalControls();
  }
  reresolveAtEOC() {
    console.log("\u{1F500} reresolveAtEOC() called");
    if (!this.star) {
      console.error("\u274C No WebRTC star available for re-resolve");
      return;
    }
    console.log("\u{1F4E1} Creating re-resolve message...");
    const message = MessageBuilder.reresolveAtEOC();
    console.log("\u{1F4E4} Broadcasting re-resolve message:", message);
    const sent = this.star.broadcastToType("synth", message, "control");
    console.log(`\u2705 Re-resolve message sent to ${sent} synths`);
    this.log(`\u{1F500} Re-resolve requested for ${sent} synths at next EOC`, "info");
  }
  setupMusicalControls() {
    this.setupEnvelopeControls();
    if (this.elements.periodInput) {
      this.elements.periodInput.addEventListener("input", (e) => {
        const newPeriod = parseFloat(e.target.value);
        this.pendingPeriodSec = newPeriod;
        this.log(`Period staged for EOC: ${newPeriod}s (pending)`, "info");
      });
    }
    if (this.elements.stepsInput) {
      this.elements.stepsInput.addEventListener("input", (e) => {
        const newSteps = parseInt(e.target.value);
        this.pendingStepsPerCycle = newSteps;
        this.log(`Steps staged for EOC: ${newSteps} (pending)`, "info");
      });
    }
    if (this.elements.playBtn) {
      this.elements.playBtn.addEventListener("click", () => {
        if (this.isPlaying) {
          this.handleTransport("pause");
        } else {
          this.handleTransport("play");
        }
      });
    }
    if (this.elements.stopBtn) {
      this.elements.stopBtn.addEventListener("click", () => {
        this.handleTransport("stop");
      });
    }
    if (this.elements.resetBtn) {
      this.elements.resetBtn.addEventListener("click", () => {
        this.handleReset();
      });
    }
    if (this.elements.stepsPerCycleSlider) {
      this.elements.stepsPerCycleSlider.addEventListener("input", (e) => {
        this.stepsPerCycle = parseFloat(e.target.value);
        this.elements.stepsPerCycleValue.textContent = `${this.stepsPerCycle} steps`;
        this.log(`Steps per cycle changed to ${this.stepsPerCycle}`, "info");
      });
    }
    if (this.elements.es8EnableBtn) {
      this.elements.es8EnableBtn.addEventListener("click", () => this.toggleES8());
    }
    this.setupSceneMemoryUI();
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        this.log("\u2328\uFE0F Cmd+Enter pressed", "info");
        this.log("\u2328\uFE0F Cmd+Enter no longer triggers Apply Changes (unified system)", "info");
      }
      if (/^[0-9]$/.test(e.key) && e.target?.tagName !== "INPUT") {
        e.preventDefault();
        const location = parseInt(e.key);
        if (e.shiftKey) {
          this.saveScene(location);
        } else {
          this.loadScene(location);
        }
      }
    });
  }
  setupEnvelopeControls() {
    this.setupFrequencyControls();
    this.setupCompactParameterControls("vowelX");
    this.setupCompactParameterControls("vowelY");
    this.setupCompactParameterControls("zingAmount");
    this.setupCompactParameterControls("zingMorph");
    this.setupCompactParameterControls("symmetry");
    this.setupCompactParameterControls("amplitude");
    this.setupCompactParameterControls("whiteNoise");
    Object.keys(this.musicalState).forEach((paramName) => {
      this.setParameterState(paramName, this.musicalState[paramName]);
    });
  }
  setupCompactParameterControls(paramName) {
    const interpSelect = document.getElementById(`${paramName}-interpolation`);
    const textInput = document.getElementById(`${paramName}-value`);
    const startHrg = document.getElementById(`${paramName}-start-hrg`);
    const endHrg = document.getElementById(`${paramName}-end-hrg`);
    const hrgArrow = document.getElementById(`${paramName}-hrg-arrow`);
    const endValueInput = document.getElementById(`${paramName}-end-value`);
    if (!textInput) return;
    textInput.addEventListener("blur", () => {
      this._handleValueInput(paramName, textInput.value, "start");
      this.handleUnifiedParameterUpdate(paramName, textInput.value);
    });
    if (interpSelect) {
      interpSelect.addEventListener("change", () => {
        const interpolation = interpSelect.value;
        this._updatePendingState({
          type: "SET_INTERPOLATION",
          param: paramName,
          interpolation
        });
        this.markPendingChanges();
      });
    }
    if (endValueInput) {
      endValueInput.addEventListener("change", () => {
        this._handleValueInput(paramName, endValueInput.value, "end");
        this.markPendingChanges();
      });
      endValueInput.addEventListener("input", () => {
        const isValid = /^-?\d*\.?\d*(\s*-\s*-?\d*\.?\d*)?$/.test(endValueInput.value);
        endValueInput.classList.toggle("invalid-input", !isValid && endValueInput.value !== "");
      });
    }
    if (textInput) {
      textInput.addEventListener("change", () => {
        this._handleValueInput(paramName, textInput.value, "start");
        this.markPendingChanges();
      });
      textInput.addEventListener("blur", () => {
        if (false) {
          if (textInput.value.trim() === "") {
            let defaultValue;
            switch (paramName) {
              case "vowelX":
              case "vowelY":
              case "symmetry":
              case "zingMorph":
              case "zingAmount":
                defaultValue = 0.5;
                break;
              case "frequency":
                defaultValue = 220;
                break;
              case "amplitude":
                defaultValue = 0.8;
                break;
              case "whiteNoise":
              default:
                defaultValue = 0;
                break;
            }
            console.log(`Input for '${paramName}' was empty on blur, defaulting to ${defaultValue}`);
            this._updatePendingState({
              type: "SET_BASE_VALUE",
              param: paramName,
              value: defaultValue
            });
          }
        }
      });
      textInput.addEventListener("input", () => {
        const isValid = /^-?\d*\.?\d*(\s*-\s*-?\d*\.?\d*)?$/.test(textInput.value);
        textInput.classList.toggle("invalid-input", !isValid && textInput.value !== "");
      });
    }
    if (paramName === "frequency") {
      const startNumeratorsInput = document.getElementById("frequency-start-numerators");
      const startDenominatorsInput = document.getElementById("frequency-start-denominators");
      const startNumBehaviorSelect = document.getElementById("frequency-start-numerators-behavior");
      const startDenBehaviorSelect = document.getElementById("frequency-start-denominators-behavior");
      if (startNumeratorsInput) {
        startNumeratorsInput.addEventListener("input", () => {
          const { ok } = this._validateSINString(startNumeratorsInput.value);
          startNumeratorsInput.classList.toggle("invalid-input", !ok);
          if (this.isPlaying) {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "start",
              config: {
                numerators: startNumeratorsInput.value
              }
            });
            this.markPendingChanges();
          }
        });
        startNumeratorsInput.addEventListener("blur", () => {
          if (!this.isPlaying) {
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "start",
              config: {
                numerators: startNumeratorsInput.value
              }
            });
          } else {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "start",
              config: {
                numerators: startNumeratorsInput.value
              }
            });
            this.markPendingChanges();
          }
        });
      }
      if (startDenominatorsInput) {
        startDenominatorsInput.addEventListener("input", () => {
          const { ok } = this._validateSINString(startDenominatorsInput.value);
          startDenominatorsInput.classList.toggle("invalid-input", !ok);
          if (this.isPlaying) {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "start",
              config: {
                denominators: startDenominatorsInput.value
              }
            });
            this.markPendingChanges();
          }
        });
        startDenominatorsInput.addEventListener("blur", () => {
          if (!this.isPlaying) {
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "start",
              config: {
                denominators: startDenominatorsInput.value
              }
            });
          } else {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "start",
              config: {
                denominators: startDenominatorsInput.value
              }
            });
            this.markPendingChanges();
          }
        });
      }
      if (startNumBehaviorSelect) {
        startNumBehaviorSelect.addEventListener("change", () => {
          if (!this.isPlaying) {
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "start",
              config: {
                numeratorBehavior: startNumBehaviorSelect.value
              }
            });
          } else {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "start",
              config: {
                numeratorBehavior: startNumBehaviorSelect.value
              }
            });
            this.markPendingChanges();
          }
        });
      }
      if (startDenBehaviorSelect) {
        startDenBehaviorSelect.addEventListener("change", () => {
          if (!this.isPlaying) {
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "start",
              config: {
                denominatorBehavior: startDenBehaviorSelect.value
              }
            });
          } else {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "start",
              config: {
                denominatorBehavior: startDenBehaviorSelect.value
              }
            });
            this.markPendingChanges();
          }
        });
      }
      const endNumeratorsInput = document.getElementById("frequency-end-numerators");
      const endDenominatorsInput = document.getElementById("frequency-end-denominators");
      const endNumBehaviorSelect = document.getElementById("frequency-end-numerators-behavior");
      const endDenBehaviorSelect = document.getElementById("frequency-end-denominators-behavior");
      if (endNumeratorsInput) {
        endNumeratorsInput.addEventListener("input", () => {
          const { ok } = this._validateSINString(endNumeratorsInput.value);
          endNumeratorsInput.classList.toggle("invalid-input", !ok);
          if (this.isPlaying) {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "end",
              config: {
                numerators: endNumeratorsInput.value
              }
            });
            this.markPendingChanges();
          }
        });
        endNumeratorsInput.addEventListener("blur", () => {
          if (!this.isPlaying) {
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "end",
              config: {
                numerators: endNumeratorsInput.value
              }
            });
          } else {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "end",
              config: {
                numerators: endNumeratorsInput.value
              }
            });
            this.markPendingChanges();
          }
        });
      }
      if (endDenominatorsInput) {
        endDenominatorsInput.addEventListener("input", () => {
          const { ok } = this._validateSINString(endDenominatorsInput.value);
          endDenominatorsInput.classList.toggle("invalid-input", !ok);
          if (this.isPlaying) {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "end",
              config: {
                denominators: endDenominatorsInput.value
              }
            });
            this.markPendingChanges();
          }
        });
        endDenominatorsInput.addEventListener("blur", () => {
          if (!this.isPlaying) {
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "end",
              config: {
                denominators: endDenominatorsInput.value
              }
            });
          } else {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "end",
              config: {
                denominators: endDenominatorsInput.value
              }
            });
            this.markPendingChanges();
          }
        });
      }
      if (endNumBehaviorSelect) {
        endNumBehaviorSelect.addEventListener("change", () => {
          if (!this.isPlaying) {
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "end",
              config: {
                numeratorBehavior: endNumBehaviorSelect.value
              }
            });
          } else {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "end",
              config: {
                numeratorBehavior: endNumBehaviorSelect.value
              }
            });
            this.markPendingChanges();
          }
        });
      }
      if (endDenBehaviorSelect) {
        endDenBehaviorSelect.addEventListener("change", () => {
          if (!this.isPlaying) {
            this._applyHRGChangeWithPortamento({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "end",
              config: {
                denominatorBehavior: endDenBehaviorSelect.value
              }
            });
          } else {
            this._updatePendingState({
              type: "SET_GENERATOR_CONFIG",
              param: "frequency",
              position: "end",
              config: {
                denominatorBehavior: endDenBehaviorSelect.value
              }
            });
            this.markPendingChanges();
          }
        });
      }
    }
    this._updateUIFromState(paramName);
  }
  setupFrequencyControls() {
    const paramName = "frequency";
    const baseInput = document.getElementById("frequency-base");
    const interpSelect = document.getElementById("frequency-interpolation");
    const startNumeratorsInput = document.getElementById("frequency-start-numerators");
    const startDenominatorsInput = document.getElementById("frequency-start-denominators");
    const startNumBehaviorSelect = document.getElementById("frequency-start-numerators-behavior");
    const startDenBehaviorSelect = document.getElementById("frequency-start-denominators-behavior");
    const endNumeratorsInput = document.getElementById("frequency-end-numerators");
    const endDenominatorsInput = document.getElementById("frequency-end-denominators");
    const endNumBehaviorSelect = document.getElementById("frequency-end-numerators-behavior");
    const endDenBehaviorSelect = document.getElementById("frequency-end-denominators-behavior");
    if (baseInput) {
      baseInput.addEventListener("input", () => {
        const v = parseFloat(baseInput.value);
        const isValid = Number.isFinite(v);
        baseInput.classList.toggle("invalid-input", !isValid && baseInput.value.trim() !== "");
      });
      const applyBase = () => {
        let v = parseFloat(baseInput.value);
        if (!Number.isFinite(v)) return;
        v = Math.max(16, Math.min(16384, v));
        baseInput.value = String(v);
        if (this.isPlaying) {
          this._updatePendingState({
            type: "SET_BASE_VALUE",
            param: paramName,
            value: v
          });
          this.broadcastMusicalParameters();
          this.pendingParameterChanges.add(paramName);
          this.updateParameterVisualFeedback(paramName);
        } else {
          this._updateActiveState({
            type: "SET_BASE_VALUE",
            param: paramName,
            value: v
          });
          const portamentoTime = this.elements.portamentoTime ? parseInt(this.elements.portamentoTime.value) : 100;
          this.broadcastSubParameterUpdate(`${paramName}.baseValue`, v, portamentoTime);
          this.pendingParameterChanges.delete(paramName);
          this.updateParameterVisualFeedback(paramName);
        }
      };
      baseInput.addEventListener("blur", applyBase);
    }
    if (interpSelect) {
      interpSelect.addEventListener("change", () => {
        const interpolation = interpSelect.value;
        this._updatePendingState({
          type: "SET_INTERPOLATION",
          param: paramName,
          interpolation
        });
        this.markPendingChanges();
        this.broadcastMusicalParameters();
      });
    }
    if (startNumeratorsInput) {
      startNumeratorsInput.addEventListener("input", () => {
        const { ok } = this._validateSINString(startNumeratorsInput.value);
        startNumeratorsInput.classList.toggle("invalid-input", !ok);
        if (this.isPlaying) {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: {
              numerators: startNumeratorsInput.value
            }
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged("frequency");
        }
      });
      startNumeratorsInput.addEventListener("blur", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: {
              numerators: startNumeratorsInput.value
            }
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: {
              numerators: startNumeratorsInput.value
            }
          });
          this.markPendingChanges();
        }
      });
    }
    if (startDenominatorsInput) {
      startDenominatorsInput.addEventListener("input", () => {
        const { ok } = this._validateSINString(startDenominatorsInput.value);
        startDenominatorsInput.classList.toggle("invalid-input", !ok);
        if (this.isPlaying) {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: {
              denominators: startDenominatorsInput.value
            }
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged("frequency");
        }
      });
      startDenominatorsInput.addEventListener("blur", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: {
              denominators: startDenominatorsInput.value
            }
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: {
              denominators: startDenominatorsInput.value
            }
          });
          this.markPendingChanges();
        }
      });
    }
    if (startNumBehaviorSelect) {
      startNumBehaviorSelect.addEventListener("change", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: {
              numeratorBehavior: startNumBehaviorSelect.value
            }
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: {
              numeratorBehavior: startNumBehaviorSelect.value
            }
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged("frequency");
        }
      });
    }
    if (startDenBehaviorSelect) {
      startDenBehaviorSelect.addEventListener("change", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: {
              denominatorBehavior: startDenBehaviorSelect.value
            }
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "start",
            config: {
              denominatorBehavior: startDenBehaviorSelect.value
            }
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged("frequency");
        }
      });
    }
    if (endNumeratorsInput) {
      endNumeratorsInput.addEventListener("input", () => {
        const { ok } = this._validateSINString(endNumeratorsInput.value);
        endNumeratorsInput.classList.toggle("invalid-input", !ok);
        if (this.isPlaying) {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: {
              numerators: endNumeratorsInput.value
            }
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged("frequency");
        }
      });
      endNumeratorsInput.addEventListener("blur", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: {
              numerators: endNumeratorsInput.value
            }
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: {
              numerators: endNumeratorsInput.value
            }
          });
          this.markPendingChanges();
        }
      });
    }
    if (endDenominatorsInput) {
      endDenominatorsInput.addEventListener("input", () => {
        const { ok } = this._validateSINString(endDenominatorsInput.value);
        endDenominatorsInput.classList.toggle("invalid-input", !ok);
        if (this.isPlaying) {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: {
              denominators: endDenominatorsInput.value
            }
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged("frequency");
        }
      });
      endDenominatorsInput.addEventListener("blur", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: {
              denominators: endDenominatorsInput.value
            }
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: {
              denominators: endDenominatorsInput.value
            }
          });
          this.markPendingChanges();
        }
      });
    }
    if (endNumBehaviorSelect) {
      endNumBehaviorSelect.addEventListener("change", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: {
              numeratorBehavior: endNumBehaviorSelect.value
            }
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: {
              numeratorBehavior: endNumBehaviorSelect.value
            }
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged("frequency");
        }
      });
    }
    if (endDenBehaviorSelect) {
      endDenBehaviorSelect.addEventListener("change", () => {
        if (!this.isPlaying) {
          this._applyHRGChangeWithPortamento({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: {
              denominatorBehavior: endDenBehaviorSelect.value
            }
          });
        } else {
          this._updatePendingState({
            type: "SET_GENERATOR_CONFIG",
            param: "frequency",
            position: "end",
            config: {
              denominatorBehavior: endDenBehaviorSelect.value
            }
          });
          this.markPendingChanges();
          this.broadcastSingleParameterStaged("frequency");
        }
      });
    }
    this._updateUIFromState("frequency");
  }
  /**
   * Handle value input changes with smart range detection
   */
  _handleValueInput(paramName, inputValue, position) {
    const currentMode = "program";
    const trimmedValue = inputValue.trim();
    if (trimmedValue.includes("-")) {
    }
    if (currentMode === "direct") {
      let baseValue;
      if (trimmedValue.includes("-")) {
        const [min, max] = trimmedValue.split("-").map((v) => parseFloat(v.trim()));
        if (!isNaN(min) && !isNaN(max)) {
          baseValue = (min + max) / 2;
        }
      } else {
        const value = parseFloat(trimmedValue);
        if (!isNaN(value)) {
          baseValue = value;
        }
      }
      if (baseValue !== void 0) {
        this._updatePendingState({
          type: "SET_BASE_VALUE",
          param: paramName,
          value: baseValue
        });
      }
    } else {
      this._updateProgramGenerator(paramName, trimmedValue, position);
    }
  }
  /**
   * Update program generator based on input value (single value or range)
   */
  _updateProgramGenerator(paramName, inputValue, position) {
    if (paramName === "frequency") return;
    if (inputValue.includes("-")) {
      const [min, max] = inputValue.split("-").map((v) => parseFloat(v.trim()));
      if (!isNaN(min) && !isNaN(max)) {
        this._updatePendingState({
          type: "SET_GENERATOR_CONFIG",
          param: paramName,
          position,
          config: {
            type: "normalised",
            range: {
              min: Math.min(min, max),
              max: Math.max(min, max)
            },
            sequenceBehavior: "static"
          }
        });
      }
    } else {
      const value = parseFloat(inputValue);
      if (!isNaN(value)) {
        this._updatePendingState({
          type: "SET_GENERATOR_CONFIG",
          param: paramName,
          position,
          config: {
            type: "normalised",
            range: value,
            sequenceBehavior: "static"
          }
        });
        if (position === "start") {
          const state = this.pendingMusicalState[paramName];
          const needsEndMirror = state.interpolation !== "step" && state.endValueGenerator?.type === "normalised" && typeof state.endValueGenerator.range !== "number";
          if (needsEndMirror) {
            const endInput = document.getElementById(`${paramName}-end-value`);
            const raw = (endInput?.value || "").trim();
            if (!raw || raw === "0-1") {
              this._updatePendingState({
                type: "SET_GENERATOR_CONFIG",
                param: paramName,
                position: "end",
                config: {
                  type: "normalised",
                  range: value,
                  sequenceBehavior: "static"
                }
              });
            }
          }
        }
      }
    }
  }
  /**
   * Update UI visibility based on current interpolation type
   */
  /**
  * Update UI elements to reflect the current typed state
  * This is the reverse of the old DOM-based state management
  * State is now the master, UI is just a reflection of it
  */
  _updateUIFromState(paramName) {
    const paramState = this.pendingMusicalState[paramName];
    const valueInput = paramName === "frequency" ? document.getElementById("frequency-base") : document.getElementById(`${paramName}-value`);
    const interpSelect = document.getElementById(`${paramName}-interpolation`);
    const hrgStartControls = document.getElementById(`${paramName}-start-hrg`);
    const hrgEndControls = document.getElementById(`${paramName}-end-hrg`);
    const hrgArrow = document.getElementById(`${paramName}-hrg-arrow`);
    const endValueInput = document.getElementById(`${paramName}-end-value`);
    if (!valueInput) return;
    if (valueInput) {
      valueInput.style.display = "inline-block";
      if (paramState.startValueGenerator?.type === "normalised") {
        const range = paramState.startValueGenerator.range;
        if (typeof range === "number") {
          valueInput.value = range.toString();
        } else if (typeof range === "object") {
          valueInput.value = `${range.min}-${range.max}`;
        }
      } else if (paramState.startValueGenerator?.type === "periodic") {
        valueInput.value = (paramState.baseValue ?? "").toString();
      } else if (paramState.baseValue !== null) {
        valueInput.value = paramState.baseValue.toString();
      } else {
        valueInput.value = "";
        valueInput.focus();
      }
    }
    if (interpSelect) {
      interpSelect.style.display = "inline-block";
      interpSelect.value = paramState.interpolation;
    }
    if (hrgStartControls) {
      hrgStartControls.style.display = "inline";
    }
    const isEnvelope = paramState.interpolation !== "step";
    if (hrgEndControls) {
      hrgEndControls.style.display = isEnvelope ? "inline" : "none";
    }
    if (hrgArrow) hrgArrow.style.display = isEnvelope ? "inline" : "none";
    if (endValueInput) {
      endValueInput.style.display = isEnvelope ? "inline" : "none";
    }
    if (endValueInput && isEnvelope && paramState.endValueGenerator && paramState.endValueGenerator.type === "normalised") {
      const endGen = paramState.endValueGenerator;
      if (typeof endGen.range === "number") {
        endValueInput.value = endGen.range.toString();
      } else if (typeof endGen.range === "object") {
        endValueInput.value = `${endGen.range.min}-${endGen.range.max}`;
      }
    }
    if (paramName === "frequency") {
      const startGen = paramState.startValueGenerator;
      if (startGen && startGen.type === "periodic") {
        const startNums = document.getElementById("frequency-start-numerators");
        const startDens = document.getElementById("frequency-start-denominators");
        const startNumBeh = document.getElementById("frequency-start-numerators-behavior");
        const startDenBeh = document.getElementById("frequency-start-denominators-behavior");
        if (startNums) startNums.value = startGen.numerators ?? "1";
        if (startDens) startDens.value = startGen.denominators ?? "1";
        if (startNumBeh) {
          startNumBeh.value = startGen.numeratorBehavior ?? "static";
        }
        if (startDenBeh) {
          startDenBeh.value = startGen.denominatorBehavior ?? "static";
        }
      }
      if (isEnvelope) {
        const endGen = paramState.endValueGenerator;
        if (endGen && endGen.type === "periodic") {
          const endNums = document.getElementById("frequency-end-numerators");
          const endDens = document.getElementById("frequency-end-denominators");
          const endNumBeh = document.getElementById("frequency-end-numerators-behavior");
          const endDenBeh = document.getElementById("frequency-end-denominators-behavior");
          if (endNums) endNums.value = endGen.numerators ?? "1";
          if (endDens) endDens.value = endGen.denominators ?? "1";
          if (endNumBeh) {
            endNumBeh.value = endGen.numeratorBehavior ?? "static";
          }
          if (endDenBeh) {
            endDenBeh.value = endGen.denominatorBehavior ?? "static";
          }
        }
      }
    }
  }
  // Capture current HRG inputs into pending state before apply
  _syncHRGStateFromInputs() {
    const freqState = this.pendingMusicalState.frequency;
    if (!freqState || freqState.startValueGenerator?.type !== "periodic") return;
    let anyInvalid = false;
    const validateField = (el, label) => {
      if (!el) return true;
      const { ok } = this._validateSINString(el.value);
      el.classList.toggle("invalid-input", !ok);
      if (!ok) {
        this.log(`Invalid ${label}: "${el.value}" (use numbers, commas, and ranges like 1-6)`, "error");
      }
      return ok;
    };
    const v1 = validateField(document.getElementById("frequency-start-numerators"), "start numerators");
    const v2 = validateField(document.getElementById("frequency-start-denominators"), "start denominators");
    const v3 = validateField(document.getElementById("frequency-end-numerators"), "end numerators");
    const v4 = validateField(document.getElementById("frequency-end-denominators"), "end denominators");
    anyInvalid = !(v1 && v2 && v3 && v4);
    if (anyInvalid) {
      return false;
    }
    if (freqState.startValueGenerator?.type === "periodic") {
      const startNums = document.getElementById("frequency-start-numerators")?.value;
      const startDens = document.getElementById("frequency-start-denominators")?.value;
      const startNumBeh = document.getElementById("frequency-start-numerators-behavior")?.value;
      const startDenBeh = document.getElementById("frequency-start-denominators-behavior")?.value;
      freqState.startValueGenerator.numerators = startNums ?? freqState.startValueGenerator.numerators;
      freqState.startValueGenerator.denominators = startDens ?? freqState.startValueGenerator.denominators;
      freqState.startValueGenerator.numeratorBehavior = startNumBeh ?? freqState.startValueGenerator.numeratorBehavior;
      freqState.startValueGenerator.denominatorBehavior = startDenBeh ?? freqState.startValueGenerator.denominatorBehavior;
    }
    if (freqState.interpolation !== "step" && freqState.endValueGenerator?.type === "periodic") {
      const endNums = document.getElementById("frequency-end-numerators")?.value;
      const endDens = document.getElementById("frequency-end-denominators")?.value;
      const endNumBeh = document.getElementById("frequency-end-numerators-behavior")?.value;
      const endDenBeh = document.getElementById("frequency-end-denominators-behavior")?.value;
      freqState.endValueGenerator.numerators = endNums ?? freqState.endValueGenerator.numerators;
      freqState.endValueGenerator.denominators = endDens ?? freqState.endValueGenerator.denominators;
      freqState.endValueGenerator.numeratorBehavior = endNumBeh ?? freqState.endValueGenerator.numeratorBehavior;
      freqState.endValueGenerator.denominatorBehavior = endDenBeh ?? freqState.endValueGenerator.denominatorBehavior;
    }
    return true;
  }
  markPendingChanges() {
    console.log("markPendingChanges called");
    this.hasPendingChanges = true;
  }
  clearPendingChanges() {
    this.hasPendingChanges = false;
  }
  /**
   * Unified method to set parameter state and update UI
   */
  setParameterState(paramName, newState) {
    this.musicalState[paramName] = newState;
    this.pendingMusicalState[paramName] = {
      ...newState
    };
    this._updateUIFromState(paramName);
  }
  applyParameterChanges() {
    const ok = this._syncHRGStateFromInputs();
    if (ok === false) {
      this.log("Fix invalid HRG inputs before applying.", "error");
      return;
    }
    this.musicalState = JSON.parse(JSON.stringify(this.pendingMusicalState));
    console.log("Applying new state:", this.musicalState);
    this.broadcastMusicalParameters();
    this.clearPendingChanges();
  }
  // Validate a SIN string like "1-3,5,7-9"
  _validateSINString(str) {
    if (str == null) return {
      ok: false,
      error: "empty"
    };
    const s = String(str).trim();
    if (s.length === 0) return {
      ok: false,
      error: "empty"
    };
    const basic = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;
    if (!basic.test(s)) return {
      ok: false,
      error: "format"
    };
    const parts = s.split(",");
    for (const p of parts) {
      const t = p.trim();
      if (t.includes("-")) {
        const [aStr, bStr] = t.split("-").map((v) => v.trim());
        const a = parseInt(aStr, 10);
        const b = parseInt(bStr, 10);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0 || a > b) {
          return {
            ok: false,
            error: "range"
          };
        }
      } else {
        const n = parseInt(t, 10);
        if (!Number.isFinite(n) || n <= 0) {
          return {
            ok: false,
            error: "number"
          };
        }
      }
    }
    return {
      ok: true
    };
  }
  /**
   * Central method for translating IMusicalState to wire format (unified, scope-free)
   * Used by both broadcastMusicalParameters and sendCompleteStateToSynth
   */
  _getWirePayload(portamentoTime) {
    for (const key in this.musicalState) {
      const paramState = this.musicalState[key];
      if ("scope" in paramState) {
        throw new Error(`CRITICAL: Parameter '${key}' has forbidden 'scope' field`);
      }
    }
    const wirePayload = {
      synthesisActive: this.synthesisActive,
      isManualMode: this.isManualControlMode
    };
    if (portamentoTime !== void 0) {
      wirePayload.portamentoTime = portamentoTime;
    }
    for (const key in this.musicalState) {
      const paramKey = key;
      const paramState = this.musicalState[paramKey];
      if (!paramState.interpolation || ![
        "step",
        "cosine"
      ].includes(paramState.interpolation)) {
        throw new Error(`CRITICAL: Parameter '${paramKey}' missing valid interpolation`);
      }
      if (!paramState.startValueGenerator) {
        throw new Error(`CRITICAL: Parameter '${paramKey}' missing startValueGenerator`);
      }
      if (paramState.interpolation === "cosine" && !paramState.endValueGenerator) {
        throw new Error(`CRITICAL: Parameter '${paramKey}' cosine interpolation missing endValueGenerator`);
      }
      if (paramState.startValueGenerator.type === "periodic" && paramState.baseValue === void 0) {
        throw new Error(`CRITICAL: Parameter '${paramKey}' periodic generator missing baseValue`);
      }
      const startGen = {
        ...paramState.startValueGenerator
      };
      let endGen = void 0;
      if (paramState.interpolation === "cosine" && paramState.endValueGenerator) {
        endGen = {
          ...paramState.endValueGenerator
        };
      }
      wirePayload[paramKey] = {
        interpolation: paramState.interpolation,
        startValueGenerator: startGen,
        endValueGenerator: endGen,
        baseValue: paramState.baseValue
      };
    }
    return wirePayload;
  }
  broadcastMusicalParameters(portamentoTime) {
    if (!this.star) return;
    const wirePayload = this._getWirePayload(portamentoTime);
    console.log("Broadcasting translated payload:", wirePayload);
    const message = MessageBuilder.createParameterUpdate(MessageTypes.PROGRAM_UPDATE, wirePayload);
    this.star.broadcast(message);
    this.log(`\u{1F4E1} Broadcasted musical parameters${portamentoTime ? ` with ${portamentoTime}ms portamento` : ""}`, "info");
  }
  /**
   * Broadcast update for a single parameter with portamento
   * More efficient than broadcasting entire state when only one parameter changed
   */
  broadcastSingleParameterUpdate(paramName, portamentoTime) {
    if (!this.star) return;
    const paramState = this.pendingMusicalState[paramName];
    if ("scope" in paramState) {
      throw new Error(`CRITICAL: Parameter '${paramName}' has forbidden 'scope' field`);
    }
    const wirePayload = {
      synthesisActive: this.synthesisActive,
      portamentoTime
    };
    const startGen = {
      ...paramState.startValueGenerator
    };
    let endGen = void 0;
    if (paramState.interpolation === "cosine" && paramState.endValueGenerator) {
      endGen = {
        ...paramState.endValueGenerator
      };
    }
    wirePayload[paramName] = {
      interpolation: paramState.interpolation,
      startValueGenerator: startGen,
      endValueGenerator: endGen,
      baseValue: paramState.baseValue
    };
    const message = MessageBuilder.createParameterUpdate(MessageTypes.PROGRAM_UPDATE, wirePayload);
    this.star.broadcastToType("synth", message, "control");
    this.log(`\u{1F4E1} Broadcasted ${paramName} update with ${portamentoTime}ms portamento`, "info");
  }
  /**
   * Broadcast a sub-parameter update (e.g., frequency.baseValue)
   */
  broadcastSubParameterUpdate(paramPath, value, portamentoTime) {
    if (!this.star) return;
    const message = MessageBuilder.subParamUpdate(paramPath, value, portamentoTime);
    this.star.broadcastToType("synth", message, "control");
    this.log(`\u{1F4E1} Broadcasted sub-parameter ${paramPath} = ${value} with ${portamentoTime}ms portamento`, "info");
  }
  // Broadcast a single parameter update for staging at EOC (no portamento field)
  broadcastSingleParameterStaged(paramName) {
    if (!this.star) return;
    const paramState = this.musicalState[paramName];
    if ("scope" in paramState) {
      throw new Error(`CRITICAL: Parameter '${paramName}' has forbidden 'scope' field`);
    }
    const wirePayload = {
      synthesisActive: this.synthesisActive
    };
    const startGen = {
      ...paramState.startValueGenerator
    };
    if (startGen.type === "periodic") {
      startGen.baseValue = paramState.baseValue;
    }
    let endGen = void 0;
    if (paramState.interpolation === "cosine" && paramState.endValueGenerator) {
      endGen = {
        ...paramState.endValueGenerator
      };
      if (endGen.type === "periodic") {
        endGen.baseValue = paramState.baseValue;
      }
    }
    wirePayload[paramName] = {
      interpolation: paramState.interpolation,
      startValueGenerator: startGen,
      endValueGenerator: endGen,
      baseValue: paramState.baseValue
    };
    const message = MessageBuilder.createParameterUpdate(MessageTypes.PROGRAM_UPDATE, wirePayload);
    this.star.broadcastToType("synth", message, "control");
  }
  // Removed splitParametersByMode - no longer needed with separated state
  // Phasor Management Methods
  calculateCycleLength() {
    this.cycleLength = this.periodSec;
  }
  applyPendingTimingChanges() {
    let changed = false;
    if (this.pendingPeriodSec !== null) {
      this.periodSec = this.pendingPeriodSec;
      this.cycleLength = this.periodSec;
      this.log(`Applied period change: ${this.periodSec}s`, "info");
      this.pendingPeriodSec = null;
      changed = true;
    }
    if (this.pendingStepsPerCycle !== null) {
      this.stepsPerCycle = this.pendingStepsPerCycle;
      this.updatePhasorTicks();
      this.log(`Applied steps change: ${this.stepsPerCycle}`, "info");
      this.pendingStepsPerCycle = null;
      changed = true;
    }
    if (changed) {
      if (this.elements.periodInput) {
        this.elements.periodInput.value = this.periodSec.toString();
      }
      if (this.elements.stepsInput) {
        this.elements.stepsInput.value = this.stepsPerCycle.toString();
      }
    }
  }
  initializePhasor() {
    this.phasor = 0;
    this.lastPhasorTime = performance.now() / 1e3;
    this.updatePhasorTicks();
    this.startPhasorUpdate();
    this.updatePhasorDisplay();
  }
  updatePhasorTicks() {
    if (!this.elements.phasorTicks) return;
    this.elements.phasorTicks.innerHTML = "";
    for (let i = 0; i < this.stepsPerCycle; i++) {
      const tick = document.createElement("div");
      tick.className = "phasor-tick";
      tick.style.left = `${i / this.stepsPerCycle * 100}%`;
      this.elements.phasorTicks.appendChild(tick);
    }
  }
  updatePhasor() {
    const currentTime = performance.now() / 1e3;
    const deltaTime = currentTime - this.lastPhasorTime;
    if (this.isPlaying) {
      const phasorIncrement = deltaTime / this.cycleLength;
      const previousPhasor = this.phasor;
      this.phasor += phasorIncrement;
      const eocCrossed = this.phasor >= 1;
      if (this.phasor >= 1) {
        this.phasor -= 1;
        this.applyPendingTimingChanges();
        this.clearAllPendingChanges();
      }
    }
    this.lastPhasorTime = currentTime;
    this.updatePhasorDisplay();
    this.updateES8State();
    this.broadcastPhasor(currentTime);
  }
  updatePhasorDisplay() {
    if (this.elements.phasorDisplay) {
      this.elements.phasorDisplay.textContent = this.phasor.toFixed(3);
    }
    if (this.elements.phasorBar) {
      const percentage = (this.phasor * 100).toFixed(1);
      this.elements.phasorBar.style.width = `${percentage}%`;
    }
  }
  startPhasorUpdate() {
    const updateLoop = () => {
      this.updatePhasor();
      this.phasorUpdateId = requestAnimationFrame(updateLoop);
    };
    updateLoop();
  }
  stopPhasorUpdate() {
    if (this.phasorUpdateId) {
      cancelAnimationFrame(this.phasorUpdateId);
      this.phasorUpdateId = null;
    }
  }
  broadcastPhasor(currentTime) {
    if (!this.star) return;
    const timeSinceLastBroadcast = currentTime - this.lastBroadcastTime;
    const broadcastInterval = 1 / this.phasorBroadcastRate;
    if (timeSinceLastBroadcast >= broadcastInterval) {
      const message = MessageBuilder.phasorSync(this.phasor, null, this.stepsPerCycle, this.cycleLength, this.isPlaying);
      const sent = this.star.broadcastToType("synth", message, "sync");
      this.lastBroadcastTime = currentTime;
    }
  }
  // ES-8 Integration Methods
  async toggleES8() {
    this.es8Enabled = !this.es8Enabled;
    if (this.es8Enabled) {
      await this.initializeES8();
      this.elements.es8EnableBtn.textContent = "disable es-8";
      this.elements.es8EnableBtn.classList.add("active");
      this.log("ES-8 enabled - CV output active", "success");
    } else {
      this.shutdownES8();
      this.elements.es8EnableBtn.textContent = "enable es-8";
      this.elements.es8EnableBtn.classList.remove("active");
      this.log("ES-8 disabled", "info");
    }
  }
  async initializeES8() {
    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContext({
          sampleRate: 48e3
        });
        await this.audioContext.resume();
      }
      if (this.audioContext.destination.maxChannelCount >= 8) {
        this.audioContext.destination.channelCount = 8;
        this.audioContext.destination.channelCountMode = "explicit";
        this.audioContext.destination.channelInterpretation = "discrete";
        this.log("Configured audio destination for 8 channels", "info");
      } else {
        this.log(`Only ${this.audioContext.destination.maxChannelCount} channels available`, "warning");
      }
      await this.audioContext.audioWorklet.addModule("/ctrl/worklets/es8-processor.worklet.js");
      this.es8Node = new AudioWorkletNode(this.audioContext, "es8-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [
          8
        ],
        channelCount: 8,
        channelCountMode: "explicit",
        channelInterpretation: "discrete"
      });
      this.es8Node.connect(this.audioContext.destination);
      this.es8Node.port.postMessage({
        type: "enable",
        enabled: true
      });
      this.updateES8State();
      this.sendSynthParametersToES8();
      this.log("ES-8 AudioWorklet initialized", "info");
    } catch (error) {
      this.log(`ES-8 initialization failed: ${error.message}`, "error");
      this.es8Enabled = false;
    }
  }
  updateES8State() {
    if (!this.es8Enabled || !this.es8Node) return;
    this.es8Node.port.postMessage({
      type: "phasor-update",
      phasor: this.phasor,
      periodSec: this.periodSec,
      stepsPerCycle: this.stepsPerCycle,
      cycleLength: this.cycleLength
    });
  }
  sendSynthParametersToES8() {
    if (!this.es8Enabled || !this.es8Node) return;
    const params = this.musicalState;
    this.es8Node.port.postMessage({
      type: "synth-parameters",
      frequency: params.frequency,
      vowelX: params.vowelX,
      vowelY: params.vowelY,
      zingAmount: params.zingAmount,
      amplitude: params.amplitude
    });
  }
  shutdownES8() {
    if (this.es8Node) {
      this.es8Node.port.postMessage({
        type: "enable",
        enabled: false
      });
      this.es8Node.disconnect();
      this.es8Node = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
  // Transport control methods
  handleTransport(action) {
    console.log(`Transport: ${action}`);
    const wasAtZero = this.phasor === 0;
    switch (action) {
      case "play":
        this.isPlaying = true;
        this.lastPhasorTime = performance.now() / 1e3;
        this.log("Global phasor started", "info");
        if (wasAtZero && this.star) {
          console.log("\u{1F504} Triggering EOC event - playing from reset position");
          const eocMessage = MessageBuilder.jumpToEOC();
          this.star.broadcastToType("synth", eocMessage, "control");
        }
        break;
      case "pause":
        this.isPlaying = false;
        this.clearAllPendingChanges();
        this.log("Global phasor paused", "info");
        break;
      case "stop":
        this.isPlaying = false;
        this.phasor = 0;
        this.lastPhasorTime = performance.now() / 1e3;
        this.clearAllPendingChanges();
        this.updatePhasorDisplay();
        this.log("Global phasor stopped and reset", "info");
        break;
    }
    this.updatePlayPauseButton();
    if (this.star) {
      const transportMessage = MessageBuilder.transport(action);
      this.star.broadcastToType("synth", transportMessage, "control");
    }
    this.broadcastPhasor(performance.now() / 1e3);
  }
  updatePlayPauseButton() {
    if (this.elements.playBtn) {
      this.elements.playBtn.textContent = this.isPlaying ? "pause" : "play";
    }
  }
  handleUnifiedParameterUpdate(paramName, value) {
    console.log(`\u{1F39B}\uFE0F Unified parameter update: ${paramName} = ${value}`);
    this._updatePendingState({
      type: "SET_BASE_VALUE",
      param: paramName,
      value: parseFloat(value) || 0
    });
    const paramState = this.pendingMusicalState[paramName];
    const resolvedValues = this.resolveParameterValues(paramName, paramState);
    const portamentoTime = this.elements.portamentoTime ? parseInt(this.elements.portamentoTime.value) : 100;
    const message = MessageBuilder.unifiedParamUpdate(
      paramName,
      resolvedValues.start,
      resolvedValues.end,
      paramState.interpolation,
      this.isPlaying,
      portamentoTime,
      this.phasor
      // Include current phase for interpolation
    );
    if (this.star) {
      this.star.broadcastToType("synth", message, "control");
    }
    if (this.isPlaying) {
      this.pendingParameterChanges.add(paramName);
      this.updateParameterVisualFeedback(paramName);
    } else {
      this.pendingParameterChanges.delete(paramName);
      this.updateParameterVisualFeedback(paramName);
    }
    const statusIcon = this.isPlaying ? "\u{1F4CB}*" : "\u26A1";
    this.log(`${statusIcon} ${paramName}: ${resolvedValues.start}${resolvedValues.end !== void 0 ? ` \u2192 ${resolvedValues.end}` : ""} (${this.isPlaying ? "staged for EOC" : `immediate +${portamentoTime}ms`})`, "info");
  }
  updateParameterVisualFeedback(paramName) {
    const paramLabels = document.querySelectorAll(".param-label");
    for (const label of paramLabels) {
      const labelElement = label;
      const labelText = labelElement.textContent || "";
      const cleanText = labelText.replace("*", "").trim();
      const paramDisplayNames = {
        frequency: "freq",
        vowelX: "vowel x",
        vowelY: "vowel y",
        symmetry: "symmetry",
        zingAmount: "z amount",
        zingMorph: "z morph",
        amplitude: "amp",
        whiteNoise: "noise"
      };
      if (cleanText === paramDisplayNames[paramName]) {
        const hasPendingChanges = this.pendingParameterChanges.has(paramName);
        const shouldShowAsterisk = hasPendingChanges && this.isPlaying;
        if (shouldShowAsterisk && !labelText.includes("*")) {
          labelElement.textContent = cleanText + "*";
        } else if (!shouldShowAsterisk && labelText.includes("*")) {
          labelElement.textContent = cleanText;
        }
        break;
      }
    }
  }
  clearAllPendingChanges() {
    for (const paramName of this.pendingParameterChanges) {
      this.updateParameterVisualFeedback(paramName);
    }
    this.pendingParameterChanges.clear();
  }
  resolveParameterValues(paramName, paramState) {
    if (paramState.interpolation === "step") {
      return {
        start: this.resolveGeneratorValue(paramState.startValueGenerator, paramState.baseValue),
        end: void 0
      };
    }
    return {
      start: this.resolveGeneratorValue(paramState.startValueGenerator, paramState.baseValue),
      end: this.resolveGeneratorValue(paramState.endValueGenerator, paramState.baseValue)
    };
  }
  resolveGeneratorValue(generator, baseValue) {
    if (generator.type === "periodic") {
      const numerators = this.parseHRGString(generator.numerators || "1");
      const denominators = this.parseHRGString(generator.denominators || "1");
      const numerator = this.selectHRGValue(numerators, generator.sequenceBehavior);
      const denominator = this.selectHRGValue(denominators, generator.sequenceBehavior);
      return (baseValue || 220) * (numerator / denominator);
    } else {
      if (typeof generator.range === "number") {
        return generator.range;
      } else {
        const min = generator.range?.min || 0;
        const max = generator.range?.max || 1;
        return Math.random() * (max - min) + min;
      }
    }
  }
  parseHRGString(input) {
    const result = [];
    const parts = input.split(",");
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.includes("-")) {
        const [start, end] = trimmed.split("-").map(Number);
        for (let i = start; i <= end; i++) {
          result.push(i);
        }
      } else {
        result.push(Number(trimmed));
      }
    }
    return result;
  }
  selectHRGValue(values, behavior) {
    return values[Math.floor(Math.random() * values.length)];
  }
  handleReset() {
    console.log("Reset phasor");
    this.phasor = 0;
    this.lastPhasorTime = performance.now() / 1e3;
    this.updatePhasorDisplay();
    this.isPlaying = false;
    this.updatePlayPauseButton();
    if (this.star) {
      const message = MessageBuilder.jumpToEOC();
      this.star.broadcastToType("synth", message, "control");
    }
    this.broadcastPhasor(performance.now() / 1e3);
    this.log("Global phasor reset to 0.0", "info");
  }
  async connectToNetwork() {
    try {
      this.updateConnectionStatus("connecting");
      this.log("Connecting to network...", "info");
      this.star = new WebRTCStar(this.peerId, "ctrl");
      this.setupStarEventHandlers();
      const protocol = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
      const port = globalThis.location.port ? `:${globalThis.location.port}` : "";
      const signalingUrl = `${protocol}//${globalThis.location.hostname}${port}/ws`;
      await this.star.connect(signalingUrl, this.forceTakeover);
      if (this.forceTakeover) {
        this.updateConnectionStatus("active");
      } else {
        this.updateConnectionStatus("inactive");
      }
      this._updateUIState();
      this.log("Connected to network successfully", "success");
    } catch (error) {
      this.log(`Connection failed: ${error.message}`, "error");
      this.updateConnectionStatus("disconnected");
      this._updateUIState();
    }
  }
  _updateUIState() {
    const isConnected = this.star && this.star.isConnectedToSignaling;
  }
  setupStarEventHandlers() {
    this.star.addEventListener("became-leader", () => {
      this.log("Became network leader", "success");
      this._updateUIState();
    });
    this.star.addEventListener("peer-connected", (event) => {
      const { peerId } = event.detail;
      this.log(`Peer connected: ${peerId}`, "info");
      this.updatePeerList();
      this._updateUIState();
      if (peerId.startsWith("synth-")) {
        this.sendCompleteStateToSynth(peerId);
      }
    });
    this.star.addEventListener("peer-removed", (event) => {
      this.log(`Peer disconnected: ${event.detail.peerId}`, "info");
      this.updatePeerList();
      this._updateUIState();
    });
    this.star.addEventListener("kicked", (event) => {
      this.log(`Kicked: ${event.detail.reason}`, "error");
      this.updateConnectionStatus("kicked");
      this._updateUIState();
      alert("You have been disconnected: Another control client has taken over.");
    });
    this.star.addEventListener("join-rejected", (event) => {
      this.log(`Cannot join: ${event.detail.reason}`, "error");
      this.updateConnectionStatus("error");
      this._updateUIState();
      if (event.detail.reason.includes("Add ?force=true")) {
        if (confirm("Another control client is already connected. Force takeover?")) {
          globalThis.location.href = globalThis.location.href + "?force=true";
        }
      }
    });
    this.star.addEventListener("data-message", (event) => {
      const { peerId, channelType, message } = event.detail;
      if (message.type === MessageTypes.PING) {
        const pong = MessageBuilder.pong(message.id, message.timestamp);
        this.star.sendToPeer(peerId, pong, "sync");
      }
      if (message.type !== MessageTypes.PING && message.type !== MessageTypes.PONG) {
        this.log(`Received ${message.type} from ${peerId}`, "debug");
      }
    });
  }
  toggleSynthesis() {
    this.synthesisActive = !this.synthesisActive;
    if (this.synthesisActive) {
      this.elements.manualModeBtn.textContent = "Disable Synthesis";
      this.elements.manualModeBtn.classList.add("active");
      if (this.elements.synthesisStatus) {
        this.elements.synthesisStatus.textContent = "active";
      }
      this.log("Synthesis enabled - real-time parameter control active", "info");
    } else {
      this.elements.manualModeBtn.textContent = "Enable Synthesis";
      this.elements.manualModeBtn.classList.remove("active");
      if (this.elements.synthesisStatus) {
        this.elements.synthesisStatus.textContent = "inactive";
      }
      this.log("Synthesis disabled", "info");
    }
    this.broadcastMusicalParameters();
    this.broadcastPhasor(performance.now() / 1e3);
  }
  // Deprecated - use toggleSynthesis instead
  toggleManualMode() {
    this.toggleSynthesis();
  }
  sendCompleteStateToSynth(synthId) {
    this.log(`Sending complete state to new synth: ${synthId}`, "info");
    const wirePayload = this._getWirePayload();
    const message = MessageBuilder.createParameterUpdate(MessageTypes.PROGRAM_UPDATE, wirePayload);
    const success = this.star.sendToPeer(synthId, message, "control");
    if (success) {
      this.log(`\u2705 Sent typed musical state to ${synthId}`, "debug");
    } else {
      this.log(`\u274C Failed to send typed musical state to ${synthId}`, "error");
    }
  }
  updateConnectionStatus(status) {
    const statusElement = this.elements.connectionStatus;
    const valueElement = this.elements.connectionValue;
    const takeoverSection = this.elements.takeoverSection;
    statusElement.classList.remove("connected", "syncing", "active", "inactive", "kicked", "error");
    if (takeoverSection) {
      takeoverSection.style.display = "none";
    }
    switch (status) {
      case "active":
        valueElement.textContent = "Active Controller \u2713";
        statusElement.classList.add("active");
        break;
      case "inactive":
        valueElement.textContent = "Inactive (view only)";
        statusElement.classList.add("inactive");
        takeoverSection.style.display = "block";
        break;
      case "kicked":
        valueElement.textContent = "Kicked (reload to retry)";
        statusElement.classList.add("kicked");
        takeoverSection.style.display = "block";
        break;
      case "connected":
        valueElement.textContent = "Connected";
        statusElement.classList.add("connected");
        break;
      case "connecting":
        valueElement.textContent = "Connecting...";
        statusElement.classList.add("syncing");
        break;
      case "error":
        valueElement.textContent = "Connection Error";
        statusElement.classList.add("error");
        break;
      default:
        valueElement.textContent = "Disconnected";
    }
  }
  updatePeerCount(count) {
    if (this.elements.synthCount) {
      this.elements.synthCount.textContent = count.toString();
    }
    if (this.elements.synthCount) {
      if (count > 0) {
        this.elements.synthCount.classList.add("good");
      } else {
        this.elements.synthCount.classList.remove("good");
      }
    }
  }
  updateTimingStatus(isRunning) {
    const statusElement = this.elements.timingStatus;
    const valueElement = this.elements.timingValue;
    if (isRunning) {
      valueElement.textContent = "Running";
      statusElement.classList.add("syncing");
    } else {
      valueElement.textContent = "Stopped";
      statusElement.classList.remove("syncing");
    }
  }
  updatePhasorVisualization(phasor) {
    const percentage = (phasor * 100).toFixed(1);
    this.elements.phasorBar.style.width = `${percentage}%`;
    this.elements.phasorText.textContent = phasor.toFixed(3);
  }
  updatePeerList() {
    if (!this.star) {
      this.clearPeerList();
      return;
    }
    const stats = this.star.getNetworkStats();
    const peers = Object.keys(stats.peerStats);
    this.updatePeerCount(peers.length);
    if (peers.length === 0) {
      this.clearPeerList();
      return;
    }
    const listHTML = peers.map((peerId) => {
      const peerStats = stats.peerStats[peerId];
      const peerType = peerStats.peerType || peerId.split("-")[0];
      return `
        <div class="peer-item">
          <div class="peer-info">
            <div class="peer-id">${peerId}</div>
            <div class="peer-type">${peerType}</div>
          </div>
          <div class="peer-stats">
            <div>Status: ${peerStats.connectionState}</div>
          </div>
        </div>
      `;
    }).join("");
    this.elements.peerList.innerHTML = listHTML;
  }
  clearPeerList() {
    this.elements.peerList.innerHTML = `
      <div style="color: #888; font-style: italic; text-align: center; padding: 20px;">
        No peers connected
      </div>
    `;
  }
  log(message, level = "info") {
    const timestamp = (/* @__PURE__ */ new Date()).toLocaleTimeString();
    const prefix = {
      "info": "\u2139\uFE0F",
      "success": "\u2705",
      "error": "\u274C",
      "debug": "\u{1F50D}"
    }[level] || "\u2139\uFE0F";
    const logEntry = `[${timestamp}] ${prefix} ${message}
`;
    if (this.elements.debugLog) {
      this.elements.debugLog.textContent += logEntry;
      this.elements.debugLog.scrollTop = this.elements.debugLog.scrollHeight;
    }
    console.log(`[CTRL] ${message}`);
  }
  clearLog() {
    if (this.elements.debugLog) {
      this.elements.debugLog.textContent = "";
    }
  }
  setupSceneMemoryUI() {
    const sceneButtons = document.querySelectorAll(".scene-btn");
    sceneButtons.forEach((button) => {
      button.addEventListener("click", (e) => {
        const location = parseInt(button.getAttribute("data-location"));
        if (e.shiftKey) {
          this.saveScene(location);
        } else {
          this.loadScene(location);
        }
      });
    });
    this.updateSceneMemoryIndicators();
  }
  updateSceneMemoryIndicators() {
    const sceneButtons = document.querySelectorAll(".scene-btn");
    sceneButtons.forEach((button) => {
      const location = parseInt(button.getAttribute("data-location"));
      const key = `scene_${location}_controller`;
      const hasScene = localStorage.getItem(key) !== null;
      if (hasScene) {
        button.classList.add("has-scene");
      } else {
        button.classList.remove("has-scene");
      }
    });
  }
  saveScene(memoryLocation) {
    console.log(`\u{1F4BE} Saving scene to memory location ${memoryLocation}...`);
    try {
      const programToSave = {
        ...this.musicalState,
        savedAt: Date.now()
      };
      localStorage.setItem(`scene_${memoryLocation}_controller`, JSON.stringify(programToSave));
      if (this.star) {
        const message = MessageBuilder.saveScene(memoryLocation);
        this.star.broadcastToType("synth", message, "control");
      }
      this.log(`Scene ${memoryLocation} saved.`, "success");
      this.updateSceneMemoryIndicators();
    } catch (error) {
      console.error("Error saving scene:", error);
      this.log(`Failed to save scene ${memoryLocation}: ${error.message}`, "error");
    }
  }
  loadScene(memoryLocation) {
    console.log(`\u{1F4C2} Loading scene from memory location ${memoryLocation}...`);
    try {
      const savedProgramString = localStorage.getItem(`scene_${memoryLocation}_controller`);
      if (!savedProgramString) {
        this.log(`No scene found at location ${memoryLocation}.`, "error");
        return;
      }
      const loadedProgram = JSON.parse(savedProgramString);
      this.pendingMusicalState = loadedProgram;
      this.musicalState = JSON.parse(JSON.stringify(loadedProgram));
      Object.keys(this.musicalState).forEach((paramName) => {
        this._updateUIFromState(paramName);
      });
      if (this.star) {
        const message = MessageBuilder.loadScene(memoryLocation, loadedProgram);
        this.star.broadcastToType("synth", message, "control");
      }
      this.log(`Scene ${memoryLocation} loaded and broadcast.`, "success");
      this.updateSceneMemoryIndicators();
    } catch (error) {
      console.error("Error loading scene:", error);
      this.log(`Failed to load scene ${memoryLocation}: ${error.message}`, "error");
    }
  }
  clearSceneBanks() {
    for (let i = 0; i <= 9; i++) {
      localStorage.removeItem(`scene_${i}_controller`);
    }
    this.updateSceneMemoryIndicators();
    this.log("Cleared all scene banks", "success");
    if (this.star) {
      const msg = MessageBuilder.clearBanks();
      this.star.broadcastToType("synth", msg, "control");
    }
  }
  clearBank(memoryLocation) {
    localStorage.removeItem(`scene_${memoryLocation}_controller`);
    this.updateSceneMemoryIndicators();
    this.log(`Cleared scene bank ${memoryLocation}`, "success");
    if (this.star) {
      const msg = MessageBuilder.clearScene(memoryLocation);
      this.star.broadcastToType("synth", msg, "control");
    }
  }
  // Legacy setupParameterRandomizer method removed - now handled by compact controls
  // Close all randomizer modals when clicking outside
  // Update the visual state of randomizer buttons
  // Apply random value to specific start or end
  setupHRGKeyboardNavigation(controlsElement) {
    if (!controlsElement) return;
    const getFocusableElements = () => {
      return controlsElement.querySelectorAll('input[type="text"], select, input[type="checkbox"]');
    };
    const setupElementNavigation = () => {
      const focusableElements = getFocusableElements();
      focusableElements.forEach((element, index) => {
        element.addEventListener("keydown", (e) => {
          if (e.key === "Tab") {
            e.preventDefault();
            const nextIndex = e.shiftKey ? (index - 1 + focusableElements.length) % focusableElements.length : (index + 1) % focusableElements.length;
            focusableElements[nextIndex].focus();
          } else if (e.key === "Enter") {
            e.preventDefault();
            controlsElement.style.display = "none";
            const button = controlsElement.closest(".parameter-line")?.querySelector(".randomizer-btn");
            if (button) {
              button.classList.remove("active");
              button.focus();
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            controlsElement.style.display = "none";
            const button = controlsElement.closest(".parameter-line")?.querySelector(".randomizer-btn");
            if (button) {
              button.classList.remove("active");
              button.focus();
            }
          }
        });
      });
    };
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "attributes" && mutation.attributeName === "style") {
          if (controlsElement.style.display !== "none") {
            setTimeout(setupElementNavigation, 0);
          }
        }
      });
    });
    observer.observe(controlsElement, {
      attributes: true
    });
    if (controlsElement.style.display !== "none") {
      setupElementNavigation();
    }
  }
};
console.log("About to create ControlClient");
var controlClient = new ControlClient();
console.log("ControlClient created successfully");
globalThis.controlClient = controlClient;
