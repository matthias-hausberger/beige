/**
 * LLM-specific error handling for user-friendly Telegram messages.
 *
 * This module provides:
 * - LLM error classification (beyond generic errors)
 * - User-friendly error messages suitable for Telegram display
 * - Error formatting utilities
 *
 * Used by the Telegram channel to show helpful messages instead of raw errors.
 *
 * @see BEIGE-006 for design rationale
 */

import { classifyError, type ErrorType } from "./error-logger.js";

// ── Types ────────────────────────────────────────────────────────────────

export type LLMErrorCategory =
  | "rate_limit"
  | "auth"
  | "context_too_long"
  | "model_unavailable"
  | "network"
  | "invalid_response"
  | "timeout"
  | "unknown";

export interface LLMErrorInfo {
  category: LLMErrorCategory;
  userMessage: string;
  technicalMessage: string;
  retryable: boolean;
  suggestedAction?: string;
}

// ── LLM-Specific Classification ──────────────────────────────────────────

/**
 * Classify an LLM-related error into a specific category.
 * This is more specific than the generic error classifier.
 */
export function classifyLLMError(err: unknown): LLMErrorCategory {
  if (!(err instanceof Error)) {
    return "unknown";
  }

  const msg = err.message.toLowerCase();

  // Rate limiting (most specific first)
  if (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("quota exceeded")
  ) {
    return "rate_limit";
  }

  // Context/token limits
  if (
    msg.includes("context length") ||
    msg.includes("token limit") ||
    msg.includes("prompt is too long") ||
    msg.includes("maximum context") ||
    msg.includes("reduce the length") ||
    msg.includes("context_too_long")
  ) {
    return "context_too_long";
  }

  // Authentication issues
  if (
    msg.includes("invalid api key") ||
    msg.includes("unauthorized") ||
    msg.includes("authentication failed") ||
    msg.includes("api key") ||
    msg.includes("401") ||
    msg.includes("403")
  ) {
    return "auth";
  }

  // Model availability
  if (
    msg.includes("model not found") ||
    msg.includes("model unavailable") ||
    msg.includes("model is overloaded") ||
    msg.includes("model is currently unavailable") ||
    msg.includes("no such model")
  ) {
    return "model_unavailable";
  }

  // Network issues
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("etimedout")
  ) {
    return "timeout";
  }

  if (
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up")
  ) {
    return "network";
  }

  // Response parsing issues
  if (
    msg.includes("invalid response") ||
    msg.includes("malformed") ||
    msg.includes("failed to parse") ||
    msg.includes("unexpected token") ||
    msg.includes("json")
  ) {
    return "invalid_response";
  }

  return "unknown";
}

// ── User-Friendly Messages ────────────────────────────────────────────────

const USER_MESSAGES: Record<LLMErrorCategory, { message: string; emoji: string; retryable: boolean; action?: string }> = {
  rate_limit: {
    emoji: "⏳",
    message: "The AI is a bit busy right now. I've automatically switched to a backup model.",
    retryable: true,
    action: "Your request is being processed with an alternative model.",
  },
  auth: {
    emoji: "🔑",
    message: "There's an API key issue. Please check the configuration.",
    retryable: false,
    action: "Contact the administrator to verify API keys.",
  },
  context_too_long: {
    emoji: "📏",
    message: "This conversation is getting too long for the AI's memory.",
    retryable: false,
    action: "Try /new to start a fresh conversation, or keep your messages shorter.",
  },
  model_unavailable: {
    emoji: "🤖",
    message: "The AI model is temporarily unavailable.",
    retryable: true,
    action: "I'm trying a different model automatically.",
  },
  network: {
    emoji: "🌐",
    message: "Network connection issue. Please try again.",
    retryable: true,
    action: "Check your internet connection.",
  },
  timeout: {
    emoji: "⏰",
    message: "The request took too long. The AI might be busy.",
    retryable: true,
    action: "Try again in a moment.",
  },
  invalid_response: {
    emoji: "🔧",
    message: "Received an unexpected response from the AI.",
    retryable: true,
    action: "Try rephrasing your request.",
  },
  unknown: {
    emoji: "❌",
    message: "An unexpected error occurred.",
    retryable: true,
    action: "Try again or use /new to start fresh.",
  },
};

/**
 * Get user-friendly information about an LLM error.
 */
export function getLLMErrorInfo(err: unknown): LLMErrorInfo {
  const category = classifyLLMError(err);
  const config = USER_MESSAGES[category];
  const technicalMessage = err instanceof Error ? err.message : String(err);

  return {
    category,
    userMessage: config.message,
    technicalMessage,
    retryable: config.retryable,
    suggestedAction: config.action,
  };
}

/**
 * Format an LLM error for Telegram display.
 * Returns a concise, user-friendly message with optional technical details.
 */
export function formatTelegramError(err: unknown, verbose: boolean = false): string {
  const info = getLLMErrorInfo(err);
  const { emoji, message } = USER_MESSAGES[info.category];

  let formatted = `${emoji} ${message}`;

  if (info.suggestedAction) {
    formatted += `\n\n💡 ${info.suggestedAction}`;
  }

  if (verbose && info.technicalMessage) {
    // Include technical details in verbose mode
    formatted += `\n\n\`\`\`\n${info.technicalMessage.slice(0, 500)}\n\`\`\``;
  }

  return formatted;
}

/**
 * Check if an error indicates that all fallback models have been exhausted.
 */
export function isAllModelsExhausted(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("All models failed");
}

/**
 * Format the "all models failed" error for Telegram.
 */
export function formatAllModelsExhaustedError(err: unknown): string {
  // Extract the last error message if available
  const lastError = err instanceof Error
    ? err.message.replace(/.*Last error:\s*/, "")
    : "Unknown error";

  return `❌ All AI models failed. This might be a temporary issue.\n\n` +
    `💡 Try again in a few minutes, or use /new to start fresh.\n\n` +
    `Last error: ${lastError}`;
}

/**
 * Get a short error tag for logging purposes.
 */
export function getErrorTag(err: unknown): string {
  const category = classifyLLMError(err);
  const tags: Record<LLMErrorCategory, string> = {
    rate_limit: "RATE_LIMIT",
    auth: "AUTH",
    context_too_long: "CONTEXT",
    model_unavailable: "MODEL",
    network: "NETWORK",
    invalid_response: "PARSE",
    timeout: "TIMEOUT",
    unknown: "UNKNOWN",
  };
  return tags[category];
}
