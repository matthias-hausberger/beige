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

function buildSessionContext(): Record<string, string> | undefined {
  const sessionKey = Deno.env.get("BEIGE_SESSION_KEY");
  const channel = Deno.env.get("BEIGE_CHANNEL");
  const chatId = Deno.env.get("BEIGE_CHAT_ID");
  const threadId = Deno.env.get("BEIGE_THREAD_ID");

  if (!sessionKey || !channel) {
    return undefined;
  }

  const ctx: Record<string, string> = { sessionKey, channel };
  if (chatId) ctx.chatId = chatId;
  if (threadId) ctx.threadId = threadId;
  return ctx;
}

const sessionContext = buildSessionContext();

const request: Record<string, unknown> = {
  type: "tool_request",
  tool: toolName,
  args,
};

if (sessionContext) {
  request.sessionContext = sessionContext;
}

const requestJson = JSON.stringify(request) + "\n";

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
  await conn.write(encoder.encode(requestJson));

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
