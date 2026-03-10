import { describe, it, expect } from "vitest";
import {
  type ToolRequest,
  type ToolResponse,
  encodeMessage,
  decodeMessage,
} from "./protocol.js";

describe("protocol", () => {
  describe("encodeMessage", () => {
    it("encodes ToolRequest with newline suffix", () => {
      const msg: ToolRequest = {
        type: "tool_request",
        tool: "kv",
        args: ["set", "mykey", "myvalue"],
      };

      const encoded = encodeMessage(msg);
      expect(encoded.toString()).toBe(JSON.stringify(msg) + "\n");
    });

    it("encodes successful ToolResponse", () => {
      const msg: ToolResponse = {
        type: "tool_response",
        success: true,
        output: "OK",
        exitCode: 0,
      };

      const encoded = encodeMessage(msg);
      expect(encoded.toString()).toBe(JSON.stringify(msg) + "\n");
    });

    it("encodes error ToolResponse", () => {
      const msg: ToolResponse = {
        type: "tool_response",
        success: false,
        error: "Permission denied",
        exitCode: 1,
      };

      const encoded = encodeMessage(msg);
      expect(encoded.toString()).toBe(JSON.stringify(msg) + "\n");
    });

    it("encodes ToolResponse with all fields", () => {
      const msg: ToolResponse = {
        type: "tool_response",
        success: true,
        output: "result data",
        error: undefined,
        exitCode: 0,
      };

      const encoded = encodeMessage(msg);
      expect(encoded.toString()).toContain("tool_response");
      expect(encoded.toString()).toContain("result data");
    });

    it("returns a Buffer", () => {
      const msg: ToolRequest = {
        type: "tool_request",
        tool: "test",
        args: [],
      };

      const encoded = encodeMessage(msg);
      expect(encoded).toBeInstanceOf(Buffer);
    });
  });

  describe("decodeMessage", () => {
    it("decodes ToolRequest", () => {
      const json = '{"type":"tool_request","tool":"kv","args":["get","key"]}';
      const msg = decodeMessage(json) as ToolRequest;

      expect(msg.type).toBe("tool_request");
      expect(msg.tool).toBe("kv");
      expect(msg.args).toEqual(["get", "key"]);
    });

    it("decodes successful ToolResponse", () => {
      const json = '{"type":"tool_response","success":true,"output":"value","exitCode":0}';
      const msg = decodeMessage(json) as ToolResponse;

      expect(msg.type).toBe("tool_response");
      expect(msg.success).toBe(true);
      expect(msg.output).toBe("value");
      expect(msg.exitCode).toBe(0);
    });

    it("decodes error ToolResponse", () => {
      const json = '{"type":"tool_response","success":false,"error":"Not found","exitCode":1}';
      const msg = decodeMessage(json) as ToolResponse;

      expect(msg.type).toBe("tool_response");
      expect(msg.success).toBe(false);
      expect(msg.error).toBe("Not found");
      expect(msg.exitCode).toBe(1);
    });

    it("handles whitespace in input", () => {
      const json = '  {"type":"tool_request","tool":"test","args":[]}  ';
      const msg = decodeMessage(json) as ToolRequest;

      expect(msg.type).toBe("tool_request");
      expect(msg.tool).toBe("test");
    });

    it("throws on invalid JSON", () => {
      expect(() => decodeMessage("not json")).toThrow();
    });
  });

  describe("roundtrip encode/decode", () => {
    it("roundtrips ToolRequest with empty args", () => {
      const original: ToolRequest = {
        type: "tool_request",
        tool: "status",
        args: [],
      };

      const encoded = encodeMessage(original);
      const decoded = decodeMessage(encoded.toString().trim()) as ToolRequest;

      expect(decoded).toEqual(original);
    });

    it("roundtrips ToolRequest with multiple args", () => {
      const original: ToolRequest = {
        type: "tool_request",
        tool: "kv",
        args: ["set", "key1", "value with spaces", "more"],
      };

      const encoded = encodeMessage(original);
      const decoded = decodeMessage(encoded.toString().trim()) as ToolRequest;

      expect(decoded).toEqual(original);
    });

    it("roundtrips ToolResponse with special characters in output", () => {
      const original: ToolResponse = {
        type: "tool_response",
        success: true,
        output: "Line 1\nLine 2\tTabbed \"quoted\"",
        exitCode: 0,
      };

      const encoded = encodeMessage(original);
      const decoded = decodeMessage(encoded.toString().trim()) as ToolResponse;

      expect(decoded).toEqual(original);
    });

    it("roundtrips ToolResponse with unicode", () => {
      const original: ToolResponse = {
        type: "tool_response",
        success: true,
        output: "Hello 🌍 世界",
        exitCode: 0,
      };

      const encoded = encodeMessage(original);
      const decoded = decodeMessage(encoded.toString().trim()) as ToolResponse;

      expect(decoded).toEqual(original);
    });
  });
});
