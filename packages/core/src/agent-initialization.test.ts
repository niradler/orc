import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, loadConfig, resetConfig, updateGlobalConfig } from "./config.js";
import {
  initializeAgentPreferences,
  providerChatDefaults,
  providerForAgent,
  readProviderSettings,
  saveProviderSettings,
} from "./provider-service.js";

const home = mkdtempSync(join(tmpdir(), "orc-agent-init-"));
const original = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  ORC_HOME: process.env.ORC_HOME,
};

beforeEach(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ORC_HOME = join(home, ".orc");
  mkdirSync(join(home, ".orc"), { recursive: true });
  writeFileSync(globalConfigPath(), "{}");
  resetConfig();
});
afterAll(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

test("should persist only installed defaults and choose an available chat default once", () => {
  initializeAgentPreferences((name) => (name === "opencode" ? process.execPath : null));
  expect(loadConfig().preferences.agents).toEqual(["opencode"]);
  expect(providerChatDefaults().agent).toBe("opencode");
  expect(readProviderSettings().providers.find((row) => row.id === "copilot")?.enabled).toBe(false);
  const saved = readFileSync(globalConfigPath(), "utf8");
  resetConfig();
  initializeAgentPreferences(() => null);
  expect(readFileSync(globalConfigPath(), "utf8")).toBe(saved);
});

test("should persist no installed agents and allow settings recovery without restoring defaults", () => {
  initializeAgentPreferences(() => null);
  expect(loadConfig().preferences.agents).toEqual([]);
  const initial = readProviderSettings();
  expect(initial.providers.every((profile) => !profile.enabled)).toBe(true);
  saveProviderSettings(initial);
  expect(() => providerChatDefaults()).not.toThrow();
  expect(() => providerForAgent("codex", "codex")).toThrow("Enable this provider");
  const saved = readProviderSettings();
  saveProviderSettings({
    ...saved,
    default_provider_id: "opencode",
    providers: saved.providers.map((profile) => ({
      ...profile,
      enabled: profile.id === "opencode",
    })),
  });
  initializeAgentPreferences(() => null);
  expect(providerForAgent("opencode", "opencode")?.enabled).toBe(true);
});

test("should preserve legacy explicit selections including an empty list", () => {
  for (const agents of [[], ["copilot"]]) {
    updateGlobalConfig((raw) => {
      raw.preferences = { agents };
    });
    initializeAgentPreferences(() => process.execPath);
    expect(loadConfig().preferences.agents).toEqual(agents);
  }
});

test("should detect a configured ACP command instead of the default binary", () => {
  updateGlobalConfig((raw) => {
    raw.agent_loop = { acp_commands: { opencode: { command: "custom-acp", args: [] } } };
  });
  initializeAgentPreferences((name) => (name === "custom-acp" ? process.execPath : null));
  expect(loadConfig().preferences.agents).toEqual(["opencode"]);
});

test("should align saved providers with discovery when no selection was recorded", () => {
  saveProviderSettings(readProviderSettings());
  updateGlobalConfig((raw) => {
    const preferences = (raw.preferences ?? {}) as Record<string, unknown>;
    delete preferences.agents;
    raw.preferences = preferences;
  });
  expect(loadConfig().preferences.agents).toBeUndefined();
  initializeAgentPreferences((name) => (name === "claude" ? process.execPath : null));
  expect(loadConfig().preferences.agents).toEqual(["claude"]);
  const saved = readProviderSettings();
  expect(saved.providers.find((profile) => profile.id === "claude")?.enabled).toBe(true);
  expect(saved.providers.find((profile) => profile.id === "codex")?.enabled).toBe(false);
  expect(saved.default_provider_id).toBe("claude");
  // Once the selection is recorded, later runs keep it even when binaries vanish.
  const before = readFileSync(globalConfigPath(), "utf8");
  initializeAgentPreferences(() => null);
  expect(readFileSync(globalConfigPath(), "utf8")).toBe(before);
});
