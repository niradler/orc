import { describe, expect, test } from "bun:test";
import { formatContextMessage, renderOrcPromptSection } from "../src/prompt.js";

const base = {
  mode: "meta" as const,
  exposure: "direct" as const,
  apiBase: "http://127.0.0.1:7700",
  mcp: true,
  spec: true,
  skillMode: "search" as const,
  recall: true,
};

describe("renderOrcPromptSection", () => {
  test("describes the active project and meta mode", () => {
    const text = renderOrcPromptSection({ ...base, project: "orc" });
    expect(text).toContain('The active ORC project is "orc".');
    expect(text).toContain("tool_search");
    expect(text).toContain("tool_invoke");
    expect(text).toContain("memory_list");
    expect(text).toContain("memory_create");
    expect(text).toContain("orc_spec");
    expect(text).toContain("http://127.0.0.1:7700");
  });

  test("explains direct and deferred exposure", () => {
    expect(renderOrcPromptSection({ ...base, mode: "full" })).toContain(
      "exposes ORC tools directly",
    );
    expect(renderOrcPromptSection({ ...base, mode: "full", exposure: "deferred" })).toContain(
      "load through `tool_search`",
    );
  });

  test("explains disabled MCP and spec", () => {
    const text = renderOrcPromptSection({ ...base, mcp: false, spec: false });
    expect(text).toContain("Native ORC MCP tools are disabled");
    expect(text).not.toContain("Use `orc_spec`");
  });

  test("search mode says skills are not preloaded and local skills win", () => {
    const text = renderOrcPromptSection(base);
    expect(text).toContain("not preloaded");
    expect(text).toContain("local Pi setup");
    expect(renderOrcPromptSection({ ...base, skillMode: "pinned" })).toContain(
      "Selected ORC skills are loaded",
    );
  });

  test("mentions recall hints only when recall is on", () => {
    expect(renderOrcPromptSection(base)).toContain("Hidden ORC hints");
    expect(renderOrcPromptSection({ ...base, recall: false })).not.toContain("Hidden ORC hints");
  });

  test("is static: identical input renders identical text", () => {
    expect(renderOrcPromptSection(base)).toBe(renderOrcPromptSection({ ...base }));
  });

  test("does not claim a project when none is selected", () => {
    const text = renderOrcPromptSection(base);
    expect(text).toContain("No ORC project is selected");
    expect(text).not.toContain("The active ORC project is");
  });
});

test("formatContextMessage names the project and trims the index", () => {
  expect(formatContextMessage("orc", "\n  tasks: none\n")).toBe(
    "ORC context for project orc:\n\ntasks: none",
  );
  expect(formatContextMessage(undefined, "x")).toBe("ORC context for the active project:\n\nx");
});
