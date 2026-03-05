import { resolve } from "path";
import { loadConfig } from "./config/loader.js";
import { Gateway } from "./gateway/gateway.js";

const configPath = process.argv[2] || "config.json5";

console.log(`[BEIGE] Loading config from: ${resolve(configPath)}`);

let gateway: Gateway;

try {
  const config = loadConfig(configPath);
  gateway = new Gateway(config);
  await gateway.start();
} catch (err) {
  console.error("[BEIGE] Failed to start:", err);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async () => {
  console.log("\n[BEIGE] Received shutdown signal...");
  await gateway.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
