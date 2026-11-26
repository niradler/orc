import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { isProcessAlive } from "./daemon-runtime.js";
import { orcHome } from "./home.js";
import { ulid } from "./ids.js";

export const BackgroundJobStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "stopped",
  "interrupted_by_restart",
]);
export type BackgroundJobStatus = z.infer<typeof BackgroundJobStatusSchema>;

export const BackgroundJobRecordSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(200).nullable().default(null),
  command: z.string().min(1).max(16_000),
  cwd: z.string().min(1),
  session_id: z.string().max(200).nullable().default(null),
  project_id: z.string().max(200).nullable().default(null),
  status: BackgroundJobStatusSchema,
  pid: z.number().int().positive().nullable(),
  started_at: z.number().int().nonnegative(),
  finished_at: z.number().int().nonnegative().nullable().default(null),
  exit_code: z.number().int().nullable().default(null),
  signal: z.string().max(32).nullable().default(null),
  error: z.string().max(2000).nullable().default(null),
  log_path: z.string().min(1),
});
export type BackgroundJobRecord = z.infer<typeof BackgroundJobRecordSchema>;

export const BackgroundJobStartSchema = z
  .object({
    command: z.string().trim().min(1).max(16_000),
    cwd: z.string().trim().min(1),
    label: z.string().trim().min(1).max(200).optional(),
    session_id: z.string().trim().min(1).max(200).optional(),
    project_id: z.string().trim().min(1).max(200).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BackgroundJobStartInput = z.infer<typeof BackgroundJobStartSchema>;

const ExitFileSchema = z.object({
  exit_code: z.number().int().nullable(),
  signal: z.string().max(32).nullable().optional(),
  finished_at: z.number().int().nonnegative().optional(),
});

const JOB_ID_RE = /^[0-9A-Za-z_-]{4,64}$/;
const DEFAULT_TAIL_BYTES = 16_384;
const MAX_TAIL_BYTES = 256_000;
const MAX_TAIL_LINES = 2000;
const BLOCKED_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
]);

const POSIX_WRAPPER = [
  "cmd=$1",
  "log=$2",
  "exit_file=$3",
  'exec >>"$log" 2>&1',
  '/bin/sh -c "$cmd" &',
  "child=$!",
  'sig=""',
  'trap \'sig="SIGTERM"; kill -TERM "$child" 2>/dev/null || true\' TERM',
  'trap \'sig="SIGINT"; kill -INT "$child" 2>/dev/null || true\' INT',
  'wait "$child"',
  "code=$?",
  'if [ -n "$sig" ]; then wait "$child" 2>/dev/null || true; fi',
  "ts=$(date +%s 2>/dev/null || true)",
  'case "$ts" in ""|0|*[!0-9]*) ms=0 ;; *) ms="$ts"000 ;; esac',
  'tmp="$exit_file.tmp.$$"',
  'if [ -n "$sig" ]; then',
  '  printf \'{"exit_code":%d,"signal":"%s","finished_at":%s}\\n\' "$code" "$sig" "$ms" >"$tmp"',
  "else",
  '  printf \'{"exit_code":%d,"signal":null,"finished_at":%s}\\n\' "$code" "$ms" >"$tmp"',
  "fi",
  'mv -f "$tmp" "$exit_file"',
  'exit "$code"',
].join("\n");

const WIN32_PS_WRAPPER = [
  "$cmd = $env:ORC_BG_CMD",
  "$log = $env:ORC_BG_LOG",
  "$exitFile = $env:ORC_BG_EXIT",
  "Remove-Item Env:ORC_BG_CMD,Env:ORC_BG_LOG,Env:ORC_BG_EXIT -ErrorAction SilentlyContinue",
  "$utf8 = New-Object System.Text.UTF8Encoding($false)",
  "$code = 1",
  "$fsOut = $null",
  "$fsErr = $null",
  "$proc = $null",
  "try {",
  "  $fsOut = New-Object System.IO.FileStream($log, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite, 1)",
  "  $fsErr = New-Object System.IO.FileStream($log, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite, 1)",
  "  $psi = New-Object System.Diagnostics.ProcessStartInfo",
  "  $psi.FileName = 'cmd.exe'",
  `  $psi.Arguments = '/d /s /c "' + $cmd + '"'`,
  "  $psi.WorkingDirectory = (Get-Location).ProviderPath",
  "  $psi.UseShellExecute = $false",
  "  $psi.CreateNoWindow = $true",
  "  $psi.RedirectStandardOutput = $true",
  "  $psi.RedirectStandardError = $true",
  "  $proc = New-Object System.Diagnostics.Process",
  "  $proc.StartInfo = $psi",
  "  [void]$proc.Start()",
  "  $tOut = $proc.StandardOutput.BaseStream.CopyToAsync($fsOut, 4096)",
  "  $tErr = $proc.StandardError.BaseStream.CopyToAsync($fsErr, 4096)",
  "  $proc.WaitForExit()",
  "  $tOut.GetAwaiter().GetResult()",
  "  $tErr.GetAwaiter().GetResult()",
  "  $code = [int]$proc.ExitCode",
  "} catch {",
  "  $errBytes = $utf8.GetBytes($_.Exception.Message + [Environment]::NewLine)",
  "  if ($null -ne $fsErr) { $fsErr.Write($errBytes, 0, $errBytes.Length) }",
  "  $code = 1",
  "} finally {",
  "  if ($null -ne $fsOut) { try { $fsOut.Flush(); $fsOut.Dispose() } catch {} }",
  "  if ($null -ne $fsErr) { try { $fsErr.Flush(); $fsErr.Dispose() } catch {} }",
  "  if ($null -ne $proc) { try { $proc.Dispose() } catch {} }",
  "  $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
  "  $payload = @{ exit_code = $code; signal = $null; finished_at = $ms } | ConvertTo-Json -Compress",
  '  $tmp = "$exitFile.tmp.$PID"',
  "  [System.IO.File]::WriteAllText($tmp, $payload, $utf8)",
  "  Move-Item -LiteralPath $tmp -Destination $exitFile -Force",
  "}",
  "exit $code",
].join("\n");

const WIN32_PS_ENCODED = Buffer.from(WIN32_PS_WRAPPER, "utf16le").toString("base64");

export function backgroundJobsDir(rootDir?: string): string {
  return rootDir ? resolve(rootDir) : join(orcHome(), "background-jobs");
}

function jobDir(id: string, rootDir?: string): string {
  if (!JOB_ID_RE.test(id)) throw new Error("Invalid background job id.");
  return join(backgroundJobsDir(rootDir), id);
}

function metaPath(id: string, rootDir?: string): string {
  return join(jobDir(id, rootDir), "meta.json");
}

function exitPath(id: string, rootDir?: string): string {
  return join(jobDir(id, rootDir), "exit.json");
}

function logPath(id: string, rootDir?: string): string {
  return join(jobDir(id, rootDir), "output.log");
}

function writeMetaAtomic(record: BackgroundJobRecord, rootDir?: string): void {
  const target = metaPath(record.id, rootDir);
  const tmp = `${target}.tmp.${process.pid}.${ulid()}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

function readMetaRaw(id: string, rootDir?: string): BackgroundJobRecord | null {
  try {
    return BackgroundJobRecordSchema.parse(JSON.parse(readFileSync(metaPath(id, rootDir), "utf8")));
  } catch {
    return null;
  }
}

function readExitFile(id: string, rootDir?: string): z.infer<typeof ExitFileSchema> | null {
  try {
    return ExitFileSchema.parse(JSON.parse(readFileSync(exitPath(id, rootDir), "utf8")));
  } catch {
    return null;
  }
}

function applyExitFile(
  record: BackgroundJobRecord,
  exit: z.infer<typeof ExitFileSchema>,
  rootDir?: string,
): BackgroundJobRecord {
  const nextStatus: BackgroundJobStatus =
    record.status === "stopped"
      ? "stopped"
      : exit.exit_code === 0 && !exit.signal
        ? "completed"
        : "failed";
  const updated: BackgroundJobRecord = {
    ...record,
    status: nextStatus,
    exit_code: exit.exit_code,
    signal: exit.signal ?? null,
    finished_at: record.finished_at ?? Math.max(record.started_at, exit.finished_at ?? Date.now()),
    error:
      nextStatus === "failed" && !record.error
        ? exit.signal
          ? `Command terminated by ${exit.signal} (exit code ${exit.exit_code ?? "unknown"}).`
          : `Command exited with code ${exit.exit_code ?? "unknown"}.`
        : record.error,
  };
  if (
    updated.status !== record.status ||
    updated.exit_code !== record.exit_code ||
    updated.signal !== record.signal ||
    updated.finished_at !== record.finished_at
  ) {
    try {
      writeMetaAtomic(updated, rootDir);
    } catch {
      // Best-effort persistence on read.
    }
  }
  return updated;
}

function reconcileRecord(record: BackgroundJobRecord, rootDir?: string): BackgroundJobRecord {
  const exit = readExitFile(record.id, rootDir);
  if (exit) return applyExitFile(record, exit, rootDir);

  if (record.status === "running" && record.pid !== null && !isProcessAlive(record.pid)) {
    const lateExit = readExitFile(record.id, rootDir);
    if (lateExit) return applyExitFile(record, lateExit, rootDir);
    const updated: BackgroundJobRecord = {
      ...record,
      status: "interrupted_by_restart",
      finished_at: record.finished_at ?? Date.now(),
      error:
        record.error ??
        "Background job process exited without recording a completion status (terminated externally or by a host/container restart).",
    };
    try {
      writeMetaAtomic(updated, rootDir);
    } catch {
      // Best-effort persistence on read.
    }
    return updated;
  }

  return record;
}

export function startBackgroundJob(
  input: BackgroundJobStartInput,
  rootDir?: string,
): BackgroundJobRecord {
  const parsed = BackgroundJobStartSchema.parse(input);
  const cwd = resolve(parsed.cwd);
  let cwdStat: ReturnType<typeof statSync>;
  try {
    cwdStat = statSync(cwd);
  } catch {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  if (!cwdStat.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${cwd}`);
  }
  if (parsed.env) {
    for (const key of Object.keys(parsed.env)) {
      if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
        throw new Error(`Environment variable ${key} cannot be overridden for background jobs.`);
      }
    }
  }
  const id = ulid();
  const dir = jobDir(id, rootDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const outputLog = logPath(id, rootDir);
  const exitFile = exitPath(id, rootDir);
  writeFileSync(outputLog, "", { mode: 0o600 });

  const env = parsed.env ? { ...process.env, ...parsed.env } : process.env;
  const child =
    process.platform === "win32"
      ? spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            WIN32_PS_ENCODED,
          ],
          {
            cwd,
            env: {
              ...env,
              ORC_BG_CMD: parsed.command,
              ORC_BG_LOG: outputLog,
              ORC_BG_EXIT: exitFile,
            },
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          },
        )
      : spawn("/bin/sh", ["-c", POSIX_WRAPPER, "--", parsed.command, outputLog, exitFile], {
          cwd,
          env,
          detached: true,
          stdio: "ignore",
        });

  child.on("error", () => {});
  child.unref();

  const spawned = typeof child.pid === "number" && child.pid > 0;
  const now = Date.now();
  const record: BackgroundJobRecord = {
    id,
    label: parsed.label ?? null,
    command: parsed.command,
    cwd,
    session_id: parsed.session_id ?? null,
    project_id: parsed.project_id ?? null,
    status: spawned ? "running" : "failed",
    pid: spawned ? (child.pid ?? null) : null,
    started_at: now,
    finished_at: spawned ? null : now,
    exit_code: spawned ? null : 1,
    signal: null,
    error: spawned ? null : "Failed to spawn detached background shell process.",
    log_path: outputLog,
  };
  writeMetaAtomic(record, rootDir);
  return reconcileRecord(record, rootDir);
}

export function getBackgroundJob(id: string, rootDir?: string): BackgroundJobRecord | null {
  const record = readMetaRaw(id, rootDir);
  if (!record) return null;
  return reconcileRecord(record, rootDir);
}

export function listBackgroundJobs(
  filter?: {
    session_id?: string | undefined;
    project_id?: string | undefined;
    project_ids?: string[] | undefined;
    status?: BackgroundJobStatus | undefined;
    limit?: number | undefined;
  },
  rootDir?: string,
): BackgroundJobRecord[] {
  const base = backgroundJobsDir(rootDir);
  if (!existsSync(base)) return [];
  const allowedProjects = filter?.project_ids ? new Set(filter.project_ids) : null;
  const entries = readdirSync(base, { withFileTypes: true });
  const jobs: BackgroundJobRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_ID_RE.test(entry.name)) continue;
    const record = getBackgroundJob(entry.name, rootDir);
    if (!record) continue;
    if (filter?.session_id && record.session_id !== filter.session_id) continue;
    if (filter?.project_id && record.project_id !== filter.project_id) continue;
    if (allowedProjects && (!record.project_id || !allowedProjects.has(record.project_id)))
      continue;
    if (filter?.status && record.status !== filter.status) continue;
    jobs.push(record);
  }
  jobs.sort((a, b) => b.started_at - a.started_at);
  const limit = Math.max(1, Math.min(filter?.limit ?? 50, 200));
  return jobs.slice(0, limit);
}

export function readBackgroundJobLog(
  id: string,
  opts?: { tail_bytes?: number | undefined; tail_lines?: number | undefined },
  rootDir?: string,
): { text: string; truncated: boolean; size_bytes: number } {
  const file = logPath(id, rootDir);
  if (!existsSync(file)) return { text: "", truncated: false, size_bytes: 0 };
  const size = statSync(file).size;
  if (size === 0) return { text: "", truncated: false, size_bytes: 0 };
  const maxBytes = Math.max(256, Math.min(opts?.tail_bytes ?? DEFAULT_TAIL_BYTES, MAX_TAIL_BYTES));
  const readBytes = Math.min(size, maxBytes);
  const start = size - readBytes;
  const buffer = Buffer.alloc(readBytes);
  const fd = openSync(file, "r");
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buffer, 0, readBytes, start);
  } finally {
    closeSync(fd);
  }
  let text = buffer.subarray(0, bytesRead).toString("utf8");
  let truncated = start > 0;
  if (opts?.tail_lines !== undefined) {
    const limit = Math.max(1, Math.min(opts.tail_lines, MAX_TAIL_LINES));
    const lines = text.split(/\r?\n/);
    if (lines.length > limit) {
      text = lines.slice(-limit).join("\n");
      truncated = true;
    }
  }
  return { text, truncated, size_bytes: size };
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (res.error || res.status !== 0) process.kill(pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
}

export async function stopBackgroundJob(
  id: string,
  rootDir?: string,
  graceMs = 3000,
): Promise<BackgroundJobRecord | null> {
  const current = getBackgroundJob(id, rootDir);
  if (!current) return null;
  if (current.status !== "running" || current.pid === null) return current;

  const pid = current.pid;
  signalProcessGroup(pid, "SIGTERM");

  const deadline = Date.now() + Math.max(100, graceMs);
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (isProcessAlive(pid)) {
    signalProcessGroup(pid, "SIGKILL");
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && isProcessAlive(pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const exit = readExitFile(id, rootDir);
  const stopped: BackgroundJobRecord = {
    ...current,
    status: "stopped",
    finished_at: exit?.finished_at ?? Date.now(),
    exit_code: exit?.exit_code ?? current.exit_code,
    signal: exit?.signal ?? "SIGTERM",
    error: "Stopped by request.",
  };
  writeMetaAtomic(stopped, rootDir);
  return stopped;
}
