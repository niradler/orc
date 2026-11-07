#!/usr/bin/env bun
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  findAgentOwner,
  LIVE_REGISTRY_DIR,
  liveSessionWaiting,
  readRegistrations,
  recordLiveSessionWait,
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
  notification_type: z.string().max(100).optional(),
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

async function main(): Promise<void> {
  let backend = process.argv[2];
  if (!backend || !["cursor", "cursor-agent", "gemini", "claude"].includes(backend))
    throw new Error("Unsupported hook backend");
  const raw = await Bun.stdin.text();
  if (raw.length > 200_000) throw new Error("Hook input is too large");
  const input = Input.parse(JSON.parse(raw));
  const externalId = input.session_id ?? input.conversation_id;
  const event = process.argv[3] ?? input.hook_event_name ?? "";
  const waiting = liveSessionWaiting(event, {
    ...(input.notification_type !== undefined ? { notificationType: input.notification_type } : {}),
    ...(input.tool_name !== undefined ? { toolName: input.tool_name } : {}),
  });
  const status = EVENTS[event];
  if (!externalId) throw new Error("Missing session identity");
  if (!status) {
    if (waiting !== undefined) await recordLiveSessionWait(backend, event, input);
    return;
  }
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
      : await findAgentOwner(backend, externalId, previous?.pid);
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
  let retainedWaiting: boolean | undefined;
  if (status === "stopped") retainedWaiting = false;
  else if (waiting !== undefined) retainedWaiting = waiting;
  else retainedWaiting = previous?.waiting;
  writeRegistration({
    backend,
    externalId,
    pid,
    status,
    ...(retainedWaiting !== undefined ? { waiting: retainedWaiting } : {}),
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
