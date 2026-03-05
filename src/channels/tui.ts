import {
  InteractiveMode,
  type AgentSession,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import type { BeigeConfig } from "../config/schema.js";
import type { AgentManager } from "../gateway/agent-manager.js";
import { BeigeSessionStore } from "../gateway/sessions.js";

/**
 * TUI channel — an interactive terminal interface to a beige agent.
 *
 * This is a channel just like Telegram: it talks to the gateway's agent-manager,
 * which owns the sandboxes, tools, sessions, and LLM calls.
 *
 * Uses pi's InteractiveMode for the actual terminal UI (editor, streaming,
 * model switching, etc.).
 *
 * Provides beige-specific commands:
 *   /new       — start a fresh conversation session
 *   /sessions  — list and switch sessions for the current agent
 *   /resume    — pick any previous session across all agents
 *   /agent     — switch to a different beige agent
 */
export class TUIChannel {
  constructor(
    private config: BeigeConfig,
    private agentManager: AgentManager,
    private sessionStore: BeigeSessionStore
  ) {}

  /**
   * Run the TUI. Blocks until the user exits.
   * May re-enter if the user switches agents via /agent.
   */
  async run(agentName: string, resumeFile?: string): Promise<void> {
    let currentAgent = agentName;
    let currentResumeFile = resumeFile;

    // Outer loop: allows /agent to restart with a different agent
    while (true) {
      const result = await this.runSession(currentAgent, currentResumeFile);
      currentResumeFile = undefined;

      if (result.type === "exit") break;

      if (result.type === "switch_agent") {
        currentAgent = result.agentName!;
        console.log(`\n[TUI] Switching to agent '${currentAgent}'...`);
      }
    }
  }

  private async runSession(
    agentName: string,
    resumeFile?: string
  ): Promise<{ type: "exit" | "switch_agent"; agentName?: string }> {
    // Get a session from the agent-manager (same path as Telegram)
    const sessionKey = BeigeSessionStore.tuiKey(agentName);
    const managed = await this.agentManager.getOrCreateSession(
      sessionKey,
      agentName,
      { sessionFile: resumeFile }
    );

    const session = managed.session;
    let switchToAgent: string | undefined;

    // Register beige-specific commands on the session's extension runtime
    this.registerCommands(session, agentName, () => switchToAgent, (agent) => {
      switchToAgent = agent;
    });

    // Launch pi's interactive TUI — blocks until user exits
    const mode = new InteractiveMode(session, {});
    await mode.run();

    // Clean up this session from the agent-manager cache
    // (a new one will be created on next entry)
    await this.agentManager.disposeSession(sessionKey);

    if (switchToAgent) {
      return { type: "switch_agent", agentName: switchToAgent };
    }
    return { type: "exit" };
  }

  private registerCommands(
    session: AgentSession,
    agentName: string,
    getSwitchTarget: () => string | undefined,
    setSwitchTarget: (agent: string) => void
  ): void {
    // Access the extension runtime from the session
    // The agent-manager creates sessions with an extension runtime that supports registerCommand
    const pi = (session as any).agent?.extensionRuntime as ExtensionAPI | undefined;
    if (!pi?.registerCommand) {
      console.warn("[TUI] Could not register commands — extension runtime not available");
      return;
    }

    const agentNames = Object.keys(this.config.agents);
    const sessionStore = this.sessionStore;

    // /new — start fresh session
    pi.registerCommand("new", {
      description: "Start a new conversation session",
      handler: async (_args, ctx) => {
        const ok = await ctx.ui.confirm(
          "New Session",
          "Start a new session? The current session will be saved."
        );
        if (ok) {
          await session.newSession();
          ctx.ui.notify("🆕 New session started", "info");
        }
      },
    });

    // /sessions — list sessions for current agent
    pi.registerCommand("sessions", {
      description: "List saved sessions for the current agent",
      handler: async (_args, ctx) => {
        const sessions = sessionStore.listSessions(agentName);
        if (sessions.length === 0) {
          ctx.ui.notify("No saved sessions found", "info");
          return;
        }

        const options = sessions.map(
          (s) => `${s.sessionId} — ${s.firstMessage} (${s.createdAt.slice(0, 16)})`
        );
        const choice = await ctx.ui.select("Sessions", options);

        if (choice !== undefined) {
          const idx = options.indexOf(choice);
          const selected = sessions[idx];
          if (selected) {
            await session.switchSession(selected.sessionFile);
            ctx.ui.notify(`📂 Switched to session ${selected.sessionId}`, "info");
          }
        }
      },
    });

    // /resume — pick any session across all agents
    pi.registerCommand("resume", {
      description: "Resume a previous session",
      handler: async (_args, ctx) => {
        const allSessions = sessionStore.listAllSessions();
        if (allSessions.length === 0) {
          ctx.ui.notify("No saved sessions found", "info");
          return;
        }

        const options = allSessions.map(
          (s) => `[${s.agentName}] ${s.sessionId} — ${s.firstMessage} (${s.createdAt.slice(0, 16)})`
        );
        const choice = await ctx.ui.select("Resume Session", options);

        if (choice !== undefined) {
          const idx = options.indexOf(choice);
          const selected = allSessions[idx];
          if (selected) {
            if (selected.agentName !== agentName) {
              ctx.ui.notify(
                `Session belongs to agent '${selected.agentName}'. Use /agent ${selected.agentName} first.`,
                "warning"
              );
              return;
            }
            await session.switchSession(selected.sessionFile);
            ctx.ui.notify(`📂 Resumed session ${selected.sessionId}`, "info");
          }
        }
      },
    });

    // /agent — switch to a different beige agent
    pi.registerCommand("agent", {
      description: "Switch to a different beige agent",
      getArgumentCompletions: (prefix: string) => {
        const items = agentNames.map((name) => ({ value: name, label: name }));
        const filtered = items.filter((i) => i.value.startsWith(prefix));
        return filtered.length > 0 ? filtered : null;
      },
      handler: async (args, ctx) => {
        const targetAgent = args?.trim();

        if (!targetAgent) {
          const choice = await ctx.ui.select(
            `Current agent: ${agentName}`,
            agentNames
          );
          if (choice && choice !== agentName) {
            setSwitchTarget(choice);
            ctx.ui.notify(`Switching to agent '${choice}'...`, "info");
            await session.abort();
          }
          return;
        }

        if (!this.config.agents[targetAgent]) {
          ctx.ui.notify(
            `Unknown agent '${targetAgent}'. Available: ${agentNames.join(", ")}`,
            "warning"
          );
          return;
        }

        if (targetAgent === agentName) {
          ctx.ui.notify(`Already using agent '${agentName}'`, "info");
          return;
        }

        setSwitchTarget(targetAgent);
        ctx.ui.notify(`Switching to agent '${targetAgent}'...`, "info");
        await session.abort();
      },
    });
  }
}
