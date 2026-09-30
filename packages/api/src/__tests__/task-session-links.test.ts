import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createApp } from "../server.js";
import { runSync } from "../session-watcher.js";
import { claudeAdapter } from "../sessions/claude.js";
import { sessionIdsIn } from "../sessions/tasklinks.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const root = mkdtempSync(join(tmpdir(), "orc-tasklinks-"));
const A = "aaaaaaaa-1111-4222-8333-000000000001";
const B = "bbbbbbbb-1111-4222-8333-000000000002";
const C = "cccccccc-1111-4222-8333-000000000003";

const writeSession = (pid: number, id: string) =>
  writeFileSync(
    join(root, `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, cwd: "/tmp/x", name: `s-${pid}`, status: "idle" }),
  );

const live = async (query = "") => {
  const res = await req(app, "GET", `/sessions/live?active=false${query}`);
  return (await res.json()).sessions as { session_id: string; task: { id: string } | null }[];
};

beforeAll(async () => {
  app = setupTestApp();
  mkdirSync(root, { recursive: true });
  writeSession(process.pid, A);
  writeSession(1, B);
  writeSession(2, C);
  await runSync([claudeAdapter({ registry: root, desktop: null, projects: null })], {
    force: true,
  });
});

afterAll(() => {
  teardownTestApp();
  rmSync(root, { recursive: true, force: true });
});

describe("session lines in a task body", () => {
  test("parses every uuid on every session: line", () => {
    const body = `session:    ${A}\nresume: claude --resume ${A}\nsession: ${B}, ${C.toUpperCase()}\nnot a line session: ${A}`;
    expect(sessionIdsIn(body)).toEqual([A, B, C]);
    expect(sessionIdsIn(null)).toEqual([]);
  });

  test("a task collects every session named in its body, without a manual link", async () => {
    const task = await (
      await req(app, "POST", "/tasks", { title: "one goal", body: `session: ${A}\nsession: ${B}` })
    ).json();
    const rows = await live(`&task_id=${task.id}`);
    expect(rows.map((r) => r.session_id).sort()).toEqual([A, B]);
    expect(rows.every((r) => r.task?.id === task.id)).toBe(true);
    expect((await live()).find((r) => r.session_id === C)?.task).toBeNull();
  });

  test("a session named by two tasks shows the most recently updated one", async () => {
    const older = await (
      await req(app, "POST", "/tasks", { title: "older", body: `session: ${C}` })
    ).json();
    await Bun.sleep(1100);
    const newer = await (
      await req(app, "POST", "/tasks", { title: "newer", body: `session: ${C}` })
    ).json();
    expect((await live()).find((r) => r.session_id === C)?.task?.id).toBe(newer.id);
    expect((await live(`&task_id=${older.id}`)).map((r) => r.session_id)).toContain(C);
  });

  test("a manual link beats the body line and leaves the other task's list alone", async () => {
    const tasks = (await (await req(app, "GET", "/tasks?limit=100")).json()).tasks as {
      id: string;
      title: string;
    }[];
    const goal = tasks.find((t) => t.title === "one goal");
    const manual = await (await req(app, "POST", "/tasks", { title: "manual" })).json();
    const row = (await (await req(app, "GET", "/sessions/live?active=false")).json()).sessions.find(
      (r: { session_id: string }) => r.session_id === A,
    );
    await req(app, "PATCH", `/sessions/live/${row.id}`, { task_id: manual.id });
    expect((await live()).find((r) => r.session_id === A)?.task?.id).toBe(manual.id);
    expect((await live(`&task_id=${goal?.id}`)).map((r) => r.session_id)).toEqual([B]);
  });
});
