/**
 * Voice.Assembly.FM Control Client Main Application
 */

import { WebRTCStar, generatePeerId } from '../../src/common/webrtc-star.js';
import { MessageTypes, MessageBuilder } from '../../src/common/message-protocol.js';

class ControlClient {
  constructor() {
    // Check for force takeover mode
    const urlParams = new URLSearchParams(window.location.search);
    this.forceTakeover = urlParams.get('force') === 'true';
    
    this.peerId = generatePeerId('ctrl');
    this.star = null;
    this.isCalibrationMode = false;
    this.isManualMode = false;
    
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
    
    // Randomization configuration - separate start and end for each parameter
    this.randomizationConfig = {
      vowelX: {
        start: { enabled: false, min: 0, max: 1 },
        end: { enabled: false, min: 0, max: 1 }
      },
      vowelY: {
        start: { enabled: false, min: 0, max: 1 },
        end: { enabled: false, min: 0, max: 1 }
      },
      zingAmount: {
        start: { enabled: false, min: 0, max: 1 },
        end: { enabled: false, min: 0, max: 1 }
      },
      zingMorph: {
        start: { enabled: false, min: 0, max: 1 },
        end: { enabled: false, min: 0, max: 1 }
      },
      symmetry: {
        start: { enabled: false, min: 0, max: 1 },
        end: { enabled: false, min: 0, max: 1 }
      },
      amplitude: {
        start: { enabled: false, min: 0, max: 1 },
        end: { enabled: false, min: 0, max: 1 }
      }
    };
    
    
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
      frequencySlider: document.getElementById('frequency-slider'),
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
    
    this.setupEventHandlers();
    this.calculateCycleLength();
    this.initializePhasor();
    this.log('Control client initialized', 'info');
    
    // Auto-connect on page load
    this.connectToNetwork();
  }

  setupEventHandlers() {
    
    // Calibration
    this.elements.calibrationBtn.addEventListener('click', () => this.toggleCalibration());
    
    // Manual mode
    this.elements.manualModeBtn.addEventListener('click', () => this.toggleManualMode());
    
    // Debug log
    this.elements.clearLogBtn.addEventListener('click', () => this.clearLog());
    
    // Apply button
    this.elements.applyParamsBtn.addEventListener('click', () => this.applyParameterChanges());
    
    // Musical controls
    this.setupMusicalControls();
  }
  
  setupMusicalControls() {
    // Note: All synthesis parameters are now handled by setupEnvelopeControls()
    
    // Envelope controls for all parameters that support them
    this.setupEnvelopeControls();
    
    // Randomizer controls for normalized parameters
    this.setupRandomizerControls();
    
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
  }

  setupEnvelopeControls() {
    // Parameters that support envelopes
    const envelopeParams = [
      { name: 'frequency', suffix: ' Hz', precision: 0 },
      { name: 'vowelX', suffix: '', precision: 2 },
      { name: 'vowelY', suffix: '', precision: 2 },
      { name: 'zingAmount', suffix: '', precision: 2 },
      { name: 'zingMorph', suffix: '', precision: 2 },
      { name: 'symmetry', suffix: '', precision: 2 },
      { name: 'amplitude', suffix: '', precision: 2 }
    ];
    
    envelopeParams.forEach(param => {
      this.setupParameterEnvelopeControls(param.name, param.suffix, param.precision);
    });
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
        // Check randomization config to determine if range or static mode
        const startEnabled = this.randomizationConfig[paramName]?.start?.enabled || false;
        const endEnabled = this.randomizationConfig[paramName]?.end?.enabled || false;
        
        startSlider.dataset.mode = startEnabled ? 'range' : 'static';
        if (endSlider) endSlider.dataset.mode = endEnabled ? 'range' : 'static';
        envelopeControl.classList.add('envelope-active');
      }
      
      // Update visual displays
      this.updateDualSliderDisplay(paramName, 'start', precision);
      this.updateDualSliderDisplay(paramName, 'end', precision);
      
      this.updateParameterEnvelopePreview(paramName);
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
    
    // Intensity slider (unchanged)
    intensitySlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      intensityValue.textContent = value.toFixed(2);
      this.updateParameterEnvelopePreview(paramName);
      this.markPendingChanges();
    });
    
    // Envelope type radio buttons
    document.querySelectorAll(`input[name="${paramName}-env-type"]`).forEach(radio => {
      radio.addEventListener('change', () => {
        this.updateParameterEnvelopePreview(paramName);
        this.markPendingChanges();
      });
    });
    
    // Initialize preview
    this.updateParameterEnvelopePreview(paramName);
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
        
        // Only broadcast immediately if the parameter is in true static mode (static checkbox checked)
        const staticCheckbox = document.getElementById(`${paramName}-static`);
        if (staticCheckbox && staticCheckbox.checked) {
          this.broadcastMusicalParameters();
        }
      } else {
        // In range mode, ensure min <= max
        const maxVal = parseFloat(maxHandle.value);
        if (minVal > maxVal) {
          maxHandle.value = minVal;
        }
        this.updateSliderRange(container);
        this.updateDualSliderDisplay(paramName, valueType, precision);
        
        // Update randomization config and broadcast
        this.randomizationConfig[paramName][valueType].min = minVal;
        this.randomizationConfig[paramName][valueType].max = parseFloat(maxHandle.value);
        this.broadcastRandomizationConfig();
      }
      
      this.updateParameterEnvelopePreview(paramName);
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
        
        // Only broadcast immediately if the parameter is in true static mode (static checkbox checked)
        const staticCheckbox = document.getElementById(`${paramName}-static`);
        if (staticCheckbox && staticCheckbox.checked) {
          this.broadcastMusicalParameters();
        }
      } else {
        // In range mode, ensure min <= max
        const minVal = parseFloat(minHandle.value);
        if (maxVal < minVal) {
          minHandle.value = maxVal;
        }
        this.updateSliderRange(container);
        this.updateDualSliderDisplay(paramName, valueType, precision);
        
        // Update randomization config and broadcast
        this.randomizationConfig[paramName][valueType].min = parseFloat(minHandle.value);
        this.randomizationConfig[paramName][valueType].max = maxVal;
        this.broadcastRandomizationConfig();
      }
      
      this.updateParameterEnvelopePreview(paramName);
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
      
      // Disable randomization
      this.randomizationConfig[paramName][valueType].enabled = false;
    } else {
      // Switch to range: enable randomization with small default range
      const minHandle = container.querySelector('.range-min');
      const maxHandle = container.querySelector('.range-max');
      const currentVal = parseFloat(minHandle.value);
      const range = 0.1; // Default range width
      
      minHandle.value = Math.max(parseFloat(minHandle.min), currentVal - range/2);
      maxHandle.value = Math.min(parseFloat(minHandle.max), currentVal + range/2);
      
      // Enable randomization
      this.randomizationConfig[paramName][valueType].enabled = true;
      this.randomizationConfig[paramName][valueType].min = parseFloat(minHandle.value);
      this.randomizationConfig[paramName][valueType].max = parseFloat(maxHandle.value);
      this.broadcastRandomizationConfig();
      
      // Update range indicator immediately
      this.updateSliderRange(container);
    }
    
    this.updateDualSliderDisplay(paramName, valueType, precision);
    this.updateParameterEnvelopePreview(paramName); // Update visualizer for both modes
    this.log(`${paramName} ${valueType} switched to ${newMode} mode`, 'info');
  }

  updateParameterEnvelopePreview(paramName) {
    const staticCheckbox = document.getElementById(`${paramName}-static`);
    if (staticCheckbox.checked) return; // No preview needed for static mode
    
    // Get values from dual-handle sliders
    const startContainer = document.querySelector(`[data-param="${paramName}"][data-type="start"]`);
    const endContainer = document.querySelector(`[data-param="${paramName}"][data-type="end"]`);
    
    if (!startContainer || !endContainer) return;
    
    const startMinHandle = startContainer.querySelector('.range-min');
    const startMaxHandle = startContainer.querySelector('.range-max');
    const endMinHandle = endContainer.querySelector('.range-min');
    const endMaxHandle = endContainer.querySelector('.range-max');
    
    const startMin = parseFloat(startMinHandle.value);
    const startMax = parseFloat(startMaxHandle.value);
    const endMin = parseFloat(endMinHandle.value);
    const endMax = parseFloat(endMaxHandle.value);
    
    const intensity = parseFloat(document.getElementById(`${paramName}-intensity`).value);
    const envType = document.querySelector(`input[name="${paramName}-env-type"]:checked`).value;
    
    // Check if randomization is enabled (ranges have different min/max values)
    const startHasRange = startContainer.dataset.mode === 'range';
    const endHasRange = endContainer.dataset.mode === 'range';
    const hasAnyRange = startHasRange || endHasRange;
    
    // Get SVG elements
    const pathElement = document.getElementById(`${paramName}-envelope-path`);
    const rangeArea = document.getElementById(`${paramName}-range-area`);
    const minPath = document.getElementById(`${paramName}-min-path`);
    const maxPath = document.getElementById(`${paramName}-max-path`);
    
    if (hasAnyRange) {
      // Range visualization mode
      const paths = this.generateRangeEnvelopePaths(startMin, startMax, endMin, endMax, intensity, envType, paramName);
      
      // Show range visualization elements
      rangeArea.style.display = 'block';
      minPath.style.display = 'block';
      maxPath.style.display = 'block';
      
      // Hide main envelope path (no median line needed)
      pathElement.style.display = 'none';
      
      // Update elements
      rangeArea.setAttribute('points', paths.polygonPoints);
      minPath.setAttribute('d', paths.minPath);
      maxPath.setAttribute('d', paths.maxPath);
    } else {
      // Standard single envelope mode
      const path = this.generateEnvelopePath(startMin, endMin, intensity, envType, paramName);
      pathElement.setAttribute('d', path);
      pathElement.style.display = 'block';
      
      // Hide range visualization elements
      rangeArea.style.display = 'none';
      minPath.style.display = 'none';
      maxPath.style.display = 'none';
    }
  }

  // Helper function to normalize parameter values for visualization (0-1 range)
  normalizeForVisualization(value, paramName) {
    if (paramName === 'frequency') {
      // Frequency: 80-800 Hz -> 0-1
      return (value - 80) / (800 - 80);
    } else {
      // Normalized parameters already in 0-1 range
      return value;
    }
  }

  generateEnvelopePath(startValue, endValue, intensity, envType, paramName) {
    const width = 300;
    const height = 80;
    const steps = 150; // Number of points along the curve
    
    // Normalize start value for display
    const normalizedStart = this.normalizeForVisualization(startValue, paramName);
    let pathData = `M 0,${height * (1 - normalizedStart)}`;
    
    for (let i = 1; i <= steps; i++) {
      const phase = i / steps; // 0 to 1
      let interpolatedValue;
      
      if (envType === 'par') {
        // Parabolic envelope calculates the value directly
        interpolatedValue = this.calculateParTypeEnvelope(phase, intensity, startValue, endValue, paramName);
      } else {
        // Lin and cos envelopes use the interpolation pattern
        let envelopeValue;
        if (envType === 'lin') {
          envelopeValue = this.calculateLinTypeEnvelope(phase, intensity);
        } else {
          envelopeValue = this.calculateCosTypeEnvelope(phase, intensity);
        }
        interpolatedValue = startValue + (endValue - startValue) * envelopeValue;
      }
      
      // Normalize interpolated value for display
      const normalizedValue = this.normalizeForVisualization(interpolatedValue, paramName);
      const x = (i / steps) * width;
      const y = height * (1 - normalizedValue); // Flip Y axis
      
      pathData += ` L ${x},${y}`;
    }
    
    return pathData;
  }

  generateRangeEnvelopePaths(startMin, startMax, endMin, endMax, intensity, envType, paramName) {
    const width = 300;
    const height = 80;
    const steps = 150;
    
    // Normalize start values for display
    const normalizedStartMin = this.normalizeForVisualization(startMin, paramName);
    const normalizedStartMax = this.normalizeForVisualization(startMax, paramName);
    
    // Generate min envelope path (startMin -> endMin)
    let minPathData = `M 0,${height * (1 - normalizedStartMin)}`;
    
    // Generate max envelope path (startMax -> endMax)
    let maxPathData = `M 0,${height * (1 - normalizedStartMax)}`;
    
    // Arrays to store polygon points for filled area
    const topPoints = [];
    const bottomPoints = [];
    
    // Calculate all envelope paths
    for (let i = 1; i <= steps; i++) {
      const phase = i / steps; // 0 to 1
      const x = (i / steps) * width;
      
      let minInterpolated, maxInterpolated;
      
      if (envType === 'par') {
        // Parabolic envelopes calculate values directly
        minInterpolated = this.calculateParTypeEnvelope(phase, intensity, startMin, endMin, paramName);
        maxInterpolated = this.calculateParTypeEnvelope(phase, intensity, startMax, endMax, paramName);
      } else {
        // Lin and cos envelopes use the interpolation pattern
        let envelopeValue;
        if (envType === 'lin') {
          envelopeValue = this.calculateLinTypeEnvelope(phase, intensity);
        } else {
          envelopeValue = this.calculateCosTypeEnvelope(phase, intensity);
        }
        
        // Min envelope (startMin -> endMin)
        minInterpolated = startMin + (endMin - startMin) * envelopeValue;
        
        // Max envelope (startMax -> endMax)
        maxInterpolated = startMax + (endMax - startMax) * envelopeValue;
      }
      
      // Normalize interpolated values for display
      const normalizedMinValue = this.normalizeForVisualization(minInterpolated, paramName);
      const normalizedMaxValue = this.normalizeForVisualization(maxInterpolated, paramName);
      
      const minY = height * (1 - normalizedMinValue);
      minPathData += ` L ${x},${minY}`;
      
      const maxY = height * (1 - normalizedMaxValue);
      maxPathData += ` L ${x},${maxY}`;
      
      // Determine top and bottom for polygon (max envelope could be above or below min)
      if (maxY <= minY) {
        topPoints.push(`${x},${maxY}`);
        bottomPoints.unshift(`${x},${minY}`); // Reverse order for polygon
      } else {
        topPoints.push(`${x},${minY}`);
        bottomPoints.unshift(`${x},${maxY}`); // Reverse order for polygon
      }
    }
    
    // Add starting points for polygon (using normalized values)
    const startMinY = height * (1 - normalizedStartMin);
    const startMaxY = height * (1 - normalizedStartMax);
    if (startMaxY <= startMinY) {
      topPoints.unshift(`0,${startMaxY}`);
      bottomPoints.push(`0,${startMinY}`);
    } else {
      topPoints.unshift(`0,${startMinY}`);
      bottomPoints.push(`0,${startMaxY}`);
    }
    
    // Create polygon path data for filled area
    const polygonPoints = [...topPoints, ...bottomPoints].join(' ');
    
    return {
      minPath: minPathData,
      maxPath: maxPathData,
      polygonPoints: polygonPoints
    };
  }

  // Envelope calculation methods (same as in worklet)
  calculateLinTypeEnvelope(phase, intensity) {
    const t = Math.max(0, Math.min(1, phase));
    const p = Math.max(0, Math.min(1, intensity));
    
    // More intuitive exponential mapping:
    // p=0: strong ease-in (slow start, fast end)
    // p=0.5: linear
    // p=1: strong ease-out (fast start, slow end)
    
    if (Math.abs(p - 0.5) < 0.001) return t; // Perfect linear at 0.5
    
    let exponent;
    if (p < 0.5) {
      // Ease-in: higher exponent makes slower start
      exponent = 1 / (0.1 + p * 1.8); // Range: ~5.6 to 1
    } else {
      // Ease-out: lower exponent makes faster start  
      exponent = 0.1 + (p - 0.5) * 1.8; // Range: 0.1 to 1
    }
    
    if (t === 0) return 0;
    return Math.pow(t, exponent);
  }

  calculateCosTypeEnvelope(phase, intensity) {
    const t = Math.max(0, Math.min(1, phase));
    const p = Math.max(0, Math.min(1, intensity));
    
    // Logistic function with variable growth rate for smooth sigmoid-to-square morph
    // p=0: k=4 (gentle sigmoid)
    // p=0.5: k=10 (moderate)  
    // p=1: k=100 (nearly square)
    const k = 4 + p * p * 96;
    
    // Center around 0.5 and apply logistic function
    const x = (t - 0.5) * k;
    
    return 1 / (1 + Math.exp(-x));
  }

  calculateParTypeEnvelope(phase, intensity, startValue, endValue, paramName) {
    const t = Math.max(0, Math.min(1, phase));
    const p = Math.max(0, Math.min(1, intensity));
    
    // Calculate peak value based on parameter type and intensity
    let peakValue;
    
    // Check if this is a frequency parameter by name
    if (paramName === 'frequency') {
      // Frequency parameter: intensity controls how far the peak deviates from the midpoint
      // First, calculate the geometric mean (midpoint in log space) between start and end
      const logStart = Math.log2(Math.max(1, startValue));
      const logEnd = Math.log2(Math.max(1, endValue));
      const logMidpoint = (logStart + logEnd) / 2;
      const midpointFreq = Math.pow(2, logMidpoint);
      
      // intensity controls octave offset from this midpoint
      // intensity=0 -> -1 octave from midpoint, intensity=0.5 -> midpoint, intensity=1 -> +1 octave from midpoint
      const octaveOffset = (p - 0.5) * 2.0; // -1 to +1 octave range
      peakValue = midpointFreq * Math.pow(2, octaveOffset);
      
      // Ensure peak stays within reasonable bounds
      const minFreq = Math.min(startValue, endValue) * 0.5;
      const maxFreq = Math.max(startValue, endValue) * 2.0;
      peakValue = Math.max(minFreq, Math.min(maxFreq, peakValue));
      
    } else {
      // Normalized parameter (0-1): intensity controls how far peak deviates from midpoint
      const midpoint = (startValue + endValue) / 2;
      const maxRange = Math.min(0.5, Math.abs(endValue - startValue) + 0.2); // Dynamic range based on start/end difference
      const offset = (p - 0.5) * 2.0 * maxRange; // Scale to ±maxRange
      peakValue = Math.max(0, Math.min(1, midpoint + offset));
    }
    
    // Create parabola passing through three points:
    // (0, startValue), (0.5, peakValue), (1, endValue)
    
    // Solve for quadratic coefficients: y = at² + bt + c
    const c = startValue;
    const a = 2 * (startValue + endValue - 2 * peakValue);
    const b = 4 * peakValue - endValue - 3 * startValue;
    
    // Evaluate parabola at phase t
    return a * t * t + b * t + c;
  }

  markPendingChanges() {
    this.hasPendingChanges = true;
    this.elements.applyParamsBtn.disabled = false;
    this.elements.applyParamsBtn.textContent = 'apply changes*';
  }

  clearPendingChanges() {
    this.hasPendingChanges = false;
    this.elements.applyParamsBtn.disabled = true;
    this.elements.applyParamsBtn.textContent = 'apply changes';
  }

  applyParameterChanges() {
    if (!this.hasPendingChanges) return;
    
    // Schedule parameter application at next cycle boundary (EOC)
    if (this.star) {
      const message = MessageBuilder.scheduleParameterUpdate(this.getMusicalParameters());
      const sent = this.star.broadcastToType('synth', message, 'control');
      this.log(`Scheduled parameter update for EOC to ${sent} synths`, 'info');
    }
    
    this.clearPendingChanges();
  }
  
  
  getMusicalParameters() {
    return {
        frequency: this.getParameterValue('frequency', 220),
        vowelX: this.getParameterValue('vowelX', 0.5),
        vowelY: this.getParameterValue('vowelY', 0.5),
        zingAmount: this.getParameterValue('zingAmount', 0.0),
        zingMorph: this.getParameterValue('zingMorph', 0.5),
        symmetry: this.getParameterValue('symmetry', 0.5),
        amplitude: this.getParameterValue('amplitude', 1.0),
        isManualMode: this.isManualMode,
    };
  }

  getParameterValue(paramName, defaultValue) {
    const staticCheckbox = document.getElementById(`${paramName}-static`);
    
    // Get containers for start and end sliders
    const startContainer = document.querySelector(`[data-param="${paramName}"][data-type="start"]`);
    if (!startContainer) return defaultValue;
    
    if (staticCheckbox.checked) {
      // Static mode: return simple number from start slider
      const startMinHandle = startContainer.querySelector('.range-min');
      const startValue = parseFloat(startMinHandle.value);
      return isNaN(startValue) ? defaultValue : startValue;
    } else {
      // Envelope mode: return envelope object with proper range handling
      const endContainer = document.querySelector(`[data-param="${paramName}"][data-type="end"]`);
      if (!endContainer) return defaultValue;
      
      const intensity = parseFloat(document.getElementById(`${paramName}-intensity`).value);
      const envType = document.querySelector(`input[name="${paramName}-env-type"]:checked`).value;
      
      // Check if start slider is in range mode
      const startIsRange = startContainer.dataset.mode === 'range';
      let startValue;
      if (startIsRange) {
        const startMin = parseFloat(startContainer.querySelector('.range-min').value);
        const startMax = parseFloat(startContainer.querySelector('.range-max').value);
        startValue = { min: startMin, max: startMax };
      } else {
        startValue = parseFloat(startContainer.querySelector('.range-min').value);
      }
      
      // Check if end slider is in range mode  
      const endIsRange = endContainer.dataset.mode === 'range';
      let endValue;
      if (endIsRange) {
        const endMin = parseFloat(endContainer.querySelector('.range-min').value);
        const endMax = parseFloat(endContainer.querySelector('.range-max').value);
        endValue = { min: endMin, max: endMax };
      } else {
        endValue = parseFloat(endContainer.querySelector('.range-min').value);
      }
      
      return {
        static: false,
        startValue: startValue,
        endValue: endValue,
        intensity: isNaN(intensity) ? 0.5 : intensity,
        envType: envType || 'lin'
      };
    }
  }

  broadcastMusicalParameters() {
    if (!this.star) return;
    
    const params = this.getMusicalParameters();
    const message = MessageBuilder.musicalParameters(params);
    
    // Send to all connected synth peers
    const sent = this.star.broadcastToType('synth', message, 'control');
    
    // Also send to ES-8 if enabled
    this.sendMusicalParametersToES8();
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
      this.sendMusicalParametersToES8();
      
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
  
  sendMusicalParametersToES8() {
    if (!this.es8Enabled || !this.es8Node) return;
    
    const params = this.getMusicalParameters();
    this.es8Node.port.postMessage({
      type: 'musical-parameters',
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

  toggleManualMode() {
    this.isManualMode = !this.isManualMode;
    
    if (this.isManualMode) {
      this.elements.manualModeBtn.textContent = 'Disable Synthesis';
      this.elements.manualModeBtn.classList.add('active');
      this.log('Synthesis enabled - real-time parameter control active', 'info');
    } else {
      this.elements.manualModeBtn.textContent = 'Enable Synthesis';
      this.elements.manualModeBtn.classList.remove('active');
      this.log('Synthesis disabled', 'info');
    }
    
    // Immediately broadcast parameters with new mode
    this.broadcastMusicalParameters();
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
    
    // 2. Send current musical parameters (includes test mode state)
    const params = this.getMusicalParameters();
    const musicalMsg = MessageBuilder.musicalParameters(params);
    const musicalSuccess = this.star.sendToPeer(synthId, musicalMsg, 'control');
    if (musicalSuccess) {
      this.log(`✅ Sent musical parameters to ${synthId} (test mode: ${params.isManualMode})`, 'debug');
    } else {
      this.log(`❌ Failed to send musical parameters to ${synthId}`, 'error');
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

  setupRandomizerControls() {
    // Only normalized parameters get randomizers (not frequency, which gets HRG)
    const randomizerParams = ['vowelX', 'vowelY', 'zingAmount', 'zingMorph', 'symmetry', 'amplitude'];
    
    randomizerParams.forEach(paramName => {
      this.setupParameterRandomizer(paramName, 'start');
      this.setupParameterRandomizer(paramName, 'end');
    });
    
  }

  setupParameterRandomizer(paramName, valueType) {
    // valueType is either 'start' or 'end'
    const enableCheckbox = document.getElementById(`${paramName}-${valueType}-rand-enable`);
    const minSlider = document.getElementById(`${paramName}-${valueType}-rand-min`);
    const maxSlider = document.getElementById(`${paramName}-${valueType}-rand-max`);
    
    if (!enableCheckbox || !minSlider || !maxSlider) {
      console.warn(`Randomizer controls not found for ${paramName}-${valueType}`);
      return;
    }

    // Load existing configuration
    const config = this.randomizationConfig[paramName][valueType];
    enableCheckbox.checked = config.enabled;
    minSlider.value = config.min;
    maxSlider.value = config.max;

    // Enable/disable continuous randomization
    enableCheckbox.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      this.randomizationConfig[paramName][valueType].enabled = enabled;
      
      if (enabled) {
        this.log(`Enabled continuous randomization for ${paramName} ${valueType} (range: ${minSlider.value}-${maxSlider.value})`, 'info');
      } else {
        this.log(`Disabled continuous randomization for ${paramName} ${valueType}`, 'info');
      }
      
      // Send updated config to synths
      this.broadcastRandomizationConfig();
    });

    // Update min value and config
    minSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      this.randomizationConfig[paramName][valueType].min = value;
      
      // Ensure min doesn't exceed max
      if (value >= parseFloat(maxSlider.value)) {
        maxSlider.value = (value + 0.01).toFixed(2);
        this.randomizationConfig[paramName][valueType].max = parseFloat(maxSlider.value);
      }
      
      // Send updated config to synths if enabled
      if (enableCheckbox.checked) {
        this.broadcastRandomizationConfig();
      }
    });
    
    // Update max value and config
    maxSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      this.randomizationConfig[paramName][valueType].max = value;
      
      // Ensure max doesn't go below min
      if (value <= parseFloat(minSlider.value)) {
        minSlider.value = (value - 0.01).toFixed(2);
        this.randomizationConfig[paramName][valueType].min = parseFloat(minSlider.value);
      }
      
      // Send updated config to synths if enabled
      if (enableCheckbox.checked) {
        this.broadcastRandomizationConfig();
      }
    });
  }


  applyRandomValue(paramName, min, max) {
    const randomValue = min + Math.random() * (max - min);
    const staticCheckbox = document.getElementById(`${paramName}-static`);
    
    if (staticCheckbox.checked) {
      // Static mode: set start value and broadcast immediately
      const slider = document.getElementById(`${paramName}-slider`);
      const valueDisplay = document.getElementById(`${paramName}-value`);
      
      slider.value = randomValue;
      const precision = paramName === 'frequency' ? 0 : 2;
      valueDisplay.textContent = precision === 0 ? randomValue.toString() : randomValue.toFixed(precision);
      
      this.broadcastMusicalParameters();
    } else {
      // Envelope mode: randomize both start and end values
      const startSlider = document.getElementById(`${paramName}-slider`);
      const endSlider = document.getElementById(`${paramName}-end-slider`);
      const startValue = document.getElementById(`${paramName}-value`);
      const endValue = document.getElementById(`${paramName}-end-value`);
      
      const randomStart = min + Math.random() * (max - min);
      const randomEnd = min + Math.random() * (max - min);
      
      const precision = paramName === 'frequency' ? 0 : 2;
      
      startSlider.value = randomStart;
      endSlider.value = randomEnd;
      startValue.textContent = precision === 0 ? randomStart.toString() : randomStart.toFixed(precision);
      endValue.textContent = precision === 0 ? randomEnd.toString() : randomEnd.toFixed(precision);
      
      // Update envelope preview
      this.updateParameterEnvelopePreview(paramName);
      this.markPendingChanges();
    }
    
    this.log(`Applied random ${paramName}: ${randomValue.toFixed(3)} (range: ${min.toFixed(2)}-${max.toFixed(2)})`, 'info');
  }

  // Close all randomizer modals when clicking outside

  // SIN (Stochastic Integer Notation) Parser
  // Parses notation like "1-3, 5, 7-9" into [1, 2, 3, 5, 7, 8, 9]
  parseSIN(sinString) {
    if (!sinString || sinString.trim() === '') {
      return [];
    }

    const result = [];
    const segments = sinString.split(',').map(s => s.trim());

    for (const segment of segments) {
      if (segment.includes('-')) {
        // Range notation like "1-3" or "7-9"
        const [startStr, endStr] = segment.split('-').map(s => s.trim());
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);

        if (isNaN(start) || isNaN(end)) {
          continue; // Skip invalid ranges
        }

        // Add all integers in the range (inclusive)
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
          if (!result.includes(i)) {
            result.push(i);
          }
        }
      } else {
        // Single integer like "5"
        const num = parseInt(segment, 10);
        if (!isNaN(num) && !result.includes(num)) {
          result.push(num);
        }
      }
    }

    // Sort the result array
    result.sort((a, b) => a - b);
    return result;
  }

  // Convert array back to SIN string for display
  arrayToSIN(integerArray) {
    if (!integerArray || integerArray.length === 0) {
      return '';
    }

    // Sort the array first
    const sorted = [...integerArray].sort((a, b) => a - b);
    const ranges = [];
    let rangeStart = sorted[0];
    let rangeEnd = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === rangeEnd + 1) {
        // Continue the current range
        rangeEnd = sorted[i];
      } else {
        // End the current range and start a new one
        if (rangeStart === rangeEnd) {
          ranges.push(rangeStart.toString());
        } else {
          ranges.push(`${rangeStart}-${rangeEnd}`);
        }
        rangeStart = sorted[i];
        rangeEnd = sorted[i];
      }
    }

    // Add the final range
    if (rangeStart === rangeEnd) {
      ranges.push(rangeStart.toString());
    } else {
      ranges.push(`${rangeStart}-${rangeEnd}`);
    }

    return ranges.join(', ');
  }

  // HRG Behavior implementations
  applyHRGBehavior(integerSet, behavior, synthIndex, totalSynths) {
    if (!integerSet || integerSet.length === 0) {
      return 1; // Default ratio
    }

    const setSize = integerSet.length;

    switch (behavior) {
      case 'static':
        // All synths get the same value (first in set)
        return integerSet[0];

      case 'ascending':
        // Distribute values in ascending order
        return integerSet[synthIndex % setSize];

      case 'descending':
        // Distribute values in descending order
        const descending = [...integerSet].reverse();
        return descending[synthIndex % setSize];

      case 'shuffle':
        // Fixed shuffle based on synthIndex (deterministic)
        const shuffled = this.deterministicShuffle([...integerSet], synthIndex);
        return shuffled[synthIndex % setSize];

      case 'random':
        // True random selection (non-repeating until all used)
        if (!this.hrgRandomState) {
          this.hrgRandomState = {};
        }
        if (!this.hrgRandomState[synthIndex]) {
          this.hrgRandomState[synthIndex] = [...integerSet];
          this.shuffleArray(this.hrgRandomState[synthIndex]);
        }
        
        const randomSet = this.hrgRandomState[synthIndex];
        if (randomSet.length === 0) {
          // Reset when exhausted
          this.hrgRandomState[synthIndex] = [...integerSet];
          this.shuffleArray(this.hrgRandomState[synthIndex]);
        }
        
        return randomSet.pop();

      default:
        return integerSet[0];
    }
  }

  // Deterministic shuffle based on seed
  deterministicShuffle(array, seed) {
    const rng = this.seededRandom(seed);
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  // Seeded random number generator
  seededRandom(seed) {
    let x = Math.sin(seed) * 10000;
    return function() {
      x = Math.sin(x) * 10000;
      return x - Math.floor(x);
    };
  }

  // Fisher-Yates shuffle
  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  // Generate harmonic ratio from numerator and denominator sets
  generateHarmonicRatio(numeratorSet, denominatorSet, behavior, synthIndex, totalSynths) {
    const num = this.applyHRGBehavior(numeratorSet, behavior, synthIndex, totalSynths);
    const den = this.applyHRGBehavior(denominatorSet, behavior, synthIndex, totalSynths);
    return num / den;
  }

  // Update the visual state of randomizer buttons

  // Send randomization configuration to synths
  broadcastRandomizationConfig() {
    if (!this.star) return;
    
    const message = MessageBuilder.randomizationConfig(this.randomizationConfig);
    const sent = this.star.broadcastToType('synth', message, 'control');
    this.log(`Sent randomization config to ${sent} synths`, 'info');
  }

  // Apply random value to specific start or end
  applyRandomValueSeparate(paramName, valueType, min, max) {
    const randomValue = min + Math.random() * (max - min);
    const staticCheckbox = document.getElementById(`${paramName}-static`);
    
    if (valueType === 'start') {
      const slider = document.getElementById(`${paramName}-slider`);
      const valueDisplay = document.getElementById(`${paramName}-value`);
      
      if (slider && valueDisplay) {
        slider.value = randomValue;
        const precision = paramName === 'frequency' ? 0 : 2;
        valueDisplay.textContent = precision === 0 ? randomValue.toString() : randomValue.toFixed(precision);
        
        if (staticCheckbox.checked) {
          this.broadcastMusicalParameters();
        } else {
          this.updateParameterEnvelopePreview(paramName);
          this.markPendingChanges();
        }
      }
    } else if (valueType === 'end' && staticCheckbox && !staticCheckbox.checked) {
      const endSlider = document.getElementById(`${paramName}-end-slider`);
      const endValue = document.getElementById(`${paramName}-end-value`);
      
      if (endSlider && endValue) {
        endSlider.value = randomValue;
        const precision = paramName === 'frequency' ? 0 : 2;
        endValue.textContent = precision === 0 ? randomValue.toString() : randomValue.toFixed(precision);
        
        this.updateParameterEnvelopePreview(paramName);
        this.markPendingChanges();
      }
    }
    
    this.log(`Applied random ${paramName} ${valueType}: ${randomValue.toFixed(3)} (range: ${min.toFixed(2)}-${max.toFixed(2)})`, 'info');
  }
}

// Initialize the control client
const controlClient = new ControlClient();

// Make it globally available for debugging
window.controlClient = controlClient;