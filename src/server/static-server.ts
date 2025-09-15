/**
 * Simple static file server for development
 */

import { serve } from "std/http/server.ts";
import { serveDir } from "std/http/file_server.ts";
import { parse } from "std/flags/mod.ts";
import { getLocalIPs } from "./utils.ts";

const flags = parse(Deno.args, {
  default: { root: "public" },
  string: ["root"],
  number: ["port"]
});

const port = flags.port;
const root = flags.root;

const localIPs = getLocalIPs();

console.log(`📁 Static server serving ${root}/`);
console.log(`📡 Local:     http://localhost:${port}`);

if (localIPs.length > 0) {
  console.log("📱 Network:");
  localIPs.forEach(ip => {
    console.log(`   http://${ip}:${port}`);
  });
} else {
  console.log("⚠️  No network interfaces found");
}

await serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      }
    });
  }

  // Custom file serving logic
  const url = new URL(req.url);
  let response;
  
  // Check if requesting /src/common/ files
  if (url.pathname.startsWith('/src/common/')) {
    // Serve from project root (src/common/ -> ./src/common/)
    response = await serveDir(req, { fsRoot: "." });
  } else {
    // Serve from public directory
    response = await serveDir(req, { fsRoot: root });
  }
  
  // Add CORS headers to all responses
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  
  // Fix MIME type for JavaScript modules
  if (url.pathname.endsWith('.js')) {
    response.headers.set("Content-Type", "application/javascript");
  }
  
  return response;
}, { port, hostname: "0.0.0.0" });