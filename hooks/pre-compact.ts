#!/usr/bin/env bun
import { readFileSync } from "node:fs";

async function main() {
  const raw = readFileSync("/dev/stdin", "utf-8");
  void raw;

  const sessionId = process.env.ORC_SESSION_ID ?? "default";
  const apiBase = process.env.ORC_API_BASE ?? "http://127.0.0.1:7700";

  try {
    const res = await fetch(`${apiBase}/mcp/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "session_snapshot", args: { session_id: sessionId } }),
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
  } catch {
    // MCP server not running — passthrough
  }

  process.exit(0);
}

main();
