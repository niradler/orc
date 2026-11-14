import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LiveRegistration,
  liveSessionWaiting,
  readRegistrations,
  recordLiveSessionEvent,
  writeRegistration,
} from "./live-session";
import { RULE_EVENT_ADAPTERS } from "./rule-events";

async function lockRegistration(file: string, milliseconds: number) {
  const script = `$file = [IO.File]::Open('${file.replaceAll("'", "''")}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); [Console]::WriteLine('locked'); Start-Sleep -Milliseconds ${milliseconds}; $file.Dispose()`;
  const process = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdout: "pipe",
    stderr: "inherit",
    timeout: 10000,
    windowsHide: true,
  });
  const { value } = await process.stdout.getReader().read();
  expect(new TextDecoder().decode(value)).toContain("locked");
  return process;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orc-registration-race-"));
  const record: LiveRegistration = {
    backend: "codex",
    externalId: "reader",
    pid: process.pid,
    title: "Registration race",
    status: "idle",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  writeRegistration(record, dir);
  return { dir, record, file: join(dir, "codex-reader.json") };
}

describe("live session waiting", () => {
  test("should offer question and wait-clearing events in the Claude adapter", () => {
    const natives = RULE_EVENT_ADAPTERS.claude.map((entry) => entry.native);
    for (const event of [
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionDenied",
      "UserPromptSubmit",
      "ElicitationResult",
      "SessionEnd",
      "Stop",
    ])
      expect(natives).toContain(event);
  });

  test("should treat permission prompts and questions as waiting", () => {
    expect(liveSessionWaiting("PermissionRequest")).toBe(true);
    expect(liveSessionWaiting("Notification", { notificationType: "permission_prompt" })).toBe(
      true,
    );
    expect(liveSessionWaiting("Notification", { notificationType: "elicitation_dialog" })).toBe(
      true,
    );
    expect(liveSessionWaiting("Notification", { notificationType: "ToolPermission" })).toBe(true);
    expect(liveSessionWaiting("PreToolUse", { toolName: "AskUserQuestion" })).toBe(true);
  });

  test("should clear waiting when the prompt is answered or the turn ends", () => {
    expect(liveSessionWaiting("PostToolUse")).toBe(false);
    expect(liveSessionWaiting("Stop")).toBe(false);
    expect(liveSessionWaiting("AfterTool")).toBe(false);
    expect(liveSessionWaiting("ElicitationResult")).toBe(false);
    expect(liveSessionWaiting("PermissionDenied")).toBe(false);
    expect(liveSessionWaiting("UserPromptSubmit")).toBe(false);
    expect(liveSessionWaiting("Notification", { notificationType: "elicitation_response" })).toBe(
      false,
    );
  });

  test("should ignore idle notices and unrelated tool calls", () => {
    expect(liveSessionWaiting("Notification", { notificationType: "idle_prompt" })).toBeUndefined();
    expect(
      liveSessionWaiting("Notification", { notificationType: "auth_success" }),
    ).toBeUndefined();
    expect(liveSessionWaiting("PreToolUse", { toolName: "Bash" })).toBeUndefined();
    expect(liveSessionWaiting("BeforeTool")).toBeUndefined();
  });
});

describe("recordLiveSessionEvent", () => {
  const dirs: string[] = [];
  function registry(): string {
    const dir = mkdtempSync(join(tmpdir(), "orc-live-event-"));
    dirs.push(dir);
    return dir;
  }
  function seed(dir: string, externalId: string, status: LiveRegistration["status"]): void {
    const now = Date.now();
    writeRegistration(
      {
        backend: "claude",
        externalId,
        pid: process.pid,
        title: "Live event test",
        status,
        createdAt: now,
        updatedAt: now,
      },
      dir,
    );
  }
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("registers lifecycle status and captures the transcript against the live owner", async () => {
    const dir = registry();
    seed(dir, "s1", "idle");
    await recordLiveSessionEvent(
      "claude",
      "BeforeAgent",
      { session_id: "s1", prompt: "hello world", cwd: process.cwd() },
      dir,
    );
    const record = readRegistrations(dir)[0];
    expect(record?.status).toBe("running");
    expect(record?.pid).toBe(process.pid);
    expect(record?.cwd).toBe(process.cwd());
    const line = readFileSync(join(dir, "transcripts", "claude-s1.jsonl"), "utf8").trim();
    expect(JSON.parse(line).message.content).toEqual([{ type: "text", text: "hello world" }]);
    await recordLiveSessionEvent("claude", "SessionEnd", { session_id: "s1" }, dir);
    expect(readRegistrations(dir)[0]?.status).toBe("stopped");
    expect(readRegistrations(dir)[0]?.waiting).toBe(false);
  });

  test("ignores out-of-order timestamps, unrelated events and unsupported backends", async () => {
    const dir = registry();
    const now = Date.now();
    seed(dir, "s2", "running");
    await recordLiveSessionEvent(
      "claude",
      "BeforeAgent",
      { session_id: "s2", timestamp: new Date(now - 5000).toISOString() },
      dir,
    );
    expect(readRegistrations(dir)[0]?.status).toBe("running");
    await recordLiveSessionEvent(
      "claude",
      "Notification",
      { session_id: "s2", notification_type: "idle_prompt" },
      dir,
    );
    await recordLiveSessionEvent("codex", "SessionStart", { session_id: "s3" }, dir);
    expect(readRegistrations(dir)).toHaveLength(1);
  });

  test("requires a session identity and delegates waiting-only events", async () => {
    const dir = registry();
    await expect(recordLiveSessionEvent("claude", "SessionStart", {}, dir)).rejects.toThrow(
      "Missing session identity",
    );
    seed(dir, "s4", "idle");
    await recordLiveSessionEvent("claude", "PermissionRequest", { session_id: "s4" }, dir);
    expect(readRegistrations(dir)[0]?.waiting).toBe(true);
  });
});

describe.skipIf(process.platform !== "win32")("Windows atomic live-session updates", () => {
  test("waits for a transient reader lock and preserves the complete record", async () => {
    const { dir, record, file } = fixture();
    const reader = await lockRegistration(file, 200);
    try {
      writeRegistration({ ...record, status: "stopped" }, dir);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...record, status: "stopped" });
    } finally {
      await reader.exited;
    }
  }, 10000);

  test("surfaces a persistent lock within a bound and keeps the previous record", async () => {
    const { dir, record, file } = fixture();
    const reader = await lockRegistration(file, 1400);
    const started = Date.now();
    try {
      expect(() => writeRegistration({ ...record, status: "stopped" }, dir)).toThrow();
      expect(Date.now() - started).toBeLessThan(1300);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
    } finally {
      await reader.exited;
    }
  }, 10000);
});
