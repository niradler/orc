import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateTestHome } from "./test-home-isolation.js";

const KEYS = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"] as const;
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
  isolateTestHome();
  expect(process.env.HOME).toBe(isolated);
});
