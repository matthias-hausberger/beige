import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AuditLogger } from "../gateway/audit.js";
import type { SandboxManager } from "../sandbox/manager.js";

/**
 * Create the 4 core tools that are exposed to the LLM.
 * All execute inside the agent's sandbox via docker exec.
 */
export function createCoreTools(
  agentName: string,
  sandbox: SandboxManager,
  audit: AuditLogger
): ToolDefinition[] {
  return [
    createReadTool(agentName, sandbox, audit),
    createWriteTool(agentName, sandbox, audit),
    createPatchTool(agentName, sandbox, audit),
    createExecTool(agentName, sandbox, audit),
  ];
}

function createReadTool(
  agentName: string,
  sandbox: SandboxManager,
  audit: AuditLogger
): ToolDefinition {
  return {
    name: "read",
    label: "Read File",
    description:
      "Read the contents of a file in the sandbox. Paths are relative to /workspace or absolute within the sandbox.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to read" }),
      offset: Type.Optional(
        Type.Number({ description: "Line number to start reading from (1-indexed)" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of lines to read" })
      ),
    }),
    execute: async (toolCallId, params) => {
      const args = ["cat"];

      // Use sed for offset/limit support
      if (params.offset || params.limit) {
        const start = params.offset ?? 1;
        const end = params.limit ? start + params.limit - 1 : "$";
        args.length = 0;
        args.push("sed", "-n", `${start},${end}p`, params.path);
      } else {
        args.push(params.path);
      }

      const timer = audit.start(agentName, "core_tool", "read", [params.path], "allowed");

      try {
        const result = await sandbox.exec(agentName, args);
        timer.finish({
          exitCode: result.exitCode,
          outputBytes: Buffer.byteLength(result.stdout),
        });

        if (result.exitCode !== 0) {
          return {
            content: [{ type: "text", text: result.stderr || `Failed to read: ${params.path}` }],
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
  audit: AuditLogger
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
      const timer = audit.start(
        agentName,
        "core_tool",
        "write",
        [params.path, `(${Buffer.byteLength(params.content)} bytes)`],
        "allowed"
      );

      try {
        // Create parent dirs then write via sh -c
        const script = `mkdir -p "$(dirname '${params.path}')" && cat > '${params.path}'`;
        const result = await sandbox.exec(agentName, ["sh", "-c", script], params.content);

        timer.finish({
          exitCode: result.exitCode,
          outputBytes: Buffer.byteLength(params.content),
        });

        if (result.exitCode !== 0) {
          return {
            content: [{ type: "text", text: result.stderr || `Failed to write: ${params.path}` }],
            details: {},
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Successfully wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}`,
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
  audit: AuditLogger
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
      const timer = audit.start(
        agentName,
        "core_tool",
        "patch",
        [params.path],
        "allowed"
      );

      try {
        // Read current content
        const readResult = await sandbox.exec(agentName, ["cat", params.path]);
        if (readResult.exitCode !== 0) {
          timer.finish({ exitCode: 1, error: `File not found: ${params.path}` });
          return {
            content: [{ type: "text", text: `File not found: ${params.path}` }],
            details: {},
            isError: true,
          };
        }

        const content = readResult.stdout;
        if (!content.includes(params.oldText)) {
          timer.finish({ exitCode: 1, error: "oldText not found in file" });
          return {
            content: [
              {
                type: "text",
                text: `The specified oldText was not found in ${params.path}. Make sure it matches exactly.`,
              },
            ],
            details: {},
            isError: true,
          };
        }

        const newContent = content.replace(params.oldText, params.newText);
        const writeScript = `cat > '${params.path}'`;
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
          content: [{ type: "text", text: `Successfully patched ${params.path}` }],
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

function createExecTool(
  agentName: string,
  sandbox: SandboxManager,
  audit: AuditLogger
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
          description: "Timeout in seconds (default: 120)",
        })
      ),
    }),
    execute: async (toolCallId, params) => {
      const args = ["sh", "-c", params.command];
      const timer = audit.start(
        agentName,
        "core_tool",
        "exec",
        [params.command],
        "allowed"
      );

      try {
        const timeout = (params.timeout ?? 120) * 1000;
        const result = await sandbox.exec(agentName, args, undefined, timeout);

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
