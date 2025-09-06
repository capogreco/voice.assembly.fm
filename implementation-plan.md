# Voice.Assembly.FM Implementation Plan

## Development Strategy

This implementation plan follows a **bottom-up, risk-first approach**, tackling the most complex and uncertain technical challenges early while building a solid foundation that can support the full system architecture.

### Core Principles
- **Validate early**: Build minimal working versions of complex subsystems first
- **Iterative integration**: Each phase produces a functional, demonstrable system
- **Reference-driven**: Leverage existing code from reference projects extensively
- **Performance-conscious**: Optimize critical paths (timing, synthesis) from the start

## Phase 1: Network Infrastructure & Timing Foundation
*Duration: 2-3 weeks*

### Objectives
Build the distributed timing system that forms the backbone of the entire platform. This is the highest-risk component and must work reliably before other features can be added.

### Deliverables

#### 1.1 WebRTC Mesh Networking
- **Base**: Adapt WebRTC coordination from `string.assembly.fm/NetworkCoordinator.js`
- **Signaling server**: Simple WebSocket-based peer discovery
- **Full mesh**: Every peer connects to every other peer
- **Connection lifecycle**: Join, leave, failure detection
- **Data channels**: Unreliable, unordered configuration for timing messages

#### 1.2 Master-Slave Timing Architecture  
- **Leader election**: Score-based (RTT-minimizing) selection algorithm
- **Ping-pong protocol**: Continuous latency measurement and clock offset calculation
- **Phasor synchronization**: Shared 0.0-1.0 cycle position across network
- **Clock drift compensation**: Basic offset + skew modeling per client

#### 1.3 Basic Ctrl Client
- **Minimal UI**: Connection status, manual cycle control
- **Timing authority**: Generate master phasor, broadcast sync messages  
- **Network coordination**: Handle peer connections, leader election
- **Test interface**: Manual parameter broadcast for testing

#### 1.4 Basic Synth Client
- **Minimal UI**: "Tap to join" → connection status display
- **Timing slave**: Receive and process phasor sync messages
- **Test output**: Simple sine wave oscillator controlled by shared timing
- **Connection handling**: Auto-reconnect, graceful failure

### Success Criteria
- 12+ clients can connect in full mesh topology
- Master election works reliably with client joins/leaves
- All clients maintain synchronized phasor within ~10ms accuracy
- System recovers gracefully from master disconnection

### Technical Focus
- WebRTC data channel configuration and reliability
- Timing message protocol design and optimization
- Clock synchronization algorithm implementation
- Network failure handling and recovery

---

## Phase 2: Synthesis Engine Integration
*Duration: 2-3 weeks*

### Objectives
Port and integrate the morphing-zing synthesis engine, creating the audio generation foundation for distributed vocal synthesis.

### Deliverables

#### 2.1 Morphing-Zing AudioWorklet
- **Base**: Port from `euclidean_seq/src/frontend/morphing-zing.worklet.js`
- **Parameter system**: All synthesis parameters configurable via messages
- **Multi-channel output**: Main audio + separate formant channels for XY scope
- **Real-time scheduling**: Parameter changes synchronized to AudioContext.currentTime

#### 2.2 Parameter Envelope System
- **Implementation**: Both "lin" and "cos" envelope types from `reference/envelopes.md`
- **Real-time calculation**: Efficient per-sample envelope processing
- **AudioWorklet integration**: Envelope parameters passed from main thread
- **Cycle synchronization**: Envelopes triggered and timed to network phasor

#### 2.3 Enhanced Synth Client  
- **Audio synthesis**: Full morphing-zing engine with parameter control
- **XY oscilloscope**: Real-time visualization of first two formant outputs
- **Parameter application**: Receive parameter updates from ctrl client
- **Volume control**: User-adjustable output level for calibration

#### 2.4 Enhanced Ctrl Client
- **Parameter interface**: GUI controls for all synthesis parameters
- **Broadcast system**: Send parameter updates to all connected synth clients
- **Real-time control**: Live parameter modification during performance
- **Envelope configuration**: Per-parameter envelope type and intensity settings

### Success Criteria
- All clients generate rich, controllable vocal synthesis sounds
- Parameter changes propagate across network in real-time
- XY oscilloscope displays clear, synchronized formant visualizations
- Envelope system provides smooth parameter transitions over cycles

### Technical Focus  
- AudioWorklet performance optimization
- Parameter serialization and network transmission
- Envelope calculation efficiency
- Audio visualization and real-time graphics

---

## Phase 3: ES-8 Hardware Integration
*Duration: 2-3 weeks*

### Objectives
Connect the software system to the physical Eurorack environment, establishing the ES-8 as the authoritative timing source and implementing CV I/O.

### Deliverables

#### 3.1 WebUSB ES-8 Interface
- **Base**: Adapt from `es_8_test/src/frontend/audio.js` and related files
- **CV input**: Read channels 7 (clock pulses) and 8 (cycle ramp)
- **CV output**: Write channels 1-6 (TR/CV sequencer) + echo channels 7-8
- **Calibration**: Voltage scaling and offset calibration interface

#### 3.2 Hardware Timing Authority
- **ES-8 timing**: Channel 8 ramp becomes authoritative cycle position
- **Clock processing**: Channel 7 pulses trigger subdivision events  
- **Phasor sync**: Network phasor locked to ES-8 cycle timing
- **Fallback handling**: Software timing when ES-8 disconnected

#### 3.3 CV Output Integration
- **Sequencer engine**: Port minimalist TR/CV functionality from es_8_test
- **Pattern management**: GUI for programming output patterns
- **Real-time output**: CV generation synchronized to master timing
- **Modular compatibility**: Standard Eurorack voltage ranges and timing

#### 3.4 Ctrl Client Hardware UI
- **ES-8 status**: Connection, calibration, and channel monitoring
- **Cycle control**: Hardware-driven cycle length and subdivision display
- **CV sequencer**: Pattern programming interface for output channels
- **Integration testing**: Verify timing accuracy with external clock sources

### Success Criteria
- ES-8 provides stable, accurate timing authority for network
- CV outputs work reliably with standard Eurorack modules
- System maintains sync accuracy even with hardware timing source
- Ctrl client displays accurate hardware status and control

### Technical Focus
- WebUSB API integration and reliability
- Hardware timing synchronization algorithms
- CV generation and calibration procedures
- Real-time system performance with hardware I/O

---

## Phase 4: HRG System & Monome Integration
*Duration: 2-3 weeks*

### Objectives
Implement the sophisticated stochastic harmonic control system, providing the musical intelligence that creates interesting distributed harmonic relationships.

### Deliverables

#### 4.1 SIN Processing Engine
- **Base**: Adapt from `string.assembly.fm/public/js/modules/ui/HarmonicRatioSelector.js`
- **Parser**: "1-3, 4, 7-9" → [1, 2, 3, 4, 7, 8, 9] conversion
- **Behaviors**: static, ascending, descending, shuffle, random iteration
- **Ratio generation**: Integer pairs → harmonic frequency ratios

#### 4.2 Stochastic Parameter Resolution
- **Ctrl-side processing**: HRG resolution happens on ctrl client
- **Harmonic distribution**: Intelligent assignment of ratios to connected synths
- **Musical spacing**: Avoid clustering, ensure good harmonic relationships
- **Live reassignment**: Ability to redistribute harmonics during performance

#### 4.3 Monome Grid Integration
- **Base**: Reference monome integration patterns from `reference/arc_test`
- **Grid mapping**: 4 rows for HRG control (frequency start/end numerator/denominator)
- **SIN editing**: Visual interface for toggling integers, setting ranges
- **Navigation system**: Page management for different parameter groups
- **Visual feedback**: LED patterns showing active HRG states

#### 4.4 Enhanced Parameter System
- **HRG application**: Frequency parameters get stochastic harmonic variation
- **Per-synth variation**: Each connected synth gets unique parameter values
- **Real-time updates**: HRG changes propagate immediately to network
- **Visualization**: Display of harmonic distribution across synth clients

### Success Criteria
- HRG system generates musically interesting harmonic relationships
- Monome Grid provides intuitive, real-time control of SIN sets
- Each synth client gets unique but harmonically-related parameters
- System supports live editing of harmonic relationships during performance

### Technical Focus
- Stochastic algorithm implementation and optimization
- Monome Grid communication protocols
- Real-time parameter resolution and distribution
- Musical harmony and spacing algorithms

---

## Phase 5: Calibration & Polish
*Duration: 2-3 weeks*

### Objectives
Complete the system with calibration tools, user experience refinements, and performance optimizations that make the platform ready for live performance.

### Deliverables

#### 5.1 Volume Calibration System
- **Calibration mode**: All synths play pink noise at controlled amplitude
- **User controls**: Per-device volume adjustment interface
- **Visual feedback**: Level meters and balance indicators
- **Workflow integration**: Seamless transition from calibration to performance

#### 5.2 Connection Management
- **Robust networking**: Enhanced error handling and recovery
- **Connection visualization**: Clear status display for all connected clients
- **Graceful degradation**: System continues functioning with partial connectivity
- **Performance monitoring**: Latency, jitter, and connection quality metrics

#### 5.3 User Experience Polish
- **Ctrl client refinement**: Streamlined interface, better organization
- **Synth client optimization**: Smooth animations, responsive touch handling
- **Visual design**: Cohesive aesthetic across all interfaces
- **Accessibility**: Touch targets, contrast, usability improvements

#### 5.4 Performance Optimization
- **Network efficiency**: Message compression, bandwidth optimization
- **Audio performance**: AudioWorklet optimization, memory management
- **Battery life**: Mobile power consumption optimization
- **Scalability testing**: Verify performance with maximum client count

#### 5.5 Documentation & Testing
- **User guides**: Setup and operation documentation
- **Technical documentation**: API references, architecture diagrams
- **Test coverage**: Automated tests for critical functionality
- **Performance testing**: Load testing, timing accuracy validation

### Success Criteria
- System works reliably in live performance conditions
- Calibration process is quick and intuitive for audience members
- All interfaces are polished and professional-quality
- Performance is stable with 20+ concurrent clients

### Technical Focus
- System reliability and error recovery
- User interface design and usability
- Performance profiling and optimization
- Documentation and testing infrastructure

---

## Implementation Guidelines

### Code Organization
```
src/
├── common/               # Shared utilities and constants
│   ├── message-protocol.js    # Network message formats
│   ├── timing-math.js         # Synchronization calculations  
│   └── audio-constants.js     # Sample rates, buffer sizes, etc.
├── ctrl/                 # Ctrl client (performer interface)
│   ├── network/          # WebRTC management, leader election
│   ├── hardware/         # ES-8 interface, CV I/O
│   ├── ui/               # GUI components, parameter controls
│   └── hrg/              # HRG resolution, Monome Grid
├── synth/                # Synth client (audience interface)
│   ├── synthesis/        # AudioWorklet, envelope processing
│   ├── network/          # Timing sync, parameter reception
│   └── ui/               # Minimal UI, oscilloscope
└── server/               # Signaling server
    └── signaling.js      # WebSocket peer discovery
```

### Development Environment
- **Node.js/Deno**: Server runtime for signaling and development tools
- **Modern browsers**: Chrome/Edge for WebUSB, Firefox for testing
- **Hardware**: ES-8 interface, Monome Grid 128, Eurorack system
- **Testing devices**: Multiple phones/tablets for network testing

### Quality Assurance
- **Real-time testing**: Verify timing accuracy with audio analysis tools
- **Network stress testing**: Simulate poor network conditions, dropouts
- **Hardware integration**: Test with multiple Eurorack configurations
- **Cross-browser compatibility**: Ensure consistent behavior across platforms
- **Performance profiling**: Monitor CPU, memory, and battery usage

### Risk Mitigation
- **Phase dependencies**: Each phase builds working system; failure doesn't block progress
- **Reference code**: Extensive reuse of proven implementations reduces implementation risk
- **Hardware fallbacks**: System works without ES-8 or Monome for testing/development
- **Incremental testing**: Continuous integration testing throughout development

### Success Metrics
- **Timing accuracy**: <10ms synchronization across all clients
- **Network reliability**: >95% uptime with graceful failure recovery  
- **User experience**: <30 second setup time for audience members
- **Performance**: Stable operation with 24 concurrent clients for >30 minutes
- **Musical quality**: Rich, harmonically interesting distributed vocal synthesis

This implementation plan provides a structured path from initial networking experiments to a complete, performance-ready distributed synthesis platform, with each phase building on the previous while maintaining focus on the core technical challenges that make this system unique.