import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createApp } from "../server.js";
import { runSync } from "../session-watcher.js";
import { claudeAdapter } from "../sessions/claude.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const root = mkdtempSync(join(tmpdir(), "orc-housekeeping-"));
const A = "aaaaaaaa-1111-4222-8333-000000000151";
const B = "bbbbbbbb-1111-4222-8333-000000000152";

type Row = {
  id: string;
  session_id: string | null;
  name: string | null;
  renamed?: boolean;
  hidden?: boolean;
};

const writeSession = (pid: number, id: string, name: string) =>
  writeFileSync(
    join(root, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: id,
      cwd: "/tmp/x",
      name,
      status: "idle",
    }),
  );

const live = async (query = ""): Promise<Row[]> => {
  const res = await req(app, "GET", `/sessions/live?active=false${query}`);
  return (await res.json()).sessions as Row[];
};

const bySession = async (id: string, query = ""): Promise<Row | undefined> =>
  (await live(query)).find((row) => row.session_id === id);

beforeAll(async () => {
  app = setupTestApp();
  mkdirSync(root, { recursive: true });
  writeSession(process.pid, A, "native-a");
  writeSession(1, B, "native-b");
  await runSync([claudeAdapter({ registry: root, desktop: null, projects: null })], {
    force: true,
  });
});

afterAll(() => {
  teardownTestApp();
  rmSync(root, { recursive: true, force: true });
});

describe("session rename and hide", () => {
  test("keeps the agent title until a human renames the session", async () => {
    const row = await bySession(A);
    expect(row).toMatchObject({ name: "native-a", renamed: false, hidden: false });
  });

  test("a rename is shown, survives a re-sync, and can be reverted", async () => {
    const row = await bySession(A);
    const renamed = await (
      await req(app, "PATCH", `/sessions/live/${row?.id}`, { display_title: "  My thread  " })
    ).json();
    expect(renamed).toMatchObject({ name: "My thread", renamed: true });

    await runSync([claudeAdapter({ registry: root, desktop: null, projects: null })], {
      force: true,
    });
    expect(await bySession(A)).toMatchObject({ name: "My thread", renamed: true });

    const reverted = await (
      await req(app, "PATCH", `/sessions/live/${row?.id}`, { display_title: null })
    ).json();
    expect(reverted).toMatchObject({ name: "native-a", renamed: false });
  });

  test("a hidden session leaves the default list and returns when asked for", async () => {
    const row = await bySession(B);
    const hidden = await (
      await req(app, "PATCH", `/sessions/live/${row?.id}`, { hidden: true })
    ).json();
    expect(hidden).toMatchObject({ hidden: true });

    expect(await bySession(B)).toBeUndefined();
    expect(await bySession(B, "&include_hidden=true")).toMatchObject({ hidden: true });

    await runSync([claudeAdapter({ registry: root, desktop: null, projects: null })], {
      force: true,
    });
    expect(await bySession(B)).toBeUndefined();

    const shown = await (
      await req(app, "PATCH", `/sessions/live/${row?.id}`, { hidden: false })
    ).json();
    expect(shown).toMatchObject({ hidden: false });
    expect(await bySession(B)).toMatchObject({ hidden: false });
  });

  test("hiding twice keeps the original hide time", async () => {
    const row = await bySession(B);
    await req(app, "PATCH", `/sessions/live/${row?.id}`, { hidden: true });
    const first = (await bySession(B, "&include_hidden=true"))?.hidden;
    await req(app, "PATCH", `/sessions/live/${row?.id}`, { hidden: true });
    expect(first).toBe(true);
    await req(app, "PATCH", `/sessions/live/${row?.id}`, { hidden: false });
  });

  test("an empty patch, an unknown session and an overlong name are refused", async () => {
    const row = await bySession(A);
    expect((await req(app, "PATCH", `/sessions/live/${row?.id}`, {})).status).toBe(400);
    expect((await req(app, "PATCH", "/sessions/live/missing", { hidden: true })).status).toBe(404);
    expect(
      (
        await req(app, "PATCH", `/sessions/live/${row?.id}`, {
          display_title: "x".repeat(201),
        })
      ).status,
    ).toBe(400);
  });

  test("a task link still updates through the same route", async () => {
    const row = await bySession(A);
    const task = await (await req(app, "POST", "/tasks", { title: "housekeeping" })).json();
    const linked = await (
      await req(app, "PATCH", `/sessions/live/${row?.id}`, { task_id: task.id })
    ).json();
    expect(linked.task?.id).toBe(task.id);
  });
});
