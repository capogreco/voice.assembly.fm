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

// Load environment variables from .env file (if available locally)
let env: Record<string, string> = {};
try {
  env = await load();
} catch {
  // .env file not available (normal in Deno Deploy)
  console.log("No .env file found, using environment variables");
}

// Deno Deploy automatically provides PORT, fallback for local development
const port = parseInt(Deno.env.get("PORT") || env.PORT || "3456");

console.log(`🎵 Voice.Assembly.FM Simplified Signaling Server starting...`);

// Cleanup stale KV entries on startup
await cleanupKVOnStartup();

/**
 * Handle HTTP requests
 */
async function handleRequest(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);

    console.log(
      `[${new Date().toISOString()}] [${request.method}] ${url.pathname}`,
    );

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      console.log("Returning CORS response");
      return createCorsResponse();
    }

    // WebSocket upgrade (only on /ws path)
    if (
      request.headers.get("upgrade") === "websocket" && url.pathname === "/ws"
    ) {
      console.log("Handling WebSocket upgrade");
      return handleWebSocketUpgrade(request);
    }

    // Handle ICE servers request for TURN credentials
    if (url.pathname === "/ice-servers") {
      console.log("Handling ICE servers request");
      return await handleIceServersRequest(request);
    }

    // Handle static files
    console.log("Calling handleStaticFiles for:", url.pathname);
    const response = await handleStaticFiles(request);
    console.log("handleStaticFiles returned:", !!response, response?.status);
    
    if (response) {
      console.log("Returning response with status:", response.status);
      return response;
    }
    
    // If no static file found, return 404
    console.error("❌ No static file found for:", url.pathname);
    return createErrorResponse(404, "Not found");

  } catch (error) {
    console.error("❌ Error in handleRequest:", error);
    return createErrorResponse(500, "Internal server error");
  }
}

// Start the server
console.log(`🚀 Starting server on port ${port}...`);

// For Deno Deploy, port is automatically configured
const serveOptions = Deno.env.get("DENO_DEPLOYMENT_ID") 
  ? {} // Let Deno Deploy handle port assignment
  : { port: port }; // Use specified port for local development

const server = Deno.serve(serveOptions, async (request: Request): Promise<Response> => {
  console.log("Handler called for:", request.url);
  try {
    const result = await handleRequest(request);
    console.log("Handler returning:", !!result, result?.status);
    return result;
  } catch (error) {
    console.error("Handler error:", error);
    return createErrorResponse(500, "Handler error");
  }
});

if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
  console.log(`✅ Server running on Deno Deploy`);
  console.log(`🎵 Voice.Assembly.FM is ready!`);
} else {
  console.log(`✅ Server running on:`);
  console.log(`   Local:    http://localhost:${port}`);
  
  const localIPs = getLocalIPs();
  for (const ip of localIPs) {
    console.log(`   Network:  http://${ip}:${port}`);
  }
  
  console.log(`\n🎵 Voice.Assembly.FM is ready!`);
  console.log(`   Control:  http://localhost:${port}/ctrl`);
  console.log(`   Synth:    http://localhost:${port}/synth`);
}