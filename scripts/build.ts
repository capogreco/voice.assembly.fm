/**
 * Build script for Voice.Assembly.FM
 * Copies common modules to public directories
 */

async function ensureDir(path: string) {
  try {
    await Deno.stat(path);
  } catch {
    await Deno.mkdir(path, { recursive: true });
  }
}

async function copyFile(src: string, dest: string) {
  await Deno.copyFile(src, dest);
}

console.log("🔨 Building Voice.Assembly.FM...");

// Ensure directories exist
await ensureDir("public/ctrl/src/common");
await ensureDir("public/synth/src/common");

// Copy common modules
const commonFiles = [
  "webrtc-mesh.js",
  "phasor-sync.js", 
  "message-protocol.js",
  "timing-math.js"
];

for (const file of commonFiles) {
  const srcPath = `src/common/${file}`;
  
  try {
    await copyFile(srcPath, `public/ctrl/src/common/${file}`);
    await copyFile(srcPath, `public/synth/src/common/${file}`);
    console.log(`✅ Copied ${file}`);
  } catch (error) {
    console.error(`❌ Failed to copy ${file}:`, error);
  }
}

console.log("✨ Build complete!");