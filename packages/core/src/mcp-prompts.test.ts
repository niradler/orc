import { describe, expect, test } from "bun:test";
import { DEFAULT_MCP_PROMPTS, McpPromptListSchema, renderMcpPrompt } from "./mcp-prompts";

const prompt = { name: "x", title: "X", description: "", content: "Do it.\nRequest: {{request}}" };

describe("MCP prompts", () => {
  test("built-ins validate and every one takes the request", () => {
    expect(McpPromptListSchema.parse(DEFAULT_MCP_PROMPTS)).toHaveLength(8);
    for (const p of DEFAULT_MCP_PROMPTS) expect(p.content).toContain("{{request}}");
  });

  test("the skill prompt covers search, supporting refs and verified script downloads", () => {
    const skill = DEFAULT_MCP_PROMPTS.find((p) => p.name === "skill")?.content ?? "";
    for (const step of ["skill_list with q", "ref set to its path", "download:true", "sha256"])
      expect(skill).toContain(step);
  });

  test("render fills the request slot, or asks when it is empty", () => {
    expect(renderMcpPrompt(prompt, "ship it")).toBe("Do it.\nRequest: ship it");
    expect(renderMcpPrompt(prompt)).toContain("ask what is needed");
  });

  test("render appends a request when the prompt has no slot and expands the catalog", () => {
    const plain = { ...prompt, content: "Plain" };
    expect(renderMcpPrompt(plain)).toBe("Plain");
    expect(renderMcpPrompt(plain, "more")).toBe("Plain\n\nRequest: more");
    const ui = DEFAULT_MCP_PROMPTS.find((p) => p.name === "render-ui");
    expect(ui && renderMcpPrompt(ui, "a")).toContain("## Examples");
  });
});
