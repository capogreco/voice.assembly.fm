// @ts-check

/**
 * State update utilities for Voice.Assembly.FM Control Client
 */

// JSDoc type imports
/** @typedef {import('../../../src/common/parameter-types.js').IControlState} IControlState */
/** @typedef {import('../../../src/common/parameter-types.js').ParameterState} ParameterState */

/**
 * Control action for state updates
 * @typedef {Object} ControlAction
 * @property {"SET_BASE_VALUE" | "SET_INTERPOLATION" | "SET_GENERATOR_CONFIG"} type
 * @property {string} [param] - Parameter name
 * @property {number} [value] - Parameter value
 * @property {"step" | "disc" | "cont"} [interpolation] - Interpolation type
 * @property {"start" | "end"} [position] - Generator position
 * @property {Object} [config] - Generator configuration
 */

/**
 * Update staged state with action
 * @param {IControlState} stagedState - Current staged state
 * @param {ControlAction} action - Action to apply
 * @returns {IControlState} - New staged state
 */
export function updateStagedState(stagedState, action) {
  console.log("Action dispatched:", action);

  // Create a deep copy of current staged state
  const newState = JSON.parse(JSON.stringify(stagedState));

  switch (action.type) {
    case "SET_BASE_VALUE": {
      const param = newState[action.param];
      param.baseValue = action.value;
      break;
    }

    case "SET_INTERPOLATION": {
      const param = newState[action.param];
      if (action.interpolation === "step") {
        // Step interpolation - only needs start generator
        newState[action.param] = {
          interpolation: "step",
          baseValue: param.baseValue,
          startValueGenerator: param.startValueGenerator,
        };
      } else {
        // Disc/cont interpolation - needs start and end generators
        newState[action.param] = {
          interpolation: action.interpolation,
          baseValue: param.baseValue,
          startValueGenerator: param.startValueGenerator,
          endValueGenerator: param.endValueGenerator || {
            ...param.startValueGenerator, // Copy start generator
          },
        };
      }
      break;
    }

    case "SET_GENERATOR_CONFIG": {
      const param = newState[action.param];
      if (action.position === "start") {
        // Merge config properties into existing generator
        param.startValueGenerator = {
          ...param.startValueGenerator,
          ...action.config,
        };
      } else if (
        action.position === "end" && param.interpolation !== "step" &&
        param.endValueGenerator
      ) {
        // Merge config properties into existing generator
        param.endValueGenerator = {
          ...param.endValueGenerator,
          ...action.config,
        };
      }
      break;
    }
  }

  return newState;
}

/**
 * Update live state with action
 * @param {IControlState} liveState - Current live state
 * @param {ControlAction} action - Action to apply
 * @returns {IControlState} - New live state
 */
export function updateLiveState(liveState, action) {
  // Clone the current live state
  const newState = JSON.parse(JSON.stringify(liveState));

  // Apply the same logic as updateStagedState but to the live state
  switch (action.type) {
    case "SET_BASE_VALUE": {
      const param = newState[action.param];
      param.baseValue = action.value;
      break;
    }

    case "SET_INTERPOLATION": {
      const param = newState[action.param];
      if (action.interpolation === "step") {
        // Step interpolation - only needs start generator
        newState[action.param] = {
          interpolation: "step",
          baseValue: param.baseValue,
          startValueGenerator: param.startValueGenerator,
        };
      } else {
        // Disc/cont interpolation - needs start and end generators
        newState[action.param] = {
          interpolation: action.interpolation,
          baseValue: param.baseValue,
          startValueGenerator: param.startValueGenerator,
          endValueGenerator: param.endValueGenerator || {
            ...param.startValueGenerator, // Copy start generator
          },
        };
      }
      break;
    }

    case "SET_GENERATOR_CONFIG": {
      const param = newState[action.param];
      if (action.position === "start") {
        // Merge config properties into existing generator
        param.startValueGenerator = {
          ...param.startValueGenerator,
          ...action.config,
        };
      } else if (
        action.position === "end" && param.interpolation !== "step" &&
        param.endValueGenerator
      ) {
        // Merge config properties into existing generator
        param.endValueGenerator = {
          ...param.endValueGenerator,
          ...action.config,
        };
      }
      break;
    }
  }

  return newState;
}

/**
 * Set parameter state and sync both live and staged copies
 * @param {IControlState} liveState - Current live state
 * @param {IControlState} stagedState - Current staged state
 * @param {string} paramName - Parameter name
 * @param {ParameterState} newState - New parameter state
 * @returns {{liveState: IControlState, stagedState: IControlState}}
 */
export function setParameterState(liveState, stagedState, paramName, newState) {
  const newLive = { ...liveState };
  const newStaged = { ...stagedState };
  
  newLive[paramName] = newState;
  newStaged[paramName] = { ...newState };
  
  return {
    liveState: newLive,
    stagedState: newStaged,
  };
}

/**
 * Mark that there are pending changes
 * @returns {Object} - Status update
 */
export function markPendingChanges() {
  console.log("markPendingChanges called");
  return { hasPendingChanges: true };
}

/**
 * Clear pending changes flag
 * @returns {Object} - Status update
 */
export function clearPendingChanges() {
  return { hasPendingChanges: false };
}

/**
 * Apply staged changes to live state
 * @param {IControlState} stagedState - Current staged state
 * @returns {IControlState} - New live state (deep copy of staged)
 */
export function applyStagedChanges(stagedState) {
  return JSON.parse(JSON.stringify(stagedState));
}
