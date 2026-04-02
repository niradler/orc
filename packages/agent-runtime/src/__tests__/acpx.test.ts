import { describe, expect, it } from "bun:test";
import { parseAcpxLine } from "../acpx.js";

describe("parseAcpxLine", () => {
  it("returns null for malformed JSON", () => {
    expect(parseAcpxLine("not json")).toBeNull();
    expect(parseAcpxLine("")).toBeNull();
    expect(parseAcpxLine("{broken")).toBeNull();
  });

  it("parses error messages", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", error: { message: "something broke" } });
    const event = parseAcpxLine(line);
    expect(event).toEqual({ type: "error", data: "something broke" });
  });

  it("parses error with missing message", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", error: {} });
    const event = parseAcpxLine(line);
    expect(event).toEqual({ type: "error", data: "ACPX error" });
  });

  it("parses result with stopReason", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50 } },
    });
    const event = parseAcpxLine(line);
    expect(event?.type).toBe("result");
    expect((event?.data as Record<string, unknown>).usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("returns null for result without stopReason or usage", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "abc" } });
    expect(parseAcpxLine(line)).toBeNull();
  });

  it("parses text content from agent_message_chunk", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello world" },
        },
      },
    });
    const event = parseAcpxLine(line);
    expect(event).toEqual({ type: "text", data: "Hello world" });
  });

  it("parses thinking content from agent_message_chunk", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "thinking", text: "Let me think..." },
        },
      },
    });
    const event = parseAcpxLine(line);
    expect(event).toEqual({ type: "thinking", data: "Let me think..." });
  });

  it("returns null for agent_message_chunk with empty content", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: null } },
    });
    expect(parseAcpxLine(line)).toBeNull();
  });

  it("parses tool_call event", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-123",
          title: "ReadFile",
          rawInput: { path: "/tmp/test.ts" },
          _meta: { claudeCode: { toolName: "Read" } },
        },
      },
    });
    const event = parseAcpxLine(line);
    expect(event?.type).toBe("tool_use");
    const data = event?.data as Record<string, unknown>;
    expect(data.id).toBe("tc-123");
    expect(data.name).toBe("Read");
    expect(JSON.parse(data.input)).toEqual({ path: "/tmp/test.ts" });
  });

  it("uses title as fallback tool name", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-456",
          title: "Bash",
          rawInput: "ls -la",
        },
      },
    });
    const event = parseAcpxLine(line);
    const data = event?.data as Record<string, unknown>;
    expect(data.name).toBe("Bash");
    expect(data.input).toBe("ls -la");
  });

  it("parses tool_call_update (completed)", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          status: "completed",
          toolCallId: "tc-123",
          rawOutput: "file contents here",
          _meta: { claudeCode: { toolResponse: { stdout: "stdout", stderr: "" } } },
        },
      },
    });
    const event = parseAcpxLine(line);
    expect(event?.type).toBe("tool_result");
    const data = event?.data as Record<string, unknown>;
    expect(data.toolUseId).toBe("tc-123");
    expect(data.content).toBe("file contents here");
    expect(data.isError).toBe(false);
  });

  it("detects error from stderr in tool_call_update", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          status: "completed",
          toolCallId: "tc-789",
          _meta: { claudeCode: { toolResponse: { stdout: "output", stderr: "error happened" } } },
        },
      },
    });
    const event = parseAcpxLine(line);
    const data = event?.data as Record<string, unknown>;
    expect(data.isError).toBe(true);
    expect(data.content).toBe("output");
  });

  it("ignores tool_call_update that is not completed", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: { sessionUpdate: "tool_call_update", status: "running", toolCallId: "tc-999" },
      },
    });
    expect(parseAcpxLine(line)).toBeNull();
  });

  it("ignores unknown session/update types", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "unknown_type" } },
    });
    expect(parseAcpxLine(line)).toBeNull();
  });

  it("ignores non session/update methods", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", method: "session/start", params: {} });
    expect(parseAcpxLine(line)).toBeNull();
  });
});
