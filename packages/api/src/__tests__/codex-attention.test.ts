import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { codexQuestionPending, readCodexQuestionPending } from "../sessions/codex-attention.js";

const line = (value: unknown) => JSON.stringify(value);
const call = line({
  type: "response_item",
  payload: { type: "function_call", name: "request_user_input", call_id: "q1" },
});
const reply = line({
  type: "response_item",
  payload: { type: "function_call_output", call_id: "q1" },
});

test("only an unanswered structured Codex question produces a notice", () => {
  expect(codexQuestionPending(call)).toBe(true);
  expect(
    codexQuestionPending(
      `${call}\n${line({ type: "response_item", payload: { type: "function_call_output", call_id: "other" } })}`,
    ),
  ).toBe(true);
  expect(codexQuestionPending(`${call}\n${reply}`)).toBe(false);
  expect(
    codexQuestionPending(
      `${call}\n${line({ type: "event_msg", payload: { type: "turn_aborted" } })}`,
    ),
  ).toBe(false);
  expect(codexQuestionPending(`${call}\n${line({ type: "turn_context" })}`)).toBe(false);
  expect(
    codexQuestionPending(
      line({
        type: "response_item",
        payload: { type: "function_call", name: "exec_command", call_id: "tool" },
      }),
    ),
  ).toBe(false);
  expect(codexQuestionPending("{partial\nordinary text")).toBe(false);
  expect(codexQuestionPending(`null\n42\n[]\n${call}`)).toBe(true);
});

test("a bounded transcript tail detects a question and removes it after the matching output", async () => {
  const root = mkdtempSync(join(tmpdir(), "orc-codex-attention-"));
  const transcript = join(root, "session.jsonl");
  writeFileSync(transcript, `${"x".repeat(300000)}\n${call}\n`);
  expect(await readCodexQuestionPending(hostRuntime(LOCAL_HOST), transcript)).toBe(true);
  writeFileSync(transcript, `${"x".repeat(300000)}\n${call}\n${reply}\n`);
  expect(await readCodexQuestionPending(hostRuntime(LOCAL_HOST), transcript)).toBe(false);
});
