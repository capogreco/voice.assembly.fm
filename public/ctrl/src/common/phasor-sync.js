/**
 * Phasor Synchronization System for Voice.Assembly.FM
 * Handles distributed timing synchronization across the network
 */

import { MessageBuilder, MessageTypes } from './message-protocol.js';
import { PhasorSync, ClockFilter } from './timing-math.js';

/**
 * Master Phasor Controller (runs on ctrl client)
 */
export class MasterPhasorController extends EventTarget {
  constructor(star) {
    super();
    this.star = star;
    this.isLeader = false;
    this.phasor = 0.0;
    this.cycleFreq = 0.5; // Hz (2-second cycles by default)
    this.lastUpdateTime = performance.now();
    this.syncInterval = null;
    this.isRunning = false;
    
    // Listen for leadership changes
    this.star.addEventListener('leader-changed', (event) => {
      this.isLeader = event.detail.isLeader;
      console.log(`👑 Master phasor controller leader status: ${this.isLeader}`);
    });
    
    console.log('👑 Master phasor controller initialized');
  }

  /**
   * Start phasor generation and synchronization broadcasting
   */
  start(cycleDurationSeconds = 2.0) {
    if (this.isRunning) {
      this.stop();
    }

    this.cycleFreq = 1.0 / cycleDurationSeconds;
    this.isRunning = true;
    this.lastUpdateTime = performance.now();
    
    console.log(`▶️ Master phasor started: ${cycleDurationSeconds}s cycles (${this.cycleFreq.toFixed(3)} Hz)`);

    // Start sync broadcast timer
    this.syncInterval = setInterval(() => {
      this.broadcastSync();
    }, 100); // Broadcast every 100ms

    // Start phasor update timer
    this.updateInterval = setInterval(() => {
      this.updatePhasor();
    }, 16); // Update at ~60 FPS

    this.dispatchEvent(new CustomEvent('started', {
      detail: { cycleFreq: this.cycleFreq }
    }));
  }

  /**
   * Stop phasor generation
   */
  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    console.log('⏹️ Master phasor stopped');
    this.dispatchEvent(new CustomEvent('stopped'));
  }

  /**
   * Update local phasor based on time progression
   */
  updatePhasor() {
    const currentTime = performance.now();
    const deltaTime = (currentTime - this.lastUpdateTime) / 1000; // Convert to seconds
    
    const prevPhasor = this.phasor;
    this.phasor = (this.phasor + this.cycleFreq * deltaTime) % 1.0;
    this.lastUpdateTime = currentTime;

    // Detect cycle boundary crossing
    if (prevPhasor > 0.9 && this.phasor < 0.1) {
      this.dispatchEvent(new CustomEvent('cycle-start', {
        detail: { phasor: this.phasor, audioTime: currentTime }
      }));
    }

    // Emit regular phasor updates
    this.dispatchEvent(new CustomEvent('phasor-update', {
      detail: { phasor: this.phasor, audioTime: currentTime }
    }));
  }

  /**
   * Broadcast sync message to all peers
   */
  broadcastSync() {
    if (!this.isRunning || !this.isLeader) return;

    const syncMessage = MessageBuilder.phasorSync(
      this.phasor,
      this.cycleFreq,
      performance.now()
    );

    const sent = this.star.broadcast(syncMessage, 'sync');
    
    if (sent > 0) {
      console.log(`📡 Broadcast phasor sync: ${this.phasor.toFixed(3)} to ${sent} peers`);
    }
  }

  /**
   * Get current phasor state
   */
  getCurrentState() {
    return {
      phasor: this.phasor,
      cycleFreq: this.cycleFreq,
      isRunning: this.isRunning,
      audioTime: performance.now()
    };
  }

  /**
   * Set cycle duration
   */
  setCycleDuration(seconds) {
    const oldFreq = this.cycleFreq;
    this.cycleFreq = 1.0 / seconds;
    
    console.log(`🔄 Cycle duration changed: ${seconds}s (${oldFreq.toFixed(3)} -> ${this.cycleFreq.toFixed(3)} Hz)`);
    
    this.dispatchEvent(new CustomEvent('cycle-duration-changed', {
      detail: { 
        duration: seconds, 
        oldFreq, 
        newFreq: this.cycleFreq 
      }
    }));
  }
}

/**
 * Client Phasor Synchronizer (runs on synth clients)
 */
export class ClientPhasorSynchronizer extends EventTarget {
  constructor(star) {
    super();
    this.star = star;
    this.phasorSync = new PhasorSync();
    this.clockFilter = new ClockFilter(0.1);
    this.isActive = false;
    this.lastSyncTime = 0;
    this.syncTimeout = null;
    
    // Listen for sync messages from master
    this.star.addEventListener('data-message', (event) => {
      const { message } = event.detail;
      if (message.type === MessageTypes.PHASOR_SYNC) {
        this.handlePhasorSync(message);
      }
    });

    console.log('🎯 Slave phasor synchronizer initialized');
  }

  /**
   * Handle phasor sync message from master
   */
  handlePhasorSync(syncMessage) {
    const currentTime = performance.now();
    
    // Update phasor synchronization
    this.phasorSync.updateFromMaster(
      syncMessage.phasor,
      syncMessage.cycleFreq,
      syncMessage.audioTime,
      currentTime
    );

    // Record timing for health monitoring
    const messageAge = currentTime - syncMessage.timestamp;
    this.clockFilter.update(messageAge, messageAge); // Simple approximation

    this.lastSyncTime = currentTime;
    this.isActive = true;

    // Reset sync timeout
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }
    
    this.syncTimeout = setTimeout(() => {
      this.handleSyncLoss();
    }, 5000); // Consider sync lost after 5 seconds

    // Check for cycle boundary
    if (this.phasorSync.detectCycleStart()) {
      this.dispatchEvent(new CustomEvent('cycle-start', {
        detail: { 
          phasor: this.phasorSync.getCurrentPhasor(),
          audioTime: currentTime 
        }
      }));
    }

    // Emit sync update
    this.dispatchEvent(new CustomEvent('sync-update', {
      detail: { 
        phasor: this.phasorSync.getCurrentPhasor(),
        cycleFreq: this.phasorSync.cycleFreq,
        audioTime: currentTime,
        health: this.clockFilter.getEstimate()
      }
    }));

    console.log(`🎯 Sync update: phasor=${this.phasorSync.getCurrentPhasor().toFixed(3)}, age=${messageAge.toFixed(1)}ms`);
  }

  /**
   * Handle loss of synchronization
   */
  handleSyncLoss() {
    console.warn('⚠️ Phasor sync lost - no master updates received');
    this.isActive = false;
    
    this.dispatchEvent(new CustomEvent('sync-lost', {
      detail: { 
        lastSyncTime: this.lastSyncTime,
        timeSinceLast: performance.now() - this.lastSyncTime 
      }
    }));
  }

  /**
   * Get current synchronized phasor
   */
  getCurrentPhasor() {
    return this.phasorSync.getCurrentPhasor();
  }

  /**
   * Get synchronization health metrics
   */
  getSyncHealth() {
    return {
      isActive: this.isActive,
      lastSyncTime: this.lastSyncTime,
      timeSinceLastSync: performance.now() - this.lastSyncTime,
      clockFilter: this.clockFilter.getEstimate(),
      phasor: this.phasorSync.getCurrentPhasor(),
      cycleFreq: this.phasorSync.cycleFreq
    };
  }

  /**
   * Cleanup
   */
  cleanup() {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    
    this.isActive = false;
    console.log('🧹 Slave phasor synchronizer cleaned up');
  }
}

/**
 * Cycle-based Parameter Scheduler
 * Schedules parameter changes to occur at specific cycle positions
 */
export class CycleScheduler extends EventTarget {
  constructor(phasorController) {
    super();
    this.phasor = phasorController;
    this.scheduledEvents = new Map(); // eventId -> { phasorTarget, callback, data }
    this.activeScheduler = null;
    
    // Listen for phasor updates
    this.phasor.addEventListener('phasor-update', (event) => {
      this.processPendingEvents(event.detail);
    });

    this.phasor.addEventListener('sync-update', (event) => {
      this.processPendingEvents(event.detail);
    });
  }

  /**
   * Schedule an event to occur at a specific phasor position
   */
  scheduleAtPhasor(targetPhasor, callback, data = null) {
    const eventId = Math.random().toString(36).substring(2);
    
    this.scheduledEvents.set(eventId, {
      phasorTarget: targetPhasor,
      callback,
      data,
      scheduled: performance.now()
    });

    console.log(`⏰ Scheduled event ${eventId} for phasor ${targetPhasor.toFixed(3)}`);
    return eventId;
  }

  /**
   * Schedule an event to occur at the next cycle start
   */
  scheduleAtNextCycle(callback, data = null) {
    return this.scheduleAtPhasor(0.0, callback, data);
  }

  /**
   * Cancel a scheduled event
   */
  cancelEvent(eventId) {
    if (this.scheduledEvents.has(eventId)) {
      this.scheduledEvents.delete(eventId);
      console.log(`❌ Cancelled event ${eventId}`);
      return true;
    }
    return false;
  }

  /**
   * Process pending events based on current phasor position
   */
  processPendingEvents({ phasor, audioTime }) {
    const eventsToRemove = [];
    
    for (const [eventId, event] of this.scheduledEvents) {
      // Check if we've reached or passed the target phasor
      const threshold = 0.01; // 1% tolerance
      
      if (this.hasPhasorPassed(phasor, event.phasorTarget, threshold)) {
        try {
          event.callback(event.data, { 
            phasor, 
            audioTime,
            scheduledPhasor: event.phasorTarget,
            eventId 
          });
          
          console.log(`✅ Executed scheduled event ${eventId} at phasor ${phasor.toFixed(3)}`);
        } catch (error) {
          console.error(`❌ Error executing scheduled event ${eventId}:`, error);
        }
        
        eventsToRemove.push(eventId);
      }
    }

    // Clean up executed events
    for (const eventId of eventsToRemove) {
      this.scheduledEvents.delete(eventId);
    }
  }

  /**
   * Check if current phasor has passed the target (handling wraparound)
   */
  hasPhasorPassed(current, target, threshold) {
    // Simple case: target is ahead in the same cycle
    if (target > current) {
      return false;
    }
    
    // Handle wraparound case
    const distance = current - target;
    return distance <= threshold || distance >= (1.0 - threshold);
  }

  /**
   * Get pending events count
   */
  getPendingCount() {
    return this.scheduledEvents.size;
  }

  /**
   * Clear all pending events
   */
  clearAll() {
    const count = this.scheduledEvents.size;
    this.scheduledEvents.clear();
    console.log(`🧹 Cleared ${count} pending events`);
  }
}