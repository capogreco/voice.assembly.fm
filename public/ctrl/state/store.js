// @ts-check

/**
 * Scene storage management for Voice.Assembly.FM Control Client
 * Handles localStorage operations and UI indicators
 */

/**
 * Save scene to localStorage
 * @param {number} memoryLocation - Memory location (0-9)
 * @param {Object} program - Program configuration to save
 * @param {function} logFn - Logging function
 */
export function saveSceneToLocalStorage(memoryLocation, program, logFn) {
  const controllerKey = `scene_${memoryLocation}_controller`;

  try {
    localStorage.setItem(controllerKey, JSON.stringify(program));
    logFn(`💾 Saved scene ${memoryLocation} to local storage`, "success");
  } catch (error) {
    logFn(
      `❌ Failed to save scene ${memoryLocation}: ${error.message}`,
      "error",
    );
    throw error;
  }
}

/**
 * Load scene from localStorage
 * @param {number} memoryLocation - Memory location (0-9)
 * @param {function} logFn - Logging function
 * @returns {Object|null} - Loaded program or null if not found
 */
export function loadSceneFromLocalStorage(memoryLocation, logFn) {
  const controllerKey = `scene_${memoryLocation}_controller`;

  try {
    const storedProgram = localStorage.getItem(controllerKey);
    if (!storedProgram) {
      logFn(`No scene found in bank ${memoryLocation}`, "warning");
      return null;
    }

    const program = JSON.parse(storedProgram);
    logFn(`📂 Loaded scene ${memoryLocation} from local storage`, "success");
    return program;
  } catch (error) {
    logFn(
      `❌ Failed to load scene ${memoryLocation}: ${error.message}`,
      "error",
    );
    return null;
  }
}

/**
 * Update scene memory indicators on buttons
 * @param {NodeListOf<Element>} buttons - Scene buttons
 * @param {function} hasSceneChecker - Function to check if scene exists
 */
export function markSceneIndicators(buttons, hasSceneChecker) {
  buttons.forEach((button) => {
    const location = parseInt(button.getAttribute("data-location"));
    const hasScene = hasSceneChecker(location);

    if (hasScene) {
      button.classList.add("has-scene");
    } else {
      button.classList.remove("has-scene");
    }
  });
}

/**
 * Clear a single scene bank
 * @param {number} memoryLocation - Memory location (0-9)
 * @param {function} logFn - Logging function
 */
export function clearSceneBank(memoryLocation, logFn) {
  const controllerKey = `scene_${memoryLocation}_controller`;

  try {
    localStorage.removeItem(controllerKey);
    logFn(`🧹 Cleared scene bank ${memoryLocation}`, "success");
  } catch (error) {
    logFn(
      `❌ Failed to clear scene ${memoryLocation}: ${error.message}`,
      "error",
    );
  }
}

/**
 * Clear all scene banks
 * @param {function} logFn - Logging function
 */
export function clearAllSceneBanks(logFn) {
  let clearedCount = 0;

  for (let i = 0; i < 10; i++) {
    const controllerKey = `scene_${i}_controller`;
    if (localStorage.getItem(controllerKey)) {
      localStorage.removeItem(controllerKey);
      clearedCount++;
    }
  }

  logFn(
    `🧹 Cleared ${clearedCount} scene bank(s) from local storage`,
    "success",
  );
}
