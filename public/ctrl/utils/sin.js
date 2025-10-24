// @ts-check

/**
 * Simple Integer Notation (SIN) parser and formatter
 * Handles comma-separated values and ranges like "1-4,8" → [1,2,3,4,8]
 */

/**
 * Parse a SIN string into an array of numbers
 * @param {string} sin - SIN string like "1-3,5,7-9"
 * @returns {number[]} - Parsed array of numbers
 * @throws {Error} - If the string is invalid
 */
export function parseSinString(sin) {
  if (!sin || typeof sin !== "string") {
    return [1]; // Default to [1] for empty/invalid input
  }

  const results = [];
  const parts = sin.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    
    if (!trimmed) continue; // Skip empty parts
    
    if (trimmed.includes("-")) {
      // Handle range like "1-4"
      const rangeParts = trimmed.split("-");
      if (rangeParts.length !== 2) {
        throw new Error(`Invalid range format: "${trimmed}"`);
      }
      
      const start = parseInt(rangeParts[0].trim(), 10);
      const end = parseInt(rangeParts[1].trim(), 10);
      
      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid numbers in range: "${trimmed}"`);
      }
      
      if (start > end) {
        throw new Error(`Invalid range (start > end): "${trimmed}"`);
      }
      
      for (let i = start; i <= end; i++) {
        results.push(i);
      }
    } else {
      // Handle single number
      const num = parseInt(trimmed, 10);
      if (isNaN(num)) {
        throw new Error(`Invalid number: "${trimmed}"`);
      }
      results.push(num);
    }
  }

  if (results.length === 0) {
    return [1]; // Default if nothing valid was parsed
  }

  return results;
}

/**
 * Format an array of numbers back to a SIN string
 * Attempts to compress consecutive ranges for readability
 * @param {number[]} arr - Array of numbers
 * @returns {string} - Formatted SIN string
 */
export function formatSinArray(arr) {
  if (!arr || arr.length === 0) {
    return "1";
  }

  // Sort and deduplicate
  const sorted = [...new Set(arr)].sort((a, b) => a - b);
  
  const parts = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];

  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i];
    
    if (i === sorted.length || current !== rangeEnd + 1) {
      // End of a range or the array
      if (rangeStart === rangeEnd) {
        parts.push(rangeStart.toString());
      } else if (rangeEnd === rangeStart + 1) {
        // Two consecutive numbers - list them separately
        parts.push(rangeStart.toString());
        parts.push(rangeEnd.toString());
      } else {
        // Range of 3+ numbers
        parts.push(`${rangeStart}-${rangeEnd}`);
      }
      
      if (i < sorted.length) {
        rangeStart = current;
        rangeEnd = current;
      }
    } else {
      rangeEnd = current;
    }
  }

  return parts.join(",");
}

/**
 * Validate a SIN string without parsing completely
 * @param {string} sin - SIN string to validate
 * @returns {{valid: boolean, error?: string}} - Validation result
 */
export function validateSinString(sin) {
  try {
    const result = parseSinString(sin);
    if (result.length === 0) {
      return { valid: false, error: "Empty result" };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}