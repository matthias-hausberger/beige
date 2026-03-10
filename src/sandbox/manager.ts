import Docker from "dockerode";
import { mkdirSync, writeFileSync, chmodSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { PassThrough } from "stream";
import { fileURLToPath } from "url";
import type { BeigeConfig, AgentConfig } from "../config/schema.js";
import type { LoadedTool } from "../tools/registry.js";
import type { LoadedSkill } from "../skills/registry.js";

/** The image name prefix we build and manage. Any image starting with this is ours. */
const BEIGE_IMAGE_PREFIX = "beige-sandbox";
const BEIGE_IMAGE_DEFAULT = "beige-sandbox:latest";

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
    private loadedTools: Map<string, LoadedTool>,
    private loadedSkills: Map<string, LoadedSkill>
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
    timeout?: number,
    env?: Record<string, string>
  ): Promise<ExecResult> {
    const container = this.containers.get(agentName);
    if (!container) {
      throw new Error(`No sandbox running for agent: ${agentName}`);
    }

    const agentConfig = this.config.agents[agentName];
    const baseEnv = Object.entries(agentConfig?.sandbox?.extraEnv ?? {}).map(
      ([k, v]) => `${k}=${v}`
    );
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
          // In hijack mode, we get a raw stream
          stream.write(stdin);
          stream.end();

          // Demux the stream
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
   * Check which agents use a beige-managed image and, if any do, ensure the
   * image is built before containers are created.
   *
   * - Skipped entirely when no agent references a beige-sandbox image.
   * - Skipped when the image already exists (unless `force` is true).
   * - Builds one image per unique beige image tag referenced across all agents.
   */
  async ensureSandboxImage(force = false): Promise<void> {
    // Collect the set of beige-managed image tags that agents actually need.
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

  /**
   * Build the beige-sandbox Docker image from the bundled Dockerfile.
   * Streams build output to stdout so the user can see progress.
   */
  private async buildSandboxImage(tag: string): Promise<void> {
    // sandbox/ lives two directories up from src/sandbox/manager.ts
    // At runtime (dist/sandbox/manager.js) it's still two levels up from dist/.
    // We resolve relative to this file using import.meta.url.
    // src/sandbox/manager.ts → up to src/sandbox → up to project root
    const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const sandboxDir = resolve(projectRoot, "sandbox");

    console.log(`[SANDBOX] Building image '${tag}' from ${sandboxDir} ...`);

    const stream = await this.docker.buildImage(
      { context: sandboxDir, src: ["Dockerfile", "tool-client.ts"] },
      { t: tag }
    );

    // Stream build output line-by-line
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

  /**
   * Returns true when `image` is a beige-managed image (i.e. one we build).
   */
  private isBeigeImage(image: string): boolean {
    // Match "beige-sandbox", "beige-sandbox:latest", "beige-sandbox:custom-tag", etc.
    return image === BEIGE_IMAGE_PREFIX || image.startsWith(`${BEIGE_IMAGE_PREFIX}:`);
  }

  /**
   * Returns true when the given Docker image tag already exists locally.
   */
  private async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch {
      return false;
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
