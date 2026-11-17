import { expect, test } from "bun:test";
import {
  MAX_TOOL_IMAGE_BYTES,
  outputTail,
  parseApplyPatch,
  pullRequestLinks,
  resultBranch,
  resultFiles,
  stripInlineImages,
  toolDetail,
  toolImages,
  toolKey,
  toolOrigin,
  toolView,
} from "../../src/lib/chat-tools";

const tool = (name: string, input: unknown, result?: string) => ({
  type: "tool" as const,
  id: name,
  name,
  input: typeof input === "string" ? input : JSON.stringify(input),
  ...(result === undefined ? {} : { result }),
});

const png = "cG5n";

test("should normalise tool names across agents and MCP prefixes", () => {
  expect(toolKey("Edit")).toBe("edit");
  expect(toolKey("mcp__orc__task_get")).toBe("task_get");
  expect(toolKey("MCP: Read")).toBe("read");
  expect(toolKey("functions.exec_command")).toBe("exec_command");
  expect(toolOrigin("mcp__orc__task_get")).toEqual({
    key: "task_get",
    server: "orc",
    mcp: true,
  });
  expect(toolOrigin("Read")).toEqual({ key: "read", mcp: false });
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

test("should read writes, OpenCode, Gemini and Codex file changes", () => {
  const write = toolView(tool("Write", { file_path: "new.md", content: "a\nb\nc" }));
  expect(write.kind).toBe("write");
  expect(write.kind === "write" && write.files[0]).toMatchObject({
    path: "new.md",
    added: 3,
    removed: 0,
    created: true,
  });
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
  expect(
    files.map(({ path, added, removed, created }) => ({ path, added, removed, created })),
  ).toEqual([
    { path: "src/a.ts", added: 1, removed: 1, created: undefined },
    { path: "src/b.ts", added: 1, removed: 0, created: true },
  ]);
  const view = toolView(tool("apply_patch", { input: "*** Update File: z.ts\n-a\n+b" }));
  expect(view.kind === "edit" && view.files[0]?.path).toBe("z.ts");
});

test("should show a command with a trimmed output tail", () => {
  const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
  const view = toolView(tool("Bash", { command: "bun test" }, `${output}\n\n`));
  expect(view).toEqual({
    kind: "run",
    command: "bun test",
    tail: Array.from({ length: 12 }, (_, index) => `line ${index + 19}`).join("\n"),
    hidden: 18,
  });
  expect(toolView(tool("command_execution", JSON.stringify("git status")))).toMatchObject({
    kind: "run",
    command: "git status",
    tail: "",
    hidden: 0,
  });
  expect(toolView(tool("shell", { command: ["git", "diff"] }))).toMatchObject({
    kind: "run",
    command: "git diff",
  });
  expect(outputTail("a\nb", 5)).toEqual({ tail: "a\nb", hidden: 0 });
});

test("should read files and search patterns as separate kinds with their path", () => {
  expect(toolView(tool("Read", { file_path: "src/a.ts", offset: 12 }))).toEqual({
    kind: "read",
    target: "src/a.ts",
    path: "src/a.ts",
    line: 12,
  });
  expect(toolView(tool("Grep", { pattern: "foldTurn", path: "src" }))).toEqual({
    kind: "search",
    target: "foldTurn in src",
    path: "src",
  });
  expect(toolView(tool("Glob", { pattern: "**/*.ts" }))).toEqual({
    kind: "search",
    target: "**/*.ts",
  });
  expect(toolView(tool("WebFetch", { url: "https://example.com" }))).toEqual({
    kind: "read",
    target: "https://example.com",
  });
});

test("should name an MCP tool with its server, and open a browser action", () => {
  expect(toolView(tool("mcp__orc__task_get", { id: "1" }))).toEqual({
    kind: "mcp",
    server: "orc",
    tool: "task_get",
  });
  expect(toolView(tool("mcp__browser", { url: "https://example.com" }))).toEqual({
    kind: "mcp",
    tool: "browser",
  });
  expect(
    toolView(tool("browser_navigate", { action: "open", url: "https://example.com" })),
  ).toEqual({ kind: "browser", action: "open", target: "https://example.com" });
});

test("should read checklists from todo and plan tools without inventing steps", () => {
  const todo = toolView(
    tool("TodoWrite", {
      todos: [
        { id: "t1", content: "Add the strip", status: "in_progress" },
        { id: "t2", content: "Ship it", status: "done" },
      ],
    }),
  );
  expect(todo.kind).toBe("todo");
  expect(todo.kind === "todo" && todo.entries).toEqual([
    { id: "t1", content: "Add the strip", status: "in_progress" },
    { id: "t2", content: "Ship it", status: "completed" },
  ]);

  const plan = toolView(
    tool("update_plan", {
      explanation: "Chat polish",
      plan: [
        { step: "Map tool kinds", status: "completed" },
        { step: "Render the plan", status: "pending" },
      ],
    }),
  );
  expect(plan.kind).toBe("plan");
  expect(plan.kind === "plan" && plan.title).toBe("Chat polish");
  expect(plan.kind === "plan" && plan.entries.map((entry) => entry.content)).toEqual([
    "Map tool kinds",
    "Render the plan",
  ]);

  expect(toolView(tool("update_plan", { plan: [] }))).toEqual({ kind: "generic" });
  expect(toolView(tool("TodoWrite", { todos: [{}] }))).toEqual({ kind: "generic" });
});

test("should show a question with its options", () => {
  const view = toolView(
    tool("AskUserQuestion", {
      questions: [
        {
          header: "Layout",
          question: "Where should filters live?",
          options: [{ label: "In the fold" }, { label: "Global bar" }],
        },
      ],
    }),
  );
  expect(view).toEqual({
    kind: "question",
    questions: [
      {
        header: "Layout",
        question: "Where should filters live?",
        options: ["In the fold", "Global bar"],
      },
    ],
  });
  expect(toolDetail(view)).toBe("Where should filters live?");
});

test("should describe each kind in one summary line", () => {
  expect(toolDetail(toolView(tool("Read", { file_path: "a.ts" })))).toBe("a.ts");
  expect(toolDetail(toolView(tool("Grep", { pattern: "x", path: "src" })))).toBe("x in src");
  expect(toolDetail(toolView(tool("mcp__orc__task_get", {})))).toBe("orc: task_get");
  expect(
    toolDetail(toolView(tool("TodoWrite", { todos: [{ content: "a", status: "done" }] }))),
  ).toBe("1 of 1 steps");
});

test("should keep unknown or unparseable tools on the raw view", () => {
  expect(toolView(tool("task_get", { id: "1" }))).toEqual({ kind: "generic" });
  expect(toolView(tool("Edit", "not json"))).toEqual({ kind: "generic" });
  expect(toolView(tool("Bash", {}))).toEqual({ kind: "generic" });
  expect(toolView(tool("Read", {}))).toEqual({ kind: "generic" });
  expect(toolView(tool("SomeNewTool", { value: 1 }))).toEqual({ kind: "generic" });
});

test("should decode inline images from known content blocks only", () => {
  expect(toolImages(`screenshot ready: data:image/png;base64,${png} done`)).toEqual([
    { src: `data:image/png;base64,${png}`, bytes: 3 },
  ]);
  expect(
    toolImages(
      JSON.stringify([
        { type: "text", text: "Here is the render" },
        { type: "image", mimeType: "image/jpeg", data: png },
      ]),
    ),
  ).toEqual([{ src: `data:image/jpeg;base64,${png}`, bytes: 3 }]);
  expect(
    toolImages(
      JSON.stringify({
        type: "image_url",
        image_url: { url: `data:image/webp;base64,${png}` },
      }),
    ),
  ).toEqual([{ src: `data:image/webp;base64,${png}`, bytes: 3 }]);
});

test("should never load a remote or active image from a tool result", () => {
  expect(toolImages("see https://example.com/shot.png for the screenshot")).toEqual([]);
  expect(
    toolImages(
      JSON.stringify({ type: "image_url", image_url: { url: "https://example.com/a.png" } }),
    ),
  ).toEqual([]);
  expect(toolImages(`data:image/svg+xml;base64,${png}`)).toEqual([]);
  expect(toolImages("")).toEqual([]);
  expect(toolImages(undefined)).toEqual([]);
});

test("should bound inline image size and duplicate results", () => {
  const huge = "A".repeat(Math.ceil((MAX_TOOL_IMAGE_BYTES * 4) / 3) + 16);
  expect(toolImages(`data:image/png;base64,${huge}`)).toEqual([]);
  const url = `data:image/png;base64,${png}`;
  expect(toolImages(`${url} and again ${url}`)).toHaveLength(1);
  expect(stripInlineImages(`before\n${url}\nafter`)).toBe("before\n[image]\nafter");
  expect(stripInlineImages("plain output")).toBe("plain output");
});

test("should link only the pull requests and Git files a result prints", () => {
  expect(
    pullRequestLinks("Created pull request https://github.com/niradler/orc/pull/353."),
  ).toEqual([{ href: "https://github.com/niradler/orc/pull/353", label: "PR 353" }]);
  expect(pullRequestLinks("no links here")).toEqual([]);

  const status = [
    "On branch feat/chat-tool-cards",
    "Changes not staged for commit:",
    " M packages/web/src/lib/chat-tools.ts",
    "?? packages/web/src/lib/new.ts",
    "+++ b/packages/web/src/components/ChatActivityList.tsx",
    "+++ /dev/null",
  ].join("\n");
  expect(resultBranch("git status --short", status)).toBe("feat/chat-tool-cards");
  expect(resultFiles("git status --short", status)).toEqual([
    "packages/web/src/components/ChatActivityList.tsx",
    "packages/web/src/lib/chat-tools.ts",
    "packages/web/src/lib/new.ts",
  ]);
  expect(resultBranch("ls", "On branch main")).toBeUndefined();
  expect(resultFiles("bun test", " M src/a.ts")).toEqual([]);
});
