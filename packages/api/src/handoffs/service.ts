import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from "@orc/core/errors";
import {
  type ExecHost,
  execHostFor,
  type HostRuntime,
  hostExec,
  hostRuntime,
  resolveExecHost,
} from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import {
  HANDOFF_TTL_MS,
  type SessionBundle,
  SessionBundleSchema,
  type SessionHandoff,
  type SessionHandoffRequest,
} from "@orc/core/session-handoff";
import { getDb } from "@orc/db/client";
import { bridge_chats, gateway_sessions, projects, session_handoffs } from "@orc/db/schema";
import { and, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { LIVE_CHAT_ID } from "../sessions/common.js";
import { handoffAdapters } from "./adapters.js";
import { prepareHandoffWorktree, validateHandoffRepo, verifyHandoffWorktree } from "./git.js";

type HandoffRow = typeof session_handoffs.$inferSelect;
const logger = createLogger("api:handoff");

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function handoffDto(row: HandoffRow): SessionHandoff {
  return {
    id: row.id,
    project_id: row.project_id,
    agent: row.request.agent,
    source_session_id: row.request.session_id,
    session_id: row.session_id,
    host: row.execution_host,
    branch: row.request.branch,
    commit: row.request.commit,
    status: row.status,
    cwd: row.cwd,
    live_session_id: row.live_session_id,
    error: row.error,
    expires_at: row.expires_at.toISOString(),
  };
}

const PRIVATE_WRITE_SCRIPT = `import json, os, sys
data = json.load(sys.stdin)
path = data['path']
os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
content = data['content'].encode('utf-8')
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    if os.path.islink(path) or open(path, 'rb').read() != content:
        sys.exit(3)
else:
    with os.fdopen(fd, 'wb') as f:
        f.write(content)
`;

async function writePrivateFile(host: ExecHost, path: string, content: string): Promise<void> {
  if (host.kind === "local") {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await lstat(path)).isSymbolicLink() || (await readFile(path, "utf8")) !== content)
        throw new ConflictError("Imported session file already exists with different contents");
    }
    return;
  }
  const result = await hostExec(host, ["python3", "-c", PRIVATE_WRITE_SCRIPT], {
    input: JSON.stringify({ path, content }),
    timeoutMs: 30_000,
    login: false,
  });
  if (result.code !== 0)
    throw new ConflictError("Could not install the session file on the selected execution host");
}

export interface HandoffServiceOptions {
  storageRoot?: string;
  runtimeFor?: (host: ExecHost) => HostRuntime;
  nativeRootFor?: (
    host: ExecHost,
    agent: "claude" | "codex",
    runtime: HostRuntime,
  ) => Promise<string>;
}

async function nativeRootFor(
  host: ExecHost,
  agent: "claude" | "codex",
  runtime: HostRuntime,
): Promise<string> {
  const home = await runtime.home();
  const fallback = (host.kind === "ssh" || home.startsWith("/") ? posix : win32).join(
    home,
    `.${agent}`,
  );
  const variable = agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  if (host.kind === "local") return process.env[variable] || fallback;
  const result = await runtime.exec(
    [
      "python3",
      "-c",
      "import os,sys; print(os.path.expanduser(os.environ.get(sys.argv[1]) or sys.argv[2]))",
      variable,
      fallback,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0 || !result.stdout.trim().startsWith("/"))
    throw new ValidationError("Could not resolve the destination agent's native storage");
  return result.stdout.trim();
}

async function checkContainedDirectory(host: ExecHost, root: string, cwd: string): Promise<void> {
  if (host.kind === "local") {
    const paths = root.startsWith("/") ? posix : win32;
    const relative = paths.relative(await realpath(root), await realpath(cwd));
    if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
      throw new ValidationError("Repository subdirectory escapes the handoff worktree");
    return;
  }
  const result = await hostExec(
    host,
    [
      "python3",
      "-c",
      "import os,sys; root=os.path.realpath(sys.argv[1]); cwd=os.path.realpath(sys.argv[2]); sys.exit(0 if os.path.commonpath([root,cwd]) == root else 3)",
      root,
      cwd,
    ],
    { timeoutMs: 30_000, login: false },
  );
  if (result.code !== 0)
    throw new ValidationError("Repository subdirectory escapes the handoff worktree");
}

export class HandoffService {
  private readonly locks = new Set<string>();
  private readonly runtimeFor: (host: ExecHost) => HostRuntime;
  private readonly storageRoot: string;
  private readonly nativeRootFor: NonNullable<HandoffServiceOptions["nativeRootFor"]>;

  constructor(options: HandoffServiceOptions = {}) {
    this.storageRoot = options.storageRoot ?? join(homedir(), ".orc", "handoffs");
    this.runtimeFor = options.runtimeFor ?? hostRuntime;
    this.nativeRootFor = options.nativeRootFor ?? nativeRootFor;
  }

  async get(id: string): Promise<HandoffRow> {
    const row = await getDb().query.session_handoffs.findFirst({
      where: eq(session_handoffs.id, id),
    });
    if (!row) throw new NotFoundError("Session handoff", id);
    return row;
  }

  async create(request: SessionHandoffRequest): Promise<{ row: HandoffRow; token: string }> {
    const project = await getDb().query.projects.findFirst({
      where: sql`lower(${projects.name}) = lower(${request.project})`,
    });
    if (!project) throw new NotFoundError("Project", request.project);
    if (!project.scope)
      throw new ValidationError(
        "Set the project's folder scope to its repository on the execution host first",
      );
    const host = resolveExecHost();
    const root = await validateHandoffRepo(host, project.scope, request);
    const runtime = this.runtimeFor(host);
    if (!(await runtime.binary(request.agent)))
      throw new ValidationError("The requested agent CLI is unavailable on the execution host");
    const id = ulid();
    const token = randomBytes(32).toString("base64url");
    await getDb()
      .insert(session_handoffs)
      .values({
        id,
        request,
        project_id: project.id,
        session_id: randomUUID(),
        execution_host: host.kind === "ssh" ? host.alias : null,
        repo_root: root,
        token_hash: tokenHash(token),
        status: "pending",
        expires_at: new Date(Date.now() + HANDOFF_TTL_MS),
      });
    return { row: await this.get(id), token };
  }

  async authorizeUpload(id: string, token: string): Promise<HandoffRow> {
    const row = await this.get(id);
    const actual = Buffer.from(tokenHash(token), "hex");
    const expected = Buffer.from(row.token_hash ?? "", "hex");
    if (
      row.status !== "pending" ||
      row.expires_at.getTime() <= Date.now() ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    )
      throw new UnauthorizedError("Upload link is invalid, expired or already used");
    return row;
  }

  async upload(id: string, token: string, bundle: SessionBundle): Promise<HandoffRow> {
    const row = await this.authorizeUpload(id, token);
    handoffAdapters[row.request.agent].validate(bundle, row.request);
    const claimed = await getDb()
      .update(session_handoffs)
      .set({ status: "uploading", token_hash: null, updated_at: new Date() })
      .where(
        and(
          eq(session_handoffs.id, id),
          eq(session_handoffs.status, "pending"),
          eq(session_handoffs.token_hash, row.token_hash as string),
          gt(session_handoffs.expires_at, new Date()),
        ),
      )
      .returning();
    if (!claimed.length) throw new UnauthorizedError("Upload link is already used");
    try {
      await writePrivateFile(
        { kind: "local" },
        join(this.storageRoot, id, "bundle.json"),
        JSON.stringify(bundle),
      );
      await getDb()
        .update(session_handoffs)
        .set({ status: "uploaded", updated_at: new Date() })
        .where(eq(session_handoffs.id, id));
      return await this.prepare(id);
    } catch (error) {
      await this.fail(id, error);
      return this.get(id);
    }
  }

  private async fail(id: string, error: unknown): Promise<void> {
    if (!(error instanceof ValidationError || error instanceof ConflictError))
      logger.error(`Handoff ${id} preparation failed`, error);
    const message =
      error instanceof ValidationError || error instanceof ConflictError
        ? error.message
        : "Session preparation failed; check server logs and retry";
    await getDb()
      .update(session_handoffs)
      .set({ status: "error", error: message, updated_at: new Date() })
      .where(eq(session_handoffs.id, id));
  }

  async prepare(id: string): Promise<HandoffRow> {
    const row = await this.get(id);
    if (row.status === "ready" || row.status === "resumed") return row;
    if (
      row.status === "pending" ||
      (row.status === "uploading" && row.updated_at.getTime() > Date.now() - 5 * 60 * 1000)
    )
      throw new ConflictError("Upload must finish before preparation");
    if (this.locks.has(id)) throw new ConflictError("Handoff preparation is already in progress");
    const claimed = await getDb()
      .update(session_handoffs)
      .set({ status: "preparing", error: null, updated_at: new Date() })
      .where(
        and(
          eq(session_handoffs.id, id),
          or(
            inArray(session_handoffs.status, ["uploaded", "error"]),
            and(
              inArray(session_handoffs.status, ["preparing", "uploading"]),
              lt(session_handoffs.updated_at, new Date(Date.now() - 5 * 60 * 1000)),
            ),
          ),
        ),
      )
      .returning();
    if (!claimed.length)
      throw new ConflictError(
        "Handoff preparation is already in progress; interrupted preparation can be retried after five minutes",
      );
    this.locks.add(id);
    try {
      const bundle = SessionBundleSchema.parse(
        JSON.parse(await readFile(join(this.storageRoot, id, "bundle.json"), "utf8")),
      );
      const adapter = handoffAdapters[row.request.agent];
      adapter.validate(bundle, row.request);
      const host = execHostFor(row.execution_host);
      const runtime = this.runtimeFor(host);
      const worktree = await prepareHandoffWorktree(host, row.repo_root, id, row.request);
      const paths = host.kind === "ssh" || worktree.startsWith("/") ? posix : win32;
      const cwd = row.request.subdirectory
        ? paths.join(worktree, row.request.subdirectory)
        : worktree;
      if (!(await runtime.isDirectory(cwd)))
        throw new ValidationError(
          "Reported repository subdirectory is missing in the pushed commit",
        );
      await checkContainedDirectory(host, worktree, cwd);
      const files = adapter.installFiles(
        bundle,
        row.request,
        row.session_id,
        cwd,
        await runtime.home(),
        row.created_at,
        await this.nativeRootFor(host, row.request.agent, runtime),
      );
      for (const file of files) await writePrivateFile(host, file.path, file.content);
      const liveId = row.live_session_id ?? row.id;
      const db = getDb();
      db.transaction((tx) => {
        tx.insert(bridge_chats)
          .values({ id: LIVE_CHAT_ID, platform: "telegram", chat_id: "live" })
          .onConflictDoNothing()
          .run();
        tx.insert(gateway_sessions)
          .values({
            id: liveId,
            chat_id: LIVE_CHAT_ID,
            backend: row.request.agent,
            mode: "direct",
            runtime_session_id: row.session_id,
            execution_host: row.execution_host,
            cwd,
            project_id: row.project_id,
            status: "stopped",
            title: row.request.title ?? `Handoff: ${row.request.project} / ${row.request.branch}`,
            summary: `Imported from ${row.request.source_cwd}; branch ${row.request.branch} at ${row.request.commit}`,
            transcript_path: files[0]?.path ?? null,
            last_activity_at: new Date(),
          })
          .onConflictDoNothing()
          .run();
        tx.update(session_handoffs)
          .set({
            status: "ready",
            cwd,
            live_session_id: liveId,
            error: null,
            updated_at: new Date(),
          })
          .where(eq(session_handoffs.id, id))
          .run();
      });
      return this.get(id);
    } catch (error) {
      await this.fail(id, error);
      throw error;
    } finally {
      this.locks.delete(id);
    }
  }

  async verifyResume(liveSessionId: string): Promise<boolean> {
    const row = await getDb().query.session_handoffs.findFirst({
      where: eq(session_handoffs.live_session_id, liveSessionId),
    });
    if (!row) return false;
    if (!["ready", "resumed"].includes(row.status) || !row.cwd)
      throw new ConflictError("Handoff is not ready to resume");
    if (row.status === "ready")
      await verifyHandoffWorktree(execHostFor(row.execution_host), row.cwd, row.request.commit);
    const live = await getDb().query.gateway_sessions.findFirst({
      where: eq(gateway_sessions.id, liveSessionId),
    });
    if (
      !live?.transcript_path ||
      !(await this.runtimeFor(execHostFor(row.execution_host)).isFile(live.transcript_path))
    )
      throw new ConflictError("Imported session file is missing from its execution host");
    return true;
  }

  async markResumed(liveSessionId: string): Promise<void> {
    await getDb()
      .update(session_handoffs)
      .set({ status: "resumed", updated_at: new Date() })
      .where(
        and(
          eq(session_handoffs.live_session_id, liveSessionId),
          eq(session_handoffs.status, "ready"),
        ),
      );
  }
}

let service: HandoffService | null = null;

export function getHandoffService(): HandoffService {
  service ??= new HandoffService();
  return service;
}

export function setHandoffService(next: HandoffService | null): void {
  service = next;
}
