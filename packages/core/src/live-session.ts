import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const LIVE_REGISTRY_DIR = join(homedir(), ".orc", "live-sessions");
export const LiveRegistration = z.object({
  backend: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  externalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/),
  pid: z.number().int().positive(),
  title: z.string().max(200).default("Agent session"),
  cwd: z.string().optional(),
  transcriptPath: z.string().optional(),
  status: z.enum(["running", "idle", "stopped"]),
  waiting: z.boolean().optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
});
export type LiveRegistration = z.infer<typeof LiveRegistration>;

const CLEAR_WAIT_EVENTS = new Set([
  "Stop",
  "stop",
  "SessionEnd",
  "sessionEnd",
  "PostToolUse",
  "postToolUse",
  "PostToolUseFailure",
  "postToolUseFailure",
  "AfterTool",
  "AfterAgent",
  "UserPromptSubmit",
  "beforeSubmitPrompt",
  "BeforeAgent",
  "ElicitationResult",
  "PermissionDenied",
]);
const BLOCKING_NOTIFICATIONS = new Set([
  "permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "ToolPermission",
  "ShellInteraction",
]);
const CLEARED_NOTIFICATIONS = new Set(["elicitation_complete", "elicitation_response"]);

export function liveSessionWaiting(
  event: string,
  input: { notificationType?: string; toolName?: string } = {},
): boolean | undefined {
  if (event === "PermissionRequest") return true;
  if (event === "PreToolUse" || event === "BeforeTool")
    return input.toolName === "AskUserQuestion" ? true : undefined;
  if (event === "Notification") {
    const type = input.notificationType ?? "";
    if (BLOCKING_NOTIFICATIONS.has(type)) return true;
    if (CLEARED_NOTIFICATIONS.has(type)) return false;
    return undefined;
  }
  if (CLEAR_WAIT_EVENTS.has(event)) return false;
  return undefined;
}

type ProcessRow = { pid: number; parent: number; name: string; command: string };

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function claudeRegistryPid(sessionId: string): number | undefined {
  const dir = join(homedir(), ".claude", "sessions");
  if (!existsSync(dir)) return undefined;
  const direct = join(dir, `${sessionId}.json`);
  let names: string[] = [];
  try {
    names = existsSync(direct) ? [direct] : readdirSync(dir).map((name) => join(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
  for (const file of names.slice(0, 500)) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        sessionId?: unknown;
        pid?: unknown;
      };
      if (
        parsed.sessionId === sessionId &&
        typeof parsed.pid === "number" &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0
      )
        return parsed.pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
  }
  return undefined;
}

function matchesAgent(backend: string, row: ProcessRow): boolean {
  if (/live-session|rules hook/i.test(row.command)) return false;
  if (backend === "claude") return /^claude(\.exe)?$/i.test(row.name);
  const matcher =
    backend === "gemini" ? /gemini/i : backend === "cursor-agent" ? /cursor-agent/i : /cursor/i;
  return matcher.test(`${row.name} ${row.command}`);
}

export async function findAgentOwner(
  backend: string,
  externalId: string,
  previousPid?: number,
): Promise<{ pid: number; backend: string }> {
  if (previousPid && previousPid > 0 && processAlive(previousPid))
    return { pid: previousPid, backend };
  if (backend === "claude") {
    const registered = claudeRegistryPid(externalId);
    if (registered && processAlive(registered)) return { pid: registered, backend };
  }
  const command =
    process.platform === "win32"
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$all = Get-CimInstance Win32_Process; $ownerId = ${process.ppid}; $chain = @(); for ($i = 0; $i -lt 16; $i++) { $row = $all | Where-Object ProcessId -eq $ownerId | Select-Object -First 1; if (-not $row) { break }; $chain += $row; $ownerId = $row.ParentProcessId }; ConvertTo-Json -Compress -InputObject @($chain | Select-Object @{n='pid';e={$_.ProcessId}},@{n='parent';e={$_.ParentProcessId}},@{n='name';e={$_.Name}},@{n='command';e={$_.CommandLine}})`,
        ]
      : ["ps", "-eo", "pid=,ppid=,comm=,args="];
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 2500,
    windowsHide: true,
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error("Unable to identify agent owner");
  let windowsRows: ProcessRow[] = [];
  if (process.platform === "win32") {
    try {
      windowsRows = JSON.parse(output);
    } catch {
      throw new Error("Unable to parse agent process inventory");
    }
  }
  const rows: ProcessRow[] =
    process.platform === "win32"
      ? windowsRows
      : output.split("\n").flatMap((line) => {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
          return match
            ? [
                {
                  pid: Number(match[1]),
                  parent: Number(match[2]),
                  name: match[3] ?? "",
                  command: match[4] ?? "",
                },
              ]
            : [];
        });
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let pid = process.ppid;
  for (let i = 0; i < 16; i++) {
    const row = byPid.get(pid);
    if (!row) break;
    if (
      !/^(cmd|powershell|pwsh|sh|bash|zsh)(\.exe)?$/i.test(row.name) &&
      matchesAgent(backend, row)
    )
      return {
        pid: row.pid,
        backend:
          backend === "cursor" && /cursor-agent/i.test(row.command) ? "cursor-agent" : backend,
      };
    pid = row.parent;
  }
  throw new Error("Agent owner process was not found");
}

function hookString(raw: unknown, key: string): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export async function recordLiveSessionWait(
  backend: string,
  event: string,
  raw: unknown,
  dir: string = LIVE_REGISTRY_DIR,
): Promise<void> {
  if (!["claude", "cursor", "cursor-agent", "gemini"].includes(backend)) return;
  const notificationType = hookString(raw, "notification_type");
  const toolName = hookString(raw, "tool_name");
  const waiting = liveSessionWaiting(event, {
    ...(notificationType !== undefined ? { notificationType } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
  });
  if (waiting === undefined) return;
  const externalId = hookString(raw, "session_id") ?? hookString(raw, "conversation_id");
  if (!externalId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(externalId)) return;
  const previous = readRegistrations(dir).find(
    (record) =>
      (record.backend === backend || (backend === "cursor" && record.backend === "cursor-agent")) &&
      record.externalId === externalId,
  );
  if (!previous && !waiting) return;
  if (previous?.waiting === waiting) return;
  const owner = await findAgentOwner(previous?.backend ?? backend, externalId, previous?.pid);
  const now = Date.now();
  const cwd = hookString(raw, "cwd") ?? previous?.cwd;
  const transcriptPath = hookString(raw, "transcript_path") ?? previous?.transcriptPath;
  const prompt = hookString(raw, "prompt")?.replace(/\s+/g, " ").slice(0, 200);
  writeRegistration(
    {
      backend: owner.backend,
      externalId,
      pid: owner.pid,
      title: previous?.title ?? prompt ?? `${owner.backend} session`,
      status: previous?.status ?? "idle",
      waiting,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(cwd ? { cwd } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
    },
    dir,
  );
}

export function readRegistrations(dir: string = LIVE_REGISTRY_DIR): LiveRegistration[] {
  if (!existsSync(dir)) return [];
  const records: LiveRegistration[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = LiveRegistration.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (parsed.success) records.push(parsed.data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
  }
  return records;
}

export function writeRegistration(input: LiveRegistration, dir: string = LIVE_REGISTRY_DIR): void {
  const record = LiveRegistration.parse(input);
  mkdirSync(dir, { recursive: true });
  const name = `${record.backend}-${record.externalId}.json`;
  const temp = join(dir, `${name}.${process.pid}.${crypto.randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      renameSync(temp, join(dir, name));
      return;
    } catch (error) {
      // A Windows reader (or antivirus scanner) can briefly deny replacement.
      // Keep the old complete record visible and retry the same atomic rename.
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
