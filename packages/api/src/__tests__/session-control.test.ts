import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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

let slow: Promise<void> = Promise.resolve();
let failPreflight = false;
let app: ReturnType<typeof createApp>;
let original: AgentBackend;
const turns: Turn[] = [];
const home = mkdtempSync(join(tmpdir(), "orc-session-control-"));
const repo = realpathSync(mkdtempSync(join(tmpdir(), "orc-session-control-repo-")));
const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
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
  process.env.USERPROFILE = home;
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
    preflight: async () => {
      await slow;
      return failPreflight ? { ok: false, error: "agent unavailable" } : { ok: true };
    },
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
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
  if (oldMock !== undefined) process.env.ORC_E2E_CHAT_MOCK = oldMock;
  resetConfig();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("agent session control", () => {
  afterEach(async () => {
    for (const turn of turns) turn.release();
    // An outcome notification whose steer target was already ending is refused and
    // queues behind the finalizer, then arrives as its own turn. Sweep until a pass
    // starts nothing, releasing every turn, so no gated turn leaks into the next test.
    for (let pass = 0; pass < 10; pass++) {
      const before = turns.length;
      const swept = deliverIdleSessionMessages();
      const releaser = setInterval(() => {
        for (const turn of turns.slice(before)) turn.release();
      }, 10);
      await swept;
      clearInterval(releaser);
      if (turns.length === before) break;
    }
  });
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
    // git prints forward slashes even on Windows.
    const listed = execFileSync("git", ["-C", repo, "worktree", "list"]).toString();
    expect(listed.replaceAll("\\", "/")).toContain(child.cwd.replaceAll("\\", "/"));
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
  test("should keep a cascade-stopped parent stopped instead of waking it with child notes", async () => {
    const lead = await startParent("calm lead: fan out", repo);
    await turnFor("calm lead: fan out");
    const child = (
      await req(
        app,
        "POST",
        "/sessions/live/spawn",
        { prompt: "calm worker", notify: true },
        as(lead.id),
      )
    ).json<SessionStatus>();
    const { session_id } = await child;
    await turnFor("calm worker");
    expect((await req(app, "POST", `/sessions/live/${lead.id}/stop`)).status).toBe(200);
    await until(
      () => !chatControl().running(lead.id) && !chatControl().running(session_id),
      "tree stopped",
    );
    await Bun.sleep(50);
    const before = turns.length;
    void deliverIdleSessionMessages();
    await Bun.sleep(200);
    expect((await inbox(lead.id)).filter((message) => message.state !== "delivered")).toEqual([]);
    expect(chatControl().running(lead.id)).toBe(false);
    expect(turns.some((turn) => turn.prompt.includes(`id=${session_id}`))).toBe(false);
    for (const turn of turns.slice(before)) turn.release();
    await until(() => !chatControl().full(), "workers free");
  });

  test("should stop a queued child caught while it starts, report cancelled ones as stopped, and queue racing spawns", async () => {
    const lead = await startParent("race lead: fan out", repo);
    await turnFor("race lead: fan out");
    const spawn = async (prompt: string) =>
      (
        await req(app, "POST", "/sessions/live/spawn", { prompt }, as(lead.id))
      ).json<SessionStatus>();
    const prompts = ["race one", "race two", "race three", "race four"];
    const started = await Promise.all(prompts.map(spawn));
    expect(started.map((child) => child.status).sort()).toEqual([
      "queued",
      "running",
      "running",
      "running",
    ]);
    const index = started.findIndex((child) => child.status === "queued");
    const queued = started[index] as SessionStatus;
    const queuedPrompt = prompts[index] as string;
    const runningPrompt = prompts[
      started.findIndex((child) => child.status === "running")
    ] as string;
    const cancelled = await spawn("race cancelled");
    expect(cancelled.status).toBe("queued");
    const send = await app.request("/api/chat/stream", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: queued.session_id,
        messages: [{ role: "user", content: "jump the queue" }],
      }),
    });
    expect(send.status).toBe(409);
    expect((await req(app, "POST", `/sessions/live/${cancelled.session_id}/stop`)).status).toBe(
      200,
    );
    expect((await status(cancelled.session_id)).status).toBe("stopped");

    let open = () => {};
    slow = new Promise<void>((resolve) => {
      open = resolve;
    });
    (await turnFor(runningPrompt)).release();
    await until(() => chatControl().running(queued.session_id), "queued child dequeued");
    expect((await req(app, "POST", `/sessions/live/${queued.session_id}/stop`)).status).toBe(200);
    open();
    slow = Promise.resolve();
    await until(() => !chatControl().running(queued.session_id), "dequeued child stopped");
    expect(turns.some((turn) => turn.prompt.includes(queuedPrompt))).toBe(false);
    expect((await status(queued.session_id)).status).toBe("stopped");
    expect(turns.filter((turn) => turn.prompt === "jump the queue")).toEqual([]);
    for (const turn of turns) turn.release();
    await req(app, "POST", `/sessions/live/${lead.id}/stop`);
  });
  test("should withdraw messages queued for a stopped tree and deliver ones sent after the stop", async () => {
    const lead = await startParent("withdraw lead", repo);
    await turnFor("withdraw lead");
    const child = await (
      await req(
        app,
        "POST",
        "/sessions/live/spawn",
        { prompt: "withdraw child", notify: true },
        as(lead.id),
      )
    ).json<SessionStatus>();
    await turnFor("withdraw child");
    const early = await (
      await req(
        app,
        "POST",
        "/session-messages",
        { session_id: child.session_id, body: "stale followup", mode: "queue" },
        as(lead.id),
      )
    ).json<SessionMessageResult>();
    expect((await req(app, "POST", `/sessions/live/${lead.id}/stop`)).status).toBe(200);
    await until(
      () => !chatControl().running(lead.id) && !chatControl().running(child.session_id),
      "tree stopped",
    );
    void deliverIdleSessionMessages();
    await Bun.sleep(200);
    expect(turns.some((turn) => turn.prompt.includes("stale followup"))).toBe(false);
    expect((await inbox(child.session_id)).find((m) => m.id === early.message.id)?.state).toBe(
      "cancelled",
    );
    expect((await status(child.session_id)).status).toBe("stopped");

    await req(app, "POST", `/sessions/live/${child.session_id}/messages`, { body: "fresh work" });
    void deliverIdleSessionMessages();
    (await turnFor("fresh work")).release();
    await until(() => !chatControl().running(child.session_id), "fresh work done");
    for (const turn of turns) turn.release();
    await until(() => !chatControl().running(lead.id), "lead idle");
  });
  test("should stop a child whose spawn was still starting when the parent's tree was stopped", async () => {
    const lead = await startParent("inflight lead", repo);
    await turnFor("inflight lead");
    let open = () => {};
    slow = new Promise<void>((resolve) => {
      open = resolve;
    });
    const spawning = req(
      app,
      "POST",
      "/sessions/live/spawn",
      { prompt: "inflight child", notify: true },
      as(lead.id),
    );
    await Bun.sleep(20);
    expect((await req(app, "POST", `/sessions/live/${lead.id}/stop`)).status).toBe(200);
    open();
    slow = Promise.resolve();
    const child = await (await spawning).json<SessionStatus>();
    await until(() => !chatControl().running(child.session_id), "in-flight child stopped");
    await Bun.sleep(50);
    expect((await status(child.session_id)).status).toBe("stopped");
    expect((await inbox(lead.id)).filter((message) => message.state === "queued")).toEqual([]);
    expect(chatControl().running(lead.id)).toBe(false);
    const late = await req(
      app,
      "POST",
      "/sessions/live/spawn",
      { prompt: "late child", notify: true },
      as(lead.id),
    );
    expect(late.status).toBe(409);
  });
  test("should report a queued child that fails to start as failed, and tell the parent about a human stop during its start", async () => {
    const lead = await startParent("gaps lead", repo);
    await turnFor("gaps lead");
    const spawn = async (prompt: string) =>
      (
        await req(app, "POST", "/sessions/live/spawn", { prompt, notify: true }, as(lead.id))
      ).json<SessionStatus>();
    const running = [await spawn("gaps one"), await spawn("gaps two"), await spawn("gaps three")];
    expect(running.map((child) => child.status)).toEqual(["running", "running", "running"]);
    const broken = await spawn("gaps broken");
    const stoppedByHuman = await spawn("gaps stopped");
    expect([broken.status, stoppedByHuman.status]).toEqual(["queued", "queued"]);

    failPreflight = true;
    (await turnFor("gaps one")).release();
    await until(async () => (await status(broken.session_id)).status === "failed", "broken failed");
    failPreflight = false;

    let open = () => {};
    slow = new Promise<void>((resolve) => {
      open = resolve;
    });
    (await turnFor("gaps two")).release();
    await until(() => chatControl().running(stoppedByHuman.session_id), "stopped child dequeued");
    expect(
      (await req(app, "POST", `/sessions/live/${stoppedByHuman.session_id}/stop`)).status,
    ).toBe(200);
    failPreflight = true;
    open();
    slow = Promise.resolve();
    await until(() => !chatControl().running(stoppedByHuman.session_id), "start failed");
    failPreflight = false;
    expect((await status(stoppedByHuman.session_id)).status).toBe("stopped");
    const notes = (await inbox(lead.id)).map((message) => message.body.split("\n")[0]);
    expect(notes).toContain(`[orc child-session id=${broken.session_id} outcome=failed]`);
    expect(notes).toContain(`[orc child-session id=${stoppedByHuman.session_id} outcome=stopped]`);
    for (const turn of turns) turn.release();
    await req(app, "POST", `/sessions/live/${lead.id}/stop`);
  });
});

describe("child work rollup", () => {
  test("an idle parent reads working while its spawned child holds a turn", async () => {
    const parent = await startParent("parent: delegate and rest", repo);
    const parentTurn = await turnFor("parent: delegate");
    await req(
      app,
      "POST",
      "/sessions/live/spawn",
      { prompt: "child: long run", title: "Long run" },
      as(parent.id),
    );
    const childTurn = await turnFor("child: long run");
    parentTurn.release();
    await until(async () => (await status(parent.id)).status === "idle", "parent idle");

    // The parent's own turn ended, but the child still holds work: the status, the
    // thread list and the thread session payload must all say so.
    const idle = await status(parent.id);
    expect(idle.status).toBe("idle");
    expect(idle.working_children).toBe(1);
    expect(idle.waiting_children).toBe(0);
    const threads = await (await req(app, "GET", "/chat/threads")).json<{
      threads: { id: string; workingChildren: number; waitingChildren: number }[];
    }>();
    const row = threads.threads.find((thread) => thread.id === parent.id);
    expect(row?.workingChildren).toBe(1);
    const session = await (await req(app, "GET", `/chat/threads/${parent.id}/session`)).json<{
      workingChildren: number;
      waitingChildren: number;
      stopping: boolean;
    }>();
    expect(session.workingChildren).toBe(1);
    expect(session.stopping).toBe(false);

    childTurn.release();
    await until(async () => (await status(parent.id)).working_children === 0, "child settled");
    for (const turn of turns) turn.release();
  });

  test("native subagents discovered under the session count as child work", async () => {
    const parent = await startParent("parent: native children", repo);
    const parentTurn = await turnFor("parent: native");
    parentTurn.release();
    await until(async () => (await status(parent.id)).status === "idle", "parent idle");
    const thread = await (await req(app, "GET", `/chat/threads/${parent.id}`)).json<{
      runtimeId: string | null;
    }>();
    expect(thread.runtimeId).toBeTruthy();
    const sqlite = getSqlite();
    const subagentId = `sub-${crypto.randomUUID()}`;
    sqlite
      .query(
        `INSERT INTO gateway_sessions
           (id, chat_id, backend, mode, status, role, parent_session_id, runtime_session_id, created_at, updated_at)
         VALUES (?, '__live-sessions__', 'claude', 'agent:claude', 'running', 'worker', ?, ?, unixepoch(), unixepoch())`,
      )
      .run(subagentId, thread.runtimeId, `native-${subagentId}`);
    try {
      const withChild = await status(parent.id);
      expect(withChild.status).toBe("idle");
      expect(withChild.working_children).toBe(1);
      sqlite.query("UPDATE gateway_sessions SET status = 'stopped' WHERE id = ?").run(subagentId);
      expect((await status(parent.id)).working_children).toBe(0);
    } finally {
      sqlite.query("DELETE FROM gateway_sessions WHERE id = ?").run(subagentId);
    }
  });

  test("a requested stop reads stopping until the agent ends the turn", async () => {
    const wrapper = createBackend("claude");
    let releaseTurn = () => {};
    registerBackend("claude", () => ({
      ...wrapper,
      startSession: async (opts) => {
        const session = fakeSession(opts.cwd, `native-stop-${crypto.randomUUID()}`);
        // An agent that acknowledges the interrupt but keeps working: the turn must
        // stay visible as stopping, not flip to idle on the ack.
        return { ...session, interrupt: async () => {}, close: async () => releaseTurn() };
      },
    }));
    try {
      const parent = await startParent("parent: stop me", repo);
      const turn = await turnFor("parent: stop me");
      releaseTurn = turn.release;
      expect((await req(app, "POST", `/sessions/live/${parent.id}/stop`)).status).toBe(200);
      const stopping = await status(parent.id);
      expect(stopping.status).toBe("running");
      expect(stopping.stopping).toBe(true);
      releaseTurn();
      await until(async () => (await status(parent.id)).status === "stopped", "turn drained");
      expect((await status(parent.id)).stopping).toBe(false);
    } finally {
      registerBackend("claude", () => wrapper);
    }
  });
});

describe("observable worker sessions (#533)", () => {
  test("advances mid-turn last_activity_at and activity metadata on tool and thinking events before turn completion", async () => {
    const wrapper = createBackend("claude");
    let pushEvent: ((event: AgentEvent) => void) | undefined;
    let finishTurn: (() => void) | undefined;

    registerBackend("claude", () => ({
      ...wrapper,
      startSession: async () => {
        const runtimeId = `ses_live_${crypto.randomUUID().slice(0, 8)}`;
        const queue: AgentEvent[] = [];
        let wake: (() => void) | undefined;
        let done = false;
        pushEvent = (event) => {
          queue.push(event);
          wake?.();
          wake = undefined;
        };
        finishTurn = () => {
          queue.push({ type: "text", data: "final reply" });
          queue.push({ type: "result", data: { runtimeSessionId: runtimeId } });
          done = true;
          wake?.();
          wake = undefined;
        };
        return {
          id: runtimeId,
          capabilities: wrapper.capabilities,
          getRuntimeSessionId: () => runtimeId,
          send: async () => {},
          interrupt: async () => finishTurn?.(),
          respondPermission: () => {},
          alive: () => !done,
          close: async () => {
            done = true;
            wake?.();
          },
          async *events(): AsyncIterable<AgentEvent> {
            while (!done || queue.length > 0) {
              if (!queue.length) {
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
                continue;
              }
              const next = queue.shift();
              if (next) yield next;
            }
          },
        };
      },
    }));

    try {
      const parent = await startParent("parent: live activity", repo);
      const initial = await status(parent.id);
      expect(initial.status).toBe("running");
      const firstActivityAt = initial.last_activity_at ?? initial.updated_at;

      await Bun.sleep(20);
      pushEvent?.({
        type: "tool_use",
        data: { id: "tool-1", name: "bash", input: '{"command":"git status"}' },
      });
      await until(
        async () => (await status(parent.id)).last_activity === "tool:bash",
        "tool_use activity recorded",
      );
      const afterTool = await status(parent.id);
      expect(afterTool.status).toBe("running");
      expect(afterTool.last_activity).toBe("tool:bash");
      expect(afterTool.activity_count).toBeGreaterThanOrEqual(1);
      expect(afterTool.last_activity_at ?? 0).toBeGreaterThan(firstActivityAt);
      expect(afterTool.updated_at).toBeGreaterThan(firstActivityAt);

      await Bun.sleep(20);
      pushEvent?.({ type: "thinking", data: "analyzing diff" });
      await until(
        async () => (await status(parent.id)).last_activity === "thinking",
        "thinking activity recorded",
      );
      const afterThinking = await status(parent.id);
      expect(afterThinking.last_activity_at ?? 0).toBeGreaterThan(afterTool.last_activity_at ?? 0);
      expect(afterThinking.activity_count).toBeGreaterThan(afterTool.activity_count ?? 0);

      finishTurn?.();
      await until(async () => (await status(parent.id)).status === "idle", "turn completed");
      const settled = await status(parent.id);
      expect(settled.last_message).toBe("final reply");
    } finally {
      registerBackend("claude", () => wrapper);
    }
  });

  test("surfaces runtime spawn errors in start_error and last_message and logs them to /system/logs", async () => {
    const wrapper = createBackend("claude");
    const oldLogFlag = process.env.ORC_LOG_FILE;
    process.env.ORC_LOG_FILE = "1";
    let failLaunch = false;
    registerBackend("claude", () => ({
      ...wrapper,
      startSession: async (opts) => {
        if (failLaunch) throw new Error("Simulated codex launch failure: auth token missing");
        return fakeSession(opts.cwd, `native-ok-${crypto.randomUUID()}`);
      },
    }));

    try {
      const parent = await startParent("parent: spawn error test", repo);
      const parentTurn = await turnFor("parent: spawn error test");
      failLaunch = true;

      const spawned = await req(
        app,
        "POST",
        "/sessions/live/spawn",
        { prompt: "child: will fail launch", title: "Failing worker" },
        as(parent.id),
      );
      expect(spawned.status).toBe(200);
      const child = await spawned.json<SessionStatus>();

      await until(async () => (await status(child.session_id)).status === "failed", "child failed");
      const failed = await status(child.session_id);
      expect(failed.status).toBe("failed");
      expect(failed.start_error).toContain("Simulated codex launch failure: auth token missing");
      expect(failed.last_message).toContain("Simulated codex launch failure: auth token missing");

      const logsRes = await req(
        app,
        "GET",
        "/system/logs?level=error&q=Simulated+codex+launch+failure",
      );
      expect(logsRes.status).toBe(200);
      const logsBody = await logsRes.json<{
        path: string;
        entries: { level: string | null; msg: string; data?: string }[];
      }>();
      expect(logsBody.entries.length).toBeGreaterThanOrEqual(1);
      expect(
        logsBody.entries.some((entry) =>
          `${entry.msg} ${entry.data ?? ""}`.includes("Simulated codex launch failure"),
        ),
      ).toBe(true);

      parentTurn.release();
      for (const turn of turns) turn.release();
    } finally {
      if (oldLogFlag === undefined) delete process.env.ORC_LOG_FILE;
      else process.env.ORC_LOG_FILE = oldLogFlag;
      registerBackend("claude", () => wrapper);
    }
  });

  test("normalizes backend alias agent=codex-cli on session spawn", async () => {
    const originalCodex = createBackend("codex-cli");
    registerBackend("codex-cli", () => ({
      ...originalCodex,
      preflight: async () => ({ ok: true }),
      startSession: async (opts) => fakeSession(opts.cwd, `native-codex-${crypto.randomUUID()}`),
      resumeSession: async (id, opts) => fakeSession(opts.cwd, id),
    }));
    try {
      const parent = await startParent("parent: codex alias", repo);
      const parentTurn = await turnFor("parent: codex alias");

      const spawned = await req(
        app,
        "POST",
        "/sessions/live/spawn",
        { prompt: "child: codex alias run", agent: "codex-cli", title: "Codex alias worker" },
        as(parent.id),
      );
      expect(spawned.status).toBe(200);
      const child = await spawned.json<SessionStatus>();
      expect(child.agent).toBe("codex");

      const childTurn = await turnFor("child: codex alias run");
      childTurn.release();
      parentTurn.release();
      await until(
        async () => (await status(child.session_id)).status === "idle",
        "codex child idle",
      );
      for (const turn of turns) turn.release();
    } finally {
      registerBackend("codex-cli", () => originalCodex);
    }
  });

  test("resolves chat UUID, gateway record id, and native ses_ id across status, live, transcript, and stop — including discovery-only records", async () => {
    const parent = await startParent("parent: unified ids", repo);
    const parentTurn = await turnFor("parent: unified ids");
    parentTurn.release();
    await until(async () => (await status(parent.id)).status === "idle", "parent idle");

    const thread = await (await req(app, "GET", `/chat/threads/${parent.id}`)).json<{
      runtimeId: string | null;
    }>();
    expect(thread.runtimeId).toBeTruthy();

    const sqlite = getSqlite();
    const liveId = `live-${crypto.randomUUID().slice(0, 12)}`;
    const nativeId = thread.runtimeId as string;
    sqlite
      .query(
        `INSERT INTO gateway_sessions
           (id, chat_id, backend, mode, status, role, runtime_session_id, title, cwd, created_at, updated_at, last_activity_at)
         VALUES (?, '__live-sessions__', 'claude', 'direct', 'idle', 'worker', ?, 'Unified Session', ?, unixepoch(), unixepoch(), unixepoch())`,
      )
      .run(liveId, nativeId, repo);

    const discoveryId = `disc-${crypto.randomUUID().slice(0, 12)}`;
    const discoveryNative = `ses_discovery_${crypto.randomUUID().slice(0, 8)}`;
    sqlite
      .query(
        `INSERT INTO gateway_sessions
           (id, chat_id, backend, mode, status, role, runtime_session_id, title, cwd, created_at, updated_at, last_activity_at)
         VALUES (?, '__live-sessions__', 'opencode', 'direct', 'running', 'worker', ?, 'Discovery Only', ?, unixepoch(), unixepoch(), unixepoch())`,
      )
      .run(discoveryId, discoveryNative, repo);

    try {
      for (const identifier of [parent.id, liveId, nativeId]) {
        const stRes = await req(app, "GET", `/sessions/live/${identifier}/status`);
        expect(stRes.status).toBe(200);
        const stBody = await stRes.json<SessionStatus>();
        expect(stBody.session_id).toBe(parent.id);
        expect(stBody.live_session_id).toBe(liveId);
        expect(stBody.native_session_id).toBe(nativeId);

        const liveRes = await req(app, "GET", `/sessions/live/${identifier}`);
        expect(liveRes.status).toBe(200);
        const liveBody = await liveRes.json<{ id: string; session_id: string | null }>();
        expect(liveBody.id).toBe(liveId);
        expect(liveBody.session_id).toBe(nativeId);

        const trRes = await req(app, "GET", `/sessions/live/${identifier}/transcript`);
        expect(trRes.status).toBe(200);
        const trBody = await trRes.json<{ total: number; turns: unknown[] }>();
        expect(trBody.total).toBeGreaterThanOrEqual(2);
      }

      const discByLive = await req(app, "GET", `/sessions/live/${discoveryId}/status`);
      expect(discByLive.status).toBe(200);
      expect((await discByLive.json<SessionStatus>()).status).toBe("running");

      const discByNative = await req(app, "GET", `/sessions/live/${discoveryNative}/status`);
      expect(discByNative.status).toBe(200);
      expect((await discByNative.json<SessionStatus>()).session_id).toBe(discoveryId);

      const stopRes = await req(app, "POST", `/sessions/live/${discoveryId}/stop`);
      expect(stopRes.status).toBe(200);
      const stoppedBody = await stopRes.json<SessionStatus>();
      expect(stoppedBody.status).toBe("stopped");
    } finally {
      sqlite.query("DELETE FROM gateway_sessions WHERE id IN (?, ?)").run(liveId, discoveryId);
    }
  });
});
