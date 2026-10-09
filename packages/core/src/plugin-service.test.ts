import { describe, expect, test } from "bun:test";
import { parsePluginManifest } from "./plugin-service.js";

const schema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
describe("portable Agent Plugins manifests", () => {
  test("preserves originals and isolates the specified non-fatal exceptions", () => {
    const input = {
      $schema: schema,
      name: "acme.tools",
      version: "not-semver",
      repository: "opaque metadata",
      extra: true,
      extensions: { "com.other.client": 42 },
    };
    const parsed = parsePluginManifest(JSON.stringify(input));
    expect(parsed.manifest).toEqual(input);
    expect(parsed.warnings).toEqual(["Ignored unknown manifest field: extra"]);
    expect(
      parsePluginManifest(JSON.stringify({ $schema: schema, name: "ok", extensions: 42 })).warnings,
    ).toContain("Ignored non-object extensions field");
  });
  test.each([
    { name: "ok" },
    { $schema: "https://untrusted/schema", name: "ok" },
    { $schema: schema, name: "bad--name" },
    { $schema: schema, name: "ok", author: { secret: true } },
    { $schema: schema, name: "ok", version: 1 },
  ])("rejects fatal manifest violations before discovery: %j", (value) => {
    expect(() => parsePluginManifest(JSON.stringify(value))).toThrow();
  });
});
