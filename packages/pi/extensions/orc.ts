import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { OrcApiClient } from "../src/api.js";
import {
  loadPorcConfig,
  MCP_MODES,
  type McpMode,
  type PorcConfig,
  type PorcOverrides,
  porcPaths,
  projectArgs,
  SKILL_MODES,
  type SkillMode,
} from "../src/config.js";
import { buildMcpRegistration, redact } from "../src/mcp.js";
import { OrcMcpClient } from "../src/mcp-client.js";
import { findProjectByName, matchProjectRoot } from "../src/project.js";
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
import { BUNDLED_SKILLS, type SyncReport, syncOrcSkills } from "../src/skills.js";
import { runSpec, type SpecAction, specAvailable } from "../src/spec.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = join(packageRoot, "skills");

type Health = "unknown" | "up" | "down";

type SessionState = {
  config?: PorcConfig;
  configError?: string;
  api?: OrcApiClient;
  client?: OrcMcpClient;
  project?: string | undefined;
  projectId?: string | undefined;
  health: Health;
  mcpRegistered: boolean;
  mcpError?: string | undefined;
  contextInjected: boolean;
  contextError?: string | undefined;
  skillReport?: SyncReport;
  offered: Set<string>;
  recallError?: string | undefined;
  specAvailable?: boolean;
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
  const message = err instanceof Error ? err.message : String(err);
  return redact(message, secret);
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

function flagOverrides(pi: ExtensionAPI): PorcOverrides {
  const overrides: PorcOverrides = {};
  const apiBase = pi.getFlag("porc-api-base");
  if (typeof apiBase === "string" && apiBase.trim()) overrides.apiBase = apiBase.trim();
  const project = pi.getFlag("porc-project");
  if (typeof project === "string" && project.trim()) overrides.project = project.trim();
  const mode = pi.getFlag("porc-mode");
  if (typeof mode === "string" && mode.trim()) {
    if (!(MCP_MODES as readonly string[]).includes(mode)) {
      throw new Error(`--porc-mode must be ${MCP_MODES.join(" or ")}, got "${mode}"`);
    }
    overrides.mode = mode as McpMode;
  }
  if (pi.getFlag("porc-no-context") === true) overrides.autoContext = false;
  if (pi.getFlag("porc-no-mcp") === true) overrides.mcp = false;
  if (pi.getFlag("porc-no-spec") === true) overrides.spec = false;
  const skills = pi.getFlag("porc-skills");
  if (typeof skills === "string" && skills.trim()) {
    if (!(SKILL_MODES as readonly string[]).includes(skills)) {
      throw new Error(`--porc-skills must be ${SKILL_MODES.join(", ")}, got "${skills}"`);
    }
    overrides.skillMode = skills as SkillMode;
  }
  if (pi.getFlag("porc-no-recall") === true) overrides.recall = false;
  return overrides;
}

function selectedProject(ctx: ExtensionContext): {
  project: string | undefined;
  explicit: boolean;
} {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== "porc-project") continue;
    const data = entry.data as { project?: string | null } | undefined;
    return { project: data?.project ?? undefined, explicit: true };
  }
  return { project: undefined, explicit: false };
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
  const project = session.project ?? "no project";
  const health = session.health === "up" ? "online" : session.health === "down" ? "offline" : "…";
  ctx.ui.setStatus("porc", `orc: ${project} · ${health} · ${session.config.mode}`);
}

function registerOrcMcp(pi: ExtensionAPI, session: SessionState): void {
  const config = session.config;
  if (!config) return;
  try {
    if (session.mcpRegistered) pi.unregisterMcpServer("orc");
  } catch {
    // The server may already be gone after a reload.
  }
  session.mcpRegistered = false;
  delete session.mcpError;
  if (!config.mcp) return;
  try {
    pi.registerMcpServer(
      "orc",
      buildMcpRegistration(config, session.project, session.sessionId, session.cwd),
    );
    session.mcpRegistered = true;
  } catch (err) {
    session.mcpError = errorText(err, config.secret);
  }
}

async function refreshSkills(session: SessionState): Promise<void> {
  const config = session.config;
  if (!config) return;
  mkdirSync(config.skillDir, { recursive: true });
  if (config.skillMode !== "search" && (!session.api || session.health !== "up")) return;
  try {
    session.skillReport = await withTimeout(
      syncOrcSkills(session.api as OrcApiClient, config.skillDir, {
        mode: config.skillMode,
        names: config.pinnedSkills,
        ...(session.projectId ? { projectId: session.projectId } : {}),
      }),
      12_000,
      "ORC skill sync",
    );
  } catch (err) {
    session.skillReport = {
      dir: config.skillDir,
      written: [],
      removed: [],
      skipped: [],
      errors: [errorText(err, config.secret)],
    };
  }
}

async function resolveProject(session: SessionState, ctx: ExtensionContext): Promise<void> {
  const config = session.config;
  if (!config) return;
  const selection = selectedProject(ctx);
  const configured = selection.explicit ? selection.project : config.project;
  const auto = selection.explicit ? !selection.project : config.autoProject;
  if (!configured && !auto) return;
  if (!session.api || session.health !== "up") {
    if (configured) session.project = configured;
    return;
  }
  try {
    const roots = await session.api.projectRoots();
    if (configured) {
      const match = findProjectByName(roots, configured);
      session.project = match?.projectName ?? configured;
      session.projectId = match?.projectId;
      return;
    }
    const match = matchProjectRoot(roots, ctx.cwd);
    if (match) {
      session.project = match.projectName;
      session.projectId = match.projectId;
    }
  } catch {
    if (configured) session.project = configured;
  }
}

async function initialize(
  pi: ExtensionAPI,
  state: PluginState,
  ctx: ExtensionContext,
  options: { announce?: boolean } = {},
): Promise<void> {
  const previous = state.session;
  if (previous?.client) await previous.client.close().catch(() => undefined);

  const session: SessionState = {
    health: "unknown",
    mcpRegistered: false,
    contextInjected: false,
    offered: new Set(),
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

  await resolveProject(session, ctx);
  registerOrcMcp(pi, session);
  await refreshSkills(session);
  setStatus(ctx, session);

  if (options.announce) {
    ctx.ui.notify(
      session.health === "up"
        ? `porc ready: ${session.project ?? "no project"} (${config.mode})`
        : `ORC is offline at ${config.apiBase}; porc is limited until it starts`,
      session.health === "up" ? "info" : "warning",
    );
  }
}

const OrcParams = Type.Object({
  action: StringEnum(
    [
      "context",
      "memory_list",
      "memory_read",
      "memory_create",
      "memory_update",
      "skill_list",
      "skill_read",
      "project_list",
      "call",
    ] as const,
    { description: "ORC operation to run" },
  ),
  project: Type.Optional(
    Type.String({ description: "ORC project name; defaults to the active project" }),
  ),
  name: Type.Optional(Type.String({ description: "Memory or skill name" })),
  query: Type.Optional(Type.String({ description: "Search text for memory_list or skill_list" })),
  description: Type.Optional(Type.String({ description: "Memory description: when it matters" })),
  content: Type.Optional(Type.String({ description: "Memory content" })),
  priority: Type.Optional(
    Type.Number({ minimum: 0, maximum: 100, description: "Memory priority, higher loads first" }),
  ),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Page size" })),
  sort: Type.Optional(
    StringEnum(["reads", "recent", "priority"] as const, { description: "Memory sort order" }),
  ),
  ref: Type.Optional(Type.String({ description: "Skill-relative supporting file path" })),
  tool: Type.Optional(Type.String({ description: "ORC tool name for action call" })),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arguments for action call",
    }),
  ),
});

const SpecParams = Type.Object({
  action: StringEnum(["list", "show", "call"] as const, { description: "spec operation" }),
  operation: Type.Optional(Type.String({ description: "Operation or tool id for show or call" })),
  filter: Type.Optional(Type.String({ description: "Filter for list" })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
  data: Type.Optional(Type.Unknown({ description: "JSON arguments for call" })),
});

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
        Promise.all(windows.map((q) => client.call("memory_list", { ...base, q, limit: 5 }))),
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
        "Read ORC project context, memories and skills, or call any ORC tool. Use action context before substantive work. Use skill_read before topic-specific platform or delivery work.",
      promptSnippet: "Read ORC context, memories and skills; call any ORC tool",
      promptGuidelines: [
        "Use `orc` `memory_list` / `memory_read` instead of guessing about prior decisions, and `memory_create` / `memory_update` to save durable preferences and lessons.",
        "Use `orc` action `call` only for an ORC tool not already exposed by the native ORC MCP server.",
      ],
      parameters: OrcParams,
      async execute(_toolCallId, params) {
        const session = sessionOf(state);
        const config = requireConfig(session);
        const client = requireClient(session);
        const project = params.project ?? session.project;
        const base = projectArgs(project);
        const action = params.action;
        let tool = action as string;
        let args: Record<string, unknown> = { ...base };
        if (action === "memory_list") {
          if (params.query) args.q = params.query;
          if (params.sort) args.sort = params.sort;
          if (params.limit) args.limit = params.limit;
        } else if (action === "memory_read") {
          if (!params.name) throw new Error("memory_read requires name");
          args.name = params.name;
        } else if (action === "memory_create") {
          if (!params.name) throw new Error("memory_create requires name");
          if (!params.description) throw new Error("memory_create requires description");
          if (!params.content) throw new Error("memory_create requires content");
          args = {
            name: params.name,
            description: params.description,
            content: params.content,
            ...base,
            ...(params.priority === undefined ? {} : { priority: params.priority }),
          };
        } else if (action === "memory_update") {
          if (!params.name) throw new Error("memory_update requires name");
          args = {
            name: params.name,
            ...base,
            ...(params.description ? { description: params.description } : {}),
            ...(params.content ? { content: params.content } : {}),
            ...(params.priority === undefined ? {} : { priority: params.priority }),
          };
        } else if (action === "skill_list") {
          if (params.query) args.q = params.query;
          if (params.limit) args.limit = params.limit;
        } else if (action === "skill_read") {
          if (!params.name) throw new Error("skill_read requires name");
          args.name = params.name;
          if (params.ref) args.ref = params.ref;
        } else if (action === "call") {
          if (!params.tool) throw new Error("action call requires tool");
          tool = params.tool;
          args = { ...base, ...(params.arguments ?? {}) };
        }
        const result = await client.call(tool, args);
        if (result.isError) {
          throw new Error(redact(result.text || `ORC tool ${tool} failed`, config.secret));
        }
        return {
          content: [{ type: "text" as const, text: result.text || `${tool}: no output` }],
          details: { action, tool, project },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "orc_spec",
      label: "ORC spec",
      description:
        "Explore or call ORC operations through the spec CLI when an operation is not exposed as a tool. Requires the spec CLI.",
      promptSnippet: "Use the spec CLI against ORC for operations missing from MCP",
      parameters: SpecParams,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const session = sessionOf(state);
        const config = requireConfig(session);
        if (!config.spec)
          throw new Error("The spec bridge is disabled (PORC_SPEC=false or --porc-no-spec)");
        if (!session.specAvailable) session.specAvailable = await specAvailable(execOf(pi, signal));
        if (!session.specAvailable) throw new Error("The spec CLI is not available on PATH");
        const action: SpecAction =
          params.action === "list"
            ? {
                action: "list",
                ...(params.filter ? { filter: params.filter } : {}),
                ...(params.limit ? { limit: params.limit } : {}),
              }
            : params.action === "show"
              ? { action: "show", operation: required(params.operation, "operation") }
              : {
                  action: "call",
                  operation: required(params.operation, "operation"),
                  ...(params.data === undefined ? {} : { data: params.data }),
                };
        const result = await runSpec(execOf(pi, signal), config, action, {
          ...(session.project ? { project: session.project } : {}),
          sessionId: session.sessionId,
          cwd: ctx.cwd,
        });
        const output = redact(result.output, config.secret);
        if (!result.ok) throw new Error(output || "spec command failed");
        return {
          content: [{ type: "text" as const, text: output || "spec command returned no output" }],
          details: { action: params.action, project: session.project },
        };
      },
    }),
  );
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
}

function execOf(pi: ExtensionAPI, signal: AbortSignal | undefined) {
  return (command: string, args: string[], options?: { timeout?: number; cwd?: string }) =>
    pi.exec(command, args, {
      ...(signal ? { signal } : {}),
      ...(options?.timeout ? { timeout: options.timeout } : {}),
      ...(options?.cwd ? { cwd: options.cwd } : {}),
    });
}

function statusBody(session: SessionState): string {
  if (session.configError)
    return "porc could not load its configuration. Run /orc-doctor for details.";
  const config = session.config;
  if (!config) return "porc is not initialized.";
  return [
    `API: ${config.apiBase} (${session.health})`,
    `Project: ${session.project ?? "none"}${session.projectId ? ` [${session.projectId}]` : ""}`,
    `Mode: ${config.mode} · transport: ${config.transport} · exposure: ${config.exposure}`,
    `MCP: ${session.mcpRegistered ? "registered as orc" : config.mcp ? `not registered${session.mcpError ? ` (${session.mcpError})` : ""}` : "disabled"}`,
    `Skills: ${config.skillMode} mode${config.skillMode === "search" ? " (searched per prompt, none preloaded)" : session.skillReport ? ` (${session.skillReport.written.length} synced)` : ""}`,
    `Recall: ${config.recall.enabled ? `on (≤${config.recall.maxMemories} memories, ≤${config.recall.maxSkills} skills per prompt)${session.recallError ? ` · last error: ${session.recallError}` : ""}` : "off"}`,
    `Spec: ${config.spec ? (session.specAvailable === undefined ? "available on demand" : session.specAvailable ? "available" : "not found") : "disabled"}`,
    "",
    "Commands: /orc-context, /orc-project, /orc-skills, /orc-remember, /orc-spec, /orc-doctor, /orc-theme, /orc-reload",
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
    // The entry is durable and visible in the transcript but never sent to the model.
    ctx.ui.setWidget("porc", [title, ...(data.body ? data.body.split("\n").slice(0, 12) : [])]);
    pi.appendEntry<ReportData>("porc-report", data);
  };

  pi.registerCommand("orc", {
    description: "Show porc status and ORC connection details",
    handler: async (_args, ctx) => {
      if (!state.session) {
        report(ctx, "porc", "No active porc session.", "warning");
        return;
      }
      report(ctx, "porc", statusBody(state.session));
    },
  });

  pi.registerCommand("orc-context", {
    description: "Fetch the ORC context index now",
    handler: async (args, ctx) => {
      const session = state.session;
      if (!session) return report(ctx, "ORC context", "No active porc session.", "warning");
      try {
        requireConfig(session);
        const project = args.trim() || session.project;
        const result = await requireClient(session).call("context", projectArgs(project));
        if (result.isError) throw new Error(result.text);
        report(ctx, "ORC context", formatContextMessage(project, result.text), "info");
      } catch (err) {
        report(ctx, "ORC context failed", errorText(err, session.config?.secret), "error");
      }
    },
  });

  pi.registerCommand("orc-project", {
    description: "Select the ORC project (name, or auto)",
    handler: async (args, ctx) => {
      const session = state.session;
      if (!session) return report(ctx, "ORC project", "No active porc session.", "warning");
      try {
        const api = requireApi(session);
        let choice = args.trim();
        if (!choice) {
          if (!ctx.hasUI) {
            report(
              ctx,
              "ORC project",
              "Pass a project name, or run this in the TUI to select one.",
              "warning",
            );
            return;
          }
          const roots = await api.projectRoots();
          const selected = await ctx.ui.select("ORC project", [
            "auto",
            ...roots.map((root) => root.project_name),
          ]);
          if (!selected) return;
          choice = selected;
        }
        if (choice === "auto") {
          const roots = await api.projectRoots();
          const match = matchProjectRoot(roots, ctx.cwd);
          session.project = match?.projectName;
          session.projectId = match?.projectId;
          pi.appendEntry("porc-project", { project: match?.projectName ?? null });
        } else {
          const roots = await api.projectRoots();
          const match = findProjectByName(roots, choice);
          if (!match) {
            report(
              ctx,
              "ORC project",
              `Unknown project "${choice}". Known projects: ${roots.map((root) => root.project_name).join(", ") || "none"}`,
              "error",
            );
            return;
          }
          session.project = match.projectName;
          session.projectId = match.projectId;
          pi.appendEntry("porc-project", { project: match.projectName });
        }
        session.contextInjected = false;
        registerOrcMcp(pi, session);
        await refreshSkills(session);
        setStatus(ctx, session);
        report(
          ctx,
          "ORC project",
          `Active project: ${session.project ?? "none (auto-detect found no match)"}`,
        );
      } catch (err) {
        report(ctx, "ORC project failed", errorText(err, session.config?.secret), "error");
      }
    },
  });

  pi.registerCommand("orc-skills", {
    description: "List ORC skills visible to this project (add `sync` to refresh pinned/all mode)",
    handler: async (args, ctx) => {
      const session = state.session;
      if (!session) return report(ctx, "ORC skills", "No active porc session.", "warning");
      try {
        const config = requireConfig(session);
        if (!session.api) throw new Error("ORC API client is not available");
        if (session.health !== "up") throw new Error(`ORC is offline at ${config.apiBase}`);
        const shouldSync = /(^|\s)sync(\s|$)/.test(args) || !session.skillReport;
        if (shouldSync) await refreshSkills(session);
        const skills = await session.api.listSkills();
        const visible = skills.filter(
          (skill) =>
            skill.project_ids.length === 0 ||
            !session.projectId ||
            skill.project_ids.includes(session.projectId),
        );
        const bundled = new Set<string>(BUNDLED_SKILLS);
        const lines = visible.map(
          (skill) =>
            `${bundled.has(skill.name) ? "•" : "-"} ${skill.name} [${skill.source}]${skill.project_ids.length ? ` (${skill.project_ids.length} project${skill.project_ids.length === 1 ? "" : "s"})` : " (global)"}`,
        );
        const reportData = session.skillReport;
        const syncLines = reportData
          ? [
              "",
              `Directory: ${reportData.dir}`,
              `Synced: ${reportData.written.join(", ") || "none"}`,
              ...(reportData.removed.length ? [`Removed: ${reportData.removed.join(", ")}`] : []),
              ...(reportData.skipped.length ? [`Skipped: ${reportData.skipped.join("; ")}`] : []),
              ...(reportData.errors.length ? [`Errors: ${reportData.errors.join("; ")}`] : []),
            ]
          : [];
        report(ctx, `ORC skills (${visible.length})`, [...lines, ...syncLines].join("\n"));
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
        if (!name || !description || !content) {
          return report(
            ctx,
            "ORC remember",
            "Usage: /orc-remember <name> | <when it matters> | <content>",
            "warning",
          );
        }
        const result = await requireClient(session).call("memory_create", {
          name,
          description,
          content,
          ...projectArgs(session.project),
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

  pi.registerCommand("orc-spec", {
    description: "Run spec against ORC: list [filter] | show <op> | call <op> [json]",
    handler: async (args, ctx) => {
      const session = state.session;
      if (!session) return report(ctx, "ORC spec", "No active porc session.", "warning");
      try {
        const config = requireConfig(session);
        if (!config.spec) throw new Error("The spec bridge is disabled");
        const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        let action: SpecAction;
        if (sub === "show") {
          action = { action: "show", operation: required(rest[0], "operation") };
        } else if (sub === "call") {
          action = {
            action: "call",
            operation: required(rest[0], "operation"),
            ...(rest.length > 1 ? { data: JSON.parse(rest.slice(1).join(" ")) } : {}),
          };
        } else {
          action = {
            action: "list",
            ...(rest.length ? { filter: rest.join(" ") } : {}),
            limit: 20,
          };
        }
        if (!(await specAvailable(execOf(pi, ctx.signal)))) {
          session.specAvailable = false;
          throw new Error("The spec CLI is not available on PATH");
        }
        session.specAvailable = true;
        const result = await runSpec(execOf(pi, ctx.signal), config, action, {
          ...(session.project ? { project: session.project } : {}),
          sessionId: session.sessionId,
          cwd: ctx.cwd,
        });
        report(
          ctx,
          "ORC spec",
          redact(result.output || "No output", config.secret),
          result.ok ? "info" : "error",
        );
      } catch (err) {
        report(ctx, "ORC spec failed", errorText(err, session.config?.secret), "error");
      }
    },
  });

  pi.registerCommand("orc-doctor", {
    description: "Diagnose the porc configuration and ORC connection",
    handler: async (_args, ctx) => {
      const session = state.session;
      if (!session) return report(ctx, "porc doctor", "No active porc session.", "warning");
      const lines: string[] = [];
      const paths = porcPaths({ cwd: ctx.cwd });
      lines.push(`Config error: ${session.configError ?? "none"}`);
      lines.push(`Project trust: ${ctx.isProjectTrusted() ? "granted" : "not granted"}`);
      lines.push(
        `User config: ${paths.userFile} ${existsSync(paths.userFile) ? "(present)" : "(missing)"}`,
      );
      lines.push(
        `Project config: ${paths.projectFile} ${existsSync(paths.projectFile) ? "(present)" : "(missing)"}`,
      );
      lines.push(
        `ORC config: ${paths.orcFile} ${existsSync(paths.orcFile) ? "(present)" : "(missing)"}`,
      );
      const config = session.config;
      if (config) {
        lines.push(`API: ${config.apiBase} · health ${session.health}`);
        lines.push(
          `Secret: ${config.secret ? `set (${config.secretSource ?? "unknown"} source)` : "not set"}`,
        );
        lines.push(
          `Project: ${session.project ?? "none"}${session.projectId ? ` [${session.projectId}]` : ""}`,
        );
        lines.push(
          `MCP: ${session.mcpRegistered ? "registered" : "not registered"}${session.mcpError ? ` · ${session.mcpError}` : ""}`,
        );
        lines.push(
          `Skills directory: ${config.skillDir} ${existsSync(config.skillDir) ? "(present)" : "(missing)"}`,
        );
        try {
          const managed = readdirSync(config.skillDir).length;
          lines.push(`Managed skills: ${managed} · bundled: ${BUNDLED_SKILLS.join(", ")}`);
        } catch {
          lines.push("Managed skills: unreadable");
        }
        lines.push(
          `Bundled skills directory: ${skillDir} ${existsSync(skillDir) ? "(present)" : "(missing)"}`,
        );
        if (session.api) {
          lines.push(`API reachable now: ${(await session.api.health()) ? "yes" : "no"}`);
        }
      }
      const available = await specAvailable(execOf(pi, ctx.signal));
      session.specAvailable = available;
      lines.push(`spec CLI: ${available ? "available" : "not found"}`);
      if (session.project && !session.projectId && session.health === "up") {
        lines.push(
          "Note: project name is not matched to an id; scoped skill sync may be incomplete.",
        );
      }
      report(ctx, "porc doctor", lines.join("\n"), session.configError ? "error" : "info");
    },
  });

  pi.registerCommand("orc-theme", {
    description: "Apply the ORC theme (porc or porc-light)",
    handler: async (args, ctx) => {
      const requested = args.trim();
      const name = requested || (ctx.ui.theme.appearance === "light" ? "porc-light" : "porc");
      if (!ctx.ui.getTheme(name)) {
        report(
          ctx,
          "ORC theme",
          `Theme "${name}" is not loaded. Available: ${ctx.ui
            .getAllThemes()
            .map((theme) => theme.name)
            .join(", ")}`,
          "error",
        );
        return;
      }
      const result = ctx.ui.setTheme(name);
      report(
        ctx,
        "ORC theme",
        result.success
          ? `Applied ${name}.`
          : `Could not apply ${name}: ${result.error ?? "unknown error"}`,
        result.success ? "info" : "error",
      );
    },
  });

  pi.registerCommand("orc-reload", {
    description: "Reload porc, ORC resources and Pi extensions",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
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
  pi.registerFlag("porc-mode", {
    description: `ORC MCP mode for this session: ${MCP_MODES.join(" or ")}`,
    type: "string",
  });
  pi.registerFlag("porc-no-context", {
    description: "Do not inject the ORC context index at session start",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("porc-no-mcp", {
    description: "Do not register the native ORC MCP server",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("porc-no-spec", {
    description: "Do not enable the spec CLI bridge",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("porc-skills", {
    description: `How ORC skills reach Pi: ${SKILL_MODES.join(", ")} (default search)`,
    type: "string",
  });
  pi.registerFlag("porc-no-recall", {
    description: "Do not add relevant ORC memory and skill pointers to each prompt",
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

  pi.on("session_start", async (event, ctx) => {
    await initialize(pi, state, ctx, { announce: event.reason === "startup" });
  });

  pi.on("session_compact", async () => {
    if (!state.session) return;
    state.session.contextInjected = false;
    state.session.offered.clear();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const session = state.session;
    if (!session?.config?.enabled || session.configError) return;
    const config = session.config;
    if (config.systemPrompt) {
      event.systemPromptOptions.sections.orc = renderOrcPromptSection({
        ...(session.project ? { project: session.project } : {}),
        mode: config.mode,
        exposure: config.exposure,
        apiBase: config.apiBase,
        mcp: config.mcp,
        spec: config.spec,
        skillMode: config.skillMode,
        recall: config.recall.enabled,
      });
    }
    if (session.health !== "up") return;
    const parts: string[] = [];
    if (config.autoContext && !session.contextInjected) {
      session.contextInjected = true;
      try {
        const result = await requireClient(session).call("context", projectArgs(session.project));
        if (result.isError || !result.text.trim()) {
          session.contextError = result.text || "empty ORC context";
        } else {
          ctx.ui.setStatus("porc", `orc: ${session.project ?? "no project"} · context loaded`);
          parts.push(formatContextMessage(session.project, result.text));
        }
      } catch (err) {
        session.contextError = errorText(err, config.secret);
      }
    }
    if (config.recall.enabled && event.messageType === "user") {
      const hint = await recallHint(session, event.prompt, event.systemPromptOptions.skills);
      if (hint) parts.push(hint);
    }
    if (!parts.length) return;
    return {
      message: { customType: "porc-context", content: parts.join("\n\n"), display: false },
    };
  });

  pi.on("resources_discover", () => {
    const config = state.session?.config;
    if (!config?.enabled) return undefined;
    return { skillPaths: [config.skillDir] };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("porc", undefined);
    ctx.ui.setWidget("porc", undefined);
    const session = state.session;
    state.session = undefined;
    if (session?.client) await session.client.close().catch(() => undefined);
  });
}
