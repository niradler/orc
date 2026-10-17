import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changes } from "@orc/core/changes";
import { LOCAL_HOST } from "@orc/core/exec-host";
import { watchProcessExit } from "../realtime/process-watch.js";
import { watchResourcePath } from "../realtime/sources.js";
import { startSessionWatcher } from "../session-watcher.js";
import { setupTestApp, teardownTestApp } from "./helpers.js";

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
    await Bun.sleep(250);
    expect(events).toBeGreaterThan(0);
    const previous = events;
    writeFileSync(join(target, "SKILL.md"), "Second");
    await Bun.sleep(250);
    expect(events).toBeGreaterThan(previous);
    const settled = events;
    await Bun.sleep(250);
    expect(events).toBe(settled);
  } finally {
    stop();
  }
});

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

test("should notify transcript file changes even when the session metadata does not change", async () => {
  setupTestApp();
  const root = mkdtempSync(join(tmpdir(), "orc-transcript-watch-"));
  const stop = startSessionWatcher({
    adapters: [{ backend: "unchanged-metadata", minIntervalMs: 0, list: async () => [] }],
    registryDir: root,
    liveRegistryDir: null,
  });
  let events = 0;
  let unsubscribe = (): void => {};
  try {
    await Bun.sleep(300);
    unsubscribe = changes.subscribe((event) => {
      if (event.resources.includes("sessions")) events++;
    });
    writeFileSync(join(root, "transcript.jsonl"), '{"message":"new output"}\n');
    await Bun.sleep(400);
    expect(events).toBeGreaterThan(0);
  } finally {
    unsubscribe();
    stop();
    teardownTestApp();
  }
});
