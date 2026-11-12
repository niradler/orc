import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "orc-list-race-test-"));
afterAll(() => {
  mock.restore();
  rmSync(directory, { recursive: true, force: true });
});

test("should skip a file deleted between readdir and stat instead of failing the scan", async () => {
  const fs = await import("node:fs");
  const kept = join(directory, "kept.jsonl");
  writeFileSync(kept, "{}");
  const ghost = {
    name: "ghost.jsonl",
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
  const actualReaddirSync = fs.readdirSync;
  let scanned = 0;
  mock.module("node:fs", () => ({
    ...fs,
    readdirSync: ((path: string, options?: unknown) => {
      const entries = actualReaddirSync(path as never, options as never);
      if (path !== directory) return entries;
      scanned++;
      return [...entries, ghost];
    }) as typeof fs.readdirSync,
  }));
  const { LOCAL_HOST, listHostFiles } = await import("../exec-host.js");
  const files = await listHostFiles(LOCAL_HOST, directory);
  expect(scanned).toBeGreaterThan(0);
  expect(files.map((file) => file.path)).toEqual([kept]);
});
