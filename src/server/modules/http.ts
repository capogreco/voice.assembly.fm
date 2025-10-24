/**
 * HTTP static file serving for Voice.Assembly.FM
 * Optimized for Deno Deploy
 */

import * as path from "https://deno.land/std@0.224.0/path/mod.ts";

// For Deno Deploy, files are served from the project root
const getStaticFile = async (filePath: string): Promise<Response | null> => {
  try {
    const file = await Deno.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();

    const mimeTypes: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };

    const mimeType = mimeTypes[ext] || "application/octet-stream";

    return new Response(file, {
      headers: {
        "Content-Type": mimeType,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
};

/**
 * Handle static file serving with proper MIME types for JavaScript
 * Optimized for Deno Deploy
 * @param request - HTTP request
 * @returns Response for static files
 */
export async function handleStaticFiles(
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  console.log(`Serving static file: ${pathname}`);

  // Handle root request - serve main index.html
  if (pathname === "/") {
    const response = await getStaticFile("public/index.html");
    if (response) return response;
  }

  // Handle ctrl client
  if (pathname === "/ctrl" || pathname === "/ctrl/") {
    const response = await getStaticFile("public/ctrl/index.html");
    if (response) return response;
  }

  // Handle synth client
  if (pathname === "/synth" || pathname === "/synth/") {
    const response = await getStaticFile("public/synth/index.html");
    if (response) return response;
  }

  // Handle ctrl client files
  if (pathname.startsWith("/ctrl/")) {
    const filePath = pathname.replace("/ctrl/", "public/ctrl/");
    const response = await getStaticFile(filePath);
    if (response) return response;
  }

  // Handle synth client files
  if (pathname.startsWith("/synth/")) {
    const filePath = pathname.replace("/synth/", "public/synth/");
    const response = await getStaticFile(filePath);
    if (response) return response;
  }

  // Handle src/ directory for common modules
  if (pathname.startsWith("/src/")) {
    const filePath = pathname.replace("/src/", "src/");
    const response = await getStaticFile(filePath);
    if (response) return response;
  }

  // Handle public files
  if (pathname.startsWith("/public/")) {
    const filePath = pathname.replace("/public/", "public/");
    const response = await getStaticFile(filePath);
    if (response) return response;
  }

  // Try to serve from public directory
  const publicPath = `public${pathname}`;
  const response = await getStaticFile(publicPath);
  if (response) return response;

  return null;
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
