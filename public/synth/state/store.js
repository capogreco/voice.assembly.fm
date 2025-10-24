// @ts-check

/**
 * Scene storage management for Voice.Assembly.FM Synth Client
 * Handles scene capture and restoration
 */

import {
  buildSceneSnapshot,
  loadScene as loadSceneSnapshot,
} from "./scenes.js";

/**
 * Capture current synth state as a scene snapshot
 * @param {any} context - Synth context
 * @param {number} bank - Memory bank location (0-9)
 */
export function captureSceneSnapshot(context, bank) {
  const snapshot = buildSceneSnapshot(context);
  context.sceneSnapshots[bank] = snapshot;

  // Diagnostic logging for generator state
  const freqHrg = snapshot.stochastic?.hrg?.frequency;
  if (freqHrg?.start) {
    console.log(
      `🔖 save scene ${bank}: frequency HRG start = [${freqHrg.start.indexN}] ${
        freqHrg.start.numerators?.[freqHrg.start.indexN]
      }/${freqHrg.start.denominators?.[freqHrg.start.indexD]} (arrays: [${freqHrg.start.numerators}] / [${freqHrg.start.denominators}])`,
    );
  }
  if (freqHrg?.end) {
    console.log(
      `🔖 save scene ${bank}: frequency HRG end = [${freqHrg.end.indexN}] ${
        freqHrg.end.numerators?.[freqHrg.end.indexN]
      }/${freqHrg.end.denominators?.[freqHrg.end.indexD]} (arrays: [${freqHrg.end.numerators}] / [${freqHrg.end.denominators}])`,
    );
  }

  console.log(`💾 Captured scene ${bank} (v${snapshot.v})`);
}

/**
 * Restore a scene from a snapshot
 * @param {any} snapshot - Scene snapshot
 * @param {any} context - Synth context
 * @param {number|null} [portamentoNorm] - Portamento time normalized 0-1
 */
export function restoreSceneFromSnapshot(
  snapshot,
  context,
  portamentoNorm = null,
) {
  if (!snapshot) {
    console.warn("⚠️ No snapshot provided for scene restore");
    return;
  }

  // Use the existing loadScene function which handles all the restoration logic
  loadSceneSnapshot(snapshot, context, portamentoNorm);
}

/**
 * Clear a scene bank
 * @param {any} context - Synth context
 * @param {number} bank - Memory bank location (0-9)
 */
export function clearSceneBank(context, bank) {
  if (context.sceneSnapshots[bank]) {
    context.sceneSnapshots[bank] = null;
    console.log(`🧹 Cleared synth scene bank ${bank}`);
  }
}

/**
 * Clear all scene banks
 * @param {any} context - Synth context
 */
export function clearAllSceneBanks(context) {
  const cleared = context.sceneSnapshots.filter(Boolean).length;
  context.sceneSnapshots = [];
  console.log(`🧹 Cleared ${cleared} synth scene bank(s)`);
}
