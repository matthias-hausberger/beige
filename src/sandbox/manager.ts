import Docker from "dockerode";
import { mkdirSync, writeFileSync, chmodSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import type { BeigeConfig, AgentConfig } from "../config/schema.js";
import type { LoadedTool } from "../tools/registry.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Manages Docker sandbox containers for agents.
 */
export class SandboxManager {
  private docker: Docker;
  private containers = new Map<string, Docker.Container>();
  private beigeDir: string;

  constructor(
    private config: BeigeConfig,
    private loadedTools: Map<string, LoadedTool>
  ) {
    this.docker = new Docker();
    this.beigeDir = resolve(homedir(), ".beige");
    mkdirSync(this.beigeDir, { recursive: true });
  }

  /**
   * Create and start a sandbox container for an agent.
   */
  async createSandbox(agentName: string): Promise<void> {
    const agentConfig = this.config.agents[agentName];
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    const image = agentConfig.sandbox?.image ?? "beige-sandbox:latest";

    // Prepare host directories
    const workspaceDir = resolve(this.beigeDir, "agents", agentName, "workspace");
    const socketsDir = resolve(this.beigeDir, "sockets");
    const socketPath = resolve(socketsDir, `${agentName}.sock`);
    const launchersDir = resolve(this.beigeDir, "agents", agentName, "launchers");

    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(socketsDir, { recursive: true });
    mkdirSync(launchersDir, { recursive: true });

    // Generate tool launcher scripts
    this.generateLaunchers(agentName, agentConfig, launchersDir);

    // Build mount bindings
    const binds = [
      `${workspaceDir}:/workspace:rw`,
      `${launchersDir}:/tools/bin:ro`,
      `${socketPath}:/beige/gateway.sock`,
    ];

    // Mount tool packages (read-only)
    for (const toolName of agentConfig.tools) {
      const tool = this.loadedTools.get(toolName);
      if (tool) {
        binds.push(`${tool.path}:/tools/packages/${toolName}:ro`);
      }
    }

    // Extra mounts from config
    if (agentConfig.sandbox?.extraMounts) {
      for (const [host, container] of Object.entries(agentConfig.sandbox.extraMounts)) {
        binds.push(`${host}:${container}`);
      }
    }

    // Remove existing container if any
    await this.removeSandbox(agentName);

    console.log(`[SANDBOX] Creating container for agent '${agentName}' (image: ${image})`);

    const container = await this.docker.createContainer({
      Image: image,
      name: `beige-${agentName}`,
      Hostname: `beige-${agentName}`,
      WorkingDir: "/workspace",
      Cmd: ["sleep", "infinity"], // Keep container running
      HostConfig: {
        Binds: binds,
        // No env vars from host — agent cannot access gateway secrets
      },
      // Only pass safe, non-secret env vars
      Env: Object.entries(agentConfig.sandbox?.extraEnv ?? {}).map(
        ([k, v]) => `${k}=${v}`
      ),
    });

    await container.start();
    this.containers.set(agentName, container);

    console.log(`[SANDBOX] Container started for agent '${agentName}' (${container.id.slice(0, 12)})`);
  }

  /**
   * Execute a command inside an agent's sandbox container.
   */
  async exec(
    agentName: string,
    cmd: string[],
    stdin?: string,
    timeout?: number
  ): Promise<ExecResult> {
    const container = this.containers.get(agentName);
    if (!container) {
      throw new Error(`No sandbox running for agent: ${agentName}`);
    }

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: !!stdin,
      WorkingDir: "/workspace",
    });

    return new Promise((resolveExec, reject) => {
      const timeoutMs = timeout ?? 120_000;
      let timer: ReturnType<typeof setTimeout> | undefined;

      exec.start({ hijack: !!stdin, stdin: !!stdin }, (err: Error | null, stream: any) => {
        if (err) return reject(err);

        let stdout = "";
        let stderr = "";

        if (stdin) {
          // In hijack mode, we get a raw stream
          stream.write(stdin);
          stream.end();

          // Demux the stream
          const { PassThrough } = require("stream");
          const stdoutStream = new PassThrough();
          const stderrStream = new PassThrough();

          container.modem.demuxStream(stream, stdoutStream, stderrStream);

          stdoutStream.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          stderrStream.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });

          stream.on("end", async () => {
            clearTimeout(timer);
            const inspect = await exec.inspect();
            resolveExec({
              stdout,
              stderr,
              exitCode: inspect.ExitCode ?? 1,
            });
          });
        } else {
          // Non-hijack mode: use demuxStream
          const { PassThrough } = require("stream");
          const stdoutStream = new PassThrough();
          const stderrStream = new PassThrough();

          container.modem.demuxStream(stream, stdoutStream, stderrStream);

          stdoutStream.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          stderrStream.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });

          stream.on("end", async () => {
            clearTimeout(timer);
            const inspect = await exec.inspect();
            resolveExec({
              stdout,
              stderr,
              exitCode: inspect.ExitCode ?? 1,
            });
          });
        }

        timer = setTimeout(() => {
          stream.destroy();
          reject(new Error(`Execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
    });
  }

  /**
   * Remove an agent's sandbox container.
   */
  async removeSandbox(agentName: string): Promise<void> {
    // Try to remove by name
    try {
      const existing = this.docker.getContainer(`beige-${agentName}`);
      await existing.stop().catch(() => {});
      await existing.remove({ force: true });
    } catch {
      // Container doesn't exist, that's fine
    }
    this.containers.delete(agentName);
  }

  /**
   * Stop all sandbox containers.
   */
  async shutdown(): Promise<void> {
    for (const [agentName] of this.containers) {
      await this.removeSandbox(agentName);
    }
  }

  /**
   * Generate tool launcher scripts for an agent.
   */
  private generateLaunchers(
    agentName: string,
    agentConfig: AgentConfig,
    launchersDir: string
  ): void {
    for (const toolName of agentConfig.tools) {
      const tool = this.loadedTools.get(toolName);
      if (!tool) continue;

      // Generate a launcher script that calls the tool-client
      const launcher = [
        "#!/bin/sh",
        `# Auto-generated by beige gateway. DO NOT EDIT.`,
        `# Tool: ${toolName} | Target: ${tool.manifest.target}`,
        `exec /beige/tool-client "${toolName}" "$@"`,
        "",
      ].join("\n");

      const launcherPath = join(launchersDir, toolName);
      writeFileSync(launcherPath, launcher);
      chmodSync(launcherPath, 0o755);
    }
  }
}
