#!/usr/bin/env bun
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  LIVE_REGISTRY_DIR,
  readRegistrations,
  writeRegistration,
} from "../packages/core/src/live-session.js";

const Input = z.object({
  session_id: z.string().optional(),
  conversation_id: z.string().optional(),
  cwd: z.string().optional(),
  workspace_roots: z.array(z.string()).optional(),
  transcript_path: z.string().optional(),
  timestamp: z.string().optional(),
  hook_event_name: z.string().optional(),
  prompt: z.string().optional(),
  prompt_response: z.string().optional(),
  text: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  tool_call_id: z.string().optional(),
});
const EVENTS: Record<string, "running" | "idle" | "stopped"> = {
  SessionStart: "idle",
  sessionStart: "idle",
  BeforeAgent: "running",
  beforeSubmitPrompt: "running",
  AfterAgent: "idle",
  stop: "idle",
  SessionEnd: "stopped",
  sessionEnd: "stopped",
  afterAgentResponse: "running",
  BeforeTool: "running",
  AfterTool: "running",
  preToolUse: "running",
  postToolUse: "running",
};

type ProcessRow = { pid: number; parent: number; name: string; command: string };

async function ownerPid(backend: string): Promise<{ pid: number; backend: string }> {
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
  const matcher =
    backend === "gemini" ? /gemini/i : backend === "cursor-agent" ? /cursor-agent/i : /cursor/i;
  for (let i = 0; i < 16; i++) {
    const row = byPid.get(pid);
    if (!row) break;
    if (
      !/^(cmd|powershell|pwsh|sh|bash|zsh)(\.exe)?$/i.test(row.name) &&
      !row.command?.includes("hooks/live-session") &&
      !row.command?.includes("hooks\\live-session") &&
      matcher.test(`${row.name} ${row.command}`)
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

async function main(): Promise<void> {
  let backend = process.argv[2];
  if (!backend || !["cursor", "cursor-agent", "gemini"].includes(backend))
    throw new Error("Unsupported hook backend");
  const raw = await Bun.stdin.text();
  if (raw.length > 200_000) throw new Error("Hook input is too large");
  const input = Input.parse(JSON.parse(raw));
  const externalId = input.session_id ?? input.conversation_id;
  const event = process.argv[3] ?? input.hook_event_name ?? "";
  const status = EVENTS[event];
  if (!externalId || !status) throw new Error("Missing session identity or lifecycle event");
  const records = readRegistrations();
  const previous = records.find(
    (record) =>
      (record.backend === backend || (backend === "cursor" && record.backend === "cursor-agent")) &&
      record.externalId === externalId,
  );
  const now = Date.now();
  const updatedAt = input.timestamp ? Date.parse(input.timestamp) : now;
  if (previous && previous.updatedAt > updatedAt) return;
  const owner =
    status === "stopped" && previous
      ? { pid: previous.pid, backend: previous.backend }
      : await ownerPid(backend);
  backend = owner.backend;
  const pid = owner.pid;
  const cwd = input.cwd ?? input.workspace_roots?.[0] ?? previous?.cwd;
  const transcriptDir = join(LIVE_REGISTRY_DIR, "transcripts");
  mkdirSync(transcriptDir, { recursive: true });
  // Validate identity before deriving a filesystem path.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(externalId))
    throw new Error("Malformed session id");
  const recordedPath = join(transcriptDir, `${backend}-${externalId}.jsonl`);
  const isUser = event === "BeforeAgent" || event === "beforeSubmitPrompt";
  const text = isUser ? input.prompt : (input.prompt_response ?? input.text);
  const toolId = input.tool_use_id ?? input.tool_call_id;
  const blocks = text
    ? [{ type: "text", text: text.slice(0, 100_000) }]
    : input.tool_name
      ? input.tool_response !== undefined
        ? [{ type: "tool_result", tool_use_id: toolId, content: input.tool_response }]
        : [{ type: "tool_use", id: toolId, name: input.tool_name, input: input.tool_input }]
      : [];
  if (blocks.length) {
    let size = 0;
    try {
      size = statSync(recordedPath).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (size < 50 * 1024 * 1024)
      appendFileSync(
        recordedPath,
        `${JSON.stringify({
          role: isUser ? "user" : "assistant",
          timestamp: new Date(now).toISOString(),
          message: { content: blocks },
        })}\n`,
        { mode: 0o600 },
      );
  }
  writeRegistration({
    backend,
    externalId,
    pid,
    status,
    title:
      previous?.title ?? input.prompt?.replace(/\s+/g, " ").slice(0, 200) ?? `${backend} session`,
    createdAt: previous?.createdAt ?? now,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
    ...(cwd ? { cwd } : {}),
    transcriptPath: input.transcript_path ?? previous?.transcriptPath ?? recordedPath,
  });
}

await main().catch((error) =>
  process.stderr.write(
    `[orc live-session] ${error instanceof Error ? error.message : "Hook failed"}\n`,
  ),
);
process.stdout.write("{}\n");
