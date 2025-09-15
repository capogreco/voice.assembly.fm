/**
 * Voice.Assembly.FM Development Server Launcher
 * Starts all three servers in parallel
 */

import { config } from "./config.ts";
import { getLocalIPs } from "./utils.ts";

const localIPs = getLocalIPs();

console.log("🎵 Voice.Assembly.FM Development Servers");
console.log("=====================================");

// Start all three servers
const servers = [
  {
    name: "Signaling Server",
    cmd: ["deno", "run", "--allow-net", "--allow-read", "--allow-sys", "src/server/signaling-server.ts"],
    port: config.signalingPort
  },
  {
    name: "Ctrl Client Server", 
    cmd: ["deno", "run", "--allow-net", "--allow-read", "--allow-sys", "src/server/static-server.ts", "--port", config.ctrlClientPort.toString(), "--root", "public/ctrl"],
    port: config.ctrlClientPort
  },
  {
    name: "Synth Client Server",
    cmd: ["deno", "run", "--allow-net", "--allow-read", "--allow-sys", "src/server/static-server.ts", "--port", config.synthClientPort.toString(), "--root", "public/synth"], 
    port: config.synthClientPort
  }
];

const processes: Deno.ChildProcess[] = [];

// Start servers
for (const server of servers) {
  console.log(`\n🚀 Starting ${server.name}...`);
  
  const process = new Deno.Command(server.cmd[0], {
    args: server.cmd.slice(1),
    stdout: "piped",
    stderr: "piped"
  }).spawn();
  
  processes.push(process);
  
  // Stream output with server name prefix
  (async () => {
    const decoder = new TextDecoder();
    const reader = process.stdout.getReader();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value);
      const lines = text.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        console.log(`[${server.name}] ${line}`);
      }
    }
  })();
  
  (async () => {
    const decoder = new TextDecoder();
    const reader = process.stderr.getReader();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value);
      const lines = text.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        console.log(`[${server.name}] ERROR: ${line}`);
      }
    }
  })();
}

// Wait a moment for servers to start, then show access URLs
setTimeout(() => {
  console.log("\n🌐 Access URLs:");
  console.log("==============");
  
  console.log("\n📱 Local Access:");
  console.log(`   Ctrl Client:  http://localhost:8080`);
  console.log(`   Synth Client: http://localhost:8081`);
  console.log(`   Health Check: http://localhost:8000/health`);
  
  if (localIPs.length > 0) {
    console.log("\n📱 Network Access:");
    localIPs.forEach(ip => {
      console.log(`   Ctrl Client:  http://${ip}:8080`);
      console.log(`   Synth Client: http://${ip}:8081`);
      console.log(`   Health Check: http://${ip}:8000/health`);
      console.log("");
    });
  }
  
  console.log("🎤 Quick Start:");
  console.log("1. Open Ctrl Client → Connect to Network → Start Timing");
  console.log("2. Open Synth Client(s) → Tap to Join the Choir");
  console.log("3. Test calibration mode from Ctrl Client");
  console.log("\nPress Ctrl+C to stop all servers");
  
}, 2000);

// Handle shutdown
function shutdown() {
  console.log("\n🛑 Shutting down all servers...");
  
  for (const process of processes) {
    try {
      process.kill("SIGTERM");
    } catch (error) {
      console.log(`Error killing process: ${error}`);
    }
  }
  
  Deno.exit(0);
}

// Listen for shutdown signals
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Wait for all processes to complete (they won't unless killed)
try {
  await Promise.all(processes.map(p => p.status));
} catch (error) {
  console.log("Process error:", error);
}