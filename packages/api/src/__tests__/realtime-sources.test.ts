import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changes, type ResourceChange } from "@orc/core/changes";
import { LOCAL_HOST } from "@orc/core/exec-host";
import { getSqlite } from "@orc/db/client";
import { watchProcessExit } from "../realtime/process-watch.js";
import { scheduleGithubRechecks, watchResourcePath } from "../realtime/sources.js";
import { startSessionWatcher } from "../session-watcher.js";
import { setupTestApp, teardownTestApp } from "./helpers.js";

async function waitForChange(count: () => number, previous: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (count() <= previous && Date.now() < deadline) await Bun.sleep(20);
  expect(count()).toBeGreaterThan(previous);
}

test("should watch a missing resource directory and its later file changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "orc-resource-watch-"));
  const target = join(root, "skills");
  let events = 0;
  const stop = watchResourcePath(target, () => {
    events++;
  });
  try {
    mkdirSync(target);
    writeFileSync(join(target, "SKILL.md"), "First");
    await waitForChange(() => events, 0);
    const previous = events;
    writeFileSync(join(target, "SKILL.md"), "Second");
    await waitForChange(() => events, previous);
    const settled = events;
    await Bun.sleep(250);
    expect(events).toBe(settled);
  } finally {
    stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("should receive a native process exit notification without polling", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 800)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stop = (): void => {};
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("No native process exit event")), 5000);
      stop = watchProcessExit(LOCAL_HOST, child.pid, resolve);
    });
    expect(await child.exited).toBe(0);
  } finally {
    clearTimeout(timeout);
    stop();
    if (child.exitCode === null) child.kill();
  }
});

test("should report a process that already exited as exited", async () => {
  const child = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stop = (): void => {};
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("No exit event for an exited process")), 4000);
      stop = watchProcessExit(LOCAL_HOST, child.pid, resolve);
    });
  } finally {
    clearTimeout(timeout);
    stop();
  }
});

test("should name only the session whose transcript changed when its metadata does not change", async () => {
  setupTestApp();
  const root = mkdtempSync(join(tmpdir(), "orc-transcript-watch-"));
  const transcript = join(root, "transcript.jsonl");
  writeFileSync(transcript, "{}\n");
  const stop = startSessionWatcher({
    adapters: [
      {
        backend: "unchanged-metadata",
        minIntervalMs: 0,
        list: async () => [
          {
            backend: "unchanged-metadata",
            externalId: "native-unchanged",
            title: "Unchanged",
            status: "stopped",
            createdAt: new Date(0),
            lastActivityAt: new Date(0),
            transcriptPath: transcript,
          },
        ],
      },
    ],
    registryDir: root,
    liveRegistryDir: null,
  });
  const events: ResourceChange[] = [];
  let unsubscribe = (): void => {};
  try {
    await Bun.sleep(300);
    unsubscribe = changes.subscribe((event) => {
      if (event.resources.some((resource) => resource.startsWith("session"))) events.push(event);
    });
    writeFileSync(join(root, "unrelated.json"), "{}");
    await Bun.sleep(400);
    expect(events).toEqual([]);
    writeFileSync(transcript, '{"message":"new output"}\n');
    await Bun.sleep(400);
    expect(events.length).toBeGreaterThan(0);
    expect(events).toContainEqual({
      resources: ["session-activity"],
      sessions: expect.arrayContaining(["native-unchanged"]),
    });
    expect(events.every((event) => event.resources[0] === "session-activity")).toBe(true);
  } finally {
    unsubscribe();
    stop();
    teardownTestApp();
    rmSync(root, { recursive: true, force: true });
  }
});

test("should name a session whose activity moved and its token count when no changed path is known", async () => {
  setupTestApp();
  const root = mkdtempSync(join(tmpdir(), "orc-activity-watch-"));

  const stop = startSessionWatcher({
    adapters: [
      {
        backend: "moving-activity",
        minIntervalMs: 0,
        list: async () => [
          {
            backend: "moving-activity",
            externalId: "native-moving",
            title: "Moving",
            status: "stopped",
            createdAt: new Date(0),
            lastActivityAt: new Date(Date.now() + performance.now()),
            tokensVersion: 1,
            tokens: async () => 42,
          },
        ],
      },
    ],
    registryDir: root,
    liveRegistryDir: null,
  });
  const events: ResourceChange[] = [];
  let unsubscribe = (): void => {};
  try {
    await Bun.sleep(300);
    unsubscribe = changes.subscribe((event) => {
      if (event.resources.some((resource) => resource.startsWith("session"))) events.push(event);
    });
    writeFileSync(join(root, "unrelated.json"), "{}");
    await Bun.sleep(400);
    expect(events).toContainEqual({
      resources: ["session-activity"],
      sessions: expect.arrayContaining(["native-moving"]),
    });
    expect(events.some((event) => event.resources.includes("sessions") && !event.sessions)).toBe(
      false,
    );
    expect(
      getSqlite()
        .query<{ tokens_used: number }, [string]>(
          "SELECT tokens_used FROM gateway_sessions WHERE runtime_session_id = ?",
        )
        .get("native-moving")?.tokens_used,
    ).toBe(42);
  } finally {
    unsubscribe();
    stop();
    teardownTestApp();
    rmSync(root, { recursive: true, force: true });
  }
});

test("should report which paths changed so a pushed remote ref can be recognized", async () => {
  const root = mkdtempSync(join(tmpdir(), "orc-ref-watch-"));
  mkdirSync(join(root, ".git", "refs", "remotes", "origin"), { recursive: true });
  const seen: string[] = [];
  const stop = watchResourcePath(root, (paths) => {
    seen.push(...paths);
  });
  try {
    const ref = /(^|\/)refs\/remotes\/origin\/main$/;
    const deadline = Date.now() + 8000;
    while (!seen.some((path) => ref.test(path)) && Date.now() < deadline) {
      writeFileSync(join(root, ".git", "refs", "remotes", "origin", "main"), `${Date.now()}\n`);
      await Bun.sleep(200);
    }
    expect(seen.some((path) => ref.test(path))).toBe(true);
  } finally {
    stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("should recheck GitHub a fixed number of times after a push and restart on a new push", async () => {
  let github = 0;
  const unsubscribe = changes.subscribe((change) => {
    if (change.resources.includes("github")) github++;
  });
  try {
    scheduleGithubRechecks("checkout:test", [40, 80, 120]);
    await Bun.sleep(60);
    scheduleGithubRechecks("checkout:test", [40, 80, 120]);
    await Bun.sleep(250);
    expect(github).toBe(4);
    await Bun.sleep(150);
    expect(github).toBe(4);
  } finally {
    unsubscribe();
  }
});
