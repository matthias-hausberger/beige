import { describe, it, expect } from "vitest";
import { PolicyEngine } from "./policy.js";
import { createFullConfig, createMinimalConfig } from "../test/fixtures.js";

describe("PolicyEngine", () => {
  describe("with full config", () => {
    const config = createFullConfig();
    const engine = new PolicyEngine(config);

    describe("isCoreTool", () => {
      it("returns true for 'read'", () => {
        expect(engine.isCoreTool("read")).toBe(true);
      });

      it("returns true for 'write'", () => {
        expect(engine.isCoreTool("write")).toBe(true);
      });

      it("returns true for 'patch'", () => {
        expect(engine.isCoreTool("patch")).toBe(true);
      });

      it("returns true for 'exec'", () => {
        expect(engine.isCoreTool("exec")).toBe(true);
      });

      it("returns false for custom tools", () => {
        expect(engine.isCoreTool("kv")).toBe(false);
        expect(engine.isCoreTool("browser")).toBe(false);
      });

      it("returns false for unknown tools", () => {
        expect(engine.isCoreTool("unknown")).toBe(false);
        expect(engine.isCoreTool("")).toBe(false);
      });
    });

    describe("isToolAllowed", () => {
      it("allows configured tools for agent", () => {
        expect(engine.isToolAllowed("assistant", "kv")).toBe(true);
        expect(engine.isToolAllowed("researcher", "kv")).toBe(true);
        expect(engine.isToolAllowed("researcher", "browser")).toBe(true);
      });

      it("denies unconfigured tools for agent", () => {
        expect(engine.isToolAllowed("assistant", "browser")).toBe(false);
        expect(engine.isToolAllowed("restricted", "kv")).toBe(false);
      });

      it("denies all tools for unknown agent", () => {
        expect(engine.isToolAllowed("unknown-agent", "kv")).toBe(false);
        expect(engine.isToolAllowed("unknown-agent", "browser")).toBe(false);
      });

      it("denies when agent has empty tools array", () => {
        expect(engine.isToolAllowed("restricted", "kv")).toBe(false);
        expect(engine.isToolAllowed("restricted", "browser")).toBe(false);
      });
    });

    describe("isAgentValid", () => {
      it("returns true for configured agents", () => {
        expect(engine.isAgentValid("assistant")).toBe(true);
        expect(engine.isAgentValid("researcher")).toBe(true);
        expect(engine.isAgentValid("restricted")).toBe(true);
      });

      it("returns false for unknown agents", () => {
        expect(engine.isAgentValid("unknown")).toBe(false);
        expect(engine.isAgentValid("")).toBe(false);
      });
    });

    describe("getToolTarget", () => {
      it("returns 'gateway' for gateway-targeted tools", () => {
        expect(engine.getToolTarget("kv")).toBe("gateway");
      });

      it("returns 'sandbox' for sandbox-targeted tools", () => {
        expect(engine.getToolTarget("browser")).toBe("sandbox");
      });

      it("returns undefined for unknown tools", () => {
        expect(engine.getToolTarget("unknown")).toBeUndefined();
        expect(engine.getToolTarget("")).toBeUndefined();
      });
    });
  });

  describe("with minimal config (no tools)", () => {
    const config = createMinimalConfig();
    const engine = new PolicyEngine(config);

    it("denies all custom tools when none are configured", () => {
      expect(engine.isToolAllowed("assistant", "kv")).toBe(false);
      expect(engine.isToolAllowed("assistant", "browser")).toBe(false);
    });

    it("still recognizes core tools", () => {
      expect(engine.isCoreTool("read")).toBe(true);
      expect(engine.isCoreTool("write")).toBe(true);
      expect(engine.isCoreTool("patch")).toBe(true);
      expect(engine.isCoreTool("exec")).toBe(true);
    });

    it("returns undefined for tool targets when no tools configured", () => {
      expect(engine.getToolTarget("kv")).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("handles agent with empty tools array", () => {
      const config = createMinimalConfig({
        agents: {
          empty: {
            model: { provider: "anthropic", model: "claude" },
            tools: [],
          },
        },
      });
      const engine = new PolicyEngine(config);

      expect(engine.isToolAllowed("empty", "any-tool")).toBe(false);
    });

    it("handles tool names with special characters", () => {
      const config = createMinimalConfig({
        tools: {
          "my-custom-tool": { path: "/tools/my-custom-tool", target: "gateway" },
        },
        agents: {
          assistant: {
            model: { provider: "anthropic", model: "claude" },
            tools: ["my-custom-tool"],
          },
        },
      });
      const engine = new PolicyEngine(config);

      expect(engine.isToolAllowed("assistant", "my-custom-tool")).toBe(true);
      expect(engine.getToolTarget("my-custom-tool")).toBe("gateway");
    });
  });
});
