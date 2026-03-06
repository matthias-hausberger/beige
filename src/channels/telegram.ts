import { Bot, type Context } from "grammy";
import type { TelegramChannelConfig } from "../config/schema.js";
import type { AgentManager } from "../gateway/agent-manager.js";
import { BeigeSessionStore } from "../gateway/sessions.js";
import type { SessionSettingsStore } from "../gateway/session-settings.js";
import { resolveSessionSetting } from "../gateway/session-settings.js";

/**
 * Telegram channel adapter using GrammY.
 *
 * Session model:
 * - Each chat gets a persistent session (survives gateway restarts).
 * - If a chat has threads (forum topics), each thread gets its own session.
 * - /new starts a fresh session in the current chat/thread.
 * - /start shows a welcome message.
 *
 * Channel commands (handled locally, NOT forwarded to the LLM):
 * - /start         — welcome message + command overview
 * - /new           — start a new conversation session
 * - /status        — show session info + current settings
 * - /v on|off      — toggle verbose mode for this session (shorthand)
 * - /verbose on|off — toggle verbose mode for this session
 * - /s on|off      — toggle streaming mode for this session (shorthand)
 * - /streaming on|off — toggle streaming mode for this session
 *
 * Verbose mode:
 * - When ON, the bot sends a small notification whenever the agent calls a tool.
 * - Default is OFF (configurable via channels.telegram.defaults.verbose in config.json5).
 * - Persisted per-session in ~/.beige/sessions/session-settings.json.
 *
 * Streaming mode:
 * - When ON (default), responses are streamed in real-time (message edits as LLM generates).
 * - When OFF, the full response is sent once the LLM finishes.
 * - Default is ON (configurable via channels.telegram.defaults.streaming in config.json5).
 * - Persisted per-session in ~/.beige/sessions/session-settings.json.
 *
 * Bot command registration:
 * - On startup, the bot deletes all old commands and registers the current set.
 */
export class TelegramChannel {
  private bot: Bot;
  private config: TelegramChannelConfig;

  constructor(
    telegramConfig: TelegramChannelConfig,
    private agentManager: AgentManager,
    private sessionStore: BeigeSessionStore,
    private settingsStore: SessionSettingsStore
  ) {
    this.config = telegramConfig;
    this.bot = new Bot(telegramConfig.token);

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // ── Auth middleware ──────────────────────────────────────
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.config.allowedUsers.includes(userId)) {
        console.log(`[TELEGRAM] Unauthorized user: ${userId}`);
        await ctx.reply("⛔ Unauthorized.");
        return;
      }
      await next();
    });

    // ── /start command ──────────────────────────────────────
    this.bot.command("start", async (ctx) => {
      const sessionKey = this.sessionKeyFromCtx(ctx);
      const verbose = this.resolveVerbose(sessionKey);
      const streaming = this.resolveStreaming(sessionKey);
      await ctx.reply(
        "👋 Hello! I'm your Beige agent. Send me a message and I'll help you out.\n\n" +
        "Commands:\n" +
        "/new — Start a new conversation session\n" +
        "/status — Show current session info and settings\n" +
        "/verbose on|off — Toggle tool-call notifications\n" +
        "/v on|off — Same as /verbose (shorthand)\n" +
        "/streaming on|off — Toggle real-time response streaming\n" +
        "/s on|off — Same as /streaming (shorthand)\n\n" +
        `Current settings:\n` +
        `• Verbose: ${verbose ? "🔊 on" : "🔇 off"}\n` +
        `• Streaming: ${streaming ? "⚡ on" : "📦 off"}`
      );
    });

    // ── /new command — start fresh session ──────────────────
    this.bot.command("new", async (ctx) => {
      const chatId = ctx.chat.id;
      const threadId = ctx.message?.message_thread_id;
      const sessionKey = BeigeSessionStore.telegramKey(chatId, threadId);
      const agentName = this.resolveAgent(ctx.from!.id);

      // Clear session-level overrides on /new so the user starts fresh
      this.settingsStore.clearAll(sessionKey);

      await this.agentManager.newSession(sessionKey, agentName, {
        onToolStart: this.makeToolStartHandler(sessionKey, ctx),
      });
      await ctx.reply("🆕 New session started. Previous conversation is saved.");
    });

    // ── /status command ─────────────────────────────────────
    this.bot.command("status", async (ctx) => {
      const chatId = ctx.chat.id;
      const threadId = ctx.message?.message_thread_id;
      const sessionKey = BeigeSessionStore.telegramKey(chatId, threadId);
      const agentName = this.resolveAgent(ctx.from!.id);

      const sessionFile = this.sessionStore.getSessionFile(sessionKey);
      const sessionStatus = sessionFile ? "📂 Continuing existing session" : "🆕 No session yet";
      const verbose = this.resolveVerbose(sessionKey);
      const streaming = this.resolveStreaming(sessionKey);
      const overrides = this.settingsStore.getAll(sessionKey);
      const verboseOverride = overrides.verbose !== undefined;
      const streamingOverride = overrides.streaming !== undefined;

      await ctx.reply(
        `*Session Status*\n\n` +
        `Agent: \`${agentName}\`\n` +
        `Chat: \`${chatId}${threadId ? ` / Thread: ${threadId}` : ""}\`\n` +
        `${sessionStatus}\n\n` +
        `*Settings*\n` +
        `• Verbose: ${verbose ? "🔊 on" : "🔇 off"}` +
        (verboseOverride ? " _(session override)_" : " _(channel default)_") + "\n" +
        `• Streaming: ${streaming ? "⚡ on" : "📦 off"}` +
        (streamingOverride ? " _(session override)_" : " _(channel default)_"),
        { parse_mode: "Markdown" }
      );
    });

    // ── /verbose command ─────────────────────────────────────
    this.bot.command("verbose", async (ctx) => {
      await this.handleVerboseCommand(ctx);
    });

    // ── /v command (shorthand for /verbose) ──────────────────
    this.bot.command("v", async (ctx) => {
      await this.handleVerboseCommand(ctx);
    });

    // ── /streaming command ───────────────────────────────────
    this.bot.command("streaming", async (ctx) => {
      await this.handleStreamingCommand(ctx);
    });

    // ── /s command (shorthand for /streaming) ────────────────
    this.bot.command("s", async (ctx) => {
      await this.handleStreamingCommand(ctx);
    });

    // ── Text messages ───────────────────────────────────────
    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      const chatId = ctx.chat.id;
      const threadId = ctx.message?.message_thread_id;
      const userId = ctx.from.id;

      const sessionKey = BeigeSessionStore.telegramKey(chatId, threadId);
      const agentName = this.resolveAgent(userId);
      const streaming = this.resolveStreaming(sessionKey);

      console.log(
        `[TELEGRAM] User ${userId} → agent '${agentName}' ` +
        `(chat:${chatId}${threadId ? `/thread:${threadId}` : ""}): ` +
        `${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`
      );

      try {
        await ctx.replyWithChatAction("typing");

        // Build onToolStart based on the current verbose setting
        const onToolStart = this.resolveVerbose(sessionKey)
          ? this.makeToolStartHandler(sessionKey, ctx)
          : undefined;

        if (streaming) {
          // Streaming mode: update message in real-time
          let currentMessage = "";
          let sentMessage: any = null;
          let lastUpdateTime = 0;
          const UPDATE_INTERVAL_MS = 1000;

          const response = await this.agentManager.promptStreaming(
            sessionKey,
            agentName,
            text,
            async (delta) => {
              currentMessage += delta;

              const now = Date.now();
              if (now - lastUpdateTime < UPDATE_INTERVAL_MS) return;
              lastUpdateTime = now;

              try {
                if (!sentMessage) {
                  sentMessage = await ctx.reply(truncateForTelegram(currentMessage), {
                    parse_mode: undefined,
                    ...(threadId ? { message_thread_id: threadId } : {}),
                  });
                } else {
                  await ctx.api.editMessageText(
                    ctx.chat.id,
                    sentMessage.message_id,
                    truncateForTelegram(currentMessage)
                  );
                }
              } catch {
                // Ignore edit errors
              }
            },
            { onToolStart }
          );

          // Send final message
          if (sentMessage) {
            try {
              await ctx.api.editMessageText(
                ctx.chat.id,
                sentMessage.message_id,
                truncateForTelegram(response)
              );
            } catch {
              await sendLongMessage(ctx, response, threadId);
            }
          } else {
            await sendLongMessage(ctx, response, threadId);
          }
        } else {
          // Non-streaming mode: send full response when complete
          const response = await this.agentManager.prompt(
            sessionKey,
            agentName,
            text,
            { onToolStart }
          );
          await sendLongMessage(ctx, response, threadId);
        }
      } catch (err) {
        console.error(`[TELEGRAM] Error:`, err);
        await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  // ── Verbose mode helpers ────────────────────────────────────────────

  /**
   * Handle /verbose and /v commands.
   * Parses "on"/"off" argument and persists the setting for this session.
   */
  private async handleVerboseCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const threadId = ctx.message?.message_thread_id;
    const sessionKey = BeigeSessionStore.telegramKey(chatId, threadId);

    // Extract argument: "/verbose on" or "/v off"
    const text = ctx.message?.text ?? "";
    const parts = text.trim().split(/\s+/);
    const arg = parts[1]?.toLowerCase();

    if (!arg || (arg !== "on" && arg !== "off")) {
      const current = this.resolveVerbose(sessionKey);
      await ctx.reply(
        `Usage: /verbose on|off\n\n` +
        `Current: ${current ? "🔊 on" : "🔇 off"}`
      );
      return;
    }

    const enable = arg === "on";
    this.settingsStore.set(sessionKey, "verbose", enable);

    // Update the live session's handler ref — no session restart needed.
    if (enable) {
      this.agentManager.updateToolStartHandler(
        sessionKey,
        this.makeToolStartHandlerForKey(sessionKey, ctx)
      );
    } else {
      this.agentManager.updateToolStartHandler(sessionKey, undefined);
    }

    await ctx.reply(
      enable
        ? "🔊 Verbose mode *on* — you'll see tool calls as they happen."
        : "🔇 Verbose mode *off* — tool calls are hidden.",
      { parse_mode: "Markdown" }
    );

    console.log(`[TELEGRAM] Verbose mode ${enable ? "ON" : "OFF"} for session ${sessionKey}`);
  }

  /**
   * Resolve the effective verbose setting for a session (layered: default → config → override).
   */
  private resolveVerbose(sessionKey: string): boolean {
    const sessionOverride = this.settingsStore.get(sessionKey, "verbose");
    const channelDefault = this.config.defaults?.verbose;
    return resolveSessionSetting("verbose", false, channelDefault, sessionOverride);
  }

  // ── Streaming mode helpers ────────────────────────────────────────────

  /**
   * Handle /streaming and /s commands.
   * Parses "on"/"off" argument and persists the setting for this session.
   */
  private async handleStreamingCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const threadId = ctx.message?.message_thread_id;
    const sessionKey = BeigeSessionStore.telegramKey(chatId, threadId);

    // Extract argument: "/streaming on" or "/s off"
    const text = ctx.message?.text ?? "";
    const parts = text.trim().split(/\s+/);
    const arg = parts[1]?.toLowerCase();

    if (!arg || (arg !== "on" && arg !== "off")) {
      const current = this.resolveStreaming(sessionKey);
      await ctx.reply(
        `Usage: /streaming on|off\n\n` +
        `Current: ${current ? "⚡ on" : "📦 off"}`
      );
      return;
    }

    const enable = arg === "on";
    this.settingsStore.set(sessionKey, "streaming", enable);

    await ctx.reply(
      enable
        ? "⚡ Streaming mode *on* — responses will appear in real-time as the AI generates them."
        : "📦 Streaming mode *off* — full response will be sent once complete.",
      { parse_mode: "Markdown" }
    );

    console.log(`[TELEGRAM] Streaming mode ${enable ? "ON" : "OFF"} for session ${sessionKey}`);
  }

  /**
   * Resolve the effective streaming setting for a session (layered: default → config → override).
   */
  private resolveStreaming(sessionKey: string): boolean {
    const sessionOverride = this.settingsStore.get(sessionKey, "streaming");
    const channelDefault = this.config.defaults?.streaming;
    return resolveSessionSetting("streaming", true, channelDefault, sessionOverride);
  }

  /**
   * Create an OnToolStart callback that sends a Telegram notification.
   * Uses a GrammY context for thread-aware replies.
   */
  private makeToolStartHandler(
    sessionKey: string,
    ctx: Context
  ): (toolName: string, params: Record<string, unknown>) => void {
    const chatId = ctx.chat!.id;
    const threadId = (ctx.message as any)?.message_thread_id as number | undefined;
    return this.buildToolStartHandler(sessionKey, chatId, threadId);
  }

  /**
   * Create an OnToolStart callback using raw chat/thread IDs.
   * Used when toggling verbose on mid-session (no fresh ctx available).
   */
  private makeToolStartHandlerForKey(
    sessionKey: string,
    ctx: Context
  ): (toolName: string, params: Record<string, unknown>) => void {
    const chatId = ctx.chat!.id;
    const threadId = (ctx.message as any)?.message_thread_id as number | undefined;
    return this.buildToolStartHandler(sessionKey, chatId, threadId);
  }

  private buildToolStartHandler(
    sessionKey: string,
    chatId: number,
    threadId: number | undefined
  ): (toolName: string, params: Record<string, unknown>) => void {
    return (toolName: string, params: Record<string, unknown>) => {
      const label = formatToolCall(toolName, params);
      console.log(`[TELEGRAM] [verbose] ${sessionKey} tool: ${label}`);

      // Fire-and-forget — we don't await inside a sync callback
      this.bot.api
        .sendMessage(chatId, `🔧 ${label}`, {
          ...(threadId ? { message_thread_id: threadId } : {}),
        })
        .catch((err) => {
          console.warn(`[TELEGRAM] Failed to send verbose notification: ${err}`);
        });
    };
  }

  /**
   * Resolve which agent to use for a given user.
   */
  private resolveAgent(_userId: number): string {
    return this.config.agentMapping.default;
  }

  private sessionKeyFromCtx(ctx: Context): string {
    const chatId = ctx.chat!.id;
    const threadId = (ctx.message as any)?.message_thread_id as number | undefined;
    return BeigeSessionStore.telegramKey(chatId, threadId);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    console.log("[TELEGRAM] Starting bot...");

    // Register bot commands (delete stale ones first, then set current set)
    await this.registerBotCommands();

    await this.bot.start({
      onStart: (botInfo) => {
        console.log(`[TELEGRAM] Bot started as @${botInfo.username}`);
      },
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    console.log("[TELEGRAM] Bot stopped");
  }

  /**
   * Register the bot's command list with Telegram.
   * First deletes all existing commands, then sets the current ones.
   * This ensures stale commands from old bot versions are removed.
   */
  private async registerBotCommands(): Promise<void> {
    try {
      // Delete all existing commands
      await this.bot.api.deleteMyCommands();
      console.log("[TELEGRAM] Cleared existing bot commands");

      // Register current commands
      await this.bot.api.setMyCommands([
        { command: "start", description: "Show welcome message and available commands" },
        { command: "new", description: "Start a new conversation session" },
        { command: "status", description: "Show current session info and settings" },
        {
          command: "verbose",
          description: "Toggle tool-call notifications: /verbose on|off",
        },
        {
          command: "v",
          description: "Shorthand for /verbose: /v on|off",
        },
        {
          command: "streaming",
          description: "Toggle real-time response streaming: /streaming on|off",
        },
        {
          command: "s",
          description: "Shorthand for /streaming: /s on|off",
        },
      ]);

      console.log("[TELEGRAM] Registered bot commands");
    } catch (err) {
      // Non-fatal — bot still works without registered commands
      console.warn(`[TELEGRAM] Failed to register commands: ${err}`);
    }
  }
}

// ── Formatting ────────────────────────────────────────────────────────────

/**
 * Format a tool call into a human-readable one-liner for verbose notifications.
 */
function formatToolCall(toolName: string, params: Record<string, unknown>): string {
  switch (toolName) {
    case "exec": {
      const cmd = String(params.command ?? "");
      return `exec: ${cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd}`;
    }
    case "read": {
      const path = String(params.path ?? "");
      return `read: ${path}`;
    }
    case "write": {
      const path = String(params.path ?? "");
      const bytes = params.bytes != null ? ` (${params.bytes} bytes)` : "";
      return `write: ${path}${bytes}`;
    }
    case "patch": {
      const path = String(params.path ?? "");
      return `patch: ${path}`;
    }
    default:
      return `${toolName}: ${JSON.stringify(params).slice(0, 80)}`;
  }
}

function truncateForTelegram(text: string): string {
  if (text.length <= 4096) return text;
  return text.slice(0, 4090) + "\n[…]";
}

async function sendLongMessage(ctx: Context, text: string, threadId?: number): Promise<void> {
  const MAX_LENGTH = 4096;
  if (text.length <= MAX_LENGTH) {
    await ctx.reply(text || "(empty response)", {
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
    return;
  }

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > MAX_LENGTH) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await ctx.reply(chunk, {
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  }
}
