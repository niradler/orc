import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, loadConfig, resetConfig } from "./config.js";
import {
  agentDefaultHome,
  agentHomes,
  agentHomeVariable,
  providerChatDefaults,
  providerEffectiveHome,
  providerForAgent,
  readProviderSettings,
  resolveProviderEnvironment,
  saveProviderSettings,
} from "./provider-service.js";
import { ProviderSettingsSchema } from "./providers.js";

const home = mkdtempSync(join(tmpdir(), "orc-providers-"));
const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  resetConfig();
});
afterAll(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

test("should keep named same-adapter configurations independent and mask encrypted credentials", () => {
  const initial = readProviderSettings();
  const secret = "fixture-private-provider-key";
  const saved = saveProviderSettings({
    ...initial,
    default_provider_id: "claude-proxy",
    providers: [
      ...initial.providers,
      {
        id: "claude-proxy",
        name: "Claude LiteLLM",
        agent: "claude",
        enabled: true,
        executable: "",
        model: "proxy-model",
        environment: [
          { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:4000", secret: false },
          { name: "ANTHROPIC_AUTH_TOKEN", value: secret, secret: true },
        ],
      },
      {
        id: "claude-bedrock",
        name: "Claude Bedrock",
        agent: "claude",
        enabled: true,
        executable: "",
        model: "bedrock-model",
        environment: [
          { name: "CLAUDE_CODE_USE_BEDROCK", value: "1", secret: false },
          { name: "AWS_PROFILE", value: "work", secret: false },
        ],
      },
    ],
  });
  expect(JSON.stringify(saved)).not.toContain(secret);
  expect(readFileSync(globalConfigPath(), "utf8")).not.toContain(secret);
  expect(readFileSync(globalConfigPath(), "utf8")).toContain("enc:v1:");
  expect(providerChatDefaults().providerId).toBe("claude-proxy");
  expect(providerChatDefaults().model).toBe("proxy-model");
  expect(providerChatDefaults("claude-bedrock", "claude").model).toBe("bedrock-model");
  expect(
    resolveProviderEnvironment(providerForAgent("claude", "claude-proxy")).env.ANTHROPIC_AUTH_TOKEN,
  ).toBe(secret);
  expect(resolveProviderEnvironment(providerForAgent("claude", "claude-bedrock")).env).toEqual({
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_PROFILE: "work",
  });
  expect(
    resolveProviderEnvironment(providerForAgent("claude", "claude-proxy")).redact(
      `error ${secret}`,
    ),
  ).toBe("error [REDACTED]");
  const stream = resolveProviderEnvironment(providerForAgent("claude", "claude-proxy")).stream();
  const prefix = stream.push("prefix fixture-private-");
  expect(prefix + stream.push("provider-key suffix") + stream.flush()).toBe(
    "prefix [REDACTED] suffix",
  );
  expect(stream.flush()).toBe("");
  const ciphertext = loadConfig().providers?.instances.find(
    (profile) => profile.id === "claude-proxy",
  )?.environment[1]?.value;
  const updated = saveProviderSettings({
    ...saved,
    providers: saved.providers.map((profile) =>
      profile.id === "claude-proxy" ? { ...profile, model: "new-model" } : profile,
    ),
  });
  expect(
    loadConfig().providers?.instances.find((profile) => profile.id === "claude-proxy")
      ?.environment[1]?.value,
  ).toBe(ciphertext);
  expect(() => saveProviderSettings(saved)).toThrow("changed on the server");
  expect(() =>
    saveProviderSettings({
      ...updated,
      providers: updated.providers.map((profile) =>
        profile.id === "claude-proxy" ? { ...profile, agent: "codex" } : profile,
      ),
    }),
  ).toThrow("change its adapter");
});

test("should reject unsafe environment input and a disabled default without losing stored secrets", () => {
  const current = readProviderSettings();
  for (const environment of [
    [{ name: "ORC_API_SECRET", secret: true, value: "x" }],
    [{ name: "ANTHROPIC_AUTH_TOKEN", secret: false, value: "x" }],
    [
      { name: "A", secret: false, value: "x" },
      { name: "a", secret: false, value: "x" },
    ],
    [{ name: "VALUE", secret: false, value: "x\0" }],
  ]) {
    expect(
      ProviderSettingsSchema.safeParse({
        ...current,
        providers: current.providers.map((profile) =>
          profile.id === "claude-proxy" ? { ...profile, environment } : profile,
        ),
      }).success,
    ).toBe(false);
  }
  expect(
    ProviderSettingsSchema.safeParse({
      ...current,
      providers: current.providers.map((profile) =>
        profile.id === current.default_provider_id ? { ...profile, enabled: false } : profile,
      ),
    }).success,
  ).toBe(false);
  expect(() =>
    saveProviderSettings({
      ...current,
      providers: current.providers.map((profile) =>
        profile.id === "claude-proxy"
          ? { ...profile, environment: [{ name: "RENAMED_TOKEN", secret: true, value: null }] }
          : profile,
      ),
    }),
  ).toThrow("Re-enter a secret");
});

test("should isolate Claude and Codex accounts by CLI config directory", () => {
  const initial = readProviderSettings();
  const accountHome = join(home, "accounts", "claude-work");
  const explicitHome = join(home, "explicit-claude");
  const saved = saveProviderSettings({
    ...initial,
    providers: [
      ...initial.providers,
      {
        id: "claude-work",
        name: "Claude Work",
        agent: "claude",
        enabled: true,
        executable: "",
        home: accountHome,
        model: "",
        environment: [],
      },
      {
        id: "claude-env",
        name: "Claude Env",
        agent: "claude",
        enabled: true,
        executable: "",
        home: accountHome,
        model: "",
        environment: [{ name: "CLAUDE_CONFIG_DIR", value: explicitHome, secret: false }],
      },
      {
        id: "codex-work",
        name: "Codex Work",
        agent: "codex",
        enabled: true,
        executable: "",
        home: accountHome,
        model: "",
        environment: [],
      },
    ],
  });
  const claudeWork = saved.providers.find((profile) => profile.id === "claude-work");
  const claudeEnv = saved.providers.find((profile) => profile.id === "claude-env");
  const codexWork = saved.providers.find((profile) => profile.id === "codex-work");
  if (!claudeWork || !claudeEnv || !codexWork) throw new Error("Fixture providers are missing");
  expect(agentHomeVariable("claude")).toBe("CLAUDE_CONFIG_DIR");
  expect(agentHomeVariable("codex")).toBe("CODEX_HOME");
  expect(agentHomeVariable("opencode")).toBeUndefined();
  expect(providerEffectiveHome(claudeWork)).toBe(accountHome);
  expect(providerEffectiveHome({ ...claudeWork, home: "~/accounts/tilde" })).toBe(
    join(home, "accounts", "tilde"),
  );
  const storedClaude = providerForAgent("claude", "claude-work");
  const storedEnv = providerForAgent("claude", "claude-env");
  const storedCodex = providerForAgent("codex", "codex-work");
  if (!storedClaude || !storedEnv || !storedCodex)
    throw new Error("Fixture provider settings are missing");
  expect(resolveProviderEnvironment(storedClaude).env.CLAUDE_CONFIG_DIR).toBe(accountHome);
  // An explicit environment row is the escape hatch and wins over the field.
  expect(resolveProviderEnvironment(storedEnv).env.CLAUDE_CONFIG_DIR).toBe(explicitHome);
  expect(resolveProviderEnvironment(storedCodex).env.CODEX_HOME).toBe(accountHome);
  expect(agentHomes("claude")).toContain(accountHome);
  expect(agentHomes("codex")).toContain(accountHome);
  const defaultClaudeHome = agentDefaultHome("claude");
  if (!defaultClaudeHome) throw new Error("Claude default home is missing");
  expect(agentHomes("claude")).toContain(defaultClaudeHome);
});

test("should resolve the configured home with the same precedence as the launched CLI", () => {
  const initial = readProviderSettings();
  const fieldHome = join(home, "accounts", "field");
  const envHome = join(home, "accounts", "env-row");
  const secretHome = join(home, "accounts", "secret-row");
  saveProviderSettings({
    ...initial,
    providers: [
      ...initial.providers,
      {
        id: "claude-both",
        name: "Claude Both",
        agent: "claude",
        enabled: true,
        executable: "",
        home: fieldHome,
        model: "",
        environment: [{ name: "CLAUDE_CONFIG_DIR", value: envHome, secret: false }],
      },
      {
        id: "claude-cleared",
        name: "Claude Cleared",
        agent: "claude",
        enabled: true,
        executable: "",
        home: fieldHome,
        model: "",
        environment: [{ name: "CLAUDE_CONFIG_DIR", value: "", secret: false }],
      },
      {
        id: "claude-secret-home",
        name: "Claude Secret Home",
        agent: "claude",
        enabled: true,
        executable: "",
        home: "",
        model: "",
        environment: [{ name: "CLAUDE_CONFIG_DIR", value: secretHome, secret: true }],
      },
    ],
  });
  const both = providerForAgent("claude", "claude-both");
  const cleared = providerForAgent("claude", "claude-cleared");
  const secret = providerForAgent("claude", "claude-secret-home");
  if (!both || !cleared || !secret) throw new Error("Fixture providers are missing");
  // The explicit row wins over the field, exactly as in the spawned environment.
  expect(providerEffectiveHome(both)).toBe(envHome);
  expect(resolveProviderEnvironment(both).env.CLAUDE_CONFIG_DIR).toBe(envHome);
  // An empty row clears the override back to the host default.
  expect(providerEffectiveHome(cleared)).toBe(agentDefaultHome("claude"));
  expect(resolveProviderEnvironment(cleared).env.CLAUDE_CONFIG_DIR).toBe("");
  // A secret row still names the directory the CLI uses.
  expect(providerEffectiveHome(secret)).toBe(secretHome);
  expect(resolveProviderEnvironment(secret).env.CLAUDE_CONFIG_DIR).toBe(secretHome);
  expect(agentHomes("claude")).toContain(envHome);
  expect(agentHomes("claude")).toContain(secretHome);
});
