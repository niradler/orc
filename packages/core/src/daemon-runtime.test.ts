import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeDaemonPid,
  canonicalPath,
  clearDaemonRuntime,
  type DaemonRuntime,
  isProcessAlive,
  readDaemonRuntime,
  writeDaemonRuntime,
} from "./daemon-runtime.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  directories.length = 0;
});

function fixture(): { directory: string; record: DaemonRuntime } {
  const directory = mkdtempSync(join(tmpdir(), "orc-daemon-runtime-"));
  directories.push(directory);
  const record = {
    pid: process.pid,
    port: 7700,
    instance_id: randomUUID(),
    version: "0.1.60",
    db_path: canonicalPath(join(directory, "orc.db")),
    config_path: canonicalPath(join(directory, "config.json")),
    auth_enabled: true,
    started_at: new Date().toISOString(),
  };
  writeFileSync(join(directory, "daemon.pid"), String(record.pid));
  return { directory, record };
}

describe("daemon runtime identity", () => {
  test("should round-trip only public metadata with private file permissions", () => {
    const { directory, record } = fixture();
    writeDaemonRuntime({ ...record, secret: "must-not-be-written" } as DaemonRuntime, directory);
    expect(readDaemonRuntime(directory)).toEqual(record);
    const path = join(directory, "daemon.json");
    expect(readFileSync(path, "utf8")).not.toContain("must-not-be-written");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("should ignore metadata for a stale or different daemon PID", () => {
    const { directory, record } = fixture();
    writeDaemonRuntime({ ...record, pid: 2147483647 }, directory);
    expect(readDaemonRuntime(directory)).toBeNull();
    writeFileSync(join(directory, "daemon.pid"), "2147483647");
    expect(activeDaemonPid(directory)).toBeNull();
  });

  test("should ignore incomplete, malformed and missing runtime records", () => {
    const { directory } = fixture();
    expect(readDaemonRuntime(directory)).toBeNull();
    for (const value of ["{", "null", "{}", '{"port":"7700"}']) {
      writeFileSync(join(directory, "daemon.json"), value);
      expect(readDaemonRuntime(directory)).toBeNull();
    }
  });

  test("should never use zero, negative or nonnumeric PID values", () => {
    const { directory } = fixture();
    for (const value of ["", "0", "-1", "NaN", "1.5"]) {
      writeFileSync(join(directory, "daemon.pid"), value);
      expect(activeDaemonPid(directory)).toBeNull();
    }
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("should remove only the exiting daemon's own runtime record", () => {
    const { directory, record } = fixture();
    writeDaemonRuntime(record, directory);
    clearDaemonRuntime(randomUUID(), directory);
    expect(readDaemonRuntime(directory)).toEqual(record);
    clearDaemonRuntime(record.instance_id, directory);
    expect(existsSync(join(directory, "daemon.json"))).toBe(false);
    clearDaemonRuntime(record.instance_id, directory);
  });

  test("should reject invalid ports and instance IDs before writing", () => {
    const { directory, record } = fixture();
    expect(() => writeDaemonRuntime({ ...record, port: 0 }, directory)).toThrow();
    expect(() => writeDaemonRuntime({ ...record, instance_id: "not-an-id" }, directory)).toThrow();
    expect(existsSync(join(directory, "daemon.json"))).toBe(false);
  });

  test("should clean an owned record even after the PID file is retired", () => {
    const { directory, record } = fixture();
    writeDaemonRuntime(record, directory);
    unlinkSync(join(directory, "daemon.pid"));
    clearDaemonRuntime(record.instance_id, directory);
    expect(existsSync(join(directory, "daemon.json"))).toBe(false);
  });

  test("should keep new database identity stable through a linked data directory", () => {
    const { directory } = fixture();
    const target = join(directory, "data");
    const linked = join(directory, "linked");
    mkdirSync(target);
    symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");
    const before = canonicalPath(join(linked, "new.db"));
    writeFileSync(join(target, "new.db"), "");
    expect(canonicalPath(join(linked, "new.db"))).toBe(before);
    expect(before).toBe(canonicalPath(join(target, "new.db")));
  });
});
