import { describe, expect, test } from "bun:test";
import {
  packageFields,
  packageTemplate,
  replacePackageFile,
  setInstructionBody,
  setPackageField,
  setPackageMcp,
  validatePackageDraft,
} from "../../src/lib/package-draft";

describe("specification-based package authoring", () => {
  test("preserves instruction scope and comments and retains dependencies while editing MCP", () => {
    const instruction =
      "---\n# Retain my scope\ndescription: Policy\napplyTo: '**/*.ts'\n---\nOld policy";
    expect(setInstructionBody(instruction, "New policy")).toBe(
      instruction.replace("Old policy", "New policy"),
    );
    const source = "name: example\nversion: 1.0.0\ndependencies:\n  apm: [org/package]\n";
    const changed = setPackageMcp(source, "- io.github.github/github-mcp-server\n");
    expect(packageFields(changed, "apm").dependencies).toEqual({
      apm: ["org/package"],
      mcp: ["io.github.github/github-mcp-server"],
    });
    expect(() => setPackageMcp(source, "name: malformed")).toThrow("list");
  });
  test("keeps YAML comments and extension fields when editing identity", () => {
    const source = "# My policy\nname: my-package\nversion: 1.0.0\nx-policy: preserved\n";
    const updated = setPackageField(source, "apm", "description", "For reviewing changes");
    expect(updated).toContain("# My policy");
    expect(packageFields(updated, "apm")["x-policy"]).toBe("preserved");
  });
  test("creates only specification-valid plugin identity and keeps portable structure", () => {
    const source = packageTemplate("agent-plugin");
    expect(validatePackageDraft(source, "agent-plugin").$schema).toBe(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    );
    expect(() => validatePackageDraft('{"name":"plugin"}', "agent-plugin")).toThrow("schema");
    expect(() => validatePackageDraft("name: bad--name\nversion: 1.0.0", "apm")).toThrow("name");
    expect(() => validatePackageDraft("name: good", "apm")).toThrow("version");
  });
  test("edits one resource while preserving all other supporting files", () => {
    const original = [
      { path: "mcp.json", content: "{}" },
      { path: "asset.bin", content: "AAH/", encoding: "base64" as const },
    ];
    const updated = replacePackageFile(original, "mcp.json", '{"mcpServers":{}}');
    expect(updated[1]).toEqual(original[1]);
    expect(updated).toHaveLength(2);
  });
});
