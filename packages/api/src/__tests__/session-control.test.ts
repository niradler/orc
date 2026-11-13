import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentBackend,
  type AgentEvent,
  type AgentSession,
  createBackend,
  registerBackend,
} from "@orc/agent-runtime";
import type { ChatEvent, ChatThread } from "@orc/core/chat";
import { resetConfig, updateGlobalConfig } from "@orc/core/config";
import type {
  SessionLineage,
  SessionMessage,
  SessionMessageResult,
  SessionStatus,
} from "@orc/core/session-messages";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { deliverIdleAnswers } from "../human-request-delivery";
import type { createApp } from "../server";
import { deliverIdleSessionMessages } from "../session-message-delivery";
import { chatControl } from "../sessions/turns";
import { req, setupTestApp, teardownTestApp } from "./helpers";

type Turn = { prompt: string; steers: string[]; release: () => void; cwd: string };

let app: ReturnType<typeof createApp>;
let original: AgentBackend;
const turns: Turn[] = [];
const home = mkdtempSync(join(tmpdir(), "orc-session-control-"));
const repo = realpathSync(mkdtempSync(join(tmpdir(), "orc-session-control-repo-")));
const oldHome = process.env.HOME;
const oldMock = process.env.ORC_E2E_CHAT_MOCK;

function fakeSession(cwd: string, runtimeId: string): AgentSession {
  let turn: Turn | undefined;
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  return {
    id: runtimeId,
    capabilities: createBackend("claude").capabilities,
    send: async (prompt) => {
      turn = { prompt, steers: [], release, cwd };
      turns.push(turn);
    },
    steer: async (text) => {
      turn?.steers.push(text);
    },
    interrupt: async () => release(),
    respondPermission: () => {},
    alive: () => true,
    close: async () => release(),
    async *events(): AsyncIterable<AgentEvent> {
      yield { type: "text", data: "working" };
      await gate;
      yield { type: "text", data: ` done: ${turn?.prompt.slice(0, 40)}` };
      yield { type: "result", data: { runtimeSessionId: runtimeId } };
    },
  };
}

async function until<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  label: string,
): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (value) return value;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function turnFor(prompt: string): Promise<Turn> {
  return until(() => turns.find((turn) => turn.prompt.includes(prompt)), prompt);
}

async function startParent(
  prompt: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): Promise<ChatThread> {
  const response = await app.request("/api/chat/stream", {
    method: "POST",
    headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: "claude",
      workspace: { cwd },
      messages: [{ role: "user", content: prompt }],
      ...extra,
    }),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No chat stream");
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    const event = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)) as ChatEvent)
      .find((entry) => entry.type === "thread");
    if (event?.type === "thread") {
      void reader.cancel().catch(() => {});
      return event.thread;
    }
  }
  throw new Error("Chat stream ended without a thread");
}

const as = (sessionId: string) => ({ "X-ORC-Session": sessionId });

async function status(id: string): Promise<SessionStatus> {
  return (await req(app, "GET", `/sessions/live/${id}/status`)).json<SessionStatus>();
}

async function inbox(id: string): Promise<SessionMessage[]> {
  return (await req(app, "GET", `/sessions/live/${id}/messages`))
    .json<{
      messages: SessionMessage[];
    }>()
    .then((body) => body.messages);
}

beforeAll(() => {
  process.env.HOME = home;
  delete process.env.ORC_E2E_CHAT_MOCK;
  app = setupTestApp();
  updateGlobalConfig((raw) => {
    raw.preferences = { chat: { agent: "claude", model: "fixture", autoApprove: false } };
  });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  original = createBackend("claude");
  let count = 0;
  registerBackend("claude", () => ({
    ...original,
    preflight: async () => ({ ok: true }),
    startSession: async (opts) => fakeSession(opts.cwd, `native-${++count}`),
    resumeSession: async (id, opts) => fakeSession(opts.cwd, id),
  }));
});

afterAll(() => {
  for (const turn of turns) turn.release();
  registerBackend("claude", () => original);
  teardownTestApp();
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldMock !== undefined) process.env.ORC_E2E_CHAT_MOCK = oldMock;
  resetConfig();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("agent session control", () => {
  test("should spawn a child in the parent's folder, steer it, and push its result back into the busy parent", async () => {
    const parent = await startParent("parent: coordinate the work", repo);
    const parentTurn = await turnFor("parent: coordinate");

    const spawned = await req(
      app,
      "POST",
      "/sessions/live/spawn",
      { prompt: "child: fix the flaky test", title: "Fix flaky test", request_id: "spawn-1" },
      as(parent.id),
    );
    expect(spawned.status).toBe(200);
    const child = await spawned.json<SessionStatus>();
    expect(child).toMatchObject({
      title: "Fix flaky test",
      status: "running",
      parent_session_id: parent.id,
      cwd: repo,
    });
    const childTurn = await turnFor("child: fix the flaky");
    expect(childTurn.cwd).toBe(repo);

    const again = await req(
      app,
      "POST",
      "/sessions/live/spawn",
      { prompt: "child: fix the flaky test", request_id: "spawn-1" },
      as(parent.id),
    );
    expect((await again.json<SessionStatus>()).session_id).toBe(child.session_id);

    const steered = await (
      await req(
        app,
        "POST",
        "/session-messages",
        { session_id: child.session_id, body: "Also check the retry path", mode: "steer" },
        as(parent.id),
      )
    ).json<SessionMessageResult>();
    expect(steered.target.delivery).toBe("steer");
    expect(steered.message).toMatchObject({ state: "delivered", delivered_via: "steer" });
    expect(childTurn.steers.join("\n")).toContain("Also check the retry path");

    const waiting = req(
      app,
      "POST",
      `/sessions/live/${child.session_id}/wait`,
      { until: "idle", timeout_s: 5 },
      as(parent.id),
    );
    childTurn.release();
    const waited = await (await waiting).json<SessionStatus & { timed_out: boolean }>();
    expect(waited).toMatchObject({ status: "idle", timed_out: false });
    expect(waited.last_message).toContain("done: child: fix the flaky");

    const notice = await until(
      () => parentTurn.steers.find((text) => text.includes("Fix flaky test")),
      "parent steer",
    );
    expect(notice).toContain("finished");
    expect(notice).toContain("done: child: fix the flaky");
    const parentInbox = await inbox(parent.id);
    expect(parentInbox[0]).toMatchObject({
      sender_kind: "system",
      sender_session_id: child.session_id,
      delivered_via: "steer",
    });

    const lineage = await (
      await req(app, "GET", `/sessions/live/${parent.id}/lineage`)
    ).json<SessionLineage>();
    expect(lineage.children.map((node) => node.id)).toEqual([child.session_id]);
    const up = await (
      await req(app, "GET", `/sessions/live/${child.session_id}/lineage`)
    ).json<SessionLineage>();
    expect(up.parent?.id).toBe(parent.id);

    parentTurn.release();
    await until(async () => (await status(parent.id)).status === "idle", "parent idle");
  });

  test("should refuse steer, interrupt and stop from a session that did not start the target", async () => {
    const owner = await startParent("owner: plan", repo);
    (await turnFor("owner: plan")).release();
    const stranger = await startParent("stranger: plan", repo);
    (await turnFor("stranger: plan")).release();
    await until(async () => (await status(owner.id)).status === "idle", "owner idle");
    const child = await (
      await req(app, "POST", "/sessions/live/spawn", { prompt: "child: audit" }, as(owner.id))
    ).json<SessionStatus>();
    const childTurn = await turnFor("child: audit");

    for (const mode of ["steer", "interrupt"] as const)
      expect(
        (
          await req(
            app,
            "POST",
            "/session-messages",
            { session_id: child.session_id, body: "take over", mode },
            as(stranger.id),
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await req(
          app,
          "POST",
          `/sessions/live/${child.session_id}/stop`,
          undefined,
          as(stranger.id),
        )
      ).status,
    ).toBe(403);

    const queued = await (
      await req(
        app,
        "POST",
        "/session-messages",
        { session_id: child.session_id, body: "stranger: please also lint" },
        as(stranger.id),
      )
    ).json<SessionMessageResult>();
    expect(queued.message.state).toBe("queued");
    expect(queued.target.delivery).toBe("chat");

    childTurn.release();
    await until(() => !chatControl().running(child.session_id), "child turn ended");
    expect((await status(child.session_id)).status).toBe("running");
    const delivering = deliverIdleSessionMessages();
    (await turnFor("stranger: please also lint")).release();
    (await turnFor(`Child session "child: audit"`)).release();
    await delivering;
    expect((await inbox(child.session_id)).find((m) => m.body.includes("lint"))).toMatchObject({
      state: "delivered",
      delivered_via: "chat",
    });
  });

  test("should interrupt a running child and deliver the message as its next turn", async () => {
    const parent = await startParent("boss: plan", repo);
    (await turnFor("boss: plan")).release();
    await until(async () => (await status(parent.id)).status === "idle", "boss idle");
    const child = await (
      await req(
        app,
        "POST",
        "/sessions/live/spawn",
        { prompt: "child: long refactor", notify: false },
        as(parent.id),
      )
    ).json<SessionStatus>();
    await turnFor("child: long refactor");
    const sent = await (
      await req(
        app,
        "POST",
        "/session-messages",
        { session_id: child.session_id, body: "stop and fix the build first", mode: "interrupt" },
        as(parent.id),
      )
    ).json<SessionMessageResult>();
    expect(sent.message.state).toBe("queued");
    await until(() => !chatControl().running(child.session_id), "child turn stopped");
    const delivering = deliverIdleSessionMessages();
    (await turnFor("stop and fix the build first")).release();
    await delivering;
    expect((await inbox(child.session_id))[0]).toMatchObject({
      state: "delivered",
      delivered_via: "chat",
    });
  });

  test("should create a git worktree for workspace=worktree and reject a shared folder across projects", async () => {
    const parent = await startParent("lead: split work", repo);
    (await turnFor("lead: split work")).release();
    await until(async () => (await status(parent.id)).status === "idle", "lead idle");
    const child = await (
      await req(
        app,
        "POST",
        "/sessions/live/spawn",
        { prompt: "child: isolated change", workspace: "worktree", notify: false },
        as(parent.id),
      )
    ).json<SessionStatus>();
    expect(child.cwd.startsWith(join(repo, ".orc", "worktrees"))).toBe(true);
    expect(execFileSync("git", ["-C", repo, "worktree", "list"]).toString()).toContain(child.cwd);
    (await turnFor("child: isolated change")).release();

    const other = mkdtempSync(join(tmpdir(), "orc-session-control-other-"));
    try {
      getSqlite()
        .query("INSERT INTO projects (id, name, scope) VALUES ('other-project', 'other', ?)")
        .run(other);
      const shared = await req(
        app,
        "POST",
        "/sessions/live/spawn",
        { prompt: "child: elsewhere", project_id: "other-project", workspace: "same" },
        as(parent.id),
      );
      expect(shared.status).toBe(400);
      const elsewhere = await (
        await req(
          app,
          "POST",
          "/sessions/live/spawn",
          {
            prompt: "child: in the other project",
            project_id: "other-project",
            workspace: "project",
            notify: false,
          },
          as(parent.id),
        )
      ).json<SessionStatus>();
      expect(elsewhere).toMatchObject({ project_id: "other-project", cwd: other });
      (await turnFor("child: in the other project")).release();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("should steer a human answer into the asking chat's running turn", async () => {
    const asker = await startParent("asker: needs a decision", repo);
    const turn = await turnFor("asker: needs a decision");
    const requests = new HumanRequestStore(getSqlite());
    const asked = requests.create({
      origin: {
        session_id: "native-asker",
        backend: "claude",
        request_id: "ask-1",
        chat_thread_id: asker.id,
      },
      kind: "question",
      prompt: "Which database should I use?",
    });
    requests.respond(asked.id, asked.version, { kind: "question", answer: "Use Postgres" });
    getSqlite()
      .query("UPDATE human_requests SET answered_at = answered_at - 60000 WHERE id = ?")
      .run(asked.id);
    await deliverIdleAnswers();
    expect(turn.steers.join("\n")).toContain("Answer: Use Postgres");
    expect(requests.get(asked.id).status).toBe("delivered");
    turn.release();
  });

  test("should start a child with the parent's permission mode and report a queued child as running", async () => {
    const parent = await startParent("cautious: plan", repo, { permissionMode: "acceptEdits" });
    (await turnFor("cautious: plan")).release();
    await until(async () => (await status(parent.id)).status === "idle", "cautious idle");
    const child = await (
      await req(
        app,
        "POST",
        "/sessions/live/spawn",
        { prompt: "child: careful edit", notify: false },
        as(parent.id),
      )
    ).json<SessionStatus>();
    const thread = await (
      await req(app, "GET", `/chat/threads/${child.session_id}`)
    ).json<ChatThread>();
    expect(thread.config.permissionMode).toBe("acceptEdits");
    (await turnFor("child: careful edit")).release();
    await until(async () => (await status(child.session_id)).status === "idle", "child idle");

    await req(
      app,
      "POST",
      "/session-messages",
      { session_id: child.session_id, body: "one more pass" },
      as(parent.id),
    );
    expect((await status(child.session_id)).status).toBe("running");
    const waited = await (
      await req(
        app,
        "POST",
        `/sessions/live/${child.session_id}/wait`,
        { timeout_s: 1 },
        as(parent.id),
      )
    ).json<SessionStatus & { timed_out: boolean }>();
    expect(waited.timed_out).toBe(true);
  });

  test("should queue a child while every chat worker is busy, wait on several children, and stop a whole tree", async () => {
    const lead = await startParent("lead: fan out", repo);
    const leadTurn = await turnFor("lead: fan out");
    const spawn = async (prompt: string) =>
      (
        await req(app, "POST", "/sessions/live/spawn", { prompt, notify: true }, as(lead.id))
      ).json<SessionStatus>();
    const first = await spawn("worker one");
    const second = await spawn("worker two");
    const third = await spawn("worker three");
    const queued = await spawn("worker four");
    expect(queued.status).toBe("queued");
    const firstTurn = await turnFor("worker one");

    const any = req(
      app,
      "POST",
      "/sessions/live/wait",
      { session_ids: [first.session_id, second.session_id], mode: "any", timeout_s: 5 },
      as(lead.id),
    );
    firstTurn.release();
    const anyResult = await (await any).json<{ sessions: SessionStatus[]; timed_out: boolean }>();
    expect(anyResult.timed_out).toBe(false);
    expect(anyResult.sessions[0]?.status).toBe("idle");
    await turnFor("worker four");
    expect((await status(queued.session_id)).status).toBe("running");
    const notice = await until(
      () => leadTurn.steers.find((text) => text.includes(first.session_id)),
      "lead notified",
    );
    expect(notice).toContain(`[orc child-session id=${first.session_id} outcome=finished]`);

    const stopped = await req(app, "POST", `/sessions/live/${lead.id}/stop`);
    expect(stopped.status).toBe(200);
    await until(
      () =>
        [lead.id, second.session_id, third.session_id, queued.session_id].every(
          (id) => !chatControl().running(id),
        ),
      "tree stopped",
    );
  });
});
