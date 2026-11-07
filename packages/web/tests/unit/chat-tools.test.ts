import { expect, test } from "bun:test";
import { outputTail, parseApplyPatch, toolKey, toolView } from "../../src/lib/chat-tools";

const tool = (name: string, input: unknown, result?: string) => ({
  type: "tool" as const,
  id: name,
  name,
  input: typeof input === "string" ? input : JSON.stringify(input),
  ...(result === undefined ? {} : { result }),
});

test("should normalise tool names across agents and MCP prefixes", () => {
  expect(toolKey("Edit")).toBe("edit");
  expect(toolKey("mcp__orc__task_get")).toBe("task_get");
  expect(toolKey("MCP: Read")).toBe("read");
  expect(toolKey("functions.exec_command")).toBe("exec_command");
});

test("should turn Claude Edit and MultiEdit inputs into a compact diff", () => {
  const view = toolView(
    tool("Edit", { file_path: "src/a.ts", old_string: "one\ntwo\n", new_string: "one\n2\n3\n" }),
  );
  expect(view.kind).toBe("edit");
  if (view.kind !== "edit") return;
  expect(view.files).toHaveLength(1);
  expect(view.files[0]).toMatchObject({ path: "src/a.ts", added: 2, removed: 1 });
  expect(view.files[0]?.diff.split("\n")[0]).toMatch(/^@@ -1,2 \+1,3 @@$/);
  expect(view.files[0]?.diff).toContain("-two");
  expect(view.files[0]?.diff).toContain("+3");

  const multi = toolView(
    tool("MultiEdit", {
      file_path: "b.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d\ne" },
      ],
    }),
  );
  expect(multi.kind === "edit" && multi.files).toEqual([
    expect.objectContaining({ path: "b.ts", added: 3, removed: 2 }),
  ]);
});

test("should treat writes, OpenCode, Gemini and Codex file changes as edits", () => {
  const write = toolView(tool("Write", { file_path: "new.md", content: "a\nb\nc" }));
  expect(write.kind === "edit" && write.files[0]).toMatchObject({ added: 3, removed: 0 });
  const opencode = toolView(tool("edit", { filePath: "x.ts", oldString: "a", newString: "b" }));
  expect(opencode.kind === "edit" && opencode.files[0]?.path).toBe("x.ts");
  const gemini = toolView(tool("replace", { file_path: "g.ts", old_string: "a", new_string: "b" }));
  expect(gemini.kind).toBe("edit");
  const codex = toolView(
    tool("fileChange", [
      { path: "c.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n+c" },
      { path: "d.ts", kind: "add", diff: "@@ -0,0 +1 @@\n+d" },
    ]),
  );
  expect(codex.kind === "edit" && codex.files.map((file) => [file.path, file.added])).toEqual([
    ["c.ts", 2],
    ["d.ts", 1],
  ]);
});

test("should parse apply_patch envelopes per file", () => {
  const files = parseApplyPatch(
    [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@ function a",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+hello",
      "*** End Patch",
    ].join("\n"),
  );
  expect(files.map(({ path, added, removed }) => ({ path, added, removed }))).toEqual([
    { path: "src/a.ts", added: 1, removed: 1 },
    { path: "src/b.ts", added: 1, removed: 0 },
  ]);
  const view = toolView(tool("apply_patch", { input: "*** Update File: z.ts\n-a\n+b" }));
  expect(view.kind === "edit" && view.files[0]?.path).toBe("z.ts");
});

test("should show a command with a trimmed output tail", () => {
  const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
  const view = toolView(tool("Bash", { command: "bun test" }, `${output}\n\n`));
  expect(view).toEqual({
    kind: "command",
    command: "bun test",
    tail: Array.from({ length: 12 }, (_, index) => `line ${index + 19}`).join("\n"),
    hidden: 18,
  });
  expect(toolView(tool("command_execution", JSON.stringify("git status")))).toMatchObject({
    kind: "command",
    command: "git status",
    tail: "",
    hidden: 0,
  });
  expect(toolView(tool("shell", { command: ["git", "diff"] }))).toMatchObject({
    command: "git diff",
  });
  expect(outputTail("a\nb", 5)).toEqual({ tail: "a\nb", hidden: 0 });
});

test("should collapse reads and searches to one line target", () => {
  expect(toolView(tool("Read", { file_path: "src/a.ts" }))).toEqual({
    kind: "lookup",
    target: "src/a.ts",
  });
  expect(toolView(tool("Grep", { pattern: "foldTurn", path: "src" }))).toEqual({
    kind: "lookup",
    target: "foldTurn in src",
  });
  expect(toolView(tool("Glob", { pattern: "**/*.ts" }))).toEqual({
    kind: "lookup",
    target: "**/*.ts",
  });
  expect(toolView(tool("WebFetch", { url: "https://example.com" }))).toEqual({
    kind: "lookup",
    target: "https://example.com",
  });
});

test("should fall back to the generic view for unknown or unparseable tools", () => {
  expect(toolView(tool("task_get", { id: "1" }))).toEqual({ kind: "generic" });
  expect(toolView(tool("Edit", "not json"))).toEqual({ kind: "generic" });
  expect(toolView(tool("Bash", {}))).toEqual({ kind: "generic" });
  expect(toolView(tool("Read", {}))).toEqual({ kind: "generic" });
});
