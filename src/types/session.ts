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
  /**
   * The absolute path to the agent's directory on the gateway host.
   * This is <beigeDir>/agents/<agentName>/ and contains launchers,
   * browser profiles, and other agent-specific data that is NOT user workspace.
   * Set by AgentManager when building session context.
   */
  agentDir?: string;
  /**
   * The absolute path to the agent's workspace directory on the gateway host.
   * This is mounted at /workspace inside the sandbox. Defaults to
   * <beigeDir>/agents/<agentName>/workspace/ but can be configured per-agent
   * to point anywhere on the host.
   * Set by AgentManager when building session context.
   */
  workspaceDir?: string;
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
