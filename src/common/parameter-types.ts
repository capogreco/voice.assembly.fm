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
  baseValue?: number; // Base frequency for ratio calculations

  // --- If type is 'normalised' (RBG) ---
  range?: number | { min: number; max: number };
}

/**
 * A discriminated union representing all possible states for a single parameter.
 * The 'interpolation' property acts as the discriminant for program mode.
 */
export type ParameterState =
  | {
    scope: "direct";
    directValue: number;
  }
  | {
    scope: "program";
    interpolation: "step"; // Values held constant between events
    startValueGenerator: GeneratorConfig;
    directValue?: number; // Used as baseValue for HRG
  }
  | {
    scope: "program";
    interpolation: "linear" | "cosine" | "parabolic"; // Values that glide between events
    startValueGenerator: GeneratorConfig;
    endValueGenerator: GeneratorConfig;
    intensity?: number; // Curve shaping for non-linear interpolations
    directValue?: number; // Used as baseValue for HRG
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
