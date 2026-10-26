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

describe("backend exit while a leftover child holds the pipes", () => {
  test.skipIf(!Bun.which("sh"))(
    "acpx reports the failure without waiting for the child",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "orc-acpx-leftover-"));
      // The trailing `#` swallows the arguments acpx appends; `sleep` keeps stdout/stderr open.
      const backend = ["sh", "-c", "sleep 6 & echo boom >&2; exit 3; #"];
      const session = new AcpxSession({ cwd }, backend, { kind: "local" });
      const started = Date.now();
      const events = await collect(session, "probe");
      expect(Date.now() - started).toBeLessThan(4500);
      expect(events).toEqual([{ type: "error", data: "acpx exited with code 3: boom" }]);
    },
  );
});

describe("a follow-up prompt sent right after a result", () => {
  const types = (events: AgentEvent[]) => events.map((event) => event.type);

  test("claude keeps the second turn alive while the first process exits", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-claude-followup-"));
    const session = new ClaudeSession({ cwd }, process.execPath, { kind: "local" });
    const first = `console.log(JSON.stringify({type:"result"}));setTimeout(()=>{},3000)`;
    const second = `setTimeout(()=>{console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"second"}]}}));console.log(JSON.stringify({type:"result"}))},300)`;
    expect(types(await collect(session, first))).toEqual(["result"]);
    const events = await collect(session, second);
    expect(events).toContainEqual({ type: "text", data: "second" });
    expect(types(events).at(-1)).toBe("result");
  });

  test("acpx does not end the second turn with the first process's exit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-acpx-followup-"));
    const script = join(cwd, "acpx.ts");
    // The prompt is the last argument: the first turn answers and lingers until killed.
    writeFileSync(
      script,
      `const result=()=>console.log(JSON.stringify({jsonrpc:"2.0",id:1,result:{stopReason:"end_turn"}}));
      if(process.argv.at(-1)==="first"){result();setTimeout(()=>{},3000)}else setTimeout(result,300)`,
    );
    const session = new AcpxSession({ cwd }, [process.execPath, script], { kind: "local" });
    expect(types(await collect(session, "first"))).toEqual(["result"]);
    expect(types(await collect(session, "second"))).toEqual(["result"]);
  });
});
