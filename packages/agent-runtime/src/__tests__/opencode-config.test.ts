import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenCodeConfigContent,
  EMBEDDED_PLUGIN_GLOBAL,
  installEmbeddedOpenCodePlugin,
  isOpenCodePluginDir,
  OPENCODE_BASELINE_PERMISSIONS,
  OPENCODE_PLUGIN_ENV,
  openCodeSessionEnv,
  orcCommandLine,
  resolveOpenCodePluginDir,
} from "../opencode-config.js";

const root = mkdtempSync(join(tmpdir(), "orc-opencode-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function pluginDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@orc/opencode", type: "module", main: "index.js" }),
  );
  writeFileSync(join(dir, "index.js"), "export default { id: 'orc' };\n");
  return dir;
}

describe("opencode session config", () => {
  test("appends the baseline after the user's rules and keeps their plugins", () => {
    const content = buildOpenCodeConfigContent(
      JSON.stringify({
        permissions: [{ action: "read", resource: "*", effect: "allow" }],
        plugins: ["user-plugin"],
        theme: "dark",
      }),
      "/opt/orc/opencode-plugin",
    );
    const parsed = JSON.parse(content);
    expect(parsed.theme).toBe("dark");
    expect(parsed.plugins).toEqual(["user-plugin", { package: "/opt/orc/opencode-plugin" }]);
    expect(parsed.permissions[0]).toEqual({
      action: "read",
      resource: "*",
      effect: "allow",
    });
    expect(parsed.permissions.slice(1)).toEqual([...OPENCODE_BASELINE_PERMISSIONS]);
    expect(parsed.permissions.at(-1)).toEqual(OPENCODE_BASELINE_PERMISSIONS.at(-1));
  });

  test("does not add the same plugin twice", () => {
    const content = buildOpenCodeConfigContent(
      JSON.stringify({ plugins: [{ package: "/opt/orc/opencode-plugin" }] }),
      "/opt/orc/opencode-plugin",
      [],
    );
    expect(JSON.parse(content).plugins).toEqual([{ package: "/opt/orc/opencode-plugin" }]);
  });

  test("rejects content ORC cannot merge safely", () => {
    expect(() => buildOpenCodeConfigContent("{not json", undefined)).toThrow(
      "OPENCODE_CONFIG_CONTENT is not valid JSON",
    );
    expect(() =>
      buildOpenCodeConfigContent(JSON.stringify({ permissions: {} }), undefined),
    ).toThrow("permissions must be an array");
    expect(() => buildOpenCodeConfigContent(JSON.stringify({ plugins: "one" }), undefined)).toThrow(
      "plugins must be an array",
    );
    expect(() => buildOpenCodeConfigContent("[]", undefined)).toThrow("must be a JSON object");
  });

  test("resolves a plugin package directory, never a single file", () => {
    const dir = pluginDir("plugin");
    expect(isOpenCodePluginDir(dir)).toBe(true);
    expect(isOpenCodePluginDir(join(dir, "index.js"))).toBe(false);
    expect(isOpenCodePluginDir(join(root, "missing"))).toBe(false);
    expect(resolveOpenCodePluginDir({ [OPENCODE_PLUGIN_ENV]: dir } as NodeJS.ProcessEnv)).toBe(dir);
    expect(() =>
      resolveOpenCodePluginDir({
        [OPENCODE_PLUGIN_ENV]: join(dir, "index.js"),
      } as NodeJS.ProcessEnv),
    ).toThrow(OPENCODE_PLUGIN_ENV);
  });

  test("falls back to the workspace package or the extracted embedded bundle", () => {
    const workspace = resolveOpenCodePluginDir({} as NodeJS.ProcessEnv);
    expect(workspace).toBeString();
    expect(isOpenCodePluginDir(workspace as string)).toBe(true);
    const embedded = pluginDir("embedded");
    (globalThis as Record<string, unknown>)[EMBEDDED_PLUGIN_GLOBAL] = embedded;
    try {
      expect(resolveOpenCodePluginDir({} as NodeJS.ProcessEnv)).toBe(embedded);
    } finally {
      delete (globalThis as Record<string, unknown>)[EMBEDDED_PLUGIN_GLOBAL];
    }
  });

  test("a session with policies fails loudly when enforcement is unavailable", () => {
    expect(() =>
      openCodeSessionEnv({
        policies: ["rev-1"],
        pluginDir: "/opt/orc/opencode-plugin",
        remote: true,
        dbPath: join(root, "orc.db"),
      }),
    ).toThrow("remote execution host");
    expect(() =>
      openCodeSessionEnv({
        policies: ["rev-1"],
        pluginDir: undefined,
        remote: false,
        dbPath: join(root, "orc.db"),
      }),
    ).toThrow("plugin bundle was not found");
    expect(() =>
      openCodeSessionEnv({
        policies: ["rev-1"],
        pluginDir: "/opt/orc/opencode-plugin",
        remote: false,
        dbPath: ":memory:",
      }),
    ).toThrow("in-memory rule database");
  });

  test("a protected session carries the plugin, database and API origin", () => {
    const dir = pluginDir("session-plugin");
    const existing = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: ["user-plugin"] }),
      KEEP: "1",
    };
    const env = openCodeSessionEnv({
      policies: ["rev-1"],
      pluginDir: dir,
      remote: false,
      dbPath: join(root, "orc.db"),
      apiBase: "http://127.0.0.1:7700",
      apiSecret: "secret",
      command: '"C:/orc.exe"',
      existingEnv: existing,
    });
    expect(env.KEEP).toBe("1");
    const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(parsed.plugins).toEqual(["user-plugin", { package: dir }]);
    expect(parsed.permissions).toEqual([...OPENCODE_BASELINE_PERMISSIONS]);
    expect(env.ORC_DB_PATH).toBe(join(root, "orc.db"));
    expect(env.ORC_COMMAND).toBe('"C:/orc.exe"');
    expect(env.ORC_API_BASE).toBe("http://127.0.0.1:7700");
    expect(env.ORC_API_SECRET).toBe("secret");
    expect(existing.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify({ plugins: ["user-plugin"] }));
  });

  test("a workspace without policies still gets the dangerous-command baseline only", () => {
    const env = openCodeSessionEnv({
      policies: [],
      pluginDir: undefined,
      remote: false,
      dbPath: join(root, "orc.db"),
    });
    const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(parsed.plugins).toBeUndefined();
    expect(parsed.permissions).toEqual([...OPENCODE_BASELINE_PERMISSIONS]);
  });

  test("the hook command line uses the current CLI entry or the compiled binary", () => {
    const entry = join(root, "cli.ts");
    writeFileSync(entry, "");
    expect(orcCommandLine("C:/bun.exe", entry)).toBe('"C:/bun.exe" "'.concat(entry, '"'));
    expect(orcCommandLine("C:/orc.exe", join(root, "missing.ts"))).toBe('"C:/orc.exe"');
  });

  test("embedded plugin assets materialize and detect tampering", () => {
    const assets = {
      "package.json": Buffer.from('{"name":"@orc/opencode","main":"index.js"}').toString("base64"),
      "index.js": Buffer.from("export default {}").toString("base64"),
    };
    const dir = installEmbeddedOpenCodePlugin(assets, join(root, "cache"));
    expect(isOpenCodePluginDir(dir)).toBe(true);
    expect(readFileSync(join(dir, "index.js"), "utf8")).toBe("export default {}");
    expect(installEmbeddedOpenCodePlugin(assets, join(root, "cache"))).toBe(dir);
    writeFileSync(join(dir, "index.js"), "tampered");
    expect(() => installEmbeddedOpenCodePlugin(assets, join(root, "cache"))).toThrow("modified");
    delete (globalThis as Record<string, unknown>)[EMBEDDED_PLUGIN_GLOBAL];
  });
});
