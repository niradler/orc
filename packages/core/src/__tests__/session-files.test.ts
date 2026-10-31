import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { LOCAL_HOST } from "../exec-host";
import { UPLOAD_MAX_BYTES } from "../session-file-types";
import { storeSessionFiles, uploadFilename } from "../session-files";

test("should preserve binary uploads, isolate duplicate names and honor directory overrides", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-uploads-"));
  try {
    const data = new Uint8Array([0, 255, 13, 10, 1]);
    expect(
      Bun.spawnSync(["git", "init", cwd], { stdout: "ignore", stderr: "ignore", timeout: 10000 })
        .exitCode,
    ).toBe(0);
    const files = await storeSessionFiles({
      host: LOCAL_HOST,
      cwd,
      sessionId: "session",
      files: [
        { name: "sample.bin", mimeType: "application/octet-stream", data },
        { name: "sample.bin", mimeType: "application/octet-stream", data },
      ],
    });
    expect(files[0]?.path).not.toBe(files[1]?.path);
    for (const file of files) {
      expect(file.path).toContain(join(".orc", "sessions", "session", "uploads"));
      expect(new Uint8Array(readFileSync(file.path))).toEqual(data);
    }
    expect(
      Bun.spawnSync(["git", "-C", cwd, "check-ignore", "-q", files[0]?.path ?? ""], {
        stdout: "ignore",
        stderr: "ignore",
        timeout: 10000,
      }).exitCode,
    ).toBe(0);
    const custom = await storeSessionFiles({
      host: LOCAL_HOST,
      cwd,
      sessionId: "session",
      directory: "attachments",
      files: [{ name: "../../payload.txt", mimeType: "text/plain", data }],
    });
    expect(custom[0]?.path).toContain(join(cwd, "attachments", "session", "uploads"));
    expect(relative(cwd, custom[0]?.path ?? "").split(sep)).not.toContain("..");
    expect(basename(custom[0]?.path ?? "")).toBe(uploadFilename("../../payload.txt"));
    await expect(
      storeSessionFiles({ host: LOCAL_HOST, cwd, sessionId: "../escape", files: [] }),
    ).rejects.toThrow("Invalid upload session");
    await expect(
      storeSessionFiles({
        host: LOCAL_HOST,
        cwd,
        sessionId: "session",
        files: [{ name: "big", mimeType: "", data: new Uint8Array(UPLOAD_MAX_BYTES + 1) }],
      }),
    ).rejects.toThrow("20 MB");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("should reject a redirected upload directory and sanitize reserved filenames", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-upload-links-"));
  const outside = mkdtempSync(join(tmpdir(), "orc-upload-outside-"));
  try {
    symlinkSync(outside, join(cwd, ".orc"), process.platform === "win32" ? "junction" : "dir");
    await expect(
      storeSessionFiles({
        host: LOCAL_HOST,
        cwd,
        sessionId: "session",
        files: [{ name: "secret.txt", mimeType: "text/plain", data: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow("symbolic links");
    expect(uploadFilename("NUL.txt")).not.toBe("NUL.txt");
    expect(uploadFilename("a\nb.txt")).toBe("a_b.txt");
    expect(
      new TextEncoder().encode(uploadFilename(`${"字".repeat(180)}.txt`)).length,
    ).toBeLessThanOrEqual(180);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
