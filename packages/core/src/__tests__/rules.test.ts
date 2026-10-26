import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRuleTemplate } from "../rule-catalog.js";
import { evaluateRules, type RuleEvent, RulePolicySchema } from "../rules.js";

const root = mkdtempSync(join(tmpdir(), "orc-rules-core-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const policy = RulePolicySchema.parse({
  workspace: root,
  project_id: null,
  rules: [copyRuleTemplate("block-command-pattern")],
});
function event(tool: string, input: Record<string, unknown> = {}): RuleEvent {
  return {
    id: "one",
    session_id: "session",
    backend: "claude",
    cwd: root,
    phase: "pre_tool",
    tool,
    input,
    failed: false,
  };
}
test("should keep platform policy storage and hook settings protected through directory aliases", () => {
  mkdirSync(join(root, ".orc"));
  mkdirSync(join(root, ".cursor"));
  symlinkSync(
    join(root, ".orc"),
    join(root, "linked-control"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const path of [
    ".orc/config.json",
    ".cursor/hooks.json",
    "linked-control/policy.json",
    "linked-control/nested/config.json",
  ]) {
    const result = evaluateRules(
      policy,
      event("Write", { file_path: join(root, path), content: "{}" }),
    );
    expect(result.decision).toBe("deny");
    expect(result.reasons[0]?.rule_id).toBe("orc-control-settings");
  }
  const dbPath = join(root, "custom-storage.db");
  expect(
    evaluateRules(policy, event("Write", { file_path: dbPath, content: "" }), [dbPath]).reasons[0]
      ?.rule_id,
  ).toBe("orc-control-storage");
});
test("should let agents edit inside ORC worktrees while keeping their control files protected", () => {
  const worktree = join(root, ".orc", "worktrees", "wt0001");
  mkdirSync(worktree, { recursive: true });
  const decide = (path: string) =>
    evaluateRules(policy, { ...event("Edit", { file_path: path }), cwd: worktree });
  expect(decide(join(worktree, "src", "app.ts")).decision).toBe("abstain");
  expect(decide(join(worktree, "src", "app.ts")).reasons).toEqual([]);
  for (const path of [
    join(worktree, ".orc", "config.json"),
    join(worktree, ".claude", "settings.json"),
    join(worktree, "..", "..", "config.json"),
    join(root, ".orc", "worktrees", "stray.json"),
  ]) {
    expect(decide(path).reasons[0]?.rule_id).toBe("orc-control-settings");
  }
});
test("should block exactly the selected tool and command text without implying deletion coverage", () => {
  for (const command of ["rm -rf build", "echo 'rm -rf build'"])
    expect(evaluateRules(policy, event("Bash", { command })).decision).toBe("deny");
  for (const command of [
    "rm -fr build",
    "rm -r -f build",
    `python -c "__import__('os').unlink('x')"`,
    "Remove-Item build",
    "git status",
  ]) {
    expect(evaluateRules(policy, event("Bash", { command })).decision).toBe("abstain");
  }
  expect(evaluateRules(policy, event("PowerShell", { command: "rm -rf build" })).decision).toBe(
    "abstain",
  );
  expect(
    evaluateRules(
      policy,
      event("Write", { file_path: join(root, "ordinary.ts"), content: "// comment" }),
    ).decision,
  ).toBe("abstain");
  expect(
    evaluateRules(policy, { ...event("Bash", { command: "rm -rf build" }), phase: "post_tool" })
      .decision,
  ).toBe("abstain");
});
test("should respect enabled state, agent scope, directory boundaries and strict rule shape", () => {
  const rule = copyRuleTemplate("block-command-pattern");
  rule.enabled = false;
  expect(
    evaluateRules({ ...policy, rules: [rule] }, event("Bash", { command: "rm -rf build" }))
      .decision,
  ).toBe("abstain");
  expect(
    evaluateRules(policy, { ...event("Bash", { command: "rm -rf build" }), cwd: tmpdir() })
      .decision,
  ).toBe("abstain");
  expect(RulePolicySchema.safeParse({ ...policy, surprise: true }).success).toBe(false);
  expect(RulePolicySchema.safeParse({ ...policy, rules: [rule, rule] }).success).toBe(false);
  for (const kind of ["deny_delete", "deny_comments", "deny_tools", "context", "enqueue_job"]) {
    expect(
      RulePolicySchema.safeParse({ ...policy, rules: [{ id: "old", kind, reason: "Old rule" }] })
        .success,
    ).toBe(false);
  }
});
test("should expose comment-marker text matching and its false positives instead of an implicit language checker", () => {
  const comments = { ...policy, rules: [copyRuleTemplate("block-write-comment-markers")] };
  for (const content of ["// added", "const url = 'https://example.com';", "/* added */"]) {
    expect(
      evaluateRules(comments, event("Write", { file_path: join(root, "code.ts"), content }))
        .decision,
    ).toBe("deny");
  }
  expect(
    evaluateRules(
      comments,
      event("Write", { file_path: join(root, "code.ts"), content: "const x = 1;" }),
    ).decision,
  ).toBe("abstain");
  expect(
    evaluateRules(
      comments,
      event("Edit", { file_path: join(root, "code.ts"), new_string: "// added" }),
    ).decision,
  ).toBe("abstain");
  expect(
    evaluateRules(
      comments,
      event("Write", { file_path: join(root, "notes.md"), content: "// note" }),
    ).decision,
  ).toBe("abstain");
});
