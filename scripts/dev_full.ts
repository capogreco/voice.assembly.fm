/**
 * Development script that runs both server and TypeScript bundler concurrently
 * Provides a complete development environment with auto-compilation
 */

class DevRunner {
  private serverProcess?: Deno.ChildProcess;
  private bundlerProcess?: Deno.ChildProcess;
  private isShuttingDown = false;

  async start() {
    console.log("🚀 Starting full development environment...");

    // Set up graceful shutdown handlers
    this.setupShutdownHandlers();

    // Start server with watch
    this.startServer();

    // Start TypeScript bundler with watch
    this.startBundler();

    // Keep the process running
    await this.waitForShutdown();
  }

  private startServer() {
    console.log("📡 Starting server with file watching...");

    this.serverProcess = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net",
        "--allow-read",
        "--allow-sys",
        "--allow-env",
        "--allow-run",
        "--unstable-kv",
        "--watch",
        "src/server/server.ts",
      ],
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
  }

  private startBundler() {
    console.log("🔨 Starting TypeScript bundler with file watching...");

    this.bundlerProcess = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--watch=public/ctrl/ctrl-main.ts",
        "scripts/bundle_ctrl.ts",
      ],
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
  }

  private setupShutdownHandlers() {
    const shutdown = () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.log("\n🛑 Shutting down development environment...");

      if (this.serverProcess) {
        console.log("  Stopping server...");
        this.serverProcess.kill("SIGTERM");
      }

      if (this.bundlerProcess) {
        console.log("  Stopping bundler...");
        this.bundlerProcess.kill("SIGTERM");
      }

      console.log("✅ Development environment stopped");
      Deno.exit(0);
    };

    // Handle Ctrl+C and other termination signals
    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    // Handle process exit
    globalThis.addEventListener("beforeunload", shutdown);
  }

  private async waitForShutdown() {
    // Keep the main process alive until shutdown
    while (!this.isShuttingDown) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

if (import.meta.main) {
  const runner = new DevRunner();
  await runner.start();
}
