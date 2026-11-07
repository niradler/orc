import { expect, test } from "bun:test";
import { ClaudeSession } from "../claude.js";
import type { AgentEvent } from "../types.js";

test("should preserve Claude's reported turn duration in the normalized result", async () => {
  const session = new ClaudeSession({ cwd: process.cwd() }, process.execPath, { kind: "local" });
  try {
    await session.send(
      'console.log(JSON.stringify({type:"result",session_id:"timed-turn",duration_ms:42000}))',
    );
    const events: AgentEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(events).toContainEqual({
      type: "result",
      data: { runtimeSessionId: "timed-turn", usage: undefined, durationMs: 42_000 },
    });
  } finally {
    await session.close();
  }
});
