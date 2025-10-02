/**
 * Voice.Assembly.FM Simplified Signaling Server
 * Main entry point - combines all server modules
 */

import { load } from "std/dotenv/mod.ts";
import { getLocalIPs } from "./utils.ts";
import { handleStaticFiles, createErrorResponse, createCorsResponse } from "./modules/http.ts";
import { handleWebSocketUpgrade } from "./modules/ws.ts";
import { handleIceServersRequest } from "./modules/ice.ts";
import { cleanupKVOnStartup } from "./modules/kv.ts";

// Load environment variables from .env file
const env = await load();

const port = parseInt(env.PORT || Deno.env.get("PORT") || "3456");

console.log(`🎵 Voice.Assembly.FM Simplified Signaling Server starting...`);

// Cleanup stale KV entries on startup
await cleanupKVOnStartup();

/**
 * Handle HTTP requests
 */
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  console.log(
    `[${new Date().toISOString()}] [${request.method}] ${url.pathname}`,
  );

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return createCorsResponse();
  }

  // WebSocket upgrade (only on /ws path)
  if (
    request.headers.get("upgrade") === "websocket" && url.pathname === "/ws"
  ) {
    return handleWebSocketUpgrade(request);
  }

  // Handle ICE servers request for TURN credentials
  if (url.pathname === "/ice-servers") {
    return await handleIceServersRequest(request);
  }

  // Handle static files
  try {
    return await handleStaticFiles(request);
  } catch (error) {
    console.error("❌ Error serving static files:", error);
    return createErrorResponse(500, "Internal server error");
  }
}

// Start the server
console.log(`🚀 Starting server on port ${port}...`);

Deno.serve({
  port: port,
  handler: handleRequest,
}, () => {
  console.log(`✅ Server running on:`);
  console.log(`   Local:    http://localhost:${port}`);
  
  const localIPs = getLocalIPs();
  for (const ip of localIPs) {
    console.log(`   Network:  http://${ip}:${port}`);
  }
  
  console.log(`\n🎵 Voice.Assembly.FM is ready!`);
  console.log(`   Control:  http://localhost:${port}/ctrl`);
  console.log(`   Synth:    http://localhost:${port}/synth`);
});