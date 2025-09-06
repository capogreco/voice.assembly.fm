# Voice.Assembly.FM - Phase 1

Distributed vocal synthesis platform for audience-participatory electronic music performance.

## Phase 1: Network Infrastructure & Timing Foundation

This initial phase implements the core WebRTC mesh networking and phasor-based timing synchronization system.

### Features Implemented

- ✅ **WebRTC Mesh Networking**: Full mesh P2P connections between ctrl and synth clients
- ✅ **Signaling Server**: WebSocket-based peer discovery and WebRTC connection setup
- ✅ **Leader Election**: Score-based (RTT-minimizing) automatic leader selection
- ✅ **Phasor Synchronization**: Distributed timing with master-slave architecture
- ✅ **Basic Ctrl Client**: Network management and timing control interface
- ✅ **Basic Synth Client**: Minimal UI with test oscillator and oscilloscope visualization

### Quick Start

1. **Start the signaling server:**
   ```bash
   deno task dev
   ```

2. **Start the ctrl client server:**
   ```bash
   deno task serve-ctrl
   ```

3. **Start the synth client server:**
   ```bash
   deno task serve-synth
   ```

4. **Open the applications:**
   - Ctrl client: http://localhost:8080
   - Synth clients: http://localhost:8081 (open multiple tabs/devices)

### Testing the System

1. **Open ctrl client** in one browser tab/window
2. **Click "Connect to Network"** - should become leader automatically
3. **Open synth client(s)** in other tabs/windows
4. **Click "Tap to Join the Choir"** on each synth client
5. **In ctrl client, click "Start Timing"** to begin phasor synchronization
6. **Test calibration mode** - enables pink noise on all synth clients

### Architecture Overview

```
┌─────────────────┐    WebSocket     ┌──────────────────┐
│  Ctrl Client    │◄───────────────►│ Signaling Server │
│  (Leader)       │                 │   (Port 8000)    │
└─────────┬───────┘                 └─────────┬────────┘
          │                                   │
          │ WebRTC Data Channels              │
          │                                   │
          ▼                                   ▼
┌─────────────────┐                ┌─────────────────┐
│  Synth Client   │◄──────────────►│  Synth Client   │
│   (Slave)       │   Full Mesh    │   (Slave)       │
└─────────────────┘                └─────────────────┘
```

### Network Messages

**Timing Synchronization:**
- `phasor-sync`: Master broadcasts current phasor position (0.0-1.0)
- `ping`/`pong`: RTT measurement and network health monitoring

**System Control:**
- `calibration-mode`: Enable/disable pink noise for volume matching
- `leader-election`: Automatic leader selection based on network centrality

**Connection Management:**
- `peer-joined`/`peer-left`: Peer discovery and lifecycle management
- Standard WebRTC signaling: `offer`/`answer`/`ice-candidate`

### Current Limitations

- **Test synthesis only**: Simple sine wave oscillator, not formant synthesis
- **Basic oscilloscope**: Shows waveform but not XY formant visualization
- **No ES-8 integration**: Timing is software-only
- **No HRG system**: No harmonic ratio generation yet
- **No envelope system**: No parameter modulation over cycles

### Next Phase

Phase 2 will integrate the morphing-zing synthesis engine from the euclidean sequencer reference, implementing the full formant/zing synthesis system with parameter envelope control.

### Development Notes

- Built with vanilla JavaScript ES modules for maximum compatibility
- Uses Deno for server runtime (Node.js compatible)
- WebRTC data channels configured for low-latency (unreliable, unordered)
- Phasor synchronization handles network jitter with exponential moving average filtering
- Full mesh topology scales to ~20-30 clients before bandwidth becomes limiting

### File Structure

```
src/
├── common/                 # Shared utilities
│   ├── webrtc-mesh.js     # WebRTC peer-to-peer networking
│   ├── phasor-sync.js     # Distributed timing synchronization  
│   ├── message-protocol.js # Network message format definitions
│   └── timing-math.js     # Clock synchronization mathematics
├── server/                # Development servers
│   ├── signaling-server.ts # WebSocket signaling server
│   └── static-server.ts   # Static file server
public/
├── ctrl/                  # Control client (performer interface)
│   ├── index.html         # Main HTML page
│   └── ctrl-main.js       # Application logic
└── synth/                 # Synth client (audience interface)  
    ├── index.html         # Minimal join/active UI
    └── synth-main.js      # Synthesis and networking logic
```