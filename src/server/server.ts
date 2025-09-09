/**
 * Voice.Assembly.FM Consolidated Server
 * Combines signaling server and static file serving in one process
 */

import { serve } from "std/http/server.ts";
import { serveDir } from "std/http/file_server.ts";
import { STATUS_CODE } from "std/http/status.ts";

interface Peer {
  id: string;
  type: 'ctrl' | 'synth';
  socket: WebSocket;
  connectedAt: number;
}

class SignalingServer {
  private peers = new Map<string, Peer>();
  private rooms = new Map<string, Set<string>>(); // roomId -> Set of peerIds

  constructor() {
    console.log("🎵 Voice.Assembly.FM Signaling Server starting...");
  }

  handleWebSocket(socket: WebSocket) {
    let currentPeer: Peer | null = null;

    socket.addEventListener('open', () => {
      console.log('📡 WebSocket connection opened');
    });

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        const result = this.handleMessage(socket, message, currentPeer);
        if (result) {
          currentPeer = result;
        }
      } catch (error) {
        console.error('❌ Invalid message format:', error);
        this.sendError(socket, 'Invalid message format');
      }
    });

    socket.addEventListener('close', () => {
      if (currentPeer) {
        console.log(`🔌 Peer ${currentPeer.id} (${currentPeer.type}) disconnected`);
        this.removePeer(currentPeer.id);
      }
    });

    socket.addEventListener('error', (error) => {
      console.error('❌ WebSocket error:', error);
      if (currentPeer) {
        this.removePeer(currentPeer.id);
      }
    });
  }

  private handleMessage(socket: WebSocket, message: any, currentPeer: Peer | null): Peer | null {
    switch (message.type) {
      case 'join':
        return this.handleJoin(socket, message);
      
      case 'offer':
      case 'answer':  
      case 'ice-candidate':
        this.relaySignalingMessage(message, currentPeer);
        return currentPeer;
      
      case 'request-peers':
        this.sendPeerList(socket, message.roomId);
        return currentPeer;

      default:
        console.warn('⚠️ Unknown message type:', message.type);
        this.sendError(socket, 'Unknown message type');
        return currentPeer;
    }
  }

  private handleJoin(socket: WebSocket, message: any): Peer {
    const { peerId, peerType, roomId, forceTakeover } = message;
    
    if (!peerId || !peerType || !roomId) {
      this.sendError(socket, 'Missing required fields: peerId, peerType, roomId');
      return null;
    }

    if (this.peers.has(peerId)) {
      this.sendError(socket, 'Peer ID already exists');
      return null;
    }

    // Check if room already has a ctrl client
    if (peerType === 'ctrl') {
      const existingCtrlPeers = this.getPeersByType(roomId, 'ctrl');
      
      if (existingCtrlPeers.length > 0) {
        if (forceTakeover) {
          // Force takeover: kick existing ctrl client
          console.log(`⚠️ Force takeover: Kicking existing ctrl ${existingCtrlPeers[0].id} for new ctrl ${peerId}`);
          
          // Send kicked message to existing ctrl
          this.sendMessage(existingCtrlPeers[0].socket, {
            type: 'kicked',
            reason: 'Another control client has taken over',
            timestamp: Date.now()
          });
          
          // Close existing ctrl connection
          existingCtrlPeers[0].socket.close();
          
          // Remove from peers map
          this.removePeer(existingCtrlPeers[0].id);
          
          // Continue with new ctrl joining
        } else {
          // Normal mode: reject second ctrl
          this.sendError(socket, 'Room already has a control client');
          this.sendMessage(socket, {
            type: 'join-rejected',
            reason: 'Room already has a control client. Add ?force=true to URL to take over.',
            timestamp: Date.now()
          });
          return null;
        }
      }
    }

    const peer: Peer = {
      id: peerId,
      type: peerType as 'ctrl' | 'synth',
      socket,
      connectedAt: Date.now()
    };

    this.peers.set(peerId, peer);
    
    // Add to room
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Set());
    }
    this.rooms.get(roomId)!.add(peerId);

    console.log(`✅ Peer ${peerId} (${peerType}) joined room ${roomId}`);
    
    // Send confirmation
    this.sendMessage(socket, {
      type: 'join-success',
      peerId,
      timestamp: Date.now()
    });

    // Send peer list to the newly joined peer
    this.sendPeerList(socket, roomId);

    // For star topology: notify based on peer type
    if (peerType === 'ctrl') {
      // Ctrl joining: notify all synths in room
      this.notifyPeersByType(roomId, 'synth', {
        type: 'ctrl-available',
        ctrlId: peerId
      });
    } else if (peerType === 'synth') {
      // Synth joining: only notify ctrl peers
      this.notifyPeersByType(roomId, 'ctrl', {
        type: 'synth-available', 
        synthId: peerId
      });
      
      // Send available ctrl to this synth
      const ctrlPeers = this.getPeersByType(roomId, 'ctrl');
      if (ctrlPeers.length > 0) {
        this.sendMessage(socket, {
          type: 'ctrl-available',
          ctrlId: ctrlPeers[0].id // Connect to first available ctrl
        });
      }
    }

    return peer;
  }

  private relaySignalingMessage(message: any, fromPeer: Peer | null) {
    if (!fromPeer) {
      console.warn('⚠️ Received signaling message from unknown peer');
      return;
    }

    const { targetPeerId } = message;
    const targetPeer = this.peers.get(targetPeerId);
    
    if (!targetPeer) {
      console.warn(`⚠️ Target peer ${targetPeerId} not found`);
      return;
    }

    // Add source peer ID and relay
    const relayMessage = {
      ...message,
      fromPeerId: fromPeer.id
    };

    this.sendMessage(targetPeer.socket, relayMessage);
    console.log(`📤 Relayed ${message.type} from ${fromPeer.id} to ${targetPeerId}`);
  }

  private sendPeerList(socket: WebSocket, roomId: string) {
    const roomPeers = this.rooms.get(roomId);
    if (!roomPeers) {
      this.sendMessage(socket, { type: 'peer-list', peers: [] });
      return;
    }

    const peerList = Array.from(roomPeers).map(peerId => {
      const peer = this.peers.get(peerId);
      return {
        id: peer!.id,
        type: peer!.type,
        connectedAt: peer!.connectedAt
      };
    });

    console.log(`📋 Sending peer list to new peer: ${peerList.length} peers`);
    this.sendMessage(socket, {
      type: 'peer-list',
      peers: peerList
    });
  }

  private broadcastToRoom(roomId: string, message: any, excludePeerId?: string) {
    const roomPeers = this.rooms.get(roomId);
    if (!roomPeers) return;

    for (const peerId of roomPeers) {
      if (peerId === excludePeerId) continue;
      
      const peer = this.peers.get(peerId);
      if (peer && peer.socket.readyState === WebSocket.OPEN) {
        this.sendMessage(peer.socket, message);
      }
    }
  }

  private notifyPeersByType(roomId: string, peerType: 'ctrl' | 'synth', message: any) {
    const roomPeers = this.rooms.get(roomId);
    if (!roomPeers) return;

    for (const peerId of roomPeers) {
      const peer = this.peers.get(peerId);
      if (peer && peer.type === peerType && peer.socket.readyState === WebSocket.OPEN) {
        this.sendMessage(peer.socket, message);
      }
    }
  }

  private getPeersByType(roomId: string, peerType: 'ctrl' | 'synth'): Peer[] {
    const roomPeers = this.rooms.get(roomId);
    if (!roomPeers) return [];

    const result: Peer[] = [];
    for (const peerId of roomPeers) {
      const peer = this.peers.get(peerId);
      if (peer && peer.type === peerType) {
        result.push(peer);
      }
    }
    return result;
  }

  private removePeer(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    this.peers.delete(peerId);

    // Remove from all rooms and notify
    for (const [roomId, roomPeers] of this.rooms.entries()) {
      if (roomPeers.has(peerId)) {
        roomPeers.delete(peerId);
        
        // Notify remaining peers
        this.broadcastToRoom(roomId, {
          type: 'peer-left',
          peerId,
          peerType: peer.type
        });

        // Clean up empty rooms
        if (roomPeers.size === 0) {
          this.rooms.delete(roomId);
        }
      }
    }
  }

  private sendMessage(socket: WebSocket, message: any) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private sendError(socket: WebSocket, error: string) {
    this.sendMessage(socket, {
      type: 'error',
      message: error,
      timestamp: Date.now()
    });
  }

  getStats() {
    return {
      totalPeers: this.peers.size,
      totalRooms: this.rooms.size,
      peersByType: {
        ctrl: Array.from(this.peers.values()).filter(p => p.type === 'ctrl').length,
        synth: Array.from(this.peers.values()).filter(p => p.type === 'synth').length
      }
    };
  }
}

// Get local IP addresses
function getLocalIPs() {
  const networkInterfaces = Deno.networkInterfaces();
  const ips = [];
  
  for (const iface of networkInterfaces) {
    if (iface.family === 'IPv4' && !iface.address.startsWith('127.') && iface.address !== '0.0.0.0') {
      ips.push(iface.address);
    }
  }
  
  return ips;
}

// HTTP Server with WebSocket upgrade and static file serving
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  
  // Health check endpoint
  if (pathname === '/health') {
    return new Response(JSON.stringify(signalingServer.getStats()), {
      headers: { 'content-type': 'application/json' }
    });
  }

  // WebSocket upgrade
  if (pathname === '/ws') {
    const { socket, response } = Deno.upgradeWebSocket(req);
    signalingServer.handleWebSocket(socket);
    return response;
  }

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

  // Static file serving
  let response;
  
  // Route based on first path segment
  if (pathname.startsWith('/ctrl/')) {
    // Serve ctrl client - strip /ctrl prefix
    const relativePath = pathname.substring(5); // Remove '/ctrl'
    const newUrl = new URL(relativePath || '/', url.origin);
    const ctrlReq = new Request(newUrl.toString(), req);
    response = await serveDir(ctrlReq, { fsRoot: "public/ctrl" });
  } else if (pathname === '/ctrl') {
    // Redirect /ctrl to /ctrl/
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/ctrl/' }
    });
  } else if (pathname.startsWith('/synth/')) {
    // Serve synth client - strip /synth prefix
    const relativePath = pathname.substring(6); // Remove '/synth'
    const newUrl = new URL(relativePath || '/', url.origin);
    const synthReq = new Request(newUrl.toString(), req);
    response = await serveDir(synthReq, { fsRoot: "public/synth" });
  } else if (pathname === '/synth') {
    // Redirect /synth to /synth/
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/synth/' }
    });
  } else if (pathname.startsWith('/src/common/')) {
    // Serve shared modules from project root
    response = await serveDir(req, { fsRoot: "." });
  } else {
    // Default to serving a simple landing page
    return new Response(`
<!DOCTYPE html>
<html>
<head>
    <title>Voice.Assembly.FM</title>
    <style>
        body { 
            font-family: system-ui; 
            max-width: 600px; 
            margin: 50px auto; 
            padding: 20px;
            background: #000;
            color: #fff;
        }
        h1 { color: #00ff88; }
        a { color: #00ff88; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .links { display: flex; gap: 20px; margin: 30px 0; }
        .link-box { 
            border: 1px solid #333; 
            padding: 20px; 
            border-radius: 8px;
            background: #111;
        }
    </style>
</head>
<body>
    <h1>🎵 Voice.Assembly.FM</h1>
    <p>Distributed vocal synthesis platform for audience-participatory electronic music performance.</p>
    
    <div class="links">
        <div class="link-box">
            <h3><a href="/ctrl/">Control Client</a></h3>
            <p>For the performer - controls timing and musical parameters</p>
        </div>
        <div class="link-box">
            <h3><a href="/synth/">Synth Client</a></h3>
            <p>For the audience - join the choir and participate in synthesis</p>
        </div>
    </div>
    
    <p><a href="/health">Health Check</a> | WebSocket: ws://[host]/ws</p>
</body>
</html>
    `, {
      headers: { 'content-type': 'text/html' }
    });
  }
  
  // Add CORS headers to all responses
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  
  // Fix MIME type for JavaScript modules
  if (pathname.endsWith('.js')) {
    response.headers.set("Content-Type", "application/javascript");
  }
  
  return response;
}

const signalingServer = new SignalingServer();
const localIPs = getLocalIPs();
const port = 8000;

console.log("🌐 Voice.Assembly.FM Consolidated Server");
console.log("=======================================");
console.log(`📡 Local:     http://localhost:${port}`);

if (localIPs.length > 0) {
  console.log("📱 Network:");
  localIPs.forEach(ip => {
    console.log(`   http://${ip}:${port}`);
  });
} else {
  console.log("⚠️  No network interfaces found");
}

console.log("");
console.log("🎯 Quick Access:");
console.log(`   Ctrl Client:  http://localhost:${port}/ctrl/`);
console.log(`   Synth Client: http://localhost:${port}/synth/`);
console.log(`   Health Check: http://localhost:${port}/health`);
console.log(`   WebSocket:    ws://localhost:${port}/ws`);

if (localIPs.length > 0) {
  console.log("");
  console.log("📱 Network Access:");
  localIPs.forEach(ip => {
    console.log(`   Ctrl:  http://${ip}:${port}/ctrl/`);
    console.log(`   Synth: http://${ip}:${port}/synth/`);
  });
}

console.log("");
console.log("🎤 Quick Start:");
console.log("1. Open Ctrl Client → Connect to Network");
console.log("2. Open Synth Client(s) → Tap to Join the Choir");
console.log("3. Test calibration mode and audio controls");

await serve(handler, { port, hostname: "0.0.0.0" });