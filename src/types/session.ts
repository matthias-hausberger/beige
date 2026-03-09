export interface SessionContext {
  sessionKey: string;
  channel: string;
  chatId?: string;
  threadId?: string;
}

export function parseSessionKey(sessionKey: string): SessionContext {
  const parts = sessionKey.split(":");
  const channel = parts[0] ?? "";
  
  if (channel === "telegram") {
    return {
      sessionKey,
      channel: "telegram",
      chatId: parts[1],
      threadId: parts[2],
    };
  }
  
  if (channel === "tui") {
    return {
      sessionKey,
      channel: "tui",
    };
  }
  
  return {
    sessionKey,
    channel,
  };
}
