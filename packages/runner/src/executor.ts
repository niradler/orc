import {
  execHostFor,
  type HostProcess,
  hostExec,
  hostPlatform,
  hostSpawn,
  resolveExecHost,
} from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import { resolveJobEnvironment } from "@orc/core/job-environment";
import { jobShellArgv } from "@orc/core/job-settings";
import { createLogger } from "@orc/core/logger";
import { AuditLog } from "@orc/db/audit";
import { getDb, getSqlite } from "@orc/db/client";
import { kbDigestKbId } from "@orc/db/kb-digest";
import { publishJobNotification } from "@orc/db/notification-producers";
import { job_run_logs, job_runs, jobs, sessions } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { runJobAction } from "./job-actions.js";
import { runKbDigest } from "./kb-digest.js";
import { workspaceEnvFor } from "./workspace-env.js";

const logger = createLogger("runner:executor");
const LOG_FLUSH_MS = 250;
const LOG_FLUSH_LINES = 200;

export type RunOptions = {
  jobId: string;
  runId?: string;
  triggerBy?: string;
  envOverrides?: Record<string, string>;
  input?: { stdin: string; env?: Record<string, string> };
  execution?: {
    argv: string[];
    stdin: string;
    timeout_ms: number;
    cwd: string;
  };
};

export async function executeJob(opts: RunOptions): Promise<string> {
  const db = getDb();
  const runId = opts.runId ?? ulid();
  // The API trigger path pre-creates the run row as "pending" before calling
  // us, so a row to mark "failed" exists even if setup below throws.
  let runRowExists = Boolean(opts.runId);
  let redact = (text: string): string => text;

  const mutateRun = (mutation: () => unknown): void => {
    const sqlite = getSqlite(db);
    sqlite
      .transaction(() => {
        const previous = sqlite
          .query<{ status: string }, [string]>("SELECT status FROM job_runs WHERE id=?")
          .get(runId);
        mutation();
        const row = sqlite
          .query<
            { status: string; job_id: string; project_id: string | null; exit_code: number | null },
            [string]
          >(
            "SELECT r.status,r.job_id,j.project_id,r.exit_code FROM job_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=?",
          )
          .get(runId);
        if (!row || row.status === previous?.status) return;
        if (!["running", "success", "failed", "timeout"].includes(row.status)) return;
        new AuditLog(sqlite).record({
          action: row.status === "running" ? "job_run.started" : `job_run.${row.status}`,
          subject_ids: [runId],
          project_id: row.project_id,
          snapshot: { job_id: row.job_id, status: row.status, exit_code: row.exit_code },
        });
      })
      .immediate();
  };

  try {
    const job = await db.query.jobs.findFirst({
      where: eq(jobs.id, opts.jobId),
    });
    if (!job) throw new Error(`Job not found: ${opts.jobId}`);
    if (opts.triggerBy?.startsWith("webhook:") && !job.enabled) throw new Error("Job is disabled");

    const now = new Date();

    if (opts.runId) {
      mutateRun(() =>
        db
          .update(job_runs)
          .set({ status: "running", started_at: now })
          .where(eq(job_runs.id, runId))
          .run(),
      );
    } else {
      mutateRun(() =>
        db
          .insert(job_runs)
          .values({
            id: runId,
            job_id: job.id,
            status: "running",
            trigger_by: opts.triggerBy ?? "manual",
            started_at: now,
            created_at: now,
          })
          .run(),
      );
      runRowExists = true;
    }

    await db
      .update(jobs)
      .set({ last_run_at: now, run_count: job.run_count + 1, updated_at: now })
      .where(eq(jobs.id, job.id));

    logger.info(`Starting job: ${job.name} [${runId}]`);

    // A KB digest job names its knowledge base; it starts the digest agent, never a shell.
    const digestKbId = kbDigestKbId(job.command);
    if (digestKbId) {
      const summary = await runKbDigest(digestKbId, {
        runId,
        triggerBy: opts.triggerBy ?? "manual",
        timeoutMs: (job.timeout_secs ?? 1800) * 1000,
      });
      mutateRun(() =>
        db
          .update(job_runs)
          .set({ status: "success", ended_at: new Date(), exit_code: 0, stdout: summary })
          .where(eq(job_runs.id, runId))
          .run(),
      );
      return runId;
    }

    const environment = resolveJobEnvironment(job.environment);
    redact = environment.redact;
    const jobEnv = {
      ...(job.env_vars ?? {}),
      ...(opts.input?.env ?? {}),
      ...(opts.envOverrides ?? {}),
      ...environment.env,
      ORC_JOB_RUN_ID: runId,
    };

    if (job.action && job.action.type !== "command") {
      const output = await runJobAction(
        job,
        job.action,
        runId,
        opts.input?.stdin,
        jobEnv,
        redact,
        environment.createRedactor(),
      );
      await db
        .insert(job_run_logs)
        .values({ run_id: runId, ts: new Date(), stream: "stdout", line: output });
      mutateRun(() =>
        db
          .update(job_runs)
          .set({ status: "success", ended_at: new Date(), exit_code: 0, stdout: output })
          .where(eq(job_runs.id, runId))
          .run(),
      );
      return runId;
    }

    const stdin = opts.execution?.stdin ?? opts.input?.stdin;
    const stdinBytes = stdin === undefined ? "ignore" : new TextEncoder().encode(stdin);

    const timeout = opts.execution?.timeout_ms ?? (job.timeout_secs ?? 300) * 1000;

    const host = opts.execution
      ? null
      : job.settings?.host === undefined
        ? resolveExecHost()
        : execHostFor(job.settings.host);
    const projectDirectory =
      job.settings && job.settings.inherit_project_directory !== false && job.project_id
        ? getSqlite()
            .query<{ scope: string | null }, [string]>("SELECT scope FROM projects WHERE id=?")
            .get(job.project_id)?.scope
        : undefined;
    const commandDirectory = job.working_dir ?? projectDirectory ?? undefined;
    // Project settings only apply to the job's folder, and a managed worktree is
    // installed before the command starts. Job variables still win over them.
    const projectWorkspace =
      host && commandDirectory
        ? await workspaceEnvFor(host, commandDirectory, job.project_id)
        : { env: {} };
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...projectWorkspace.env,
      ...jobEnv,
    };
    const argv =
      opts.execution?.argv ??
      jobShellArgv(job.settings, job.command, host ? hostPlatform(host) : process.platform);
    if (!opts.execution && host) {
      const available =
        host.kind === "local"
          ? Boolean(
              Bun.which(argv[0] ?? "", {
                PATH:
                  Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ??
                  process.env.PATH ??
                  "",
              }),
            )
          : (
              await hostExec(host, ["sh", "-c", 'command -v "$1"', "sh", argv[0] ?? ""], {
                timeoutMs: 10000,
              })
            ).code === 0;
      if (!available) throw new Error("Configured shell is not available on the selected host");
    }
    let handle: HostProcess;
    if (host?.kind === "ssh") {
      handle = await hostSpawn(host, argv, {
        cwd: commandDirectory,
        env,
        passEnv: [
          "ORC_JOB_RUN_ID",
          ...Object.keys(projectWorkspace.env),
          ...Object.keys(jobEnv),
          ...Object.keys(opts.input?.env ?? {}),
          ...Object.keys(opts.envOverrides ?? {}),
        ],
        stdin: stdinBytes,
      });
    } else {
      const local = Bun.spawn({
        cmd: argv,
        cwd: opts.execution?.cwd ?? commandDirectory ?? process.cwd(),
        env: env as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
        stdin: stdinBytes,
        timeout,
        killSignal: "SIGKILL",
        windowsHide: true,
      });
      handle = { proc: local, kill: () => local.kill() };
    }
    const proc = handle.proc;

    const MAX_STREAM_BYTES = opts.execution ? 65536 : 100 * 1024 * 1024;
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutCapped = false;
    let stderrCapped = false;
    type LogEntry = typeof job_run_logs.$inferInsert;
    // Lines are saved while the job runs so readers see output live, batched to bound the
    // write and change-event rate of a chatty job.
    let pendingLogs: LogEntry[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let flushing: Promise<void> = Promise.resolve();
    let runGone = false;
    const flushLogs = (): Promise<void> => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      const batch = pendingLogs;
      pendingLogs = [];
      if (!batch.length || runGone) return flushing;
      flushing = flushing.then(async () => {
        try {
          await db.insert(job_run_logs).values(batch);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("FOREIGN KEY")) throw err;
          runGone = true;
        }
      });
      return flushing;
    };
    const recordLog = (entry: LogEntry): void => {
      pendingLogs.push(entry);
      if (pendingLogs.length >= LOG_FLUSH_LINES) void flushLogs().catch(() => {});
      else if (!flushTimer)
        flushTimer = setTimeout(() => void flushLogs().catch(() => {}), LOG_FLUSH_MS);
    };

    const timeoutHandle = setTimeout(() => handle.kill(), timeout);

    const readStream = async (reader: ReadableStream<Uint8Array>, stream: "stdout" | "stderr") => {
      const dec = new TextDecoder();
      let buf = "";
      let receivedBytes = 0;
      const redactor = environment.createRedactor();
      const encoder = new TextEncoder();
      const safeDecoder = new TextDecoder();
      const accept = (text: string): void => {
        const remaining = Math.max(0, MAX_STREAM_BYTES - receivedBytes);
        if (!remaining) return;
        const bytes = encoder.encode(text);
        let length = Math.min(bytes.length, remaining);
        if (length < bytes.length) {
          while (length > 0 && ((bytes[length] ?? 0) & 0xc0) === 0x80) length--;
          receivedBytes = MAX_STREAM_BYTES;
        } else receivedBytes += length;
        buf += safeDecoder.decode(bytes.subarray(0, length));
      };
      for await (const chunk of reader) {
        accept(redactor.write(dec.decode(chunk, { stream: true })));
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine;
          if (stream === "stdout") {
            if (stdoutBytes < MAX_STREAM_BYTES) {
              stdoutLines.push(line);
              stdoutBytes += line.length;
              recordLog({ run_id: runId, ts: new Date(), stream, line });
            } else if (!stdoutCapped) {
              stdoutCapped = true;
              logger.warn(
                `Job ${job.name} [${runId}] stdout exceeded output limit — dropping remaining output`,
              );
            }
          } else {
            if (stderrBytes < MAX_STREAM_BYTES) {
              stderrLines.push(line);
              stderrBytes += line.length;
              recordLog({ run_id: runId, ts: new Date(), stream, line });
            } else if (!stderrCapped) {
              stderrCapped = true;
              logger.warn(
                `Job ${job.name} [${runId}] stderr exceeded output limit — dropping remaining output`,
              );
            }
          }
        }
      }
      accept(redactor.write(dec.decode()));
      accept(redactor.finish());
      if (buf) {
        const line = buf.slice(
          0,
          Math.max(0, MAX_STREAM_BYTES - (stream === "stdout" ? stdoutBytes : stderrBytes)),
        );
        if (stream === "stdout") stdoutLines.push(line);
        else stderrLines.push(line);
        if (line) recordLog({ run_id: runId, ts: new Date(), stream, line });
      }
    };

    await Promise.all([
      readStream(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
      readStream(proc.stderr as ReadableStream<Uint8Array>, "stderr"),
      proc.exited,
    ]);

    clearTimeout(timeoutHandle);

    const exitCode = proc.exitCode ?? -1;
    const endedAt = new Date();
    const success = exitCode === 0;

    try {
      await flushLogs();
      if (runGone) {
        logger.warn(`Job run ${runId} was deleted during execution, skipping write-back`);
        return runId;
      }

      mutateRun(() =>
        db
          .update(job_runs)
          .set({
            status: success ? "success" : "failed",
            exit_code: exitCode,
            ended_at: endedAt,
            stdout: stdoutLines.join("\n").slice(0, 65536),
            stderr: stderrLines.join("\n").slice(0, 16384),
          })
          .where(eq(job_runs.id, runId))
          .run(),
      );

      const durSecs = Math.round((endedAt.getTime() - now.getTime()) / 1000);
      await db.insert(sessions).values({
        id: ulid(),
        agent: "runner",
        summary: `Job "${job.name}" ${success ? "succeeded" : "failed"} in ${durSecs}s (exit ${exitCode})`,
        job_run_id: runId,
        created_at: endedAt,
      });
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      if (msg.includes("FOREIGN KEY")) {
        logger.warn(`Job run ${runId} was deleted during execution, skipping write-back`);
        return runId;
      }
      throw writeErr;
    }

    logger.info(
      `Job ${job.name} [${runId}] ${success ? "succeeded" : "failed"} (exit ${exitCode})`,
    );
    return runId;
  } catch (err) {
    const msg = redact(err instanceof Error ? err.message : String(err));
    // Resolve the run so it never dangles in "pending"/"running". The write-back
    // can itself fail (e.g. the run row was deleted, or the DB is shutting down),
    // so guard it — a failed status update must not mask the original error.
    if (runRowExists) {
      try {
        mutateRun(() =>
          db
            .update(job_runs)
            .set({ status: "failed", ended_at: new Date(), error_msg: msg })
            .where(eq(job_runs.id, runId))
            .run(),
        );
      } catch (markErr) {
        const markMsg = markErr instanceof Error ? markErr.message : String(markErr);
        logger.error(`Failed to mark run ${runId} as failed: ${markMsg}`);
      }
    }
    logger.error(`Job run ${runId} crashed: ${msg}`);
    throw new Error(msg);
  } finally {
    if (runRowExists) {
      try {
        publishJobNotification(getSqlite(db), runId);
      } catch (error) {
        logger.error("Could not record job notification", error);
      }
    }
  }
}
