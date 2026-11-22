import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** Directory of a plugin package OpenCode can load, not a single file. */
export const OPENCODE_PLUGIN_ENV = "ORC_OPENCODE_PLUGIN";
/** Set by bin-entry after extracting the embedded plugin bundle. */
export const EMBEDDED_PLUGIN_GLOBAL = "__ORC_OPENCODE_PLUGIN_DIR__";

export type OpenCodePermissionRule = {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
};

/**
 * Defense in depth for ORC-managed OpenCode sessions: these ask the human even
 * when no workspace rule matches and even if the enforcement plugin is absent.
 * Everything else keeps OpenCode's normal policy, so ordinary commands do not
 * start prompting.
 */
export const OPENCODE_BASELINE_PERMISSIONS: readonly OpenCodePermissionRule[] = [
  { action: "shell", resource: "*daemon stop*", effect: "ask" },
  { action: "shell", resource: "*daemon restart*", effect: "ask" },
  { action: "shell", resource: "kill *", effect: "ask" },
  { action: "shell", resource: "taskkill *", effect: "ask" },
  { action: "shell", resource: "pkill *", effect: "ask" },
  { action: "shell", resource: "killall *", effect: "ask" },
  { action: "shell", resource: "sudo *", effect: "ask" },
  { action: "shell", resource: "rm -rf *", effect: "ask" },
  { action: "shell", resource: "rm -fr *", effect: "ask" },
  { action: "shell", resource: "rd /s *", effect: "ask" },
  { action: "shell", resource: "rmdir /s *", effect: "ask" },
  { action: "shell", resource: "del /f *", effect: "ask" },
  { action: "shell", resource: "format *", effect: "ask" },
  { action: "shell", resource: "mkfs*", effect: "ask" },
  { action: "shell", resource: "*git push --force*", effect: "ask" },
  { action: "shell", resource: "*git push -f*", effect: "ask" },
  { action: "shell", resource: "*git reset --hard*", effect: "ask" },
  { action: "shell", resource: "shutdown *", effect: "ask" },
  { action: "shell", resource: "reboot *", effect: "ask" },
];

function pluginEntryDir(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && "package" in entry) {
    const name = (entry as { package?: unknown }).package;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

/** OpenCode resolves a plugin directory through its package entry, not a bare file. */
/**
 * Materialize the plugin files embedded in a compiled binary so OpenCode can
 * load them from a stable directory. A changed bundle gets a new hash path.
 */
export function installEmbeddedOpenCodePlugin(
  assets: Record<string, string>,
  cacheRoot = join(homedir(), ".orc", "bundled-opencode-plugin"),
): string {
  const entries = Object.entries(assets).sort(([a], [b]) => a.localeCompare(b));
  for (const [path] of entries) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
      throw new Error("Bundled OpenCode plugin asset path must stay inside its package");
  }
  const hash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const directory = join(cacheRoot, hash);
  for (const [path, encoded] of entries) {
    const target = join(directory, path);
    const content = Buffer.from(encoded, "base64");
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      if (!readFileSync(target).equals(content))
        throw new Error("Bundled OpenCode plugin cache was modified");
    } else writeFileSync(target, content, { flag: "wx" });
  }
  return directory;
}

export function isOpenCodePluginDir(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    const manifest = join(path, "package.json");
    if (!existsSync(manifest)) return false;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      main?: unknown;
      exports?: unknown;
    };
    const exportsField = parsed.exports;
    const target =
      exportsField && typeof exportsField === "object" && "." in exportsField
        ? (exportsField as Record<string, unknown>)["."]
        : typeof exportsField === "string"
          ? exportsField
          : parsed.main;
    const entry =
      typeof target === "string"
        ? target
        : target && typeof target === "object" && "import" in target
          ? (target as { import?: unknown }).import
          : undefined;
    return typeof entry === "string" && existsSync(join(path, entry));
  } catch {
    return false;
  }
}

/**
 * Resolve the plugin package OpenCode should load. An explicit override is
 * authoritative: a wrong value must fail the session, not silently fall back to
 * a different copy of ORC.
 */
export function resolveOpenCodePluginDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[OPENCODE_PLUGIN_ENV]?.trim();
  if (override) {
    if (!isOpenCodePluginDir(override))
      throw new Error(
        `${OPENCODE_PLUGIN_ENV} must point at an OpenCode plugin directory with package.json and its entry file (got "${override}").`,
      );
    return override;
  }
  const embedded = (globalThis as Record<string, unknown>)[EMBEDDED_PLUGIN_GLOBAL];
  if (typeof embedded === "string" && isOpenCodePluginDir(embedded)) return embedded;
  // npm dist (dist/index.js → dist/opencode-plugin), source checkout
  // (packages/agent-runtime/src → packages/opencode), and a package-local copy.
  const candidates = [
    join(import.meta.dir, "opencode-plugin"),
    join(import.meta.dir, "../../opencode"),
    join(import.meta.dir, "../opencode-plugin"),
  ];
  return candidates.find(isOpenCodePluginDir);
}

/**
 * Append ORC's rules to an existing OPENCODE_CONFIG_CONTENT document. OpenCode
 * merges this layer after global and project config, so a trailing rule wins
 * and plugin entries accumulate rather than replacing the user's plugins.
 */
export function buildOpenCodeConfigContent(
  existing: string | undefined,
  pluginDir: string | undefined,
  permissions: readonly OpenCodePermissionRule[] = OPENCODE_BASELINE_PERMISSIONS,
): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new Error(
        "OPENCODE_CONFIG_CONTENT is not valid JSON; ORC cannot add its session rules without replacing it.",
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object");
    base = parsed as Record<string, unknown>;
  }
  const currentPermissions = base.permissions;
  if (currentPermissions !== undefined && !Array.isArray(currentPermissions))
    throw new Error("OPENCODE_CONFIG_CONTENT permissions must be an array");
  const currentPlugins = base.plugins;
  if (currentPlugins !== undefined && !Array.isArray(currentPlugins))
    throw new Error("OPENCODE_CONFIG_CONTENT plugins must be an array");
  const nextPermissions = [...(currentPermissions ?? []), ...permissions];
  const nextPlugins = [...(currentPlugins ?? [])];
  if (pluginDir && !nextPlugins.some((entry) => pluginEntryDir(entry) === pluginDir))
    nextPlugins.push({ package: pluginDir });
  return JSON.stringify({
    ...base,
    permissions: nextPermissions,
    ...(nextPlugins.length ? { plugins: nextPlugins } : {}),
  });
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

/**
 * Command line the OpenCode plugin runs for `orc rules hook`. The hook child
 * needs the daemon's own CLI and database, not whatever `orc` happens to be on
 * PATH (a source checkout and an installed build can differ).
 */
export function orcCommandLine(
  execPath: string = process.execPath,
  entry: string | undefined = process.argv[1],
): string {
  const embedded = (globalThis as unknown as { Bun?: { embeddedFiles?: readonly unknown[] } }).Bun
    ?.embeddedFiles;
  if (embedded?.length) return quote(execPath);
  if (entry && /\.(?:[cm]?[jt]s)$/i.test(entry) && existsSync(entry))
    return `${quote(execPath)} ${quote(entry)}`;
  return quote(execPath);
}

export type OpenCodeSessionEnvInput = {
  /** Policies that apply to this session's cwd; empty means baseline only. */
  policies: readonly string[];
  /** Resolved plugin directory; undefined means no enforcement plugin. */
  pluginDir: string | undefined;
  /** True when the session runs on an SSH execution host. */
  remote: boolean;
  dbPath: string;
  apiBase?: string | undefined;
  apiSecret?: string | undefined;
  command?: string | undefined;
  existingEnv?: Record<string, string> | undefined;
  permissions?: readonly OpenCodePermissionRule[] | undefined;
};

/**
 * Environment OpenCode needs for an ORC-managed session. Throws instead of
 * silently downgrading a protected workspace to advisory enforcement.
 */
export function openCodeSessionEnv(input: OpenCodeSessionEnvInput): Record<string, string> {
  if (input.policies.length) {
    if (input.remote)
      throw new Error(
        "ORC rules are active in this workspace, but an OpenCode session on a remote execution host cannot load the enforcement plugin from this machine. Install ORC and the plugin on that host, or use a local execution host.",
      );
    if (!input.pluginDir)
      throw new Error(
        "ORC rules are active in this workspace, but the OpenCode enforcement plugin bundle was not found. Reinstall ORC, or set ORC_OPENCODE_PLUGIN to a directory containing the @orc/opencode plugin.",
      );
    if (!input.dbPath || input.dbPath === ":memory:")
      throw new Error(
        "ORC rules are active in this workspace, but the OpenCode enforcement plugin cannot read an in-memory rule database. Start ORC with a file-backed database.",
      );
  }
  const env: Record<string, string> = { ...input.existingEnv };
  env.OPENCODE_CONFIG_CONTENT = buildOpenCodeConfigContent(
    env.OPENCODE_CONFIG_CONTENT,
    input.pluginDir,
    input.permissions ?? OPENCODE_BASELINE_PERMISSIONS,
  );
  env.ORC_DB_PATH = input.dbPath;
  env.ORC_COMMAND = input.command ?? orcCommandLine();
  if (input.apiBase) env.ORC_API_BASE = input.apiBase;
  if (input.apiSecret) env.ORC_API_SECRET = input.apiSecret;
  return env;
}
