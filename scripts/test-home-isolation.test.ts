import { afterAll, afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanerSource, isolateTestHome } from "./test-home-isolation.js";

const KEYS = [
  "HOME",
  "USERPROFILE",
  "ORC_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const created: string[] = [];

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  // The preload's own home (direct runs only; gates use orc-ci-home-*).
  const home = saved.HOME;
  if (home?.includes("orc-test-home-")) rmSync(home, { recursive: true, force: true });
});

test("a real home is moved under the temp root", () => {
  // The repo root is never under tmpdir(), so it stands in for the real home.
  const realish = realpathSync(join(import.meta.dir, ".."));
  process.env.HOME = realish;
  process.env.USERPROFILE = realish;
  isolateTestHome();
  created.push(process.env.HOME as string);
  expect(realpathSync(process.env.HOME as string).startsWith(realpathSync(tmpdir()))).toBe(true);
  expect(process.env.HOME).not.toBe(realish);
  expect(process.env.USERPROFILE).toBe(process.env.HOME);
});

test("an already isolated home is left untouched", () => {
  const isolated = mkdtempSync(join(tmpdir(), "orc-home-guard-"));
  created.push(isolated);
  process.env.HOME = isolated;
  process.env.USERPROFILE = isolated;
  delete process.env.ORC_HOME;
  isolateTestHome();
  expect(process.env.HOME).toBe(isolated);
});

test("strips an inherited ORC_HOME outside the temp root even when HOME is isolated", () => {
  const realish = realpathSync(join(import.meta.dir, ".."));
  const isolated = mkdtempSync(join(tmpdir(), "orc-home-guard-"));
  created.push(isolated);
  process.env.HOME = isolated;
  process.env.USERPROFILE = isolated;
  process.env.ORC_HOME = join(realish, ".orc");
  isolateTestHome();
  expect(process.env.HOME).toBe(isolated);
  expect(process.env.ORC_HOME).toBeUndefined();

  process.env.HOME = realish;
  process.env.USERPROFILE = realish;
  process.env.ORC_HOME = realish;
  isolateTestHome();
  created.push(process.env.HOME as string);
  expect(process.env.ORC_HOME).toBeUndefined();
  expect(realpathSync(process.env.HOME as string).startsWith(realpathSync(tmpdir()))).toBe(true);
});

test("preserves an ORC_HOME already inside the temp root and strips sibling paths", () => {
  const isolated = mkdtempSync(join(tmpdir(), "orc-home-guard-"));
  created.push(isolated);
  process.env.HOME = isolated;
  process.env.USERPROFILE = isolated;
  const nestedOrcHome = join(isolated, "custom-orc");
  process.env.ORC_HOME = nestedOrcHome;
  isolateTestHome();
  expect(process.env.ORC_HOME).toBe(nestedOrcHome);

  process.env.ORC_HOME = `${realpathSync(tmpdir())}-evil`;
  isolateTestHome();
  expect(process.env.ORC_HOME).toBeUndefined();
});

test("the cleaner abandons a live owner's home at the deadline", async () => {
  const home = mkdtempSync(join(tmpdir(), "orc-cleaner-live-"));
  const script = join(tmpdir(), `orc-cleaner-case-${process.pid}-live.js`);
  created.push(home, script);
  writeFileSync(script, cleanerSource(home, process.pid, script, Date.now() + 100));
  const child = spawn(process.execPath, [script], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  // A long direct run outlives the deadline: the home must survive for the
  // next preload's sweep, and the cleaner removes only its own script.
  expect(existsSync(home)).toBe(true);
  expect(existsSync(script)).toBe(false);
});

test("the cleaner removes the home once the owner pid is gone", async () => {
  const dead = Bun.spawnSync([process.execPath, "-e", "0"]);
  const home = mkdtempSync(join(tmpdir(), "orc-cleaner-dead-"));
  const script = join(tmpdir(), `orc-cleaner-case-${process.pid}-dead.js`);
  created.push(home, script);
  writeFileSync(script, cleanerSource(home, dead.pid, script, Date.now() + 60_000));
  const child = spawn(process.execPath, [script], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  expect(existsSync(home)).toBe(false);
  expect(existsSync(script)).toBe(false);
});
