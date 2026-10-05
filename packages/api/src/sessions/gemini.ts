import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { oneLine } from "./common.js";
import type { SessionAdapter, SessionRecord } from "./types.js";

export const GEMINI_TMP_DIR = join(homedir(), ".gemini", "tmp");
export const GeminiSession = z.object({
  sessionId: z.string().min(1),
  startTime: z.string().datetime(),
  lastUpdated: z.string().datetime(),
  summary: z.string().optional(),
  directories: z.array(z.string()).optional(),
  messages: z.array(
    z.object({
      type: z.string(),
      timestamp: z.string().optional(),
      content: z.unknown(),
      tokens: z.object({ total: z.number().nonnegative() }).nullish(),
      toolCalls: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            args: z.unknown(),
            result: z.unknown().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

export function geminiText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "string" ? [part] : part && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

export function geminiAdapter(root: string = GEMINI_TMP_DIR): SessionAdapter {
  return {
    backend: "gemini",
    minIntervalMs: 30_000,
    async list() {
      if (!existsSync(root)) return [];
      const records: SessionRecord[] = [];
      for (const file of readdirSync(root, { recursive: true }) as string[]) {
        if (!file.endsWith(".json") || !file.split(/[\\/]/).pop()?.startsWith("session-")) continue;
        const path = join(root, file);
        if (statSync(path).size > 50 * 1024 * 1024) continue;
        const parsed = GeminiSession.safeParse(JSON.parse(readFileSync(path, "utf8")));
        if (!parsed.success) continue;
        const data = parsed.data;
        const prompt = geminiText(
          data.messages.find((message) => message.type === "user")?.content,
        );
        records.push({
          backend: "gemini",
          externalId: data.sessionId,
          title: oneLine(data.summary || prompt || data.sessionId, 120),
          summary: oneLine(prompt, 400) || null,
          cwd: data.directories?.[0] ?? null,
          status: "stopped",
          createdAt: new Date(data.startTime),
          lastActivityAt: new Date(data.lastUpdated),
          transcriptPath: path,
          tokensUsed:
            data.messages.reduce((sum, message) => sum + (message.tokens?.total ?? 0), 0) || null,
        });
      }
      return records;
    },
  };
}
