/**
 * Type definitions for Voice.Assembly.FM parameter system
 * This file contains only TypeScript type and interface definitions
 */

/**
 * Defines how a value is chosen from a set at each discrete event (e.g., EOC).
 */
export interface GeneratorConfig {
  type: "periodic" | "normalised";

  // Sequence behavior - how values are selected from the set
  sequenceBehavior:
    | "static"
    | "ascending"
    | "descending"
    | "shuffle"
    | "random";

  // --- If type is 'periodic' (HRG) ---
  numerators?: string; // e.g., "1-3,5"
  denominators?: string; // e.g., "2,4"

  // --- If type is 'normalised' (RBG) ---
  range?: number | { min: number; max: number };
}

/**
 * Unified parameter state - no more direct/program distinction.
 * Parameters are applied immediately when paused, at EOC when playing.
 */
export type ParameterState =
  | {
    interpolation: "step"; // Values held constant between events
    baseValue?: number; // Required when using periodic generators
    startValueGenerator: GeneratorConfig;
  }
  | {
    interpolation: "cosine"; // Values that glide between events
    baseValue?: number; // Required when using periodic generators
    startValueGenerator: GeneratorConfig;
    endValueGenerator: GeneratorConfig;
  };

/**
 * Defines the shape of the entire musical state object.
 */
export interface IMusicalState {
  frequency: ParameterState;
  vowelX: ParameterState;
  vowelY: ParameterState;
  zingAmount: ParameterState;
  zingMorph: ParameterState;
  symmetry: ParameterState;
  amplitude: ParameterState;
  whiteNoise: ParameterState;
}
