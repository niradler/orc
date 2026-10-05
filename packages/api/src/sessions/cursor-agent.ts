import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { oneLine } from "./common.js";
import type { SessionAdapter, SessionRecord } from "./types.js";

export const CURSOR_CHATS_DIR = join(homedir(), ".cursor", "chats");
const ChatMeta = z.object({
  title: z.string().optional(),
  cwd: z.string().optional(),
  createdAtMs: z.number().finite(),
  updatedAtMs: z.number().finite().optional(),
});

export function cursorAgentAdapter(root: string = CURSOR_CHATS_DIR): SessionAdapter {
  return {
    backend: "cursor-agent",
    minIntervalMs: 30_000,
    async list() {
      if (!existsSync(root)) return [];
      const records: SessionRecord[] = [];
      for (const file of readdirSync(root, { recursive: true }) as string[]) {
        if (!file.endsWith(`${process.platform === "win32" ? "\\" : "/"}meta.json`)) continue;
        const id = file.split(/[\\/]/).at(-2);
        if (!id) continue;
        const parsed = ChatMeta.safeParse(JSON.parse(readFileSync(join(root, file), "utf8")));
        if (!parsed.success) continue;
        const data = parsed.data;
        records.push({
          backend: "cursor-agent",
          externalId: id,
          title: oneLine(data.title || id, 120),
          cwd: data.cwd ?? null,
          status: "stopped",
          createdAt: new Date(data.createdAtMs),
          lastActivityAt: new Date(data.updatedAtMs ?? data.createdAtMs),
        });
      }
      return records;
    },
  };
}
