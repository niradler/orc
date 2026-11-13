import { homedir } from "node:os";
import { join } from "node:path";
import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { USAGE_EVENT_VERSION } from "@orc/core/usage";
import { z } from "zod";
import { oneLine } from "./common.js";
import type { SessionAdapter, SessionRecord } from "./types.js";
import { parseGeminiUsage } from "./usage-parsers.js";

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

export function geminiAdapter(
  root: string | undefined = undefined,
  runtime: HostRuntime = hostRuntime(LOCAL_HOST),
): SessionAdapter {
  return {
    backend: "gemini",
    minIntervalMs: 30_000,
    async list(known) {
      const sessions = root ?? join(await runtime.home(), ".gemini", "tmp");
      const records: SessionRecord[] = [];
      for (const file of await runtime.listFiles(sessions)) {
        if (!file.path.endsWith(".json") || !file.path.split(/[\\/]/).pop()?.startsWith("session-"))
          continue;
        if (file.size > 50 * 1024 * 1024) continue;
        let content: unknown;
        try {
          content = JSON.parse(
            new TextDecoder().decode(await runtime.readFile(file.path, 50 * 1024 * 1024)),
          );
        } catch {
          continue;
        }
        const parsed = GeminiSession.safeParse(content);
        if (!parsed.success) continue;
        const data = parsed.data;
        const prompt = geminiText(
          data.messages.find((message) => message.type === "user")?.content,
        );
        const lastActivityAt = new Date(data.lastUpdated);
        const usage = parseGeminiUsage(data.messages, lastActivityAt.getTime());
        const before = known.get(data.sessionId);
        const record: SessionRecord = {
          backend: "gemini",
          externalId: data.sessionId,
          title: oneLine(data.summary || prompt || data.sessionId, 120),
          summary: oneLine(prompt, 400) || null,
          cwd: data.directories?.[0] ?? null,
          status: "stopped",
          createdAt: new Date(data.startTime),
          lastActivityAt,
          transcriptPath: file.path,
          tokensUsed: usage.tokens || null,
        };
        if (
          !before ||
          lastActivityAt.getTime() > before.lastActivityMs ||
          before?.usageVersion !== USAGE_EVENT_VERSION
        ) {
          record.usage = async () => usage;
          record.usageVersion = USAGE_EVENT_VERSION;
        }
        records.push(record);
      }
      return records;
    },
  };
}
