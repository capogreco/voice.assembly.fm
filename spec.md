# Voice.Assembly.FM System Specification

## Overview

Voice.Assembly.FM is a distributed vocal synthesis platform that transforms audience members' phones into components of a collective choir. The system combines precise timing control via ES-8 Eurorack interface, WebRTC peer-to-peer networking, and sophisticated formant/zing synthesis to create harmonically-related vocal textures that sum acoustically in the performance space.

**Core Concept**: The performer controls harmonic and temporal parameters through Eurorack CV and a Monome Grid, while 12-24 audience members' phones synthesize vocal sounds using shared timing and stochastic harmonic variation. The result is distributed synthesis with acoustic summing in physical space.

## System Architecture

### High-Level Components

1. **Ctrl Client** (Performer's browser)
   - ES-8 CV input/output via WebUSB
   - Monome Grid integration for HRG control
   - WebRTC master for network coordination
   - Parameter broadcast and timing control

2. **Synth Clients** (Audience phones)
   - Minimal UI: gesture to enable audio + XY oscilloscope
   - Formant/zing synthesis engine
   - WebRTC slave for timing synchronization
   - Local speaker output for acoustic summing

3. **Signaling Server** (WebSocket)
   - Peer discovery and WebRTC connection setup
   - No audio routing - pure coordination

## ES-8 Integration

### Channel Mapping

**Inputs to Browser:**
- **Channel 8**: Linear downward ramp (10V→0V) - cycle position/progress
- **Channel 7**: Clock pulses - cycle subdivision triggers

**Outputs from Browser:**
- **Channels 1-6**: Minimalist TR and CV sequencer (following es_8_test pattern)
- **Channel 8**: Echo of cycle position (for patching/monitoring)
- **Channel 7**: Echo of clock pulses

### Cycle Control
- **Duration**: ~2 seconds typical (~120 BPM at 4/4)
- **Control**: Set via ctrl client GUI (not CV controllable)
- **Timing Source**: ES-8 channel 8 ramp is authoritative reference

## Network Architecture

### Topology
- **Physical**: Star topology WebRTC network (ctrl-hub, synth-spokes)
- **Logical**: Ctrl-master, synth-slave timing hierarchy
- **Capacity**: Designed for 12-24 concurrent synth clients
- **Auto-Connect**: Both clients connect automatically on page load

### Master-Slave Coordination
- **Leadership**: Ctrl clients are always masters/leaders (no election needed)
- **Sync Protocol**: Continuous ping-pong timestamp exchange
- **Phasor Synchronization**: Distributed phase coherence for musical timing
- **Connection Flow**: Network connects immediately, audio requires user gesture

### WebRTC Configuration
```js
// Dedicated sync channel (unreliable, unordered)
const syncChannelOptions = {
  ordered: false,
  maxRetransmits: 0
};
```

## Synthesis Engine

### Core Engine
Based on morphing-zing synthesis from euclidean sequencer reference:
- **Formant synthesis**: Three-formant vowel generation with vowel space morphing
- **Zing synthesis**: Ring modulation + phase modulation with hard sync
- **Hybrid modes**: Continuous blend between formant and zing

### Synthesis Parameters

**HRG-Controlled Parameters (uses HRG System):**
- `frequency` - Fundamental frequency (uses harmonic ratio generation)

**Normalized Parameters (uses Range System, 0-1 range):**
- `morph` - PM to Ring Mod blend (-1 to 1, mapped to 0-1)
- `modDepth` - Modulation intensity
- `symmetry` - Phase warping/pulse width  
- `gain` - Output level
- `sync` - Hard sync on/off
- `vowelX` - Front/back vowel position
- `vowelY` - Close/open vowel position
- `vowelBlend` - Zing vs formant mode blend
- `active` - Synthesis enable/disable

*See "Parameter Randomization Systems" section below for details on the two randomization approaches.*

### Formant Frequency Constraints
All secondary oscillator ratios (for both formant and zing modes) are constrained to vowel-realistic frequency ranges:
- **F1 range**: ~240-850 Hz (ratios ~1.1-3.9 relative to fundamental)
- **F2 range**: ~596-2290 Hz (ratios ~2.7-10.4)  
- **F3 range**: ~2240-3010 Hz (ratios ~10.2-13.7)

This ensures all synthesis modes produce human voice-like spectral content.

## Parameter Randomization Systems

Voice.Assembly.FM uses **two distinct randomization systems** depending on parameter type:

### 1. HRG System (Frequency/Harmonic Parameters)
- **Purpose**: Generate musical harmonic ratios (e.g., 3/2, 5/4, 7/4)
- **Parameters**: `frequency` and future harmonic/period parameters
- **Method**: Numerator/Denominator integer sets with temporal behaviors
- **Benefits**: 
  - Ensures harmonic relationships between synths
  - Musical intervals rather than arbitrary frequencies
  - Temporal behaviors (shuffle, ascending, etc.) for structured variation
- **Example**: n="1-6" d="2" with shuffle behavior → frequencies of 220×(1/2), 220×(2/2), 220×(3/2), etc.

### 2. Range System (Normalized Parameters)
- **Purpose**: Continuous variation within bounded ranges
- **Parameters**: All normalized (0-1) parameters: `vowelX`, `vowelY`, `morph`, `symmetry`, `amplitude`, etc.
- **Method**: Min/max ranges for start and end envelope values
- **Benefits**:
  - Smooth parameter exploration within safe bounds
  - Independent randomization per synth
  - Continuous values rather than discrete ratios
- **Example**: vowelX start range: 0.2-0.4, end range: 0.6-0.8 → random values within these bounds

### Why Two Systems?
- **Frequency parameters need harmonic relationships** (musical intervals)
- **Normalized parameters need continuous exploration** (perceptual smoothness)
- **Different mathematical domains** (ratios vs. bounded ranges)

## Harmonic Ratio Generator (HRG) System

### Concept
HRGs provide stochastic variation of frequency parameters across the distributed choir using Stochastic Integer Notation (SIN).

### SIN Format
- **Notation**: "1-3, 4, 7-9" → [1, 2, 3, 4, 7, 8, 9]
- **Behaviors**: static, ascending, descending, shuffle, random (non-repeating)

### HRG Parameters
- **Frequency Start HRG**: Numerator SIN + Denominator SIN
- **Frequency End HRG**: Numerator SIN + Denominator SIN
- **Total**: 4 SIN sets (2 numerator, 2 denominator)

### Resolution Architecture
**Ctrl-side resolution** (not synth-side):
- Ctrl maintains `synthId → assignedRatio` mapping
- Ensures musical harmonic distributions (no clustering)
- Enables visualization and live reassignment
- Lower bandwidth (specific values vs full HRG sets)

### Implementation Status ✅ COMPLETED for Frequency
**User Interface**:
- **[H] Toggle Button**: Compact design replaces dice emoji
- **Two-line Layout**: Numerators (n:) and denominators (d:) on separate lines
- **Separate Behaviors**: Independent behavior selection for numerators and denominators
- **Deferred Application**: Changes require "Apply Changes" button (no Range/HRG mode selector)

**Temporal Behaviors**:
- **Static (S)**: Random start, constant value
- **Ascending (A)**: Random start, increments at EOC
- **Descending (D)**: Random start, decrements at EOC  
- **Shuffle (Sh)**: Fixed random sequence
- **Random (R)**: Non-repeating selection

**Integration**: HRG values applied at phasor cycle boundaries (EOC) with envelope system integration.

## Parameter Envelope System

### Per-Parameter Configuration
Each synthesis parameter gets:
- **Start Value** (+ HRG for frequency parameters, + Range for normalized parameters)
- **End Value** (+ HRG for frequency parameters, + Range for normalized parameters)
- **Envelope Type**: "lin" or "cos"  
- **Envelope Intensity**: 0-1 morphing parameter

**Randomization Integration**:
- **HRG Parameters**: Use numerator/denominator SIN sets with temporal behaviors
- **Normalized Parameters**: Use min/max range definitions for stochastic variation

### Envelope Types

**Type "lin" (Log→Linear→Exponential):**
- Uses power function: `y = t^exponent`
- `intensity=0`: exponent=1/8 (logarithmic/concave - fast start, slow finish)
- `intensity=0.5`: exponent=1 (linear)
- `intensity=1`: exponent=8 (exponential/convex - slow start, fast finish)

**Type "cos" (Square→Cosine→Median-Step):**
- Linear interpolation between three shapes
- `intensity=0`: Square (immediate jump to end value)
- `intensity=0.5`: Cosine S-curve (smooth transition)
- `intensity=1`: Median-step (jump to median, then to end at termination)

### Timing
- **Duration**: One ES-8 cycle (synchronized across all synth clients)
- **Progress**: Channel 8 voltage maps to normalized time 0-1

## Ctrl Client Specification

### Core Features
- **ES-8 Interface**: WebUSB connection for CV I/O
- **Network Management**: WebRTC coordination and peer management  
- **Parameter Control**: GUI for all synthesis parameters
- **HRG Control**: Integration with Monome Grid 128
- **Connection Status**: Display of connected synth clients
- **Calibration Mode**: Pink noise generation for volume matching

### User Interface
- **Minimalist Design**: Following es_8_test aesthetic
- **Parameter Sections**: Organized by synthesis function
- **Real-time Feedback**: Connection count, network health
- **Calibration Toggle**: Enable/disable calibration mode
- **Apply Changes Button**: Located in control panel for deferred parameter application

### Monome Grid Integration
- **Grid Layout** (8 rows available):
  - Row 1: Frequency Start HRG (Numerator)
  - Row 2: Frequency Start HRG (Denominator)  
  - Row 3: Frequency End HRG (Numerator)
  - Row 4: Frequency End HRG (Denominator)
  - Rows 5-8: Navigation/parameter assignment/other controls

- **Interaction**:
  - Tap button: Toggle integer in/out of SIN set
  - Hold + tap: Set range in SIN set
  - Columns 13-16: Navigation buttons
  - Visual feedback: Active integers illuminated

### Parameter Assignment
- GUI controls for assigning parameter pairs to Grid rows
- Ability to page between different parameter groupings
- Live editing of SIN sets during performance

## Synth Client Specification

### Minimal UI Design
**Two-state interface:**

**State 1: Waiting to Join**
- Network connects automatically on page load
- Single interaction element: "Tap to join the choir" 
- Gesture enables AudioContext (no microphone permissions needed)
- Simple, clear call-to-action

**State 2: Active Synthesis**  
- **Full-screen XY oscilloscope**: Displays first two formant outputs
- **No controls**: All parameters controlled by ctrl client
- **Visual feedback**: Real-time waveform visualization
- **Status indicator**: Connection health (subtle, non-intrusive)

### Audio Output
- **Local speakers**: Each phone outputs synthesized audio
- **Acoustic summing**: Collective sound combines in physical space
- **Volume calibration**: User-adjustable output level
- **Fallback behavior**: Go silent and attempt reconnection on network loss

### Technical Requirements
- **WebRTC P2P**: Direct connection to all other peers
- **AudioWorklet**: High-precision synthesis timing
- **Touch/gesture handling**: Single-tap audio enablement
- **Responsive design**: Works on phones and tablets

## Network Synchronization Protocol

### Phasor-Based Timing
- **Shared phasor state**: Distributed 0.0-1.0 cycle position
- **Continuous sync**: Regular phasor correction messages
- **Graceful correction**: Gradual phase alignment (no harsh jumps)
- **ES-8 authority**: Channel 8 ramp is ground truth reference

### Timing Messages
```js
// Ctrl broadcasts (every 100-200ms)
{
  type: "phasor_sync",
  phasor: 0.347,              // current cycle position
  audioTime: scheduledTime,   // when this phasor is valid
  cycleFreq: 0.5             // cycles per second
}
```

### Parameter Updates
```js
// Sent at cycle boundaries
{
  type: "parameter_update", 
  synthId: "unique-id",
  parameters: {
    frequency: 440.0,        // resolved from HRG
    vowelX: 0.3,
    morph: 0.7,
    // ... other parameters
  },
  envelopes: {
    frequency: { type: "lin", intensity: 0.8 },
    vowelX: { type: "cos", intensity: 0.2 },
    // ... per-parameter envelopes
  }
}
```

### Latency Compensation
- **RTT measurement**: Continuous ping/pong latency tracking
- **Predictive scheduling**: Schedule events with latency + buffer offset
- **Outlier rejection**: Ignore measurements with unusually high RTT
- **Clock drift compensation**: Track and correct for device clock skew

## Calibration System

### Volume Matching Mode
- **Activation**: Toggle from ctrl client
- **Behavior**: All synth clients play pink noise at amplitude 0.1
- **User Control**: Volume slider on each synth client
- **Goal**: Match perceived loudness across all devices
- **Workflow**: 
  1. Performer enables calibration mode
  2. Audience adjusts phone volumes until balanced
  3. Performer disables calibration mode
  4. Synthesis begins

### Connection Lifecycle
- **Auto-Discovery**: Clients connect automatically on page load via signaling server
- **Handshake**: WebRTC peer connection establishment in star topology
- **Network Ready**: Ctrl shows connected peer count, synth shows "Connected - Tap to join"
- **Audio Enable**: User gesture enables AudioContext and synthesis
- **Sync**: Initial timing synchronization (when implemented)
- **Active**: Full participation in distributed synthesis

## Performance Considerations

### Real-Time Requirements
- **Audio thread isolation**: All synthesis in AudioWorklet
- **Sample-accurate timing**: Parameter changes scheduled with precision
- **Low-latency networking**: Unreliable WebRTC data channels
- **Efficient envelope calculation**: Pre-computed coefficients where possible

### Scalability
- **Target audience**: 12-24 concurrent synth clients
- **Network topology**: Star (1 ctrl + N synths = N+1 total connections)
- **Bandwidth**: Low (control data only, no audio streaming)
- **CPU usage**: Distributed synthesis reduces ctrl client load

### Failure Modes
- **Ctrl disconnect**: Synth clients wait for reconnection (no re-election)
- **Synth disconnect**: Graceful removal from star network
- **Network partitions**: Continue with local timing, resync on reconnection
- **ES-8 disconnect**: Fall back to internal timing source

## Development Phases

### Phase 1: Network Infrastructure ✅ COMPLETED
- WebRTC star topology networking
- Ctrl-master timing hierarchy
- Auto-connect functionality
- Signaling server with proper peer routing
- Basic peer connection and GUI updates

### Phase 2: Synthesis Engine
- Morphing-zing AudioWorklet implementation
- Parameter envelope system
- XY oscilloscope visualization

### Phase 3: ES-8 Integration
- WebUSB CV interface
- Cycle timing synchronization
- TR/CV output sequencing

### Phase 4: HRG System ✅ PARTIALLY COMPLETED
- ✅ **SIN notation parsing**: Implemented for frequency parameters
- ✅ **Stochastic parameter resolution**: Working with temporal behaviors
- ✅ **Compact HRG UI**: [H] toggle with numerator/denominator controls
- **Monome Grid integration**: Pending implementation

### Phase 5: Polish & Optimization
- Performance tuning
- UI refinement
- Calibration system
- Error handling and recovery

## Technical Dependencies

### Browser APIs
- **WebRTC**: Peer-to-peer networking
- **Web Audio API**: High-precision synthesis
- **AudioWorklet**: Real-time audio processing
- **WebUSB**: ES-8 hardware interface
- **Web MIDI**: Monome Grid communication

### External Libraries
- **Monome Grid utilities**: Grid interaction handling
- **WebRTC signaling**: Peer discovery coordination
- **Math libraries**: Envelope curve calculations

### Hardware Requirements
- **Ctrl Client**: Modern browser, WebUSB support, ES-8 interface
- **Synth Clients**: Modern mobile browsers with Web Audio support
- **Network**: Local Wi-Fi with reasonable bandwidth and latency

---

This specification defines a complete distributed vocal synthesis system that bridges the physical world of Eurorack control with the distributed computing power of audience devices, creating new possibilities for participatory electronic music performance.