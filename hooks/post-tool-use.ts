#!/usr/bin/env bun
import { readFileSync } from "node:fs";

type HookEvent = {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: { content?: string; error?: string };
};

function classify(event: HookEvent): { type: string; priority: number; data: Record<string, string> } | null {
  const tool = event.tool_name ?? "";
  const input = event.tool_input ?? {};
  const response = event.tool_response ?? {};

  if (["Write", "Edit", "StrReplace", "EditNotebook"].includes(tool)) {
    return {
      type: "file",
      priority: 1,
      data: { tool, path: String(input["path"] ?? input["target_notebook"] ?? "") },
    };
  }

  if (tool === "Shell" || tool === "Bash") {
    const cmd = String(input["command"] ?? "");
    if (/^git\s/.test(cmd)) {
      return { type: "git", priority: 2, data: { cmd: cmd.slice(0, 80) } };
    }
    if (response.error ?? (String(response.content ?? "").includes("exit code"))) {
      return { type: "error", priority: 2, data: { cmd: cmd.slice(0, 80), err: String(response.error ?? "").slice(0, 120) } };
    }
    return null;
  }

  if (tool.startsWith("TodoWrite") || tool.startsWith("todo")) {
    return { type: "task", priority: 1, data: { raw: JSON.stringify(input).slice(0, 200) } };
  }

  return null;
}

async function main() {
  const raw = readFileSync("/dev/stdin", "utf-8");
  const event = JSON.parse(raw) as HookEvent;
  const classified = classify(event);
  if (!classified) process.exit(0);

  const { type, priority, data } = classified;
  const sessionId = process.env.ORC_SESSION_ID ?? "default";
  const apiBase = process.env.ORC_API_BASE ?? "http://127.0.0.1:7700";

  try {
    await fetch(`${apiBase}/mcp/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "session_event",
        args: { type, priority, data: { ...data, session_id: sessionId } },
      }),
    });
  } catch {
    // MCP server not running — silently skip
  }

  process.exit(0);
}

main();
