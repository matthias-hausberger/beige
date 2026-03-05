/**
 * Tool client — runs INSIDE the sandbox.
 * Connects to the gateway via Unix domain socket and sends tool requests.
 *
 * Usage: tool-client <tool-name> [args...]
 *
 * This is compiled/bundled and mounted read-only into the sandbox at /beige/tool-client.
 * For simplicity in MVP, we use deno to run this directly as TypeScript.
 */

import { connect } from "net";

const SOCKET_PATH = "/beige/gateway.sock";

const toolName = process.argv[2];
const args = process.argv.slice(3);

if (!toolName) {
  console.error("Usage: tool-client <tool-name> [args...]");
  process.exit(1);
}

const request = JSON.stringify({
  type: "tool_request",
  tool: toolName,
  args,
}) + "\n";

const socket = connect(SOCKET_PATH, () => {
  socket.write(request);
});

let buffer = "";

socket.on("data", (data: Buffer) => {
  buffer += data.toString();

  const newlineIdx = buffer.indexOf("\n");
  if (newlineIdx !== -1) {
    const line = buffer.slice(0, newlineIdx);
    try {
      const response = JSON.parse(line);
      if (response.success) {
        if (response.output) {
          process.stdout.write(response.output);
        }
        process.exit(response.exitCode ?? 0);
      } else {
        if (response.error) {
          process.stderr.write(response.error + "\n");
        }
        process.exit(response.exitCode ?? 1);
      }
    } catch (err) {
      console.error("Failed to parse gateway response:", err);
      process.exit(1);
    }
  }
});

socket.on("error", (err: Error) => {
  console.error("Failed to connect to gateway:", err.message);
  process.exit(1);
});

socket.on("close", () => {
  if (buffer.trim()) {
    // Try to parse any remaining data
    try {
      const response = JSON.parse(buffer.trim());
      if (response.output) process.stdout.write(response.output);
      process.exit(response.exitCode ?? 0);
    } catch {
      // Already handled
    }
  }
});
