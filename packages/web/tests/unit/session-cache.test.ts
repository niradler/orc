import { expect, test } from "bun:test";
import {
  CONTEXT_HINT_TOKENS,
  chatContextHint,
  sessionCacheIndicator,
} from "../../src/lib/session-cache";

test("cache indicator changes at the evidence-based time boundary without changing historical cache usage", () => {
  const latest = {
    input_tokens: 100,
    cached_input_tokens: 80,
    cache_write_tokens: 20,
    recorded_at: "2026-11-06T12:00:00Z",
    may_be_cold_after: "2026-11-06T12:05:00Z",
  };
  expect(sessionCacheIndicator(latest, Date.parse("2026-11-06T12:04:59Z"))).toEqual({
    label: "80% cached input",
    cold: false,
  });
  expect(sessionCacheIndicator(latest, Date.parse("2026-11-06T12:05:00Z"))).toEqual({
    label: "Cache may need rebuilding · 80% last reported",
    cold: true,
  });
  expect(
    sessionCacheIndicator(
      { ...latest, may_be_cold_after: null },
      Date.parse("2027-01-01T00:00:00Z"),
    ),
  ).toEqual({ label: "80% cached input", cold: false });
  expect(sessionCacheIndicator(null, Date.now())).toBeNull();
  expect(
    sessionCacheIndicator({ ...latest, input_tokens: 0, cached_input_tokens: 0 }, Date.now()),
  ).toBeNull();
});

const request = (input_tokens: number) => ({
  input_tokens,
  cached_input_tokens: Math.round(input_tokens * 0.8),
  cache_write_tokens: 0,
  recorded_at: "2026-11-06T12:00:00Z",
  may_be_cold_after: null,
});

test("composer hint appears only for a genuinely large recorded request", () => {
  expect(CONTEXT_HINT_TOKENS).toBe(150_000);
  expect(chatContextHint(null, "claude")).toBeNull();
  expect(chatContextHint(undefined, "claude")).toBeNull();
  expect(chatContextHint(request(CONTEXT_HINT_TOKENS - 1), "claude")).toBeNull();
  expect(chatContextHint(request(0), "claude")).toBeNull();
  expect(chatContextHint(request(CONTEXT_HINT_TOKENS), "claude")).not.toBeNull();
});

test("composer hint names the agent's own compaction control and never a window share", () => {
  const hint = (agent: string) =>
    chatContextHint(request(182_000), agent) ?? { text: "", note: "" };

  // Claude compacts internally; ORC can still request a manual compaction.
  expect(hint("claude").text).toBe(
    "182k tokens of context · Claude Code compacts automatically on its own · Compact summarizes now",
  );
  expect(hint("claude").note).toContain("decides when to compact internally");
  expect(hint("claude").note).toContain("Compact in the session actions");

  // Codex and Pi name the agent option that controls automatic compaction.
  expect(hint("codex").text).toBe(
    "182k tokens of context · Codex compacts automatically (model_auto_compact_token_limit) · Compact summarizes now",
  );
  expect(hint("codex").note).toContain("model_auto_compact_token_limit agent option");
  expect(hint("pi").text).toBe(
    "182k tokens of context · Pi compacts automatically (autoCompaction) · Compact summarizes now",
  );
  expect(hint("pi").note).toContain("autoCompaction agent option");

  // OpenCode has no manual action, so the hint says the agent keeps control.
  expect(hint("opencode").text).toBe(
    "182k tokens of context · OpenCode compacts automatically on its own · no manual compaction in ORC",
  );
  expect(hint("opencode").note).toContain("Manual compaction is not available for this agent");

  // A generic ACP agent never exposes its policy; ORC does not guess one.
  expect(hint("cursor").text).toBe(
    "182k tokens of context · ORC does not know when Cursor compacts · no manual compaction in ORC",
  );
  expect(hint("cursor").note).toContain("does not expose its compaction policy");

  // A size, never a percentage of a context window ORC does not know.
  for (const agent of ["claude", "codex", "pi", "opencode"]) {
    expect(hint(agent).text).not.toContain("%");
    expect(hint(agent).text).toContain("182k tokens of context");
  }
});
