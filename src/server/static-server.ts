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
  const url = new URL(req.url);
  const pathname = url.pathname;

  // Handle CORS preflight first
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
  
  // Intercept requests for TypeScript module files
  const tsModulePaths = [
    "/ctrl/ctrl-main.js",
    "/synth/synth-main.js"
  ];
  
  if (tsModulePaths.includes(pathname)) {
    const tsPath = `${root}${pathname.replace('.js', '.ts')}`;
    
    try {
      // Use 'deno bundle' command to transpile the TS file
      const command = new Deno.Command(Deno.execPath(), {
        args: ["bundle", tsPath],
        stdout: "piped",
        stderr: "piped",
      });
      
      const { code, stdout, stderr } = await command.output();
      
      if (code !== 0) {
        const error = new TextDecoder().decode(stderr);
        console.error(`Error bundling ${tsPath}:\n${error}`);
        return new Response(`Error bundling file: ${error}`, { status: 500 });
      }

      const compiledJs = new TextDecoder().decode(stdout);
      
      return new Response(compiledJs, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        }
      });
    } catch (e) {
      console.error(`Failed to serve ${pathname}:`, e);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // Fallback to serveDir for all other static assets
  let response;
  if (pathname.startsWith('/src/common/')) {
    response = await serveDir(req, { fsRoot: "." });
  } else {
    response = await serveDir(req, { fsRoot: root });
  }

  // Add general CORS headers
  response.headers.set("Access-Control-Allow-Origin", "*");

  return response;
}, { port, hostname: "0.0.0.0" });