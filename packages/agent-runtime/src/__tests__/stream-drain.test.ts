import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpxSession } from "../acpx.js";
import { ClaudeSession } from "../claude.js";
import type { AgentEvent, AgentSession } from "../types.js";

// Closes stdout first, then reports the failure on stderr and exits non-zero.
const FAIL_AFTER_STDOUT_CLOSES =
  "require('node:fs').closeSync(1);setTimeout(()=>{console.error('backend exploded');process.exit(3)},100)";

async function collect(session: AgentSession, prompt: string): Promise<AgentEvent[]> {
  await session.send(prompt);
  const events: AgentEvent[] = [];
  for await (const event of session.events()) events.push(event);
  return events;
}

describe("backend exit after stdout closes", () => {
  test("claude reports the failure instead of ending the turn silently", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-claude-drain-"));
    // `bun -p <prompt>` evaluates the prompt, standing in for the claude binary.
    const session = new ClaudeSession({ cwd }, process.execPath, { kind: "local" });
    const events = await collect(session, FAIL_AFTER_STDOUT_CLOSES);
    expect(events).toEqual([{ type: "error", data: "backend exploded" }]);
  });

  test("acpx reports the failure instead of synthesising an empty result", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-acpx-drain-"));
    const script = join(cwd, "acpx.ts");
    writeFileSync(script, FAIL_AFTER_STDOUT_CLOSES);
    const session = new AcpxSession({ cwd }, [process.execPath, script], { kind: "local" });
    const events = await collect(session, "probe");
    expect(events).toEqual([{ type: "error", data: "acpx exited with code 3: backend exploded" }]);
  });
});
