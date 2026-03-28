import Docker from "dockerode";
import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { beigeDir } from "../paths.js";
import { PassThrough } from "stream";
import { fileURLToPath } from "url";
import type { BeigeConfig, AgentConfig } from "../config/schema.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { LoadedSkill } from "../skills/registry.js";

/** The image name prefix we build and manage. Any image starting with this is ours. */
const BEIGE_IMAGE_PREFIX = "beige-sandbox";
const BEIGE_IMAGE_DEFAULT = "beige-sandbox:latest";

/**
 * Default memory limit applied to every sandbox container (3 GiB).
 * Prevents runaway processes (npm install, build tools) from exhausting host
 * RAM and triggering a hardware watchdog reboot.  The container will receive
 * a cgroup OOM kill instead — much safer than taking down the whole host.
 */
const DEFAULT_MEMORY_LIMIT = "3g";

/**
 * Parse a human-readable memory string into bytes for Docker's Memory field.
 * Accepts: "3g", "3G", "512m", "512M", "1024k", "1024K", or a plain number
 * (treated as bytes).
 */
function parseMemoryBytes(limit: string): number {
  const match = limit.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgKMG]?)b?$/i);
  if (!match) {
    throw new Error(
      `Invalid sandbox memoryLimit "${limit}". Use a number with unit, e.g. "3g", "512m".`
    );
  }
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    "": 1,
    k: 1_024,
    m: 1_024 ** 2,
    g: 1_024 ** 3,
  };
  return Math.floor(value * (multipliers[unit] ?? 1));
}

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
    private pluginRegistry: PluginRegistry,
    private loadedSkills: Map<string, LoadedSkill>
  ) {
    this.docker = new Docker();
    this.beigeDir = beigeDir();
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

    const workspaceDir = this.getWorkspaceDir(agentName, agentConfig);
    const socketsDir = resolve(this.beigeDir, "sockets");
    const socketPath = resolve(socketsDir, `${agentName}.sock`);
    const launchersDir = resolve(this.beigeDir, "agents", agentName, "launchers");

    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(socketsDir, { recursive: true });
    mkdirSync(launchersDir, { recursive: true });

    // Populate AGENTS.md in the workspace if it doesn't exist yet
    this.ensureAgentsMd(agentName, workspaceDir);

    // Generate tool launcher scripts
    this.generateLaunchers(agentName, agentConfig, launchersDir);

    // Build mount bindings
    const binds = [
      `${workspaceDir}:/workspace:rw`,
      `${launchersDir}:/tools/bin:ro`,
      `${socketPath}:/beige/gateway.sock`,
    ];

    // Mount plugin package directories (read-only) for tools that have a path
    // This allows agents to read SKILL.md and README.md
    for (const toolName of agentConfig.tools) {
      // Find the plugin that provides this tool
      const pluginTool = this.pluginRegistry.getTool(toolName);
      if (!pluginTool) continue;

      // The plugin's path is resolved from the loaded plugin; for now,
      // we check the config for the plugin path
      const pluginName = toolName.includes(".") ? toolName.split(".")[0] : toolName;
      const pluginConfig = this.config.plugins?.[pluginName];
      if (pluginConfig?.path) {
        binds.push(`${pluginConfig.path}:/tools/packages/${toolName}:ro`);
      }
    }

    // Mount skill packages (read-only)
    for (const skillName of agentConfig.skills ?? []) {
      const skill = this.loadedSkills.get(skillName);
      if (skill) {
        binds.push(`${skill.path}:/skills/${skillName}:ro`);
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

    // Build environment: prepend /tools/bin to PATH so tools shadow system binaries
    const envVars = [
      "PATH=/tools/bin:/usr/local/bin:/usr/bin:/bin",
      ...Object.entries(agentConfig.sandbox?.extraEnv ?? {}).map(
        ([k, v]) => `${k}=${v}`
      ),
    ];

    // Resolve memory limit — agent-level override → global sandbox default → hardcoded default
    const memoryLimitStr = agentConfig.sandbox?.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    const memoryBytes = parseMemoryBytes(memoryLimitStr);
    console.log(`[SANDBOX] Memory limit for '${agentName}': ${memoryLimitStr} (${memoryBytes} bytes)`);

    const container = await this.docker.createContainer({
      Image: image,
      name: `beige-${agentName}`,
      Hostname: `beige-${agentName}`,
      WorkingDir: "/workspace",
      Cmd: ["sleep", "infinity"],
      HostConfig: {
        Binds: binds,
        // Hard memory cap — container gets OOM-killed by the cgroup before it
        // can exhaust host RAM.  Swap is intentionally kept at the same value
        // (MemorySwap = Memory) to disable swap and keep the limit hard.
        Memory: memoryBytes,
        MemorySwap: memoryBytes,
      },
      Env: envVars,
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
    timeout?: number,
    env?: Record<string, string>
  ): Promise<ExecResult> {
    const container = this.containers.get(agentName);
    if (!container) {
      throw new Error(`No sandbox running for agent: ${agentName}`);
    }

    const agentConfig = this.config.agents[agentName];
    const baseEnv = [
      "PATH=/tools/bin:/usr/local/bin:/usr/bin:/bin",
      ...Object.entries(agentConfig?.sandbox?.extraEnv ?? {}).map(
        ([k, v]) => `${k}=${v}`
      ),
    ];
    const additionalEnv = env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : [];

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: !!stdin,
      WorkingDir: "/workspace",
      Env: [...baseEnv, ...additionalEnv],
    });

    return new Promise((resolveExec, reject) => {
      const timeoutMs = timeout ?? 120_000;
      let timer: ReturnType<typeof setTimeout> | undefined;

      exec.start({ hijack: !!stdin, stdin: !!stdin }, (err: Error | null, stream: any) => {
        if (err) return reject(err);

        let stdout = "";
        let stderr = "";

        if (stdin) {
          stream.write(stdin);
          stream.end();

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
   * Check which agents use a beige-managed image and, if any do, ensure the
   * image is built before containers are created.
   */
  async ensureSandboxImage(force = false): Promise<void> {
    const needed = new Set<string>();
    for (const agentConfig of Object.values(this.config.agents)) {
      const image = agentConfig.sandbox?.image ?? BEIGE_IMAGE_DEFAULT;
      if (this.isBeigeImage(image)) {
        needed.add(image);
      }
    }

    if (needed.size === 0) {
      console.log("[SANDBOX] No agents use a beige-sandbox image — skipping image build");
      return;
    }

    for (const image of needed) {
      if (!force && (await this.imageExists(image))) {
        console.log(`[SANDBOX] Image '${image}' already exists — skipping build`);
        continue;
      }

      await this.buildSandboxImage(image);
    }
  }

  private async buildSandboxImage(tag: string): Promise<void> {
    const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const sandboxDir = resolve(projectRoot, "sandbox");

    console.log(`[SANDBOX] Building image '${tag}' from ${sandboxDir} ...`);

    const stream = await this.docker.buildImage(
      { context: sandboxDir, src: ["Dockerfile", "tool-client.ts"] },
      { t: tag }
    );

    await new Promise<void>((res, rej) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => (err ? rej(err) : res()),
        (event: { stream?: string; error?: string; status?: string }) => {
          if (event.error) {
            process.stderr.write(`[SANDBOX BUILD] ${event.error}`);
          } else if (event.stream) {
            process.stdout.write(`[SANDBOX BUILD] ${event.stream}`);
          } else if (event.status) {
            process.stdout.write(`[SANDBOX BUILD] ${event.status}\n`);
          }
        }
      );
    });

    console.log(`[SANDBOX] Image '${tag}' built successfully ✓`);
  }

  private isBeigeImage(image: string): boolean {
    return image === BEIGE_IMAGE_PREFIX || image.startsWith(`${BEIGE_IMAGE_PREFIX}:`);
  }

  private async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
    }
  }

  private getWorkspaceDir(agentName: string, agentConfig: AgentConfig): string {
    if (agentConfig.workspaceDir) {
      return agentConfig.workspaceDir;
    }
    return resolve(this.beigeDir, "agents", agentName, "workspace");
  }

  private ensureAgentsMd(agentName: string, workspaceDir: string): void {
    const agentsMdPath = join(workspaceDir, "AGENTS.md");
    if (existsSync(agentsMdPath)) return;

    try {
      const templatePath = fileURLToPath(
        new URL("../gateway/default-agents-md.md", import.meta.url)
      );
      const content = readFileSync(templatePath, "utf-8");
      writeFileSync(agentsMdPath, content, "utf-8");
      console.log(`[SANDBOX] Created AGENTS.md for agent '${agentName}'`);
    } catch (err) {
      console.warn(`[SANDBOX] Could not write AGENTS.md for agent '${agentName}': ${err}`);
    }
  }

  /**
   * Generate tool launcher scripts for an agent.
   * Launchers are shell scripts that call the tool-client, which connects
   * to the gateway via Unix socket.
   */
  private generateLaunchers(
    agentName: string,
    agentConfig: AgentConfig,
    launchersDir: string
  ): void {
    for (const toolName of agentConfig.tools) {
      const pluginTool = this.pluginRegistry.getTool(toolName);
      if (!pluginTool) continue;

      const launcher = [
        "#!/bin/sh",
        `# Auto-generated by beige gateway. DO NOT EDIT.`,
        `# Tool: ${toolName}`,
        `exec /beige/tool-client "${toolName}" "$@"`,
        "",
      ].join("\n");

      // For dotted tool names (e.g. slack.send_message), use the full name
      const launcherPath = join(launchersDir, toolName);
      writeFileSync(launcherPath, launcher);
      chmodSync(launcherPath, 0o755);
    }
  }
}
