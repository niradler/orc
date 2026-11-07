import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfig, resolveApiBase } from "@orc/core/config";
import { loadDesktopConfig, saveDesktopConnection } from "./connection.js";

const originalEnvironment = { ...process.env };
const originalDirectory = process.cwd();
const directories: string[] = [];

afterEach(() => {
  process.env = { ...originalEnvironment };
  process.chdir(originalDirectory);
  resetConfig();
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  directories.length = 0;
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "orc-desktop-config-"));
  directories.push(directory);
  for (const key of Object.keys(process.env)) if (key.startsWith("ORC_")) delete process.env[key];
  process.env.USERPROFILE = directory;
  process.env.HOME = directory;
  process.chdir(directory);
  mkdirSync(join(directory, ".orc"));
  const path = join(directory, ".orc", "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      api: { port: 7700, secret: "saved-secret", session_days: 7 },
      preferences: { theme: "light" },
    }),
  );
  return path;
}

test("should preserve the stored secret when a launcher inherits an empty override", () => {
  fixture();
  process.env.ORC_API_SECRET = "";
  expect(loadDesktopConfig().api.secret).toBe("saved-secret");
  expect(process.env.ORC_API_SECRET).toBe("");
  expect(loadConfig().api.secret).toBe("");
});

test("should keep a nonempty explicit secret override", () => {
  fixture();
  process.env.ORC_API_SECRET = "explicit-secret";
  expect(loadDesktopConfig().api.secret).toBe("explicit-secret");
});

test("should persist the selected endpoint for default CLI and MCP clients while retaining settings", () => {
  const path = fixture();
  const config = loadDesktopConfig();
  saveDesktopConnection(config, {
    url: "http://127.0.0.1:49321",
    owned: true,
    stop() {},
    onExit() {},
  });
  resetConfig();
  expect(resolveApiBase()).toBe("http://127.0.0.1:49321");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    api: { host: "127.0.0.1", port: 49321, secret: "saved-secret", session_days: 7 },
    preferences: { theme: "light" },
  });
  process.env.ORC_API_PORT = "7701";
  resetConfig();
  expect(resolveApiBase()).toBe("http://127.0.0.1:7701");
});

test("should save a generated secret only for the daemon the app started", () => {
  const path = fixture();
  const config = loadDesktopConfig();
  const daemon = { url: "http://127.0.0.1:49322", owned: false, stop() {}, onExit() {} };
  saveDesktopConnection(config, daemon, "generated-secret");
  expect(JSON.parse(readFileSync(path, "utf8")).api.secret).toBe("saved-secret");
  saveDesktopConnection(config, { ...daemon, owned: true }, "generated-secret");
  expect(JSON.parse(readFileSync(path, "utf8")).api.secret).toBe("generated-secret");
});

test("should preserve invalid configuration instead of overwriting it", () => {
  const path = fixture();
  const config = loadDesktopConfig();
  writeFileSync(path, "{broken");
  expect(() =>
    saveDesktopConnection(config, {
      url: "http://127.0.0.1:49323",
      owned: true,
      stop() {},
      onExit() {},
    }),
  ).toThrow("not valid JSON");
  expect(readFileSync(path, "utf8")).toBe("{broken");
});
