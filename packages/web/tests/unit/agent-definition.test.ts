import { describe, expect, test } from "bun:test";
import {
  agentTools,
  readAgentDefinition,
  readYamlMapping,
  setAgentBody,
  setAgentField,
  setAgentTools,
} from "../../src/lib/agent-definition";

describe("editable agent definitions", () => {
  const source =
    "---\n# Shared profile\nname: Reviewer\ndescription: Review changes\nmodel: pinned-model # Keep model comment\ntools:\n  Read: true # Keep tool comment\n  Bash: false\nhandoffs:\n  - agent: builder\n    prompt: Fix findings\ncustom-field:\n  nested: preserved\n---\n\nExact instructions.\n";
  test("should preserve unknown configuration, comments and instructions while changing fields and tools", () => {
    const changed = setAgentTools(setAgentField(source, "name", "Security reviewer"), [
      { name: "Read", allowed: true },
      { name: "WebSearch", allowed: false },
    ]);
    const parsed = readAgentDefinition(changed);
    expect(parsed.fields).toMatchObject({
      name: "Security reviewer",
      model: "pinned-model",
      tools: { Read: true, WebSearch: false },
      "custom-field": { nested: "preserved" },
      handoffs: [{ agent: "builder", prompt: "Fix findings" }],
    });
    expect(parsed.fields.tools).not.toHaveProperty("Bash");
    expect(changed).toContain("# Shared profile");
    expect(changed).toContain("# Keep model comment");
    expect(changed).toContain("# Keep tool comment");
    expect(parsed.body).toBe("\nExact instructions.\n");
  });
  test("should preserve the raw header when editing instructions and keep BOM/CRLF", () => {
    expect(setAgentBody(source, "New instructions").split("---")[1]).toBe(source.split("---")[1]);
    const windowsSource = `\uFEFF${source.replace(/\n/g, "\r\n")}`;
    const changed = setAgentField(windowsSource, "description", "Updated");
    expect(changed.startsWith("\uFEFF---\r\n")).toBe(true);
    expect(readAgentDefinition(changed).body).toBe("\r\nExact instructions.\r\n");
  });
  test("should distinguish backend defaults from an empty custom tool list and support legacy tool shapes", () => {
    expect(agentTools({ tools: "Read, Grep" })).toEqual([
      { name: "Read", allowed: true },
      { name: "Grep", allowed: true },
    ]);
    expect(agentTools({ tools: ["Read"] })).toEqual([{ name: "Read", allowed: true }]);
    expect(readAgentDefinition(setAgentTools(source, [])).fields.tools).toEqual({});
    expect(
      readAgentDefinition(setAgentField(source, "tools", undefined)).fields.tools,
    ).toBeUndefined();
  });
  test("should reject malformed, duplicate-key and non-mapping YAML and invalid tool values", () => {
    for (const invalid of ["name: [", "name: first\nname: second", "[first, second]"])
      expect(() => readYamlMapping(invalid)).toThrow();
    expect(() => readAgentDefinition("Plain Markdown")).toThrow();
    expect(() => agentTools({ tools: { Bash: "yes" } })).toThrow();
  });
});
