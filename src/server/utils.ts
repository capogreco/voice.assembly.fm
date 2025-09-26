/**
 * Voice.Assembly.FM Server Utilities
 * Shared utility functions for server components
 */

/**
 * Get local IP addresses for network interface display
 */
export function getLocalIPs() {
  const networkInterfaces = Deno.networkInterfaces();
  const ips = [];

  for (const iface of networkInterfaces) {
    if (
      iface.family === "IPv4" && !iface.address.startsWith("127.") &&
      iface.address !== "0.0.0.0"
    ) {
      ips.push(iface.address);
    }
  }

  return ips;
}
