import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { orcHome } from "./home.js";

const DaemonRuntimeSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  instance_id: z.uuid(),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/),
  db_path: z.string().min(1),
  config_path: z.string().min(1),
  auth_enabled: z.boolean(),
  started_at: z.iso.datetime(),
  launch_id: z.uuid().optional(),
});

export type DaemonRuntime = z.infer<typeof DaemonRuntimeSchema>;

export function daemonHome(): string {
  return orcHome();
}

export function canonicalPath(path: string): string {
  let result = resolve(path);
  try {
    result = realpathSync(result);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(result);
    if (parent !== result) result = join(canonicalPath(parent), basename(result));
  }
  return process.platform === "win32" ? result.toLowerCase() : result;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function activeDaemonPid(directory = daemonHome()): number | null {
  try {
    const pid = Number(readFileSync(join(directory, "daemon.pid"), "utf8").trim());
    return isProcessAlive(pid) ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readRuntimeRecord(directory: string): DaemonRuntime | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(directory, "daemon.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
      return null;
    throw error;
  }
  const parsed = DaemonRuntimeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readDaemonRuntime(directory = daemonHome()): DaemonRuntime | null {
  const record = readRuntimeRecord(directory);
  return record && activeDaemonPid(directory) === record.pid ? record : null;
}

export function writeDaemonRuntime(record: DaemonRuntime, directory = daemonHome()): void {
  const data = DaemonRuntimeSchema.parse(record);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, "daemon.json");
  const temporary = `${target}.${data.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

export function clearDaemonRuntime(instanceId: string, directory = daemonHome()): void {
  if (readRuntimeRecord(directory)?.instance_id !== instanceId) return;
  unlinkSync(join(directory, "daemon.json"));
}
