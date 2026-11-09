import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownloadItem } from "electron";
import { PreviewDownloads } from "./preview-downloads.js";

const directory = mkdtempSync(join(tmpdir(), "orc-download-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
class Download extends EventEmitter {
  path = "";
  bytes = 0;
  cancelled = false;
  getFilename() {
    return "../demo.txt";
  }
  setSavePath(path: string) {
    this.path = path;
  }
  getReceivedBytes() {
    return this.bytes;
  }
  getTotalBytes() {
    return this.bytes;
  }
  cancel() {
    this.cancelled = true;
    this.emit("done", {}, "cancelled");
  }
}
test("should recover after failed downloads, reject incomplete files and bound staging across tabs", () => {
  const store = new PreviewDownloads(directory, () => {}),
    other = new PreviewDownloads(directory, () => {});
  try {
    for (let index = 0; index < 4; index++) {
      const failed = new Download();
      store.start(failed as unknown as DownloadItem);
      failed.bytes = 16_000_001;
      failed.emit("updated");
      expect(failed.cancelled).toBe(true);
    }
    expect(() => store.read(crypto.randomUUID())).toThrow();
    const completed = new Download();
    store.start(completed as unknown as DownloadItem);
    expect(completed.path.startsWith(join(directory, "preview-downloads"))).toBe(true);
    writeFileSync(completed.path, "synthetic");
    completed.bytes = 9;
    completed.emit("done", {}, "completed");
    const state = store.list().find((item) => item.status === "completed");
    expect(state).toBeDefined();
    if (!state) throw new Error("Completed download was not retained");
    expect(store.read(state.id)).toMatchObject({
      type: "download",
      data: Buffer.from("synthetic").toString("base64"),
    });
    expect(store.list()).toEqual([]);
    for (let index = 0; index < 4; index++) store.start(new Download() as unknown as DownloadItem);
    expect(() => other.start(new Download() as unknown as DownloadItem)).toThrow();
    store.cancelActive();
    expect(store.list().every((item) => item.status === "failed")).toBe(true);
    other.start(new Download() as unknown as DownloadItem);
  } finally {
    store.dispose();
    other.dispose();
  }
});
