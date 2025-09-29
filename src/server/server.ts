/**
 * Voice.Assembly.FM Simplified Signaling Server
 * Based on string.assembly.fm pattern - ctrl-centric with KV registry
 */

import { serveDir } from "std/http/file_server.ts";
import { load } from "std/dotenv/mod.ts";
import { getLocalIPs } from "./utils.ts";

// Load environment variables from .env file
const env = await load();

const port = parseInt(env.PORT || Deno.env.get("PORT") || "3456");

// Load Twilio credentials for TURN servers
const TWILIO_ACCOUNT_SID = env.TWILIO_ACCOUNT_SID ||
  Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = env.TWILIO_AUTH_TOKEN ||
  Deno.env.get("TWILIO_AUTH_TOKEN");

// Types for ICE server responses
interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface IceServersResponse {
  ice_servers: IceServer[];
}

// Get TURN credentials from Twilio
async function getTurnCredentials(
  requestSource = "unknown",
): Promise<IceServer[] | null> {
  console.log(
    `[TURN] ${requestSource} - Environment check - TWILIO_ACCOUNT_SID: ${
      TWILIO_ACCOUNT_SID ? "SET" : "MISSING"
    }`,
  );
  console.log(
    `[TURN] ${requestSource} - Environment check - TWILIO_AUTH_TOKEN: ${
      TWILIO_AUTH_TOKEN ? "SET" : "MISSING"
    }`,
  );

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error(
      `[TURN] ${requestSource} - Missing Twilio credentials - SID: ${!!TWILIO_ACCOUNT_SID}, Token: ${!!TWILIO_AUTH_TOKEN}`,
    );
    return null;
  }

  try {
    const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
    const url =
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Tokens.json`;

    console.log(
      `[TURN] ${requestSource} - Making request to Twilio API: ${url}`,
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    console.log(
      `[TURN] ${requestSource} - Twilio API response status: ${response.status} ${response.statusText}`,
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[TURN] ${requestSource} - Twilio API error - Status: ${response.status}, Response: ${errorText}`,
      );
      return null;
    }

    const data = await response.json();
    console.log(
      `[TURN] ${requestSource} - Successfully fetched ${
        data.ice_servers?.length || 0
      } ICE servers from Twilio`,
    );
    return data.ice_servers;
  } catch (error) {
    console.error(
      `[TURN] ${requestSource} - Error fetching TURN credentials:`,
      error,
    );
    return null;
  }
}

interface ConnectionInfo {
  socket: WebSocket;
  actual_id: string | null;
}

interface KVCtrlEntry {
  client_id: string;
  timestamp: number;
  ws_id: string;
}

interface BaseMessage {
  type: string;
  source?: string;
  target?: string;
  sender_id?: string;
  timestamp?: number;
}

interface RegisterMessage extends BaseMessage {
  type: "register";
  client_id: string;
  force_takeover?: boolean;
}

interface RequestCtrlsMessage extends BaseMessage {
  type: "request-ctrls";
}

interface CtrlsListMessage extends BaseMessage {
  type: "ctrls-list";
  ctrls: string[];
}

interface CtrlJoinedMessage extends BaseMessage {
  type: "ctrl-joined";
  ctrl_id: string;
}

interface CtrlLeftMessage extends BaseMessage {
  type: "ctrl-left";
  ctrl_id: string;
}

interface SynthJoinedMessage extends BaseMessage {
  type: "synth-joined";
  synth_id: string;
}

interface SynthLeftMessage extends BaseMessage {
  type: "synth-left";
  synth_id: string;
}

interface RequestSynthsMessage extends BaseMessage {
  type: "request-synths";
}

interface SynthsListMessage extends BaseMessage {
  type: "synths-list";
  synths: string[];
}

interface SignalingMessage extends BaseMessage {
  type: "offer" | "answer" | "ice-candidate";
  data: any;
  targetPeerId: string;
}

type Message =
  | RegisterMessage
  | RequestCtrlsMessage
  | CtrlsListMessage
  | CtrlJoinedMessage
  | CtrlLeftMessage
  | SynthJoinedMessage
  | SynthLeftMessage
  | RequestSynthsMessage
  | SynthsListMessage
  | SignalingMessage
  | BaseMessage;

const kv = await Deno.openKv();
const connections = new Map<string, ConnectionInfo>();

console.log(`🎵 Voice.Assembly.FM Simplified Signaling Server starting...`);

// Cleanup stale KV entries on startup
async function cleanupKVOnStartup() {
  console.log("🧹 Cleaning up stale KV entries...");

  try {
    // Clean up old messages
    const messageEntries = kv.list({ prefix: ["messages"] });
    let messageCount = 0;
    for await (const entry of messageEntries) {
      await kv.delete(entry.key);
      messageCount++;
    }
    console.log(`🧹 Cleaned up ${messageCount} stale message entries`);

    // Clean up old ctrl entries
    const ctrlEntries = kv.list({ prefix: ["ctrls"] });
    let ctrlCount = 0;
    for await (const entry of ctrlEntries) {
      await kv.delete(entry.key);
      ctrlCount++;
    }
    console.log(`🧹 Cleaned up ${ctrlCount} stale ctrl entries`);
  } catch (error) {
    console.error("🧹 Error cleaning up KV entries:", error);
  }
}

// Helper function to send message directly or queue for cross-edge delivery
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

// Handle WebSocket messages and queue them in KV
async function handleWebSocketMessage(
  sender_id: string,
  data: string,
): Promise<void> {
  try {
    const message: Message = JSON.parse(data);
    message.sender_id = sender_id;
    message.timestamp = Date.now();

    console.log(`📨 Message from ${sender_id}: ${message.type}`);

    // Handle synth requesting ctrl list - now returns single active controller
    if (message.type === "request-ctrls") {
      const ctrlsList = [];
      const activeCtrlEntry = await kv.get(["active_ctrl"]);
      console.log(`[SERVER-STATE] SYNTH REQUEST from ${sender_id}. Active controller in DB is: ${(activeCtrlEntry?.value as KVCtrlEntry)?.client_id ?? 'null'}`);

      if (activeCtrlEntry && activeCtrlEntry.value) {
        const activeCtrl = activeCtrlEntry.value as KVCtrlEntry;

        // Check if the active ctrl is still connected locally
        const isConnected = connections.has(activeCtrl.client_id) &&
          connections.get(activeCtrl.client_id)?.socket.readyState ===
            WebSocket.OPEN;

        if (isConnected) {
          ctrlsList.push(activeCtrl.client_id);
        } else {
          // Clean up stale active ctrl entry
          await kv.delete(["active_ctrl"]);
        }
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

    // Handle ctrl requesting synth list
    if (message.type === "request-synths") {
      const synthsList = [];
      
      // Find all connected synths
      for (const [id, conn] of connections.entries()) {
        if (id.startsWith("synth-") && conn.socket.readyState === WebSocket.OPEN) {
          synthsList.push(id);
        }
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

      await sendOrQueue((message as any).target, message as unknown as Record<string, unknown>, 30 * 1000);
    }
  } catch (error) {
    console.error(`❌ Error handling message: ${error}`);
  }
}

// Poll KV for messages destined to this client
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

    // Poll every 100ms (faster than before for better signaling performance)
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`🔄 Stopped polling for client: ${client_id}`);
}

// Handle HTTP requests
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  console.log(
    `[${new Date().toISOString()}] [${request.method}] ${url.pathname}`,
  );

  // Handle CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type",
      },
    });
  }

  // WebSocket upgrade (only on /ws path)
  if (
    request.headers.get("upgrade") === "websocket" && url.pathname === "/ws"
  ) {
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
        const regMessage = data as RegisterMessage;
        const old_id = client_id;
        client_id = regMessage.client_id;

        console.log(`✅ Peer ${client_id} registering...`);

        connections.delete(old_id);
        connections.set(client_id, { socket, actual_id: client_id });

        // --- SINGLE CONTROLLER TAKEOVER LOGIC ---
        if (client_id.startsWith("ctrl-")) {
          // --- BEGIN NEW, SIMPLIFIED CONTROLLER REGISTRATION LOGIC ---
          const oldCtrlEntry = await kv.get(["active_ctrl"]);
          const oldCtrl = oldCtrlEntry?.value as (KVCtrlEntry | null);
          console.log(`[SERVER-STATE] REGISTRATION from ${client_id}. Current active_ctrl in DB is: ${oldCtrl?.client_id ?? 'null'}`);

          // The new controller registering should ALWAYS become the active one.
          // This is the most robust way to handle the refresh race condition.
          // If there was an old controller, we will kick it to be safe.
          if (oldCtrl && oldCtrl.client_id !== client_id) {
            const oldCtrlSocket = connections.get(oldCtrl.client_id)?.socket;
            if (oldCtrlSocket?.readyState === WebSocket.OPEN) {
              console.log(`[SERVER-STATE] Kicking stale controller ${oldCtrl.client_id} due to new registration from ${client_id}.`);
              oldCtrlSocket.send(JSON.stringify({ type: "kicked", reason: "A new controller has connected." }));
            }
          }
          
          // Set shouldBecomeActive to true to trigger the synth notifications below.
          const shouldBecomeActive = true;
          // --- END NEW LOGIC ---

          if (shouldBecomeActive) {
            // Set the new controller as the active one
            const value: KVCtrlEntry = {
              client_id: client_id,
              timestamp: Date.now(),
              ws_id: temp_id,
            };
            console.log(`[SERVER-STATE] Setting active_ctrl in DB to: ${client_id}`);
            await kv.set(["active_ctrl"], value);
            console.log(`👑 ${client_id} is now the active controller`);

            // --- BEGIN FINAL FIX ---
            // Immediately send the new controller a list of all current synths.
            const synthsList = [];
            for (const [id, conn] of connections.entries()) {
              if (id.startsWith("synth-") && conn.socket.readyState === WebSocket.OPEN) {
                synthsList.push(id);
              }
            }

            if (synthsList.length > 0) {
              console.log(`[SERVER-STATE] Proactively sending synth list to new controller ${client_id}:`, synthsList);
              const notification: SynthsListMessage = {
                type: "synths-list",
                synths: synthsList,
                timestamp: Date.now(),
              };
              socket.send(JSON.stringify(notification)); // Send to the new controller's socket
            }
            // --- END FINAL FIX ---

            // Notify all synths about the new (or re-confirmed) active controller
            const notification: CtrlJoinedMessage = {
              type: "ctrl-joined",
              ctrl_id: client_id,
              timestamp: Date.now(),
            };

            for (const [conn_id, conn_info] of connections) {
              if (
                conn_id.startsWith("synth-") &&
                conn_info.socket.readyState === WebSocket.OPEN
              ) {
                conn_info.socket.send(JSON.stringify(notification));
              }
            }
          }
        } else if (client_id.startsWith("synth-")) {
          // Notify active ctrl about new synth
          const activeCtrlEntry = await kv.get(["active_ctrl"]);
          if (activeCtrlEntry && activeCtrlEntry.value) {
            const activeCtrl = activeCtrlEntry.value as KVCtrlEntry;
            const ctrlSocket = connections.get(activeCtrl.client_id)?.socket;

            if (ctrlSocket && ctrlSocket.readyState === WebSocket.OPEN) {
              const notification: SynthJoinedMessage = {
                type: "synth-joined",
                synth_id: client_id,
                timestamp: Date.now(),
              };
              ctrlSocket.send(JSON.stringify(notification));
            }
          }
        }
        // --- END OF TAKEOVER LOGIC ---

        startPollingForClient(client_id, socket);
        return;
      }

      // Only handle non-registration messages if client has registered
      if (client_id && client_id !== temp_id) {
        await handleWebSocketMessage(client_id, event.data);
      } else {
        console.log(
          `📨 Ignoring message from unregistered client ${temp_id}: ${data.type}`,
        );
      }
    });

    socket.addEventListener("close", async () => {
      console.log(`🔌 Client ${client_id} disconnected`);
      connections.delete(client_id);

      // Clean up KV messages for this client
      if (client_id && client_id !== temp_id) {
        const entries = kv.list({ prefix: ["messages", client_id] });
        for await (const entry of entries) {
          await kv.delete(entry.key);
        }
      }

      // If this was the active ctrl, remove from KV and notify synths
      if (client_id && client_id.startsWith("ctrl-")) {
        const activeCtrlEntry = await kv.get(["active_ctrl"]);
        if (activeCtrlEntry && activeCtrlEntry.value) {
          const activeCtrl = activeCtrlEntry.value as KVCtrlEntry;
          if (activeCtrl.client_id === client_id) {
            console.log(`[SERVER-STATE] Disconnected client ${client_id} was the active controller. Deleting active_ctrl from DB.`);
            await kv.delete(["active_ctrl"]);
            console.log(`👑 Active controller ${client_id} disconnected`);

            // Notify synths that the controller left
            const notification: CtrlLeftMessage = {
              type: "ctrl-left",
              ctrl_id: client_id,
              timestamp: Date.now(),
            };

            for (const [conn_id, conn_info] of connections) {
              if (
                conn_id.startsWith("synth-") &&
                conn_info.socket.readyState === WebSocket.OPEN
              ) {
                conn_info.socket.send(JSON.stringify(notification));
              }
            }
          }
        }
      }

      // If this was a synth, notify the active ctrl about synth leaving
      if (client_id && client_id.startsWith("synth-")) {
        const activeCtrlEntry = await kv.get(["active_ctrl"]);
        if (activeCtrlEntry && activeCtrlEntry.value) {
          const activeCtrl = activeCtrlEntry.value as KVCtrlEntry;
          const ctrlSocket = connections.get(activeCtrl.client_id)?.socket;

          if (ctrlSocket && ctrlSocket.readyState === WebSocket.OPEN) {
            const notification: SynthLeftMessage = {
              type: "synth-left",
              synth_id: client_id,
              timestamp: Date.now(),
            };
            ctrlSocket.send(JSON.stringify(notification));
          }
        }
      }
    });

    return response;
  }

  // Handle ICE servers request for TURN credentials
  if (url.pathname === "/ice-servers") {
    console.log(
      `[ICE-SERVERS] Request received from ${
        request.headers.get("user-agent")
      }`,
    );

    try {
      const iceServers = await getTurnCredentials("voice-assembly-fm");

      if (iceServers) {
        console.log(
          `[ICE-SERVERS] Returning ${iceServers.length} ICE servers from Twilio`,
        );
        const response: IceServersResponse = { ice_servers: iceServers };
        return new Response(JSON.stringify(response), {
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "Content-Type",
          },
        });
      } else {
        console.log(
          `[ICE-SERVERS] Twilio credentials failed, returning fallback STUN servers`,
        );
        const response: IceServersResponse = {
          ice_servers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
          ],
        };
        return new Response(JSON.stringify(response), {
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "Content-Type",
          },
        });
      }
    } catch (error) {
      console.error(`[ICE-SERVERS] Error processing request:`, error);
      const response: IceServersResponse = {
        ice_servers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      };
      return new Response(JSON.stringify(response), {
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Content-Type",
        },
      });
    }
  }

  // Use serveDir with urlRoot mapping to handle different directories
  let response;

  if (url.pathname === "/") {
    response = new Response(null, {
      status: 302,
      headers: { "Location": "/synth/" },
    });
  } else if (url.pathname === "/ctrl/" || url.pathname === "/ctrl") {
    response = new Response(null, {
      status: 302,
      headers: { "Location": "/ctrl/index.html" },
    });
  } else if (url.pathname === "/synth/" || url.pathname === "/synth") {
    response = new Response(null, {
      status: 302,
      headers: { "Location": "/synth/index.html" },
    });
  } else if (url.pathname.startsWith("/src/")) {
    // Serve from project root for src files
    response = await serveDir(request, {
      fsRoot: ".",
      headers: ["access-control-allow-origin: *"],
    });
  } else if (url.pathname.startsWith("/worklets/")) {
    // Serve worklets from public directories
    response = await serveDir(request, {
      fsRoot: "./public",
      headers: ["access-control-allow-origin: *"],
    });
  } else {
    // Serve everything else from public
    response = await serveDir(request, {
      fsRoot: "./public",
      headers: ["access-control-allow-origin: *"],
    });
  }

  // --- BEGIN MIME TYPE FIX ---
  // Ensure that all .js files are served with the correct MIME type.
  if (url.pathname.endsWith(".js")) {
    response.headers.set("Content-Type", "application/javascript; charset=utf-8");
  }
  // --- END MIME TYPE FIX ---

  return response;
}

// Startup
await cleanupKVOnStartup();

const localIPs = getLocalIPs();
console.log("🌐 Voice.Assembly.FM Simplified Server");
console.log("======================================");
console.log(`📡 Local:     http://localhost:${port}`);

if (localIPs.length > 0) {
  console.log("📱 Network:");
  localIPs.forEach((ip) => {
    console.log(`   http://${ip}:${port}`);
  });
}

console.log("🎯 Quick Access:");
console.log(`   Ctrl Client:  http://localhost:${port}/ctrl/`);
console.log(`   Synth Client: http://localhost:${port}/synth/`);
console.log(`   WebSocket:    ws://localhost:${port}/ws`);

if (localIPs.length > 0) {
  console.log("📱 Network Access:");
  localIPs.forEach((ip) => {
    console.log(`   Ctrl:  http://${ip}:${port}/ctrl/`);
    console.log(`   Synth: http://${ip}:${port}/synth/`);
  });
}

console.log("🎤 Simplified Pattern:");
console.log("1. Ctrl registers → KV entry created");
console.log("2. Synths request-ctrls → get list");
console.log("3. Synths initiate WebRTC to ctrls");

Deno.serve({ port, hostname: "0.0.0.0" }, handleRequest);
