import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  agentHomeVariable,
  providerConfiguredHome,
  providerEffectiveHome,
  storedProviderProfiles,
} from "@orc/core/provider-service";
import type { ProviderAccount, ProviderProfile } from "@orc/core/providers";

type Identity = {
  status: ProviderAccount["status"];
  label: string | null;
  organization: string | null;
  plan: string | null;
  message: string | null;
};

type Dependencies = {
  read: (path: string) => Promise<string>;
  home: string;
  platform: NodeJS.Platform;
};

const signedOut = (message: string | null = null): Identity => ({
  status: "signed_out",
  label: null,
  organization: null,
  plan: null,
  message,
});

function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function readClaudeIdentity(
  profile: ProviderProfile,
  dependencies: Dependencies,
): Promise<Identity> {
  const configHome = providerEffectiveHome(profile) ?? join(dependencies.home, ".claude");
  // Without CLAUDE_CONFIG_DIR Claude keeps the account block in ~/.claude.json;
  // with it, the file lives inside that directory. The default ~/.claude home is
  // not itself a CLAUDE_CONFIG_DIR override.
  const configuredHome = providerConfiguredHome(profile) ?? process.env.CLAUDE_CONFIG_DIR;
  const accountPath = configuredHome
    ? join(configHome, ".claude.json")
    : join(dependencies.home, ".claude.json");
  const credentialsPath = join(configHome, ".credentials.json");
  let account: Record<string, unknown> | null = null;
  let credentials: Record<string, unknown> | null = null;
  try {
    account = JSON.parse(await dependencies.read(accountPath)) as Record<string, unknown>;
  } catch {}
  try {
    credentials = JSON.parse(await dependencies.read(credentialsPath)) as Record<string, unknown>;
  } catch {}
  const oauth =
    account?.oauthAccount && typeof account.oauthAccount === "object"
      ? (account.oauthAccount as Record<string, unknown>)
      : null;
  const token =
    credentials?.claudeAiOauth && typeof credentials.claudeAiOauth === "object"
      ? (credentials.claudeAiOauth as Record<string, unknown>)
      : null;
  if (!oauth && !token) return signedOut("No readable Claude login in this config directory.");
  const label = text(oauth?.emailAddress) ?? text(account?.emailAddress);
  return {
    status: "signed_in",
    label,
    organization: text(oauth?.organizationName) ?? text(oauth?.organizationUuid),
    plan: text(token?.subscriptionType) ?? text(token?.rateLimitTier),
    message: null,
  };
}

export async function readCodexIdentity(
  profile: ProviderProfile,
  dependencies: Dependencies,
): Promise<Identity> {
  const home = providerEffectiveHome(profile) ?? join(dependencies.home, ".codex");
  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(await dependencies.read(join(home, "auth.json"))) as Record<string, unknown>;
  } catch {
    return signedOut("No readable Codex login in this config directory.");
  }
  const tokens =
    auth.tokens && typeof auth.tokens === "object"
      ? (auth.tokens as Record<string, unknown>)
      : null;
  if (!text(tokens?.access_token)) return signedOut("Codex is not signed in here.");
  const claims = text(tokens?.id_token) ? decodeJwtPayload(String(tokens?.id_token)) : null;
  const authClaims =
    claims?.["https://api.openai.com/auth"] &&
    typeof claims["https://api.openai.com/auth"] === "object"
      ? (claims["https://api.openai.com/auth"] as Record<string, unknown>)
      : null;
  return {
    status: "signed_in",
    label:
      text(claims?.email) ??
      text(claims?.preferred_username) ??
      text(authClaims?.email) ??
      text(auth.email) ??
      null,
    organization: null,
    plan: text(authClaims?.chatgpt_plan_type) ?? text(claims?.chatgpt_plan_type),
    message: null,
  };
}

/** Single-quoted shell literal: neither POSIX sh nor PowerShell expands anything inside. */
function shellLiteral(value: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

export function signInCommand(
  profile: ProviderProfile,
  home: string,
  platform: NodeJS.Platform,
): string | null {
  const variable = agentHomeVariable(profile.agent);
  if (!variable || !providerConfiguredHome(profile)) return null;
  const command = profile.agent === "claude" ? "claude" : "codex";
  const quoted = shellLiteral(home, platform);
  return platform === "win32"
    ? `$env:${variable}=${quoted}; ${command}`
    : `${variable}=${quoted} ${command}`;
}

export function readProviderAccounts(dependencies: Dependencies = defaultDependencies()) {
  const profiles = storedProviderProfiles();
  return Promise.all(
    profiles.map(async (profile): Promise<ProviderAccount> => {
      const home = providerEffectiveHome(profile) ?? "";
      const identity =
        profile.agent === "claude"
          ? await readClaudeIdentity(profile, dependencies)
          : profile.agent === "codex"
            ? await readCodexIdentity(profile, dependencies)
            : signedOut("Account identity is not available for this adapter.");
      return {
        provider_id: profile.id,
        name: profile.name,
        agent: profile.agent,
        home,
        ...identity,
        duplicate_of: null,
        sign_in_command: signInCommand(profile, home, dependencies.platform),
      };
    }),
  ).then(withDuplicates);
}

export function withDuplicates(accounts: ProviderAccount[]): ProviderAccount[] {
  const seen = new Map<string, string>();
  return accounts.map((account) => {
    if (account.status !== "signed_in" || (!account.label && !account.home)) return account;
    const key = `${account.agent}:${(account.label ?? account.home).toLowerCase()}`;
    const earlier = seen.get(key);
    if (!earlier) {
      seen.set(key, account.provider_id);
      return account;
    }
    return { ...account, duplicate_of: earlier };
  });
}

function defaultDependencies(): Dependencies {
  return { read: (path) => readFile(path, "utf8"), home: homedir(), platform: process.platform };
}
