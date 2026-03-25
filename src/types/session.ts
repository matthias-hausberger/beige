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
  /**
   * Relative working directory from workspace root.
   * When an agent runs a tool from a subdirectory of /workspace, this field
   * contains the relative path (e.g., "repos/beige-toolkit").
   * Tools can use this to run commands in the correct directory.
   */
  cwd?: string;
  chatId?: string;
  threadId?: string;
}

/**
 * Parse a session key into a SessionContext.
 *
 * Session keys follow the convention `channel:id1:id2:...`. The first segment
 * is always the channel name. Remaining segments are channel-specific and are
 * stored as chatId (second segment) and threadId (third segment) for backward
 * compatibility — plugins may use these for any purpose.
 */
export function parseSessionKey(sessionKey: string): SessionContext {
  const parts = sessionKey.split(":");
  const channel = parts[0] ?? "";

  return {
    sessionKey,
    channel,
    chatId: parts[1],
    threadId: parts[2],
  };
}
