export interface SessionContext {
  sessionKey: string;
  channel: string;
  /**
   * The beige agent name that owns this session.
   * Set by AgentManager when creating or resuming a session and injected into
   * the sandbox environment so gateway tools can identify the calling agent
   * without needing to look up the session store.
   */
  agentName?: string;
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
