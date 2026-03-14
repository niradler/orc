#!/usr/bin/env bun
import { readFileSync } from "node:fs";

type HookEvent = {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: { content?: string; error?: string };
};

const CLAUDE_FILE_TOOLS = new Set(["Write", "Edit", "StrReplace", "EditNotebook"]);
const CODEX_FILE_TOOLS = new Set(["write_file", "create_file", "str_replace", "apply_patch"]);
const SHELL_TOOLS = new Set(["Shell", "Bash", "shell"]);
const TODO_TOOLS = new Set(["TodoWrite", "todo_write"]);

function classify(
  event: HookEvent,
): { type: string; priority: number; data: Record<string, string> } | null {
  const tool = event.tool_name ?? "";
  const input = event.tool_input ?? {};
  const response = event.tool_response ?? {};

  if (CLAUDE_FILE_TOOLS.has(tool) || CODEX_FILE_TOOLS.has(tool)) {
    const path = String(input.path ?? input.target_notebook ?? input.file_path ?? "");
    return { type: "file", priority: 1, data: { tool, path } };
  }

  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(input.command ?? input.cmd ?? "");
    if (/^git\s/.test(cmd)) {
      return { type: "git", priority: 2, data: { cmd: cmd.slice(0, 80) } };
    }
    if (
      /^(npm|pnpm|bun|pip|uv|cargo)\s+(install|add|remove)/.test(cmd) ||
      /^export\s+\w+=/.test(cmd)
    ) {
      const safe = cmd.replace(/export\s+(\w+)=\S+/g, "export $1=***");
      return { type: "env", priority: 2, data: { cmd: safe.slice(0, 80) } };
    }
    const hasError =
      response.error ??
      String(response.content ?? "").includes("exit code") ??
      String(response.content ?? "").includes("Error:");
    if (hasError) {
      return {
        type: "error",
        priority: 2,
        data: { cmd: cmd.slice(0, 80), err: String(response.error ?? "").slice(0, 120) },
      };
    }
    return null;
  }

  if (TODO_TOOLS.has(tool)) {
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

  const sessionId =
    process.env.ORC_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID ??
    process.env.CODEX_SESSION_ID ??
    "default";

  const apiBase = process.env.ORC_API_BASE ?? "http://127.0.0.1:7700";
  const secret = process.env.ORC_API_SECRET;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;

  try {
    await fetch(`${apiBase}/mcp/tool`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "session_event",
        args: { session_id: sessionId, type, priority, data },
      }),
    });
  } catch {
    // API not running — silently skip
  }

  process.exit(0);
}

main();
