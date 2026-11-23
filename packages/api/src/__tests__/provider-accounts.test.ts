import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAccount, ProviderProfile } from "@orc/core/providers";
import {
  readClaudeIdentity,
  readCodexIdentity,
  signInCommand,
  withDuplicates,
} from "../provider-accounts.js";

const home = mkdtempSync(join(tmpdir(), "orc-provider-accounts-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const claudeProfile = (overrides: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id: "claude-work",
  name: "Claude Work",
  agent: "claude",
  enabled: true,
  executable: "",
  model: "",
  environment: [],
  ...overrides,
});

const accountHome = join(home, "accounts", "claude-work");

function dependencies(
  files: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
) {
  const reads: string[] = [];
  return {
    reads,
    deps: {
      home,
      platform: "linux" as NodeJS.Platform,
      env,
      read: async (path: string) => {
        reads.push(path);
        if (!(path in files)) throw new Error("private missing path");
        return JSON.stringify(files[path]);
      },
    },
  };
}

describe("provider account identity", () => {
  test("reads a Claude login from the configured CLI directory without exposing credentials", async () => {
    const { deps, reads } = dependencies({
      [join(accountHome, ".claude.json")]: {
        oauthAccount: { emailAddress: "work@example.com", organizationName: "Acme" },
      },
      [join(accountHome, ".credentials.json")]: {
        claudeAiOauth: { accessToken: "private-access-token", subscriptionType: "max" },
      },
    });
    const identity = await readClaudeIdentity(claudeProfile({ home: accountHome }), deps);
    expect(identity).toEqual({
      status: "signed_in",
      label: "work@example.com",
      organization: "Acme",
      plan: "max",
      message: null,
    });
    expect(reads).toContain(join(accountHome, ".claude.json"));
    expect(JSON.stringify(identity)).not.toContain("private-access-token");
  });

  test("keeps the default Claude account file in the home directory when no directory is set", async () => {
    const { deps, reads } = dependencies({
      [join(home, ".claude.json")]: {
        oauthAccount: { emailAddress: "personal@example.com" },
      },
      [join(home, ".claude", ".credentials.json")]: {
        claudeAiOauth: { accessToken: "private-default-token" },
      },
    });
    const identity = await readClaudeIdentity(claudeProfile(), deps);
    expect(identity.status).toBe("signed_in");
    expect(identity.label).toBe("personal@example.com");
    expect(reads).toContain(join(home, ".claude.json"));
    expect(reads).not.toContain(join(home, ".claude", ".claude.json"));
  });

  test("reads the agent config directory from the injected environment", async () => {
    const claudeDir = join(home, "injected-claude");
    const codexDir = join(home, "injected-codex");
    const payload = Buffer.from(JSON.stringify({ email: "env-codex@example.com" })).toString(
      "base64url",
    );
    const { deps, reads } = dependencies(
      {
        [join(claudeDir, ".claude.json")]: {
          oauthAccount: { emailAddress: "env-claude@example.com" },
        },
        [join(codexDir, "auth.json")]: {
          tokens: { access_token: "private-env-token", id_token: `header.${payload}.signature` },
        },
      },
      { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir },
    );
    const claude = await readClaudeIdentity(claudeProfile(), deps);
    expect(claude).toMatchObject({ status: "signed_in", label: "env-claude@example.com" });
    const codex = await readCodexIdentity(
      { ...claudeProfile(), id: "codex-env", agent: "codex" },
      deps,
    );
    expect(codex).toMatchObject({ status: "signed_in", label: "env-codex@example.com" });
    expect(reads).toContain(join(claudeDir, ".claude.json"));
    expect(reads).toContain(join(codexDir, "auth.json"));
    expect(JSON.stringify(claude) + JSON.stringify(codex)).not.toContain("private-env-token");
  });

  test("reads Codex claims from CODEX_HOME and treats a missing login as signed out", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        email: "codex@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      }),
    ).toString("base64url");
    const { deps } = dependencies({
      [join(accountHome, "auth.json")]: {
        tokens: { access_token: "private-codex-access", id_token: `header.${payload}.signature` },
      },
    });
    const codex = { ...claudeProfile({ home: accountHome }), id: "codex-work", agent: "codex" };
    const identity = await readCodexIdentity(codex, deps);
    expect(identity).toMatchObject({
      status: "signed_in",
      label: "codex@example.com",
      plan: "plus",
    });
    expect(JSON.stringify(identity)).not.toContain("private-codex-access");
    const missing = await readCodexIdentity(codex, dependencies({}).deps);
    expect(missing.status).toBe("signed_out");
  });

  test("offers a sign-in command only for a configured directory", () => {
    expect(signInCommand(claudeProfile({ home: accountHome }), accountHome, "linux")).toBe(
      `CLAUDE_CONFIG_DIR='${accountHome}' claude`,
    );
    expect(signInCommand(claudeProfile({ home: accountHome }), accountHome, "win32")).toBe(
      `$env:CLAUDE_CONFIG_DIR='${accountHome}'; claude`,
    );
    expect(signInCommand(claudeProfile(), accountHome, "linux")).toBeNull();
  });

  test("sign-in commands quote the directory as a shell literal", () => {
    const hostile = "/tmp/$(printf INJECTED)'\"`";
    expect(signInCommand(claudeProfile({ home: hostile }), hostile, "linux")).toBe(
      "CLAUDE_CONFIG_DIR='/tmp/$(printf INJECTED)'\\''\"`' claude",
    );
    expect(signInCommand(claudeProfile({ home: hostile }), hostile, "win32")).toBe(
      "$env:CLAUDE_CONFIG_DIR='/tmp/$(printf INJECTED)''\"`'; claude",
    );
  });

  test("marks later profiles that resolve to the same account", () => {
    const account = (id: string, label: string): ProviderAccount => ({
      provider_id: id,
      name: id,
      agent: "claude",
      home: join(home, "accounts", id),
      status: "signed_in",
      label,
      organization: null,
      plan: null,
      duplicate_of: null,
      message: null,
      sign_in_command: null,
    });
    const [first, second, other] = withDuplicates([
      account("claude-a", "same@example.com"),
      account("claude-b", "SAME@example.com"),
      account("claude-c", "other@example.com"),
    ]);
    expect(first?.duplicate_of).toBeNull();
    expect(second?.duplicate_of).toBe("claude-a");
    expect(other?.duplicate_of).toBeNull();
  });
});
