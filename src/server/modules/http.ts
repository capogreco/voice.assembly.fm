/**
 * HTTP static file serving for Voice.Assembly.FM
 */

import { serveDir } from "std/http/file_server.ts";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";

// Define project root directory based on script location
const __dirname = path.dirname(path.fromFileUrl(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..", "..", ".."); // Navigate from src/server/modules up to project root

/**
 * Handle static file serving with proper MIME types for JavaScript
 * @param request - HTTP request
 * @returns Response for static files
 */
export async function handleStaticFiles(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Handle root request
  if (pathname === "/") {
    return serveDir(request, {
      fsRoot: path.join(ROOT_DIR, "public"),
      urlRoot: "",
      showDirListing: false,
      enableCors: true,
    });
  }

  // Handle ctrl client
  if (pathname === "/ctrl" || pathname.startsWith("/ctrl/")) {
    return serveDir(request, {
      fsRoot: path.join(ROOT_DIR, "public", "ctrl"),
      urlRoot: "ctrl",
      showDirListing: false,
      enableCors: true,
    });
  }

  // Handle synth client
  if (pathname === "/synth" || pathname.startsWith("/synth/")) {
    return serveDir(request, {
      fsRoot: path.join(ROOT_DIR, "public", "synth"),
      urlRoot: "synth",
      showDirListing: false,
      enableCors: true,
    });
  }

  // Handle src/ directory for common modules
  if (pathname.startsWith("/src/")) {
    const response = await serveDir(request, {
      fsRoot: path.join(ROOT_DIR, "src"),
      urlRoot: "src",
      showDirListing: false,
      enableCors: true,
    });

    // Fix MIME type for .js files served from /src/
    if (pathname.endsWith(".js")) {
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "application/javascript");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return response;
  }

  // Handle all other static files from public directory
  return serveDir(request, {
    fsRoot: path.join(ROOT_DIR, "public"),
    urlRoot: "",
    showDirListing: false,
    enableCors: true,
  });
}

/**
 * Create basic HTTP error response
 * @param status - HTTP status code
 * @param message - Error message
 * @returns Error response
 */
export function createErrorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: message }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    },
  );
}

/**
 * Create CORS preflight response
 * @returns CORS response
 */
export function createCorsResponse(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}