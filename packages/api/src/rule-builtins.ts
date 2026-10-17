import { createHash } from "node:crypto";
import { ConflictError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import type { RuleEvent } from "@orc/core/rule-types";
import { claudeMemoryDirectory, syncClaudeMemory } from "@orc/db/agent-memory";
import { getSqlite } from "@orc/db/client";
import { DIGEST_COMMAND, DIGEST_JOB_NAME, DigestStore } from "@orc/db/digest";
import { RuleStore } from "@orc/db/rules";
import { executeTool } from "@orc/mcp/tools";

function sessionEvent(
  event: RuleEvent,
  configured: string | undefined,
): { type: string; priority: number; data: Record<string, string> } | null {
  const tool = event.tool ?? "";
  const command = event.input.command ?? event.input.cmd;
  let type = configured && configured !== "auto" ? configured : "";
  if (!type) {
    if (
      [
        "Write",
        "Edit",
        "MultiEdit",
        "StrReplace",
        "EditNotebook",
        "write_file",
        "create_file",
        "str_replace",
        "apply_patch",
      ].includes(tool)
    )
      type = "file";
    else if (event.failed) type = "error";
    else if (typeof command === "string" && /^git\s/.test(command)) type = "git";
    else if (
      typeof command === "string" &&
      /^(?:npm|pnpm|bun|pip|uv|cargo)\s+(?:install|add|remove)\b/.test(command)
    )
      type = "env";
    else if (tool.includes("task_") || ["TodoWrite", "todo_write"].includes(tool)) type = "task";
    else if (tool.includes("memory_")) type = "decision";
    else if (["Agent", "agent"].includes(tool)) type = "subagent";
    else if (["EnterPlanMode", "ExitPlanMode"].includes(tool)) type = "plan";
    else return null;
  }
  const data: Record<string, string> = { tool };
  const path = event.input.file_path ?? event.input.path ?? event.input.target_notebook;
  if (type === "file" && typeof path === "string") data.path = path.slice(0, 4096);
  if (typeof command === "string")
    data.command_hash = createHash("sha256").update(command).digest("hex");
  if (typeof event.input.id === "string") data.resource_id = event.input.id.slice(0, 200);
  if (type === "plan") data.action = tool === "EnterPlanMode" ? "enter" : "exit";
  return { type, priority: ["file", "task"].includes(type) ? 1 : 2, data };
}

export async function executeBuiltinRuleAction(
  event: RuleEvent,
  revisionId: string,
  ruleId: string,
): Promise<{ context: string[]; status: string }> {
  const db = getSqlite();
  const store = new RuleStore(db);
  const active = store.active(event.cwd).find((entry) => entry.id === revisionId);
  const selected = active?.policy?.rules.find((rule) => rule.id === ruleId);
  if (!active || selected?.kind !== "event" || selected.target.type !== "orc_action")
    throw new ValidationError("Active built-in rule action not found");
  const decision = store.evaluate(event);
  if (
    decision.decision === "deny" ||
    !decision.orc_actions?.some(
      (entry) => entry.revision_id === revisionId && entry.rule_id === ruleId,
    )
  )
    throw new ValidationError("Built-in action does not match this event");
  const target = selected.target;
  const continuitySessionId = `rule:${createHash("sha256")
    .update(JSON.stringify([event.backend, event.session_id, active.workspace, active.project_id]))
    .digest("hex")}`;
  const readonly = ["load_context", "restore_session"].includes(target.action);
  const serialized = JSON.stringify(event);
  const inputHash = createHash("sha256").update(serialized).digest("hex");
  const key = createHash("sha256")
    .update(
      JSON.stringify([revisionId, ruleId, event.session_id, event.id, event.phase, "builtin"]),
    )
    .digest("hex");
  const receipt = db
    .transaction(() => {
      const existing = db
        .query<{ id: string; input_hash: string; result: string }, [string]>(
          "SELECT id,input_hash,result FROM rule_decisions WHERE event_key=?",
        )
        .get(key);
      if (existing) {
        if (existing.input_hash !== inputHash)
          throw new ConflictError("Action identity reused with different input");
        const result = JSON.parse(existing.result) as { status: string };
        if (result.status !== "done" && result.status !== "skipped")
          throw new ConflictError("Action effects are uncertain; do not blindly replay");
        return { id: existing.id, replay: true, status: result.status };
      }
      const id = ulid();
      db.query(
        "INSERT INTO rule_decisions(id,event_key,input_hash,revision_id,session_id,phase,tool,result,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        key,
        inputHash,
        revisionId,
        event.session_id,
        `orc_action:${target.action}`,
        event.tool ?? null,
        JSON.stringify({ status: "pending", rule_id: ruleId, action: target.action }),
        Date.now(),
      );
      return { id, replay: false, status: "pending" };
    })
    .immediate();
  if (receipt.replay && !readonly) return { context: [], status: receipt.status };
  const context: string[] = [];
  let status = "done";
  try {
    switch (target.action) {
      case "load_context":
        context.push(await executeTool("context", { project_id: active.project_id }));
        break;
      case "restore_session":
        context.push(await executeTool("session_restore", { session_id: continuitySessionId }));
        break;
      case "snapshot_session":
        await executeTool("session_snapshot", {
          session_id: continuitySessionId,
          project_id: active.project_id,
        });
        break;
      case "record_event": {
        const classified = sessionEvent(event, target.event_type);
        if (classified)
          await executeTool("session_event", { ...classified, session_id: continuitySessionId });
        else status = "skipped";
        break;
      }
      case "sync_agent_memory": {
        const synced = syncClaudeMemory(
          db,
          event,
          active.project_id,
          claudeMemoryDirectory(event.cwd, target.memory_directory),
        );
        if (synced.skipped.length)
          context.push(
            [
              "ORC skipped Claude memory files:",
              ...synced.skipped.map((skip) => `- ${skip.file}: ${skip.reason}`),
            ].join("\n"),
          );
        if (!synced.updated) status = "skipped";
        break;
      }
      case "queue_knowledge_digest": {
        if (!new DigestStore(db).hasChanges(active.project_id)) {
          status = "skipped";
          break;
        }
        const job = db
          .query<{ id: string }, [string, string]>(
            "SELECT id FROM jobs WHERE name=? AND command=? AND enabled=1",
          )
          .get(DIGEST_JOB_NAME, DIGEST_COMMAND);
        if (!job) throw new Error("Knowledge digest job unavailable");
        const queued = db
          .transaction(() => {
            if (
              db
                .query(
                  "SELECT 1 FROM rule_actions WHERE job_id=? AND status IN ('pending','running') UNION SELECT 1 FROM job_runs WHERE job_id=? AND status IN ('pending','running') LIMIT 1",
                )
                .get(job.id, job.id)
            )
              return false;
            const count =
              db
                .query<{ count: number }, []>(
                  "SELECT count(*) AS count FROM rule_actions WHERE status='pending'",
                )
                .get()?.count ?? 0;
            if (count >= 1000) throw new Error("Rule action queue capacity exceeded");
            db.query(
              "INSERT INTO rule_actions(id,decision_id,rule_id,job_id,status,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)",
            ).run(ulid(), receipt.id, ruleId, job.id, Date.now(), Date.now());
            return true;
          })
          .immediate();
        if (!queued) status = "skipped";
        break;
      }
    }
    if (context.join("").length > 16000) throw new Error("Built-in context exceeds limit");
    db.query("UPDATE rule_decisions SET result=? WHERE id=?").run(
      JSON.stringify({
        status,
        rule_id: ruleId,
        action: target.action,
        context_hash: context.length
          ? createHash("sha256").update(context.join("\n")).digest("hex")
          : null,
      }),
      receipt.id,
    );
    return { context, status };
  } catch {
    db.query("UPDATE rule_decisions SET result=? WHERE id=?").run(
      JSON.stringify({
        status: "failed",
        rule_id: ruleId,
        action: target.action,
        reason: "Built-in action failed; inspect service availability and configuration",
      }),
      receipt.id,
    );
    throw new ValidationError("Built-in action failed; inspect action history");
  }
}
