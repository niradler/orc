#!/usr/bin/env bun
import { readFileSync } from "node:fs";

type SessionStartEvent = {
  hook_event_name: "SessionStart";
  source?: "startup" | "compact";
};

async function main() {
  const raw = readFileSync("/dev/stdin", "utf-8");
  const event = JSON.parse(raw) as SessionStartEvent;

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
    const project = process.env.ORC_PROJECT;

    if (event.source === "compact") {
      const res = await fetch(`${apiBase}/mcp/tool`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "session_restore", args: { session_id: sessionId } }),
      });

      if (res.ok) {
        const { result } = (await res.json()) as { result: string };
        process.stdout.write(
          JSON.stringify({
            type: "inject_context",
            content: `<orc_session_context>\n${result}\n</orc_session_context>`,
          }),
        );
      }
    } else {
      const contextArgs: Record<string, string> = {};
      if (project) contextArgs.project = project;

      const res = await fetch(`${apiBase}/mcp/tool`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "context", args: contextArgs }),
      });

      if (res.ok) {
        const { result } = (await res.json()) as { result: string };
        process.stdout.write(
          JSON.stringify({
            type: "inject_context",
            content: `<orc_context>\n${result}\n</orc_context>`,
          }),
        );
      }
    }
  } catch {
    // API not running - passthrough
  }

  process.exit(0);
}

main();
