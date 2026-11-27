import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { loadConfig } from "@orc/core/config";
import { ConflictError, ValidationError } from "@orc/core/errors";
import { shortId, ulid } from "@orc/core/ids";
import type { RuleEvent } from "@orc/core/rule-types";
import { claudeMemoryDirectory, syncClaudeMemory } from "@orc/db/agent-memory";
import { getDb, getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { tasks } from "@orc/db/schema";
import { executeTool } from "@orc/mcp/tools";
import { sql } from "drizzle-orm";

type SnapshotTaskRow = { id: string; title: string; status: string; priority: string };
type SnapshotEventRow = { type: string; priority: number; data: string };

const P1_TYPES = new Set(["file", "task", "rule"]);
const P2_TYPES = new Set(["decision", "git", "env", "error", "plan"]);

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSnapshot(
  taskRows: SnapshotTaskRow[],
  events: SnapshotEventRow[],
  maxBytes: number,
): string {
  const taskXml = taskRows
    .map(
      (t) =>
        `  <task id="${shortId(t.id)}" status="${t.status}" priority="${t.priority}">${escapeXml(t.title)}</task>`,
    )
    .join("\n");

  const p1Events = events.filter((e) => P1_TYPES.has(e.type));
  const p2Events = events.filter((e) => P2_TYPES.has(e.type));
  const p3Events = events.filter((e) => !P1_TYPES.has(e.type) && !P2_TYPES.has(e.type));

  function renderEvents(evs: SnapshotEventRow[], max = 5): string {
    const grouped: Record<string, string[]> = {};
    for (const e of evs.slice(0, max * 3)) {
      if (!grouped[e.type]) grouped[e.type] = [];
      const items = grouped[e.type] ?? [];
      if (items.length >= max) continue;
      try {
        const d = JSON.parse(e.data) as Record<string, string>;
        items.push(
          Object.entries(d)
            .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
            .join(" "),
        );
      } catch {
        items.push(String(e.data).slice(0, 120));
      }
    }
    return Object.entries(grouped)
      .map(
        ([type, items]) =>
          `  <${type}s>${items.map((i) => `<item>${escapeXml(i)}</item>`).join("")}</${type}s>`,
      )
      .join("\n");
  }

  function assemble(includeP2: boolean, includeP3: boolean): string {
    const parts = [`<tasks>\n${taskXml}\n</tasks>`];
    const p1Xml = renderEvents(p1Events);
    if (p1Xml) parts.push(`<context priority="high">\n${p1Xml}\n</context>`);
    if (includeP2) {
      const p2Xml = renderEvents(p2Events);
      if (p2Xml) parts.push(`<context priority="normal">\n${p2Xml}\n</context>`);
    }
    if (includeP3) {
      const p3Xml = renderEvents(p3Events, 3);
      if (p3Xml) parts.push(`<context priority="low">\n${p3Xml}\n</context>`);
    }
    return `<session>\n${parts.join("\n")}\n</session>`;
  }

  for (const [incP2, incP3] of [
    [true, true],
    [true, false],
    [false, false],
  ] as const) {
    const xml = assemble(incP2, incP3);
    if (Buffer.byteLength(xml) <= maxBytes) return xml;
  }

  return `<session>\n<tasks>\n${taskXml}\n</tasks>\n</session>`;
}

function recordContinuityEvent(
  sqlite: Database,
  sessionId: string,
  entry: { type: string; priority: number; data: Record<string, string> },
): void {
  const dataJson = JSON.stringify(entry.data);
  const dataHash = createHash("sha256").update(dataJson).digest("hex").slice(0, 16);
  const recent = sqlite
    .query<{ data_hash: string }, [string, string, number]>(
      `SELECT data_hash FROM session_events
       WHERE session_id = ? AND type = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionId, entry.type, 5);
  if (recent.some((r) => r.data_hash === dataHash)) return;
  const { n } = sqlite
    .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM session_events WHERE session_id = ?")
    .get(sessionId) ?? { n: 0 };
  if (n >= 1000) {
    sqlite
      .query(
        `DELETE FROM session_events WHERE id = (
           SELECT id FROM session_events WHERE session_id = ?
           ORDER BY priority ASC, created_at ASC LIMIT 1
         )`,
      )
      .run(sessionId);
  }
  sqlite
    .query(
      "INSERT INTO session_events(id, session_id, type, priority, data, data_hash) VALUES (?,?,?,?,?,?)",
    )
    .run(ulid(), sessionId, entry.type, entry.priority, dataJson, dataHash);
}

async function snapshotContinuitySession(
  sqlite: Database,
  sessionId: string,
  projectId: string | null,
): Promise<void> {
  const maxBytes = loadConfig().context.snapshot_max_bytes;
  const activeTasks = await getDb().query.tasks.findMany({
    where: sql`${tasks.project_id} IS ${projectId}`,
    limit: 10,
    orderBy: (t, { desc }) => [desc(t.updated_at)],
  });
  const filteredTasks = activeTasks.filter((t) => !["done", "cancelled"].includes(t.status));
  const events = sqlite
    .query<SnapshotEventRow, [string]>(
      `SELECT type, priority, data FROM session_events
       WHERE session_id = ?
       ORDER BY priority ASC, created_at DESC LIMIT 100`,
    )
    .all(sessionId);
  const xml = buildSnapshot(filteredTasks, events, maxBytes);
  sqlite
    .query("INSERT INTO session_snapshots(id, session_id, xml) VALUES (?,?,?)")
    .run(ulid(), sessionId, xml);
}

function restoreContinuitySession(sqlite: Database, sessionId: string): string {
  const snap = sqlite
    .query<{ xml: string }, [string]>(
      "SELECT xml FROM session_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(sessionId);
  if (!snap) return "No session snapshot found. Starting fresh.";
  return `## Session Restored\n\n${snap.xml}`;
}

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
        context.push(restoreContinuitySession(db, continuitySessionId));
        break;
      case "snapshot_session":
        await snapshotContinuitySession(db, continuitySessionId, active.project_id);
        break;
      case "record_event": {
        const classified = sessionEvent(event, target.event_type);
        if (classified) recordContinuityEvent(db, continuitySessionId, classified);
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
