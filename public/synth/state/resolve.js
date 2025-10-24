// @ts-check

/**
 * Pure resolver for program configurations
 * Resolves generator values without mutating synth state
 */

/**
 * @typedef {Object} ResolveContext
 * @property {Object} programConfig - Program configuration
 * @property {Object} hrgState - HRG state tracking
 * @property {Record<string, any>} rbgState - RBG state tracking
 * @property {function(string): boolean} isCosInterp - Check if interpolation is cosine-based
 * @property {function(string, "start"|"end", boolean=): number} resolveHRG - Resolve HRG value
 * @property {function(Object, string=, "start"|"end"=): number} resolveRBG - Resolve RBG value
 */

/**
 * @typedef {Object} ResolvedParam
 * @property {string} interpolation - Interpolation type
 * @property {number} startValue - Start value
 * @property {number} endValue - End value
 */

/**
 * Resolve program configuration to concrete values
 * Pure function - no side effects, no state mutation
 *
 * @param {ResolveContext} ctx - Resolution context
 * @returns {Record<string, ResolvedParam>} - Resolved parameters
 */
export function resolveProgramSnapshot(ctx) {
  /** @type {Record<string, ResolvedParam>} */
  const resolved = {};

  if (!ctx.programConfig) {
    return resolved;
  }

  for (const [paramName, paramConfig] of Object.entries(ctx.programConfig)) {
    if (!paramConfig) continue;

    const interpolation = paramConfig.interpolation || "step";

    // Resolve start value
    let startValue = 0;
    if (paramConfig.startValueGenerator) {
      const gen = paramConfig.startValueGenerator;
      if (gen.type === "periodic") {
        startValue = ctx.resolveHRG(paramName, "start", true); // Use peek to avoid advancing
      } else {
        startValue = ctx.resolveRBG(gen, paramName, "start", true); // Use peek for save/load
      }
    }

    // Resolve end value
    let endValue = startValue;
    if (ctx.isCosInterp(interpolation)) {
      if (paramConfig.endValueGenerator) {
        const gen = paramConfig.endValueGenerator;
        if (gen.type === "periodic") {
          endValue = ctx.resolveHRG(paramName, "end", true); // Use peek
        } else {
          endValue = ctx.resolveRBG(gen, paramName, "end", true); // Use peek for save/load
        }
      }
    } else if (interpolation === "cont") {
      // For cont interpolation, end value comes from RBG state if available
      const rbgEnd = ctx.rbgState?.[paramName]?.endValue;
      if (rbgEnd !== undefined && rbgEnd !== null) {
        endValue = rbgEnd;
      } else {
        endValue = startValue;
      }
    }

    resolved[paramName] = {
      interpolation,
      startValue,
      endValue,
    };
  }

  return resolved;
}

/**
 * Build resolved values from a cached snapshot
 * Used when loading scenes to restore exact values
 *
 * @param {Record<string, ResolvedParam>} cachedResolved - Cached resolved values
 * @returns {Record<string, ResolvedParam>} - Resolved parameters for worklet
 */
export function buildResolvedFromSnapshot(cachedResolved) {
  /** @type {Record<string, ResolvedParam>} */
  const resolved = {};

  if (!cachedResolved) {
    return resolved;
  }

  // Direct mapping - snapshot already has the right format
  for (const [paramName, values] of Object.entries(cachedResolved)) {
    if (!values) continue;

    resolved[paramName] = {
      interpolation: values.interpolation || "step",
      startValue: values.startValue || 0,
      endValue: values.endValue || values.startValue || 0,
    };
  }

  return resolved;
}

/**
 * Helper to check if interpolation is cosine-based
 * @param {string} interp - Interpolation type
 * @returns {boolean} - True if cosine-based
 */
export function isCosineInterpolation(interp) {
  return interp === "disc" || interp === "cont";
}
