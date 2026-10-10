import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentTokens, evaluateRules, type RuleEvent, RulePolicySchema } from "../rules.js";

const root = mkdtempSync(join(tmpdir(), "orc-rules-core-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const event = (tool: string, input: Record<string, unknown> = {}): RuleEvent => ({
  id: "one",
  session_id: "session",
  backend: "test",
  cwd: root,
  phase: "pre_tool",
  tool,
  input,
  failed: false,
});
const policy = (kind: "deny_comments" | "deny_delete") =>
  RulePolicySchema.parse({
    workspace: root,
    project_id: null,
    rules: [{ id: "guard", kind, reason: "Project rule" }],
  });

describe("deterministic rules", () => {
  test("control storage, hook settings and directory links cannot bypass file guards", () => {
    mkdirSync(join(root, ".orc"));
    mkdirSync(join(root, ".cursor"));
    mkdirSync(join(root, "plain-directory"));
    symlinkSync(
      join(root, ".orc"),
      join(root, "linked-control"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const toolPolicy = RulePolicySchema.parse({
      workspace: root,
      project_id: null,
      rules: [{ id: "tools", kind: "deny_tools", tools: ["Bash"], reason: "No shell" }],
    });
    for (const path of [
      ".orc/config.json",
      ".cursor/hooks.json",
      "linked-control/policy.json",
      "linked-control/nested/config.json",
    ])
      for (const guardedPolicy of [policy("deny_delete"), toolPolicy])
        expect(
          evaluateRules(guardedPolicy, event("Write", { path: join(root, path), content: "{}" }))
            .decision,
        ).toBe("deny");
    const dbPath = join(root, "custom-storage.db");
    expect(
      evaluateRules(policy("deny_delete"), event("Write", { path: dbPath, content: "" }), [dbPath])
        .decision,
    ).toBe("deny");
    expect(
      evaluateRules(
        policy("deny_delete"),
        event("Write", { path: join(root, "plain-directory"), content: "" }),
      ).decision,
    ).toBe("deny");
  });
  test("blocks unmediated shell, delete, rename, subagent and arbitrary MCP tools", () => {
    for (const tool of [
      "Bash",
      "run_shell_command",
      "Delete",
      "Rename",
      "Task",
      "mcp__other__mutate",
      "unknown",
    ])
      expect(evaluateRules(policy("deny_delete"), event(tool)).decision).toBe("deny");
    expect(evaluateRules(policy("deny_delete"), event("Read")).decision).toBe("abstain");
    expect(
      evaluateRules(
        policy("deny_delete"),
        event("Write", { file_path: join(root, "safe.ts"), content: "const x=1;" }),
      ).decision,
    ).toBe("abstain");
    expect(
      evaluateRules(
        policy("deny_delete"),
        event("Write", { file_path: join(root, "..", "outside.ts"), content: "" }),
      ).decision,
    ).toBe("deny");
  });
  test("denies added comments and preserves existing comments and ordinary edits", () => {
    const path = join(root, "code.ts");
    writeFileSync(path, "// existing\nexport const x = 1;\n");
    expect(
      evaluateRules(
        policy("deny_comments"),
        event("Edit", { file_path: path, old_string: "x = 1", new_string: "x = 2" }),
      ).decision,
    ).toBe("abstain");
    expect(
      evaluateRules(
        policy("deny_comments"),
        event("Edit", { file_path: path, old_string: "x = 1", new_string: "x = 2; // added" }),
      ).decision,
    ).toBe("deny");
    expect(
      evaluateRules(
        policy("deny_comments"),
        event("Write", { file_path: path, content: "// existing\n// existing\nconst x=1;" }),
      ).decision,
    ).toBe("deny");
    expect(
      evaluateRules(
        policy("deny_comments"),
        event("Write", { file_path: path, content: "// changed\nconst x=1;" }),
      ).decision,
    ).toBe("deny");
  });
  test("strings, regexes, templates and JSX text are not comments", () => {
    expect(
      commentTokens(
        "code.ts",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source code under test
        'const a="https://example.com"; const b=/https?:\\/\\//; const c=`literal // ${"/* string */"} tail /* ok */`;',
      ),
    ).toEqual([]);
    expect(commentTokens("code.tsx", "const x=<div>https://example.com /* text */</div>;")).toEqual(
      [],
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source code under test
    expect(commentTokens("code.ts", "const x=`literal ${1 /* actual */} end`;")).toEqual([
      "/* actual */",
    ]);
  });
  test("unknown languages and invalid or ambiguous edit payloads fail closed", () => {
    const path = join(root, "bad.ts");
    writeFileSync(path, "const x=1; const x=1;");
    expect(
      evaluateRules(
        policy("deny_comments"),
        event("Write", { file_path: join(root, "code.py"), content: "x=1" }),
      ).decision,
    ).toBe("deny");
    expect(
      evaluateRules(
        policy("deny_comments"),
        event("Write", { file_path: path, content: "const x = ;" }),
      ).decision,
    ).toBe("deny");
    expect(
      evaluateRules(
        policy("deny_comments"),
        event("Edit", { file_path: path, old_string: "x=1", new_string: "x=2" }),
      ).decision,
    ).toBe("deny");
    expect(
      evaluateRules(policy("deny_comments"), event("apply_patch", { patch: "anything" })).decision,
    ).toBe("deny");
  });
  test("project rules only match descendant workspaces; duplicate IDs and extra keys fail", () => {
    mkdirSync(join(root, "child"));
    expect(
      evaluateRules(policy("deny_delete"), { ...event("Bash"), cwd: join(root, "child") }).decision,
    ).toBe("deny");
    expect(evaluateRules(policy("deny_delete"), { ...event("Bash"), cwd: tmpdir() }).decision).toBe(
      "abstain",
    );
    expect(RulePolicySchema.safeParse({ ...policy("deny_delete"), surprise: true }).success).toBe(
      false,
    );
    expect(
      RulePolicySchema.safeParse({
        ...policy("deny_delete"),
        rules: [policy("deny_delete").rules[0], policy("deny_delete").rules[0]],
      }).success,
    ).toBe(false);
  });
});
