import { Bot, type Context } from "grammy";
import type { TelegramChannelConfig } from "../config/schema.js";
import type { AgentManager } from "../gateway/agent-manager.js";
import { BeigeSessionStore } from "../gateway/sessions.js";

/**
 * Telegram channel adapter using GrammY.
 *
 * Session model:
 * - Each chat gets a persistent session (survives gateway restarts).
 * - If a chat has threads (forum topics), each thread gets its own session.
 * - /new starts a fresh session in the current chat/thread.
 * - /start shows a welcome message.
 */
export class TelegramChannel {
  private bot: Bot;
  private config: TelegramChannelConfig;

  constructor(
    telegramConfig: TelegramChannelConfig,
    private agentManager: AgentManager,
    private sessionStore: BeigeSessionStore
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
      await ctx.reply(
        "👋 Hello! I'm your Beige agent. Send me a message and I'll help you out.\n\n" +
        "Commands:\n" +
        "/new — Start a new conversation session\n" +
        "/status — Show current session info"
      );
    });

    // ── /new command — start fresh session ──────────────────
    this.bot.command("new", async (ctx) => {
      const chatId = ctx.chat.id;
      const threadId = ctx.message?.message_thread_id;
      const sessionKey = BeigeSessionStore.telegramKey(chatId, threadId);
      const agentName = this.resolveAgent(ctx.from!.id);

      await this.agentManager.newSession(sessionKey, agentName);
      await ctx.reply("🆕 New session started. Previous conversation is saved.");
    });

    // ── /status command ─────────────────────────────────────
    this.bot.command("status", async (ctx) => {
      const chatId = ctx.chat.id;
      const threadId = ctx.message?.message_thread_id;
      const sessionKey = BeigeSessionStore.telegramKey(chatId, threadId);
      const agentName = this.resolveAgent(ctx.from!.id);

      const sessionFile = this.sessionStore.getSessionFile(sessionKey);
      const status = sessionFile ? "📂 Continuing existing session" : "🆕 No session yet (will create on first message)";

      await ctx.reply(
        `Agent: ${agentName}\n` +
        `Chat: ${chatId}${threadId ? ` / Thread: ${threadId}` : ""}\n` +
        `${status}`
      );
    });

    // ── Text messages ───────────────────────────────────────
    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      const chatId = ctx.chat.id;
      const threadId = ctx.message?.message_thread_id;
      const userId = ctx.from.id;

      const sessionKey = BeigeSessionStore.telegramKey(chatId, threadId);
      const agentName = this.resolveAgent(userId);

      console.log(
        `[TELEGRAM] User ${userId} → agent '${agentName}' ` +
        `(chat:${chatId}${threadId ? `/thread:${threadId}` : ""}): ` +
        `${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`
      );

      try {
        await ctx.replyWithChatAction("typing");

        // Stream the response
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
          }
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
      } catch (err) {
        console.error(`[TELEGRAM] Error:`, err);
        await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /**
   * Resolve which agent to use for a given user.
   */
  private resolveAgent(_userId: number): string {
    return this.config.agentMapping.default;
  }

  async start(): Promise<void> {
    console.log("[TELEGRAM] Starting bot...");
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
