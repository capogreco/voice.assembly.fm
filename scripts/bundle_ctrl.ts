/**
 * Bundle script for ctrl-main.ts
 * Compiles TypeScript to JavaScript for static serving
 */

async function bundleCtrl() {
  const inputFile = "./public/ctrl/ctrl-main.ts";
  const outputFile = "./public/ctrl/ctrl-main.js";

  try {
    console.log("🔨 Bundling ctrl-main.ts...");

    const command = new Deno.Command(Deno.execPath(), {
      args: ["bundle", inputFile],
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout, stderr } = await command.output();

    if (code !== 0) {
      const error = new TextDecoder().decode(stderr);
      console.error("❌ Bundle failed:", error);
      Deno.exit(1);
    }

    const bundled = new TextDecoder().decode(stdout);
    await Deno.writeTextFile(outputFile, bundled);

    console.log("✅ Successfully bundled ctrl-main.js");
  } catch (error) {
    console.error("❌ Bundle error:", error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await bundleCtrl();
}
