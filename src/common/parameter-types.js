/**
 * Type definitions for Voice.Assembly.FM parameter system
 * This file contains only JSDoc typedef definitions for browser use
 * No runtime exports - pure type definitions for editor support
 */

/**
 * Defines how a value is chosen from a set at each discrete event (e.g., EOC).
 * @typedef {Object} GeneratorConfig
 * @property {"periodic" | "normalised"} type
 *
 * // --- If type is 'normalised' (RBG) ---
 * @property {"static" | "random"} [sequenceBehavior] - Sequence behavior for normalised generators only
 * @property {number | {min: number, max: number}} [range] - Value or range for normalised generators
 *
 * // --- If type is 'periodic' (HRG) ---
 * @property {string} [numerators] - e.g., "1-3,5"
 * @property {string} [denominators] - e.g., "2,4"
 * @property {"static" | "ascending" | "descending" | "shuffle" | "random"} [numeratorBehavior] - Independent behavior for numerator sequence
 * @property {"static" | "ascending" | "descending" | "shuffle" | "random"} [denominatorBehavior] - Independent behavior for denominator sequence
 */

/**
 * Unified parameter state - no more direct/program distinction.
 * Parameters are applied immediately when paused, at EOC when playing.
 * @typedef {Object} ParameterState
 * @property {"step" | "disc" | "cont"} interpolation - step: values held constant between events, disc: discrete cosine (re-resolve both at EOC), cont: continuous cosine (smooth morphing across cycles)
 * @property {number} [baseValue] - Required when using periodic generators (param-level only, never in generators)
 * @property {GeneratorConfig} startValueGenerator - Start value generator configuration
 * @property {GeneratorConfig} [endValueGenerator] - End value generator (required for disc/cont interpolation, always present for periodic params)
 */

/**
 * Defines the shape of the entire control state object.
 * @typedef {Object} IControlState
 * @property {ParameterState} frequency
 * @property {ParameterState} vowelX
 * @property {ParameterState} vowelY
 * @property {ParameterState} zingAmount
 * @property {ParameterState} zingMorph
 * @property {ParameterState} symmetry
 * @property {ParameterState} amplitude
 * @property {ParameterState} whiteNoise
 * @property {ParameterState} vibratoWidth
 * @property {ParameterState} vibratoRate
 */

// No exports - this file is for JSDoc typedef imports only
