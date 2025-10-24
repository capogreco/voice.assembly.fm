/**
 * WebSocket handling for Voice.Assembly.FM signaling server
 */

import { createKVOperations } from "./kv.ts";

// Types for WebSocket connections and messages
interface Connection {
  socket: WebSocket;
  actual_id: string | null;
}

interface Message {
  type: string;
  sender_id?: string;
  timestamp?: number;
}

interface RegisterMessage extends Message {
  client_id: string;
  force_takeover?: boolean;
}

interface SignalingMessage extends Message {
  targetPeerId: string;
}

interface CtrlsListMessage extends Message {
  type: "ctrls-list";
  ctrls: string[];
}

interface SynthsListMessage extends Message {
  type: "synths-list";
  synths: string[];
}

interface CtrlJoinedMessage extends Message {
  type: "ctrl-joined";
  ctrl_id: string;
}

interface SynthJoinedMessage extends Message {
  type: "synth-joined";
  synth_id: string;
}

interface KVCtrlEntry {
  client_id: string;
  timestamp: number;
  ws_id: string;
}

// Global connection tracking
const connections = new Map<string, Connection>();
const synthKeepAliveTimers = new Map<string, number>();

// Initialize KV operations
const kv = await createKVOperations();

/**
 * Send message directly or queue for cross-edge delivery
 */
async function sendOrQueue(
  targetPeerId: string,
  payload: Record<string, unknown>,
  ttlMs = 10_000,
): Promise<void> {
  const target = connections.get(targetPeerId)?.socket;
  if (target?.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify(payload));
  } else {
    await kv.set(["messages", targetPeerId, crypto.randomUUID()], payload, {
      expireIn: ttlMs,
    });
  }
}

/**
 * Handle WebSocket messages and queue them in KV
 */
async function handleWebSocketMessage(
  sender_id: string,
  data: string,
): Promise<void> {
  try {
    const message: Message = JSON.parse(data);
    message.sender_id = sender_id;
    message.timestamp = Date.now();

    console.log(`📨 Message from ${sender_id}: ${message.type}`);

    // Handle synth requesting ctrl list - trust KV (multi-region)
    if (message.type === "request-ctrls") {
      const ctrlsList: string[] = [];
      const activeCtrlEntry = await kv.get(["active_ctrl"]);
      console.log(
        `[SERVER-STATE] SYNTH REQUEST from ${sender_id}. Active controller in DB is: ${
          (activeCtrlEntry?.value as KVCtrlEntry)?.client_id ?? "null"
        }`,
      );

      if (activeCtrlEntry?.value) {
        const activeCtrl = activeCtrlEntry.value as KVCtrlEntry;
        ctrlsList.push(activeCtrl.client_id);
      }

      const response: CtrlsListMessage = {
        type: "ctrls-list",
        ctrls: ctrlsList,
        timestamp: Date.now(),
      };

      const clientConnection = connections.get(sender_id);
      if (clientConnection?.socket.readyState === WebSocket.OPEN) {
        clientConnection.socket.send(JSON.stringify(response));
      }
      return;
    }

    // Handle ctrl requesting synth list (KV roster across regions)
    if (message.type === "request-synths") {
      const synthsList: string[] = [];
      // Prefer KV-backed roster so we see synths connected to other regions
      try {
        const synthEntries = kv.list({ prefix: ["synths"] });
        for await (const entry of synthEntries) {
          const key = entry.key as (string | unknown)[];
          const synthId = String(key[1]);
          if (synthId?.startsWith("synth-")) synthsList.push(synthId);
        }
      } catch (e) {
        console.error("[SYNTHS-LIST] Failed to read KV synth roster:", e);
      }

      const response: SynthsListMessage = {
        type: "synths-list",
        synths: synthsList,
        timestamp: Date.now(),
      };

      const clientConnection = connections.get(sender_id);
      if (clientConnection?.socket.readyState === WebSocket.OPEN) {
        clientConnection.socket.send(JSON.stringify(response));
      }
      return;
    }

    // Handle signaling messages (offer, answer, ice-candidate)
    if (["offer", "answer", "ice-candidate"].includes(message.type)) {
      const sigMessage = message as SignalingMessage;
      const payload = {
        ...sigMessage,
        fromPeerId: sender_id,
      };

      const target = connections.get(sigMessage.targetPeerId)?.socket;
      if (target?.readyState === WebSocket.OPEN) {
        console.log(
          `📤 Relayed ${message.type} from ${sender_id} to ${sigMessage.targetPeerId} (local)`,
        );
      } else {
        console.log(
          `📤 Queued ${message.type} from ${sender_id} to ${sigMessage.targetPeerId} (cross-edge)`,
        );
      }

      await sendOrQueue(sigMessage.targetPeerId, payload);
      return;
    }

    // All other messages with targets
    if ((message as any).target) {
      const target = connections.get((message as any).target)?.socket;
      if (target?.readyState === WebSocket.OPEN) {
        console.log(
          `📤 Relayed ${message.type} from ${sender_id} to ${
            (message as any).target
          } (local)`,
        );
      } else {
        console.log(
          `📤 Queued ${message.type} from ${sender_id} to ${
            (message as any).target
          } (cross-edge)`,
        );
      }

      await sendOrQueue(
        (message as any).target,
        message as unknown as Record<string, unknown>,
        30 * 1000,
      );
    }
  } catch (error) {
    console.error(`❌ Error handling message: ${error}`);
  }
}

/**
 * Poll KV for messages destined to this client
 */
async function startPollingForClient(
  client_id: string,
  socket: WebSocket,
): Promise<void> {
  console.log(`🔄 Starting polling for client: ${client_id}`);

  while (socket.readyState === WebSocket.OPEN) {
    try {
      const entries = kv.list({ prefix: ["messages", client_id] });

      for await (const entry of entries) {
        const message = entry.value as Message;
        console.log(`📩 Delivering message to ${client_id}: ${message.type}`);

        socket.send(JSON.stringify(message));
        await kv.delete(entry.key);
      }
    } catch (error) {
      console.error(`🔄 Polling error for ${client_id}: ${error}`);
    }

    // Poll every 200ms for better signaling performance
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log(`🔄 Stopped polling for client: ${client_id}`);
}

/**
 * Handle WebSocket connection registration
 */
async function handleRegistration(
  regMessage: RegisterMessage,
  socket: WebSocket,
  temp_id: string,
): Promise<string> {
  const old_id = temp_id;
  const client_id = regMessage.client_id;

  console.log(`✅ Peer ${client_id} registering...`);

  connections.delete(old_id);
  connections.set(client_id, { socket, actual_id: client_id });

  // Controller registration logic
  if (client_id.startsWith("ctrl-")) {
    const oldCtrlEntry = await kv.get(["active_ctrl"]);
    const oldCtrl = oldCtrlEntry?.value as (KVCtrlEntry | null);
    console.log(
      `[SERVER-STATE] REGISTRATION from ${client_id}. Current active_ctrl in DB is: ${
        oldCtrl?.client_id ?? "null"
      }`,
    );

    // The new controller registering should ALWAYS become the active one
    if (oldCtrl && oldCtrl.client_id !== client_id) {
      const oldCtrlSocket = connections.get(oldCtrl.client_id)?.socket;
      if (oldCtrlSocket?.readyState === WebSocket.OPEN) {
        console.log(
          `[SERVER-STATE] Kicking stale controller ${oldCtrl.client_id} due to new registration from ${client_id}.`,
        );
        oldCtrlSocket.send(
          JSON.stringify({
            type: "kicked",
            reason: "A new controller has connected.",
          }),
        );
      }
    }

    // Set the new controller as the active one
    const value: KVCtrlEntry = {
      client_id: client_id,
      timestamp: Date.now(),
      ws_id: temp_id,
    };
    console.log(
      `[SERVER-STATE] Setting active_ctrl in DB to: ${client_id}`,
    );
    await kv.set(["active_ctrl"], value);
    console.log(`👑 ${client_id} is now the active controller`);

    // Send the new controller a list of all current synths
    const synthsList = [];
    for (const [id, conn] of connections.entries()) {
      if (
        id.startsWith("synth-") &&
        conn.socket.readyState === WebSocket.OPEN
      ) {
        synthsList.push(id);
      }
    }

    if (synthsList.length > 0) {
      console.log(
        `[SERVER-STATE] Proactively sending synth list to new controller ${client_id}:`,
        synthsList,
      );
      const notification: SynthsListMessage = {
        type: "synths-list",
        synths: synthsList,
        timestamp: Date.now(),
      };
      socket.send(JSON.stringify(notification));
    }

    // Notify all synths about the new controller
    const notification: CtrlJoinedMessage = {
      type: "ctrl-joined",
      ctrl_id: client_id,
      timestamp: Date.now(),
    };

    // Local synths
    for (const [conn_id, conn_info] of connections) {
      if (
        conn_id.startsWith("synth-") &&
        conn_info.socket.readyState === WebSocket.OPEN
      ) {
        conn_info.socket.send(JSON.stringify(notification));
      }
    }

    // Cross-edge synths via KV mailbox
    try {
      const synthEntries = kv.list({ prefix: ["synths"] });
      for await (const entry of synthEntries) {
        const key = entry.key as (string | unknown)[];
        const synthId = String(key[1]);
        await sendOrQueue(
          synthId,
          notification as unknown as Record<string, unknown>,
        );
      }
    } catch (e) {
      console.error("[CTRL-JOINED] KV synth broadcast failed:", e);
    }
  } else if (client_id.startsWith("synth-")) {
    // Register synth in KV roster with TTL and start keepalive refresh
    try {
      await kv.set(["synths", client_id], { ts: Date.now() }, {
        expireIn: 30_000,
      });
      const timerId = setInterval(async () => {
        try {
          await kv.set(["synths", client_id], { ts: Date.now() }, {
            expireIn: 30_000,
          });
        } catch (e) {
          console.error(
            `[SYNTH-KA] Failed to refresh TTL for ${client_id}:`,
            e,
          );
        }
      }, 10_000) as unknown as number;
      synthKeepAliveTimers.set(client_id, timerId);
    } catch (e) {
      console.error(
        `[SYNTH-REGISTER] Failed to register ${client_id} in KV:`,
        e,
      );
    }

    // Notify active ctrl about new synth
    const activeCtrlEntry = await kv.get(["active_ctrl"]);
    if (activeCtrlEntry && activeCtrlEntry.value) {
      const activeCtrl = activeCtrlEntry.value as KVCtrlEntry;
      const notification: SynthJoinedMessage = {
        type: "synth-joined",
        synth_id: client_id,
        timestamp: Date.now(),
      };
      const ctrlSocket = connections.get(activeCtrl.client_id)?.socket;
      if (ctrlSocket && ctrlSocket.readyState === WebSocket.OPEN) {
        ctrlSocket.send(JSON.stringify(notification));
      } else {
        await sendOrQueue(
          activeCtrl.client_id,
          notification as unknown as Record<string, unknown>,
        );
      }
    }
  }

  // Start polling for queued messages
  startPollingForClient(client_id, socket);

  return client_id;
}

/**
 * Handle WebSocket disconnection cleanup
 */
async function handleDisconnection(client_id: string): Promise<void> {
  console.log(`👋 Peer ${client_id} disconnected`);

  connections.delete(client_id);

  // Clean up synth registration
  if (client_id.startsWith("synth-")) {
    const timerId = synthKeepAliveTimers.get(client_id);
    if (timerId) {
      clearInterval(timerId);
      synthKeepAliveTimers.delete(client_id);
    }
    try {
      await kv.delete(["synths", client_id]);
    } catch (e) {
      console.error(
        `[SYNTH-CLEANUP] Failed to delete ${client_id} from KV:`,
        e,
      );
    }

    // Notify active controller about synth disconnection
    const activeCtrlEntry = await kv.get(["active_ctrl"]);
    if (activeCtrlEntry?.value) {
      const activeCtrl = activeCtrlEntry.value as KVCtrlEntry;
      const notification = {
        type: "synth-left",
        synth_id: client_id,
        timestamp: Date.now(),
      };
      await sendOrQueue(
        activeCtrl.client_id,
        notification as unknown as Record<string, unknown>,
      );
      console.log(
        `📢 Notified controller ${activeCtrl.client_id} about synth-left: ${client_id}`,
      );
    }
  }

  // Clean up controller registration
  if (client_id.startsWith("ctrl-")) {
    const activeCtrlEntry = await kv.get(["active_ctrl"]);
    if (activeCtrlEntry?.value) {
      const activeCtrl = activeCtrlEntry.value as KVCtrlEntry;
      if (activeCtrl.client_id === client_id) {
        console.log(
          `[SERVER-STATE] Active controller ${client_id} disconnected`,
        );
        await kv.delete(["active_ctrl"]);
      }
    }

    // Notify all synths about controller disconnection
    try {
      const synthEntries = kv.list({ prefix: ["synths"] });
      for await (const entry of synthEntries) {
        const key = entry.key as (string | unknown)[];
        const synthId = String(key[1]);
        const notification = {
          type: "ctrl-left",
          ctrl_id: client_id,
          timestamp: Date.now(),
        };
        await sendOrQueue(
          synthId,
          notification as unknown as Record<string, unknown>,
        );
      }
      console.log(`📢 Notified all synths about ctrl-left: ${client_id}`);
    } catch (e) {
      console.error("[CTRL-LEFT] Failed to notify synths:", e);
    }
  }
}

/**
 * Handle WebSocket upgrade request
 */
export function handleWebSocketUpgrade(request: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(request);
  const temp_id = crypto.randomUUID();
  let client_id: string = temp_id;

  socket.addEventListener("open", () => {
    connections.set(temp_id, { socket, actual_id: null });
    console.log("📡 WebSocket connection opened");
  });

  socket.addEventListener("message", async (event) => {
    const data = JSON.parse(event.data);

    // Handle client registration
    if (data.type === "register") {
      client_id = await handleRegistration(
        data as RegisterMessage,
        socket,
        temp_id,
      );
    } else {
      // Handle other messages
      await handleWebSocketMessage(client_id, event.data);
    }
  });

  socket.addEventListener("close", async () => {
    await handleDisconnection(client_id);
  });

  socket.addEventListener("error", (error) => {
    console.error(`❌ WebSocket error for ${client_id}:`, error);
  });

  return response;
}
