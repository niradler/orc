import { isAbsolute, join, posix } from "node:path";
import { loadConfig } from "@orc/core/config";
import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { z } from "zod";
import { oneLine } from "./common.js";
import type { SessionAdapter, SessionRecord } from "./types.js";

const headerSchema = z.object({
  type: z.literal("session"),
  version: z.literal(3),
  id: z.uuid(),
  timestamp: z.string().datetime(),
  cwd: z.string().min(1),
});
const entrySchema = z.object({
  type: z.string(),
  id: z.string().min(1),
  parentId: z.string().nullable(),
  timestamp: z.string().datetime(),
  message: z
    .object({
      role: z.string(),
      content: z.unknown(),
      toolCallId: z.string().optional(),
      usage: z.object({ totalTokens: z.number().finite().nonnegative().optional() }).optional(),
    })
    .passthrough()
    .optional(),
  name: z.string().optional(),
  targetId: z.string().optional(),
  replacement: z.object({ content: z.unknown() }).nullable().optional(),
});

export function piText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) => {
      const text = z.object({ type: z.literal("text"), text: z.string() }).safeParse(part);
      return text.success ? [text.data.text] : [];
    })
    .join("\n");
}

/** Pi resumes the last entry's parent chain, rather than every branch in its append-only log. */
export function parsePiSession(content: string) {
  const records: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* A writer may have an incomplete final record. */
    }
  }
  const header = headerSchema.safeParse(records[0]);
  if (!header.success) return null;
  const entries = records.slice(1).flatMap((record) => {
    const parsed = entrySchema.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: z.infer<typeof entrySchema>[] = [];
  const visited = new Set<string>();
  let entry = entries.at(-1);
  while (entry && !visited.has(entry.id)) {
    visited.add(entry.id);
    branch.push(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  branch.reverse();
  const edits = new Map(
    branch
      .filter((item) => item.type === "context_edit" && item.targetId)
      .map((item) => [item.targetId, item.replacement]),
  );
  const messages = branch.flatMap((item) => {
    if (item.type !== "message" || !item.message) return [];
    const replacement = edits.get(item.id);
    if (replacement === null) return [];
    return [
      {
        ...item,
        message: { ...item.message, ...(replacement ? { content: replacement.content } : {}) },
      },
    ];
  });
  return { header: header.data, entries, branch, messages };
}

export function piAdapter(
  root?: string,
  runtime: HostRuntime = hostRuntime(LOCAL_HOST),
): SessionAdapter {
  return {
    backend: "pi",
    minIntervalMs: 5_000,
    async list() {
      const records: SessionRecord[] = [];
      const directories = root ? [root] : await piSessionRoots(runtime);
      const files = (
        await Promise.all(directories.map((directory) => runtime.listFiles(directory)))
      ).flat();
      const seen = new Set<string>();
      for (const file of files) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        if (!file.path.endsWith(".jsonl") || file.size > 50 * 1024 * 1024) continue;
        let content: string;
        try {
          content = new TextDecoder().decode(await runtime.readFile(file.path, 50 * 1024 * 1024));
        } catch {
          continue;
        }
        const parsed = parsePiSession(content);
        if (!parsed) continue;
        const prompt = piText(
          parsed.messages.find((item) => item.message.role === "user")?.message.content,
        );
        const name = parsed.entries.filter((item) => item.type === "session_info").at(-1)?.name;
        records.push({
          backend: "pi",
          externalId: parsed.header.id,
          title: oneLine(name || prompt || parsed.header.id, 120),
          summary: oneLine(prompt, 400) || null,
          cwd: parsed.header.cwd,
          status: "stopped",
          createdAt: new Date(parsed.header.timestamp),
          lastActivityAt: new Date(
            parsed.entries.reduce(
              (latest, item) => Math.max(latest, Date.parse(item.timestamp)),
              Date.parse(parsed.header.timestamp),
            ),
          ),
          transcriptPath: file.path,
          tokensUsed:
            parsed.entries.reduce(
              (sum, item) => sum + (item.message?.usage?.totalTokens ?? 0),
              0,
            ) || null,
        });
      }
      return records;
    },
  };
}

export async function piSessionRoots(runtime: HostRuntime): Promise<string[]> {
  const home = await runtime.home();
  const joinHost = runtime.host.kind === "ssh" ? posix.join : join;
  const absolute = runtime.host.kind === "ssh" ? posix.isAbsolute : isAbsolute;
  const configured = (loadConfig().providers?.instances ?? [])
    .filter((profile) => profile.agent === "pi")
    .flatMap((profile) =>
      profile.environment
        .filter((row) => row.name === "PI_CODING_AGENT_DIR" && !row.secret)
        .map((row) => row.value),
    );
  if (runtime.host.kind === "local" && process.env.PI_CODING_AGENT_DIR)
    configured.push(process.env.PI_CODING_AGENT_DIR);
  const roots = [joinHost(home, ".pi", "agent", "sessions")];
  for (const directory of configured) {
    const expanded =
      directory.startsWith("~/") || directory.startsWith("~\\")
        ? joinHost(home, directory.slice(2))
        : directory;
    if (absolute(expanded)) roots.push(joinHost(expanded, "sessions"));
  }
  return [...new Set(roots)];
}
