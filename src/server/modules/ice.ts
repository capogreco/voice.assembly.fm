/**
 * ICE server endpoint for Voice.Assembly.FM signaling server
 */

import { load } from "std/dotenv/mod.ts";

// Load environment variables
const env = await load();

// Load Twilio credentials for TURN servers
const TWILIO_ACCOUNT_SID = env.TWILIO_ACCOUNT_SID ||
  Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = env.TWILIO_AUTH_TOKEN ||
  Deno.env.get("TWILIO_AUTH_TOKEN");

// Types for ICE server responses
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceServersResponse {
  ice_servers: IceServer[];
}

/**
 * Get TURN credentials from Twilio
 */
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

/**
 * Create fallback STUN servers response
 */
function createFallbackResponse(): IceServersResponse {
  return {
    ice_servers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };
}

/**
 * Create CORS headers for ICE servers response
 */
function createCorsHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
  };
}

/**
 * Handle ICE servers request
 */
export async function handleIceServersRequest(request: Request): Promise<Response> {
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
        headers: createCorsHeaders(),
      });
    } else {
      console.log(
        `[ICE-SERVERS] Twilio credentials failed, returning fallback STUN servers`,
      );
      const response = createFallbackResponse();
      return new Response(JSON.stringify(response), {
        headers: createCorsHeaders(),
      });
    }
  } catch (error) {
    console.error(`[ICE-SERVERS] Error processing request:`, error);
    const response = createFallbackResponse();
    return new Response(JSON.stringify(response), {
      headers: createCorsHeaders(),
    });
  }
}