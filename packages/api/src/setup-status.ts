import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentForSessionBackend } from "@orc/core/coding-agents";
import { localAgentBinary } from "@orc/core/config";
import { hostExec, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import type { ProviderProfile } from "@orc/core/providers";
import { getSqlite } from "@orc/db/client";
import { readClaudeIdentity, readCodexIdentity } from "./provider-accounts.js";
import { LIVE_CHAT_ID, repoRootFor } from "./sessions/common.js";

export type SetupAgentId = "claude" | "codex" | "opencode" | "pi" | "cursor";

export type SetupFix = {
  /** What the row's action does, e.g. "Install Codex". */
  label: string;
  /** Shell command the user runs on the ORC host to fix the row. */
  command: string;
};

export type SetupAgentStatus = {
  agent: SetupAgentId;
  label: string;
  installed: boolean;
  /** Resolved binary path, when installed. */
  path: string | null;
  /** `<binary> --version` output, best effort. */
  version: string | null;
  /** Signed in where ORC can tell; null means the credential store is not inspectable (e.g. macOS keychain). */
  signed_in: boolean | null;
  /** Account identity label (email) when known. */
  account_label: string | null;
  /** The one action that unblocks this agent, or null when it is ready or hopeless. */
  fix: SetupFix | null;
};

export type SetupProjectSuggestion = {
  /** Repository root (or session folder when it is not a repository). */
  path: string;
  /** Suggested project name, valid for POST /projects and unique within the list. */
  name: string;
  /** Agent ids whose sessions used this folder. */
  agents: string[];
  sessions: number;
  last_activity_at: string;
};

export type SetupDeps = {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  findBinary: (name: string) => string | null;
  exec: (argv: readonly string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;
  read: (path: string) => Promise<string>;
};

export function defaultSetupDeps(): SetupDeps {
  return {
    home: homedir(),
    platform: process.platform,
    env: process.env,
    findBinary: (name) => localAgentBinary(name),
    exec: async (argv, timeoutMs) => {
      try {
        const result = await hostExec(LOCAL_HOST, argv, { timeoutMs });
        return { code: result.code ?? 1, stdout: result.stdout };
      } catch {
        return { code: 1, stdout: "" };
      }
    },
    read: (path) => readFile(path, "utf8"),
  };
}

/**
 * The agents the first-run screen reports on, in display order. Each row of the
 * table is the whole detection contract for one agent: how to find it, how to
 * install it, how to sign in, and where its credentials live. Everything else
 * in this module is shared mechanics.
 */
type SetupAgentSpec = {
  id: SetupAgentId;
  label: string;
  binaries: readonly string[];
  install: (platform: NodeJS.Platform) => string;
  signIn: string;
};

const SETUP_AGENTS: readonly SetupAgentSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    binaries: ["claude"],
    install: () => "npm i -g @anthropic-ai/claude-code",
    signIn: "claude",
  },
  {
    id: "codex",
    label: "Codex",
    binaries: ["codex"],
    install: () => "npm i -g @openai/codex",
    signIn: "codex login",
  },
  {
    id: "opencode",
    label: "OpenCode",
    binaries: ["opencode"],
    install: () => "npm install -g opencode-ai",
    signIn: "opencode auth login",
  },
  {
    id: "pi",
    label: "Pi",
    binaries: ["pi"],
    install: () => "npm i -g @earendil-works/pi-coding-agent",
    signIn: "pi  # then /login",
  },
  {
    id: "cursor",
    label: "Cursor",
    binaries: ["cursor-agent", "agent"],
    install: (platform) =>
      platform === "win32"
        ? "irm https://cursor.com/install | iex"
        : "curl https://cursor.com/install -fsS | bash",
    signIn: "cursor-agent login",
  },
];

export function setupAgentIds(): SetupAgentId[] {
  return SETUP_AGENTS.map((spec) => spec.id);
}

const VERSION_TIMEOUT_MS = 10_000;

function parseVersion(stdout: string): string | null {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-.\w]+)?/.exec(stdout);
  return match ? match[0] : null;
}

async function readJson(deps: SetupDeps, path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await deps.read(path));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** True when a parsed credential file holds at least one usable secret value. */
function hasCredential(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(hasCredential);
}

function defaultProfile(agent: SetupAgentId): ProviderProfile {
  return {
    id: agent,
    name: agent,
    agent,
    enabled: true,
    executable: "",
    model: "",
    environment: [],
  };
}

function xdg(dir: string, home: string, fallback: readonly string[]): string {
  return dir || join(home, ...fallback);
}

async function signInState(
  spec: SetupAgentSpec,
  deps: SetupDeps,
): Promise<{ signed_in: boolean | null; account_label: string | null }> {
  const identityDeps = { read: deps.read, home: deps.home, platform: deps.platform };
  switch (spec.id) {
    case "claude": {
      if (deps.env.ANTHROPIC_API_KEY || deps.env.ANTHROPIC_AUTH_TOKEN)
        return { signed_in: true, account_label: null };
      const identity = await readClaudeIdentity(defaultProfile("claude"), identityDeps);
      return { signed_in: identity.status === "signed_in", account_label: identity.label };
    }
    case "codex": {
      if (deps.env.OPENAI_API_KEY) return { signed_in: true, account_label: null };
      const identity = await readCodexIdentity(defaultProfile("codex"), identityDeps);
      return { signed_in: identity.status === "signed_in", account_label: identity.label };
    }
    case "opencode": {
      const data = xdg(deps.env.XDG_DATA_HOME ?? "", deps.home, [".local", "share"]);
      const auth = await readJson(deps, join(data, "opencode", "auth.json"));
      return { signed_in: auth ? hasCredential(auth) : false, account_label: null };
    }
    case "pi": {
      const dir = deps.env.PI_CODING_AGENT_DIR || join(deps.home, ".pi", "agent");
      const auth = await readJson(deps, join(dir, "auth.json"));
      return { signed_in: auth ? hasCredential(auth) : false, account_label: null };
    }
    case "cursor": {
      if (deps.env.CURSOR_API_KEY) return { signed_in: true, account_label: null };
      const configDir =
        deps.env.CURSOR_CONFIG_DIR || xdg(deps.env.XDG_CONFIG_HOME ?? "", deps.home, [".config"]);
      const candidates = [
        deps.platform === "win32"
          ? join(deps.env.APPDATA || join(deps.home, "AppData", "Roaming"), "Cursor", "auth.json")
          : null,
        deps.platform === "darwin" ? join(deps.home, ".cursor", "auth.json") : null,
        join(configDir, "cursor", "auth.json"),
        join(deps.home, ".cursor", "auth.json"),
      ].filter((path): path is string => !!path);
      for (const path of candidates) {
        const auth = await readJson(deps, path);
        if (auth && hasCredential(auth)) return { signed_in: true, account_label: null };
      }
      // macOS keeps the CLI login in the keychain unless AGENT_CLI_CREDENTIAL_STORE=file,
      // so a missing file there is "cannot tell", not "signed out".
      const cliConfig = await readJson(deps, join(configDir, "cli-config.json"));
      if (cliConfig?.authInfo) return { signed_in: true, account_label: null };
      return { signed_in: deps.platform === "darwin" ? null : false, account_label: null };
    }
  }
}

/**
 * Detect the first-run agents without spawning anything except `--version`:
 * binary lookup, credential-file reads and identity parsing. `probeBackends()`
 * stays the source for "can a session run right now"; this answers the setup
 * screen's question ("installed? signed in? which version? how do I fix it?")
 * fast enough to render on first paint.
 */
export async function readSetupAgents(
  deps: SetupDeps = defaultSetupDeps(),
): Promise<SetupAgentStatus[]> {
  return Promise.all(
    SETUP_AGENTS.map(async (spec): Promise<SetupAgentStatus> => {
      let path: string | null = null;
      for (const binary of spec.binaries) {
        try {
          path = deps.findBinary(binary);
        } catch {
          path = null;
        }
        if (path) break;
      }
      const base = { agent: spec.id, label: spec.label, path };
      if (!path)
        return {
          ...base,
          installed: false,
          version: null,
          signed_in: null,
          account_label: null,
          fix: { label: `Install ${spec.label}`, command: spec.install(deps.platform) },
        };
      const [versionResult, signIn] = await Promise.all([
        deps
          .exec([path, "--version"], VERSION_TIMEOUT_MS)
          .then((result) => (result.code === 0 ? parseVersion(result.stdout) : null))
          .catch(() => null),
        signInState(spec, deps).catch(() => ({ signed_in: null, account_label: null })),
      ]);
      return {
        ...base,
        installed: true,
        version: versionResult,
        signed_in: signIn.signed_in,
        account_label: signIn.account_label,
        fix:
          signIn.signed_in === false
            ? { label: `Sign in to ${spec.label}`, command: spec.signIn }
            : null,
      };
    }),
  );
}

const SUGGESTION_LIMIT = 12;
const CANDIDATE_LIMIT = 300;
/** POST /projects accepts names of at most 100 characters. */
const PROJECT_NAME_MAX = 100;

/** Folder name -> a project name POST /projects accepts. */
export function suggestedProjectName(path: string): string {
  // Session folders carry the producing platform's separators; split on both so a
  // Windows-named folder still reads correctly when the API host differs.
  const folder = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const base = folder
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_NAME_MAX);
  return base || "project";
}

/**
 * `base` made unique against `used`, staying within the project-name cap. The
 * suffix needs room inside the cap: slicing after the append would truncate a
 * max-length base back to itself and the search would never terminate. Cut
 * first and every candidate is distinct, so a free name is always found.
 */
function uniqueProjectName(base: string, used: Set<string>): string {
  let name = base;
  for (let suffix = 2; used.has(name.toLowerCase()); suffix++) {
    const tail = `-${suffix}`;
    name = `${base.slice(0, PROJECT_NAME_MAX - tail.length)}${tail}`;
  }
  return name;
}

/**
 * Folders the discovered agent sessions were last used in, newest first, each
 * resolved to its repository root so worktrees and subfolders suggest one
 * project. Only local sessions qualify: a remote folder is not a project folder
 * on this machine.
 */
export async function suggestSetupProjects(
  limit = SUGGESTION_LIMIT,
): Promise<SetupProjectSuggestion[]> {
  const rows = getSqlite()
    .query<
      { cwd: string; backend: string; sessions: number; last_activity_at: number },
      [string, number]
    >(
      `SELECT cwd, backend, COUNT(*) AS sessions, MAX(last_activity_at) AS last_activity_at
         FROM gateway_sessions
        WHERE chat_id = ? AND cwd IS NOT NULL AND cwd != '' AND project_id IS NULL
          AND (execution_host IS NULL OR execution_host = '' OR execution_host = 'local')
        GROUP BY cwd, backend
        ORDER BY last_activity_at DESC
        LIMIT ?`,
    )
    .all(LIVE_CHAT_ID, CANDIDATE_LIMIT);
  const runtime = hostRuntime(LOCAL_HOST);
  type Merged = {
    path: string;
    agents: Set<string>;
    sessions: number;
    last: number;
  };
  const merged = new Map<string, Merged>();
  for (const row of rows) {
    const root = (await repoRootFor(row.cwd, runtime)) ?? row.cwd;
    // A folder that no longer exists is not a useful project.
    if (!(await runtime.isDirectory(root))) continue;
    const entry = merged.get(root) ?? { path: root, agents: new Set(), sessions: 0, last: 0 };
    entry.agents.add(agentForSessionBackend(row.backend)?.id ?? row.backend);
    entry.sessions += row.sessions;
    entry.last = Math.max(entry.last, row.last_activity_at);
    merged.set(root, entry);
  }
  const used = new Set<string>();
  return [...merged.values()]
    .sort((a, b) => b.last - a.last)
    .slice(0, limit)
    .map((entry) => {
      const name = uniqueProjectName(suggestedProjectName(entry.path), used);
      used.add(name.toLowerCase());
      return {
        path: entry.path,
        name,
        agents: [...entry.agents].sort(),
        sessions: entry.sessions,
        // gateway_sessions keeps whole unix seconds.
        last_activity_at: new Date(entry.last * 1000).toISOString(),
      };
    });
}
