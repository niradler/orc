import { type AgentSession, openAgentSession } from "@orc/agent-runtime";
import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { renderSkillInstructions, type SkillFull } from "@orc/core/skill-service";
import { getSqlite } from "@orc/db/client";
import { type DigestInput, DigestStore } from "@orc/db/digest";
import { SkillHistory } from "@orc/db/skill-history";

export async function runDigestAgent(input: DigestInput, timeoutMs = 600000): Promise<void> {
  const config = loadConfig();
  const skill = new SkillHistory(getSqlite()).read(
    "orc-wiki",
    input.project_id,
  ) as SkillFull | null;
  if (!skill) throw new Error("orc-wiki digest skill is not installed");
  const cwd =
    input.project_id === null
      ? process.cwd()
      : (getSqlite()
          .query<{ scope: string | null }, [string]>("SELECT scope FROM projects WHERE id=?")
          .get(input.project_id)?.scope ?? process.cwd());
  const sessionId = ulid();
  const sqlite = getSqlite();
  sqlite
    .query(
      "INSERT INTO gateway_sessions(id,backend,mode,cwd,title,chat_id,status,role,project_id,pid) VALUES(?,?,?,?,?,'__task-loop__','running','worker',?,?)",
    )
    .run(
      sessionId,
      config.agent_loop.default_backend,
      "knowledge-digest",
      cwd,
      "Daily knowledge digest",
      input.project_id,
      process.pid,
    );
  let session: AgentSession | undefined;
  let expired = false;
  let trace = "";
  let runtimeId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        void session?.close();
        reject(new Error("Knowledge digest timed out"));
      }, timeoutMs);
    });
    const work = async (): Promise<void> => {
      session = await openAgentSession(config.agent_loop.default_backend, {
        ruleBuiltinActions: false,
        cwd,
        autoApprove: true,
        mcpAlwaysLoad: true,
        systemPromptAppend:
          "For this assigned digest, use the supplied scope and inputs. Do not call startup context; search/read only what the digest requires. MCP tool schemas are loaded for this session.",
        toolAllowlist: [
          "ToolSearch",
          ...[
            "wiki_index",
            "wiki_search",
            "wiki_get",
            "wiki_write",
            "wiki_history",
            "memory_search",
            "memory_get",
            "memory_store",
            "memory_update",
            "audit_list",
            "knowledge_search",
            "knowledge_get",
            "skill_list",
            "skill_read",
            "skill_update",
            "digest_complete",
          ].map((name) => `mcp__orc__${name}`),
        ],
      });
      if (expired) {
        await session.close();
        return;
      }
      const activeSession = session;
      let error: string | null = null;
      const events = (async () => {
        for await (const event of activeSession.events()) {
          sqlite
            .query("UPDATE gateway_sessions SET last_activity_at=unixepoch() WHERE id=?")
            .run(sessionId);
          if (event.type === "text") trace = (trace + event.data).slice(-8000);
          if (event.type === "tool_use") trace = `${trace}\nTool: ${event.data.name}`.slice(-8000);
          if (event.type === "tool_result" && event.data.isError)
            trace = `${trace}\nTool error: ${event.data.content}`.slice(-8000);
          if (event.type === "result") runtimeId = event.data.runtimeSessionId ?? null;
          if (event.type === "error") error = event.data;
          if (event.type === "permission_request")
            activeSession.respondPermission(event.data.requestId, "denied");
          if (event.type === "result") break;
        }
      })();
      await session.send(`${renderSkillInstructions(skill)}

Assigned scope: ${input.project ?? "global"}. All project arguments must use this scope. Use session_id: ${sessionId} and author: orc-wiki on wiki/skill writes.
Digest input:
${JSON.stringify(input)}`);
      await events;
      if (error) throw new Error(error);
      if (!new DigestStore(getSqlite()).completed(input.token))
        throw new Error("Agent ended without digest_complete; watermark unchanged");
    };
    await Promise.race([work(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await session?.close();
    } finally {
      sqlite
        .query(
          "UPDATE gateway_sessions SET status=?,runtime_session_id=?,summary=?,last_error=?,updated_at=unixepoch(),last_activity_at=unixepoch() WHERE id=?",
        )
        .run(
          new DigestStore(sqlite).completed(input.token) ? "stopped" : "error",
          runtimeId ?? session?.id ?? null,
          trace.replaceAll(input.token, "[digest claim]").slice(-8000),
          new DigestStore(sqlite).completed(input.token)
            ? null
            : "Digest ended without confirmed completion; see summary",
          sessionId,
        );
    }
  }
}

export async function runKnowledgeDigest(
  runAgent?: (input: DigestInput) => Promise<void>,
  timeoutMs = 1800000,
): Promise<string> {
  const store = new DigestStore(getSqlite());
  const results: string[] = [];
  let failed = false;
  const deadline = Date.now() + timeoutMs;
  for (const projectId of store.scopes()) {
    if (Date.now() >= deadline) {
      results.push("Job timeout reached; remaining scopes deferred without advancing watermarks");
      failed = true;
      break;
    }
    const input = store.claim(projectId);
    if (!input) continue;
    try {
      await (runAgent
        ? runAgent(input)
        : runDigestAgent(input, Math.min(600000, deadline - Date.now())));
      if (!store.completed(input.token)) throw new Error("Digest did not confirm completion");
      results.push(`${input.project ?? "global"}: completed`);
    } catch (error) {
      failed = true;
      store.fail(
        input.token,
        error instanceof Error ? error.message.slice(0, 2000) : "Digest failed",
      );
      results.push(`${input.project ?? "global"}: failed; will retry without advancing watermark`);
    }
  }
  new SkillHistory(getSqlite()).prune();
  if (failed) throw new Error(results.join("\n"));
  return results.length ? results.join("\n") : "No new knowledge; no agents started";
}
