/**
 * WebSocket Signaling Server for Voice.Assembly.FM
 * Handles peer discovery and WebRTC connection setup
 */

import { serve } from "std/http/server.ts";
import { STATUS_CODE } from "std/http/status.ts";
import { config } from "./config.ts";
import { getLocalIPs } from "./utils.ts";

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
    
    // Validate join message
    if (!this.validateJoinMessage(message, socket)) {
      return null;
    }

    if (this.peers.has(peerId)) {
      this.sendError(socket, 'Peer ID already exists');
      return null;
    }

    // Handle ctrl takeover if needed
    if (peerType === 'ctrl') {
      const takeoverResult = this.handleCtrlTakeover(roomId, peerId, forceTakeover, socket);
      if (!takeoverResult) {
        return null;
      }
    }

    // Create and register peer
    const peer = this.registerPeer(peerId, peerType, socket, roomId);
    
    // Notify other peers about the new joinee
    this.notifyPeersOfNewJoinee(peer, roomId, socket);

    return peer;
  }

  private validateJoinMessage(message: any, socket: WebSocket): boolean {
    const { peerId, peerType, roomId } = message;
    
    if (!peerId || !peerType || !roomId) {
      this.sendError(socket, 'Missing required fields: peerId, peerType, roomId');
      return false;
    }
    
    return true;
  }

  private handleCtrlTakeover(roomId: string, newPeerId: string, forceTakeover: boolean, socket: WebSocket): boolean {
    const existingCtrlPeers = this.getPeersByType(roomId, 'ctrl');
    
    if (existingCtrlPeers.length === 0) {
      return true; // No existing ctrl, proceed
    }

    if (forceTakeover) {
      // Force takeover: kick existing ctrl client
      console.log(`⚠️ Force takeover: Kicking existing ctrl ${existingCtrlPeers[0].id} for new ctrl ${newPeerId}`);
      
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
      
      return true; // Continue with new ctrl joining
    } else {
      // Normal mode: reject second ctrl
      this.sendError(socket, 'Room already has a control client');
      this.sendMessage(socket, {
        type: 'join-rejected',
        reason: 'Room already has a control client. Add ?force=true to URL to take over.',
        timestamp: Date.now()
      });
      return false;
    }
  }

  private registerPeer(peerId: string, peerType: string, socket: WebSocket, roomId: string): Peer {
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

    return peer;
  }

  private notifyPeersOfNewJoinee(peer: Peer, roomId: string, socket: WebSocket): void {
    // For star topology: notify based on peer type
    if (peer.type === 'ctrl') {
      // Ctrl joining: notify all synths in room
      this.notifyPeersByType(roomId, 'synth', {
        type: 'ctrl-available',
        ctrlId: peer.id
      });
    } else if (peer.type === 'synth') {
      // Synth joining: only notify ctrl peers
      this.notifyPeersByType(roomId, 'ctrl', {
        type: 'synth-available', 
        synthId: peer.id
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

// HTTP Server with WebSocket upgrade
async function handler(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  
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

  // CORS headers for development
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  return new Response('Voice.Assembly.FM Signaling Server', {
    status: STATUS_CODE.OK,
    headers: {
      'content-type': 'text/plain',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

const signalingServer = new SignalingServer();

const localIPs = getLocalIPs();
const port = config.signalingPort;

console.log("🌐 Voice.Assembly.FM Signaling Server");
console.log(`📡 Local:     http://localhost:${port}`);

if (localIPs.length > 0) {
  console.log("📱 Network:");
  localIPs.forEach(ip => {
    console.log(`   http://${ip}:${port}`);
  });
} else {
  console.log("⚠️  No network interfaces found");
}

console.log(`📡 WebSocket: ws://[address]:${port}/ws`);
console.log(`❤️  Health:   http://[address]:${port}/health`);

await serve(handler, { port, hostname: "0.0.0.0" });