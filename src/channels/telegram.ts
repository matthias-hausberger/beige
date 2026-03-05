import { Bot, type Context } from "grammy";
import type { BeigeConfig, TelegramChannelConfig } from "../config/schema.js";
import type { AgentManager } from "../gateway/agent-manager.js";

/**
 * Telegram channel adapter using GrammY.
 * Maps Telegram users to agents and streams responses.
 */
export class TelegramChannel {
  private bot: Bot;
  private config: TelegramChannelConfig;

  constructor(
    telegramConfig: TelegramChannelConfig,
    private agentManager: AgentManager
  ) {
    this.config = telegramConfig;
    this.bot = new Bot(telegramConfig.token);

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Check user authorization
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.config.allowedUsers.includes(userId)) {
        console.log(`[TELEGRAM] Unauthorized user: ${userId}`);
        await ctx.reply("⛔ Unauthorized.");
        return;
      }
      await next();
    });

    // Handle text messages
    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text;
      const userId = ctx.from.id;
      const agentName = this.resolveAgent(userId);

      console.log(`[TELEGRAM] User ${userId} → agent '${agentName}': ${text.slice(0, 100)}...`);

      try {
        // Send typing indicator
        await ctx.replyWithChatAction("typing");

        // Stream the response
        let currentMessage = "";
        let sentMessage: any = null;
        let lastUpdateTime = 0;
        const UPDATE_INTERVAL_MS = 1000; // Telegram rate limit friendly

        const response = await this.agentManager.promptStreaming(
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
                });
              } else {
                await ctx.api.editMessageText(
                  ctx.chat.id,
                  sentMessage.message_id,
                  truncateForTelegram(currentMessage)
                );
              }
            } catch {
              // Ignore edit errors (message unchanged, rate limit, etc.)
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
            // If edit fails, send as new message
            await sendLongMessage(ctx, response);
          }
        } else {
          await sendLongMessage(ctx, response);
        }
      } catch (err) {
        console.error(`[TELEGRAM] Error:`, err);
        await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Handle /start command
    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        "👋 Hello! I'm your Beige agent. Send me a message and I'll help you out."
      );
    });
  }

  /**
   * Resolve which agent to use for a given user.
   */
  private resolveAgent(_userId: number): string {
    // For now, always use the default agent
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

/**
 * Telegram messages have a 4096 character limit.
 */
function truncateForTelegram(text: string): string {
  if (text.length <= 4096) return text;
  return text.slice(0, 4090) + "\n[…]";
}

/**
 * Send a long message by splitting into multiple messages.
 */
async function sendLongMessage(ctx: Context, text: string): Promise<void> {
  const MAX_LENGTH = 4096;
  if (text.length <= MAX_LENGTH) {
    await ctx.reply(text || "(empty response)");
    return;
  }

  // Split on newlines, trying to keep paragraphs together
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
    await ctx.reply(chunk);
  }
}
