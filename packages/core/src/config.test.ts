import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globalConfigPath,
  loadConfig,
  OrcConfigSchema,
  resetConfig,
  resolveApiBase,
} from "./config.js";

test("should accept literal shell argv while preserving executable string overrides", () => {
  expect(OrcConfigSchema.parse({ terminals: { shell: "pwsh" } }).terminals.shell).toBe("pwsh");
  const shell: [string, ...string[]] = [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "-NoProfile",
    "",
    "a & b",
  ];
  expect(OrcConfigSchema.parse({ terminals: { shell } }).terminals.shell).toEqual(shell);
  for (const invalid of [
    [],
    [""],
    ["pwsh", 7],
    ["pwsh\0"],
    ["pwsh", "bad\0arg"],
    Array(65).fill("pwsh"),
  ])
    expect(OrcConfigSchema.safeParse({ terminals: { shell: invalid } }).success).toBe(false);
});

test("an explicitly empty environment secret overrides a stored secret", () => {
  const previousDirectory = process.cwd();
  const previousSecret = process.env.ORC_API_SECRET;
  const directory = mkdtempSync(join(tmpdir(), "orc-empty-secret-"));
  mkdirSync(join(directory, ".orc"));
  writeFileSync(
    join(directory, ".orc", "config.json"),
    JSON.stringify({ api: { secret: "stored-test-secret" } }),
  );
  try {
    process.chdir(directory);
    delete process.env.ORC_API_SECRET;
    resetConfig();
    expect(loadConfig().api.secret).toBe("stored-test-secret");
    process.env.ORC_API_SECRET = "";
    resetConfig();
    expect(loadConfig().api.secret).toBe("");
    process.env.ORC_API_SECRET = "environment-test-secret";
    resetConfig();
    expect(loadConfig().api.secret).toBe("environment-test-secret");
  } finally {
    process.chdir(previousDirectory);
    if (previousSecret === undefined) delete process.env.ORC_API_SECRET;
    else process.env.ORC_API_SECRET = previousSecret;
    resetConfig();
  }
});

test("ORC_HOME is the data root for config and the database", () => {
  const previous = {
    orcHome: process.env.ORC_HOME,
    dbPath: process.env.ORC_DB_PATH,
    directory: process.cwd(),
  };
  const root = mkdtempSync(join(tmpdir(), "orc-home-"));
  const data = join(root, "data");
  const cwd = mkdtempSync(join(tmpdir(), "orc-cwd-"));
  try {
    process.chdir(cwd);
    process.env.ORC_HOME = data;
    delete process.env.ORC_DB_PATH;
    resetConfig();
    expect(globalConfigPath()).toBe(join(data, "config.json"));
    expect(loadConfig().db.path).toBe(join(data, "orc.db"));
    expect(loadConfig().knowledge.root).toBe(join(data, "knowledge"));

    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ preferences: { theme: "light" } }));
    resetConfig();
    expect(loadConfig().preferences.theme).toBe("light");

    process.env.ORC_DB_PATH = join(root, "explicit.db");
    resetConfig();
    expect(loadConfig().db.path).toBe(join(root, "explicit.db"));
  } finally {
    process.chdir(previous.directory);
    if (previous.orcHome === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = previous.orcHome;
    if (previous.dbPath === undefined) delete process.env.ORC_DB_PATH;
    else process.env.ORC_DB_PATH = previous.dbPath;
    resetConfig();
  }
});

describe("agent_loop defaults", () => {
  test("a config with no agent_loop key does not start autonomous workers", () => {
    const cfg = OrcConfigSchema.parse({});
    expect(cfg.agent_loop.enabled).toBe(false);
  });

  test("a config with a partial agent_loop key does not start them either", () => {
    const cfg = OrcConfigSchema.parse({ agent_loop: { max_workers: 3 } });
    expect(cfg.agent_loop.enabled).toBe(false);
    expect(cfg.agent_loop.max_workers).toBe(3);
  });

  test("opting in is explicit", () => {
    const cfg = OrcConfigSchema.parse({ agent_loop: { enabled: true } });
    expect(cfg.agent_loop.enabled).toBe(true);
    expect(cfg.agent_loop.poll_interval_minutes).toBe(5);
  });
});

describe("resolveApiBase", () => {
  const api = (host: string) =>
    ({ api: { host, port: 7700 } }) as Parameters<typeof resolveApiBase>[0];

  test("dials wildcard binds on loopback and brackets IPv6 hosts", () => {
    const previous = process.env.ORC_API_BASE;
    delete process.env.ORC_API_BASE;
    try {
      expect(resolveApiBase(api("0.0.0.0"))).toBe("http://127.0.0.1:7700");
      expect(resolveApiBase(api("::"))).toBe("http://127.0.0.1:7700");
      expect(resolveApiBase(api("10.0.0.5"))).toBe("http://10.0.0.5:7700");
      expect(resolveApiBase(api("::1"))).toBe("http://[::1]:7700");
      expect(resolveApiBase(api("[::1]"))).toBe("http://[::1]:7700");
      expect(resolveApiBase(api("localhost"))).toBe("http://localhost:7700");
    } finally {
      if (previous === undefined) delete process.env.ORC_API_BASE;
      else process.env.ORC_API_BASE = previous;
    }
  });

  test("prefers ORC_API_BASE without a trailing slash or /api suffix", () => {
    const previous = process.env.ORC_API_BASE;
    process.env.ORC_API_BASE = "http://127.0.0.1:41234/api/";
    try {
      expect(resolveApiBase(api("0.0.0.0"))).toBe("http://127.0.0.1:41234");
    } finally {
      if (previous === undefined) delete process.env.ORC_API_BASE;
      else process.env.ORC_API_BASE = previous;
    }
  });
});
