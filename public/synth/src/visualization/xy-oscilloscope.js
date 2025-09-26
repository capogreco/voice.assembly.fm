/**
 * XY Oscilloscope for Voice.Assembly.FM
 * Visualizes dual-channel audio as XY plot
 */

export class XYOscilloscope {
  constructor(canvas, audioContext, inputNode) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.audioContext = audioContext;
    this.inputNode = inputNode;

    // Create channel splitter to separate stereo channels
    this.channelSplitter = audioContext.createChannelSplitter(2);

    // Create separate analysers for left (X) and right (Y) channels
    this.leftAnalyser = audioContext.createAnalyser();
    this.rightAnalyser = audioContext.createAnalyser();

    this.leftAnalyser.fftSize = 1024;
    this.rightAnalyser.fftSize = 1024;
    this.bufferLength = this.leftAnalyser.fftSize;

    // Data arrays for each channel
    this.leftData = new Float32Array(this.bufferLength);
    this.rightData = new Float32Array(this.bufferLength);

    // Connect: Input -> ChannelSplitter -> Separate Analysers
    this.inputNode.connect(this.channelSplitter);
    this.channelSplitter.connect(this.leftAnalyser, 0); // Left channel
    this.channelSplitter.connect(this.rightAnalyser, 1); // Right channel

    // Animation and trail effect
    this.isRunning = false;
    this.animationId = null;
    this.trailFactor = 0.05; // How much trail to leave (0-1)

    this.resize();
  }

  resize() {
    // Get dimensions from parent container instead of canvas itself
    const container = this.canvas.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;

    // Calculate display size
    const displayWidth = rect.width;
    const displayHeight = rect.height;

    // Set CSS size first to avoid visual glitches
    this.canvas.style.width = displayWidth + "px";
    this.canvas.style.height = displayHeight + "px";

    // Set buffer size with device pixel ratio
    this.canvas.width = displayWidth * dpr;
    this.canvas.height = displayHeight * dpr;

    // Reset transform and apply DPR scaling
    this.ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform matrix
    this.ctx.scale(dpr, dpr);

    // Store display dimensions
    this.width = displayWidth;
    this.height = displayHeight;
    this.centerX = this.width / 2;
    this.centerY = this.height / 2;
  }

  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    this.draw();
  }

  stop() {
    this.isRunning = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  disconnect() {
    // Disconnect existing connections to allow reconnection
    try {
      // Disconnect input to channelSplitter
      if (this.inputNode) {
        this.inputNode.disconnect(this.channelSplitter);
      }
      // Disconnect channelSplitter outputs
      if (this.channelSplitter) {
        this.channelSplitter.disconnect();
      }
    } catch (e) {
      // Ignore if already disconnected
    }
  }

  draw() {
    if (!this.isRunning) return;

    this.animationId = requestAnimationFrame(() => this.draw());

    // Get audio data from separate analysers
    this.leftAnalyser.getFloatTimeDomainData(this.leftData);
    this.rightAnalyser.getFloatTimeDomainData(this.rightData);

    // Clear canvas with dark background (like euclidean reference)
    this.ctx.fillStyle = "#1a1a1a";
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Plot consecutive instantaneous sample points per frame
    const maxRadius = Math.min(this.centerX, this.centerY) * 0.8;
    const samplesPerFrame = 256; // Match euclidean reference

    // Create frame points array (like euclidean reference)
    const framePoints = [];

    for (let i = 0; i < Math.min(samplesPerFrame, this.bufferLength); i++) {
      let xSample = this.leftData[i];
      let ySample = this.rightData[i];

      // Clamp samples to avoid extreme values

      // Convert to screen coordinates with consistent scaling
      const amplification = 0.5; // Balanced amplification for all signals
      const x = this.centerX + (xSample * amplification * maxRadius);
      const y = this.centerY - (ySample * amplification * maxRadius); // Negative for correct orientation

      framePoints.push({ x, y });
    }

    // Draw the frame as a continuous path (euclidean style)
    if (framePoints.length >= 2) {
      this.ctx.strokeStyle = "#ffffff"; // White lines for clean visibility
      this.ctx.lineWidth = 1;
      this.ctx.lineCap = "round";
      this.ctx.lineJoin = "round";

      this.ctx.beginPath();
      this.ctx.moveTo(framePoints[0].x, framePoints[0].y);

      for (let i = 1; i < framePoints.length; i++) {
        this.ctx.lineTo(framePoints[i].x, framePoints[i].y);
      }

      this.ctx.stroke();
    }
  }

  drawGrid() {
    // Clean background - no grid elements (like euclidean reference)
    // Just a plain dark background for minimal distraction
  }
}
