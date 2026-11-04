import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, resetConfig } from "@orc/core/config";
import { DEFAULT_MCP_PROMPTS } from "@orc/core/mcp-prompts";
import { importConfigMcpPrompts, installMcpPrompts, McpPromptStore } from "./mcp-prompts";

const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const home = mkdtempSync(join(tmpdir(), "orc-prompts-"));

function restore(key: "HOME" | "USERPROFILE") {
  if (original[key] === undefined) delete process.env[key];
  else process.env[key] = original[key];
}

beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mkdirSync(join(home, ".orc"));
  resetConfig();
});

afterAll(() => {
  restore("HOME");
  restore("USERPROFILE");
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

function freshDb() {
  const sqlite = new Database(":memory:");
  installMcpPrompts(sqlite);
  return sqlite;
}

describe("MCP prompt store", () => {
  test("seeds built-ins once, so deleting one sticks across restarts", () => {
    const sqlite = freshDb();
    const store = new McpPromptStore(sqlite);
    expect(store.list()).toEqual(DEFAULT_MCP_PROMPTS);
    store.replace(DEFAULT_MCP_PROMPTS.slice(1));
    installMcpPrompts(sqlite);
    expect(store.list().map((p) => p.name)).not.toContain("render-ui");
  });

  test("keeps the given order and rejects duplicates", () => {
    const store = new McpPromptStore(freshDb());
    const [a, b] = DEFAULT_MCP_PROMPTS as [
      (typeof DEFAULT_MCP_PROMPTS)[0],
      (typeof DEFAULT_MCP_PROMPTS)[0],
    ];
    expect(store.replace([b, a]).map((p) => p.name)).toEqual([b.name, a.name]);
    expect(store.get(a.name)).toEqual(a);
    expect(store.get("missing")).toBeNull();
    expect(() => store.replace([a, a])).toThrow();
    expect(store.list()).toHaveLength(2);
  });

  test("imports legacy config prompts once and removes the key", () => {
    writeFileSync(
      globalConfigPath(),
      JSON.stringify({
        api: { secret: "keep" },
        mcp: {
          default_mode: "full",
          prompts: [
            {
              name: "render-ui",
              title: "Mine",
              description: "",
              content: "Custom",
              include_ui_catalog: true,
            },
          ],
        },
      }),
    );
    resetConfig();
    const sqlite = freshDb();
    importConfigMcpPrompts(sqlite);
    const store = new McpPromptStore(sqlite);
    expect(store.get("render-ui")?.content).toBe("Custom\n\n{{ui_catalog}}");
    expect(store.list()).toHaveLength(DEFAULT_MCP_PROMPTS.length);
    const raw = JSON.parse(readFileSync(globalConfigPath(), "utf8"));
    expect(raw.mcp).toEqual({ default_mode: "full" });
    expect(raw.api.secret).toBe("keep");
    store.replace([]);
    importConfigMcpPrompts(sqlite);
    expect(store.list()).toEqual([]);
  });
});
