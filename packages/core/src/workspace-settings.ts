import { z } from "zod";
import { JobEnvironmentSchema } from "./job-settings.js";

/** Default first port handed to the first workspace of a project. */
export const DEFAULT_WORKSPACE_PORT_BASE = 3100;
export const DEFAULT_WORKSPACE_PORT_COUNT = 10;
export const DEFAULT_SETUP_TIMEOUT_SECS = 900;
/** Setup output kept for the UI; later output wins so a failure message survives. */
export const WORKSPACE_SETUP_OUTPUT_LIMIT = 16_000;

const script = z
  .string()
  .max(8192)
  .refine((value) => !value.includes("\0"), "Scripts cannot contain NUL bytes");

export const WorkspaceEnvironmentSchema = z
  .object({
    setup_script: script.nullable(),
    dev_script: script.nullable(),
    setup_timeout_secs: z.number().int().min(30).max(3600),
    /**
     * First port of this project's pool. Each workspace gets a `port_count` wide
     * block inside it; null asks ORC to start at the default base.
     */
    port_base: z.number().int().min(1024).max(65535).nullable(),
    port_count: z.number().int().min(1).max(100),
    env: JobEnvironmentSchema,
  })
  .strict()
  .refine(
    (value) => !value.port_base || value.port_base + value.port_count - 1 <= 65535,
    "The port block must end at or below 65535",
  );
export type WorkspaceEnvironment = z.infer<typeof WorkspaceEnvironmentSchema>;

export function defaultWorkspaceEnvironment(): WorkspaceEnvironment {
  return {
    setup_script: null,
    dev_script: null,
    setup_timeout_secs: DEFAULT_SETUP_TIMEOUT_SECS,
    port_base: null,
    port_count: DEFAULT_WORKSPACE_PORT_COUNT,
    env: [],
  };
}

/** Stored JSON may predate a field; unknown or broken values fall back to defaults. */
export function parseWorkspaceEnvironment(value: unknown): WorkspaceEnvironment {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return defaultWorkspaceEnvironment();
    }
  }
  const parsed = WorkspaceEnvironmentSchema.safeParse(value ?? {});
  if (!parsed.success) return defaultWorkspaceEnvironment();
  return parsed.data;
}

/** Read-back view: secret values become null so they never leave the server. */
export function publicWorkspaceEnvironment(stored: unknown): WorkspaceEnvironment {
  const parsed = parseWorkspaceEnvironment(stored);
  return {
    ...parsed,
    env: parsed.env.map((entry) => ({ ...entry, value: entry.secret ? null : entry.value })),
  };
}

/** System-provided port variables. User variables cannot use the ORC_ prefix. */
export function workspacePortEnv(base: number, count: number): Record<string, string> {
  const env: Record<string, string> = {
    PORT: String(base),
    ORC_PORT: String(base),
    ORC_PORT_END: String(base + count - 1),
    ORC_PORT_COUNT: String(count),
  };
  for (let index = 1; index <= count; index++) env[`ORC_PORT_${index}`] = String(base + index - 1);
  return env;
}

export function isWorktreePath(path: string): boolean {
  return /[\\/](?:\.orc|\.claude|\.codex)[\\/]worktrees[\\/]/i.test(path);
}

/**
 * `repo/.orc/worktrees/<id>` -> `repo`. Returns null when the path does not
 * follow ORC's worktree layout.
 */
export function worktreeRoot(path: string): string | null {
  const match = /^(.*?)[\\/](?:\.orc|\.claude|\.codex)[\\/]worktrees[\\/][^\\/]+[\\/]?$/i.exec(
    path,
  );
  return match?.[1] ?? null;
}

export type WorkspaceSetupStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface WorkspaceRecord {
  worktree_path: string;
  project_id: string | null;
  repo_root: string | null;
  git_branch: string | null;
  host: string | null;
  setup_status: WorkspaceSetupStatus;
  setup_output: string | null;
  setup_started_at: number | null;
  setup_ended_at: number | null;
  port_base: number | null;
  port_count: number | null;
  preview_url: string | null;
  dev_terminal_id: string | null;
  created_at: number;
  updated_at: number;
}

/** Persistence the runtime needs; `@orc/db` supplies the SQLite implementation. */
export interface WorkspaceEnvironmentStore {
  byPath(path: string): WorkspaceRecord | null;
  create(input: {
    worktree_path: string;
    project_id: string | null;
    repo_root: string | null;
    git_branch: string | null;
    host: string | null;
    port_base: number;
    port_count: number;
  }): WorkspaceRecord;
  setSetup(input: {
    path: string;
    status: WorkspaceSetupStatus;
    output?: string | null;
    started?: number | null;
    ended?: number | null;
  }): void;
  /** Every port already handed to a workspace on this machine, across projects. */
  usedPorts(): number[];
}
