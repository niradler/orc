import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatEvent, ChatThreadSchema } from "@orc/core/chat";
import { type HumanRequest, HumanRequestSchema } from "@orc/core/human-requests";
import { z } from "zod";

// Opt-in: uses the installed agents and their configured provider credentials.
if (!process.argv.includes("--run"))
  throw new Error("Run explicitly with --run; this verification makes real provider requests.");
const agents = process.argv.includes("--codex-only")
  ? ["codex"]
  : process.argv.includes("--claude-only")
    ? ["claude"]
    : ["codex", "claude"];
const cwd = mkdtempSync(join(tmpdir(), "orc-native-attention-api-"));
process.chdir(cwd);
Object.assign(process.env, {
  ORC_DB_PATH: ":memory:",
  ORC_RULES_ENABLED: "false",
  ORC_SSH_HOST: "",
  ORC_ACTIVE_PROJECT: "",
  ORC_E2E_CHAT_MOCK: "",
  ORC_API_SECRET: crypto.randomUUID(),
});
const { loadConfig, resetConfig } = await import("../../core/src/config.js");
const { ChatSettingsSchema } = await import("../../core/src/chat.js");
resetConfig();
loadConfig().preferences.chat = ChatSettingsSchema.parse({
  mcp: "native",
  permissionMode: "default",
  system:
    "Controlled integration test. Follow the supplied test instructions. Do not inspect or modify files.",
});
const { createTestDb, closeDb } = await import("../../db/src/client.js");
createTestDb();
const { createApp } = await import("../src/server.js");
const { codexAdapter } = await import("../src/sessions/codex.js");
const { runSync } = await import("../src/session-watcher.js");
const app = createApp();
const headers = {
  Authorization: `Bearer ${process.env.ORC_API_SECRET}`,
  "Content-Type": "application/json",
};
const evidence: string[] = [];
let commandsAuthorized = 0;
const WaitsSchema = z.object({
  waiting: z.array(z.object({ thread_id: z.string(), host: z.string().nullable() })),
});
const SessionsSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      session_id: z.string().nullable(),
      status: z.string(),
      waiting_for_human: z.boolean(),
    }),
  ),
});
async function request(path: string, body?: unknown) {
  const response = await app.request(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
  return response;
}
async function inbox(): Promise<HumanRequest[]> {
  return z.array(HumanRequestSchema).parse(await (await request("/human-requests")).json());
}
async function waitUntil(check: () => Promise<boolean>, description: string) {
  const until = Date.now() + 10000;
  while (!(await check())) {
    assert(Date.now() < until, description);
    await Bun.sleep(100);
  }
}
async function turn(
  agent: string,
  kind: "question" | "approval" | "resume",
  via: "chat" | "inbox" | "cancel",
  threadId?: string,
  approved = false,
) {
  const prompt =
    kind === "question"
      ? "Controlled integration test. Do not inspect files, use commands or make edits. Use your structured question tool (request_user_input or AskUserQuestion) to ask Choose a color with options Blue and Green. After the answer, reply exactly PROBE_COMPLETE."
      : kind === "approval"
        ? `Controlled permission test. Do not inspect or modify files. Invoke the command tool exactly once to request permission for ${agent === "codex" ? "Write-Output ORC_APPROVAL_PROBE, explicitly using sandbox_permissions=require_escalated" : "python -c \"print('ORC_APPROVAL_PROBE')\" with Bash and dangerouslyDisableSandbox=true"}. If denied, do not retry or use other tools; reply exactly PROBE_DENIED. If it executes, reply exactly PROBE_EXECUTED.`
        : "Controlled continuation test. Do not use tools. Reply exactly PROBE_RESUMED.";
  let runId = "";
  let currentThread = threadId ?? "";
  let seen = 0;
  let text = "";
  let executed = false;
  let done = false;
  let requestId: string | undefined;
  const timer = setTimeout(() => {
    if (runId) void request(`/chat/runs/${runId}/cancel`, {});
  }, 120000);
  const response = await request("/chat/stream", {
    agent,
    ...(threadId ? { threadId } : {}),
    messages: [{ role: "user", content: prompt }],
  });
  assert(response.body, "Missing event stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      pending += decoder.decode(part.value, { stream: true });
      let boundary = pending.indexOf("\n\n");
      while (boundary >= 0) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = block
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        boundary = pending.indexOf("\n\n");
        if (!data) continue;
        const event = JSON.parse(data) as ChatEvent;
        if (event.type === "thread") {
          runId = event.runId;
          currentThread = event.thread.id;
        }
        if (event.type === "text") text += event.text;
        if (
          event.type === "tool_result" &&
          !event.data.isError &&
          event.data.content.includes("ORC_APPROVAL_PROBE")
        )
          executed = true;
        if (event.type === "done") done = true;
        if (event.type === "error" && via !== "cancel") throw new Error(event.message);
        if (event.type !== "question_request" && event.type !== "permission_request") continue;
        seen++;
        assert.equal(seen, 1, "Agent retried or issued an unexpected additional human request");
        assert.equal(event.type, kind === "question" ? "question_request" : "permission_request");
        const record = (await inbox()).find(
          (entry) => entry.input.origin.chat_thread_id === currentThread,
        );
        assert(record, "Native request missing from authenticated Attention endpoint");
        assert.equal(record.status, "pending");
        assert.equal(record.input.origin.backend, agent);
        assert.equal(record.input.origin.execution_host, null);
        assert.equal(record.input.kind, kind);
        assert(record.input.origin.native_session_id, "Native identity missing");
        requestId = record.id;
        if (kind === "approval" && approved) {
          const command = record.input.action?.input.command;
          const shell = Bun.which("pwsh");
          const permitted =
            agent === "codex"
              ? [
                  "Write-Output ORC_APPROVAL_PROBE",
                  ...(shell ? [`"${shell}" -Command 'Write-Output ORC_APPROVAL_PROBE'`] : []),
                ]
              : ["python -c \"print('ORC_APPROVAL_PROBE')\""];
          assert(
            typeof command === "string" && permitted.includes(command.replaceAll("\\\\", "\\")),
            "Refusing approval for a command outside the exact harmless fixture",
          );
        }
        const waits = WaitsSchema.parse(await (await request("/chat/waiting")).json());
        assert(
          waits.waiting.some((wait: { thread_id: string }) => wait.thread_id === currentThread),
        );
        if (agent === "codex" && kind === "question") {
          const native = (await codexAdapter().list(new Map())).find(
            (entry) => entry.externalId === record.input.origin.native_session_id,
          );
          assert.equal(
            native?.pendingHuman,
            true,
            "Real native transcript did not expose its pending question",
          );
        }
        if (via === "cancel") await request(`/chat/runs/${runId}/cancel`, {});
        else if (via === "inbox")
          await request(`/human-requests/${record.id}/respond`, {
            version: record.version,
            response:
              kind === "approval"
                ? { kind: "approval", approved }
                : { kind: "question", answer: "Blue" },
          });
        else if (event.type === "permission_request")
          await request(`/chat/runs/${runId}/permission`, {
            requestId: event.data.requestId,
            decision: approved ? "approved" : "denied",
          });
        else
          await request(`/chat/runs/${runId}/answer`, {
            requestId: event.data.requestId,
            answers: Object.fromEntries(
              event.data.questions.map((question) => [question.id, ["Blue"]]),
            ),
          });
      }
    }
    assert(done, "Stream did not finish");
    assert.equal(
      seen,
      kind === "resume" ? 0 : 1,
      `${agent} ${kind} did not emit the required native request: ${text.slice(0, 500)}`,
    );
    if (via !== "cancel")
      assert(
        text.includes(
          kind === "question"
            ? "PROBE_COMPLETE"
            : kind === "approval"
              ? approved
                ? "PROBE_EXECUTED"
                : "PROBE_DENIED"
              : "PROBE_RESUMED",
        ),
        "Native agent did not confirm continuation",
      );
    if (kind === "approval")
      assert.equal(executed, approved, "Native command output did not match its decision");
    if (requestId) {
      await waitUntil(
        async () =>
          !(await inbox()).some(
            (entry) => entry.id === requestId && ["pending", "answered"].includes(entry.status),
          ),
        "Attention request did not resolve",
      );
      const record = HumanRequestSchema.parse(
        await (await request(`/human-requests/${requestId}`)).json(),
      );
      assert.equal(record.status, via === "cancel" ? "cancelled" : "delivered");
      const duplicate = await app.request(`/api/human-requests/${requestId}/respond`, {
        method: "POST",
        headers,
        body: JSON.stringify({ version: 1, response: { kind: "approval", approved: true } }),
      });
      assert.equal(duplicate.status, 409, "Late response was accepted");
    }
    const waits = WaitsSchema.parse(await (await request("/chat/waiting")).json());
    assert(!waits.waiting.some((wait: { thread_id: string }) => wait.thread_id === currentThread));
    evidence.push(
      kind === "resume"
        ? `${agent}: original native conversation resumed and completed`
        : `${agent} ${kind}${kind === "approval" ? (approved ? " approved" : " denied") : ""} ${via}: pending in Attention, native delivery/cancellation and cleanup verified`,
    );
    console.log(`PASS ${evidence.at(-1)}`);
    if (kind === "approval" && approved) commandsAuthorized++;
    return ChatThreadSchema.parse(await (await request(`/chat/threads/${currentThread}`)).json());
  } finally {
    clearTimeout(timer);
    if (!done && runId) await request(`/chat/runs/${runId}/cancel`, {}).catch(() => {});
    await reader.cancel();
  }
}
try {
  assert.equal((await app.request("/api/chat/waiting")).status, 401);
  for (const agent of agents) {
    const thread = process.argv.includes("--approval-only")
      ? null
      : await turn(agent, "question", agent === "codex" ? "inbox" : "chat");
    if (agent === "codex" && thread) {
      const adapter = codexAdapter();
      await runSync([adapter], { force: true });
      const sessions = SessionsSchema.parse(
        await (await request("/sessions/live?agent=codex&active=false&limit=5000")).json(),
      );
      const source = sessions.sessions.find((entry) => entry.session_id === thread.runtimeId);
      assert(
        source && source.status === "stopped" && !source.waiting_for_human,
        "Completed real session did not become resumable",
      );
      const resumed = ChatThreadSchema.parse(
        await (await request("/chat/threads", { sourceSessionId: source.id })).json(),
      );
      assert.equal(resumed.runtimeId, thread.runtimeId);
      const completed = await turn("codex", "resume", "chat", resumed.id);
      assert.equal(
        completed.runtimeId,
        thread.runtimeId,
        "Continuation started a different native session",
      );
    }
    // The existing Claude Rules guard isolates user auto-allow settings even
    // with no active policy; no matching rule creates the approval notice.
    loadConfig().rules.enabled = agent === "claude";
    await turn(agent, "approval", agent === "codex" ? "chat" : "inbox");
    await turn(agent, "approval", agent === "codex" ? "inbox" : "chat", undefined, true);
    loadConfig().rules.enabled = false;
  }
  if (agents.includes("codex") && !process.argv.includes("--approval-only"))
    await turn("codex", "question", "cancel");
  console.log(JSON.stringify({ result: "passed", assertions: evidence, commandsAuthorized }));
} finally {
  closeDb();
}
