import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerEffectiveHome, storedProviderProfiles } from "@orc/core/provider-service";
import type { UsageQuota } from "@orc/core/usage";
import { z } from "zod";

const Percent = z.number().finite().min(0).max(100);
const CodexWindow = z.object({
  used_percent: Percent,
  limit_window_seconds: z.number().positive().optional(),
  reset_at: z.number().nonnegative().nullable().optional(),
});
const CodexResponse = z.object({
  rate_limit: z.object({
    primary_window: CodexWindow.nullish(),
    secondary_window: CodexWindow.nullish(),
  }),
});
const ClaudeWindow = z.object({
  utilization: Percent,
  resets_at: z.string().datetime({ offset: true }).nullish(),
});
const ClaudeResponse = z.object({
  five_hour: ClaudeWindow.nullish(),
  seven_day: ClaudeWindow.nullish(),
  seven_day_opus: ClaudeWindow.nullish(),
  seven_day_sonnet: ClaudeWindow.nullish(),
});
const CodexCredentials = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    account_id: z.string().min(1).optional(),
  }),
});
const ClaudeCredentials = z.object({ claudeAiOauth: z.object({ accessToken: z.string().min(1) }) });
const AlibabaResponse = z.object({
  per1MonthPercentage: z.number().finite().nonnegative().optional(),
  per1MonthResetTime: z.number().finite().nonnegative().nullish(),
  hasQuotaData: z.boolean().optional(),
});

type QuotaProcess = { exitCode: number; stdout: string; stderr: string };

type QuotaDependencies = {
  read: (path: string) => Promise<string>;
  fetch: (url: string, options: RequestInit) => Promise<Response>;
  home: string;
  codexHome?: string | undefined;
  claudeHome?: string | undefined;
  run?: (command: string, args: string[]) => Promise<QuotaProcess>;
};

function resetTime(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
  return isoTime(seconds * 1000);
}

function isoTime(milliseconds: number | null | undefined): string | null {
  if (milliseconds == null) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function decodeCodexQuota(body: unknown): UsageQuota["windows"] {
  const { rate_limit: limits } = CodexResponse.parse(body);
  return [limits.primary_window, limits.secondary_window].flatMap((window, index) => {
    if (!window) return [];
    let label = index === 0 ? "Primary window" : "Secondary window";
    if (window.limit_window_seconds) {
      const hours = window.limit_window_seconds / 3600;
      label = hours >= 24 ? `${hours / 24}-day window` : `${hours}-hour window`;
    }
    return [{ label, used_percent: window.used_percent, resets_at: resetTime(window.reset_at) }];
  });
}

export function decodeClaudeQuota(body: unknown): UsageQuota["windows"] {
  const limits = ClaudeResponse.parse(body);
  const labels = {
    five_hour: "5-hour window",
    seven_day: "7-day window",
    seven_day_opus: "Opus · 7 days",
    seven_day_sonnet: "Sonnet · 7 days",
  };
  return (Object.keys(labels) as (keyof typeof labels)[]).flatMap((key) => {
    const window = limits[key];
    return window
      ? [
          {
            label: labels[key],
            used_percent: window.utilization,
            resets_at: window.resets_at ? new Date(window.resets_at).toISOString() : null,
          },
        ]
      : [];
  });
}

export function decodeAlibabaQuota(body: unknown): UsageQuota["windows"] {
  const quota = AlibabaResponse.parse(body);
  if (quota.hasQuotaData === false || quota.per1MonthPercentage === undefined) return [];
  const used = Math.min(100, Math.max(0, quota.per1MonthPercentage * 100));
  return [
    {
      label: "Monthly token plan",
      used_percent: Math.round(used * 100) / 100,
      resets_at: isoTime(quota.per1MonthResetTime),
    },
  ];
}

function jsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

/**
 * Bailian CLI output can mix pretty-printed JSON with update notices, so read the
 * first complete object that carries quota fields instead of parsing all of stdout.
 */
export function parseAlibabaOutput(stdout: string): unknown {
  for (let start = stdout.indexOf("{"); start !== -1; start = stdout.indexOf("{", start + 1)) {
    const end = jsonObjectEnd(stdout, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(stdout.slice(start, end + 1));
      if (value && typeof value === "object" && "hasQuotaData" in value) return value;
    } catch {
      // Keep scanning past notices that are not JSON objects.
    }
  }
  return null;
}

export type QuotaTarget = {
  provider: UsageQuota["provider"];
  providerId?: string | undefined;
  name?: string | undefined;
  home?: string | undefined;
};

function quotaResult(target: QuotaTarget): UsageQuota {
  return {
    provider: target.provider,
    ...(target.providerId ? { provider_id: target.providerId } : {}),
    ...(target.name ? { name: target.name } : {}),
    status: "unavailable",
    message: null,
    checked_at: new Date().toISOString(),
    windows: [],
  };
}

async function readAlibabaQuota(
  dependencies: QuotaDependencies,
  result: UsageQuota,
): Promise<UsageQuota> {
  try {
    const run = dependencies.run;
    if (!run) return { ...result, message: "Alibaba Cloud quota reader is not configured." };
    const { exitCode, stdout, stderr } = await run("bl", [
      "usage",
      "token-plan",
      "--output",
      "json",
    ]);
    if (exitCode !== 0) {
      const signedOut = /\b(auth|login|credential|token|unauthori[sz]ed)\b/i.test(stderr);
      return {
        ...result,
        ...(signedOut ? { status: "signed_out" as const } : {}),
        message:
          "Alibaba Cloud quota could not be read with the Bailian CLI (bl). Sign in with `bl auth login` on the API host.",
      };
    }
    const body = parseAlibabaOutput(stdout);
    const windows = body ? decodeAlibabaQuota(body) : [];
    if (!windows.length)
      return { ...result, message: "This account does not report an Alibaba Cloud token plan." };
    return { ...result, status: "available", windows };
  } catch {
    return { ...result, message: "Alibaba Cloud quota data could not be read. Try again later." };
  }
}

async function readQuota(
  dependencies: QuotaDependencies,
  target: QuotaTarget,
): Promise<UsageQuota> {
  const result = quotaResult(target);
  if (target.provider === "alibaba") return readAlibabaQuota(dependencies, result);
  let headers: Record<string, string>;
  try {
    if (target.provider === "codex") {
      const raw = await dependencies.read(
        join(
          target.home ?? dependencies.codexHome ?? join(dependencies.home, ".codex"),
          "auth.json",
        ),
      );
      const { tokens } = CodexCredentials.parse(JSON.parse(raw));
      headers = { Authorization: `Bearer ${tokens.access_token}` };
      if (tokens.account_id) headers["ChatGPT-Account-Id"] = tokens.account_id;
    } else {
      const raw = await dependencies.read(
        join(
          target.home ?? dependencies.claudeHome ?? join(dependencies.home, ".claude"),
          ".credentials.json",
        ),
      );
      const { claudeAiOauth } = ClaudeCredentials.parse(JSON.parse(raw));
      headers = {
        Authorization: `Bearer ${claudeAiOauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      };
    }
  } catch {
    return {
      ...result,
      status: "signed_out",
      message:
        "No readable local account login in this provider's config directory. Sign in with this provider’s CLI on the API host. Keychain-only and API-key logins are not supported.",
    };
  }
  try {
    const url =
      target.provider === "codex"
        ? "https://chatgpt.com/backend-api/wham/usage"
        : "https://api.anthropic.com/api/oauth/usage";
    const response = await dependencies.fetch(url, {
      headers,
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) {
      const message =
        response.status === 401 || response.status === 403
          ? "Account access expired or quota access is denied. Sign in again with the provider’s CLI."
          : "Provider quota service is unavailable. Try again later.";
      return { ...result, message };
    }
    const body: unknown = await response.json();
    const windows = target.provider === "codex" ? decodeCodexQuota(body) : decodeClaudeQuota(body);
    if (!windows.length)
      return { ...result, message: "This account does not expose quota windows." };
    return { ...result, status: "available", windows };
  } catch {
    return { ...result, message: "Provider quota data could not be read. Try again later." };
  }
}

export function createTargetQuotaReader(
  dependencies: QuotaDependencies,
  targets: () => QuotaTarget[],
): () => Promise<UsageQuota[]> {
  let snapshot: { key: string; expires: number; accounts: UsageQuota[] } | undefined;
  let pending: { key: string; promise: Promise<UsageQuota[]> } | undefined;
  return async () => {
    const list = targets();
    const key = JSON.stringify(
      list.map((target) => [target.provider, target.providerId ?? "", target.home ?? ""]),
    );
    if (snapshot?.key === key && snapshot.expires > Date.now()) return snapshot.accounts;
    if (pending?.key === key) return pending.promise;
    const promise = Promise.all(list.map((target) => readQuota(dependencies, target)))
      .then((accounts) => {
        snapshot = { key, accounts, expires: Date.now() + 60_000 };
        return accounts;
      })
      .finally(() => {
        if (pending?.key === key) pending = undefined;
      });
    pending = { key, promise };
    return promise;
  };
}

export function createQuotaReader(dependencies: QuotaDependencies): () => Promise<UsageQuota[]> {
  return createTargetQuotaReader(dependencies, () => [
    { provider: "codex" },
    { provider: "claude" },
  ]);
}

function configuredTargets(): QuotaTarget[] {
  const targets: QuotaTarget[] = storedProviderProfiles()
    .filter((profile) => profile.agent === "claude" || profile.agent === "codex")
    .map((profile) => ({
      provider: profile.agent as QuotaTarget["provider"],
      providerId: profile.id,
      name: profile.name,
      home: providerEffectiveHome(profile),
    }));
  if (Bun.which("bl", { PATH: process.env.PATH ?? "" })) targets.push({ provider: "alibaba" });
  return targets;
}

async function runQuotaCommand(command: string, args: string[]): Promise<QuotaProcess> {
  const child = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(8000),
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export const readUsageQuotas = createTargetQuotaReader(
  {
    read: (path) => readFile(path, "utf8"),
    fetch: globalThis.fetch,
    home: homedir(),
    codexHome: process.env.CODEX_HOME,
    claudeHome: process.env.CLAUDE_CONFIG_DIR,
    run: runQuotaCommand,
  },
  configuredTargets,
);
