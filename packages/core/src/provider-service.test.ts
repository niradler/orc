import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, loadConfig, resetConfig } from "./config.js";
import {
  providerChatDefaults,
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
  expect(stream.push("prefix fixture-private-")).toBe("prefix ");
  expect(stream.push("provider-key suffix") + stream.flush()).toBe("[REDACTED] suffix");
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
