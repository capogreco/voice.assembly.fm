// @ts-check

/**
 * State update utilities for Voice.Assembly.FM Control Client
 */

// JSDoc type imports
/** @typedef {import('../../../src/common/parameter-types.js').IMusicalState} IMusicalState */
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
 * Update pending state with action
 * @param {IMusicalState} pendingState - Current pending state
 * @param {ControlAction} action - Action to apply
 * @returns {IMusicalState} - New pending state
 */
export function updatePendingState(pendingState, action) {
  console.log("Action dispatched:", action);

  // Create a deep copy of current pending state
  const newState = JSON.parse(JSON.stringify(pendingState));

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
 * Update active state with action
 * @param {IMusicalState} activeState - Current active state
 * @param {ControlAction} action - Action to apply
 * @returns {IMusicalState} - New active state
 */
export function updateActiveState(activeState, action) {
  // Clone the current active state
  const newState = JSON.parse(JSON.stringify(activeState));

  // Apply the same logic as updatePendingState but to active state
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
 * Set parameter state and sync both active and pending
 * @param {IMusicalState} activeState - Current active state
 * @param {IMusicalState} pendingState - Current pending state
 * @param {string} paramName - Parameter name
 * @param {ParameterState} newState - New parameter state
 * @returns {{activeState: IMusicalState, pendingState: IMusicalState}}
 */
export function setParameterState(activeState, pendingState, paramName, newState) {
  const newActive = { ...activeState };
  const newPending = { ...pendingState };
  
  newActive[paramName] = newState;
  newPending[paramName] = { ...newState };
  
  return {
    activeState: newActive,
    pendingState: newPending,
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
 * Apply pending changes to active state
 * @param {IMusicalState} pendingState - Current pending state
 * @returns {IMusicalState} - New active state (deep copy of pending)
 */
export function applyPendingChanges(pendingState) {
  return JSON.parse(JSON.stringify(pendingState));
}