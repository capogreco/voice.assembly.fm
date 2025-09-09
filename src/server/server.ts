/**
 * Voice.Assembly.FM Simplified Signaling Server
 * Based on string.assembly.fm pattern - ctrl-centric with KV registry
 */

import { serveDir } from "std/http/file_server.ts";
import { STATUS_CODE } from "std/http/status.ts";

const port = parseInt(Deno.env.get("PORT") || "3456");

interface ConnectionInfo {
  socket: WebSocket;
  actual_id: string | null;
}

interface KVCtrlEntry {
  timestamp: number;
  ws_id: string;
  roomId: string;
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
  roomId?: string;
}

interface RequestCtrlsMessage extends BaseMessage {
  type: "request-ctrls";
  roomId: string;
}

interface CtrlsListMessage extends BaseMessage {
  type: "ctrls-list";
  ctrls: string[];
}

interface CtrlJoinedMessage extends BaseMessage {
  type: "ctrl-joined";
  ctrl_id: string;
  roomId: string;
}

interface CtrlLeftMessage extends BaseMessage {
  type: "ctrl-left";
  ctrl_id: string;
  roomId: string;
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
  | SignalingMessage
  | BaseMessage;

const kv = await Deno.openKv();
const connections = new Map<string, ConnectionInfo>();

console.log(`🎵 Voice.Assembly.FM Simplified Signaling Server starting...`);

// Cleanup stale KV entries on startup
async function cleanupKVOnStartup() {
  console.log('🧹 Cleaning up stale KV entries...');
  
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
    console.error('🧹 Error cleaning up KV entries:', error);
  }
}

// Handle WebSocket messages and queue them in KV
async function handleWebSocketMessage(sender_id: string, data: string): Promise<void> {
  try {
    const message: Message = JSON.parse(data);
    message.sender_id = sender_id;
    message.timestamp = Date.now();

    console.log(`📨 Message from ${sender_id}: ${message.type}`);

    // Handle synth requesting ctrl list
    if (message.type === "request-ctrls") {
      const reqMessage = message as RequestCtrlsMessage;
      const ctrlsList = [];
      const entries = kv.list({ prefix: ["ctrls", reqMessage.roomId] });

      for await (const entry of entries) {
        const ctrl_id = entry.key[2] as string;
        const ctrlData = entry.value as KVCtrlEntry;

        // Check if this ctrl is still connected locally
        const isConnected = connections.has(ctrl_id) && 
                           connections.get(ctrl_id)?.socket.readyState === WebSocket.OPEN;

        if (isConnected) {
          ctrlsList.push(ctrl_id);
        } else {
          // Clean up stale KV entry
          await kv.delete(entry.key);
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

    // Handle signaling messages (offer, answer, ice-candidate)
    if (['offer', 'answer', 'ice-candidate'].includes(message.type)) {
      const sigMessage = message as SignalingMessage;
      const targetPeer = connections.get(sigMessage.targetPeerId);
      
      if (targetPeer?.socket.readyState === WebSocket.OPEN) {
        // Target is connected locally - relay directly
        targetPeer.socket.send(JSON.stringify({
          ...sigMessage,
          fromPeerId: sender_id
        }));
        console.log(`📤 Relayed ${message.type} from ${sender_id} to ${sigMessage.targetPeerId} (local)`);
      } else {
        // Queue message for cross-edge delivery
        const key = ["messages", sigMessage.targetPeerId, crypto.randomUUID()];
        await kv.set(key, {
          ...sigMessage,
          fromPeerId: sender_id
        }, { expireIn: 10 * 1000 }); // 10 second TTL
        console.log(`📤 Queued ${message.type} from ${sender_id} to ${sigMessage.targetPeerId} (cross-edge)`);
      }
      return;
    }

    // All other messages with targets get queued
    if ((message as any).target) {
      const key = ["messages", (message as any).target, crypto.randomUUID()];
      await kv.set(key, message, { expireIn: 30 * 1000 });
      console.log(`📤 Queued ${message.type} from ${sender_id} to ${(message as any).target}`);
    }

  } catch (error) {
    console.error(`❌ Error handling message: ${error}`);
  }
}

// Poll KV for messages destined to this client
async function startPollingForClient(client_id: string, socket: WebSocket): Promise<void> {
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
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log(`🔄 Stopped polling for client: ${client_id}`);
}

// Handle HTTP requests
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  
  console.log(`[${new Date().toISOString()}] [${request.method}] ${url.pathname}`);

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

  // WebSocket upgrade
  if (request.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(request);
    const temp_id = crypto.randomUUID();
    let client_id = temp_id;

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
        const roomId = regMessage.roomId || "voice-assembly-default";
        
        console.log(`✅ Peer ${client_id} registered in room ${roomId}`);
        
        connections.delete(old_id);
        connections.set(client_id, { socket, actual_id: client_id });

        // If this is a ctrl, add to KV registry
        if (client_id.startsWith("ctrl-")) {
          const key = ["ctrls", roomId, client_id];
          const value: KVCtrlEntry = {
            timestamp: Date.now(),
            ws_id: temp_id,
            roomId: roomId
          };
          await kv.set(key, value, { expireIn: 60 * 1000 }); // 60 second TTL

          // Notify all synths in this room about new ctrl
          const notification: CtrlJoinedMessage = {
            type: "ctrl-joined",
            ctrl_id: client_id,
            roomId: roomId,
            timestamp: Date.now(),
          };

          for (const [conn_id, conn_info] of connections) {
            if (conn_id.startsWith("synth-") && conn_info.socket.readyState === WebSocket.OPEN) {
              // Simple approach: notify all synths (they'll filter by room client-side if needed)
              conn_info.socket.send(JSON.stringify(notification));
            }
          }
        }

        startPollingForClient(client_id, socket);
        return;
      }

      // Only handle non-registration messages if client has registered
      if (client_id && client_id !== temp_id) {
        await handleWebSocketMessage(client_id, event.data);
      } else {
        console.log(`📨 Ignoring message from unregistered client ${temp_id}: ${data.type}`);
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

      // If this was a ctrl, remove from KV registry and notify synths
      if (client_id && client_id.startsWith("ctrl-")) {
        // Find and delete ctrl entries (we don't know the room, so check all)
        const ctrlEntries = kv.list({ prefix: ["ctrls"] });
        for await (const entry of ctrlEntries) {
          if (entry.key[2] === client_id) {
            const roomId = entry.key[1] as string;
            await kv.delete(entry.key);

            // Notify synths about ctrl leaving
            const notification: CtrlLeftMessage = {
              type: "ctrl-left", 
              ctrl_id: client_id,
              roomId: roomId,
              timestamp: Date.now(),
            };

            for (const [conn_id, conn_info] of connections) {
              if (conn_id.startsWith("synth-") && conn_info.socket.readyState === WebSocket.OPEN) {
                conn_info.socket.send(JSON.stringify(notification));
              }
            }
          }
        }
      }
      
      // If this was a synth, notify all ctrl clients about synth leaving
      if (client_id && client_id.startsWith("synth-")) {
        const notification = {
          type: "synth-left",
          synth_id: client_id,
          timestamp: Date.now(),
        };

        for (const [conn_id, conn_info] of connections) {
          if (conn_id.startsWith("ctrl-") && conn_info.socket.readyState === WebSocket.OPEN) {
            conn_info.socket.send(JSON.stringify(notification));
          }
        }
      }
    });

    return response;
  }

  // Serve static files
  let fsPathRoot = "./public";
  let requestedPath = url.pathname;

  // Handle route aliases and default document
  if (requestedPath === "/") {
    requestedPath = "/index.html";
  } else if (requestedPath === "/ctrl/" || requestedPath === "/ctrl") {
    requestedPath = "/ctrl/index.html";
  } else if (requestedPath === "/synth/" || requestedPath === "/synth") {
    requestedPath = "/synth/index.html";
  }

  let fullFsPath;
  if (requestedPath.startsWith("/src/") || requestedPath.startsWith("/worklets/")) {
    fullFsPath = `.${requestedPath}`;
  } else {
    fullFsPath = `${fsPathRoot}${requestedPath}`;
  }

  try {
    const file = await Deno.readFile(fullFsPath);
    const contentType = requestedPath.endsWith(".html") ? "text/html"
      : requestedPath.endsWith(".js") ? "application/javascript" 
      : requestedPath.endsWith(".css") ? "text/css"
      : requestedPath.endsWith(".ico") ? "image/x-icon"
      : "application/octet-stream";

    return new Response(file, { headers: { "content-type": contentType } });
  } catch (e) {
    return new Response("not found", { status: 404 });
  }
}

function getLocalIPs(): string[] {
  // Simplified - would need proper network interface detection for production
  return ["192.168.1.136"]; // Placeholder
}

// Startup
await cleanupKVOnStartup();

const localIPs = getLocalIPs();
console.log("🌐 Voice.Assembly.FM Simplified Server");
console.log("======================================");
console.log(`📡 Local:     http://localhost:${port}`);

if (localIPs.length > 0) {
  console.log("📱 Network:");
  localIPs.forEach(ip => {
    console.log(`   http://${ip}:${port}`);
  });
}

console.log("🎯 Quick Access:");
console.log(`   Ctrl Client:  http://localhost:${port}/ctrl/`);
console.log(`   Synth Client: http://localhost:${port}/synth/`);
console.log(`   WebSocket:    ws://localhost:${port}/ws`);

if (localIPs.length > 0) {
  console.log("📱 Network Access:");
  localIPs.forEach(ip => {
    console.log(`   Ctrl:  http://${ip}:${port}/ctrl/`);
    console.log(`   Synth: http://${ip}:${port}/synth/`);
  });
}

console.log("🎤 Simplified Pattern:");
console.log("1. Ctrl registers → KV entry created");
console.log("2. Synths request-ctrls → get list");  
console.log("3. Synths initiate WebRTC to ctrls");

Deno.serve({ port, hostname: "0.0.0.0" }, handleRequest);