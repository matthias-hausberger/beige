type ToolHandler = (
  args: string[],
  config?: Record<string, unknown>,
  sessionContext?: SessionContext
) => Promise<{ output: string; exitCode: number }>;

interface SessionContext {
  sessionKey: string;
  channel: string;
  chatId?: string;
  threadId?: string;
}

interface ToolHandlerContext {
  channelRegistry?: ChannelRegistry;
}

interface ChannelRegistry {
  get(channel: string): ChannelAdapter | undefined;
  has(channel: string): boolean;
}

interface ChannelAdapter {
  sendMessage(
    chatId: string,
    threadId: string | undefined,
    text: string,
    options?: { parseMode?: "html" | "markdown" }
  ): Promise<void>;
  supportsMessaging(): boolean;
}

interface ParsedCommand {
  action: "current" | "telegram";
  chatId?: string;
  threadId?: string;
  parseMode?: "html" | "markdown";
  text: string;
}

function parseArgs(args: string[]): ParsedCommand | { error: string } {
  if (args.length === 0) {
    return { error: "No arguments provided. Usage: message --to-current-session -- <text> | message telegram <chatId> [-- <threadId>] -- [--parse-mode <mode>] -- <text>" };
  }

  if (args[0] === "--to-current-session") {
    const doubleDashIndex = args.indexOf("--");
    if (doubleDashIndex === -1 || doubleDashIndex === args.length - 1) {
      return { error: "Missing message text after --. Usage: message --to-current-session -- <text>" };
    }
    const textParts: string[] = [];
    let i = doubleDashIndex + 1;
    while (i < args.length) {
      textParts.push(args[i]);
      i++;
    }
    return {
      action: "current",
      text: textParts.join(" "),
    };
  }

  if (args[0] === "telegram") {
    if (args.length < 3) {
      return { error: "Missing arguments. Usage: message telegram <chatId> [-- <threadId>] -- [--parse-mode <mode>] -- <text>" };
    }

    const chatId = args[1];
    let threadId: string | undefined;
    let parseMode: "html" | "markdown" | undefined;
    let textStartIndex = 2;

    // Look for threadId (must be before the final --)
    const lastDoubleDash = args.lastIndexOf("--");
    if (lastDoubleDash === -1 || lastDoubleDash === args.length - 1) {
      return { error: "Missing message text after --. Usage: message telegram <chatId> [-- <threadId>] -- [--parse-mode <mode>] -- <text>" };
    }

    // Check for --parse-mode before the final --
    for (let i = 2; i < lastDoubleDash; i++) {
      if (args[i] === "--parse-mode" && i + 1 < lastDoubleDash) {
        const mode = args[i + 1];
        if (mode === "html" || mode === "markdown") {
          parseMode = mode;
        } else {
          return { error: `Invalid parse mode: ${mode}. Must be 'html' or 'markdown'.` };
        }
      } else if (!isNaN(Number(args[i])) && !threadId && args[i - 1] !== "--parse-mode") {
        // If it's a number and we haven't set threadId yet, it might be threadId
        threadId = args[i];
      }
    }

    const text = args.slice(lastDoubleDash + 1).join(" ");
    if (!text) {
      return { error: "Missing message text after --" };
    }

    return {
      action: "telegram",
      chatId,
      threadId,
      parseMode,
      text,
    };
  }

  return { error: `Unknown action: ${args[0]}. Use '--to-current-session' or 'telegram'.` };
}

export function createHandler(config: Record<string, unknown>, context: ToolHandlerContext): ToolHandler {
  const channelRegistry = context.channelRegistry;

  return async (args: string[], _config?: Record<string, unknown>, sessionContext?: SessionContext) => {
    const parsed = parseArgs(args);
    if ("error" in parsed) {
      return { output: `Error: ${parsed.error}`, exitCode: 1 };
    }

    if (parsed.action === "current") {
      if (!sessionContext) {
        return {
          output: "Error: No session context available. This command must be run from within an active LLM session, not from a standalone script.\n\nUse explicit targeting instead: message telegram <chatId> -- <text>",
          exitCode: 1,
        };
      }

      const adapter = channelRegistry?.get(sessionContext.channel);
      if (!adapter) {
        return {
          output: `Error: Channel '${sessionContext.channel}' is not available or not registered.`,
          exitCode: 1,
        };
      }

      if (!adapter.supportsMessaging()) {
        return {
          output: `Error: The current session's channel ('${sessionContext.channel}') doesn't support messaging.`,
          exitCode: 1,
        };
      }

      if (!sessionContext.chatId) {
        return {
          output: `Error: The current session does not have a chat ID. Cannot send message.`,
          exitCode: 1,
        };
      }

      try {
        await adapter.sendMessage(sessionContext.chatId, sessionContext.threadId, parsed.text);
        return { output: "Message sent successfully.", exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Error sending message: ${msg}`, exitCode: 1 };
      }
    }

    if (parsed.action === "telegram") {
      if (!parsed.chatId) {
        return { output: "Error: Missing chat ID for Telegram message.", exitCode: 1 };
      }

      const adapter = channelRegistry?.get("telegram");
      if (!adapter) {
        return {
          output: "Error: Telegram channel is not available. Make sure Telegram is enabled in the gateway config.",
          exitCode: 1,
        };
      }

      try {
        await adapter.sendMessage(parsed.chatId, parsed.threadId, parsed.text, { parseMode: parsed.parseMode });
        return { output: "Message sent successfully to Telegram.", exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Error sending message to Telegram: ${msg}`, exitCode: 1 };
      }
    }

    return { output: "Error: Unknown action.", exitCode: 1 };
  };
}
