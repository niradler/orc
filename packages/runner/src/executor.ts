import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { job_run_logs, job_runs, jobs, sessions } from "@orc/db/schema";
import { eq } from "drizzle-orm";

const logger = createLogger("runner:executor");

export type RunOptions = {
  jobId: string;
  runId?: string;
  triggerBy?: string;
  envOverrides?: Record<string, string>;
};

export async function executeJob(opts: RunOptions): Promise<string> {
  const db = getDb();
  const runId = opts.runId ?? ulid();
  // The API trigger path pre-creates the run row as "pending" before calling
  // us, so a row to mark "failed" exists even if setup below throws.
  let runRowExists = Boolean(opts.runId);

  try {
    const job = await db.query.jobs.findFirst({ where: eq(jobs.id, opts.jobId) });
    if (!job) throw new Error(`Job not found: ${opts.jobId}`);

    const now = new Date();

    if (opts.runId) {
      await db
        .update(job_runs)
        .set({ status: "running", started_at: now })
        .where(eq(job_runs.id, runId));
    } else {
      await db.insert(job_runs).values({
        id: runId,
        job_id: job.id,
        status: "running",
        trigger_by: opts.triggerBy ?? "manual",
        started_at: now,
        created_at: now,
      });
      runRowExists = true;
    }

    await db
      .update(jobs)
      .set({ last_run_at: now, run_count: job.run_count + 1, updated_at: now })
      .where(eq(jobs.id, job.id));

    logger.info(`Starting job: ${job.name} [${runId}]`);

    const env = {
      ...process.env,
      ORC_JOB_RUN_ID: runId,
      ...(job.env_vars ?? {}),
      ...(opts.envOverrides ?? {}),
    };

    const timeout = (job.timeout_secs ?? 300) * 1000;

    const proc = Bun.spawn({
      cmd: ["sh", "-c", job.command],
      cwd: job.working_dir ?? process.cwd(),
      env: env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });

    const MAX_STREAM_BYTES = 100 * 1024 * 1024; // 100 MB per stream
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutCapped = false;
    let stderrCapped = false;
    const logEntries: Array<{
      run_id: string;
      ts: Date;
      stream: "stdout" | "stderr";
      line: string;
    }> = [];

    const timeoutHandle = setTimeout(() => proc.kill(), timeout);

    const readStream = async (reader: ReadableStream<Uint8Array>, stream: "stdout" | "stderr") => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of reader) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (stream === "stdout") {
            if (stdoutBytes < MAX_STREAM_BYTES) {
              stdoutLines.push(line);
              stdoutBytes += line.length;
              logEntries.push({ run_id: runId, ts: new Date(), stream, line });
            } else if (!stdoutCapped) {
              stdoutCapped = true;
              logger.warn(
                `Job ${job.name} [${runId}] stdout exceeded 100 MB — dropping remaining output`,
              );
            }
          } else {
            if (stderrBytes < MAX_STREAM_BYTES) {
              stderrLines.push(line);
              stderrBytes += line.length;
              logEntries.push({ run_id: runId, ts: new Date(), stream, line });
            } else if (!stderrCapped) {
              stderrCapped = true;
              logger.warn(
                `Job ${job.name} [${runId}] stderr exceeded 100 MB — dropping remaining output`,
              );
            }
          }
        }
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
      if (logEntries.length > 0) {
        await db.insert(job_run_logs).values(logEntries);
      }

      await db
        .update(job_runs)
        .set({
          status: success ? "success" : "failed",
          exit_code: exitCode,
          ended_at: endedAt,
          stdout: stdoutLines.join("\n").slice(0, 65536),
          stderr: stderrLines.join("\n").slice(0, 16384),
        })
        .where(eq(job_runs.id, runId));

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
    const msg = err instanceof Error ? err.message : String(err);
    // Resolve the run so it never dangles in "pending"/"running". The write-back
    // can itself fail (e.g. the run row was deleted, or the DB is shutting down),
    // so guard it — a failed status update must not mask the original error.
    if (runRowExists) {
      try {
        await db
          .update(job_runs)
          .set({ status: "failed", ended_at: new Date(), error_msg: msg })
          .where(eq(job_runs.id, runId));
      } catch (markErr) {
        const markMsg = markErr instanceof Error ? markErr.message : String(markErr);
        logger.error(`Failed to mark run ${runId} as failed: ${markMsg}`);
      }
    }
    logger.error(`Job run ${runId} crashed: ${msg}`);
    throw err;
  }
}
