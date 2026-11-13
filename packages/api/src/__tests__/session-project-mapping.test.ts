import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, getSqlite } from "@orc/db/client";
import { NotificationStore } from "@orc/db/notifications";
import { bridge_chats, gateway_sessions } from "@orc/db/schema";
import { reconcileSessionProjects } from "../session-watcher.js";
import { invalidateProjectFolderCache, projectIdFor } from "../sessions/common.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
let root = "";
let nestedProjectFolder = "";
let worktreeProjectFolder = "";
let worktreeFolder = "";
let worktreeBase = "";

beforeAll(async () => {
  app = setupTestApp();
  root = mkdtempSync(join(tmpdir(), "orc-project-map-"));
  nestedProjectFolder = join(root, "nested");
  mkdirSync(nestedProjectFolder, { recursive: true });
  const main = join(root, "worktree-repo");
  worktreeProjectFolder = main;
  mkdirSync(main, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: main });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    {
      cwd: main,
    },
  );
  worktreeBase = mkdtempSync(join(tmpdir(), "orc-worktree-"));
  worktreeFolder = join(worktreeBase, "checkout");
  execFileSync("git", ["worktree", "add", "-q", worktreeFolder], { cwd: main });
  expect((await req(app, "POST", "/projects", { name: "mapping-root", scope: root })).status).toBe(
    201,
  );
  expect(
    (await req(app, "POST", "/projects", { name: "mapping-nested", scope: nestedProjectFolder }))
      .status,
  ).toBe(201);
  expect(
    (
      await req(app, "POST", "/projects", {
        name: "mapping-worktree",
        scope: worktreeProjectFolder,
      })
    ).status,
  ).toBe(201);
  // Project routes re-map sessions in the background; drain that work before tests.
  await reconcileSessionProjects();
  invalidateProjectFolderCache();
});

afterAll(() => {
  teardownTestApp();
  if (root) rmSync(root, { recursive: true, force: true });
  if (worktreeBase) rmSync(worktreeBase, { recursive: true, force: true });
});

test("maps a folder to the most specific project and resolves a worktree to its checkout", async () => {
  const rootProject = getSqlite()
    .query<{ id: string }, []>("SELECT id FROM projects WHERE name='mapping-root'")
    .get();
  const nested = getSqlite()
    .query<{ id: string }, []>("SELECT id FROM projects WHERE name='mapping-nested'")
    .get();
  const worktree = getSqlite()
    .query<{ id: string }, []>("SELECT id FROM projects WHERE name='mapping-worktree'")
    .get();
  expect(await projectIdFor(join(nestedProjectFolder, "child"))).toBe(nested?.id ?? null);
  expect(await projectIdFor(root)).toBe(rootProject?.id ?? null);
  expect(await projectIdFor(worktreeFolder)).toBe(worktree?.id ?? null);
});

test("reconciles an existing session and its notifications after a project folder is set", async () => {
  const project = getSqlite()
    .query<{ id: string }, []>("SELECT id FROM projects WHERE name='mapping-nested'")
    .get();
  if (!project) throw new Error("Missing nested project");
  const now = new Date();
  await getDb()
    .insert(bridge_chats)
    .values({ id: "__live-sessions__", platform: "telegram", chat_id: "__live-sessions__" })
    .onConflictDoNothing();
  await getDb()
    .insert(gateway_sessions)
    .values({
      id: "mapping-session",
      chat_id: "__live-sessions__",
      backend: "mapping-agent",
      mode: "direct",
      runtime_session_id: "mapping-native",
      project_id: null,
      cwd: join(nestedProjectFolder, "child"),
      status: "stopped",
      title: "Mapping fixture",
      created_at: now,
      last_activity_at: now,
    });
  const store = new NotificationStore(getSqlite());
  const notification = store.publish({
    type: "agent.finished",
    source_key: "mapping:finished",
    source_id: "mapping-session",
    title: "Mapping fixture finished",
    level: "done",
    project_id: null,
    path: "/sessions?session=mapping-session",
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
  });
  if (!notification) throw new Error("Missing notification fixture");

  await reconcileSessionProjects();
  const row = getSqlite()
    .query<{ project_id: string | null }, [string]>(
      "SELECT project_id FROM gateway_sessions WHERE id=?",
    )
    .get("mapping-session");
  expect(row?.project_id).toBe(project.id);

  const scoped = await (
    await req(app, "GET", `/notifications?project_id=${encodeURIComponent(project.id)}`)
  ).json<{ notifications: { id: string }[]; unread: number }>();
  expect(scoped.notifications.some((item) => item.id === notification.id)).toBe(true);
  const other = getSqlite()
    .query<{ id: string }, []>("SELECT id FROM projects WHERE name='mapping-root'")
    .get();
  const unrelated = await (
    await req(app, "GET", `/notifications?project_id=${encodeURIComponent(other?.id ?? "")}`)
  ).json<{ notifications: { id: string }[] }>();
  expect(unrelated.notifications.some((item) => item.id === notification.id)).toBe(false);
});

test("drops an assignment its project's scope no longer justifies", async () => {
  const movedBase = mkdtempSync(join(tmpdir(), "orc-project-moved-"));
  const oldScope = join(movedBase, "old");
  const newScope = join(movedBase, "new");
  mkdirSync(oldScope, { recursive: true });
  mkdirSync(newScope, { recursive: true });
  try {
    const created = await (
      await req(app, "POST", "/projects", { name: "mapping-moved", scope: oldScope })
    ).json<{ id: string }>();
    const now = new Date();
    await getDb()
      .insert(gateway_sessions)
      .values({
        id: "moved-session",
        chat_id: "__live-sessions__",
        backend: "mapping-agent",
        mode: "direct",
        runtime_session_id: "moved-native",
        project_id: null,
        cwd: join(oldScope, "work"),
        status: "stopped",
        title: "Moved fixture",
        created_at: now,
        last_activity_at: now,
      });
    const store = new NotificationStore(getSqlite());
    const notification = store.publish({
      type: "agent.finished",
      source_key: "moved:finished",
      source_id: "moved-session",
      title: "Moved fixture finished",
      level: "done",
      project_id: null,
      path: "/sessions?session=moved-session",
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    });
    if (!notification) throw new Error("Missing moved notification fixture");
    await reconcileSessionProjects();
    const assigned = getSqlite()
      .query<{ project_id: string | null }, [string]>(
        "SELECT project_id FROM gateway_sessions WHERE id=?",
      )
      .get("moved-session");
    expect(assigned?.project_id).toBe(created.id);

    // Moving the scope must not leave the old folder assigned to this project.
    expect((await req(app, "PATCH", `/projects/${created.id}`, { scope: newScope })).status).toBe(
      200,
    );
    await reconcileSessionProjects();
    const cleared = getSqlite()
      .query<{ project_id: string | null }, [string]>(
        "SELECT project_id FROM gateway_sessions WHERE id=?",
      )
      .get("moved-session");
    expect(cleared?.project_id).toBeNull();
    const stored = getSqlite()
      .query<{ project_id: string | null }, [string]>(
        "SELECT project_id FROM notifications WHERE id=?",
      )
      .get(notification.id);
    expect(stored?.project_id).toBeNull();

    const unassigned = await (await req(app, "GET", "/notifications?project_id=unassigned")).json<{
      notifications: { id: string }[];
    }>();
    expect(unassigned.notifications.some((item) => item.id === notification.id)).toBe(true);

    // Marking all read in another project's scoped inbox must not touch this one.
    await req(app, "POST", `/notifications/read?project_id=${encodeURIComponent(created.id)}`);
    const stillUnread = await (
      await req(app, "GET", "/notifications?project_id=unassigned&unread=true")
    ).json<{ notifications: { id: string }[] }>();
    expect(stillUnread.notifications.some((item) => item.id === notification.id)).toBe(true);

    await req(app, "POST", "/notifications/read?project_id=unassigned");
    const readScoped = await (await req(app, "GET", "/notifications?project_id=unassigned")).json<{
      notifications: { id: string }[];
      unread: number;
    }>();
    expect(readScoped.unread).toBe(0);
  } finally {
    rmSync(movedBase, { recursive: true, force: true });
  }
});
