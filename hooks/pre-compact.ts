#!/usr/bin/env bun
import { readFileSync } from "node:fs";

async function main() {
  const raw = readFileSync("/dev/stdin", "utf-8");
  void raw;

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
      body: JSON.stringify({ name: "session_snapshot", args: { session_id: sessionId } }),
    });
  } catch {
    // API not running — passthrough silently
  }

  process.exit(0);
}

main();
