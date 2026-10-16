import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LiveRegistration, writeRegistration } from "./live-session";

async function lockRegistration(file: string, milliseconds: number) {
  const script = `$file = [IO.File]::Open('${file.replaceAll("'", "''")}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); [Console]::WriteLine('locked'); Start-Sleep -Milliseconds ${milliseconds}; $file.Dispose()`;
  const process = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdout: "pipe",
    stderr: "inherit",
    timeout: 10000,
    windowsHide: true,
  });
  const { value } = await process.stdout.getReader().read();
  expect(new TextDecoder().decode(value)).toContain("locked");
  return process;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orc-registration-race-"));
  const record: LiveRegistration = {
    backend: "codex",
    externalId: "reader",
    pid: process.pid,
    title: "Registration race",
    status: "idle",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  writeRegistration(record, dir);
  return { dir, record, file: join(dir, "codex-reader.json") };
}

describe.skipIf(process.platform !== "win32")("Windows atomic live-session updates", () => {
  test("waits for a transient reader lock and preserves the complete record", async () => {
    const { dir, record, file } = fixture();
    const reader = await lockRegistration(file, 200);
    try {
      writeRegistration({ ...record, status: "stopped" }, dir);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...record, status: "stopped" });
    } finally {
      await reader.exited;
    }
  }, 10000);

  test("surfaces a persistent lock within a bound and keeps the previous record", async () => {
    const { dir, record, file } = fixture();
    const reader = await lockRegistration(file, 1400);
    const started = Date.now();
    try {
      expect(() => writeRegistration({ ...record, status: "stopped" }, dir)).toThrow();
      expect(Date.now() - started).toBeLessThan(1300);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
    } finally {
      await reader.exited;
    }
  }, 10000);
});
