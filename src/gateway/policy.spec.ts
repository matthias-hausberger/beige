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
        expect(engine.isCoreTool("git")).toBe(false);
        expect(engine.isCoreTool("chrome")).toBe(false);
      });
    });

    describe("isToolAllowed", () => {
      it("allows tools listed in agent config", () => {
        expect(engine.isToolAllowed("assistant", "git")).toBe(true);
      });

      it("denies tools not listed in agent config", () => {
        expect(engine.isToolAllowed("assistant", "chrome")).toBe(false);
      });

      it("denies all tools for restricted agent", () => {
        expect(engine.isToolAllowed("restricted", "git")).toBe(false);
        expect(engine.isToolAllowed("restricted", "chrome")).toBe(false);
      });

      it("allows multiple tools for researcher agent", () => {
        expect(engine.isToolAllowed("researcher", "git")).toBe(true);
        expect(engine.isToolAllowed("researcher", "chrome")).toBe(true);
      });

      it("denies tools for unknown agents", () => {
        expect(engine.isToolAllowed("unknown-agent", "git")).toBe(false);
      });
    });

    describe("isAgentValid", () => {
      it("returns true for configured agents", () => {
        expect(engine.isAgentValid("assistant")).toBe(true);
        expect(engine.isAgentValid("researcher")).toBe(true);
      });

      it("returns false for unknown agents", () => {
        expect(engine.isAgentValid("unknown")).toBe(false);
      });
    });

    describe("getToolTarget", () => {
      it("returns 'gateway' for plugin-registered tools", () => {
        expect(engine.getToolTarget("git")).toBe("gateway");
      });

      it("returns 'gateway' for dotted plugin tools", () => {
        // A tool like git.status resolves to plugin "git"
        expect(engine.getToolTarget("git.status")).toBe("gateway");
      });

      it("returns undefined for unknown tools", () => {
        expect(engine.getToolTarget("nonexistent")).toBeUndefined();
      });
    });
  });

  describe("with minimal config", () => {
    const config = createMinimalConfig();
    const engine = new PolicyEngine(config);

    it("allows core tools for configured agents", () => {
      expect(engine.isCoreTool("read")).toBe(true);
      expect(engine.isCoreTool("write")).toBe(true);
      expect(engine.isCoreTool("patch")).toBe(true);
      expect(engine.isCoreTool("exec")).toBe(true);
    });

    it("returns undefined for tool targets when no plugins configured", () => {
      expect(engine.getToolTarget("git")).toBeUndefined();
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

    it("handles plugin names with special characters", () => {
      const config = createMinimalConfig({
        plugins: {
          "my-custom-plugin": { path: "/plugins/my-custom-plugin" },
        },
        agents: {
          assistant: {
            model: { provider: "anthropic", model: "claude" },
            tools: ["my-custom-plugin"],
          },
        },
      });
      const engine = new PolicyEngine(config);

      expect(engine.isToolAllowed("assistant", "my-custom-plugin")).toBe(true);
      expect(engine.getToolTarget("my-custom-plugin")).toBe("gateway");
    });
  });
});
