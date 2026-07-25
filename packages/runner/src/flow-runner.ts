import type { AgentSession } from "@orc/agent-runtime";
import { openAgentSession } from "@orc/agent-runtime";
import { loadConfig } from "@orc/core/config";
import type { FlowCondition, FlowDefinition, FlowNode, NumericOperand } from "@orc/core/flow";
import { declaredOutcomes, resolvePlaceholder } from "@orc/core/flow";
import type { FlowAction, FlowState, FlowStep } from "@orc/core/flow-engine";
import { advanceFlow, checkFlowTimeout, describeHalt, startFlow } from "@orc/core/flow-engine";
import { resolveFlowForTask } from "@orc/core/flow-service";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import type { SkillFull } from "@orc/core/skill-service";
import { readSkill } from "@orc/core/skill-service";
import type { TaskStatus } from "@orc/core/types";
import { getDb, getSqlite } from "@orc/db/client";
import { flow_runs, gateway_sessions } from "@orc/db/schema";
import { addTaskComment, updateTaskStatus } from "@orc/task-service";

const logger = createLogger("runner:flow");

// ---------------------------------------------------------------------------
// Live session registry
//
// Without in-memory handles, cleanup could only flip DB rows: the hung agent
// child process and the suspended `for await (session.events())` frame would
// leak forever. The registry lets cleanup actually kill the session, which ends
// the event loop and frees the worker slot.
// ---------------------------------------------------------------------------

const liveSessions = new Map<string, AgentSession>();

// Node runs cancelled while their session was still being opened. `liveSessions`
// only gets a handle once `openAgentSession` resolves, so a cancel arriving in
// that window has nothing to close; the spawn path consults this set the moment
// it does have a handle and closes immediately. Without it the agent runs to
// completion on cancelled work, unreapable (its session row says `stopped`, and
// the stale sweep only looks at `running`).
const cancelledNodeRuns = new Set<string>();

const SESSION_TOUCH_THROTTLE_MS = 5_000;
const lastSessionTouch = new Map<string, number>();

function touchSessionActivity(sessionId: string): void {
  const now = Date.now();
  const last = lastSessionTouch.get(sessionId) ?? 0;
  if (now - last < SESSION_TOUCH_THROTTLE_MS) return;
  lastSessionTouch.set(sessionId, now);
  getSqlite()
    .query(
      "UPDATE gateway_sessions SET last_activity_at = unixepoch(), updated_at = unixepoch() WHERE id = ?",
    )
    .run(sessionId);
}

export function closeLiveSession(sessionId: string): void {
  const live = liveSessions.get(sessionId);
  if (!live) return;
  liveSessions.delete(sessionId);
  void live.close().catch(() => {});
}

function markNodeRunCancelled(nodeRunId: string): void {
  cancelledNodeRuns.add(nodeRunId);
  // Bounded: this only holds ids long enough for an in-flight open to notice.
  if (cancelledNodeRuns.size > 512) {
    const oldest = cancelledNodeRuns.values().next().value;
    if (oldest !== undefined) cancelledNodeRuns.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

type TaskRow = {
  id: string;
  title: string;
  body: string | null;
  status: string;
  project_id: string | null;
  skill_name: string | null;
  agent_backend: string | null;
  agent_model: string | null;
  max_review_rounds: number;
  required_review: number;
  flow_name: string | null;
  flow_override: string | null;
};

type FlowRunRow = {
  id: string;
  task_id: string;
  project_id: string | null;
  flow_name: string;
  definition: string;
  status: string;
  active: string | null;
  visits: string | null;
  joins: string | null;
  vars: string | null;
  node_executions: number;
  paused_secs: number;
  started_at: number;
};

type NodeRunRow = {
  id: string;
  flow_run_id: string;
  task_id: string;
  node_id: string;
  attempt: number;
  status: string;
  outcome: string | null;
  summary: string | null;
  skill_name: string | null;
  gateway_session_id: string | null;
  resume_session: number;
};

function getTask(taskId: string): TaskRow | null {
  return (
    (getSqlite()
      .query(
        `SELECT id, title, body, status, project_id, skill_name, agent_backend, agent_model,
                max_review_rounds, required_review, flow_name, flow_override
         FROM tasks WHERE id = ?`,
      )
      .get(taskId) as TaskRow | null) ?? null
  );
}

function getFlowRunRow(flowRunId: string): FlowRunRow | null {
  return (
    (getSqlite()
      .query("SELECT * FROM flow_runs WHERE id = ?")
      .get(flowRunId) as FlowRunRow | null) ?? null
  );
}

export function getActiveFlowRunForTask(taskId: string): FlowRunRow | null {
  return (
    (getSqlite()
      .query(
        "SELECT * FROM flow_runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      )
      .get(taskId) as FlowRunRow | null) ?? null
  );
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

type LoadedRun = { row: FlowRunRow; def: FlowDefinition; state: FlowState };

function loadRun(flowRunId: string): LoadedRun | null {
  const row = getFlowRunRow(flowRunId);
  if (!row) return null;
  const def = parseJson<FlowDefinition | null>(row.definition, null);
  if (!def) {
    logger.error(`Flow run ${flowRunId} has an unreadable definition snapshot`);
    return null;
  }
  const state: FlowState = {
    status:
      row.status === "running" ? "running" : row.status === "completed" ? "completed" : "halted",
    active: parseJson(row.active, [] as { nodeId: string; attempt: number }[]),
    visits: parseJson(row.visits, {} as Record<string, number>),
    joins: parseJson(row.joins, {} as FlowState["joins"]),
    vars: parseJson(row.vars, {} as Record<string, unknown>),
    executions: row.node_executions,
    started_at: row.started_at,
    paused_secs: row.paused_secs ?? 0,
  };
  return { row, def, state };
}

function saveState(flowRunId: string, state: FlowState): void {
  const status =
    state.status === "running" ? "running" : state.status === "completed" ? "completed" : "halted";
  getSqlite()
    .query(
      `UPDATE flow_runs SET status = ?, active = ?, visits = ?, joins = ?, vars = ?,
              node_executions = ?, paused_secs = ?, halt_reason = ?, ended_at = ?,
              updated_at = unixepoch()
       WHERE id = ?`,
    )
    .run(
      status,
      JSON.stringify(state.active),
      JSON.stringify(state.visits),
      JSON.stringify(state.joins),
      JSON.stringify(state.vars),
      state.executions,
      state.paused_secs ?? 0,
      state.halt_reason ?? null,
      state.status === "running" ? null : Math.floor(Date.now() / 1000),
      flowRunId,
    );
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Per-task serialization
//
// Advancing a flow is read-state → compute → write-state, with awaits in the
// middle (comments, task transitions). Fan-out means several node sessions can
// end at the same moment, and without this lock each would read the same state
// and the last write would clobber the others — resurrecting finished nodes and
// losing join arrivals. A task's flow is the unit of serialization; the daemon
// is one process, so an in-process queue is enough.
// ---------------------------------------------------------------------------

const taskLocks = new Map<string, Promise<void>>();

function withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prior = taskLocks.get(taskId) ?? Promise.resolve();
  const result = prior.then(fn);
  // The queued tail never rejects, so one failed operation cannot poison the
  // queue for every later one.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  taskLocks.set(taskId, tail);
  void tail.then(() => {
    if (taskLocks.get(taskId) === tail) taskLocks.delete(taskId);
  });
  return result;
}

function taskIdForRun(flowRunId: string): string | null {
  const row = getSqlite().query("SELECT task_id FROM flow_runs WHERE id = ?").get(flowRunId) as {
    task_id: string;
  } | null;
  return row?.task_id ?? null;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function nodeSkillName(node: FlowNode, task: TaskRow): string | undefined {
  return resolvePlaceholder(node.skill, {
    skill_name: task.skill_name,
    agent_backend: task.agent_backend,
    agent_model: task.agent_model,
  });
}

function nodeBackend(node: FlowNode, task: TaskRow): string {
  const config = loadConfig();
  return (
    resolvePlaceholder(node.backend, {
      skill_name: task.skill_name,
      agent_backend: task.agent_backend,
      agent_model: task.agent_model,
    }) ??
    task.agent_backend ??
    config.agent_loop.default_backend
  );
}

function nodeModel(node: FlowNode, task: TaskRow): string | undefined {
  return (
    resolvePlaceholder(node.model, {
      skill_name: task.skill_name,
      agent_backend: task.agent_backend,
      agent_model: task.agent_model,
    }) ??
    task.agent_model ??
    undefined
  );
}

/** The ledger: what every earlier node in this run was asked and what it said. */
function renderLedger(flowRunId: string, excludeNodeRunId?: string): string | null {
  const rows = getSqlite()
    .query(
      `SELECT node_id, attempt, retry, status, outcome, summary, error FROM flow_node_runs
       WHERE flow_run_id = ? AND id != ? AND status IN ('succeeded','failed','cancelled')
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(flowRunId, excludeNodeRunId ?? "", LEDGER_MAX_ENTRIES) as {
    node_id: string;
    attempt: number;
    retry: number;
    status: string;
    outcome: string | null;
    summary: string | null;
    error: string | null;
  }[];
  if (rows.length === 0) return null;
  rows.reverse();

  const lines = ["## Flow Ledger", "", "What earlier nodes in this run did, in order:", ""];
  for (const r of rows) {
    const verdict = r.outcome ? `→ ${r.outcome}` : `(${r.status})`;
    const label = r.retry > 0 ? `attempt ${r.attempt}, retry ${r.retry}` : `attempt ${r.attempt}`;
    lines.push(`- **${r.node_id}** (${label}) ${verdict}`);
    if (r.summary) {
      for (const line of truncate(r.summary.trim(), LEDGER_MAX_SUMMARY).split("\n")) {
        lines.push(`  ${line}`);
      }
    }
    // A node that crashed is not the same as one that found nothing, and the
    // next worker cannot tell the difference without this.
    if (r.error) lines.push(`  _failed: ${truncate(r.error, 300)}_`);
  }
  return lines.join("\n");
}

function renderVars(vars: Record<string, unknown>): string | null {
  const entries = Object.entries(vars).filter(
    ([key, value]) => value !== null && value !== undefined && !RESERVED_VARS.has(key),
  );
  if (entries.length === 0) return null;
  const lines = ["## Flow State", ""];
  for (const [key, value] of entries) {
    lines.push(`- \`${key}\`: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

// Prompt assembly bounds. A long-running supervisor flow accumulates comments
// and ledger entries indefinitely, and every node re-reads them.
const LEDGER_MAX_ENTRIES = 25;
const LEDGER_MAX_SUMMARY = 2_000;
const COMMENTS_MAX = 40;
const COMMENT_MAX_CHARS = 4_000;

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

const RESERVED_VARS = new Set([
  "task_id",
  "task_title",
  "project_id",
  "skill_name",
  "required_review",
  "max_review_rounds",
]);

/**
 * The cap the graph will enforce on visits to this node, if one is discoverable —
 * either its own `max_visits` or a `visits` guard on an edge that loops back to
 * it. Used to tell a node how much rope it has left.
 */
function loopBudgetFor(
  def: FlowDefinition,
  nodeId: string,
  vars: Record<string, unknown>,
): number | undefined {
  const node = def.nodes[nodeId];
  if (node?.max_visits !== undefined) return node.max_visits;

  for (const edge of def.edges) {
    if (edge.to !== nodeId || !edge.when) continue;
    const bound = visitsBoundFor(edge.when, nodeId, vars);
    if (bound !== undefined) return bound;
  }
  return undefined;
}

function visitsBoundFor(
  cond: FlowCondition,
  nodeId: string,
  vars: Record<string, unknown>,
): number | undefined {
  if ("visits" in cond) {
    // Only a guard that names this node counts. Without `node`, `visits` means
    // the node the edge leaves *from*, which is a different node's budget.
    if (cond.visits.node !== nodeId) return undefined;
    const resolve = (operand: NumericOperand | undefined): number | undefined => {
      if (operand === undefined) return undefined;
      const value = typeof operand === "number" ? operand : vars[operand.var];
      return typeof value === "number" ? value : undefined;
    };
    // `visits < N` permits N visits; `visits <= N` permits N + 1.
    const lt = resolve(cond.visits.lt);
    if (lt !== undefined) return lt;
    const lte = resolve(cond.visits.lte);
    return lte !== undefined ? lte + 1 : undefined;
  }
  if ("all" in cond) {
    for (const c of cond.all) {
      const found = visitsBoundFor(c, nodeId, vars);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function outcomeContract(
  def: FlowDefinition,
  nodeId: string,
  ctx: { taskId: string; attempt: number; maxAttempts?: number | undefined },
): string {
  const outcomes = declaredOutcomes(def, nodeId);
  const attemptNote =
    ctx.maxAttempts !== undefined
      ? ` This is attempt ${ctx.attempt} of at most ${ctx.maxAttempts}.`
      : ctx.attempt > 1
        ? ` This is attempt ${ctx.attempt}.`
        : "";
  const lines = [
    "## Reporting Your Outcome",
    "",
    `You are node **${nodeId}** in flow **${def.name}**.${attemptNote} When your work is finished you MUST`,
    "call the `flow_report` MCP tool so the flow can route to the next node:",
    "",
    "```",
    `flow_report(task: "${ctx.taskId}", node: "${nodeId}", outcome: "<one of below>", summary: "<what you did / found>")`,
    "```",
    "",
  ];
  if (outcomes.length > 0) {
    lines.push("Valid outcomes for this node:");
    for (const o of outcomes) lines.push(`- \`${o}\``);
  } else {
    lines.push("This node has no declared outcomes — report `done`.");
  }
  lines.push(
    "",
    "Report exactly one outcome, and only once. Pass `vars` if the flow's routing needs values from you",
    "(the instructions above will say so). Do not invent an outcome that is not listed.",
  );
  return lines.join("\n");
}

function taskComments(taskId: string, since?: number): { content: string; author: string }[] {
  const sqlite = getSqlite();
  if (since !== undefined) {
    return sqlite
      .query(
        `SELECT content, author FROM comments
         WHERE resource_type = 'task' AND resource_id = ? AND created_at > ?
         ORDER BY created_at ASC`,
      )
      .all(taskId, since) as { content: string; author: string }[];
  }
  // Newest N, then restored to chronological order: an old comment matters less
  // than a recent one, and the whole history does not fit a context window.
  const rows = sqlite
    .query(
      `SELECT content, author FROM comments WHERE resource_type = 'task' AND resource_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(taskId, COMMENTS_MAX) as { content: string; author: string }[];
  return rows.reverse();
}

function buildNodePrompt(opts: {
  def: FlowDefinition;
  node: FlowNode;
  nodeId: string;
  attempt: number;
  task: TaskRow;
  flowRunId: string;
  nodeRunId: string;
  vars: Record<string, unknown>;
  resumeSince?: number | undefined;
}): string {
  const { def, node, nodeId, task, vars } = opts;
  const parts: string[] = [];

  // Tell the node where it is in its own budget: a reviewer on the last allowed
  // round should know that rejecting escalates rather than loops.
  const loopBudget = loopBudgetFor(def, nodeId, vars);
  const contractCtx = {
    taskId: task.id,
    attempt: opts.attempt,
    ...(loopBudget !== undefined ? { maxAttempts: loopBudget } : {}),
  };

  // Resuming the same session: it already has the task and its own history, so
  // send only what changed plus the contract. Re-sending everything would bury
  // the new instruction in noise it has already read.
  if (opts.resumeSince !== undefined) {
    parts.push(
      `You are resuming as node **${nodeId}** of flow **${def.name}** on task "${task.title}" (ID: ${task.id}), attempt ${opts.attempt}.`,
    );
    const ledger = renderLedger(opts.flowRunId, opts.nodeRunId);
    if (ledger) parts.push(ledger);
    const varsBlock = renderVars(vars);
    if (varsBlock) parts.push(varsBlock);
    const fresh = taskComments(task.id, opts.resumeSince);
    if (fresh.length > 0) {
      parts.push("## New Comments Since Your Last Session");
      for (const c of fresh) parts.push(`[${c.author}]: ${c.content}`);
    }
    if (node.prompt) parts.push(`## Node Instructions\n${node.prompt}`);
    parts.push(outcomeContract(def, nodeId, contractCtx));
    return parts.join("\n\n");
  }

  // Worker nodes get the base worker contract; reviewer nodes deliberately do
  // not — a reviewer told to "submit for review and stop" reviews itself.
  if ((node.role ?? "worker") === "worker") {
    const baseSkill = readSkill("orc-worker-base") as SkillFull | null;
    if (baseSkill) parts.push(baseSkill.content);
  }

  const skillName = nodeSkillName(node, task);
  if (skillName) {
    const skill = readSkill(skillName) as SkillFull | null;
    if (skill) parts.push(`\n---\n## Workflow: ${skill.name}\n${skill.content}`);
    else logger.warn(`Node ${nodeId} references unknown skill "${skillName}"`);
  }

  if (node.prompt) parts.push(`\n---\n## Node Instructions (${nodeId})\n${node.prompt}`);

  parts.push(`\n---\n## Task: ${task.title}\nTask ID: ${task.id}`);
  if (task.body) parts.push(task.body);

  const ledger = renderLedger(opts.flowRunId, opts.nodeRunId);
  if (ledger) parts.push(`\n---\n${ledger}`);

  const varsBlock = renderVars(vars);
  if (varsBlock) parts.push(`\n---\n${varsBlock}`);

  const comments = taskComments(task.id);
  if (comments.length > 0) {
    parts.push("\n## Comments");
    for (const c of comments)
      parts.push(`[${c.author}]: ${truncate(c.content, COMMENT_MAX_CHARS)}`);
  }

  parts.push(`\n---\n${outcomeContract(def, nodeId, contractCtx)}`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Applying engine actions
// ---------------------------------------------------------------------------

async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
  comment?: string,
  claimedBy?: string,
  opts?: { notifyHuman?: boolean },
): Promise<void> {
  const current = getSqlite().query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
    status: string;
  } | null;
  // Re-entering a node whose task_status is already current (build → build) is
  // normal; the transition matrix rejects same-to-same, so don't ask.
  if (current?.status === status) {
    if (comment) await addTaskComment(taskId, comment, "system");
    return;
  }

  const result = await updateTaskStatus({
    taskId,
    status,
    ...(comment !== undefined ? { comment } : {}),
    ...(claimedBy !== undefined ? { claimedBy } : {}),
    author: "system",
    // Mark it as ours so the transition hook does not treat the flow's own
    // moves as outside interference and cancel the run.
    source: "flow",
    // Only a human gate should page a human. Every agent reviewer node also
    // moves the task to `review`, and notifying on those meant one task sent
    // "ready for review" once per review round — each telling the human to
    // approve by hand, which the flow would then have to override.
    notifyHuman: opts?.notifyHuman ?? false,
  });
  if (!result.ok) {
    logger.warn(`Task ${taskId} → ${status} rejected: ${result.error}`);
  }
}

/**
 * Gates and terminals never become active nodes, so they would otherwise leave
 * no trace. Diff the visit counters to record them in the ledger.
 */
function recordPassiveVisits(
  flowRunId: string,
  taskId: string,
  def: FlowDefinition,
  before: Record<string, number>,
  after: Record<string, number>,
): void {
  const sqlite = getSqlite();
  for (const [nodeId, count] of Object.entries(after)) {
    const node = def.nodes[nodeId];
    if (!node || node.kind === "agent" || node.kind === "human") continue;
    const previous = before[nodeId] ?? 0;
    for (let attempt = previous + 1; attempt <= count; attempt++) {
      try {
        sqlite
          .query(
            `INSERT INTO flow_node_runs
               (id, flow_run_id, task_id, node_id, node_kind, attempt, status, outcome, started_at, ended_at)
             VALUES (?, ?, ?, ?, ?, ?, 'succeeded', 'entered', unixepoch(), unixepoch())`,
          )
          .run(ulid(), flowRunId, taskId, nodeId, node.kind, attempt);
      } catch {
        // Unique index on (run, node, attempt) — already recorded.
      }
    }
  }
}

async function applyStep(
  flowRunId: string,
  def: FlowDefinition,
  task: TaskRow,
  before: FlowState,
  step: FlowStep,
): Promise<void> {
  const sqlite = getSqlite();
  recordPassiveVisits(flowRunId, task.id, def, before.visits, step.state.visits);

  for (const action of step.actions) {
    await applyAction(flowRunId, def, task, step.state, action);
  }

  saveState(flowRunId, step.state);

  if (step.state.status === "running" && step.state.active.length === 0) {
    // Should not happen — the engine halts on a stall — but never leave a run
    // claiming to be running with nothing to run.
    logger.warn(`Flow run ${flowRunId} is running with no active nodes`);
  }

  if (step.state.status !== "running") {
    sqlite
      .query(
        "UPDATE tasks SET claimed_by = NULL, updated_at = unixepoch() WHERE id = ? AND claimed_by = ?",
      )
      .run(task.id, flowRunId);
  }
}

async function applyAction(
  flowRunId: string,
  def: FlowDefinition,
  task: TaskRow,
  state: FlowState,
  action: FlowAction,
): Promise<void> {
  const sqlite = getSqlite();

  switch (action.kind) {
    case "spawn": {
      const node = def.nodes[action.nodeId];
      if (!node) return;
      const isHuman = node.kind === "human";
      const nodeRunId = ulid();
      try {
        sqlite
          .query(
            `INSERT INTO flow_node_runs
               (id, flow_run_id, task_id, node_id, node_kind, attempt, status, skill_name, resume_session, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
          )
          .run(
            nodeRunId,
            flowRunId,
            task.id,
            action.nodeId,
            node.kind,
            action.attempt,
            isHuman ? "awaiting_human" : "pending",
            nodeSkillName(node, task) ?? null,
            action.resume ? 1 : 0,
          );
      } catch (err) {
        // Unique on (run, node, attempt): an existing row means this step is
        // being replayed, which is fine. Anything else would leave the engine
        // with an active node that has no row to drive it, so fail loudly.
        // Only a *runnable* existing row means this step is a harmless replay.
        // A finished row with the same key means something else took that
        // coordinate, and swallowing it would leave the engine with an active
        // node that nothing will ever drive.
        const already = sqlite
          .query(
            `SELECT status FROM flow_node_runs
             WHERE flow_run_id = ? AND node_id = ? AND attempt = ?
             ORDER BY retry DESC LIMIT 1`,
          )
          .get(flowRunId, action.nodeId, action.attempt) as { status: string } | null;
        const replayable =
          already !== null && ["pending", "running", "awaiting_human"].includes(already.status);
        if (!replayable) {
          logger.error(
            `Could not queue node ${action.nodeId}#${action.attempt} (existing row: ${already?.status ?? "none"}): ${String(err)}`,
          );
          throw err;
        }
        logger.debug(`Node run ${action.nodeId}#${action.attempt} already queued`);
        return;
      }

      // A queued agent node is not being worked on yet: the task is `queued`
      // until its session really starts (see spawnNodeSession). Applying the
      // node's status here would show N tasks `doing` while max_workers allows
      // one. Human nodes have no session, so they take their status now.
      if (isHuman) {
        if (node.task_status) {
          await setTaskStatus(task.id, node.task_status, undefined, flowRunId, {
            notifyHuman: true,
          });
        }
      } else {
        await setTaskStatus(task.id, "queued", undefined, flowRunId);
      }
      if (isHuman) {
        await addTaskComment(
          task.id,
          `Flow **${def.name}** is waiting for a human at node **${action.nodeId}**.` +
            (node.prompt ? `\n\n${node.prompt}` : "") +
            `\n\nResolve with: \`orc flow resume ${task.id} --outcome <${declaredOutcomes(def, action.nodeId).join("|") || "done"}>\``,
          "system",
        );
      }
      return;
    }

    case "cancel": {
      // Every *live* row for this visit, not just one: a visit can have several
      // rows once it has been retried, and picking one arbitrarily left the live
      // retry running with its session open — an auto-approved agent still
      // working on a run the graph had already halted, still counting against
      // max_workers until the idle sweep noticed.
      const rows = sqlite
        .query(
          `SELECT id, gateway_session_id FROM flow_node_runs
           WHERE flow_run_id = ? AND node_id = ? AND attempt = ?
             AND status IN ('pending','running','awaiting_human')`,
        )
        .all(flowRunId, action.nodeId, action.attempt) as {
        id: string;
        gateway_session_id: string | null;
      }[];

      for (const row of rows) {
        markNodeRunCancelled(row.id);
        if (row.gateway_session_id) {
          closeLiveSession(row.gateway_session_id);
          sqlite
            .query(
              "UPDATE gateway_sessions SET status = 'stopped', last_error = ?, updated_at = unixepoch() WHERE id = ?",
            )
            .run(`cancelled: ${action.reason}`, row.gateway_session_id);
        }
        sqlite
          .query(
            "UPDATE flow_node_runs SET status = 'cancelled', error = ?, ended_at = unixepoch() WHERE id = ?",
          )
          .run(action.reason, row.id);
      }
      return;
    }

    case "complete": {
      // A terminal ends the graph before it takes a visit counter, so it has to
      // be written to the ledger from here or it would leave no trace of where
      // the run actually finished.
      const terminal = def.nodes[action.nodeId];
      if (terminal) {
        const previous = sqlite
          .query(
            "SELECT COALESCE(MAX(attempt), 0) AS last FROM flow_node_runs WHERE flow_run_id = ? AND node_id = ?",
          )
          .get(flowRunId, action.nodeId) as { last: number } | null;
        try {
          sqlite
            .query(
              `INSERT INTO flow_node_runs
                 (id, flow_run_id, task_id, node_id, node_kind, attempt, status, outcome, started_at, ended_at)
               VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, unixepoch(), unixepoch())`,
            )
            .run(
              ulid(),
              flowRunId,
              task.id,
              action.nodeId,
              terminal.kind,
              (previous?.last ?? 0) + 1,
              action.task_status,
            );
        } catch {
          // Already recorded.
        }
      }

      await addTaskComment(
        task.id,
        `Flow **${def.name}** finished at **${action.nodeId}** → task \`${action.task_status}\`.` +
          ` ${state.executions} node execution(s).`,
        "system",
      );
      await setTaskStatus(task.id, action.task_status);
      return;
    }

    case "halt": {
      await addTaskComment(
        task.id,
        `Flow **${def.name}** halted: ${describeHalt(action.reason)}.` +
          ` ${state.executions} node execution(s) ran. Needs a human — resume by moving the task back to \`todo\`` +
          " (a fresh flow run starts) or attach a different flow.",
        "system",
      );
      await setTaskStatus(task.id, action.task_status);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Starting a flow
// ---------------------------------------------------------------------------

export type StartFlowResult =
  | { ok: true; flowRunId: string; flowName: string }
  | { ok: false; error: string };

export function startFlowForTask(
  taskId: string,
  opts?: { flowName?: string | undefined; vars?: Record<string, unknown> | undefined },
): Promise<StartFlowResult> {
  return withTaskLock(taskId, () => startFlowForTaskUnlocked(taskId, opts));
}

async function startFlowForTaskUnlocked(
  taskId: string,
  opts?: { flowName?: string | undefined; vars?: Record<string, unknown> | undefined },
): Promise<StartFlowResult> {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: `Task not found: ${taskId}` };

  const existing = getActiveFlowRunForTask(taskId);
  if (existing) {
    return { ok: false, error: `Task already has a running flow (${existing.flow_name})` };
  }

  const config = loadConfig();

  // A per-run rail cannot see a loop made of whole runs: a terminal that sets
  // `changes_requested` makes the task eligible again, and the next cycle starts
  // a fresh run with its budgets reset. Bound the number of runs per task too.
  // Only runs that ran to an end of their own count: a run cancelled by a human
  // (or by attach/halt) is not evidence of a loop, and counting it would park a
  // task nobody looped. Runs before the task's last human touch are forgiven, so
  // moving a parked task back to `todo` genuinely restarts the budget.
  const priorRuns = getSqlite()
    .query(
      `SELECT COUNT(*) AS count FROM flow_runs
       WHERE task_id = ? AND status IN ('completed', 'halted')
         AND ended_at > COALESCE(
           (SELECT MAX(created_at) FROM comments
            WHERE resource_type = 'task' AND resource_id = ? AND author = 'human'), 0)`,
    )
    .get(taskId, taskId) as { count: number } | null;
  if ((priorRuns?.count ?? 0) >= config.agent_loop.max_flow_runs_per_task) {
    // Only say so once: this is re-checked every cycle while the task sits there.
    const alreadySaid = getSqlite()
      .query(
        `SELECT 1 AS present FROM comments
         WHERE resource_type = 'task' AND resource_id = ? AND content LIKE '%not converging%'
           AND created_at > COALESCE(
             (SELECT MAX(created_at) FROM comments
              WHERE resource_type = 'task' AND resource_id = ? AND author = 'human'), 0)
         LIMIT 1`,
      )
      .get(taskId, taskId) as { present: number } | null;
    if (!alreadySaid) {
      await addTaskComment(
        taskId,
        `This task has already completed ${priorRuns?.count} flow runs ` +
          `(limit ${config.agent_loop.max_flow_runs_per_task}). Pausing for a human rather than starting another — ` +
          "the flow is not converging. Commenting on the task as a human resets this budget.",
        "system",
      );
    }
    await setTaskStatus(taskId, "paused");
    return { ok: false, error: "Task has exhausted its flow-run budget" };
  }
  let inlineOverride: unknown;
  if (!opts?.flowName && task.flow_override !== null) {
    try {
      inlineOverride = JSON.parse(task.flow_override);
    } catch (err) {
      // Silently running orc-default instead would hide the corruption.
      const message = `flow_override is not readable JSON: ${err instanceof Error ? err.message : String(err)}`;
      await addTaskComment(taskId, `Cannot start flow: ${message}`, "system");
      await setTaskStatus(taskId, "blocked");
      return { ok: false, error: message };
    }
  }

  const resolved = resolveFlowForTask({
    flowOverride: inlineOverride,
    flowName: opts?.flowName ?? task.flow_name,
    defaultFlowName: config.agent_loop.default_flow,
  });
  if ("error" in resolved) {
    await addTaskComment(taskId, `Cannot start flow: ${resolved.error}`, "system");
    await setTaskStatus(taskId, "blocked", undefined);
    return { ok: false, error: resolved.error };
  }

  const { definition, source, name } = resolved;
  const flowRunId = ulid();
  const startedAt = nowSecs();

  const vars: Record<string, unknown> = {
    task_id: task.id,
    task_title: task.title,
    project_id: task.project_id,
    skill_name: task.skill_name,
    required_review: task.required_review === 1,
    max_review_rounds: task.max_review_rounds,
    ...(opts?.vars ?? {}),
  };

  const step = startFlow(definition, { now: startedAt, vars });

  await getDb()
    .insert(flow_runs)
    .values({
      id: flowRunId,
      task_id: task.id,
      project_id: task.project_id,
      flow_name: name,
      flow_source: source,
      definition,
      status: "running",
      active: [],
      visits: {},
      joins: {},
      vars,
      node_executions: 0,
      started_at: new Date(startedAt * 1000),
      created_at: new Date(),
      updated_at: new Date(),
    });

  const claimed = getSqlite()
    .query(
      "UPDATE tasks SET claimed_by = ?, updated_at = unixepoch() WHERE id = ? AND claimed_by IS NULL",
    )
    .run(flowRunId, task.id);
  if (claimed.changes === 0) {
    getSqlite().query("DELETE FROM flow_runs WHERE id = ?").run(flowRunId);
    return { ok: false, error: "Task was claimed concurrently" };
  }

  const emptyBefore: FlowState = {
    status: "running",
    active: [],
    visits: {},
    executions: 0,
    vars,
    joins: {},
    started_at: startedAt,
  };
  await applyStep(flowRunId, definition, task, emptyBefore, step);

  logger.info(`Flow ${name} started for task ${task.id} (run ${flowRunId})`);
  return { ok: true, flowRunId, flowName: name };
}

// ---------------------------------------------------------------------------
// Advancing a flow
// ---------------------------------------------------------------------------

type AdvanceInput = {
  nodeId: string;
  attempt: number;
  outcome?: string | undefined;
  vars?: Record<string, unknown> | undefined;
  error?: string | undefined;
};

/** Caller must already hold the task lock. */
async function advanceUnlocked(flowRunId: string, result: AdvanceInput): Promise<void> {
  const loaded = loadRun(flowRunId);
  if (!loaded) return;
  if (loaded.state.status !== "running") return;
  const task = getTask(loaded.row.task_id);
  if (!task) return;

  const step = advanceFlow(loaded.def, loaded.state, result, { now: nowSecs() });
  if (step.actions.length === 0 && step.state === loaded.state) return;
  await applyStep(flowRunId, loaded.def, task, loaded.state, step);
}

export type ReportOutcomeResult = { ok: true; nextNodes: string[] } | { ok: false; error: string };

/**
 * A node agent reporting its verdict. This is the one place a node's opinion
 * enters the graph; everything downstream of it is deterministic.
 */
export function reportNodeOutcome(opts: {
  taskId: string;
  nodeId?: string | undefined;
  outcome: string;
  summary?: string | undefined;
  vars?: Record<string, unknown> | undefined;
}): Promise<ReportOutcomeResult> {
  return withTaskLock(opts.taskId, () => reportNodeOutcomeUnlocked(opts));
}

async function reportNodeOutcomeUnlocked(opts: {
  taskId: string;
  nodeId?: string | undefined;
  outcome: string;
  summary?: string | undefined;
  vars?: Record<string, unknown> | undefined;
}): Promise<ReportOutcomeResult> {
  const run = getActiveFlowRunForTask(opts.taskId);
  if (!run) return { ok: false, error: `Task ${opts.taskId} has no running flow` };

  const sqlite = getSqlite();
  const candidates = sqlite
    .query(
      `SELECT * FROM flow_node_runs WHERE flow_run_id = ? AND status IN ('running','pending','awaiting_human')
       ORDER BY created_at ASC`,
    )
    .all(run.id) as NodeRunRow[];

  const node = opts.nodeId
    ? candidates.find((c) => c.node_id === opts.nodeId)
    : candidates.length === 1
      ? candidates[0]
      : undefined;

  if (!node) {
    if (opts.nodeId) {
      return { ok: false, error: `No active node "${opts.nodeId}" in flow run ${run.id}` };
    }
    return {
      ok: false,
      error: `${candidates.length} nodes are active — pass the node id you are: ${candidates.map((c) => c.node_id).join(", ")}`,
    };
  }

  const def = parseJson<FlowDefinition | null>(run.definition, null);
  const valid = def ? declaredOutcomes(def, node.node_id) : [];
  if (valid.length > 0 && !valid.includes(opts.outcome)) {
    return {
      ok: false,
      error: `Outcome "${opts.outcome}" is not routable from node "${node.node_id}". Valid: ${valid.join(", ")}`,
    };
  }

  sqlite
    .query("UPDATE flow_node_runs SET outcome = ?, summary = COALESCE(?, summary) WHERE id = ?")
    .run(opts.outcome, opts.summary ?? null, node.id);

  // A human node has no session to finish, so its report advances the graph
  // immediately. An agent node's report is recorded here and consumed when its
  // session ends, so the agent can keep working after reporting.
  if (node.status === "awaiting_human") {
    // The time this gate waited is the human's, not the agents' — excluding it
    // is what stops execution_timeout_secs being a fuse on every human gate.
    const waited = sqlite
      .query(
        "SELECT MAX(0, unixepoch() - COALESCE(started_at, created_at)) AS secs FROM flow_node_runs WHERE id = ?",
      )
      .get(node.id) as { secs: number } | null;
    if (waited?.secs) {
      sqlite
        .query("UPDATE flow_runs SET paused_secs = paused_secs + ? WHERE id = ?")
        .run(waited.secs, run.id);
    }
    sqlite
      .query("UPDATE flow_node_runs SET status = 'succeeded', ended_at = unixepoch() WHERE id = ?")
      .run(node.id);
    await advanceUnlocked(run.id, {
      nodeId: node.node_id,
      attempt: node.attempt,
      outcome: opts.outcome,
      ...(opts.vars ? { vars: opts.vars } : {}),
    });
  } else if (opts.vars) {
    // Vars have to land now: routing may need them even if the session lingers.
    const loaded = loadRun(run.id);
    if (loaded) {
      const merged = { ...loaded.state.vars, ...opts.vars };
      sqlite
        .query("UPDATE flow_runs SET vars = ?, updated_at = unixepoch() WHERE id = ?")
        .run(JSON.stringify(merged), run.id);
    }
  }

  const after = loadRun(run.id);
  return { ok: true, nextNodes: after?.state.active.map((a) => a.nodeId) ?? [] };
}

/**
 * Best-effort outcome for a node whose session ended without calling
 * flow_report. Existing skills drive the task status rather than the flow, so
 * map the status the agent left behind onto a routable outcome. Ambiguity is
 * not guessed at: the flow halts and a human picks it up.
 */
const STATUS_OUTCOME_HINTS: Record<string, string[]> = {
  blocked: ["blocked"],
  review: ["submitted", "reviewed", "milestone", "ready"],
  done: ["approved", "pass", "verified", "complete", "submitted"],
  changes_requested: ["changes_requested", "fail", "reject"],
  cancelled: ["blocked"],
};

function inferOutcome(def: FlowDefinition, nodeId: string, taskStatus: string): string | undefined {
  const routable = declaredOutcomes(def, nodeId);
  if (routable.length === 0) return undefined;
  for (const candidate of STATUS_OUTCOME_HINTS[taskStatus] ?? []) {
    if (routable.includes(candidate)) return candidate;
  }
  if (routable.length === 1) return routable[0];
  return undefined;
}

// ---------------------------------------------------------------------------
// Spawning node sessions
// ---------------------------------------------------------------------------

function projectScope(projectId: string | null): string | undefined {
  if (!projectId) return undefined;
  const row = getSqlite().query("SELECT scope FROM projects WHERE id = ?").get(projectId) as {
    scope: string | null;
  } | null;
  return row?.scope ?? undefined;
}

function previousNodeSession(
  flowRunId: string,
  nodeId: string,
): { runtime_session_id: string; cwd: string; ended_at: number } | null {
  return (
    (getSqlite()
      .query(
        `SELECT gs.runtime_session_id, gs.cwd, gs.updated_at AS ended_at
         FROM flow_node_runs fnr JOIN gateway_sessions gs ON gs.id = fnr.gateway_session_id
         WHERE fnr.flow_run_id = ? AND fnr.node_id = ? AND gs.runtime_session_id IS NOT NULL
         ORDER BY fnr.created_at DESC LIMIT 1`,
      )
      .get(flowRunId, nodeId) as {
      runtime_session_id: string;
      cwd: string;
      ended_at: number;
    } | null) ?? null
  );
}

async function spawnNodeSession(nodeRun: NodeRunRow): Promise<void> {
  const loaded = loadRun(nodeRun.flow_run_id);
  if (!loaded) return;
  const task = getTask(nodeRun.task_id);
  if (!task) return;
  const node = loaded.def.nodes[nodeRun.node_id];
  if (!node || node.kind !== "agent") return;

  const sqlite = getSqlite();
  const sessionId = ulid();
  const backendName = nodeBackend(node, task);
  const model = nodeModel(node, task);

  const prev =
    nodeRun.resume_session === 1 ? previousNodeSession(nodeRun.flow_run_id, nodeRun.node_id) : null;
  const cwd = projectScope(task.project_id) ?? prev?.cwd ?? process.cwd();

  const prompt = buildNodePrompt({
    def: loaded.def,
    node,
    nodeId: nodeRun.node_id,
    attempt: nodeRun.attempt,
    task,
    flowRunId: nodeRun.flow_run_id,
    nodeRunId: nodeRun.id,
    vars: loaded.state.vars,
    ...(prev ? { resumeSince: prev.ended_at } : {}),
  });

  const now = new Date();
  await getDb()
    .insert(gateway_sessions)
    .values({
      id: sessionId,
      chat_id: "__task-loop__",
      backend: backendName,
      mode: `agent:${backendName}`,
      cwd,
      title: `${loaded.def.name}/${nodeRun.node_id}: ${task.title}`,
      status: "running",
      auto_approve: true,
      task_id: task.id,
      role: node.role ?? "worker",
      pid: process.pid,
      project_id: task.project_id,
      ...(model ? { model } : {}),
      review_rounds: 0,
      created_at: now,
      updated_at: now,
    });

  // Conditional claim: if another drain already took this node, drop the session
  // row we just made and leave it alone.
  const claimed = sqlite
    .query(
      "UPDATE flow_node_runs SET status = 'running', gateway_session_id = ?, started_at = unixepoch() WHERE id = ? AND status = 'pending'",
    )
    .run(sessionId, nodeRun.id);
  if (claimed.changes === 0) {
    logger.debug(`Node run ${nodeRun.id} was already claimed; skipping`);
    sqlite.query("DELETE FROM gateway_sessions WHERE id = ?").run(sessionId);
    return;
  }

  // Now that an agent is really running, the node's declared status is honest.
  // A node that declares none still must not leave the task looking `queued`
  // while its session works, so fall back to the role's natural status.
  const runningStatus: TaskStatus =
    node.task_status ?? (node.role === "reviewer" ? "review" : "doing");
  await setTaskStatus(task.id, runningStatus, undefined, nodeRun.flow_run_id);

  driveNodeSession({
    sessionId,
    nodeRunId: nodeRun.id,
    flowRunId: nodeRun.flow_run_id,
    taskId: task.id,
    nodeId: nodeRun.node_id,
    attempt: nodeRun.attempt,
    backendName,
    prompt,
    cwd,
    ...(model ? { model } : {}),
    ...(prev ? { previousRuntimeSessionId: prev.runtime_session_id } : {}),
  }).catch((err) => {
    logger.error(`Node session ${sessionId} failed: ${String(err)}`);
  });
}

async function driveNodeSession(opts: {
  sessionId: string;
  nodeRunId: string;
  flowRunId: string;
  taskId: string;
  nodeId: string;
  attempt: number;
  backendName: string;
  prompt: string;
  cwd: string;
  model?: string | undefined;
  previousRuntimeSessionId?: string | undefined;
}): Promise<void> {
  const sqlite = getSqlite();
  let session: AgentSession | null = null;
  let sessionError: string | null = null;

  try {
    session = await openAgentSession(
      opts.backendName,
      { cwd: opts.cwd, autoApprove: true, ...(opts.model ? { model: opts.model } : {}) },
      opts.previousRuntimeSessionId,
    );

    // The graph may have cancelled this node while the backend was starting.
    // Closing here is the only chance to stop it: nothing else holds a handle,
    // and a cancelled node's session row is not `running` so the stale sweep
    // will never look at it again.
    const stillWanted = sqlite
      .query("SELECT status FROM flow_node_runs WHERE id = ?")
      .get(opts.nodeRunId) as { status: string } | null;
    if (cancelledNodeRuns.has(opts.nodeRunId) || stillWanted?.status !== "running") {
      cancelledNodeRuns.delete(opts.nodeRunId);
      logger.info(`Node ${opts.nodeId} was cancelled while its session opened; closing it`);
      await session.close().catch(() => {});
      sqlite
        .query(
          "UPDATE gateway_sessions SET status = 'stopped', last_error = 'cancelled during startup', updated_at = unixepoch() WHERE id = ?",
        )
        .run(opts.sessionId);
      return;
    }

    liveSessions.set(opts.sessionId, session);
    await session.send(opts.prompt);

    const autoApprove = loadConfig().agent_loop.worker_auto_approve;

    for await (const event of session.events()) {
      touchSessionActivity(opts.sessionId);

      if (event.type === "permission_request") {
        if (autoApprove) {
          session.respondPermission(event.data.requestId, "approved");
        } else {
          logger.info(
            `Permission request for ${opts.nodeId} (${opts.sessionId}): ${event.data.tool} - denied, no human in the loop`,
          );
          session.respondPermission(event.data.requestId, "denied");
        }
      }

      if (event.type === "result" && event.data.runtimeSessionId) {
        sqlite
          .query("UPDATE gateway_sessions SET runtime_session_id = ? WHERE id = ?")
          .run(event.data.runtimeSessionId, opts.sessionId);
      }

      if (event.type === "error") {
        sessionError = event.data;
        logger.error(`Node ${opts.nodeId} (${opts.sessionId}) error: ${event.data}`);
        break;
      }
    }
  } catch (err) {
    sessionError = String(err);
    logger.error(`Node ${opts.nodeId} (${opts.sessionId}) crashed: ${sessionError}`);
  } finally {
    lastSessionTouch.delete(opts.sessionId);
    liveSessions.delete(opts.sessionId);
    if (session?.alive()) await session.close().catch(() => {});
  }

  sqlite
    .query(
      "UPDATE gateway_sessions SET status = ?, last_error = ?, updated_at = unixepoch() WHERE id = ?",
    )
    .run(sessionError ? "error" : "stopped", sessionError, opts.sessionId);

  await finishNodeRun(opts.nodeRunId, sessionError);
}

/**
 * Close out a node run and hand its verdict to the engine. Called when a
 * session ends, and by cleanup when one is reaped.
 */
export function finishNodeRun(nodeRunId: string, error: string | null): Promise<void> {
  const owner = getSqlite()
    .query("SELECT task_id FROM flow_node_runs WHERE id = ?")
    .get(nodeRunId) as { task_id: string } | null;
  if (!owner) return Promise.resolve();
  return withTaskLock(owner.task_id, () => finishNodeRunUnlocked(nodeRunId, error));
}

async function finishNodeRunUnlocked(nodeRunId: string, error: string | null): Promise<void> {
  const sqlite = getSqlite();
  const row = sqlite
    .query("SELECT * FROM flow_node_runs WHERE id = ?")
    .get(nodeRunId) as NodeRunRow | null;
  if (!row) return;
  if (!["running", "pending", "awaiting_human"].includes(row.status)) return;

  const loaded = loadRun(row.flow_run_id);
  if (!loaded) return;

  let outcome = row.outcome ?? undefined;
  const failure = error;

  if (!failure && !outcome) {
    const task = getTask(row.task_id);
    outcome = task ? inferOutcome(loaded.def, row.node_id, task.status) : undefined;
    if (outcome) {
      logger.info(
        `Node ${row.node_id} ended without flow_report; inferred "${outcome}" from task status`,
      );
      sqlite.query("UPDATE flow_node_runs SET outcome = ? WHERE id = ?").run(outcome, nodeRunId);
    }
  }

  // An outcome the node actually reported wins over a session that ended badly
  // afterwards. A worker that reports `submitted` and then trips
  // `error_max_turns` has still done the work and said so — routing its
  // `on_error` instead would silently discard the verdict and, on orc-default,
  // block the task. The failure is still recorded on the row for the ledger.
  const errored = failure !== null && !outcome;
  sqlite
    .query(
      "UPDATE flow_node_runs SET status = ?, error = COALESCE(?, error), ended_at = unixepoch() WHERE id = ?",
    )
    .run(errored ? "failed" : "succeeded", failure, nodeRunId);
  if (failure && outcome) {
    logger.warn(
      `Node ${row.node_id} reported "${outcome}" before failing (${failure}); routing on the reported outcome`,
    );
  }

  // With neither an outcome nor an error the engine halts on `no_outcome:<node>`
  // — better a human looks than the graph guesses a verdict.
  await advanceUnlocked(row.flow_run_id, {
    nodeId: row.node_id,
    attempt: row.attempt,
    ...(outcome ? { outcome } : {}),
    ...(errored ? { error: failure } : {}),
  });
}

/**
 * A session died for infrastructure reasons (idle timeout, lifetime cap, backend
 * crash) rather than because the agent decided something. Re-queue the same node
 * as a fresh attempt instead of routing `on_error`.
 *
 * The old loop retried these automatically — a worker timeout reset the task to
 * `todo`, a reviewer timeout just unclaimed it. Routing `on_error` instead would
 * end orc-default at `blocked` on the first network blip and never come back.
 *
 * Bounded by `agent_loop.max_node_retries`: retries do not advance the graph, so
 * they consume no `visits` and no loop budget, which is exactly why they need
 * their own cap. Retries used = rows for this node − graph visits to it.
 */
async function retryNodeRun(nodeRunId: string, reason: string): Promise<boolean> {
  const sqlite = getSqlite();
  const row = sqlite
    .query("SELECT * FROM flow_node_runs WHERE id = ?")
    .get(nodeRunId) as NodeRunRow | null;
  if (!row) return false;

  const loaded = loadRun(row.flow_run_id);
  if (!loaded || loaded.state.status !== "running") return false;
  if (!loaded.state.active.some((a) => a.nodeId === row.node_id && a.attempt === row.attempt)) {
    return false;
  }

  // Retries are counted per graph visit, and numbered in their own coordinate —
  // `attempt` belongs to the engine, which will hand out the next value itself
  // when the graph next enters this node.
  const retries = sqlite
    .query(
      "SELECT COALESCE(MAX(retry), 0) AS last FROM flow_node_runs WHERE flow_run_id = ? AND node_id = ? AND attempt = ?",
    )
    .get(row.flow_run_id, row.node_id, row.attempt) as { last: number };
  const retriesUsed = retries.last;
  const maxRetries = loadConfig().agent_loop.max_node_retries;
  if (retriesUsed >= maxRetries) return false;

  sqlite
    .query(
      "UPDATE flow_node_runs SET status = 'failed', error = COALESCE(?, error), ended_at = unixepoch() WHERE id = ?",
    )
    .run(reason, nodeRunId);

  const nextRetry = retriesUsed + 1;
  sqlite
    .query(
      `INSERT INTO flow_node_runs
         (id, flow_run_id, task_id, node_id, node_kind, attempt, retry, status, skill_name, resume_session, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, unixepoch())`,
    )
    .run(
      ulid(),
      row.flow_run_id,
      row.task_id,
      row.node_id,
      loaded.def.nodes[row.node_id]?.kind ?? "agent",
      row.attempt,
      nextRetry,
      row.skill_name,
    );

  // No engine state changes: same visit, same `attempt`, so the eventual report
  // still matches the active entry and the loop budget is untouched.
  await addTaskComment(
    row.task_id,
    `Node **${row.node_id}** was reclaimed (${reason}); retrying it (${nextRetry}/${maxRetries}).`,
    "system",
  );
  logger.warn(
    `Node ${row.node_id} reclaimed (${reason}); queued retry ${nextRetry}/${maxRetries} of attempt ${row.attempt}`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Draining pending nodes
// ---------------------------------------------------------------------------

function runningWorkerCount(projectId?: string | null): number {
  const sqlite = getSqlite();
  if (projectId) {
    const row = sqlite
      .query(
        "SELECT COUNT(*) as count FROM gateway_sessions WHERE role IN ('worker','reviewer') AND status = 'running' AND project_id = ?",
      )
      .get(projectId) as { count: number } | null;
    return row?.count ?? 0;
  }
  const row = sqlite
    .query(
      "SELECT COUNT(*) as count FROM gateway_sessions WHERE role IN ('worker','reviewer') AND status = 'running'",
    )
    .get() as { count: number } | null;
  return row?.count ?? 0;
}

export function getActiveWorkerCount(projectId?: string | null): number {
  return runningWorkerCount(projectId);
}

function projectMaxWorkers(projectId: string): number | null {
  const row = getSqlite().query("SELECT max_workers FROM projects WHERE id = ?").get(projectId) as {
    max_workers: number | null;
  } | null;
  return row?.max_workers ?? null;
}

function runningNodesInFlow(flowRunId: string): number {
  const row = getSqlite()
    .query(
      "SELECT COUNT(*) as count FROM flow_node_runs WHERE flow_run_id = ? AND status = 'running'",
    )
    .get(flowRunId) as { count: number } | null;
  return row?.count ?? 0;
}

/**
 * Spawn queued agent nodes up to capacity. Fan-out is queued rather than
 * rejected: a node that fans out three ways on a single-worker install runs its
 * branches one after another instead of failing.
 */
export async function drainPendingNodes(): Promise<string[]> {
  const config = loadConfig();
  const maxWorkers = config.agent_loop.max_workers;
  const spawned: string[] = [];

  const pending = getSqlite()
    .query(
      `SELECT fnr.* FROM flow_node_runs fnr
       JOIN flow_runs fr ON fr.id = fnr.flow_run_id
       WHERE fnr.status = 'pending' AND fnr.node_kind = 'agent' AND fr.status = 'running'
       ORDER BY fnr.created_at ASC`,
    )
    .all() as NodeRunRow[];

  for (const nodeRun of pending) {
    if (runningWorkerCount() >= maxWorkers) break;

    const task = getTask(nodeRun.task_id);
    if (!task) continue;

    if (task.project_id) {
      const max = projectMaxWorkers(task.project_id);
      if (max !== null && runningWorkerCount(task.project_id) >= max) continue;
    }

    const loaded = loadRun(nodeRun.flow_run_id);
    if (!loaded) continue;

    try {
      if (runningNodesInFlow(nodeRun.flow_run_id) >= loaded.def.limits.max_parallel) continue;
      await spawnNodeSession(nodeRun);
      spawned.push(`${loaded.def.name}/${nodeRun.node_id} [${nodeRun.task_id}]`);
    } catch (err) {
      // One node that cannot be spawned must not stop every other queued node
      // in this cycle from starting.
      logger.error(
        `Spawning node ${nodeRun.node_id} of flow run ${nodeRun.flow_run_id} failed: ${String(err)}`,
      );
    }
  }

  return spawned;
}

// ---------------------------------------------------------------------------
// Human-in-the-loop and external interference
// ---------------------------------------------------------------------------

export async function resumeHumanNode(opts: {
  taskId: string;
  outcome: string;
  summary?: string | undefined;
  vars?: Record<string, unknown> | undefined;
  author?: string | undefined;
}): Promise<ReportOutcomeResult> {
  const run = getActiveFlowRunForTask(opts.taskId);
  if (!run) return { ok: false, error: `Task ${opts.taskId} has no running flow` };
  const waiting = getSqlite()
    .query(
      "SELECT * FROM flow_node_runs WHERE flow_run_id = ? AND status = 'awaiting_human' ORDER BY created_at ASC LIMIT 1",
    )
    .get(run.id) as NodeRunRow | null;
  if (!waiting) return { ok: false, error: "No node is waiting for a human on this task" };

  if (opts.summary) {
    await addTaskComment(opts.taskId, opts.summary, opts.author ?? "human");
  }
  return reportNodeOutcome({
    taskId: opts.taskId,
    nodeId: waiting.node_id,
    outcome: opts.outcome,
    ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
    ...(opts.vars !== undefined ? { vars: opts.vars } : {}),
  });
}

export function cancelFlowRun(flowRunId: string, reason: string): Promise<void> {
  const taskId = taskIdForRun(flowRunId);
  if (!taskId) return Promise.resolve();
  return withTaskLock(taskId, () => cancelFlowRunUnlocked(flowRunId, reason));
}

async function cancelFlowRunUnlocked(flowRunId: string, reason: string): Promise<void> {
  const sqlite = getSqlite();
  const nodes = sqlite
    .query(
      "SELECT id, gateway_session_id FROM flow_node_runs WHERE flow_run_id = ? AND status IN ('pending','running','awaiting_human')",
    )
    .all(flowRunId) as { id: string; gateway_session_id: string | null }[];

  for (const node of nodes) {
    markNodeRunCancelled(node.id);
    if (node.gateway_session_id) {
      closeLiveSession(node.gateway_session_id);
      sqlite
        .query(
          "UPDATE gateway_sessions SET status = 'stopped', updated_at = unixepoch() WHERE id = ?",
        )
        .run(node.gateway_session_id);
    }
    sqlite
      .query(
        "UPDATE flow_node_runs SET status = 'cancelled', error = ?, ended_at = unixepoch() WHERE id = ?",
      )
      .run(reason, node.id);
  }

  // Only a live run can be cancelled: this can be queued behind a step that
  // already completed the run, and overwriting a finished run's status would
  // corrupt its history.
  sqlite
    .query(
      `UPDATE flow_runs SET status = 'cancelled', halt_reason = ?, active = '[]',
              ended_at = unixepoch(), updated_at = unixepoch()
       WHERE id = ? AND status = 'running'`,
    )
    .run(reason, flowRunId);

  const run = getFlowRunRow(flowRunId);
  if (run) {
    sqlite
      .query(
        "UPDATE tasks SET claimed_by = NULL, updated_at = unixepoch() WHERE id = ? AND claimed_by = ?",
      )
      .run(run.task_id, flowRunId);
  }
}

/**
 * A human moved a task while a flow owned it. The human wins: a task they
 * finished, cancelled or sent back must not keep being driven by a graph that
 * thinks it is mid-review.
 */
export async function onTaskStatusChangedExternally(
  taskId: string,
  status: TaskStatus,
  author?: string | undefined,
): Promise<void> {
  const run = getActiveFlowRunForTask(taskId);
  if (!run) return;
  const sqlite = getSqlite();

  // An agent node setting the task status is the in-flow protocol, not
  // interference — its own report is what routes the graph. Anything a human
  // does is authoritative and acted on immediately, whatever the nodes are
  // doing: guessing from node status meant a human closing a task whose node
  // was merely queued was silently ignored, and an agent got spawned on work
  // they had closed.
  const fromHuman = author === undefined || !["agent", "system"].includes(author);
  if (!fromHuman) return;

  // A verdict a waiting human node can route is fed into the graph rather than
  // ending the run — that is the gate being answered, not overridden.
  const waiting = sqlite
    .query(
      "SELECT node_id FROM flow_node_runs WHERE flow_run_id = ? AND status = 'awaiting_human' LIMIT 1",
    )
    .get(run.id) as { node_id: string } | null;

  if (waiting) {
    const asOutcome =
      status === "done" ? "approved" : status === "changes_requested" ? "changes_requested" : null;
    if (asOutcome) {
      const result = await resumeHumanNode({ taskId, outcome: asOutcome, author: "human" });
      if (result.ok) return;
      // The gate cannot route that verdict; fall through and stop the run.
    }
  }

  // Otherwise the human has taken the task off the agents. Stop the run whatever
  // its nodes are doing — a queued node is not a reason to ignore them, and
  // leaving it queued means an agent gets spawned on work they just closed.
  await cancelFlowRun(run.id, `human set the task to ${status}`);
  await addTaskComment(
    taskId,
    `Flow **${run.flow_name}** stopped — a human set the task to \`${status}\`.` +
      (status === "changes_requested" ? " A fresh run starts on the next cycle." : ""),
    "system",
  );
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/** Halt runs that blew their wall clock while a node sat there doing nothing. */
export async function sweepFlowTimeouts(): Promise<number> {
  const runs = getSqlite().query("SELECT id FROM flow_runs WHERE status = 'running'").all() as {
    id: string;
  }[];
  let halted = 0;

  for (const { id } of runs) {
    const taskId = taskIdForRun(id);
    if (!taskId) continue;
    const didHalt = await withTaskLock(taskId, async () => {
      try {
        // A run parked on a person is not overrunning its agent budget. The wait
        // is credited to paused_secs when the gate is answered; until then there
        // is nothing to reap, and reaping would cancel the very node they are
        // about to answer.
        const awaitingHuman = getSqlite()
          .query(
            "SELECT 1 AS present FROM flow_node_runs WHERE flow_run_id = ? AND status = 'awaiting_human' LIMIT 1",
          )
          .get(id) as { present: number } | null;
        if (awaitingHuman) return false;

        // Re-read under the lock: the run may have advanced or finished while we
        // were queued behind a node report.
        const loaded = loadRun(id);
        if (!loaded) return false;
        const step = checkFlowTimeout(loaded.def, loaded.state, nowSecs());
        if (!step) return false;
        const task = getTask(loaded.row.task_id);
        if (!task) return false;
        await applyStep(id, loaded.def, task, loaded.state, step);
        return true;
      } catch (err) {
        // One run whose stored definition cannot be applied must not abort the
        // sweep for every other run.
        logger.error(`Timeout sweep failed for flow run ${id}: ${String(err)}`);
        return false;
      }
    });
    if (didHalt) halted++;
  }
  return halted;
}

/**
 * Reap sessions that went idle or blew their absolute lifetime, then let the
 * flow react: the node fails, and the graph either routes through on_error or
 * halts for a human.
 */
export async function cleanupStaleFlowSessions(): Promise<number> {
  const config = loadConfig();
  const sqlite = getSqlite();
  const now = nowSecs();
  const idleCutoff = now - config.agent_loop.session_idle_timeout_minutes * 60;
  // A chatty-but-hung agent refreshes last_activity_at on every event and would
  // never hit the idle cutoff, holding a worker slot forever. This ceiling is
  // separate and generous so it does not reap healthy long-running work.
  const lifetimeCutoff = now - config.agent_loop.session_max_lifetime_minutes * 60;

  const stale = sqlite
    .query(
      `SELECT id, task_id, role, created_at FROM gateway_sessions
       WHERE role IN ('worker', 'reviewer') AND status = 'running'
         AND ((last_activity_at IS NOT NULL AND last_activity_at < ?
              OR last_activity_at IS NULL AND updated_at < ?)
              OR created_at < ?)`,
    )
    .all(idleCutoff, idleCutoff, lifetimeCutoff) as {
    id: string;
    task_id: string | null;
    role: string;
    created_at: number;
  }[];

  for (const session of stale) {
    const reason = session.created_at < lifetimeCutoff ? "max lifetime exceeded" : "idle timeout";
    closeLiveSession(session.id);
    sqlite
      .query(
        "UPDATE gateway_sessions SET status = 'error', last_error = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(reason, session.id);

    const nodeRun = sqlite
      .query("SELECT id FROM flow_node_runs WHERE gateway_session_id = ? LIMIT 1")
      .get(session.id) as { id: string } | null;

    if (nodeRun) {
      // Try to retry the node in place first; only let the graph see a failure
      // once the retry budget is gone.
      const owner = sqlite
        .query("SELECT task_id FROM flow_node_runs WHERE id = ?")
        .get(nodeRun.id) as { task_id: string } | null;
      const retried = owner
        ? await withTaskLock(owner.task_id, () => retryNodeRun(nodeRun.id, reason))
        : false;
      if (!retried) await finishNodeRun(nodeRun.id, reason);
    } else if (session.task_id) {
      // A session with no node run predates flows (or its run was deleted):
      // release the task the way the old loop did so it is not stuck claimed.
      sqlite
        .query(
          "UPDATE tasks SET claimed_by = NULL, status = CASE WHEN status IN ('doing','queued') THEN 'todo' ELSE status END, updated_at = unixepoch() WHERE id = ?",
        )
        .run(session.task_id);
    }
    logger.warn(`Cleaned up stale ${session.role} session ${session.id} (${reason})`);
  }

  return stale.length;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export type FlowRunView = {
  id: string;
  task_id: string;
  flow_name: string;
  flow_source: string;
  status: string;
  halt_reason: string | null;
  halt_description: string | null;
  active: { nodeId: string; attempt: number }[];
  visits: Record<string, number>;
  node_executions: number;
  vars: Record<string, unknown>;
  started_at: number;
  ended_at: number | null;
  definition: FlowDefinition | null;
  nodes: {
    node_id: string;
    node_kind: string;
    attempt: number;
    retry: number;
    status: string;
    outcome: string | null;
    summary: string | null;
    error: string | null;
    gateway_session_id: string | null;
    /** When the row was written - a node that is queued or parked has no
     *  started_at yet, and this is the only clock a reader can use for it. */
    created_at: number;
    started_at: number | null;
    ended_at: number | null;
  }[];
};

export function getFlowRunView(flowRunId: string): FlowRunView | null {
  const row = getSqlite().query("SELECT * FROM flow_runs WHERE id = ?").get(flowRunId) as
    | (FlowRunRow & { flow_source: string; halt_reason: string | null; ended_at: number | null })
    | null;
  if (!row) return null;

  const nodes = getSqlite()
    .query(
      `SELECT node_id, node_kind, attempt, retry, status, outcome, summary, error,
              gateway_session_id, created_at, started_at, ended_at
       FROM flow_node_runs WHERE flow_run_id = ? ORDER BY created_at ASC`,
    )
    .all(flowRunId) as FlowRunView["nodes"];

  return {
    id: row.id,
    task_id: row.task_id,
    flow_name: row.flow_name,
    flow_source: row.flow_source,
    status: row.status,
    halt_reason: row.halt_reason,
    halt_description: row.halt_reason ? describeHalt(row.halt_reason) : null,
    active: parseJson(row.active, [] as { nodeId: string; attempt: number }[]),
    visits: parseJson(row.visits, {} as Record<string, number>),
    node_executions: row.node_executions,
    vars: parseJson(row.vars, {} as Record<string, unknown>),
    started_at: row.started_at,
    ended_at: row.ended_at,
    definition: parseJson<FlowDefinition | null>(row.definition, null),
    nodes,
  };
}

export function getLatestFlowRunForTask(taskId: string): FlowRunView | null {
  const row = getSqlite()
    .query("SELECT id FROM flow_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(taskId) as { id: string } | null;
  return row ? getFlowRunView(row.id) : null;
}

export async function haltFlowRunForTask(
  taskId: string,
  reason: string,
  author = "system",
): Promise<boolean> {
  const run = getActiveFlowRunForTask(taskId);
  if (!run) return false;
  await cancelFlowRun(run.id, reason);
  // Author matters: a human comment forgives the cross-run budget, so an
  // automated halt must not be recorded as one.
  await addTaskComment(taskId, `Flow **${run.flow_name}** stopped: ${reason}`, author);
  return true;
}
