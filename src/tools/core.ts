import { Type } from "@sinclair/typebox";
import type { ToolDefinition, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AuditLogger } from "../gateway/audit.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { OnToolStart } from "../gateway/agent-manager.js";
import type { SessionContext } from "../types/session.js";

export type ToolStartHandlerRef = { fn: OnToolStart | undefined };

export function createCoreTools(
  agentName: string,
  sandbox: SandboxManager,
  audit: AuditLogger,
  handlerRef?: ToolStartHandlerRef,
  sessionContext?: SessionContext
): ToolDefinition[] {
  const handler: ToolStartHandlerRef = handlerRef ?? { fn: undefined };

  return [
    createReadTool(agentName, sandbox, audit, handler),
    createWriteTool(agentName, sandbox, audit, handler),
    createPatchTool(agentName, sandbox, audit, handler),
    createExecTool(agentName, sandbox, audit, handler, sessionContext),
  ];
}

type HandlerRef = ToolStartHandlerRef;

/** Image extensions the read tool handles as multimodal image content. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
};

function createReadTool(
  agentName: string,
  sandbox: SandboxManager,
  audit: AuditLogger,
  handler: HandlerRef
): ToolDefinition {
  return {
    name: "read",
    label: "Read File",
    description:
      "Read the contents of a file in the sandbox. Paths are relative to /workspace or absolute within the sandbox. " +
      "For image files (.png, .jpg, .jpeg, .gif, .webp) the image is returned directly for visual inspection " +
      "— offset and limit are ignored for images.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to read" }),
      offset: Type.Optional(
        Type.Number({ description: "Line number to start reading from (1-indexed). Ignored for image files." })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of lines to read. Ignored for image files." })
      ),
    }),
    execute: async (toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) => {
      const p = params as { path: string; offset?: number; limit?: number };
      handler.fn?.("read", { path: p.path });

      // ── Image handling ──────────────────────────────────────────────
      const ext = p.path.slice(p.path.lastIndexOf(".")).toLowerCase();
      const mimeType = IMAGE_EXTENSIONS[ext];

      if (mimeType) {
        // Check whether the current model supports image input before attempting
        // to send image bytes — give the agent a clear, actionable error if not.
        const modelInput = ctx?.model?.input ?? [];
        if (!modelInput.includes("image")) {
          const modelLabel = ctx?.model
            ? `${(ctx.model as any).provider ?? ""}/${(ctx.model as any).id ?? ctx.model}`
            : "the current model";
          return {
            content: [{
              type: "text",
              text:
                `Cannot read image: ${p.path}\n\n` +
                `${modelLabel} does not support image (vision) input. ` +
                `You cannot view or analyse image files with this model. ` +
                `If you need to inspect an image, ask the user to switch to a vision-capable model ` +
                `(e.g. claude-sonnet, gpt-4o, gemini-1.5-pro) and try again.`,
            }],
            details: {},
            isError: true,
          };
        }

        const timer = audit.start(agentName, "core_tool", "read", [p.path], "allowed");
        try {
          // Encode inside the container — avoids binary corruption through the
          // Docker exec stdout demux stream (which is not binary-safe).
          const result = await sandbox.exec(agentName, ["base64", p.path]);
          timer.finish({ exitCode: result.exitCode, outputBytes: result.stdout.length });

          if (result.exitCode !== 0) {
            return {
              content: [{ type: "text", text: result.stderr || `Failed to read image: ${p.path}` }],
              details: {},
              isError: true,
            };
          }

          return {
            content: [{
              type: "image",
              data: result.stdout.replace(/\s/g, ""), // strip base64 line-breaks
              mimeType,
            }],
            details: {},
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          timer.finish({ exitCode: 1, error: msg });
          return {
            content: [{ type: "text", text: `Error reading image: ${msg}` }],
            details: {},
            isError: true,
          };
        }
      }

      // ── Text handling (existing behaviour) ─────────────────────────
      const args = ["cat"];

      if (p.offset || p.limit) {
        const start = p.offset ?? 1;
        const end = p.limit ? start + p.limit - 1 : "$";
        args.length = 0;
        args.push("sed", "-n", `${start},${end}p`, p.path);
      } else {
        args.push(p.path);
      }

      const timer = audit.start(agentName, "core_tool", "read", [p.path], "allowed");

      try {
        const result = await sandbox.exec(agentName, args);
        timer.finish({
          exitCode: result.exitCode,
          outputBytes: Buffer.byteLength(result.stdout),
        });

        if (result.exitCode !== 0) {
          return {
            content: [{ type: "text", text: result.stderr || `Failed to read: ${p.path}` }],
            details: {},
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: result.stdout }],
          details: {},
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        timer.finish({ exitCode: 1, error: msg });
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

function createWriteTool(
  agentName: string,
  sandbox: SandboxManager,
  audit: AuditLogger,
  handler: HandlerRef
): ToolDefinition {
  return {
    name: "write",
    label: "Write File",
    description:
      "Write content to a file in the sandbox. Creates parent directories if needed. Paths are relative to /workspace or absolute within the sandbox (only /workspace is writable).",
    parameters: Type.Object({
      path: Type.String({ description: "File path to write" }),
      content: Type.String({ description: "Content to write to the file" }),
    }),
    execute: async (toolCallId, params) => {
      const p = params as { path: string; content: string };
      handler.fn?.("write", { path: p.path, bytes: Buffer.byteLength(p.content) });
      const timer = audit.start(
        agentName,
        "core_tool",
        "write",
        [p.path, `(${Buffer.byteLength(p.content)} bytes)`],
        "allowed"
      );

      try {
        const script = `mkdir -p "$(dirname '${p.path}')" && cat > '${p.path}'`;
        const result = await sandbox.exec(agentName, ["sh", "-c", script], p.content);

        timer.finish({
          exitCode: result.exitCode,
          outputBytes: Buffer.byteLength(p.content),
        });

        if (result.exitCode !== 0) {
          return {
            content: [{ type: "text", text: result.stderr || `Failed to write: ${p.path}` }],
            details: {},
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Successfully wrote ${Buffer.byteLength(p.content)} bytes to ${p.path}`,
            },
          ],
          details: {},
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        timer.finish({ exitCode: 1, error: msg });
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

function createPatchTool(
  agentName: string,
  sandbox: SandboxManager,
  audit: AuditLogger,
  handler: HandlerRef
): ToolDefinition {
  return {
    name: "patch",
    label: "Patch File",
    description:
      "Apply a find-and-replace patch to a file in the sandbox. The oldText must match exactly (including whitespace).",
    parameters: Type.Object({
      path: Type.String({ description: "File path to patch" }),
      oldText: Type.String({ description: "Exact text to find and replace" }),
      newText: Type.String({ description: "New text to replace with" }),
    }),
    execute: async (toolCallId, params) => {
      const p = params as { path: string; oldText: string; newText: string };
      handler.fn?.("patch", { path: p.path });
      const timer = audit.start(
        agentName,
        "core_tool",
        "patch",
        [p.path],
        "allowed"
      );

      try {
        const readResult = await sandbox.exec(agentName, ["cat", p.path]);
        if (readResult.exitCode !== 0) {
          timer.finish({ exitCode: 1, error: `File not found: ${p.path}` });
          return {
            content: [{ type: "text", text: `File not found: ${p.path}` }],
            details: {},
            isError: true,
          };
        }

        const content = readResult.stdout;
        if (!content.includes(p.oldText)) {
          timer.finish({ exitCode: 1, error: "oldText not found in file" });
          return {
            content: [
              {
                type: "text",
                text: `The specified oldText was not found in ${p.path}. Make sure it matches exactly.`,
              },
            ],
            details: {},
            isError: true,
          };
        }

        const newContent = content.replace(p.oldText, p.newText);
        const writeScript = `cat > '${p.path}'`;
        const writeResult = await sandbox.exec(
          agentName,
          ["sh", "-c", writeScript],
          newContent
        );

        timer.finish({
          exitCode: writeResult.exitCode,
          outputBytes: Buffer.byteLength(newContent),
        });

        if (writeResult.exitCode !== 0) {
          return {
            content: [{ type: "text", text: writeResult.stderr || "Failed to write patched file" }],
            details: {},
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `Successfully patched ${p.path}` }],
          details: {},
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        timer.finish({ exitCode: 1, error: msg });
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

function buildSessionEnvVars(ctx: SessionContext | undefined): Record<string, string> | undefined {
  if (!ctx) return undefined;
  
  const env: Record<string, string> = {
    BEIGE_SESSION_KEY: ctx.sessionKey,
    BEIGE_CHANNEL: ctx.channel,
  };

  if (ctx.agentName) env.BEIGE_AGENT_NAME = ctx.agentName;
  if (ctx.chatId) env.BEIGE_CHAT_ID = ctx.chatId;
  if (ctx.threadId) env.BEIGE_THREAD_ID = ctx.threadId;
  
  return env;
}

function createExecTool(
  agentName: string,
  sandbox: SandboxManager,
  audit: AuditLogger,
  handler: HandlerRef,
  sessionContext?: SessionContext
): ToolDefinition {
  return {
    name: "exec",
    label: "Execute Command",
    description:
      "Execute a command in the sandbox. The command runs in /workspace by default. Use this to run scripts, tools from /tools/bin/, or any available command.",
    parameters: Type.Object({
      command: Type.String({
        description: "The command to execute (e.g. 'ls -la' or '/tools/bin/kv set mykey myvalue')",
      }),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 900)",
        })
      ),
    }),
    execute: async (toolCallId, params) => {
      const p = params as { command: string; timeout?: number };
      handler.fn?.("exec", { command: p.command });
      const args = ["sh", "-c", p.command];
      const timer = audit.start(
        agentName,
        "core_tool",
        "exec",
        [p.command],
        "allowed"
      );

      try {
        const timeout = (p.timeout ?? 900) * 1000;
        const envVars = buildSessionEnvVars(sessionContext);
        const result = await sandbox.exec(agentName, args, undefined, timeout, envVars);

        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        timer.finish({
          exitCode: result.exitCode,
          outputBytes: Buffer.byteLength(output),
        });

        return {
          content: [
            {
              type: "text",
              text: `Exit code: ${result.exitCode}\n${output}`,
            },
          ],
          details: {},
          isError: result.exitCode !== 0,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        timer.finish({ exitCode: 1, error: msg });
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}
