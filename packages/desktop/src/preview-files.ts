import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { PreviewFile } from "@orc/core/desktop-preview";
import { type BrowserWindow, dialog, nativeImage } from "electron";
import { decodeText, MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from "./viewer-policy.js";

/** Opaque grants are created only by the user's native file picker, never by MCP. */
export class PreviewLocalFiles {
  private readonly grants = new Map<string, string>();
  private picking = false;
  constructor(private readonly owner: BrowserWindow) {}
  async pick(): Promise<PreviewFile | null> {
    if (this.picking) return null;
    this.picking = true;
    try {
      const selected = await dialog.showOpenDialog(this.owner, {
        title: "Preview file",
        properties: ["openFile"],
      });
      if (selected.canceled || !selected.filePaths[0] || this.owner.isDestroyed()) return null;
      return this.readPath(await realpath(selected.filePaths[0]));
    } finally {
      this.picking = false;
    }
  }
  private async readPath(path: string, existingToken?: string): Promise<PreviewFile> {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES)
      throw new Error("Choose a regular text or image file up to 8 MiB");
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_IMAGE_BYTES) throw new Error("File exceeds 8 MiB");
      bytes = buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
    const imageFile = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"].includes(
      extname(path).toLowerCase(),
    );
    let file: PreviewFile;
    if (imageFile) {
      const image = nativeImage.createFromBuffer(bytes);
      const size = image.getSize();
      if (image.isEmpty() || size.width * size.height > 16_000_000)
        throw new Error("Choose a supported image up to 16 megapixels");
      file = {
        kind: "image",
        path,
        root: dirname(path),
        host: null,
        content: image.toDataURL(),
        editable: false,
      };
    } else {
      if (bytes.length > MAX_TEXT_BYTES) throw new Error("Text previews are limited to 1 MiB");
      file = {
        kind: "text",
        path,
        root: dirname(path),
        host: null,
        content: decodeText(bytes),
        editable: bytes.length <= 200_000,
      };
    }
    const token = existingToken ?? randomUUID();
    if (!existingToken && this.grants.size >= 16)
      throw new Error("Close a local preview tab before opening more files");
    this.grants.set(token, path);
    return { ...file, local_token: token };
  }
  async read(token: string): Promise<PreviewFile> {
    const path = this.grants.get(token);
    if (!path || (await realpath(path)) !== path)
      throw new Error("File permission expired or file changed location");
    return this.readPath(path, token);
  }
  release(token: string): void {
    this.grants.delete(token);
  }
  clear(): void {
    this.grants.clear();
  }
  async save(token: string, content: string, original: string): Promise<void> {
    const path = this.grants.get(token);
    if (!path) throw new Error("File permission expired. Choose the file again.");
    if (
      Buffer.byteLength(content) > 200_000 ||
      Buffer.byteLength(original) > 200_000 ||
      content.includes("\0")
    )
      throw new Error("Only text up to 200 KB can be saved");
    if ((await realpath(path)) !== path) throw new Error("File changed location. Choose it again.");
    const handle = await open(
      path,
      constants.O_RDWR | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 200_000)
        throw new Error("File is no longer editable");
      const bytes = Buffer.alloc(info.size);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (decodeText(bytes.subarray(0, length)) !== original)
        throw new Error("File changed on disk. Reload before saving.");
      const next = Buffer.from(content);
      let written = 0;
      while (written < next.length) {
        const result = await handle.write(next, written, next.length - written, written);
        if (!result.bytesWritten) throw new Error("Save made no progress");
        written += result.bytesWritten;
      }
      await handle.truncate(next.length);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
