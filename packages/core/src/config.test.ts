import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, OrcConfigSchema, resetConfig } from "./config.js";

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
