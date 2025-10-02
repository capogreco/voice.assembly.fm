// @ts-check

/**
 * Logging utilities for Voice.Assembly.FM Control Client
 */

/**
 * Log a message with timestamp and level
 * @param {string} message - The message to log
 * @param {"info" | "success" | "error" | "debug"} level - Log level
 * @param {HTMLElement} [debugLogElement] - Optional debug log element
 */
export function log(message, level = "info", debugLogElement = null) {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = {
    "info": "INFO",
    "success": "SUCCESS", 
    "error": "ERROR",
    "debug": "DEBUG",
  }[level] || "INFO";

  const logEntry = "[" + timestamp + "] " + prefix + " " + message + "\n";

  if (debugLogElement) {
    debugLogElement.textContent += logEntry;
    debugLogElement.scrollTop = debugLogElement.scrollHeight;
  }

  // Also log to console
  console.log("[CTRL] " + message);
}

/**
 * Clear the debug log
 * @param {HTMLElement} [debugLogElement] - Optional debug log element
 */
export function clearLog(debugLogElement = null) {
  if (debugLogElement) {
    debugLogElement.textContent = "";
  }
}

/**
 * Update connection status display
 * @param {string} status - Connection status
 * @param {HTMLElement} statusElement - Status element
 * @param {HTMLElement} valueElement - Value element
 */
export function updateConnectionStatus(status, statusElement, valueElement) {
  // Remove all status classes
  statusElement.classList.remove(
    "connected",
    "syncing", 
    "active",
    "inactive",
    "kicked",
    "error",
  );

  switch (status) {
    case "active":
      valueElement.textContent = "Active Controller ✓";
      statusElement.classList.add("active");
      break;
    case "inactive":
      valueElement.textContent = "Inactive";
      statusElement.classList.add("inactive");
      break;
    case "connecting":
      valueElement.textContent = "Connecting...";
      statusElement.classList.add("syncing");
      break;
    case "connected":
      valueElement.textContent = "Connected";
      statusElement.classList.add("connected");
      break;
    case "disconnected":
      valueElement.textContent = "Disconnected";
      statusElement.classList.add("error");
      break;
    case "kicked":
      valueElement.textContent = "Kicked from Network";
      statusElement.classList.add("kicked");
      break;
    default:
      valueElement.textContent = status;
      statusElement.classList.add("inactive");
  }
}