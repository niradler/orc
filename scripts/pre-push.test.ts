import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePush } from "./pre-push.js";

const zero = "0".repeat(40);

test("should leave ref-only deletions and empty pushes without a CI run", () => {
  expect(validatePush("unused", "")).toBe(false);
  expect(validatePush("unused", `(delete) ${zero} refs/heads/old ${"a".repeat(40)}\n`)).toBe(false);
});

test("should reject malformed ref input before invoking Git", () => {
  for (const records of [
    "HEAD invalid",
    `HEAD --help refs/heads/main ${zero}`,
    `HEAD ${zero} refs/heads/main invalid`,
  ])
    expect(() => validatePush("unused", records)).toThrow("Invalid pre-push ref input");
});

test("should validate the actual pushed commits and reject dirty or unrelated checkouts", () => {
  const directory = mkdtempSync(join(tmpdir(), "orc-push-hook-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  function git(...args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd: directory, env, timeout: 10_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  try {
    git("init");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "ci@example.invalid");
    const file = join(directory, "source.ts");
    writeFileSync(file, "export const value = 1;\n");
    git("add", ".");
    git("-c", "core.hooksPath=", "commit", "-m", "first");
    const first = git("rev-parse", "HEAD");
    writeFileSync(file, "export const value = 2;\n");
    git("add", ".");
    git("-c", "core.hooksPath=", "commit", "-m", "second");
    const head = git("rev-parse", "HEAD");
    const records = `HEAD ${head} refs/heads/feature ${first}\n`;
    expect(validatePush(directory, records)).toBe(true);
    expect(validatePush(directory, `HEAD ${head} refs/heads/new ${zero}\n`)).toBe(true);
    git("tag", "-a", "candidate", "-m", "candidate");
    expect(
      validatePush(
        directory,
        `refs/tags/candidate ${git("rev-parse", "candidate")} refs/tags/candidate ${zero}\n`,
      ),
    ).toBe(true);
    const stale = `refs/heads/old ${first} refs/heads/old ${zero}\n`;
    expect(() => validatePush(directory, stale)).toThrow("checkout of its commit");
    expect(() => validatePush(directory, records + stale)).toThrow("checkout of its commit");
    writeFileSync(file, "export const value = 3;\n");
    expect(() => validatePush(directory, records)).toThrow("clean checkout");
    git("add", ".");
    expect(() => validatePush(directory, records)).toThrow("clean checkout");
    writeFileSync(file, "export const value = 2;\n");
    git("add", ".");
    expect(validatePush(directory, records)).toBe(true);
    writeFileSync(join(directory, "untracked.ts"), "export const hidden = true;\n");
    expect(() => validatePush(directory, records)).toThrow("clean checkout");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
