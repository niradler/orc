import { createServer, isIP } from "node:net";
import { type ExecHost, hostExec } from "./exec-host.js";
import { type JobOutputRedactor, resolveJobEnvironment } from "./job-environment.js";
import { jobShellArgv } from "./job-settings.js";
import { encryptSecret } from "./secrets.js";
import {
  DEFAULT_WORKSPACE_PORT_BASE,
  parseWorkspaceEnvironment,
  WORKSPACE_SETUP_OUTPUT_LIMIT,
  type WorkspaceEnvironment,
  type WorkspaceEnvironmentStore,
  type WorkspaceRecord,
  workspacePortEnv,
} from "./workspace-settings.js";

export * from "./workspace-settings.js";

export interface EnsureWorkspaceInput {
  store: WorkspaceEnvironmentStore;
  host: ExecHost;
  projectId: string;
  path: string;
  repoRoot: string | null;
  branch?: string | null | undefined;
  platform: NodeJS.Platform;
  workspace: WorkspaceEnvironment;
  /** Extra variables for the setup script (ports and project environment). */
  env?: Record<string, string> | undefined;
  /** Removes secret values from the recorded setup output. */
  redact?: ((text: string) => string) | undefined;
  isPortFree?: ((port: number) => boolean | Promise<boolean>) | undefined;
  log?: ((message: string) => void) | undefined;
}

/** Encrypts the configured secrets, keeping stored values when the client sends null. */
export function storeWorkspaceEnvironment(
  input: WorkspaceEnvironment,
  previous: WorkspaceEnvironment = parseWorkspaceEnvironment({}),
): WorkspaceEnvironment {
  return {
    ...input,
    env: input.env.map((entry) => {
      if (entry.value === null) {
        const saved = previous.env.find((item) => item.name === entry.name && item.secret);
        if (!saved || !entry.secret)
          throw new Error("A saved secret is required to keep its value");
        return saved;
      }
      return { ...entry, value: entry.secret ? encryptSecret(entry.value) : entry.value };
    }),
  };
}

export function resolveWorkspaceEnvironment(stored: unknown): {
  env: Record<string, string>;
  redact: (text: string) => string;
  createRedactor: () => JobOutputRedactor;
} {
  const parsed = parseWorkspaceEnvironment(stored);
  return resolveJobEnvironment(parsed.env);
}

export function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}

/**
 * First `start + n * count` block that is neither recorded as used nor bound.
 * Probing is skipped when the caller cannot inspect the host's sockets (SSH).
 */
export async function findFreePortBlock(opts: {
  start: number;
  count: number;
  used: readonly number[];
  isFree?: ((port: number) => boolean | Promise<boolean>) | undefined;
}): Promise<number> {
  const isFree = opts.isFree ?? isLoopbackPortFree;
  const used = new Set(opts.used);
  for (let base = opts.start; base + opts.count - 1 <= 65535; base += opts.count) {
    let blocked = false;
    for (let port = base; port < base + opts.count; port++) {
      if (used.has(port) || !(await isFree(port))) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return base;
  }
  throw new Error(`No free ${opts.count}-port block above ${opts.start}`);
}

/**
 * Makes sure a workspace has a port block and has run its setup script once.
 * Existing records are returned untouched; setup failures are recorded rather
 * than thrown so the agent still starts and the UI can show what went wrong.
 */
export async function ensureWorkspaceEnvironment(
  input: EnsureWorkspaceInput,
): Promise<WorkspaceRecord> {
  const existing = input.store.byPath(input.path);
  if (existing) return existing;

  const base = input.workspace.port_base ?? DEFAULT_WORKSPACE_PORT_BASE;
  const count = input.workspace.port_count;

  let record: WorkspaceRecord | null = null;
  let portBase = base;
  let lastError: unknown;
  // A concurrent prepare can take the block between the probe and the insert, so
  // re-read the used ports and try the next block instead of failing the launch.
  for (let attempt = 0; attempt < 3 && !record; attempt++) {
    portBase = await findFreePortBlock({
      start: base,
      count,
      used: input.store.usedPorts(),
      ...(input.host.kind === "ssh" ? { isFree: () => true } : {}),
      ...(input.isPortFree ? { isFree: input.isPortFree } : {}),
    });
    try {
      record = input.store.create({
        worktree_path: input.path,
        project_id: input.projectId,
        repo_root: input.repoRoot,
        git_branch: input.branch ?? null,
        host: input.host.kind === "ssh" ? input.host.alias : null,
        port_base: portBase,
        port_count: count,
      });
    } catch (error) {
      // Another process claimed the same path first; reuse its record.
      const raced = input.store.byPath(input.path);
      if (raced) return raced;
      lastError = error;
    }
  }
  if (!record)
    throw new Error(`Could not record the workspace environment for ${input.path}`, {
      cause: lastError,
    });

  const setup = input.workspace.setup_script?.trim();
  if (!setup) {
    input.store.setSetup({
      path: record.worktree_path,
      status: "skipped",
      started: Math.floor(Date.now() / 1000),
      ended: Math.floor(Date.now() / 1000),
    });
    return input.store.byPath(record.worktree_path) ?? record;
  }

  const env = {
    ...workspacePortEnv(portBase, count),
    ORC_PROJECT_ID: input.projectId,
    ORC_WORKSPACE: input.path,
    ORC_WORKTREE: input.path,
    ...input.env,
  };
  const started = Math.floor(Date.now() / 1000);
  input.store.setSetup({ path: record.worktree_path, status: "running", started, ended: null });
  input.log?.(`Running workspace setup in ${input.path}`);

  const result = await runWorkspaceSetup(input.host, {
    cwd: input.path,
    script: setup,
    platform: input.platform,
    env,
    timeoutMs: input.workspace.setup_timeout_secs * 1000,
    ...(input.redact ? { redact: input.redact } : {}),
  });
  const ended = Math.floor(Date.now() / 1000);
  input.store.setSetup({
    path: record.worktree_path,
    status: result.ok ? "succeeded" : "failed",
    output: result.output,
    started,
    ended,
  });
  if (!result.ok)
    input.log?.(`Workspace setup failed in ${input.path}: ${result.output.slice(-500)}`);
  return input.store.byPath(record.worktree_path) ?? record;
}

export async function runWorkspaceSetup(
  host: ExecHost,
  opts: {
    cwd: string;
    script: string;
    platform: NodeJS.Platform;
    env: Record<string, string>;
    timeoutMs: number;
    redact?: ((text: string) => string) | undefined;
  },
): Promise<{ ok: boolean; code: number | null; output: string }> {
  let result: { code: number | null; stdout: string; stderr: string };
  try {
    result = await hostExec(host, jobShellArgv(undefined, opts.script, opts.platform), {
      cwd: opts.cwd,
      env: opts.env,
      passEnv: Object.keys(opts.env),
      timeoutMs: opts.timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: null, output: truncateSetupOutput(message) };
  }
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const output = truncateSetupOutput(opts.redact ? opts.redact(raw) : raw);
  return { ok: result.code === 0, code: result.code, output };
}

function truncateSetupOutput(text: string): string {
  if (text.length <= WORKSPACE_SETUP_OUTPUT_LIMIT) return text;
  return `…${text.slice(text.length - WORKSPACE_SETUP_OUTPUT_LIMIT)}`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches the ANSI escape byte before stripping colour codes
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;
const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/gi;
const LOCAL_HOSTS = new Set(["0.0.0.0", "[::]", "[::1]", "127.0.0.1", "localhost", "::1"]);

/**
 * First http(s) URL printed by a dev server. `0.0.0.0` and `::` are rewritten
 * to localhost so the link opens from the machine running the dashboard.
 */
export function extractPreviewUrl(output: string): string | null {
  const clean = output.replace(ANSI, "");
  for (const match of clean.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (!url.hostname) continue;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "0.0.0.0" || host === "::") url.hostname = "localhost";
    else if (!LOCAL_HOSTS.has(url.hostname) && !isIP(host) && !host.includes(".")) continue;
    return url.toString().replace(/\/$/, "");
  }
  return null;
}
