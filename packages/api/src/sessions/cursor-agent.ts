import { homedir } from "node:os";
import { join } from "node:path";
import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
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

export function cursorAgentAdapter(
  root: string | undefined = undefined,
  runtime: HostRuntime = hostRuntime(LOCAL_HOST),
): SessionAdapter {
  return {
    backend: "cursor-agent",
    minIntervalMs: 30_000,
    async list() {
      const chats = root ?? join(await runtime.home(), ".cursor", "chats");
      const records: SessionRecord[] = [];
      for (const file of await runtime.listFiles(chats)) {
        if (!/[\\/]meta\.json$/.test(file.path)) continue;
        const id = file.path.split(/[\\/]/).at(-2);
        if (!id) continue;
        let content: unknown;
        try {
          content = JSON.parse(
            new TextDecoder().decode(await runtime.readFile(file.path, 2 * 1024 * 1024)),
          );
        } catch {
          continue;
        }
        const parsed = ChatMeta.safeParse(content);
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
