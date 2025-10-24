// @ts-check

/**
 * Parameter utilities for Voice.Assembly.FM Control Client
 */

/**
 * Check if value is a range (contains hyphen)
 * @param {string} value - The value to check
 * @returns {boolean}
 */
export function isRangeValue(value) {
  const trimmed = value.trim();
  if (!trimmed.includes("-")) return false;

  // Simple range detection: split on hyphen and check if both parts are numbers
  const parts = trimmed.split("-");
  if (parts.length !== 2) return false;

  const [min, max] = parts.map((p) => p.trim());
  const minNum = parseFloat(min);
  const maxNum = parseFloat(max);

  return !isNaN(minNum) && !isNaN(maxNum);
}

/**
 * Map portamento normalized value (0-1) to milliseconds (exponential curve)
 * @param {number} norm - Normalized value (0-1)
 * @returns {number} - Portamento time in milliseconds
 */
export function mapPortamentoNormToMs(norm) {
  const clamped = Math.min(Math.max(norm, 0), 1);
  return 0.5 * Math.pow(40000, clamped);
}

/**
 * Serialize normalised generator range to string for UI display
 * @param {Object} gen - Generator configuration
 * @returns {string}
 */
export function stringifyNormalised(gen) {
  if (!gen) return "";
  const r = gen.range;
  if (typeof r === "number") return String(r);
  if (r && typeof r === "object") {
    const min = Number(r.min), max = Number(r.max);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return min === max ? String(min) : min + "-" + max;
    }
  }
  return String(r);
}

/**
 * Parse a value string into appropriate format for generator ranges
 * @param {string} value - The input value
 * @returns {number | {min: number, max: number}}
 */
export function parseRangeValue(value) {
  if (!isRangeValue(value)) {
    const num = parseFloat(value);
    return isNaN(num) ? 0 : num;
  }

  const [minStr, maxStr] = value.split("-").map((s) => s.trim());
  const min = parseFloat(minStr);
  const max = parseFloat(maxStr);

  if (isNaN(min) || isNaN(max)) {
    return 0;
  }

  return { min, max };
}

/**
 * Calculate steps from period when linkage is enabled
 * @param {number} period - Period in seconds
 * @param {number} stepRefSec - Step reference time
 * @returns {number} - Calculated steps (clamped to 1-256)
 */
export function calculateStepsFromPeriod(period, stepRefSec) {
  let targetSteps = Math.round(period / stepRefSec);
  return Math.max(1, Math.min(256, targetSteps));
}

/**
 * Validate and parse numeric input with default fallback
 * @param {string} value - Input value
 * @param {number} defaultValue - Default if invalid
 * @param {number} [min] - Minimum allowed value
 * @param {number} [max] - Maximum allowed value
 * @returns {number}
 */
export function parseNumericInput(
  value,
  defaultValue,
  min = -Infinity,
  max = Infinity,
) {
  const num = parseFloat(value);
  if (isNaN(num)) return defaultValue;
  return Math.min(Math.max(num, min), max);
}

/**
 * Format parameter path for sub-parameter updates
 * @param {string} paramName - Parameter name
 * @param {string} subParam - Sub-parameter name
 * @returns {string}
 */
export function formatParameterPath(paramName, subParam) {
  return paramName + "." + subParam;
}

/**
 * Get default value for a parameter type
 * @param {string} paramName - Parameter name
 * @returns {number}
 */
export function getDefaultValue(paramName) {
  const defaults = {
    frequency: 220,
    vowelX: 0.5,
    vowelY: 0.5,
    zingAmount: 0.5,
    zingMorph: 0.5,
    symmetry: 0.5,
    amplitude: 0.8,
    whiteNoise: 0,
    vibratoWidth: 0,
    vibratoRate: 5,
  };

  return defaults[paramName] || 0;
}
