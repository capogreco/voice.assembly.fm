/**
 * Voice.Assembly.FM Control Client Main Application
 */

import { WebRTCStar, generatePeerId } from '../../src/common/webrtc-star.js';
import { MessageTypes, MessageBuilder } from '../../src/common/message-protocol.js';
import { IMusicalState, ParameterState, GeneratorConfig } from '../../src/common/parameter-types.ts';

// Define action types for state management
type ControlAction = 
  | { type: 'SET_SCOPE'; param: keyof IMusicalState; scope: 'direct' | 'program' }
  | { type: 'SET_DIRECT_VALUE'; param: keyof IMusicalState; value: number }
  | { type: 'SET_INTERPOLATION'; param: keyof IMusicalState; interpolation: 'step' | 'linear' | 'cosine' | 'parabolic' }
  | { type: 'SET_INTENSITY'; param: keyof IMusicalState; intensity: number }
  | { type: 'SET_GENERATOR_CONFIG'; param: keyof IMusicalState; position: 'start' | 'end'; config: GeneratorConfig };

class ControlClient {
  // Typed state management
  musicalState: IMusicalState;
  pendingMusicalState: IMusicalState;
  star: any; // WebRTC star connection
  forceTakeover: boolean;
  peerId: string;
  isCalibrationMode: boolean;
  calibrationAmplitude: number;
  phasor: number;
  cpm: number;
  stepsPerCycle: number;
  cycleLength: number;
  lastPhasorTime: number;
  phasorUpdateId: any;
  lastBroadcastTime: number;
  phasorBroadcastRate: number;
  audioContext: any;
  es8Enabled: boolean;
  es8Node: any;
  hasPendingChanges: boolean;
  elements: any;

  private _createDefaultState(): IMusicalState {
    // Helper for a default normalised generator
    const defaultNormalisedGenerator = (): GeneratorConfig => ({
      type: 'normalised',
      range: 0.5,
      sequenceBehavior: 'static'
    });

    // Helper for a default periodic generator 
    const defaultPeriodicGenerator = (): GeneratorConfig => ({
      type: 'periodic',
      numerators: '1',
      denominators: '1', 
      sequenceBehavior: 'static'
    });

    // Helper for a default direct state
    const defaultDirectState = (value: number): ParameterState => ({
      scope: 'direct',
      directValue: value
    });
    
    return {
      frequency: { scope: 'direct', directValue: 220 },
      vowelX: defaultDirectState(0.5),
      vowelY: defaultDirectState(0.5),
      zingAmount: defaultDirectState(0.1),
      zingMorph: defaultDirectState(0.5),
      symmetry: defaultDirectState(0.5),
      amplitude: defaultDirectState(0.8)
    };
  }

  private _updatePendingState(action: ControlAction) {
    console.log('Action dispatched:', action);
    
    // Create a deep copy of current pending state
    const newState = JSON.parse(JSON.stringify(this.pendingMusicalState));
    
    switch (action.type) {
      case 'SET_SCOPE': {
        if (action.scope === 'direct') {
          // Convert to direct mode - keep the current value if possible
          const currentParam = newState[action.param];
          const directValue = currentParam.scope === 'direct' 
            ? currentParam.directValue 
            : 220; // Default fallback
          
          newState[action.param] = {
            scope: 'direct',
            directValue
          };
        } else {
          // Convert to program mode - preserve current directValue for baseValue
          const currentParam = newState[action.param];
          const directValue = currentParam.scope === 'direct' 
            ? currentParam.directValue 
            : (action.param === 'frequency' ? 220 : 0.5); // Fallback defaults
            
          newState[action.param] = {
            scope: 'program',
            interpolation: 'step', // Default to step (constant values)
            directValue, // Preserve for use as baseValue
            startValueGenerator: action.param === 'frequency' 
              ? { type: 'periodic', numerators: '1', denominators: '1', sequenceBehavior: 'static', baseValue: directValue }
              : { type: 'normalised', range: 0.5, sequenceBehavior: 'static' }
          };
        }
        break;
      }
      
      case 'SET_DIRECT_VALUE': {
        const param = newState[action.param];
        if (param.scope === 'direct') {
          param.directValue = action.value;
        }
        break;
      }
      
      case 'SET_INTERPOLATION': {
        const param = newState[action.param];
        if (param.scope === 'program') {
          if (action.interpolation === 'step') {
            // Step interpolation - only needs start generator
            newState[action.param] = {
              scope: 'program',
              interpolation: 'step',
              directValue: param.directValue,
              startValueGenerator: param.startValueGenerator
            };
          } else {
            // Linear/cosine/parabolic interpolation - needs start and end generators
            newState[action.param] = {
              scope: 'program',
              interpolation: action.interpolation,
              directValue: param.directValue,
              startValueGenerator: param.startValueGenerator,
              endValueGenerator: param.endValueGenerator || {
                ...param.startValueGenerator // Copy start generator as default
              },
              intensity: param.intensity ?? 0.5
            };
          }
        }
        break;
      }
      
      case 'SET_INTENSITY': {
        const param = newState[action.param];
        if (param.scope === 'program' && param.interpolation !== 'step') {
          param.intensity = action.intensity;
        }
        break;
      }
      
      case 'SET_GENERATOR_CONFIG': {
        const param = newState[action.param];
        if (param.scope === 'program') {
          if (action.position === 'start') {
            // Merge config properties into existing generator
            param.startValueGenerator = { 
              ...param.startValueGenerator, 
              ...action.config 
            };
            // Update baseValue if this is a periodic generator
            if (param.startValueGenerator.type === 'periodic') {
              param.startValueGenerator.baseValue = param.directValue;
            }
          } else if (action.position === 'end' && param.interpolation !== 'step' && param.endValueGenerator) {
            // Merge config properties into existing generator
            param.endValueGenerator = { 
              ...param.endValueGenerator, 
              ...action.config 
            };
            // Update baseValue if this is a periodic generator
            if (param.endValueGenerator.type === 'periodic') {
              param.endValueGenerator.baseValue = param.directValue;
            }
          }
        }
        break;
      }
    }
    
    this.pendingMusicalState = newState;
    this.markPendingChanges();
  }

  /**
   * Apply a single direct parameter immediately and broadcast it
   * Used for immediate feedback when user leaves an input field in direct mode
   */
  private _applyDirectParameter(param: keyof IMusicalState) {
    const paramState = this.pendingMusicalState[param];
    
    // Only proceed if parameter is in direct mode
    if (paramState.scope !== 'direct') {
      return;
    }
    
    // Commit this parameter from pending to main state
    this.musicalState[param] = JSON.parse(JSON.stringify(paramState));
    
    // Log for debugging
    console.log(`📍 Applying direct parameter: ${param} = ${paramState.directValue}`);
    this.log(`Direct broadcast: ${param} = ${paramState.directValue}`, 'info');
    
    // Broadcast just this parameter update using dedicated message type
    if (this.star) {
      const message = MessageBuilder.directParamUpdate(param, paramState.directValue);
      this.star.broadcastToType('synth', message, 'control');
    }
  }

  constructor() {
    console.log('ControlClient constructor starting');
    // Check for force takeover mode
    const urlParams = new URLSearchParams(window.location.search);
    this.forceTakeover = urlParams.get('force') === 'true';
    
    this.peerId = generatePeerId('ctrl');
    this.star = null;
    this.isCalibrationMode = false;
    // Moved to this.synthesisActive (defined in state management section)
    
    // Calibration settings
    this.calibrationAmplitude = 0.1;
    
    // Phasor state
    this.phasor = 0.0;              // Current phasor position (0.0 to 1.0)
    this.cpm = 30;                  // Cycles per minute
    this.stepsPerCycle = 16;        // Number of steps per cycle
    this.cycleLength = 2.0;         // Seconds per cycle (calculated from CPM)
    this.lastPhasorTime = 0;        // For delta time calculation
    this.phasorUpdateId = null;     // RequestAnimationFrame ID
    this.lastBroadcastTime = 0;     // For phasor broadcast rate limiting
    this.phasorBroadcastRate = 30;  // Hz - how often to broadcast phasor
    
    // ES-8 Integration
    this.audioContext = null;       // AudioContext for ES-8 CV output
    this.es8Enabled = false;        // Enable/disable ES-8 output
    this.es8Node = null;            // ES-8 AudioWorklet node
    
    // Parameter staging for EOC application
    this.hasPendingChanges = false; // Track if there are pending parameter changes
    
    // Centralized State Management - replaced old program/directState with typed state
    
    // Synthesis active state
    this.synthesisActive = false;
    
    // Initialize typed state management
    this.musicalState = this._createDefaultState();
    this.pendingMusicalState = this._createDefaultState();
    
    // UI Elements
    this.elements = {
      connectionStatus: document.getElementById('connection-status'),
      connectionValue: document.getElementById('connection-value'),
      peersStatus: document.getElementById('peers-status'),
      peersValue: document.getElementById('peers-value'),
      
      calibrationBtn: document.getElementById('calibration-btn'),
      manualModeBtn: document.getElementById('manual-mode-btn'),
      
      // Musical controls
      // Simplified musical controls
      frequencyValue: document.getElementById('frequency-value'),
      
      // Phasor controls
      cpmSlider: document.getElementById('cpm-slider'),
      cpmValue: document.getElementById('cpm-value'),
      stepsPerCycleSlider: document.getElementById('steps-per-cycle-slider'),
      stepsPerCycleValue: document.getElementById('steps-per-cycle-value'),
      phasorDisplay: document.getElementById('phasor-display'),
      phasorBar: document.getElementById('phasor-bar'),
      
      // ES-8 controls
      es8EnableBtn: document.getElementById('es8-enable-btn'),
      
      // Parameter controls
      applyParamsBtn: document.getElementById('apply-params-btn'),
      
      peerList: document.getElementById('peer-list'),
      debugLog: document.getElementById('debug-log'),
      clearLogBtn: document.getElementById('clear-log-btn')
    };
    
    console.log('applyParamsBtn element:', this.elements.applyParamsBtn);
    
    this.setupEventHandlers();
    this.calculateCycleLength();
    this.initializePhasor();
    this.log('Control client initialized', 'info');
    
    // Auto-connect on page load
    this.connectToNetwork();
  }


  setupEventHandlers() {
    console.log('Setting up handlers, button exists:', !!this.elements.applyParamsBtn);
    
    // Calibration
    this.elements.calibrationBtn.addEventListener('click', () => this.toggleCalibration());
    
    // Manual mode
    this.elements.manualModeBtn.addEventListener('click', () => this.toggleSynthesis());
    
    // Debug log
    this.elements.clearLogBtn.addEventListener('click', () => this.clearLog());
    
    // Apply button
    this.elements.applyParamsBtn.addEventListener('click', () => {
      console.log('Apply Parameter Changes button clicked!');
      this.applyParameterChanges();
    });
    
    // Musical controls
    this.setupMusicalControls();
  }
  
  setupMusicalControls() {
    // Note: All synthesis parameters are now handled by setupEnvelopeControls()
    
    // Envelope controls for all parameters that support them
    this.setupEnvelopeControls();
    
    // CPM slider
    if (this.elements.cpmSlider) {
      this.elements.cpmSlider.addEventListener('input', (e) => {
        this.cpm = parseFloat(e.target.value);
        this.elements.cpmValue.textContent = `${this.cpm} CPM`;
        this.calculateCycleLength();
        this.log(`CPM changed to ${this.cpm}`, 'info');
      });
    }
    
    // Steps per cycle slider
    if (this.elements.stepsPerCycleSlider) {
      this.elements.stepsPerCycleSlider.addEventListener('input', (e) => {
        this.stepsPerCycle = parseFloat(e.target.value);
        this.elements.stepsPerCycleValue.textContent = `${this.stepsPerCycle} steps`;
        this.log(`Steps per cycle changed to ${this.stepsPerCycle}`, 'info');
      });
    }
    
    // ES-8 enable button
    if (this.elements.es8EnableBtn) {
      this.elements.es8EnableBtn.addEventListener('click', () => this.toggleES8());
    }
    
    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Cmd+Enter (Mac) or Ctrl+Enter (PC) triggers Send Program
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        this.log('⌨️ Cmd+Enter pressed', 'info');
        this.log(`  applyParamsBtn exists: ${!!this.elements.applyParamsBtn}`, 'info');
        this.log(`  applyParamsBtn disabled: ${this.elements.applyParamsBtn?.disabled}`, 'info');
        
        if (this.elements.applyParamsBtn && !this.elements.applyParamsBtn.disabled) {
          e.preventDefault();
          this.log('⌨️ Calling applyParameterChanges()', 'info');
          this.applyParameterChanges();
        } else {
          this.log('⌨️ Button check failed - not calling applyParameterChanges()', 'info');
        }
      }
    });
  }

  setupEnvelopeControls() {
    // All parameters now use the new compact format
    
    // Setup compact parameter controls (new format)
    this.setupCompactParameterControls('frequency');
    this.setupCompactParameterControls('vowelX');
    this.setupCompactParameterControls('vowelY');
    this.setupCompactParameterControls('zingAmount');
    this.setupCompactParameterControls('zingMorph');
    this.setupCompactParameterControls('symmetry');
    this.setupCompactParameterControls('amplitude');
  }

  setupParameterEnvelopeControls(paramName, suffix, precision) {
    // Get elements
    const staticCheckbox = document.getElementById(`${paramName}-static`);
    const envelopeSection = document.getElementById(`${paramName}-envelope`);
    const envelopeControl = staticCheckbox.closest('.envelope-control');
    const intensitySlider = document.getElementById(`${paramName}-intensity`);
    const intensityValue = document.getElementById(`${paramName}-intensity-value`);
    
    // Setup dual-handle sliders for both start and end values
    this.setupDualRangeSlider(paramName, 'start', precision);
    this.setupDualRangeSlider(paramName, 'end', precision);
    
    // Static checkbox - controls mode of both sliders
    staticCheckbox.addEventListener('change', () => {
      const isStatic = staticCheckbox.checked;
      envelopeSection.style.display = isStatic ? 'none' : 'block';
      
      // Toggle both sliders between static and range mode
      const startSlider = document.querySelector(`[data-param="${paramName}"][data-type="start"]`);
      const endSlider = document.querySelector(`[data-param="${paramName}"][data-type="end"]`);
      
      if (isStatic) {
        startSlider.dataset.mode = 'static';
        if (endSlider) endSlider.dataset.mode = 'static';
        envelopeControl.classList.remove('envelope-active');
      } else {
        // Legacy range mode checking - now handled by compact controls
        const startHasRange = false;
        const endHasRange = false;
        
        startSlider.dataset.mode = startHasRange ? 'range' : 'static';
        if (endSlider) endSlider.dataset.mode = endHasRange ? 'range' : 'static';
        envelopeControl.classList.add('envelope-active');
      }
      
      // Update visual displays
      this.updateDualSliderDisplay(paramName, 'start', precision);
      this.updateDualSliderDisplay(paramName, 'end', precision);
      
      // Update pendingMusicalState based on mode
      if (isStatic) {
        // Static mode - use current start value as single value
        const startMinHandle = startSlider.querySelector('.range-min');
        if (startMinHandle) {
          this.pendingMusicalState[paramName] = parseFloat(startMinHandle.value);
        }
      } else {
        // Envelope mode - create envelope object
        const startMinHandle = startSlider.querySelector('.range-min');
        const endMinHandle = endSlider?.querySelector('.range-min');
        const intensitySlider = document.getElementById(`${paramName}-intensity`);
        
        // Get envelope type from radio buttons
        const envTypeRadio = document.querySelector(`input[name="${paramName}-env-type"]:checked`);
        
        this.pendingMusicalState[paramName] = {
          static: false,
          startValue: startMinHandle ? parseFloat(startMinHandle.value) : 0,
          endValue: endMinHandle ? parseFloat(endMinHandle.value) : 0,
          envType: envTypeRadio ? envTypeRadio.value : 'lin',
          intensity: intensitySlider ? parseFloat(intensitySlider.value) : 0.5
        };
      }
      
      this.markPendingChanges();
    });
    
    // Initialize visibility based on current checkbox state
    const isStatic = staticCheckbox.checked;
    envelopeSection.style.display = isStatic ? 'none' : 'block';
    if (!isStatic) {
      envelopeControl.classList.add('envelope-active');
    }
    
    // Initialize sliders
    this.updateDualSliderDisplay(paramName, 'start', precision);
    this.updateDualSliderDisplay(paramName, 'end', precision);
    
    // Intensity slider - update state
    intensitySlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      intensityValue.textContent = value.toFixed(2);
      
      // Update pendingMusicalState if in envelope mode
      if (!staticCheckbox.checked && typeof this.pendingMusicalState[paramName] === 'object') {
        this.pendingMusicalState[paramName].intensity = value;
      }
      
      this.markPendingChanges();
    });
    
    // Envelope type radio buttons - update state
    document.querySelectorAll(`input[name="${paramName}-env-type"]`).forEach(radio => {
      radio.addEventListener('change', () => {
        // Update pendingMusicalState if in envelope mode
        if (!staticCheckbox.checked && typeof this.pendingMusicalState[paramName] === 'object') {
          this.pendingMusicalState[paramName].envType = radio.value;
        }
        
          this.markPendingChanges();
      });
    });
    
  }

  setupCompactParameterControls(paramName) {
    // Get the new compact control elements
    const modeSelect = document.getElementById(`${paramName}-mode`);
    const interpSelect = document.getElementById(`${paramName}-interpolation`);
    const textInput = document.getElementById(`${paramName}-value`);
    
    // Get inline control elements based on parameter type
    const startHrg = document.getElementById(`${paramName}-start-hrg`);
    const endHrg = document.getElementById(`${paramName}-end-hrg`);
    const endValueInput = document.getElementById(`${paramName}-end-value`);
    const intensityInput = document.getElementById(`${paramName}-intensity`);
    
    if (!modeSelect) return;
    
    // Handle direct/program mode changes
    modeSelect.addEventListener('change', () => {
      const isDirect = modeSelect.value === 'direct';
      
      // Dispatch action to update state
      this._updatePendingState({
        type: 'SET_SCOPE',
        param: paramName as keyof IMusicalState,
        scope: isDirect ? 'direct' : 'program'
      });
      
      // Update UI visibility
      if (isDirect) {
        // Direct mode: hide program controls
        if (interpSelect) interpSelect.style.display = 'none';
        if (startHrg) startHrg.style.display = 'none';
        if (endHrg) endHrg.style.display = 'none';
        if (endValueInput) endValueInput.style.display = 'none';
        if (intensityInput) intensityInput.style.display = 'none';
      } else {
        // Program mode: show interpolation select and appropriate controls
        if (interpSelect) interpSelect.style.display = 'inline';
        this._updateInterpolationUI(paramName);
      }
      
      console.log(`🔧 Set ${paramName} scope to: ${modeSelect.value}`);
    });
    
    // Handle interpolation changes
    if (interpSelect) {
      interpSelect.addEventListener('change', () => {
        const interpolation = interpSelect.value as 'step' | 'linear' | 'cosine' | 'parabolic';
        
        // Dispatch interpolation change
        this._updatePendingState({
          type: 'SET_INTERPOLATION',
          param: paramName,
          interpolation: interpolation
        });
        
        // Update UI visibility based on interpolation type
        this._updateInterpolationUI(paramName);
        
        console.log(`🎛️ Set ${paramName} interpolation to: ${interpolation}`);
        this.markPendingChanges();
      });
    }

    // Handle end value input changes
    if (endValueInput) {
      endValueInput.addEventListener('input', () => {
        this._handleValueInput(paramName, endValueInput.value, 'end');
        this.markPendingChanges();
      });
    }
    
    // Handle text input changes
    if (textInput) {
      textInput.addEventListener('input', () => {
        this._handleValueInput(paramName, textInput.value, 'start');
        this.markPendingChanges();
      });
      
      // Handle blur for immediate broadcast in direct mode
      textInput.addEventListener('blur', () => {
        if (modeSelect && modeSelect.value === 'direct') {
          // Apply and broadcast this single direct parameter
          this._applyDirectParameter(paramName as keyof IMusicalState);
        }
      });
    }

    // Handle intensity input changes
    if (intensityInput) {
      intensityInput.addEventListener('input', () => {
        const intensity = parseFloat(intensityInput.value) || 0.5;
        this._updatePendingState({
          type: 'SET_INTENSITY',
          param: paramName,
          intensity: intensity
        });
        this.markPendingChanges();
      });
    }
    
    // Add input handlers for HRG fields (frequency only)
    if (paramName === 'frequency') {
      // Start HRG inputs
      const startNumeratorsInput = document.getElementById('frequency-start-numerators');
      const startDenominatorsInput = document.getElementById('frequency-start-denominators');
      const startNumBehaviorSelect = document.getElementById('frequency-start-numerators-behavior');
      const startDenBehaviorSelect = document.getElementById('frequency-start-denominators-behavior');
      
      if (startNumeratorsInput) {
        startNumeratorsInput.addEventListener('input', () => {
          this._updatePendingState({
            type: 'SET_GENERATOR_CONFIG',
            param: 'frequency',
            position: 'start',
            config: { numerators: startNumeratorsInput.value }
          });
          this.markPendingChanges();
        });
      }
      
      if (startDenominatorsInput) {
        startDenominatorsInput.addEventListener('input', () => {
          this._updatePendingState({
            type: 'SET_GENERATOR_CONFIG',
            param: 'frequency',
            position: 'start',
            config: { denominators: startDenominatorsInput.value }
          });
          this.markPendingChanges();
        });
      }
      
      if (startNumBehaviorSelect) {
        startNumBehaviorSelect.addEventListener('change', () => {
          this._updatePendingState({
            type: 'SET_GENERATOR_CONFIG',
            param: 'frequency',
            position: 'start',
            config: { sequenceBehavior: startNumBehaviorSelect.value }
          });
          this.markPendingChanges();
        });
      }
      
      if (startDenBehaviorSelect) {
        startDenBehaviorSelect.addEventListener('change', () => {
          this._updatePendingState({
            type: 'SET_GENERATOR_CONFIG',
            param: 'frequency',
            position: 'start',
            config: { sequenceBehavior: startDenBehaviorSelect.value }
          });
          this.markPendingChanges();
        });
      }
      
      // End HRG inputs
      const endNumeratorsInput = document.getElementById('frequency-end-numerators');
      const endDenominatorsInput = document.getElementById('frequency-end-denominators');
      const endNumBehaviorSelect = document.getElementById('frequency-end-numerators-behavior');
      const endDenBehaviorSelect = document.getElementById('frequency-end-denominators-behavior');
      
      if (endNumeratorsInput) {
        endNumeratorsInput.addEventListener('input', () => {
          this._updatePendingState({
            type: 'SET_GENERATOR_CONFIG',
            param: 'frequency',
            position: 'end',
            config: { numerators: endNumeratorsInput.value }
          });
          this.markPendingChanges();
        });
      }
      
      if (endDenominatorsInput) {
        endDenominatorsInput.addEventListener('input', () => {
          this._updatePendingState({
            type: 'SET_GENERATOR_CONFIG',
            param: 'frequency',
            position: 'end',
            config: { denominators: endDenominatorsInput.value }
          });
          this.markPendingChanges();
        });
      }
      
      if (endNumBehaviorSelect) {
        endNumBehaviorSelect.addEventListener('change', () => {
          this._updatePendingState({
            type: 'SET_GENERATOR_CONFIG',
            param: 'frequency',
            position: 'end',
            config: { sequenceBehavior: endNumBehaviorSelect.value }
          });
          this.markPendingChanges();
        });
      }
      
      if (endDenBehaviorSelect) {
        endDenBehaviorSelect.addEventListener('change', () => {
          this._updatePendingState({
            type: 'SET_GENERATOR_CONFIG',
            param: 'frequency',
            position: 'end',
            config: { sequenceBehavior: endDenBehaviorSelect.value }
          });
          this.markPendingChanges();
        });
      }
    }
    
    // Initialize UI to reflect the current typed state
    this._updateUIFromState(paramName);
    const initialMode = modeSelect.value;
    if (initialMode === 'direct') {
      if (interpSelect) interpSelect.style.display = 'none';
      if (startHrg) startHrg.style.display = 'none';
      if (endHrg) endHrg.style.display = 'none';
      if (endValueInput) endValueInput.style.display = 'none';
      if (intensityInput) intensityInput.style.display = 'none';
    } else {
      if (interpSelect) interpSelect.style.display = 'inline';
      this._updateInterpolationUI(paramName);
    }
  }

  /**
   * Handle value input changes with smart range detection
   */
  private _handleValueInput(paramName: string, inputValue: string, position: 'start' | 'end') {
    const modeSelect = document.getElementById(`${paramName}-mode`) as HTMLSelectElement;
    const currentMode = modeSelect?.value || 'direct';
    const trimmedValue = inputValue.trim();
    
    // Auto-switch to program mode if range detected
    if (trimmedValue.includes('-') && currentMode === 'direct') {
      modeSelect.value = 'program';
      modeSelect.dispatchEvent(new Event('change'));
      // The mode change will trigger UI updates
      return;
    }
    
    if (currentMode === 'direct') {
      // Parse direct value from input
      let directValue;
      if (trimmedValue.includes('-')) {
        // Range format: use average of range
        const [min, max] = trimmedValue.split('-').map(v => parseFloat(v.trim()));
        if (!isNaN(min) && !isNaN(max)) {
          directValue = (min + max) / 2;
        }
      } else {
        // Single value format
        const value = parseFloat(trimmedValue);
        if (!isNaN(value)) {
          directValue = value;
        }
      }
      
      if (directValue !== undefined) {
        this._updatePendingState({
          type: 'SET_DIRECT_VALUE',
          param: paramName,
          value: directValue
        });
      }
    } else {
      // Program mode: update generator configuration based on value type
      this._updateProgramGenerator(paramName, trimmedValue, position);
    }
  }

  /**
   * Update program generator based on input value (single value or range)
   */
  private _updateProgramGenerator(paramName: string, inputValue: string, position: 'start' | 'end') {
    if (inputValue.includes('-')) {
      // Range format: create RBG generator
      const [min, max] = inputValue.split('-').map(v => parseFloat(v.trim()));
      if (!isNaN(min) && !isNaN(max)) {
        this._updatePendingState({
          type: 'SET_GENERATOR_CONFIG',
          param: paramName,
          position: position,
          config: {
            type: 'normalised',
            range: { min: Math.min(min, max), max: Math.max(min, max) },
            sequenceBehavior: 'static'
          }
        });
      }
    } else {
      // Single value: create constant generator
      const value = parseFloat(inputValue);
      if (!isNaN(value)) {
        this._updatePendingState({
          type: 'SET_GENERATOR_CONFIG', 
          param: paramName,
          position: position,
          config: {
            type: 'normalised',
            range: value,
            sequenceBehavior: 'static'
          }
        });
      }
    }
  }

  /**
   * Update UI visibility based on current interpolation type
   */
  private _updateInterpolationUI(paramName: string) {
    const paramState = this.pendingMusicalState[paramName as keyof IMusicalState];
    if (paramState.scope !== 'program') return;
    
    const startHrg = document.getElementById(`${paramName}-start-hrg`);
    const endHrg = document.getElementById(`${paramName}-end-hrg`);
    const endValueInput = document.getElementById(`${paramName}-end-value`);
    const intensityInput = document.getElementById(`${paramName}-intensity`);
    
    if (paramState.interpolation === 'step') {
      // Step interpolation: only show start controls
      if (startHrg) startHrg.style.display = 'inline';
      if (endHrg) endHrg.style.display = 'none';
      if (endValueInput) endValueInput.style.display = 'none';
      if (intensityInput) intensityInput.style.display = 'none';
    } else {
      // Linear/cosine/parabolic interpolation: show both start and end controls
      if (startHrg) startHrg.style.display = 'inline';
      if (endHrg) endHrg.style.display = 'inline';
      if (endValueInput) endValueInput.style.display = 'inline';
      
      // Show intensity input for parabolic interpolation
      if (intensityInput) {
        intensityInput.style.display = paramState.interpolation === 'parabolic' ? 'inline' : 'none';
      }
    }
  }

  /**
   * Update UI elements to reflect the current typed state
   * This is the reverse of the old DOM-based state management
   * State is now the master, UI is just a reflection of it
   */
  private _updateUIFromState(paramName: keyof IMusicalState) {
    const paramState = this.pendingMusicalState[paramName];
    
    // Update mode select
    const modeSelect = document.getElementById(`${paramName}-mode`) as HTMLSelectElement;
    if (modeSelect) {
      modeSelect.value = paramState.scope;
    }
    
    // Update interpolation select
    const interpSelect = document.getElementById(`${paramName}-interpolation`) as HTMLSelectElement;
    if (interpSelect && paramState.scope === 'program') {
      interpSelect.value = paramState.interpolation;
    }
    
    // Update UI based on scope
    if (paramState.scope === 'direct') {
      // Update text input with direct value
      const textInput = document.getElementById(`${paramName}-value`) as HTMLInputElement;
      if (textInput) {
        textInput.value = paramState.directValue.toString();
      }
      
      // Hide program-mode elements
      if (interpSelect) interpSelect.style.display = 'none';
      const startHrg = document.getElementById(`${paramName}-start-hrg`);
      const endHrg = document.getElementById(`${paramName}-end-hrg`);
      const startRbg = document.getElementById(`${paramName}-start-rbg`);
      const endRbg = document.getElementById(`${paramName}-end-rbg`);
      if (startHrg) startHrg.style.display = 'none';
      if (endHrg) endHrg.style.display = 'none';
      if (startRbg) startRbg.style.display = 'none';
      if (endRbg) endRbg.style.display = 'none';
      
    } else if (paramState.scope === 'program') {
      // Show program-mode elements
      if (interpSelect) interpSelect.style.display = 'inline';
      
      // Update interpolation UI visibility
      this._updateInterpolationUI(paramName);
      
      // Update generator-specific UI
      if (paramState.startValueGenerator.type === 'periodic') {
        // Update HRG controls for periodic parameters (like frequency)
        const startNumInput = document.getElementById('frequency-start-numerators') as HTMLInputElement;
        const startDenInput = document.getElementById('frequency-start-denominators') as HTMLInputElement;
        const startNumBehavior = document.getElementById('frequency-start-numerators-behavior') as HTMLSelectElement;
        
        if (startNumInput && paramState.startValueGenerator.numerators) {
          startNumInput.value = paramState.startValueGenerator.numerators;
        }
        if (startDenInput && paramState.startValueGenerator.denominators) {
          startDenInput.value = paramState.startValueGenerator.denominators;
        }
        if (startNumBehavior && paramState.startValueGenerator.sequenceBehavior) {
          startNumBehavior.value = paramState.startValueGenerator.sequenceBehavior;
        }
        
        // Update end generator if in envelope mode
        if (paramState.temporalBehavior === 'envelope' && paramState.endValueGenerator) {
          const endNumInput = document.getElementById('frequency-end-numerators') as HTMLInputElement;
          const endDenInput = document.getElementById('frequency-end-denominators') as HTMLInputElement;
          const endNumBehavior = document.getElementById('frequency-end-numerators-behavior') as HTMLSelectElement;
          
          if (endNumInput && paramState.endValueGenerator.numerators) {
            endNumInput.value = paramState.endValueGenerator.numerators;
          }
          if (endDenInput && paramState.endValueGenerator.denominators) {
            endDenInput.value = paramState.endValueGenerator.denominators;
          }
          if (endNumBehavior && paramState.endValueGenerator.sequenceBehavior) {
            endNumBehavior.value = paramState.endValueGenerator.sequenceBehavior;
          }
        }
      } else if (paramState.startValueGenerator.type === 'normalised') {
        // Update range controls for normalised parameters
        const textInput = document.getElementById(`${paramName}-value`) as HTMLInputElement;
        if (textInput && paramState.startValueGenerator.range !== undefined) {
          if (typeof paramState.startValueGenerator.range === 'number') {
            textInput.value = paramState.startValueGenerator.range.toString();
          } else {
            textInput.value = `${paramState.startValueGenerator.range.min}-${paramState.startValueGenerator.range.max}`;
          }
        }
      }
    }
  }

  setupDualRangeSlider(paramName, valueType, precision) {
    // valueType is either 'start' or 'end'
    const container = document.querySelector(`[data-param="${paramName}"][data-type="${valueType}"]`);
    if (!container) return;
    
    const minHandle = container.querySelector('.range-min');
    const maxHandle = container.querySelector('.range-max');
    const rangeBar = container.querySelector('.slider-range');
    const display = document.getElementById(`${paramName}-${valueType}-display`);
    
    // Handle min value changes
    minHandle.addEventListener('input', (e) => {
      const isStatic = container.dataset.mode === 'static';
      const minVal = parseFloat(e.target.value);
      
      if (isStatic) {
        // In static mode, sync both handles to the same value
        maxHandle.value = minVal;
        this.updateSliderRange(container);
        this.updateDualSliderDisplay(paramName, valueType, precision);
        
        // Update pendingMusicalState for static mode
        const staticCheckbox = document.getElementById(`${paramName}-static`);
        // Legacy parameter handling - now managed by compact controls
      } else {
        // In range mode, ensure min <= max
        const maxVal = parseFloat(maxHandle.value);
        if (minVal > maxVal) {
          maxHandle.value = minVal;
        }
        this.updateSliderRange(container);
        this.updateDualSliderDisplay(paramName, valueType, precision);
        
        // Legacy program config - now handled by compact controls
        
        // If this is envelope mode (not static) and slider is in static mode, update envelope values
        const staticCheckbox = document.getElementById(`${paramName}-static`);
        if (!staticCheckbox.checked && container.dataset.mode === 'static' && typeof this.pendingMusicalState[paramName] === 'object') {
          if (valueType === 'start') {
            this.pendingMusicalState[paramName].startValue = minVal;
          } else if (valueType === 'end') {
            this.pendingMusicalState[paramName].endValue = minVal;
          }
        }
      }
      
      this.markPendingChanges();
    });
    
    // Handle max value changes
    maxHandle.addEventListener('input', (e) => {
      const isStatic = container.dataset.mode === 'static';
      const maxVal = parseFloat(e.target.value);
      
      if (isStatic) {
        // In static mode, sync both handles to the same value
        minHandle.value = maxVal;
        this.updateSliderRange(container);
        this.updateDualSliderDisplay(paramName, valueType, precision);
        
        // Update pendingMusicalState for static mode
        const staticCheckbox = document.getElementById(`${paramName}-static`);
        if (staticCheckbox && staticCheckbox.checked) {
          this.pendingMusicalState[paramName] = maxVal;
          
          // Will be replaced with action dispatch
          // TODO: Replace with _updatePendingState dispatch
          this.broadcastDirectParameters();
        }
      } else {
        // In range mode, ensure min <= max
        const minVal = parseFloat(minHandle.value);
        if (maxVal < minVal) {
          minHandle.value = maxVal;
        }
        this.updateSliderRange(container);
        this.updateDualSliderDisplay(paramName, valueType, precision);
        
        // Legacy program config - now handled by compact controls
        
        // If this is envelope mode (not static) and slider is in static mode, update envelope values
        const staticCheckbox = document.getElementById(`${paramName}-static`);
        if (!staticCheckbox.checked && container.dataset.mode === 'static' && typeof this.pendingMusicalState[paramName] === 'object') {
          if (valueType === 'start') {
            this.pendingMusicalState[paramName].startValue = maxVal;
          } else if (valueType === 'end') {
            this.pendingMusicalState[paramName].endValue = maxVal;
          }
        }
      }
      
      this.markPendingChanges();
    });
    
    // Double-click to toggle between static and range mode
    container.addEventListener('dblclick', () => {
      const staticCheckbox = document.getElementById(`${paramName}-static`);
      if (!staticCheckbox.checked) { // Only allow toggle in envelope mode
        this.toggleSliderMode(paramName, valueType, precision);
      }
    });
    
    // Initialize the slider
    this.updateSliderRange(container);
    this.updateDualSliderDisplay(paramName, valueType, precision);
  }

  updateSliderRange(container) {
    const minHandle = container.querySelector('.range-min');
    const maxHandle = container.querySelector('.range-max');
    const rangeBar = container.querySelector('.slider-range');
    
    const min = parseFloat(minHandle.min);
    const max = parseFloat(minHandle.max);
    const minVal = parseFloat(minHandle.value);
    const maxVal = parseFloat(maxHandle.value);
    
    // Calculate percentage positions
    const minPercent = ((minVal - min) / (max - min)) * 100;
    const maxPercent = ((maxVal - min) / (max - min)) * 100;
    
    // Update visual range bar
    rangeBar.style.left = `${minPercent}%`;
    rangeBar.style.width = `${maxPercent - minPercent}%`;
  }

  updateDualSliderDisplay(paramName, valueType, precision) {
    const container = document.querySelector(`[data-param="${paramName}"][data-type="${valueType}"]`);
    const display = document.getElementById(`${paramName}-${valueType}-display`);
    if (!container || !display) return;
    
    const minHandle = container.querySelector('.range-min');
    const maxHandle = container.querySelector('.range-max');
    const isStatic = container.dataset.mode === 'static';
    
    const minVal = parseFloat(minHandle.value);
    const maxVal = parseFloat(maxHandle.value);
    
    if (isStatic || minVal === maxVal) {
      // Show single value
      display.textContent = precision === 0 ? minVal.toString() : minVal.toFixed(precision);
    } else {
      // Show range
      const minText = precision === 0 ? minVal.toString() : minVal.toFixed(precision);
      const maxText = precision === 0 ? maxVal.toString() : maxVal.toFixed(precision);
      display.textContent = `[${minText}-${maxText}]`;
    }
    
    this.updateSliderRange(container);
  }

  toggleSliderMode(paramName, valueType, precision) {
    const container = document.querySelector(`[data-param="${paramName}"][data-type="${valueType}"]`);
    const currentMode = container.dataset.mode;
    const newMode = currentMode === 'static' ? 'range' : 'static';
    
    container.dataset.mode = newMode;
    
    if (newMode === 'static') {
      // Switch to static: sync handles and disable randomization
      const minHandle = container.querySelector('.range-min');
      const maxHandle = container.querySelector('.range-max');
      const avgValue = (parseFloat(minHandle.value) + parseFloat(maxHandle.value)) / 2;
      
      minHandle.value = avgValue;
      maxHandle.value = avgValue;
      
      // Legacy static value setting - now handled by compact controls
    } else {
      // Switch to range: enable randomization with small default range
      const minHandle = container.querySelector('.range-min');
      const maxHandle = container.querySelector('.range-max');
      const currentVal = parseFloat(minHandle.value);
      const range = 0.1; // Default range width
      
      minHandle.value = Math.max(parseFloat(minHandle.min), currentVal - range/2);
      maxHandle.value = Math.min(parseFloat(minHandle.max), currentVal + range/2);
      
      // Legacy program range - now handled by compact controls
      
      // Update range indicator immediately
      this.updateSliderRange(container);
    }
    
    this.updateDualSliderDisplay(paramName, valueType, precision);
    this.log(`${paramName} ${valueType} switched to ${newMode} mode`, 'info');
  }








  markPendingChanges() {
    console.log('markPendingChanges called, button:', this.elements.applyParamsBtn);
    this.hasPendingChanges = true;
    if (this.elements.applyParamsBtn) {
      this.elements.applyParamsBtn.disabled = false;
      this.elements.applyParamsBtn.textContent = 'apply changes*';
    }
  }

  clearPendingChanges() {
    this.hasPendingChanges = false;
    if (this.elements.applyParamsBtn) {
      this.elements.applyParamsBtn.disabled = true;
      this.elements.applyParamsBtn.textContent = 'apply changes';
    }
  }




  applyParameterChanges() {
    this.musicalState = JSON.parse(JSON.stringify(this.pendingMusicalState));
    console.log('Applying new state:', this.musicalState);
    this.broadcastMusicalParameters();
    this.clearPendingChanges();
  }


  /**
   * Central method for translating IMusicalState to wire format
   * Used by both broadcastMusicalParameters and sendCompleteStateToSynth
   */
  private _getWirePayload(): any {
    const wirePayload: any = {
      synthesisActive: this.synthesisActive,
      isManualMode: this.isManualControlMode,
    };

    // Send discriminated union format directly
    for (const key in this.musicalState) {
      const paramKey = key as keyof IMusicalState;
      const paramState = this.musicalState[paramKey];

      if (paramState.scope === 'direct') {
        // Send direct parameters as-is
        wirePayload[paramKey] = paramState;
      } else { // scope is 'program'
        // Prepare generators with proper baseValue for program parameters
        const startGen = { ...paramState.startValueGenerator };
        if (startGen.type === 'periodic') {
          startGen.baseValue = paramState.directValue;
        }
        
        let endGen = undefined;
        if (paramState.interpolation !== 'step' && paramState.endValueGenerator) {
          endGen = { ...paramState.endValueGenerator };
          if (endGen.type === 'periodic') {
            endGen.baseValue = paramState.directValue;
          }
        }
        
        // Send program parameters with discriminated union format
        wirePayload[paramKey] = {
          scope: 'program',
          interpolation: paramState.interpolation,
          startValueGenerator: startGen,
          endValueGenerator: endGen,
          intensity: paramState.interpolation !== 'step' ? paramState.intensity : undefined,
          directValue: paramState.directValue
        };
      }
    }
    return wirePayload;
  }

  broadcastMusicalParameters() {
    if (!this.star) return;
    
    const wirePayload = this._getWirePayload();
    console.log("Broadcasting translated payload:", wirePayload);
    
    const message = MessageBuilder.createParameterUpdate(MessageTypes.PROGRAM_UPDATE, wirePayload);
    this.star.broadcast(message);
    this.log('📡 Broadcasted musical parameters', 'info');
  }

  // Removed splitParametersByMode - no longer needed with separated state
  
  

  broadcastDirectParameters() {
    if (!this.star) return;
    
    // Extract direct values from the typed state
    const directParams: any = { synthesisActive: this.synthesisActive };
    
    for (const key in this.musicalState) {
      const paramKey = key as keyof IMusicalState;
      const paramState = this.musicalState[paramKey];
      
      if (paramState.scope === 'direct') {
        directParams[paramKey] = paramState.directValue;
      }
    }
    
    // Send direct parameters
    const message = MessageBuilder.createParameterUpdate(MessageTypes.SYNTH_PARAMS, directParams);
    const sent = this.star.broadcastToType('synth', message, 'control');
    
    this.log(`Sent direct parameters to ${sent} synths`, 'info');
    
    // Also send to ES-8 if enabled
    this.sendSynthParametersToES8();
  }



  // Phasor Management Methods
  calculateCycleLength() {
    // Calculate cycle length: 60 seconds/minute / CPM
    // Example: 30 CPM = 60/30 = 2.0 seconds per cycle
    this.cycleLength = 60.0 / this.cpm;
  }

  initializePhasor() {
    this.phasor = 0.0;
    this.lastPhasorTime = performance.now() / 1000.0;
    this.startPhasorUpdate();
    this.updatePhasorDisplay();
  }

  updatePhasor() {
    const currentTime = performance.now() / 1000.0;
    const deltaTime = currentTime - this.lastPhasorTime;
    
    // Update phasor
    const phasorIncrement = deltaTime / this.cycleLength;
    this.phasor += phasorIncrement;
    
    // Wrap around at 1.0
    if (this.phasor >= 1.0) {
      this.phasor -= 1.0;
    }
    
    this.lastPhasorTime = currentTime;
    this.updatePhasorDisplay();
    
    // Update ES-8 with current phasor state
    this.updateES8State();
    
    // Broadcast phasor at specified rate
    this.broadcastPhasor(currentTime);
  }

  updatePhasorDisplay() {
    if (this.elements.phasorDisplay) {
      this.elements.phasorDisplay.textContent = this.phasor.toFixed(3);
    }
    
    if (this.elements.phasorBar) {
      const percentage = (this.phasor * 100).toFixed(1);
      this.elements.phasorBar.style.width = `${percentage}%`;
    }
  }

  startPhasorUpdate() {
    const updateLoop = () => {
      this.updatePhasor();
      this.phasorUpdateId = requestAnimationFrame(updateLoop);
    };
    updateLoop();
  }

  stopPhasorUpdate() {
    if (this.phasorUpdateId) {
      cancelAnimationFrame(this.phasorUpdateId);
      this.phasorUpdateId = null;
    }
  }

  broadcastPhasor(currentTime) {
    if (!this.star) return;
    
    // Rate limiting - only broadcast at the specified rate
    const timeSinceLastBroadcast = currentTime - this.lastBroadcastTime;
    const broadcastInterval = 1.0 / this.phasorBroadcastRate;
    
    if (timeSinceLastBroadcast >= broadcastInterval) {
      const message = MessageBuilder.phasorSync(
        this.phasor,
        this.cpm,
        this.stepsPerCycle,
        this.cycleLength
      );
      
      const sent = this.star.broadcastToType('synth', message, 'sync');
      this.lastBroadcastTime = currentTime;
    }
  }

  // ES-8 Integration Methods
  async toggleES8() {
    this.es8Enabled = !this.es8Enabled;
    
    if (this.es8Enabled) {
      await this.initializeES8();
      this.elements.es8EnableBtn.textContent = 'disable es-8';
      this.elements.es8EnableBtn.classList.add('active');
      this.log('ES-8 enabled - CV output active', 'success');
    } else {
      this.shutdownES8();
      this.elements.es8EnableBtn.textContent = 'enable es-8';
      this.elements.es8EnableBtn.classList.remove('active');
      this.log('ES-8 disabled', 'info');
    }
  }

  async initializeES8() {
    try {
      // Create audio context if it doesn't exist
      if (!this.audioContext) {
        this.audioContext = new AudioContext({ sampleRate: 48000 });
        await this.audioContext.resume();
      }
      
      // Configure destination for 8 channels (like the es_8_test reference)
      if (this.audioContext.destination.maxChannelCount >= 8) {
        this.audioContext.destination.channelCount = 8;
        this.audioContext.destination.channelCountMode = 'explicit';
        this.audioContext.destination.channelInterpretation = 'discrete';
        this.log('Configured audio destination for 8 channels', 'info');
      } else {
        this.log(`Only ${this.audioContext.destination.maxChannelCount} channels available`, 'warning');
      }

      // Load the ES-8 worklet
      await this.audioContext.audioWorklet.addModule('/ctrl/worklets/es8-processor.worklet.js');
      
      // Create ES-8 AudioWorkletNode
      this.es8Node = new AudioWorkletNode(this.audioContext, 'es8-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [8],
        channelCount: 8,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete'
      });
      
      // Connect to destination
      this.es8Node.connect(this.audioContext.destination);
      
      // Enable the worklet
      this.es8Node.port.postMessage({
        type: 'enable',
        enabled: true
      });
      
      // Send initial state
      this.updateES8State();
      this.sendSynthParametersToES8();
      
      this.log('ES-8 AudioWorklet initialized', 'info');
      
    } catch (error) {
      this.log(`ES-8 initialization failed: ${error.message}`, 'error');
      this.es8Enabled = false;
    }
  }

  updateES8State() {
    if (!this.es8Enabled || !this.es8Node) return;
    
    // Send phasor state to worklet
    this.es8Node.port.postMessage({
      type: 'phasor-update',
      phasor: this.phasor,
      cpm: this.cpm,
      stepsPerCycle: this.stepsPerCycle,
      cycleLength: this.cycleLength
    });
  }
  
  sendSynthParametersToES8() {
    if (!this.es8Enabled || !this.es8Node) return;
    
    const params = this.musicalState;
    this.es8Node.port.postMessage({
      type: 'synth-parameters',
      frequency: params.frequency,
      vowelX: params.vowelX,
      vowelY: params.vowelY,
      zingAmount: params.zingAmount,
      amplitude: params.amplitude
    });
  }

  shutdownES8() {
    if (this.es8Node) {
      // Disable the worklet
      this.es8Node.port.postMessage({
        type: 'enable',
        enabled: false
      });
      
      // Disconnect and clean up
      this.es8Node.disconnect();
      this.es8Node = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  async connectToNetwork() {
    try {
      this.updateConnectionStatus('connecting');
      
      this.log('Connecting to network...', 'info');
      
      // Create star network
      this.star = new WebRTCStar(this.peerId, 'ctrl');
      this.setupStarEventHandlers();
      
      // Connect to signaling server - use current host
      // Dynamic WebSocket URL that works in production and development
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const port = window.location.port ? `:${window.location.port}` : '';
      const signalingUrl = `${protocol}//${window.location.hostname}${port}/ws`;
      await this.star.connect(signalingUrl, this.forceTakeover);
      
      
      this.updateConnectionStatus('connected');
      this._updateUIState();
      
      this.log('Connected to network successfully', 'success');
      
    } catch (error) {
      this.log(`Connection failed: ${error.message}`, 'error');
      this.updateConnectionStatus('disconnected');
      this._updateUIState();
    }
  }


  _updateUIState() {
    const isConnected = this.star && this.star.isConnectedToSignaling;
    
    // Update any remaining UI state based on connection
  }

  setupStarEventHandlers() {
    this.star.addEventListener('became-leader', () => {
      this.log('Became network leader', 'success');
      this._updateUIState();
    });
    
    this.star.addEventListener('peer-connected', (event) => {
      const { peerId } = event.detail;
      this.log(`Peer connected: ${peerId}`, 'info');
      this.updatePeerList();
      this._updateUIState();
      
      // Send complete current state to new synths
      if (peerId.startsWith('synth-')) {
        this.sendCompleteStateToSynth(peerId);
      }
    });
    
    this.star.addEventListener('peer-removed', (event) => {
      this.log(`Peer disconnected: ${event.detail.peerId}`, 'info');
      this.updatePeerList();
      this._updateUIState();
    });
    
    this.star.addEventListener('kicked', (event) => {
      this.log(`Kicked: ${event.detail.reason}`, 'error');
      this.updateConnectionStatus('error');
      this._updateUIState();
      alert('You have been disconnected: Another control client has taken over.');
    });
    
    this.star.addEventListener('join-rejected', (event) => {
      this.log(`Cannot join: ${event.detail.reason}`, 'error');
      this.updateConnectionStatus('error');
      this._updateUIState();
      
      if (event.detail.reason.includes('Add ?force=true')) {
        if (confirm('Another control client is already connected. Force takeover?')) {
          window.location.href = window.location.href + '?force=true';
        }
      }
    });
    
    this.star.addEventListener('data-message', (event) => {
      const { peerId, channelType, message } = event.detail;
      
      // Handle ping messages
      if (message.type === MessageTypes.PING) {
        const pong = MessageBuilder.pong(message.id, message.timestamp);
        this.star.sendToPeer(peerId, pong, 'sync');
      }
      
      // Log other messages for debugging
      if (message.type !== MessageTypes.PING && message.type !== MessageTypes.PONG) {
        this.log(`Received ${message.type} from ${peerId}`, 'debug');
      }
    });
  }



  toggleCalibration() {
    this.isCalibrationMode = !this.isCalibrationMode;
    
    
    if (this.isCalibrationMode) {
      this.elements.calibrationBtn.textContent = 'Disable Calibration Mode';
      this.elements.calibrationBtn.classList.add('primary');
      this.log('Calibration mode enabled', 'info');
    } else {
      this.elements.calibrationBtn.textContent = 'Enable Calibration Mode';
      this.elements.calibrationBtn.classList.remove('primary');
      this.log('Calibration mode disabled', 'info');
    }
    
    // Broadcast calibration mode to all peers
    if (this.star) {
      const message = MessageBuilder.calibrationMode(this.isCalibrationMode);
      const sent = this.star.broadcast(message, 'control');
      this.log(`Broadcast calibration mode to ${sent} peers`, 'debug');
    }
  }

  toggleSynthesis() {
    this.synthesisActive = !this.synthesisActive;
    
    if (this.synthesisActive) {
      this.elements.manualModeBtn.textContent = 'Disable Synthesis';
      this.elements.manualModeBtn.classList.add('active');
      this.log('Synthesis enabled - real-time parameter control active', 'info');
    } else {
      this.elements.manualModeBtn.textContent = 'Enable Synthesis';
      this.elements.manualModeBtn.classList.remove('active');
      this.log('Synthesis disabled', 'info');
    }
    
    // Broadcast current state to all synths
    this.broadcastDirectParameters(); // Send direct parameters with synthesis state
    
    // Send current musical state using new typed system
    this.broadcastMusicalParameters();
  }

  // Deprecated - use toggleSynthesis instead
  toggleManualMode() {
    this.toggleSynthesis();
  }



  sendCompleteStateToSynth(synthId) {
    this.log(`Sending complete state to new synth: ${synthId}`, 'info');
    
    // 1. Send calibration mode if active
    if (this.isCalibrationMode) {
      const calibrationMsg = MessageBuilder.calibrationMode(
        this.isCalibrationMode,
        this.calibrationAmplitude
      );
      const success = this.star.sendToPeer(synthId, calibrationMsg, 'control');
      if (success) {
        this.log(`✅ Sent calibration mode to ${synthId}`, 'debug');
      } else {
        this.log(`❌ Failed to send calibration mode to ${synthId}`, 'error');
      }
    }
    
    // 2. Send current musical state using unified payload function
    const wirePayload = this._getWirePayload();
    
    const message = MessageBuilder.createParameterUpdate(MessageTypes.PROGRAM_UPDATE, wirePayload);
    const success = this.star.sendToPeer(synthId, message, 'control');
    if (success) {
      this.log(`✅ Sent typed musical state to ${synthId}`, 'debug');
    } else {
      this.log(`❌ Failed to send typed musical state to ${synthId}`, 'error');
    }
  }


  updateConnectionStatus(status) {
    const statusElement = this.elements.connectionStatus;
    const valueElement = this.elements.connectionValue;
    
    statusElement.classList.remove('connected', 'syncing');
    
    switch (status) {
      case 'connected':
        valueElement.textContent = 'Connected';
        statusElement.classList.add('connected');
        break;
      case 'connecting':
        valueElement.textContent = 'Connecting...';
        statusElement.classList.add('syncing');
        break;
      default:
        valueElement.textContent = 'Disconnected';
    }
  }

  updatePeerCount(count) {
    this.elements.peersValue.textContent = count.toString();
    
    // Update peers status color
    if (count > 0) {
      this.elements.peersStatus.classList.add('connected');
    } else {
      this.elements.peersStatus.classList.remove('connected');
    }
  }

  updateTimingStatus(isRunning) {
    const statusElement = this.elements.timingStatus;
    const valueElement = this.elements.timingValue;
    
    if (isRunning) {
      valueElement.textContent = 'Running';
      statusElement.classList.add('syncing');
    } else {
      valueElement.textContent = 'Stopped';
      statusElement.classList.remove('syncing');
    }
  }

  updatePhasorVisualization(phasor) {
    const percentage = (phasor * 100).toFixed(1);
    this.elements.phasorBar.style.width = `${percentage}%`;
    this.elements.phasorText.textContent = phasor.toFixed(3);
  }

  updatePeerList() {
    if (!this.star) {
      this.clearPeerList();
      return;
    }
    
    const stats = this.star.getNetworkStats();
    const peers = Object.keys(stats.peerStats);
    
    this.updatePeerCount(peers.length);
    
    if (peers.length === 0) {
      this.clearPeerList();
      return;
    }
    
    const listHTML = peers.map(peerId => {
      const peerStats = stats.peerStats[peerId];
      const peerType = peerStats.peerType || peerId.split('-')[0]; // Use stored type or extract from peerId
      
      return `
        <div class="peer-item">
          <div class="peer-info">
            <div class="peer-id">${peerId}</div>
            <div class="peer-type">${peerType}</div>
          </div>
          <div class="peer-stats">
            <div>Status: ${peerStats.connectionState}</div>
          </div>
        </div>
      `;
    }).join('');
    
    this.elements.peerList.innerHTML = listHTML;
  }

  clearPeerList() {
    this.elements.peerList.innerHTML = `
      <div style="color: #888; font-style: italic; text-align: center; padding: 20px;">
        No peers connected
      </div>
    `;
  }

  log(message, level = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = {
      'info': 'ℹ️',
      'success': '✅', 
      'error': '❌',
      'debug': '🔍'
    }[level] || 'ℹ️';
    
    const logEntry = `[${timestamp}] ${prefix} ${message}\n`;
    this.elements.debugLog.textContent += logEntry;
    this.elements.debugLog.scrollTop = this.elements.debugLog.scrollHeight;
    
    // Also log to console
  }

  clearLog() {
    this.elements.debugLog.textContent = '';
  }



  // Legacy setupParameterRandomizer method removed - now handled by compact controls



  // Close all randomizer modals when clicking outside





  // Update the visual state of randomizer buttons


  // Apply random value to specific start or end

  setupHRGKeyboardNavigation(controlsElement) {
    if (!controlsElement) return;
    
    // Get all focusable elements within the controls
    const getFocusableElements = () => {
      return controlsElement.querySelectorAll('input[type="text"], select, input[type="checkbox"]');
    };
    
    // Add Tab navigation and Enter-to-close to all focusable elements
    const setupElementNavigation = () => {
      const focusableElements = getFocusableElements();
      
      focusableElements.forEach((element, index) => {
        element.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const nextIndex = e.shiftKey ? 
              (index - 1 + focusableElements.length) % focusableElements.length :
              (index + 1) % focusableElements.length;
            focusableElements[nextIndex].focus();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            // Close the controls
            controlsElement.style.display = 'none';
            // Remove active state from associated button
            const button = controlsElement.closest('.parameter-line')?.querySelector('.randomizer-btn');
            if (button) {
              button.classList.remove('active');
              button.focus();
            }
          } else if (e.key === 'Escape') {
            e.preventDefault();
            // Close the controls
            controlsElement.style.display = 'none';
            // Remove active state from associated button
            const button = controlsElement.closest('.parameter-line')?.querySelector('.randomizer-btn');
            if (button) {
              button.classList.remove('active');
              button.focus();
            }
          }
        });
      });
    };
    
    // Setup navigation when controls become visible
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
          if (controlsElement.style.display !== 'none') {
            setTimeout(setupElementNavigation, 0);
          }
        }
      });
    });
    
    observer.observe(controlsElement, { attributes: true });
    
    // Initial setup if already visible
    if (controlsElement.style.display !== 'none') {
      setupElementNavigation();
    }
  }
}

// Initialize the control client
console.log('About to create ControlClient');
const controlClient = new ControlClient();
console.log('ControlClient created successfully');

// Make it globally available for debugging
window.controlClient = controlClient;