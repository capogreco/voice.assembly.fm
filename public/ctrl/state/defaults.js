// @ts-check

/**
 * Default state and preset generators for Voice.Assembly.FM
 */

// JSDoc type imports
/** @typedef {import('../../../src/common/parameter-types.js').IMusicalState} IMusicalState */
/** @typedef {import('../../../src/common/parameter-types.js').GeneratorConfig} GeneratorConfig */

/**
 * Helper for frequency (uses HRG with both start and end generators)
 */
function defaultFrequencyState() {
  return {
    interpolation: "step",
    baseValue: 220,
    startValueGenerator: {
      type: "periodic",
      numerators: "1",
      denominators: "1",
      numeratorBehavior: "static",
      denominatorBehavior: "static",
    },
    endValueGenerator: {
      type: "periodic",
      numerators: "1",
      denominators: "1",
      numeratorBehavior: "static",
      denominatorBehavior: "static",
    },
  };
}

/**
 * Helper for normalized parameters (0-1 range)
 */
function defaultNormalizedState() {
  return {
    interpolation: "cosine",
    startValueGenerator: {
      type: "normalised",
      range: { min: 0, max: 1 },
      sequenceBehavior: "static",
    },
    endValueGenerator: {
      type: "normalised",
      range: { min: 0, max: 1 },
      sequenceBehavior: "static",
    },
  };
}

/**
 * Helper for simple constant parameters
 * @param {number} value - The constant value
 */
function defaultConstantState(value) {
  return {
    interpolation: "step",
    baseValue: value,
    startValueGenerator: {
      type: "normalised",
      range: value,
      sequenceBehavior: "static",
    },
  };
}

/**
 * Create default musical state
 * @returns {IMusicalState}
 */
export function createDefaultState() {
  return {
    frequency: defaultFrequencyState(),
    vowelX: defaultNormalizedState(),
    vowelY: defaultNormalizedState(),
    zingAmount: defaultNormalizedState(),
    zingMorph: defaultNormalizedState(),
    symmetry: defaultNormalizedState(),
    amplitude: defaultConstantState(0.8),
    whiteNoise: defaultConstantState(0),
    vibratoWidth: {
      interpolation: "step",
      startValueGenerator: {
        type: "normalised",
        range: 0,
        sequenceBehavior: "static",
      },
    },
    vibratoRate: {
      interpolation: "step",
      startValueGenerator: {
        type: "normalised",
        range: 5,
        sequenceBehavior: "static",
      },
    },
  };
}

/**
 * Create preset configurations
 * @returns {Object<string, IMusicalState>}
 */
export function createPresetConfigs() {
  return {
    default: createDefaultState(),
    
    "gentle-sweep": {
      frequency: {
        interpolation: "cosine",
        baseValue: 440,
        startValueGenerator: {
          type: "periodic",
          numerators: "1,3,5",
          denominators: "2,4",
          numeratorBehavior: "ascending",
          denominatorBehavior: "static",
        },
        endValueGenerator: {
          type: "periodic",
          numerators: "1,2,3",
          denominators: "1,2",
          numeratorBehavior: "descending",
          denominatorBehavior: "static",
        },
      },
      vowelX: {
        interpolation: "cosine",
        startValueGenerator: {
          type: "normalised",
          range: { min: 0.2, max: 0.8 },
          sequenceBehavior: "random",
        },
        endValueGenerator: {
          type: "normalised",
          range: { min: 0.1, max: 0.9 },
          sequenceBehavior: "random",
        },
      },
      vowelY: {
        interpolation: "cosine",
        startValueGenerator: {
          type: "normalised",
          range: { min: 0.3, max: 0.7 },
          sequenceBehavior: "random",
        },
        endValueGenerator: {
          type: "normalised",
          range: { min: 0.2, max: 0.8 },
          sequenceBehavior: "random",
        },
      },
      zingAmount: defaultNormalizedState(),
      zingMorph: defaultNormalizedState(),
      symmetry: defaultNormalizedState(),
      amplitude: defaultConstantState(0.6),
      whiteNoise: defaultConstantState(0.1),
      vibratoWidth: {
        interpolation: "step",
        startValueGenerator: {
          type: "normalised",
          range: 0.05,
          sequenceBehavior: "static",
        },
      },
      vibratoRate: {
        interpolation: "step",
        startValueGenerator: {
          type: "normalised",
          range: 4,
          sequenceBehavior: "static",
        },
      },
    },

    "rhythmic-pulse": {
      frequency: {
        interpolation: "step",
        baseValue: 330,
        startValueGenerator: {
          type: "periodic",
          numerators: "1,2,3,5",
          denominators: "4,8",
          numeratorBehavior: "shuffle",
          denominatorBehavior: "static",
        },
        endValueGenerator: {
          type: "periodic",
          numerators: "1,3,7",
          denominators: "2,4",
          numeratorBehavior: "random",
          denominatorBehavior: "static",
        },
      },
      vowelX: defaultNormalizedState(),
      vowelY: defaultNormalizedState(),
      zingAmount: {
        interpolation: "step",
        startValueGenerator: {
          type: "normalised",
          range: { min: 0.3, max: 0.9 },
          sequenceBehavior: "random",
        },
        endValueGenerator: {
          type: "normalised",
          range: { min: 0.1, max: 0.7 },
          sequenceBehavior: "random",
        },
      },
      zingMorph: defaultNormalizedState(),
      symmetry: defaultNormalizedState(),
      amplitude: defaultConstantState(0.7),
      whiteNoise: defaultConstantState(0),
      vibratoWidth: {
        interpolation: "step",
        startValueGenerator: {
          type: "normalised",
          range: 0,
          sequenceBehavior: "static",
        },
      },
      vibratoRate: {
        interpolation: "step",
        startValueGenerator: {
          type: "normalised",
          range: 5,
          sequenceBehavior: "static",
        },
      },
    },
  };
}