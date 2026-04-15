import { shortId, ulid } from "@orc/core/ids";
import type { GatewayMode } from "@orc/core/types";
import {
  apiApproveTask,
  apiFindJobByName,
  apiFindProjectById,
  apiFindProjectByName,
  apiFindTask,
  apiListActiveTasks,
  apiListJobs,
  apiListProjects,
  apiRejectTask,
  apiSearchMemories,
  apiCreateTask,
  apiTriggerJob,
} from "./api.js";
import {
  assignTaskToSession,
  createGatewaySession,
  findPermission,
  getActiveGatewaySession,
  listGatewaySessions,
  setActiveGatewaySession,
  updateChatMode,
  updateChatProject,
  updateChatWorkingDir,
  updateGatewaySession,
} from "./store.js";
import type { DirectCommandResult } from "./types.js";

export function backendFromMode(mode: GatewayMode): string {
  if (mode.startsWith("agent:")) {
    const name = mode.slice(6);
    return name || "claude";
  }
  return "claude";
}

function statusEmoji(status: string): string {
  if (status === "running") return "⚡";
  if (status === "error") return "❌";
  if (status === "stopped") return "⛔";
  return "💤";
}

function priorityEmoji(p: string): string {
  if (p === "critical") return "🔴";
  if (p === "high") return "🟠";
  if (p === "normal") return "🟡";
  return "⚪";
}

function taskStatusEmoji(s: string): string {
  if (s === "done") return "✅";
  if (s === "review") return "👀";
  if (s === "doing") return "🔨";
  if (s === "blocked") return "🚧";
  if (s === "changes_requested") return "🔁";
  if (s === "cancelled") return "❌";
  return "📋";
}

function helpText(mode: GatewayMode, projectName?: string): string {
  const projectLine = projectName ? `\n📁 Project: <b>${projectName}</b>` : "";
  const base = [
    "<b>ORC Gateway Commands</b>" + projectLine,
    "",
    "<b>Navigation</b>",
    "/help - this message",
    "/status - system overview",
    "/mode [direct|agent:&lt;name&gt;|multi|job:&lt;name&gt;] - switch mode",
    "/cwd &lt;path&gt; - set working directory",
    "",
    "<b>Projects</b>",
    "/projects - list and select active project",
    "/project [name] - show or set active project",
    "",
    "<b>Tasks</b>",
    "/tasks - list active tasks (scoped to project if set)",
    "/task &lt;id&gt; - task details",
    "/create &lt;title&gt; - quick-create a task",
    "/approve &lt;id&gt; [note] - approve task or permission",
    "/reject &lt;id&gt; [note] - reject task or deny permission",
    "/assign &lt;task-id&gt; &lt;agent&gt; - assign task to agent session",
    "",
    "<b>Jobs</b>",
    "/jobs - list jobs (scoped to project if set)",
    "/run &lt;name&gt; - trigger a job",
    "",
    "<b>Memory</b>",
    "/mem &lt;query&gt; - search memories (scoped to project if set)",
    "",
    "<b>Agents</b>",
    "/agent &lt;name&gt; - switch active agent (claude, codex, gemini, copilot, a2a, ...)",
    "/sessions - list all agent sessions",
    "/session new|list|switch &lt;id&gt;|stop - session lifecycle",
  ];
  if (mode.startsWith("agent:") || mode === "multi") {
    base.push("", "<i>Current mode: agent — send any text to the active agent</i>");
  }
  return base.join("\n");
}

export async function handleDirectCommand(input: {
  chatKey: string;
  rawText: string;
  currentMode?: GatewayMode;
  currentWorkingDir?: string | null;
  currentProjectId?: string | null;
}): Promise<DirectCommandResult | null> {
  const text = input.rawText.trim();
  if (!text.startsWith("/")) return null;

  const parts = text.split(/\s+/);
  const command = parts[0] ?? "";
  const argText = parts.slice(1).join(" ").trim();

  if (command === "/start" || command === "/help") {
    let projectName: string | undefined;
    if (input.currentProjectId) {
      const proj = await apiFindProjectById(input.currentProjectId).catch(() => null);
      projectName = proj?.name;
    }
    return { html: helpText(input.currentMode ?? "direct", projectName) };
  }

  if (command === "/status") {
    const [activeTasks, sessions, jobs, activeSession] = await Promise.all([
      apiListActiveTasks(input.currentProjectId).catch(() => []),
      listGatewaySessions(input.chatKey),
      apiListJobs(input.currentProjectId).catch(() => []),
      getActiveGatewaySession(input.chatKey),
    ]);
    let projectLine = "";
    if (input.currentProjectId) {
      const proj = await apiFindProjectById(input.currentProjectId).catch(() => null);
      projectLine = proj ? `\n📁 Project: <b>${proj.name}</b>` : "";
    }
    const lines = [
      "<b>ORC Status</b>" + projectLine,
      "",
      `Mode: <code>${input.currentMode ?? "direct"}</code>`,
      `Working dir: <code>${input.currentWorkingDir ?? "(unset)"}</code>`,
      "",
      `<b>Tasks</b>: ${activeTasks.slice(0, 5).length} active`,
      `<b>Jobs</b>: ${jobs.slice(0, 5).length} defined`,
      `<b>Sessions</b>: ${sessions.length} total`,
    ];
    if (activeSession) {
      lines.push(
        `<b>Active session</b>: ${activeSession.backend} ${statusEmoji(activeSession.status)} <code>${shortId(activeSession.id)}</code>`,
      );
    }
    return { html: lines.join("\n") };
  }

  if (command === "/mode") {
    if (!argText) return { text: "Usage: /mode <direct|agent:<name>|multi|job:<name>>" };
    const mode = argText as GatewayMode;
    await updateChatMode(input.chatKey, mode);
    return { text: `Mode updated to ${mode}`, mode };
  }

  if (command === "/cwd") {
    if (!argText) return { text: "Usage: /cwd <absolute-path>" };
    await updateChatWorkingDir(input.chatKey, argText);
    const session = await getActiveGatewaySession(input.chatKey);
    if (session) await updateGatewaySession(session.id, { cwd: argText });
    return { text: `Working directory set to ${argText}` };
  }

  if (command === "/agent") {
    if (!argText) {
      return { text: "Usage: /agent <name> (e.g. claude, codex, gemini, copilot, a2a)" };
    }
    const mode = `agent:${argText}` as GatewayMode;
    await updateChatMode(input.chatKey, mode);
    return { text: `Agent mode set to ${mode}`, mode };
  }

  if (command === "/tasks") {
    const rows = await apiListActiveTasks(input.currentProjectId).catch(() => []);
    if (rows.length === 0) return { text: "No active tasks." };
    const lines = ["<b>Active Tasks</b>", ""];
    for (const row of rows) {
      const claimed = row.claimed_by ? ` [${row.claimed_by}]` : "";
      lines.push(
        `${taskStatusEmoji(row.status)} ${priorityEmoji(row.priority)} <code>${shortId(row.id)}</code> ${row.title}${claimed}`,
      );
    }
    return { html: lines.join("\n") };
  }

  if (command === "/task") {
    if (!argText) return { text: "Usage: /task <id>" };
    const task = await apiFindTask(argText);
    if (!task) return { text: `Task not found: ${argText}` };
    const lines = [
      `<b>${task.title}</b>`,
      `ID: <code>${task.id}</code>`,
      `Status: ${taskStatusEmoji(task.status)} ${task.status}`,
      `Priority: ${priorityEmoji(task.priority)} ${task.priority}`,
    ];
    if (task.claimed_by) lines.push(`Agent: ${task.claimed_by}`);
    if (task.body) lines.push("", task.body.slice(0, 500));
    const buttons =
      task.status === "review"
        ? [
            [
              { label: "✅ Approve", value: `task:approve:${task.id}` },
              { label: "🔁 Changes", value: `task:reject:${task.id}` },
            ],
          ]
        : undefined;
    return { html: lines.join("\n"), buttons };
  }

  if (command === "/approve") {
    if (!argText) return { text: "Usage: /approve <task-or-permission-id> [note]" };
    const [id, ...noteParts] = argText.split(/\s+/);
    if (!id) return { text: "Usage: /approve <task-or-permission-id> [note]" };
    const note = noteParts.join(" ").trim();

    const permission = await findPermission(id);
    if (permission) {
      return {
        text: `Permission ${shortId(permission.id)} queued for approval - use the button or wait for agent context.`,
      };
    }
    const task = await apiFindTask(id);
    if (!task) return { text: `No task or permission found for ${id}` };
    await apiApproveTask(task.id, note || "Approved from gateway");
    return { text: `✅ Approved task [${shortId(task.id)}] ${task.title}` };
  }

  if (command === "/reject") {
    if (!argText) return { text: "Usage: /reject <task-or-permission-id> [note]" };
    const [id, ...noteParts] = argText.split(/\s+/);
    if (!id) return { text: "Usage: /reject <task-or-permission-id> [note]" };
    const note = noteParts.join(" ").trim();

    const permission = await findPermission(id);
    if (permission) {
      return {
        text: `Permission ${shortId(permission.id)} denial queued - use the button or wait for agent context.`,
      };
    }
    const task = await apiFindTask(id);
    if (!task) return { text: `No task or permission found for ${id}` };
    await apiRejectTask(task.id, note || "Changes requested from gateway");
    return { text: `🔁 Changes requested for [${shortId(task.id)}] ${task.title}` };
  }

  if (command === "/assign") {
    const [taskId, agent] = argText.split(/\s+/);
    if (!taskId || !agent) return { text: "Usage: /assign <task-id> <agent>" };
    const task = await apiFindTask(taskId);
    if (!task) return { text: `Task not found: ${taskId}` };
    const sessions = await listGatewaySessions(input.chatKey);
    const session = sessions.find((s) => s.backend === agent && s.status !== "stopped");
    if (!session) {
      return {
        text: `No active ${agent} session found. Start one with /agent ${agent} then send a message.`,
      };
    }
    await assignTaskToSession(session.id, task.id);
    return {
      text: `Assigned [${shortId(task.id)}] ${task.title} → ${agent} session [${shortId(session.id)}]`,
    };
  }

  if (command === "/jobs") {
    const rows = await apiListJobs(input.currentProjectId).catch(() => []);
    if (rows.length === 0) return { text: "No jobs defined." };
    const lines = ["<b>Jobs</b>", ""];
    for (const row of rows) {
      const status = row.last_run_at ? "ran" : "never";
      lines.push(`• <code>${row.name}</code> (${row.trigger_type}) - ${status} × ${row.run_count}`);
    }
    return { html: lines.join("\n") };
  }

  if (command === "/run") {
    if (!argText) return { text: "Usage: /run <job-name>" };
    const job = await apiFindJobByName(argText);
    if (!job) return { text: `Job not found: ${argText}` };
    const runId = await apiTriggerJob(job.id);
    return { text: `Triggered ${job.name} → run ${shortId(runId)}` };
  }

  if (command === "/mem") {
    if (!argText) return { text: "Usage: /mem <query>" };
    const rows = await apiSearchMemories(argText, input.currentProjectId).catch(() => []);
    if (rows.length === 0) return { text: "No matching memories." };
    const lines = ["<b>Memories</b>", ""];
    for (const row of rows) {
      const title = row.title ?? row.content.slice(0, 40);
      lines.push(`• [${shortId(row.id)}] <b>${title}</b>`);
      lines.push(`  ${row.content.slice(0, 120)}${row.content.length > 120 ? "…" : ""}`);
    }
    return { html: lines.join("\n") };
  }

  if (command === "/sessions") {
    const sessions = await listGatewaySessions(input.chatKey);
    if (sessions.length === 0) return { text: "No agent sessions yet." };
    const active = await getActiveGatewaySession(input.chatKey);
    const lines = ["<b>Agent Sessions</b>", ""];
    for (const s of sessions) {
      const marker = s.id === active?.id ? "▶ " : "  ";
      const task = s.task_id ? ` task:${shortId(s.task_id)}` : "";
      lines.push(
        `${marker}${statusEmoji(s.status)} <code>${shortId(s.id)}</code> ${s.backend}${task}`,
      );
      if (s.cwd) lines.push(`     cwd: <code>${s.cwd}</code>`);
    }
    return { html: lines.join("\n") };
  }

  if (command === "/session") {
    const [subcommand, ...args] = parts.slice(1);
    if (!subcommand) return { text: "Usage: /session <new|list|switch <id>|stop>" };

    if (subcommand === "new") {
      const backend = backendFromMode(input.currentMode ?? "agent:claude");
      const session = await createGatewaySession({
        chatKey: input.chatKey,
        backend,
        cwd: input.currentWorkingDir ?? undefined,
        mode: (input.currentMode ?? `agent:${backend}`) as GatewayMode,
        title: `Session ${shortId(ulid())}`,
      });
      await setActiveGatewaySession(input.chatKey, session.id);
      return { text: `Created and activated ${backend} session [${shortId(session.id)}]` };
    }

    if (subcommand === "list") {
      const sessions = await listGatewaySessions(input.chatKey);
      if (sessions.length === 0) return { text: "No gateway sessions yet." };
      const active = await getActiveGatewaySession(input.chatKey);
      const lines = sessions.map((s, i) => {
        const marker = s.id === active?.id ? "*" : " ";
        return `${marker}${i + 1}. [${shortId(s.id)}] ${s.backend} ${s.status} cwd=${s.cwd ?? "(unset)"}`;
      });
      return { text: lines.join("\n") };
    }

    if (subcommand === "switch") {
      const target = args.join(" ").trim();
      if (!target) return { text: "Usage: /session switch <id-or-index>" };
      const sessions = await listGatewaySessions(input.chatKey);
      const session = /^\d+$/.test(target)
        ? sessions[Number(target) - 1]
        : sessions.find((s) => s.id === target || s.id.endsWith(target));
      if (!session) return { text: `Session not found: ${target}` };
      await setActiveGatewaySession(input.chatKey, session.id);
      return { text: `Active session: [${shortId(session.id)}] ${session.backend}` };
    }

    if (subcommand === "stop") {
      const active = await getActiveGatewaySession(input.chatKey);
      if (active) {
        await updateGatewaySession(active.id, { status: "stopped" });
      }
      await setActiveGatewaySession(input.chatKey, null);
      return { text: "Cleared active gateway session." };
    }

    return { text: "Usage: /session <new|list|switch <id>|stop>" };
  }

  if (command === "/projects") {
    const rows = await apiListProjects().catch(() => []);
    if (rows.length === 0) {
      return { text: "No active projects. Create one with: orc project add <name>" };
    }
    const active = input.currentProjectId;
    const lines = ["<b>📁 Projects</b> — tap to activate", ""];
    for (const row of rows) {
      const marker = row.id === active ? "▶ " : "  ";
      const desc = row.description ? ` — ${row.description}` : "";
      lines.push(`${marker}<code>${row.name}</code>${desc}`);
    }
    const btnRows: Array<Array<{ label: string; value: string }>> = [];
    let rowBuf: Array<{ label: string; value: string }> = [];
    for (const row of rows) {
      const marker = row.id === active ? "▶ " : "";
      rowBuf.push({ label: `${marker}${row.name}`, value: `project:set:${row.id}` });
      if (rowBuf.length === 3) {
        btnRows.push(rowBuf);
        rowBuf = [];
      }
    }
    if (rowBuf.length > 0) btnRows.push(rowBuf);
    if (active) {
      btnRows.push([{ label: "🚫 Clear project", value: "project:clear" }]);
    }
    return { html: lines.join("\n"), buttons: btnRows };
  }

  if (command === "/project") {
    if (!argText) {
      if (!input.currentProjectId) {
        return { text: "No active project. Use /projects to pick one." };
      }
      const proj = await apiFindProjectById(input.currentProjectId).catch(() => null);
      return {
        text: proj ? `📁 Active project: ${proj.name}` : "Project not found. Use /projects to pick one.",
      };
    }
    const proj = await apiFindProjectByName(argText);
    if (!proj) {
      return { text: `Project not found: ${argText}\n\nUse /projects to see available projects.` };
    }
    await updateChatProject(input.chatKey, proj.id);
    return { text: `✅ Active project: ${proj.name}`, projectId: proj.id };
  }

  if (command === "/create") {
    if (!argText) return { text: "Usage: /create <task title>" };
    const task = await apiCreateTask(argText, input.currentProjectId);
    return { text: `✅ Created task [${shortId(task.id)}] ${task.title}` };
  }

  return { text: `Unknown command: ${command}\n\nType /help for available commands.` };
}

export async function ensureAgentSession(input: {
  chatKey: string;
  mode: GatewayMode;
  cwd?: string | null;
}): Promise<typeof import("@orc/db/schema").gateway_sessions.$inferSelect> {
  const active = await getActiveGatewaySession(input.chatKey);
  const backend = backendFromMode(input.mode);
  if (active && active.backend === backend && active.status !== "stopped") return active;
  const session = await createGatewaySession({
    chatKey: input.chatKey,
    backend,
    cwd: input.cwd ?? undefined,
    mode: input.mode,
    title: `Session ${shortId(ulid())}`,
  });
  await setActiveGatewaySession(input.chatKey, session.id);
  return session;
}
