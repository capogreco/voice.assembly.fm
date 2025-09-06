# Voice.Assembly.FM - Phase 1

Distributed vocal synthesis platform for audience-participatory electronic music performance.

## Phase 1: Network Infrastructure & Timing Foundation

This initial phase implements the core WebRTC star networking and phasor-based timing synchronization system.

### Features Implemented

- ✅ **WebRTC Star Networking**: Star topology with ctrl as hub, synths as spokes
- ✅ **Signaling Server**: WebSocket-based peer discovery and WebRTC connection setup
- ✅ **Force Takeover**: Multiple ctrl client prevention with override capability
- ✅ **Phasor Synchronization**: Distributed timing with master-slave architecture
- ✅ **State Synchronization**: New synths automatically receive current system state
- ✅ **Ctrl Client**: Network management, timing control, and calibration interface
- ✅ **Synth Client**: Join UI with XY oscilloscope and white noise calibration

### Quick Start

**Start all servers (recommended):**
```bash
deno task launch
```

**Or start individually:**
1. **Signaling server:** `deno task dev`
2. **Ctrl client server:** `deno task serve-ctrl` 
3. **Synth client server:** `deno task serve-synth`

**Open the applications:**
- Ctrl client: http://localhost:8080
- Synth clients: http://localhost:8081 (open multiple tabs/devices)

**For network access from other devices:**
- The launcher displays network URLs for mobile/tablet access

### Testing the System

1. **Open ctrl client** in one browser tab/window
2. **Click "Connect to Network"** - should become leader automatically
3. **Open synth client(s)** in other tabs/windows or devices
4. **Click "Tap to Join the Choir"** on each synth client
5. **In ctrl client, click "Start Timing"** to begin phasor synchronization
6. **Test calibration mode** - enables white noise XY oscilloscope on all synth clients
7. **New synths automatically receive current state** - no need to retoggle modes

### Architecture Overview

```
                    ┌──────────────────┐
                    │ Signaling Server │
                    │   (Port 8000)    │
                    └─────────┬────────┘
                              │ WebSocket
                              │
            ┌─────────────────┴─────────────────┐
            │          Ctrl Client              │
            │         (Star Hub)                │
            └─────────┬─────────────────┬───────┘
                      │                 │
            WebRTC    │                 │    WebRTC
          Data Channels                 │  Data Channels  
                      │                 │
          ┌───────────▼───────┐   ┌─────▼─────────────┐
          │  Synth Client     │   │  Synth Client     │
          │   (Spoke)         │   │   (Spoke)         │
          └───────────────────┘   └───────────────────┘
```

### Network Messages

**Timing Synchronization:**
- `phasor-sync`: Master broadcasts current phasor position (0.0-1.0)
- `ping`/`pong`: RTT measurement and network health monitoring

**System Control:**
- `calibration-mode`: Enable/disable white noise XY oscilloscope for volume matching
- State synchronization: New synths automatically receive current system state

**Connection Management:**
- `peer-joined`/`peer-left`: Peer discovery and lifecycle management
- Standard WebRTC signaling: `offer`/`answer`/`ice-candidate`

### Current Limitations

- **Test synthesis only**: Simple sine wave oscillator, not voice synthesis
- **No musical control**: No pitch, rhythm, or parameter control from ctrl client
- **No ES-8 integration**: Timing is software-only
- **No HRG system**: No harmonic ratio generation yet
- **No envelope system**: No parameter modulation over phasor cycles

### Next Phase

Phase 2 will implement the audio synthesis engine, replacing the test oscillator with a voice synthesis system that responds to musical control and phasor-driven timing.

### Development Notes

- Built with vanilla JavaScript ES modules for maximum compatibility
- Uses Deno for server runtime (Node.js compatible)
- WebRTC data channels configured for low-latency (unreliable, unordered)
- Phasor synchronization handles network jitter with exponential moving average filtering
- Star topology scales better than mesh (ctrl bandwidth is the main limit)

### File Structure

```
src/
├── common/                    # Shared utilities
│   ├── webrtc-star.js        # WebRTC star topology networking
│   ├── phasor-sync.js        # Distributed timing synchronization  
│   ├── message-protocol.js   # Network message format definitions
│   └── timing-math.js        # Clock synchronization mathematics
├── server/                   # Development servers
│   ├── signaling-server.ts   # WebSocket signaling server
│   ├── static-server.ts      # Static file server
│   └── launcher.ts           # Multi-server launcher
public/
├── ctrl/                     # Control client (performer interface)
│   ├── index.html            # Main HTML page
│   └── ctrl-main.js          # Application logic
└── synth/                    # Synth client (audience interface)  
    ├── index.html            # Minimal join/active UI
    ├── synth-main.js         # Synthesis and networking logic
    └── worklets/
        └── white-noise-processor.js # AudioWorklet for calibration
```