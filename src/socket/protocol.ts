import type { SessionContext } from "../types/session.js";

/**
 * Socket protocol between sandbox tool launchers and the gateway.
 * Messages are newline-delimited JSON over Unix domain socket.
 */

export interface ToolRequest {
  type: "tool_request";
  tool: string;
  args: string[];
  sessionContext?: SessionContext;
  /** Relative working directory from workspace root (optional) */
  cwd?: string;
}

export interface ToolResponse {
  type: "tool_response";
  success: boolean;
  output?: string;
  error?: string;
  exitCode: number;
}

export function encodeMessage(msg: ToolRequest | ToolResponse): Buffer {
  return Buffer.from(JSON.stringify(msg) + "\n");
}

export function decodeMessage(data: string): ToolRequest | ToolResponse {
  return JSON.parse(data.trim());
}
