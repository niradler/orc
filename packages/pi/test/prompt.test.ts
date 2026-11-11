import { describe, expect, test } from "bun:test";
import { formatContextMessage, renderOrcPromptSection } from "../src/prompt.js";

const base = { apiBase: "http://127.0.0.1:7700", recall: true, rules: true };

describe("renderOrcPromptSection", () => {
  test("describes the active project and the single orc tool", () => {
    const text = renderOrcPromptSection({ ...base, project: "orc" });
    expect(text).toContain('The active ORC project is "orc"');
    expect(text).toContain("`orc` tool");
    expect(text).toContain("`search`");
    expect(text).toContain("`invoke`");
    expect(text).toContain("memory_create");
    expect(text).toContain("skill_create");
    expect(text).toContain("job_create");
    expect(text).toContain("http://127.0.0.1:7700");
  });

  test("local skills take precedence over ORC skills", () => {
    const text = renderOrcPromptSection(base);
    expect(text).toContain(".agents/skills");
    expect(text).toContain("take precedence");
  });

  test("mentions rules and recall only when enabled", () => {
    expect(renderOrcPromptSection(base)).toContain("rule_add");
    expect(renderOrcPromptSection({ ...base, rules: false })).not.toContain("rule_add");
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
  expect(formatContextMessage(undefined, "x")).toBe("ORC context for global scope:\n\nx");
});
