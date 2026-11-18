import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { execHostFor, type HostRuntime, hostRuntime } from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { gitError, gitRunner, repoRoot } from "@orc/core/session-dir";
import {
  HANDOFF_UPLOAD_PATH_PATTERN,
  MAX_HANDOFF_BYTES,
  type SessionBundle,
  SessionBundleSchema,
  type SessionHandoffInput,
  SessionHandoffSchema,
  SessionHandoffUploadSchema,
} from "@orc/core/session-handoff";
import type { SessionSend, SessionSendPreview, SessionSendRequest } from "@orc/core/session-send";
import { getDb } from "@orc/db/client";
import { gateway_sessions, session_sends } from "@orc/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { LIVE_CHAT_ID } from "../sessions/common.js";
import { codexWriterOwned } from "../sessions/ownership.js";
import { loadTranscriptBytes } from "../sessions/transcript-source.js";
import { repositoryIdentity } from "./git.js";
import { exportOpenCodeSession } from "./opencode-store.js";

type SendRow = typeof session_sends.$inferSelect;
type GatewayRow = typeof gateway_sessions.$inferSelect;
const logger = createLogger("api:send-to");

/** Secret-looking files stay on the source machine; mirrors baton's handoff pathspecs. */
const SECRET_PATHSPECS = [
  ":(glob,icase)**/.env",
  ":(glob,icase)**/.env.*",
  ":(glob)**/*.pem",
  ":(glob)**/*.key",
  ":(glob)**/*.p12",
  ":(glob)**/*.pfx",
  ":(glob)**/*.tfvars",
  ":(glob)**/*.tfstate",
  ":(glob)**/*.tfstate.*",
  ":(glob)**/id_rsa*",
  ":(glob)**/id_ecdsa*",
  ":(glob)**/id_ed25519*",
  ":(exclude,glob)**/*.example",
  ":(exclude,glob)**/*.sample",
  ":(exclude,glob)**/*.template",
  ":(exclude,glob)**/*.pub",
];

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "ORC Send",
  GIT_AUTHOR_EMAIL: "send-to@orc.local",
  GIT_COMMITTER_NAME: "ORC Send",
  GIT_COMMITTER_EMAIL: "send-to@orc.local",
};

const PREPARING_STALE_MS = 5 * 60 * 1000;

export function sendDto(row: SendRow): SessionSend {
  const stale =
    row.status === "preparing" && row.updated_at.getTime() < Date.now() - PREPARING_STALE_MS;
  return {
    id: row.id,
    live_session_id: row.live_session_id,
    status: stale ? "error" : row.status,
    host_label: row.host_label,
    host_url: row.host_url,
    project: row.project,
    handoff_id: row.handoff_id,
    remote_session_id: row.remote_session_id,
    branch: row.branch,
    commit: row.commit,
    left_behind: row.left_behind ?? [],
    error: stale ? "The send was interrupted; send the session again" : row.error,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function liveRow(id: string): Promise<GatewayRow> {
  const row = await getDb().query.gateway_sessions.findFirst({
    where: and(eq(gateway_sessions.id, id), eq(gateway_sessions.chat_id, LIVE_CHAT_ID)),
  });
  if (!row) throw new NotFoundError("Session", id);
  return row;
}

interface ResolvedSource {
  agent: "claude" | "codex" | "opencode" | "pi";
  nativeId: string;
  cwd: string;
  root: string;
  subdirectory: string;
  repository: string;
  branch: string;
  transcriptPath: string;
  runtime: HostRuntime;
}

/**
 * Everything the move needs, resolved read-only. Eligibility problems are
 * returned as a reason for the preview and thrown as validation errors for the
 * send itself.
 */
async function resolveSource(
  row: GatewayRow,
): Promise<{ source?: ResolvedSource; reason?: string }> {
  const agent =
    row.backend === "claude" ||
    row.backend === "codex" ||
    row.backend === "opencode" ||
    row.backend === "pi"
      ? row.backend
      : null;
  if (!agent)
    return {
      reason:
        "Only Claude Code, Codex, OpenCode and Pi sessions can be sent to another installation.",
    };
  if (!row.runtime_session_id || !row.transcript_path || !row.cwd)
    return { reason: "The session has no native transcript to move yet." };
  if (row.execution_host)
    return {
      reason:
        "Sending is supported for sessions on this server's own machine; SSH execution hosts are not supported yet.",
    };
  const runtime = hostRuntime(execHostFor(null));
  if (
    row.status === "running" &&
    row.pid &&
    agent !== "codex" &&
    (await runtime.processAlive(row.pid))
  )
    return { reason: "Wait for the agent to finish its turn before sending the session." };
  if (agent === "codex" && (await codexWriterOwned(runtime, row.runtime_session_id)))
    return { reason: "End the original Codex session before sending it." };
  const run = gitRunner(execHostFor(null));
  const root = await repoRoot(row.cwd, run);
  if (!root) return { reason: "The session folder is not inside a Git repository." };
  const origin = await run(["git", "-C", root, "remote", "get-url", "origin"]);
  if (origin.code !== 0 || !origin.stdout.trim())
    return {
      reason:
        "The repository has no origin remote. Both installations must reach the same Git remote.",
    };
  const repository = origin.stdout.trim();
  // Throws when an https URL carries credentials; the destination must fetch it without secrets.
  repositoryIdentity(repository);
  const current = await run(["git", "-C", root, "branch", "--show-current"]);
  const subdirectory = relative(await realpath(root), await realpath(row.cwd))
    .split(sep)
    .join("/");
  if (subdirectory.startsWith(".."))
    return { reason: "The session folder is outside its repository." };
  return {
    source: {
      agent,
      nativeId: row.runtime_session_id,
      cwd: row.cwd,
      root,
      subdirectory: subdirectory === "." ? "" : subdirectory,
      repository,
      branch: current.stdout.trim() || "(detached)",
      transcriptPath: row.transcript_path,
      runtime,
    },
  };
}

export async function sendPreview(id: string): Promise<SessionSendPreview> {
  const row = await liveRow(id);
  const { source, reason } = await resolveSource(row);
  return {
    eligible: !!source,
    reason: reason ?? null,
    agent: source?.agent ?? null,
    repository: source?.repository ?? null,
    remote: "origin",
    branch: source?.branch ?? null,
    cwd: source?.cwd ?? null,
    subdirectory: source?.subdirectory ?? "",
    title: row.display_title ?? row.title ?? null,
  };
}

/**
 * A snapshot commit through a temporary index: tracked and untracked work is
 * captured without touching the checkout's index or worktree, and secret-looking
 * files are left on this machine.
 */
async function snapshotCommit(
  runtime: HostRuntime,
  root: string,
): Promise<{ commit: string; leftBehind: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "orc-send-index-"));
  const env = {
    GIT_INDEX_FILE: join(dir, "index"),
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...SNAPSHOT_IDENTITY,
  };
  const git = (args: string[], timeoutMs = 30_000) =>
    runtime.exec(["git", "-C", root, ...args], { env, timeoutMs });
  try {
    const headResult = await git(["rev-parse", "--verify", "-q", "HEAD"]);
    const head = headResult.code === 0 ? headResult.stdout.trim() : "";
    if (head) {
      const read = await git(["read-tree", head]);
      if (read.code !== 0) throw gitError(read, "Could not read the current commit");
    }
    const added = await git(["add", "-A"], 120_000);
    if (added.code !== 0) throw gitError(added, "Could not stage the session's work");
    const listed = head
      ? await git(["diff", "--cached", "--name-only", head, "--", ...SECRET_PATHSPECS])
      : await git(["ls-files", "--cached", "--", ...SECRET_PATHSPECS]);
    if (listed.code !== 0) throw gitError(listed, "Could not check for secret files");
    const leftBehind = listed.stdout.split("\n").filter(Boolean);
    if (leftBehind.length) {
      const removed = head
        ? await git(["reset", "-q", head, "--", ...leftBehind])
        : await git(["rm", "--cached", "-q", "--", ...leftBehind]);
      if (removed.code !== 0) throw gitError(removed, "Could not keep secret files local");
    }
    const tree = await git(["write-tree"], 120_000);
    if (tree.code !== 0) throw gitError(tree, "Could not write the snapshot tree");
    const commit = await git([
      "commit-tree",
      tree.stdout.trim(),
      ...(head ? ["-p", head] : []),
      "-m",
      `orc: send-to snapshot from ${hostname()}`,
    ]);
    if (commit.code !== 0) throw gitError(commit, "Could not create the snapshot commit");
    return { commit: commit.stdout.trim(), leftBehind };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function stableRead(runtime: HostRuntime, backend: string, path: string): Promise<string> {
  const before = await runtime.stat(path);
  if (!before) throw new ValidationError(`Session file is missing: ${path}`);
  if (before.size > MAX_HANDOFF_BYTES)
    throw new ValidationError("The session transcript exceeds the 64 MiB handoff limit");
  const bytes = await loadTranscriptBytes(runtime, backend, path, null);
  const after = await runtime.stat(path);
  if (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new ConflictError(
      "The session changed during the snapshot; wait for it to be idle and retry",
    );
  return new TextDecoder().decode(bytes);
}

async function buildBundle(source: ResolvedSource): Promise<SessionBundle> {
  if (source.agent === "opencode") {
    const bundle = await exportOpenCodeSession(
      source.runtime,
      source.transcriptPath,
      source.nativeId,
    );
    if (new TextEncoder().encode(JSON.stringify(bundle)).length > MAX_HANDOFF_BYTES)
      throw new ValidationError("The session bundle exceeds the 64 MiB handoff limit");
    return bundle;
  }
  const files = [
    {
      path: "session.jsonl",
      content: await stableRead(source.runtime, source.agent, source.transcriptPath),
    },
  ];
  if (source.agent === "claude") {
    const sidecarDir = join(dirname(source.transcriptPath), source.nativeId, "subagents");
    if (await source.runtime.isDirectory(sidecarDir)) {
      const entries = await source.runtime.listFiles(sidecarDir, 129);
      for (const entry of entries) {
        const name = entry.path.split(/[\\/]/).pop() ?? "";
        if (!/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(name)) continue;
        if ((await lstat(entry.path)).isSymbolicLink())
          throw new ValidationError("Session sidecars must not be symbolic links");
        files.push({
          path: `subagents/${name}`,
          content: await stableRead(source.runtime, source.agent, entry.path),
        });
      }
    }
  }
  if (files.length > 128)
    throw new ValidationError("The session has too many sidecar files for one handoff");
  const bundle = SessionBundleSchema.parse({ version: 1, files });
  if (new TextEncoder().encode(JSON.stringify(bundle)).length > MAX_HANDOFF_BYTES)
    throw new ValidationError("The session bundle exceeds the 64 MiB handoff limit");
  return bundle;
}

function handoffBriefing(args: {
  source: ResolvedSource;
  hostLabel: string;
  project: string;
  branch: string;
  commit: string;
  leftBehind: string[];
  note: string;
}): string {
  return [
    `[ORC send-to] This session was moved from ${hostname()} (${args.source.cwd}) to ${args.hostLabel} (project ${args.project}) at ${new Date().toISOString()}.`,
    `Repo: branch ${args.branch}, snapshot ${args.commit.slice(0, 12)}, which includes the uncommitted and untracked work from the source machine.`,
    args.leftBehind.length
      ? `Not copied (secret files, still only on the source machine): ${args.leftBehind.join(", ")}.`
      : "No secret files were left behind.",
    "You are resuming on a different machine: installed dependencies, tools, environment variables, credentials and local services may differ or be missing. Check before relying on them (for example reinstall dependencies) and do not assume local-only paths exist.",
    ...(args.note ? ["", "Note from the handoff:", args.note] : []),
    "",
    "Acknowledge this briefing in one or two lines, then continue the work.",
  ].join("\n");
}

async function destinationFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, redirect: "error", signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new ValidationError(`The destination ORC did not respond in time: ${url}`);
    throw new ValidationError(`Could not reach the destination ORC at ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

async function destinationError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error.slice(0, 1000);
  } catch {
    // Non-JSON error bodies fall back to the status line.
  }
  return `HTTP ${response.status}`;
}

const sending = new Set<string>();

export async function sendSession(id: string, input: SessionSendRequest): Promise<SendRow> {
  const row = await liveRow(id);
  const { source, reason } = await resolveSource(row);
  if (!source) throw new ValidationError(reason ?? "This session cannot be sent.");
  if (sending.has(id)) throw new ConflictError("A send is already in progress for this session.");
  sending.add(id);
  const sendId = ulid();
  const db = getDb();
  await db.insert(session_sends).values({
    id: sendId,
    live_session_id: id,
    host_label: input.host_label,
    host_url: input.url,
    project: input.project,
    left_behind: [],
    status: "preparing",
  });
  const record = async (): Promise<SendRow> => {
    const found = await db.query.session_sends.findFirst({ where: eq(session_sends.id, sendId) });
    if (!found) throw new NotFoundError("Session send", sendId);
    return found;
  };
  const fail = async (error: unknown): Promise<SendRow> => {
    const message =
      error instanceof ValidationError || error instanceof ConflictError
        ? error.message
        : "The send failed; check the source server logs and retry";
    if (!(error instanceof ValidationError || error instanceof ConflictError))
      logger.error(`Send ${sendId} failed`, error);
    await db
      .update(session_sends)
      .set({ status: "error", error: message, updated_at: new Date() })
      .where(eq(session_sends.id, sendId));
    return record();
  };
  try {
    const { commit, leftBehind } = await snapshotCommit(source.runtime, source.root);
    const branch = `orc/send/${sendId}`;
    await db
      .update(session_sends)
      .set({ branch, commit, left_behind: leftBehind, updated_at: new Date() })
      .where(eq(session_sends.id, sendId));
    const pushed = await source.runtime.exec(
      ["git", "-C", source.root, "push", "origin", `${commit}:refs/heads/${branch}`],
      { env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, timeoutMs: 120_000 },
    );
    if (pushed.code !== 0) throw gitError(pushed, "Could not push the snapshot to origin");
    const bundle = await buildBundle(source);
    const briefing = handoffBriefing({
      source,
      hostLabel: input.host_label,
      project: input.project,
      branch: source.branch,
      commit,
      leftBehind,
      note: input.note,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Connection: "close",
    };
    for (const header of input.headers) headers[header.name] = header.value;
    if (input.token) headers.Authorization = `Bearer ${input.token}`;
    const request: SessionHandoffInput = {
      project: input.project,
      agent: source.agent,
      session_id: source.nativeId,
      source_cwd: source.cwd,
      subdirectory: source.subdirectory,
      repository: source.repository,
      remote: "origin",
      branch,
      commit,
      ...((row.display_title ?? row.title)
        ? { title: (row.display_title ?? row.title) as string }
        : {}),
      briefing,
    };
    const initiated = await destinationFetch(
      `${input.url}/api/session-handoffs`,
      { method: "POST", headers, body: JSON.stringify(request) },
      60_000,
    );
    if (!initiated.ok)
      throw new ValidationError(
        `The destination refused the handoff: ${await destinationError(initiated)}`,
      );
    const upload = SessionHandoffUploadSchema.parse(await initiated.json());
    const link = new URL(upload.upload_url);
    if (!HANDOFF_UPLOAD_PATH_PATTERN.test(link.pathname))
      throw new ValidationError("The destination returned an unexpected upload link");
    // The configured address is the reachable one; the link's own host may be
    // internal. Keep the single-use capability query intact.
    const uploadHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Connection: "close",
    };
    for (const header of input.headers) uploadHeaders[header.name] = header.value;
    const uploaded = await destinationFetch(
      `${input.url}${link.pathname}${link.search}`,
      { method: "PUT", headers: uploadHeaders, body: JSON.stringify(bundle) },
      300_000,
    );
    if (!uploaded.ok)
      throw new ValidationError(
        `The destination refused the session upload: ${await destinationError(uploaded)}`,
      );
    const handoff = SessionHandoffSchema.parse(await uploaded.json());
    if (handoff.status !== "ready")
      throw new ValidationError(
        handoff.error ??
          "The destination could not prepare the session; inspect it there and retry",
      );
    await db
      .update(session_sends)
      .set({
        status: "ready",
        handoff_id: handoff.id,
        remote_session_id: handoff.live_session_id,
        error: null,
        updated_at: new Date(),
      })
      .where(eq(session_sends.id, sendId));
    return record();
  } catch (error) {
    return fail(error);
  } finally {
    sending.delete(id);
  }
}

export async function listSends(id: string): Promise<SendRow[]> {
  await liveRow(id);
  return getDb().query.session_sends.findMany({
    where: eq(session_sends.live_session_id, id),
    orderBy: [desc(session_sends.created_at)],
    limit: 50,
  });
}

/** Latest send per session, for the live-session list badge. */
export async function latestSendsFor(ids: string[]): Promise<Map<string, SendRow>> {
  if (!ids.length) return new Map();
  const rows = await getDb().query.session_sends.findMany({
    where: inArray(session_sends.live_session_id, ids),
    orderBy: [desc(session_sends.created_at)],
  });
  const bySession = new Map<string, SendRow>();
  for (const row of rows)
    if (!bySession.has(row.live_session_id)) bySession.set(row.live_session_id, row);
  return bySession;
}
