// @ts-check

/**
 * Default state and preset generators for Voice.Assembly.FM
 */

// JSDoc type imports
/** @typedef {import('../../../src/common/parameter-types.js').IControlState} IControlState */
/** @typedef {import('../../../src/common/parameter-types.js').GeneratorConfig} GeneratorConfig */

/**
 * Helper for frequency (uses HRG with both start and end generators)
 */
function defaultFrequencyState() {
  return {
    interpolation: "disc", // Use disc for more interesting frequency changes
    baseValue: 220,
    startValueGenerator: {
      type: "periodic",
      numerators: "1-3",
      denominators: "1-2",
      numeratorBehavior: "random",
      denominatorBehavior: "random",
    },
    endValueGenerator: {
      type: "periodic",
      numerators: "1-3",
      denominators: "1-2",
      numeratorBehavior: "random",
      denominatorBehavior: "random",
    },
  };
}

/**
 * Helper for normalized parameters (0-1 range)
 * Uses random behavior to create animated defaults
 */
function defaultNormalizedState() {
  return {
    interpolation: "cont",
    baseValue: 1.0, // Base value for proper UI display
    startValueGenerator: {
      type: "normalised",
      range: { min: 0, max: 1 },
      sequenceBehavior: "random",
    },
    endValueGenerator: {
      type: "normalised",
      range: { min: 0, max: 1 },
      sequenceBehavior: "random",
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
      sequenceBehavior: "static", // Keep constants static
    },
  };
}

/**
 * Create default control state
 * @returns {IControlState}
 */
export function createDefaultState() {
  return {
    frequency: defaultFrequencyState(), // Use default disc interpolation from helper
    vowelX: (() => {
      const state = defaultNormalizedState();
      state.baseValue = 0.5; // Center vowel space
      return state;
    })(),
    vowelY: (() => {
      const state = defaultNormalizedState();
      state.baseValue = 0.5; // Center vowel space
      return state;
    })(),
    zingAmount: (() => {
      const state = defaultNormalizedState();
      state.baseValue = 0.3; // Light zing by default
      return state;
    })(),
    zingMorph: (() => {
      const state = defaultNormalizedState();
      state.baseValue = 0.5; // Balanced morph
      return state;
    })(),
    symmetry: (() => {
      const state = defaultNormalizedState();
      state.baseValue = 0.5; // Balanced symmetry
      return state;
    })(),
    amplitude: (() => {
      const amp = defaultConstantState(0.8);
      amp.interpolation = "step";
      return amp;
    })(),
    whiteNoise: (() => {
      const noise = defaultConstantState(0);
      noise.interpolation = "step";
      return noise;
    })(),
    vibratoWidth: {
      interpolation: "cont",
      baseValue: 1.0, // Base value for proper UI display
      startValueGenerator: {
        type: "normalised",
        range: { min: 0, max: 0.1 },
        sequenceBehavior: "random",
      },
      endValueGenerator: {
        type: "normalised",
        range: { min: 0, max: 0.1 },
        sequenceBehavior: "random",
      },
    },
    vibratoRate: {
      interpolation: "cont",
      baseValue: 5.0, // Base value for proper UI display
      startValueGenerator: {
        type: "normalised",
        range: { min: 3, max: 8 },
        sequenceBehavior: "random",
      },
      endValueGenerator: {
        type: "normalised",
        range: { min: 3, max: 8 },
        sequenceBehavior: "random",
      },
    },
  };
}

/**
 * Create preset configurations
 * @returns {Object<string, IControlState>}
 */
export function createPresetConfigs() {
  return {
    default: createDefaultState(),

    "gentle-sweep": {
      frequency: {
        interpolation: "disc",
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
        interpolation: "disc",
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
        interpolation: "disc",
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
