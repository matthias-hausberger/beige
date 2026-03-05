/**
 * Tool client — runs INSIDE the sandbox (Deno).
 * Connects to the gateway via Unix domain socket and sends tool requests.
 *
 * Usage: tool-client <tool-name> [args...]
 *
 * Mounted read-only into the sandbox at /beige/tool-client.ts.
 * Run via the wrapper: /beige/tool-client (which invokes deno run ...)
 */

const SOCKET_PATH = "/beige/gateway.sock";

const toolName = Deno.args[0];
const args = Deno.args.slice(1);

if (!toolName) {
  console.error("Usage: tool-client <tool-name> [args...]");
  Deno.exit(1);
}

const request =
  JSON.stringify({
    type: "tool_request",
    tool: toolName,
    args,
  }) + "\n";

let conn: Deno.UnixConn;
try {
  conn = await Deno.connect({ transport: "unix", path: SOCKET_PATH });
} catch (err) {
  console.error(
    `Failed to connect to gateway socket at ${SOCKET_PATH}:`,
    err instanceof Error ? err.message : err
  );
  Deno.exit(1);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

try {
  // Send request
  await conn.write(encoder.encode(request));

  // Read response (newline-delimited JSON)
  let responseText = "";
  const buf = new Uint8Array(65536);
  while (!responseText.includes("\n")) {
    const n = await conn.read(buf);
    if (n === null) break;
    responseText += decoder.decode(buf.subarray(0, n));
  }

  conn.close();

  const parsed = JSON.parse(responseText.trim());
  if (parsed.success) {
    if (parsed.output) {
      await Deno.stdout.write(encoder.encode(parsed.output));
    }
    Deno.exit(parsed.exitCode ?? 0);
  } else {
    if (parsed.error) {
      await Deno.stderr.write(encoder.encode(parsed.error + "\n"));
    }
    Deno.exit(parsed.exitCode ?? 1);
  }
} catch (err) {
  console.error("Failed to communicate with gateway:", err instanceof Error ? err.message : err);
  Deno.exit(1);
}
