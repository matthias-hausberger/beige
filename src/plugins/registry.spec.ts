import { describe, it, expect } from "vitest";
import { PluginRegistry } from "./registry.js";

describe("PluginRegistry", () => {
  describe("tool registration", () => {
    it("registers a tool with the same name as the plugin", () => {
      const registry = new PluginRegistry();
      registry.registerTool("git", {
        name: "git",
        description: "Git tool",
        handler: async () => ({ output: "", exitCode: 0 }),
      });
      expect(registry.getTool("git")).toBeDefined();
    });

    it("registers a dotted tool name", () => {
      const registry = new PluginRegistry();
      registry.registerTool("telegram", {
        name: "telegram.send_message",
        description: "Send message",
        handler: async () => ({ output: "", exitCode: 0 }),
      });
      expect(registry.getTool("telegram.send_message")).toBeDefined();
    });

    it("rejects tool names that don't start with plugin name", () => {
      const registry = new PluginRegistry();
      expect(() =>
        registry.registerTool("telegram", {
          name: "send_message",
          description: "Send message",
          handler: async () => ({ output: "", exitCode: 0 }),
        })
      ).toThrow("must equal the plugin name or start with 'telegram.'");
    });

    it("rejects duplicate tool names", () => {
      const registry = new PluginRegistry();
      registry.registerTool("git", {
        name: "git",
        description: "Git tool",
        handler: async () => ({ output: "", exitCode: 0 }),
      });
      expect(() =>
        registry.registerTool("git", {
          name: "git",
          description: "Another git",
          handler: async () => ({ output: "", exitCode: 0 }),
        })
      ).toThrow("already registered");
    });

    it("getAllTools returns all registered tools", () => {
      const registry = new PluginRegistry();
      registry.registerTool("git", {
        name: "git",
        description: "Git",
        handler: async () => ({ output: "", exitCode: 0 }),
      });
      registry.registerTool("telegram", {
        name: "telegram.send",
        description: "Send",
        handler: async () => ({ output: "", exitCode: 0 }),
      });
      expect(registry.getAllTools().size).toBe(2);
    });
  });

  describe("channel registration", () => {
    it("registers a channel", () => {
      const registry = new PluginRegistry();
      registry.registerChannel("telegram", {
        sendMessage: async () => {},
        supportsMessaging: () => true,
      });
      expect(registry.getChannel("telegram")).toBeDefined();
      expect(registry.hasChannel("telegram")).toBe(true);
    });

    it("rejects duplicate channels", () => {
      const registry = new PluginRegistry();
      registry.registerChannel("telegram", {
        sendMessage: async () => {},
        supportsMessaging: () => true,
      });
      expect(() =>
        registry.registerChannel("telegram", {
          sendMessage: async () => {},
          supportsMessaging: () => true,
        })
      ).toThrow("already registered");
    });
  });

  describe("hook registration and execution", () => {
    it("executes prePrompt hooks in order", async () => {
      const registry = new PluginRegistry();
      const order: string[] = [];

      registry.registerHook("plugin1", "prePrompt", async (event) => {
        order.push("plugin1");
        return { message: event.message + " [1]" };
      });
      registry.registerHook("plugin2", "prePrompt", async (event) => {
        order.push("plugin2");
        return { message: event.message + " [2]" };
      });

      const result = await registry.executePrePrompt({
        message: "hello",
        sessionKey: "test",
        agentName: "assistant",
        channel: "tui",
      });

      expect(order).toEqual(["plugin1", "plugin2"]);
      expect(result.message).toBe("hello [1] [2]");
    });

    it("prePrompt can block", async () => {
      const registry = new PluginRegistry();

      registry.registerHook("blocker", "prePrompt", async () => {
        return { message: "", block: true, reason: "blocked" };
      });
      registry.registerHook("never-called", "prePrompt", async (event) => {
        return { message: event.message + " should not run" };
      });

      const result = await registry.executePrePrompt({
        message: "hello",
        sessionKey: "test",
        agentName: "assistant",
        channel: "tui",
      });

      expect(result.block).toBe(true);
    });

    it("executes gatewayStarted hooks", async () => {
      const registry = new PluginRegistry();
      let called = false;

      registry.registerHook("test", "gatewayStarted", async () => {
        called = true;
      });

      await registry.executeGatewayStarted();
      expect(called).toBe(true);
    });
  });

  describe("skill registration", () => {
    it("registers a skill", () => {
      const registry = new PluginRegistry();
      registry.registerSkill("telegram", {
        name: "telegram-guide",
        path: "/path/to/skill",
        description: "Guide",
      });
      expect(registry.getSkill("telegram-guide")).toBeDefined();
    });
  });

  describe("createRegistrar", () => {
    it("creates a scoped registrar that enforces naming", () => {
      const registry = new PluginRegistry();
      const reg = registry.createRegistrar("myplugin");

      reg.tool({
        name: "myplugin",
        description: "My tool",
        handler: async () => ({ output: "", exitCode: 0 }),
      });

      expect(registry.getTool("myplugin")).toBeDefined();

      expect(() =>
        reg.tool({
          name: "other",
          description: "Wrong name",
          handler: async () => ({ output: "", exitCode: 0 }),
        })
      ).toThrow();
    });
  });
});
