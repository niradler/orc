import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PreviewDownload } from "@orc/core/desktop-preview";
import type { DownloadItem } from "electron";

/** At most four 16 MB staged files across the app; only owned downloads enter this store. */
export class PreviewDownloads {
  private static reserved = 0;
  private static roots = new Set<string>();
  private readonly entries = new Map<
    string,
    {
      state: PreviewDownload;
      item: DownloadItem;
      path: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly userData: string,
    private readonly changed: () => void,
  ) {}
  private folder(): string {
    const root = join(this.userData, "preview-downloads");
    if (!PreviewDownloads.roots.has(root)) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      for (const id of readdirSync(root))
        if (/^\d+$/.test(id) && Number(id) !== process.pid) {
          try {
            process.kill(Number(id), 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH")
              rmSync(join(root, id), { recursive: true, force: true });
          }
        }
      PreviewDownloads.roots.add(root);
    }
    const folder = join(root, String(process.pid));
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    return folder;
  }
  start(item: DownloadItem): void {
    for (const [id, entry] of this.entries)
      if (entry.state.status === "failed") this.entries.delete(id);
    if (PreviewDownloads.reserved >= 4 || this.entries.size >= 4)
      throw new Error("Save or close an existing download before downloading more");
    const id = randomUUID(),
      name =
        item
          .getFilename()
          .split("")
          .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
          .join("")
          .replace(/[<>:"/\\|?*]/g, "_")
          .slice(-180) || "download.bin";
    const path = join(this.folder(), id);
    item.setSavePath(path);
    const state: PreviewDownload = { id, name, status: "downloading", bytes: 0 };
    const entry = { state, item, path, timer: setTimeout(() => item.cancel(), 60000) };
    this.entries.set(id, entry);
    PreviewDownloads.reserved++;
    item.on("updated", () => {
      state.bytes = item.getReceivedBytes();
      if (state.bytes > 16_000_000 || item.getTotalBytes() > 16_000_000) item.cancel();
      this.changed();
    });
    item.once("done", (_event, status) => {
      clearTimeout(entry.timer);
      state.bytes = item.getReceivedBytes();
      state.status = status === "completed" && state.bytes <= 16_000_000 ? "completed" : "failed";
      if (state.status === "failed") {
        rmSync(path, { force: true });
        PreviewDownloads.reserved--;
      }
      this.changed();
    });
    this.changed();
  }
  list(): PreviewDownload[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.state }));
  }
  read(id: string): unknown {
    const entry = this.entries.get(id);
    if (entry?.state.status !== "completed")
      throw new Error("Download is not complete or was interrupted");
    const bytes = readFileSync(entry.path);
    if (bytes.length > 16_000_000) throw new Error("Download exceeds 16 MB");
    rmSync(entry.path, { force: true });
    this.entries.delete(id);
    PreviewDownloads.reserved--;
    this.changed();
    return {
      type: "download",
      name: entry.state.name,
      mimeType: "application/octet-stream",
      data: bytes.toString("base64"),
    };
  }
  cancelActive(): void {
    for (const entry of this.entries.values())
      if (entry.state.status === "downloading") entry.item.cancel();
  }
  dispose(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      if (entry.state.status === "downloading") entry.item.cancel();
      if (entry.state.status === "completed") PreviewDownloads.reserved--;
      rmSync(entry.path, { force: true });
    }
    this.entries.clear();
  }
}
