# Voice.Assembly.FM - Phase 1

Distributed vocal synthesis platform for audience-participatory electronic music
performance.

## Phase 1: Network Infrastructure & Timing Foundation

This initial phase implements the core WebRTC star networking and phasor-based
timing synchronization system.

### Features Implemented

- ✅ **WebRTC Star Networking**: Star topology with ctrl as hub, synths as
  spokes
- ✅ **Signaling Server**: WebSocket-based peer discovery and WebRTC connection
  setup
- ✅ **Force Takeover**: Multiple ctrl client prevention with override
  capability
- ✅ **Phasor Synchronization**: Distributed timing with master-slave
  architecture
- ✅ **State Synchronization**: New synths automatically receive current system
  state
- ✅ **Ctrl Client**: Network management, timing control, calibration interface,
  and musical control
- ✅ **Synth Client**: Join UI with XY oscilloscope, white noise calibration,
  and zing synthesis
- ✅ **Musical Control**: Real-time parameter control (frequency, morph, vowel
  position, harmonic ratio)
- ✅ **Envelope System**: Phasor-driven parameter modulation with multiple
  envelope types and randomization
- ✅ **HRG System**: Harmonic Ratio Generation for frequency parameters with SIN
  notation and temporal behaviors
- ✅ **Deferred Parameter Application**: Changes batched and applied via "Apply
  Changes" button in control panel
- ✅ **Scene Memory System**: In-memory save/load system with per-synth state
  preservation and re-resolve functionality

### Quick Start

Unified server (HTTP + WebSocket + static + ICE):

```bash
# with file watch
deno task dev

# without watch
deno task start
```

Open the applications (same port):

- Ctrl client: http://localhost:3456/ctrl/
- Synth clients: http://localhost:3456/synth/ (open multiple tabs/devices)

For network access from other devices, the server prints LAN URLs on startup.

**Note:** If you edit `public/ctrl/ctrl-main.ts`, run `deno task build` before
refresh.

### Configuration

- Environment file: `.env` in repo root. Supported variables:
  - `PORT`: HTTP server port (default `3456`).
  - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`: Optional. When set,
    `/ice-servers` will request TURN credentials from Twilio and return full ICE
    servers. If unset, the server returns fallback public STUN servers.
- Endpoint: `GET /ice-servers` returns `{ ice_servers: [...] }` for client
  RTCPeerConnection config.
- Quick check:
  ```bash
  curl http://localhost:3456/ice-servers | jq
  ```

### Testing the System

1. **Open ctrl client** in one browser tab/window
2. **Click "Connect to Network"** - should become leader automatically
3. **Open synth client(s)** in other tabs/windows or devices
4. **Click "Tap to Join the Choir"** on each synth client
5. **Configure timing in ctrl client**:
   - Set Period (seconds): Controls cycle duration (default 2.0s)
   - Set Steps: Number of rhythmic divisions per cycle (default 16)
   - Transport controls: play, pause, stop, jump to EOC
   - Apply at EOC toggle: Changes timing immediately or at End-of-Cycle
6. **Click "play"** to begin phasor synchronization
7. **Test calibration mode** - enables white noise XY oscilloscope on all synth
   clients
8. **Test HRG system** (optional):
   - Click [H] button next to frequency parameters to enable HRG
   - Set numerators and denominators (e.g., "1,2,3" and "1,2")
   - Choose behaviors from dropdown (S=Static, A=Ascending, D=Descending,
     Sh=Shuffle, R=Random)
   - Click "Apply Changes" in control panel to send parameters to synths
   - HRG values change at phasor cycle boundaries (EOC)
9. **New synths automatically receive current state** - no need to retoggle
   modes
10. **Scene Memory System**:

- **Save**: Click numbered save buttons (0-9) to capture current state
- **Load**: Click numbered load buttons to restore saved state
- **Re-resolve**: Click "re-resolve" button to randomize HRG indices across all
  synths
- **Per-synth memory**: Each synth maintains its own 10-slot scene memory
- **Ephemeral storage**: Scene memory lost on page refresh (by design)

### Architecture Overview

```
          ┌──────────────────────────────┐
          │ Unified Server (HTTP+WS+ICE) │
          │        (Port 3456)           │
          └─────────┬─────────┬──────────┘
                    │         │
               Static/WS   /ice-servers
                    │         │
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

**Parameter Control (Clean Three-Message Model):**

- `SUB_PARAM_UPDATE`: Individual field edits with dot-notation paths
  - Examples: `"frequency.baseValue"`, `"whiteNoise.startValueGenerator.range"`, `"amplitude.interpolation"`
  - Playing: synth stages for EOC application
  - Paused: synth applies immediately with portamento
- `PROGRAM_UPDATE`: Full program configuration changes
  - Contains: interpolation modes, generators, baseValues for all parameters
  - Effect: synth reinitializes stochastic state (fresh HRG indices, RBG values)
  - Used by: presets, bulk edits, new synth bootstrap
- `LOAD_SCENE`: Exact scene restoration with stochastic state preservation
  - Contains: program config + saved HRG indices/orders + RBG cached values
  - Effect: synth restores identical playback state for exact audible recall
  - Used by: scene memory system for performance continuity

**Timing Synchronization:**

- `phasor-sync`: Master broadcasts current phasor position (0.0-1.0), cycle
  length in seconds, and steps per cycle
- `transport`: Transport control commands (play, pause, stop)
- `jump-to-eoc`: Instantly jump all synths to End-of-Cycle
- `ping`/`pong`: RTT measurement and network health monitoring

**System Control:**

- `calibration-mode`: Enable/disable white noise XY oscilloscope for volume
  matching
- State synchronization: New synths receive current program via `PROGRAM_UPDATE`

**Connection Management:**

- `peer-joined`/`peer-left`: Peer discovery and lifecycle management
- Standard WebRTC signaling: `offer`/`answer`/`ice-candidate`

### Current Limitations

- ✅ ~~**Test synthesis only**: Simple sine wave oscillator, not voice
  synthesis~~ → **COMPLETED**: Morphing zing synthesis with formant control
- ✅ ~~**No musical control**: No pitch, rhythm, or parameter control from ctrl
  client~~ → **COMPLETED**: Musical control interface with real-time parameter
  broadcast
- ✅ ~~**No envelope system**: No parameter modulation over phasor cycles~~ →
  **COMPLETED**: Full envelope system with linear, cosine, and parabolic
  envelope types
- ✅ ~~**No HRG system**: No harmonic ratio generation yet~~ → **COMPLETED**:
  HRG system for frequency parameters with SIN notation and temporal behaviors
- **No ES-8 integration**: Timing is software-only

### Next Phase

Phase 2 will implement the audio synthesis engine, replacing the test oscillator
with a voice synthesis system that responds to musical control and phasor-driven
timing.

### Development Notes

- Built with vanilla JavaScript ES modules for maximum compatibility
- Uses Deno for server runtime (Node.js compatible)
- WebRTC data channels configured for low-latency (unreliable, unordered)
- Phasor synchronization handles network jitter with exponential moving average
  filtering
- Star topology scales better than mesh (ctrl bandwidth is the main limit)

### Technical Notes: Harmonic Ratio System

**Important:** "Harmonic Ratio" is NOT a user-controllable parameter in this
system.

- **Formant-based synthesis**: Secondary oscillators run at vowel formant
  frequencies (F1, F2, F3)
- **UPLO pairs**: Uses Unified Phase Locked Oscillator pairs for coherent
  formant generation
- **Vowel space**: Formant frequencies determined by 2D vowel position
  (front/back, close/open)
- **Emergent ratios**: Harmonic ratios emerge from formant_frequency /
  fundamental_frequency relationships
- **Bilinear interpolation**: Vowel corners (u, ɔ, i, æ) interpolated based on
  X/Y position

The `harmonicRatio` AudioParam exists in the worklet for internal DSP
calculations, but should never be exposed as a direct user control. User
controls vowel position; harmonic relationships emerge naturally.

### HRG (Harmonic Ratio Generator) System

**Overview**: The HRG system provides stochastic variation of frequency
parameters across the distributed choir using rational number ratios and
temporal behaviors.

**SIN (Stochastic Integer Notation)**:

- **Format**: "1-3,5,7-9" expands to [1,2,3,5,7,8,9]
- **Usage**: Defines sets of integers for numerators and denominators
- **Ratios**: Each synth gets a randomly selected numerator/denominator pair

**Behaviors (Temporal Progression)**:

- **Static (S)**: Random start value, stays constant throughout performance
- **Ascending (A)**: Random start, increments through set at each EOC (End of
  Cycle)
- **Descending (D)**: Random start, decrements through set at each EOC
- **Shuffle (Sh)**: Fixed random order, cycles through predefined sequence
- **Random (R)**: Non-repeating random selection (avoids consecutive duplicates)

**User Interface**:

- **[H] Toggle**: Click to show/hide HRG controls for frequency parameters
- **Compact Layout**: Two lines: numerators (n:) and denominators (d:)
- **Separate Behaviors**: Independent behavior selection for numerators and
  denominators
- **Deferred Application**: Changes require "Apply Changes" button in control
  panel

**Musical Effect**: Each synth client receives unique but harmonically-related
frequency values, creating rich ensemble textures while maintaining rhythmic
synchronization.

### Scene Memory System

**Overview**: The scene memory system allows performers to save and recall
different musical states during performance, enabling dynamic transitions
between pre-configured ensemble textures.

**Architecture**:

- **Per-synth storage**: Each synth client maintains its own independent 10-slot
  memory
- **In-memory only**: Scenes are stored in browser memory (lost on page refresh)
- **State preservation**: Saves HRG indices, sequence orders, and direct
  parameter values
- **No conflicts**: Each browser tab has its own isolated scene memory

**Save Process**:

1. **Controller saves program**: Program configuration stored in controller's
   localStorage
2. **Synths save state independently**: Each synth captures its current:
   - HRG sequence state (indices and shuffle orders)
   - Direct parameter values (amplitude, white noise, etc.)
   - Generator configurations

**Load Process**:

1. **Controller loads program**: Updates UI and broadcasts program to synths
2. **Synths restore individual state**: Each synth:
   - Checks its own memory slot for saved state
   - Restores saved HRG indices and sequences (preserving unique frequencies)
   - Applies saved direct parameter values
   - Falls back to fresh initialization if no saved state exists

**Re-resolve Functionality**:

- **Purpose**: Instantly randomize static HRG indices across all synths
- **Trigger**: "re-resolve" button in controller interface
- **Effect**: Each synth generates new random indices at next End-of-Cycle
- **Use case**: Create new ensemble texture variations during performance

**Benefits**:

- **No ID conflicts**: Eliminates issues with shared localStorage between
  browser tabs
- **True per-synth uniqueness**: Each synth maintains its own musical state
- **Simple architecture**: No complex synchronization or conflict resolution
- **Performance-friendly**: Instant scene transitions with preserved timing

### Envelope System

**Overview**: The envelope system provides phasor-driven parameter modulation
over each timing cycle, allowing for dynamic control of all synthesis
parameters.

**Supported Parameters**: All synthesis parameters support envelope control:

- `frequency` (80-800 Hz range)
- `vowelX`, `vowelY` (0-1 normalized)
- `zingAmount`, `zingMorph`, `symmetry` (0-1 normalized)
- `amplitude` (0-1 normalized)

**Envelope Types**:

1. **Linear (lin)**: Exponential curves controlled by intensity parameter
   - `intensity=0`: Ease-in (slow start, fast end)
   - `intensity=0.5`: Perfect linear interpolation
   - `intensity=1`: Ease-out (fast start, slow end)

2. **Cosine (cos)**: Sigmoid-to-square wave morphing
   - `intensity=0`: Gentle sigmoid curve
   - `intensity=0.5`: Moderate S-curve
   - `intensity=1`: Nearly square wave transition

3. **Parabolic (par)**: Parabolic curves that peak at 50% phase
   - For `frequency`: Peak calculated as geometric mean of start/end, with
     octave offset controlled by intensity
   - For normalized params: Peak calculated as arithmetic mean with linear
     offset controlled by intensity
   - `intensity=0`: Peak below midpoint
   - `intensity=0.5`: Peak at midpoint
   - `intensity=1`: Peak above midpoint

**Control Modes**:

- **Static Mode**: Parameter uses a single fixed value throughout the cycle
- **Envelope Mode**: Parameter modulates between start and end values using the
  selected envelope type
- **Range Mode**: Start and/or end values can be randomized within specified
  ranges

**Randomization**: Each synth can receive randomized start/end values at the
beginning of each phasor cycle, enabling emergent ensemble behavior while
maintaining synchronization.

### File Structure

```
src/
├── common/                      # Shared modules
│   ├── webrtc-star.js           # WebRTC star topology networking
│   ├── message-protocol.js      # Network message definitions + validation
│   └── parameter-types.ts       # Shared TS types for parameters
├── server/
│   ├── server.ts                # Unified server (HTTP + WS + static + ICE)
│   └── utils.ts                 # Server utilities (local IPs, etc.)
public/
├── ctrl/                        # Control client (performer)
│   ├── index.html
│   └── ctrl-main.ts             # TS entry; bundled on-the-fly as JS
└── synth/                       # Synth client (audience)
    ├── index.html
    ├── synth-main.js            # Synthesis + networking
    └── worklets/
        ├── white-noise-processor.js
        ├── phasor-processor.worklet.js
        ├── program-worklet.js
        └── voice-worklet.js
```
