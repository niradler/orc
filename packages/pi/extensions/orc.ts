import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { OrcApiClient, OrcApiError, type OrcProjectRoot } from "../src/api.js";
import { loadPorcConfig, type PorcConfig, type PorcOverrides, porcPaths } from "../src/config.js";
import { redact } from "../src/mcp.js";
import { OrcMcpClient } from "../src/mcp-client.js";
import {
  findProjectByName,
  matchProjectRoot,
  type ProjectChoice,
  projectNameFor,
  savedProjectChoice,
  saveProjectChoice,
  shouldAskForProject,
} from "../src/project.js";
import { formatContextMessage, renderOrcPromptSection } from "../src/prompt.js";
import {
  filterRecall,
  formatRecall,
  mergeHits,
  parseMemoryHits,
  parseSkillHits,
  queryWindows,
  recallKeys,
} from "../src/recall.js";
import {
  BLOCKING_EVENTS,
  type OrcRule,
  type PiNativeEvent,
  planRules,
  RULES_REFRESH_MS,
  type RulePlan,
  removeRule,
  ruleHookGate,
  runRuleHook,
  upsertRule,
} from "../src/rules.js";

type Health = "unknown" | "up" | "down";

type SessionState = {
  config?: PorcConfig;
  configError?: string;
  api?: OrcApiClient;
  client?: OrcMcpClient;
  project?: string | undefined;
  projectId?: string | undefined;
  projectRoot?: string | undefined;
  health: Health;
  contextInjected: boolean;
  contextError?: string | undefined;
  offered: Set<string>;
  recallError?: string | undefined;
  rules?: RulePlan | undefined;
  rulesError?: string | undefined;
  rulesDisabled: boolean;
  rulesCheckedAt: number;
  pendingContext: string[];
  sessionId: string;
  cwd: string;
};

type PluginState = { session?: SessionState | undefined };

type ReportData = {
  title: string;
  body: string;
  level: "info" | "warning" | "error";
};

function errorText(err: unknown, secret: string | undefined): string {
  return redact(err instanceof Error ? err.message : String(err), secret);
}

function withTimeout<T>(value: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([value, limit]).finally(() => clearTimeout(timer));
}

function requireConfig(session: SessionState): PorcConfig {
  if (session.configError) throw new Error(`porc configuration error: ${session.configError}`);
  if (!session.config) throw new Error("porc is not initialized for this session");
  if (!session.config.enabled) throw new Error("porc is disabled (PORC_DISABLED or enabled=false)");
  return session.config;
}

function requireApi(session: SessionState): OrcApiClient {
  requireConfig(session);
  if (!session.api) throw new Error("ORC API client is not available");
  return session.api;
}

function requireClient(session: SessionState): OrcMcpClient {
  requireConfig(session);
  if (!session.client) throw new Error("ORC MCP client is not available");
  return session.client;
}

function sessionOf(state: PluginState): SessionState {
  if (!state.session) throw new Error("porc is not initialized for this session");
  return state.session;
}

function projectArgs(project: string | undefined): Record<string, unknown> {
  return project ? { project } : { scope: "global" };
}

function flagOverrides(pi: ExtensionAPI): PorcOverrides {
  const overrides: PorcOverrides = {};
  const apiBase = pi.getFlag("porc-api-base");
  if (typeof apiBase === "string" && apiBase.trim()) overrides.apiBase = apiBase.trim();
  const project = pi.getFlag("porc-project");
  if (typeof project === "string" && project.trim()) overrides.project = project.trim();
  if (pi.getFlag("porc-no-context") === true) overrides.autoContext = false;
  if (pi.getFlag("porc-no-recall") === true) overrides.recall = false;
  if (pi.getFlag("porc-no-rules") === true) overrides.rules = false;
  return overrides;
}

function setStatus(ctx: ExtensionContext, session: SessionState): void {
  if (!session.config || session.configError) {
    ctx.ui.setStatus("porc", session.configError ? "orc: config error" : "orc: unavailable");
    return;
  }
  if (!session.config.enabled) {
    ctx.ui.setStatus("porc", "orc: disabled");
    return;
  }
  const project = session.project ?? "global";
  const health = session.health === "up" ? "online" : session.health === "down" ? "offline" : "…";
  const rules = session.rules
    ? session.rules.count
      ? ` · ${session.rules.count} rules`
      : ""
    : session.config.rules && !session.rulesDisabled
      ? " · rules guarded"
      : "";
  ctx.ui.setStatus("porc", `orc: ${project} · ${health}${rules}`);
}

function applyProject(session: SessionState, match: OrcProjectRoot | undefined): void {
  session.project = match?.project_name;
  session.projectId = match?.project_id;
  session.projectRoot = match?.root || undefined;
}

function rootOf(roots: readonly OrcProjectRoot[], name: string): OrcProjectRoot | undefined {
  const match = findProjectByName(roots, name);
  return match
    ? {
        project_id: match.projectId,
        project_name: match.projectName,
        root: match.root,
        folders: [],
      }
    : undefined;
}

async function createProjectForCwd(
  session: SessionState,
  cwd: string,
  name: string,
): Promise<OrcProjectRoot> {
  const api = requireApi(session);
  try {
    const created = await api.createProject({ name, scope: cwd });
    return { project_id: created.id, project_name: created.name, root: cwd, folders: [] };
  } catch (err) {
    if (!(err instanceof OrcApiError) || err.status !== 409) throw err;
    const existing = rootOf(await api.projectRoots(), name);
    if (!existing) throw err;
    return existing;
  }
}

async function askForProject(
  session: SessionState,
  ctx: ExtensionContext,
  roots: readonly OrcProjectRoot[],
): Promise<ProjectChoice | undefined> {
  const name = projectNameFor(ctx.cwd);
  const create = name ? `Create ORC project "${name}" for this folder` : undefined;
  const existing = "Use an existing ORC project";
  const global = "Work globally, no project";
  const later = "Decide later";
  const picked = await ctx.ui.select(
    `ORC: no project for ${ctx.cwd}`,
    [create, roots.length ? existing : undefined, global, later].filter(
      (option): option is string => Boolean(option),
    ),
  );
  if (!picked || picked === later) return undefined;
  if (picked === global) return { global: true };
  if (picked === existing) {
    const project = await ctx.ui.select(
      "ORC project",
      roots.map((root) => root.project_name),
    );
    return project ? { project } : undefined;
  }
  if (!name) return undefined;
  const created = await createProjectForCwd(session, ctx.cwd, name);
  return { project: created.project_name };
}

async function resolveProject(
  session: SessionState,
  ctx: ExtensionContext,
  interactive: boolean,
): Promise<void> {
  const config = session.config;
  if (!config) return;
  if (!session.api || session.health !== "up") {
    session.project = config.project;
    return;
  }
  try {
    let roots = await session.api.projectRoots();
    if (config.project) {
      applyProject(
        session,
        rootOf(roots, config.project) ?? {
          project_id: "",
          project_name: config.project,
          root: "",
          folders: [],
        },
      );
      if (!session.projectId) session.projectId = undefined;
      return;
    }
    if (!config.autoProject) return;
    const { choicesFile } = porcPaths({ cwd: ctx.cwd });
    const saved = savedProjectChoice(choicesFile, ctx.cwd);
    const match = matchProjectRoot(roots, ctx.cwd);
    if (saved && (!match || saved.path.length >= match.root.length)) {
      applyProject(
        session,
        "project" in saved.choice ? rootOf(roots, saved.choice.project) : undefined,
      );
      return;
    }
    if (match) {
      applyProject(session, rootOf(roots, match.projectName));
      return;
    }
    if (!interactive || !config.askProject || !ctx.hasUI) return;
    if (!shouldAskForProject(ctx.cwd, homedir())) return;
    const choice = await askForProject(session, ctx, roots);
    if (!choice) return;
    saveProjectChoice(choicesFile, ctx.cwd, choice);
    if ("project" in choice) roots = await session.api.projectRoots();
    applyProject(session, "project" in choice ? rootOf(roots, choice.project) : undefined);
  } catch (err) {
    session.project = config.project;
    ctx.ui.notify(`ORC project lookup failed: ${errorText(err, config.secret)}`, "warning");
  }
}

async function refreshRules(session: SessionState): Promise<void> {
  const config = session.config;
  session.rules = undefined;
  session.rulesError = undefined;
  session.rulesDisabled = false;
  session.rulesCheckedAt = Date.now();
  if (!config?.rules || !session.api) return;
  if (session.health !== "up") {
    // ORC may have started since initialization; blocking hooks fail closed until then.
    session.health = (await session.api.health()) ? "up" : "down";
    if (session.health !== "up") return;
  }
  try {
    const data = await session.api.rules();
    if (data.enabled) session.rules = planRules(data.history, session.cwd);
    else session.rulesDisabled = true;
  } catch (err) {
    session.rulesError = errorText(err, config.secret);
  }
}

async function initialize(
  pi: ExtensionAPI,
  state: PluginState,
  ctx: ExtensionContext,
  options: { announce?: boolean; interactive?: boolean } = {},
): Promise<void> {
  const previous = state.session;
  if (previous?.client) await previous.client.close().catch(() => undefined);

  const session: SessionState = {
    health: "unknown",
    contextInjected: false,
    offered: new Set(),
    rulesDisabled: false,
    rulesCheckedAt: 0,
    pendingContext: [],
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
  };
  state.session = session;

  try {
    session.config = loadPorcConfig({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      overrides: flagOverrides(pi),
    });
  } catch (err) {
    session.configError = errorText(err, undefined);
    setStatus(ctx, session);
    if (options.announce) ctx.ui.notify(session.configError, "error");
    return;
  }

  const config = session.config;
  if (!config.enabled) {
    setStatus(ctx, session);
    if (options.announce) ctx.ui.notify("porc is disabled", "warning");
    return;
  }

  session.api = new OrcApiClient(
    config.apiBase,
    config.secret,
    config.timeoutMs,
    config.secretSource,
  );
  session.client = new OrcMcpClient(config, session.sessionId, ctx.cwd);
  session.health = (await session.api.health()) ? "up" : "down";

  await resolveProject(session, ctx, options.interactive === true);
  await refreshRules(session);
  setStatus(ctx, session);

  if (options.announce) {
    ctx.ui.notify(
      session.health === "up"
        ? `porc ready: ${session.project ?? "global"}${session.rules?.count ? ` · ${session.rules.count} ORC rules active` : ""}`
        : `ORC is offline at ${config.apiBase}; porc is limited until it starts`,
      session.health === "up" ? "info" : "warning",
    );
  }
}

const ACTIONS = [
  "context",
  "search",
  "describe",
  "invoke",
  "memory_list",
  "memory_read",
  "memory_create",
  "memory_update",
  "skill_list",
  "skill_read",
  "skill_create",
  "project_list",
  "job_create",
  "job_list",
  "rule_add",
  "rule_remove",
  "rule_list",
] as const;

type Action = (typeof ACTIONS)[number];

const OrcParams = Type.Object({
  action: StringEnum(ACTIONS, { description: "ORC operation to run" }),
  project: Type.Optional(
    Type.String({ description: "ORC project name; defaults to the active project" }),
  ),
  name: Type.Optional(
    Type.String({ description: "Memory, skill or job name; ORC tool name for describe/invoke" }),
  ),
  query: Type.Optional(
    Type.String({ description: "Search text for search, memory_list or skill_list" }),
  ),
  description: Type.Optional(Type.String({ description: "Memory description: when it matters" })),
  content: Type.Optional(
    Type.String({
      description: "Memory content, or full SKILL.md (with frontmatter) for skill_create",
    }),
  ),
  priority: Type.Optional(
    Type.Number({ minimum: 0, maximum: 100, description: "Memory priority, higher loads first" }),
  ),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "Page size" })),
  ref: Type.Optional(Type.String({ description: "Skill-relative supporting file path" })),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "Arguments for invoke" }),
  ),
  cron: Type.Optional(
    Type.String({ description: "5-field cron expression for job_create, e.g. '0 * * * *'" }),
  ),
  prompt: Type.Optional(
    Type.String({ description: "Self-contained instructions the scheduled Pi agent runs" }),
  ),
  rule: Type.Optional(
    Type.Object(
      {
        id: Type.String({ description: "Stable rule id, e.g. no-ssh" }),
        reason: Type.String({ description: "Why the rule exists; shown when it fires" }),
        events: Type.Optional(
          Type.Array(Type.String(), {
            description: "Phases such as pre_tool, post_tool, prompt_submit (default pre_tool)",
          }),
        ),
        agents: Type.Optional(
          Type.Union([Type.Literal("all"), Type.Array(Type.String())], {
            description: "Agents the rule applies to (default all)",
          }),
        ),
        filter: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description:
              "ORC rule filter {match, conditions:[{predicate:{field, operator, value}}]}; fields read the event, e.g. input.command",
          }),
        ),
        target: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description:
              "Rule target, default {type:'block'}; also inject_context or ask_user {kind:'approval', prompt}",
          }),
        ),
      },
      { description: "Rule for rule_add" },
    ),
  ),
  id: Type.Optional(Type.String({ description: "Rule id for rule_remove" })),
});

type OrcInput = {
  action: Action;
  project?: string;
  name?: string;
  query?: string;
  description?: string;
  content?: string;
  priority?: number;
  limit?: number;
  ref?: string;
  arguments?: Record<string, unknown>;
  cron?: string;
  prompt?: string;
  rule?: {
    id: string;
    reason: string;
    events?: string[];
    agents?: "all" | string[];
    filter?: Record<string, unknown>;
    target?: Record<string, unknown>;
  };
  id?: string;
};

function need<T>(value: T | undefined, message: string): T {
  if (value === undefined || (typeof value === "string" && !value.trim())) throw new Error(message);
  return value;
}

async function confirm(ctx: ExtensionContext, title: string, message: string): Promise<void> {
  if (!ctx.hasUI) return;
  if (!(await ctx.ui.confirm(title, message))) throw new Error(`${title} cancelled by the user`);
}

function ruleWorkspace(session: SessionState): string {
  return session.projectRoot || session.cwd;
}

async function mcpAction(session: SessionState, params: OrcInput): Promise<string> {
  const client = requireClient(session);
  const project = params.project ?? session.project;
  const action = params.action;
  const scope = action.startsWith("skill_") ? projectArgs(project) : project ? { project } : {};
  let tool: string = action;
  let args: Record<string, unknown> = { ...scope };
  switch (action) {
    case "context":
      args = project ? { project } : {};
      break;
    case "search":
      tool = "tool_search";
      args = { ...(params.query ? { query: params.query } : {}), limit: params.limit ?? 8 };
      break;
    case "describe":
      tool = "tool_describe";
      args = { name: need(params.name, "describe requires name") };
      break;
    case "invoke": {
      tool = "tool_invoke";
      const inner = { ...(params.arguments ?? {}) };
      if (project && inner.project === undefined && inner.project_id === undefined)
        inner.project = project;
      args = { name: need(params.name, "invoke requires name (the ORC tool)"), arguments: inner };
      break;
    }
    case "memory_list":
      if (params.query) args.q = params.query;
      if (params.limit) args.limit = params.limit;
      break;
    case "memory_read":
      args.name = need(params.name, "memory_read requires name");
      break;
    case "memory_create":
      args = {
        ...scope,
        name: need(params.name, "memory_create requires name"),
        description: need(params.description, "memory_create requires description"),
        content: need(params.content, "memory_create requires content"),
        ...(params.priority === undefined ? {} : { priority: params.priority }),
      };
      break;
    case "memory_update":
      args = {
        ...scope,
        name: need(params.name, "memory_update requires name"),
        ...(params.description ? { description: params.description } : {}),
        ...(params.content ? { content: params.content } : {}),
        ...(params.priority === undefined ? {} : { priority: params.priority }),
      };
      break;
    case "skill_list":
      if (params.query) args.q = params.query;
      args.limit = params.limit ?? 20;
      break;
    case "skill_read":
      args.name = need(params.name, "skill_read requires name");
      if (params.ref) args.ref = params.ref;
      break;
    case "skill_create":
      args = {
        ...scope,
        name: need(params.name, "skill_create requires name"),
        content: need(params.content, "skill_create requires content (full SKILL.md)"),
      };
      break;
    case "project_list":
      args = {};
      break;
    default:
      throw new Error(`Unsupported action ${action}`);
  }
  const result = await client.call(tool, args);
  if (result.isError) throw new Error(result.text || `ORC tool ${tool} failed`);
  return result.text || `${action}: no output`;
}

async function restAction(
  session: SessionState,
  params: OrcInput,
  ctx: ExtensionContext,
): Promise<string> {
  const api = requireApi(session);
  const project = params.project ?? session.project;
  const roots = project ? await api.projectRoots() : [];
  const projectId = project ? (rootOf(roots, project)?.project_id ?? session.projectId) : undefined;
  switch (params.action) {
    case "job_create": {
      const name = need(params.name, "job_create requires name");
      const cron = need(params.cron, "job_create requires cron");
      const prompt = need(params.prompt, "job_create requires prompt");
      await confirm(
        ctx,
        "Schedule ORC job",
        `${name}\nSchedule: ${cron}\nProject: ${project ?? "global"}\nRuns Pi in ${ctx.cwd}:\n${prompt}`,
      );
      const job = await api.createJob({
        name,
        trigger_type: "cron",
        cron_expr: cron,
        enabled: true,
        action: { type: "agent", prompt, backend: "pi" },
        working_dir: ctx.cwd,
        project_id: projectId ?? null,
      });
      return `Scheduled job "${job.name}" (${job.id}) with cron ${job.cron_expr}; next run ${job.next_run_at ?? "pending"}. Manage it in ORC under Jobs.`;
    }
    case "job_list": {
      const jobs = await api.listJobs(projectId);
      if (!jobs.length) return "No ORC jobs.";
      return jobs
        .map(
          (job) =>
            `- ${job.name} [${job.enabled ? "on" : "off"}] ${job.trigger_type}${job.cron_expr ? ` ${job.cron_expr}` : ""}${job.next_run_at ? ` · next ${job.next_run_at}` : ""} (${job.id})`,
        )
        .join("\n");
    }
    case "rule_list": {
      const data = await api.rules();
      const plan = planRules(data.history, ctx.cwd);
      const current = data.history.filter((revision) => revision.current && revision.policy);
      const lines = current.flatMap((revision) =>
        (revision.policy?.rules ?? []).map(
          (rule) =>
            `- ${rule.id} [${rule.enabled ? "on" : "off"}] ${rule.scope.events.join(",")} → ${rule.target.type}: ${rule.reason} (${revision.workspace})`,
        ),
      );
      return [
        `Rules ${data.enabled ? "enabled" : "disabled in ORC settings"}; ${plan.count} apply to Pi here.`,
        ...lines,
      ].join("\n");
    }
    case "rule_add": {
      const input = need(params.rule, "rule_add requires rule");
      const rule: OrcRule = {
        id: need(input.id, "rule.id is required"),
        reason: need(input.reason, "rule.reason is required"),
        kind: "event",
        enabled: true,
        scope: { agents: input.agents ?? "all", events: input.events ?? ["pre_tool"] },
        filter: (input.filter as OrcRule["filter"]) ?? { match: "all", conditions: [] },
        target: (input.target as OrcRule["target"]) ?? { type: "block" },
      };
      const workspace = ruleWorkspace(session);
      await confirm(
        ctx,
        "Activate ORC rule",
        `${rule.id}: ${rule.reason}\nWorkspace: ${workspace}\nEvents: ${rule.scope.events.join(", ")} · agents: ${Array.isArray(rule.scope.agents) ? rule.scope.agents.join(", ") : rule.scope.agents}\nTarget: ${JSON.stringify(rule.target)}\nFilter: ${JSON.stringify(rule.filter)}`,
      );
      const data = await api.rules(workspace);
      const current = data.history.find(
        (revision) => revision.current && revision.workspace === workspace,
      );
      const policy = upsertRule(current?.policy ?? null, rule, workspace, projectId ?? null);
      const revision = await api.activateRules(
        policy,
        current?.id ?? null,
        `Pi: ${rule.id} - ${rule.reason}`.slice(0, 4000),
      );
      await refreshRules(session);
      setStatus(ctx, session);
      return `Activated rule ${rule.id} in ${revision.workspace} (revision ${revision.id}).${data.enabled ? "" : " Rules are disabled in ORC settings; enable them for enforcement."}`;
    }
    case "rule_remove": {
      const id = need(params.id, "rule_remove requires id");
      const workspace = ruleWorkspace(session);
      const data = await api.rules(workspace);
      const current = data.history.find(
        (revision) => revision.current && revision.workspace === workspace && revision.policy,
      );
      const next = current?.policy ? removeRule(current.policy, id) : undefined;
      if (!current || !next) throw new Error(`No rule ${id} in ${workspace}`);
      if (!next.rules.length)
        throw new Error(
          `${id} is the last rule in ${workspace}; disable it or revert the revision in ORC's Rules page`,
        );
      await confirm(ctx, "Remove ORC rule", `${id}\nWorkspace: ${workspace}`);
      const revision = await api.activateRules(next, current.id, `Pi: remove ${id}`);
      await refreshRules(session);
      setStatus(ctx, session);
      return `Removed rule ${id} (revision ${revision.id}).`;
    }
    default:
      throw new Error(`Unsupported action ${params.action}`);
  }
}

const REST_ACTIONS = new Set<Action>([
  "job_create",
  "job_list",
  "rule_add",
  "rule_remove",
  "rule_list",
]);

async function recallHint(
  session: SessionState,
  prompt: string,
  skills: ReadonlyArray<{ name: string }> | undefined,
): Promise<string | undefined> {
  const config = session.config;
  if (!config) return undefined;
  const windows = queryWindows(prompt);
  if (!windows.length) return undefined;
  const base = projectArgs(session.project);
  try {
    const client = requireClient(session);
    const [skillRes, memoryRes] = await withTimeout(
      Promise.all([
        Promise.all(windows.map((q) => client.call("skill_list", { ...base, q, limit: 5 }))),
        Promise.all(
          windows.map((q) =>
            client.call("memory_list", {
              ...(session.project ? { project: session.project } : {}),
              q,
              limit: 5,
            }),
          ),
        ),
      ]),
      4000,
      "recall",
    );
    const found = filterRecall(
      {
        skills: mergeHits(
          skillRes.map((res) =>
            res.isError ? [] : parseSkillHits(res.text, config.recall.minSkillScore),
          ),
        ),
        memories: mergeHits(memoryRes.map((res) => (res.isError ? [] : parseMemoryHits(res.text)))),
      },
      config.recall,
      session.offered,
      new Set((skills ?? []).map((skill) => skill.name)),
    );
    const text = formatRecall(found, config.recall.budgetChars);
    if (!text) return undefined;
    for (const key of recallKeys(found)) session.offered.add(key);
    session.recallError = undefined;
    return text;
  } catch (err) {
    session.recallError = errorText(err, config.secret);
    return undefined;
  }
}

function registerTools(pi: ExtensionAPI, state: PluginState): void {
  pi.registerTool(
    defineTool({
      name: "orc",
      label: "ORC",
      description:
        "ORC system of record: project context, memories, skills, scheduled jobs and guardrail rules. search/describe/invoke reach every other ORC tool (tasks, knowledge, sessions…).",
      promptSnippet: "ORC memories, skills, jobs, rules and any ORC tool via search/invoke",
      promptGuidelines: [
        "Save memories and skills to ORC with `orc` (`memory_create`, `skill_create`), not local files.",
        "For an ORC capability without its own action, `search` then `describe` and `invoke` it.",
        "Use `job_create` for recurring work and `rule_add` to block or gate agent behaviour.",
      ],
      parameters: OrcParams,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const session = sessionOf(state);
        const config = requireConfig(session);
        const input = params as OrcInput;
        try {
          const text = REST_ACTIONS.has(input.action)
            ? await restAction(session, input, ctx)
            : await mcpAction(session, input);
          return {
            content: [{ type: "text" as const, text: redact(text, config.secret) }],
            details: { action: input.action, project: input.project ?? session.project },
          };
        } catch (err) {
          throw new Error(errorText(err, config.secret));
        }
      },
    }),
  );
}

function statusBody(session: SessionState): string {
  if (session.configError)
    return "porc could not load its configuration. Run /orc-doctor for details.";
  const config = session.config;
  if (!config) return "porc is not initialized.";
  return [
    `API: ${config.apiBase} (${session.health}) · transport ${config.transport}`,
    `Project: ${session.project ?? "global"}${session.projectId ? ` [${session.projectId}]` : ""}${session.projectRoot ? ` · ${session.projectRoot}` : ""}`,
    `Rules: ${config.rules ? (session.rules ? `${session.rules.count} apply here (${[...session.rules.events].join(", ") || "no Pi events"})` : session.rulesError ? `error: ${session.rulesError}` : "none loaded") : "off"}`,
    `Recall: ${config.recall.enabled ? `on (≤${config.recall.maxMemories} memories, ≤${config.recall.maxSkills} skills per prompt)${session.recallError ? ` · last error: ${session.recallError}` : ""}` : "off"}`,
    `Context: ${config.autoContext ? (session.contextError ? `error: ${session.contextError}` : session.contextInjected ? "loaded" : "on first prompt") : "off"}`,
    "",
    "Commands: /orc-context, /orc-project, /orc-skills, /orc-remember, /orc-doctor, /orc-theme, /orc-reload",
  ].join("\n");
}

function registerCommands(pi: ExtensionAPI, state: PluginState): void {
  const report = (
    ctx: ExtensionContext,
    title: string,
    body: string,
    level: ReportData["level"] = "info",
  ): void => {
    const text = body.trim();
    const data: ReportData = {
      title,
      body: text.length > 8000 ? `${text.slice(0, 8000)}\n… truncated` : text,
      level,
    };
    ctx.ui.setWidget("porc", [title, ...(data.body ? data.body.split("\n").slice(0, 12) : [])]);
    pi.appendEntry<ReportData>("porc-report", data);
  };

  pi.registerCommand("orc", {
    description: "Show porc status and ORC connection details",
    handler: async (_args, ctx) => {
      if (!state.session) return report(ctx, "porc", "No active porc session.", "warning");
      report(ctx, "porc", statusBody(state.session));
    },
  });

  pi.registerCommand("orc-context", {
    description: "Fetch the ORC context index now",
    handler: async (args, ctx) => {
      const session = state.session;
      if (!session) return report(ctx, "ORC context", "No active porc session.", "warning");
      try {
        const project = args.trim() || session.project;
        const result = await requireClient(session).call("context", project ? { project } : {});
        if (result.isError) throw new Error(result.text);
        report(ctx, "ORC context", formatContextMessage(project, result.text));
      } catch (err) {
        report(ctx, "ORC context failed", errorText(err, session.config?.secret), "error");
      }
    },
  });

  pi.registerCommand("orc-project", {
    description: "Choose the ORC project for this folder: <name>, new, global, auto or reset",
    handler: async (args, ctx) => {
      const session = state.session;
      if (!session) return report(ctx, "ORC project", "No active porc session.", "warning");
      try {
        const api = requireApi(session);
        const { choicesFile } = porcPaths({ cwd: ctx.cwd });
        let roots = await api.projectRoots();
        let choice = args.trim();
        if (!choice) {
          if (!ctx.hasUI)
            return report(
              ctx,
              "ORC project",
              "Usage: /orc-project <name> | new | global | auto | reset",
              "warning",
            );
          const picked = await ctx.ui.select("ORC project for this folder", [
            "auto (match ORC project folders)",
            "new (create a project for this folder)",
            "global (no project)",
            ...roots.map((root) => root.project_name),
          ]);
          if (!picked) return;
          choice = picked.split(" ")[0] ?? picked;
        }
        if (choice === "auto" || choice === "reset") {
          saveProjectChoice(choicesFile, ctx.cwd, null);
          const match = matchProjectRoot(roots, ctx.cwd);
          applyProject(session, match ? rootOf(roots, match.projectName) : undefined);
        } else if (choice === "global") {
          saveProjectChoice(choicesFile, ctx.cwd, { global: true });
          applyProject(session, undefined);
        } else if (choice === "new") {
          const name = projectNameFor(ctx.cwd);
          if (!name) throw new Error("This folder name cannot become an ORC project name");
          const created = await createProjectForCwd(session, ctx.cwd, name);
          saveProjectChoice(choicesFile, ctx.cwd, { project: created.project_name });
          roots = await api.projectRoots();
          applyProject(session, rootOf(roots, created.project_name) ?? created);
        } else {
          const match = rootOf(roots, choice);
          if (!match)
            return report(
              ctx,
              "ORC project",
              `Unknown project "${choice}". Known: ${roots.map((root) => root.project_name).join(", ") || "none"}`,
              "error",
            );
          saveProjectChoice(choicesFile, ctx.cwd, { project: match.project_name });
          applyProject(session, match);
        }
        session.contextInjected = false;
        session.offered.clear();
        await refreshRules(session);
        setStatus(ctx, session);
        report(ctx, "ORC project", `Active: ${session.project ?? "global (no project)"}`);
      } catch (err) {
        report(ctx, "ORC project failed", errorText(err, session.config?.secret), "error");
      }
    },
  });

  pi.registerCommand("orc-skills", {
    description: "Search ORC skills for this project: /orc-skills [query]",
    handler: async (args, ctx) => {
      const session = state.session;
      if (!session) return report(ctx, "ORC skills", "No active porc session.", "warning");
      try {
        const query = args.trim();
        const result = await requireClient(session).call("skill_list", {
          ...projectArgs(session.project),
          ...(query ? { q: query } : {}),
          limit: 30,
        });
        if (result.isError) throw new Error(result.text);
        report(ctx, query ? `ORC skills: ${query}` : "ORC skills", result.text || "No skills.");
      } catch (err) {
        report(ctx, "ORC skills failed", errorText(err, session.config?.secret), "error");
      }
    },
  });

  pi.registerCommand("orc-remember", {
    description: "Save an ORC memory: /orc-remember <name> | <description> | <content>",
    handler: async (args, ctx) => {
      const session = state.session;
      if (!session) return report(ctx, "ORC remember", "No active porc session.", "warning");
      try {
        const config = requireConfig(session);
        const [name, description, ...rest] = args.split("|").map((part) => part.trim());
        const content = rest.join(" | ").trim();
        if (!name || !description || !content)
          return report(
            ctx,
            "ORC remember",
            "Usage: /orc-remember <name> | <when it matters> | <content>",
            "warning",
          );
        const result = await requireClient(session).call("memory_create", {
          ...(session.project ? { project: session.project } : {}),
          name,
          description,
          content,
        });
        report(
          ctx,
          "ORC remember",
          redact(result.text || "Saved.", config.secret),
          result.isError ? "error" : "info",
        );
      } catch (err) {
        report(ctx, "ORC remember failed", errorText(err, session.config?.secret), "error");
      }
    },
  });

  pi.registerCommand("orc-doctor", {
    description: "Diagnose the porc configuration and ORC connection",
    handler: async (_args, ctx) => {
      const session = state.session;
      if (!session) return report(ctx, "porc doctor", "No active porc session.", "warning");
      const paths = porcPaths({ cwd: ctx.cwd });
      const present = (path: string): string =>
        `${path} ${existsSync(path) ? "(present)" : "(missing)"}`;
      const lines = [
        `Config error: ${session.configError ?? "none"}`,
        `Project trust: ${ctx.isProjectTrusted() ? "granted" : "not granted"}`,
        `User config: ${present(paths.userFile)}`,
        `Project config: ${present(paths.projectFile)}`,
        `ORC config: ${present(paths.orcFile)}`,
        `Project choices: ${present(paths.choicesFile)}`,
      ];
      const config = session.config;
      if (config) {
        lines.push(`API: ${config.apiBase} · health ${session.health}`);
        lines.push(
          `Secret: ${config.secret ? `set (${config.secretSource ?? "unknown"} source)` : "not set"}`,
        );
        lines.push(`ORC command: ${config.command} (MCP over ${config.transport}, rule hooks)`);
        if (session.api)
          lines.push(`API reachable now: ${(await session.api.health()) ? "yes" : "no"}`);
        if (session.client) {
          try {
            const tools = await session.client.listTools();
            lines.push(`MCP: ${tools.map((tool) => tool.name).join(", ")}`);
          } catch (err) {
            lines.push(`MCP: ${errorText(err, config.secret)}`);
          }
        }
      }
      lines.push(statusBody(session));
      report(ctx, "porc doctor", lines.join("\n"), session.configError ? "error" : "info");
    },
  });

  pi.registerCommand("orc-theme", {
    description: "Apply the ORC theme (porc or porc-light)",
    handler: async (args, ctx) => {
      const name = args.trim() || (ctx.ui.theme.appearance === "light" ? "porc-light" : "porc");
      if (!ctx.ui.getTheme(name))
        return report(
          ctx,
          "ORC theme",
          `Theme "${name}" is not loaded. Available: ${ctx.ui
            .getAllThemes()
            .map((theme) => theme.name)
            .join(", ")}`,
          "error",
        );
      const result = ctx.ui.setTheme(name);
      report(
        ctx,
        "ORC theme",
        result.success
          ? `Applied ${name}.`
          : `Could not apply ${name}: ${result.error ?? "unknown"}`,
        result.success ? "info" : "error",
      );
    },
  });

  pi.registerCommand("orc-reload", {
    description: "Reload porc, ORC rules and Pi extensions",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
}

function hookEnv(session: SessionState): Record<string, string> {
  const config = session.config;
  return {
    ...(config ? { ORC_API_BASE: config.apiBase } : {}),
    ...(config?.secret ? { ORC_API_SECRET: config.secret } : {}),
    ORC_SESSION_ID: session.sessionId,
  };
}

async function checkRules(
  session: SessionState | undefined,
  native: PiNativeEvent,
  payload: Record<string, unknown>,
  ctx: ExtensionContext,
) {
  if (!session?.config)
    return BLOCKING_EVENTS.has(native)
      ? { block: true, reason: "ORC rules unavailable: porc configuration failed to load" }
      : undefined;
  const gate = ruleHookGate({
    enabled: session.config.rules,
    plan: session.rules,
    disabled: session.rulesDisabled,
    native,
  });
  if (!gate.run) return undefined;
  return runRuleHook({
    command: session.config.command,
    native,
    payload: { session_id: session.sessionId, cwd: ctx.cwd, ...payload },
    cwd: ctx.cwd,
    env: hookEnv(session),
    timeoutMs: gate.timeoutMs,
    signal: ctx.signal,
  });
}

function registerRuleHooks(pi: ExtensionAPI, state: PluginState): void {
  pi.on("tool_call", async (event, ctx) => {
    const session = state.session;
    const decision = await checkRules(
      session,
      "tool_call",
      { tool_call_id: event.toolCallId, tool_name: event.toolName, tool_input: event.input },
      ctx,
    );
    if (!decision) return undefined;
    if (decision.block) return { block: true, reason: decision.reason ?? "Blocked by an ORC rule" };
    if (decision.updatedInput) Object.assign(event.input, decision.updatedInput);
    if (decision.context) session?.pendingContext.push(decision.context);
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const session = state.session;
    const text = event.content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n");
    const decision = await checkRules(
      session,
      "tool_result",
      {
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        tool_input: event.input,
        tool_response: event.isError
          ? { error: text.slice(0, 4000) }
          : { output: text.slice(0, 4000) },
      },
      ctx,
    );
    const pending = session?.pendingContext.splice(0) ?? [];
    const context = [...pending, ...(decision?.context ? [decision.context] : [])];
    if (!context.length) return undefined;
    return {
      content: [
        ...event.content,
        { type: "text" as const, text: `ORC rules:\n${context.join("\n\n")}` },
      ],
      ...(event.structuredContent === undefined
        ? {}
        : { structuredContent: event.structuredContent }),
    };
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    const decision = await checkRules(state.session, "input", { prompt: event.text }, ctx);
    if (decision?.block) {
      ctx.ui.notify(decision.reason ?? "Prompt blocked by an ORC rule", "warning");
      return { action: "handled" as const };
    }
    if (decision?.context) state.session?.pendingContext.push(decision.context);
    return { action: "continue" as const };
  });
}

export default function porc(pi: ExtensionAPI): void {
  const state: PluginState = {};

  pi.registerFlag("porc-api-base", {
    description: "ORC API base URL for this session",
    type: "string",
  });
  pi.registerFlag("porc-project", {
    description: "ORC project name for this session",
    type: "string",
  });
  pi.registerFlag("porc-no-context", {
    description: "Do not inject the ORC context index on the first prompt",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("porc-no-recall", {
    description: "Do not add relevant ORC memory and skill pointers to each prompt",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("porc-no-rules", {
    description: "Do not enforce ORC rules in this session",
    type: "boolean",
    default: false,
  });

  pi.registerEntryRenderer<ReportData>("porc-report", (entry, _options, theme) => {
    const data = entry.data ?? { title: "porc", body: "", level: "info" as const };
    const color =
      data.level === "error" ? "error" : data.level === "warning" ? "warning" : "accent";
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg(color, theme.bold(data.title)), 0, 0));
    if (data.body) box.addChild(new Text(data.body, 0, 0));
    return box;
  });
  registerTools(pi, state);
  registerCommands(pi, state);
  registerRuleHooks(pi, state);

  pi.on("session_start", async (event, ctx) => {
    await initialize(pi, state, ctx, {
      announce: event.reason === "startup",
      interactive: event.reason === "startup" || event.reason === "new",
    });
    const decision = await checkRules(
      state.session,
      "session_start",
      { source: event.reason },
      ctx,
    );
    if (decision?.context) state.session?.pendingContext.push(decision.context);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    const session = state.session;
    if (!session) return;
    const decision = await checkRules(session, "session_before_compact", {}, ctx);
    if (decision?.context) session.pendingContext.push(decision.context);
  });

  pi.on("session_compact", async (_event, ctx) => {
    const session = state.session;
    if (!session) return;
    session.contextInjected = false;
    session.offered.clear();
    const decision = await checkRules(session, "session_compact", {}, ctx);
    if (decision?.context) session.pendingContext.push(decision.context);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const session = state.session;
    if (!session) return;
    const decision = await checkRules(session, "agent_end", {}, ctx);
    if (decision?.context) session.pendingContext.push(decision.context);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const session = state.session;
    if (!session?.config?.enabled || session.configError) return;
    const config = session.config;
    if (config.rules && Date.now() - session.rulesCheckedAt >= RULES_REFRESH_MS) {
      await refreshRules(session);
      setStatus(ctx, session);
    }
    if (config.systemPrompt) {
      event.systemPromptOptions.sections.orc = renderOrcPromptSection({
        ...(session.project ? { project: session.project } : {}),
        apiBase: config.apiBase,
        recall: config.recall.enabled,
        rules: config.rules,
      });
    }
    const parts: string[] = [];
    const ruleContext = session.pendingContext.splice(0);
    if (ruleContext.length) parts.push(`ORC rules:\n${ruleContext.join("\n\n")}`);
    if (session.health === "up" && config.autoContext && !session.contextInjected) {
      session.contextInjected = true;
      try {
        const result = await requireClient(session).call(
          "context",
          session.project ? { project: session.project } : {},
        );
        if (result.isError || !result.text.trim()) {
          session.contextError = result.text || "empty ORC context";
        } else {
          session.contextError = undefined;
          parts.push(formatContextMessage(session.project, result.text));
        }
      } catch (err) {
        session.contextError = errorText(err, config.secret);
      }
      setStatus(ctx, session);
    }
    if (session.health === "up" && config.recall.enabled && event.messageType === "user") {
      const hint = await recallHint(session, event.prompt, event.systemPromptOptions.skills);
      if (hint) parts.push(hint);
    }
    if (!parts.length) return;
    return {
      message: { customType: "porc-context", content: parts.join("\n\n"), display: false },
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await checkRules(state.session, "session_shutdown", {}, ctx).catch(() => undefined);
    ctx.ui.setStatus("porc", undefined);
    ctx.ui.setWidget("porc", undefined);
    const session = state.session;
    state.session = undefined;
    if (session?.client) await session.client.close().catch(() => undefined);
  });
}
