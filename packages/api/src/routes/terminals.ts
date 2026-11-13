import { basename, dirname } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import { agentForSessionBackend } from "@orc/core/coding-agents";
import { loadConfig } from "@orc/core/config";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import {
  createHostFolder,
  execHostFor,
  LOCAL_HOST,
  listHostDirectories,
} from "@orc/core/exec-host";
import { jobShellArgv } from "@orc/core/job-settings";
import { AgentSetupSchema } from "@orc/core/package-launch";
import { ProviderIdSchema } from "@orc/core/providers";
import { getDb, getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { gateway_sessions } from "@orc/db/schema";
import { and, eq } from "drizzle-orm";
import { rememberTerminalFolder } from "../git/registry.js";
import { getHandoffService } from "../handoffs/service.js";
import { recordAudit } from "../lib/audit-actor.js";
import { preparePackageLaunch } from "../lib/package-launch.js";
import { createRouter } from "../lib/router.js";
import { LIVE_CHAT_ID } from "../session-watcher.js";
import {
  selectedTerminalHost,
  TerminalHostQuerySchema,
  TerminalHostSchema,
} from "../terminals/host.js";
import {
  availableLaunchers,
  buildLaunch,
  configureProviderLaunch,
  LAUNCH_KINDS,
  providerLaunchDeps,
} from "../terminals/launch.js";
import {
  getTerminalManager,
  launchDeps,
  launchOnHost,
  pickFolderOnce,
  requireTerminals,
  sessionDirDeps,
  terminalsAvailability,
} from "../terminals/service.js";
import { prepareSessionDirectory } from "../terminals/session-dir.js";
import {
  projectById,
  projectWorkspaceConfig,
  resolveProjectForPath,
  workspaceLaunch,
} from "../workspaces/service.js";

const app = createRouter();

const LaunchKindSchema = z
  .string()
  .refine((kind) => LAUNCH_KINDS.includes(kind), { message: "Unknown terminal kind" });

const TerminalSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: LaunchKindSchema,
    cwd: z.string().nullable(),
    host: z.string().nullable(),
    status: z.enum(["running", "exited"]),
    exit_code: z.number().nullable(),
    pid: z.number().nullable(),
    live_session_id: z.string().nullable(),
    project_id: z.string().nullable(),
    worktree_path: z.string().nullable(),
    dev: z.boolean(),
    preview_url: z.string().nullable(),
    created_at: z.string().datetime(),
  })
  .openapi("Terminal");

const idParam = z.object({ id: z.string() });

const listRoute = createRoute({
  method: "get",
  path: "/terminals",
  tags: ["Terminals"],
  summary: "List terminals and whether this server can start them",
  request: { query: z.object({ host: TerminalHostQuerySchema }) },
  responses: {
    200: {
      description: "Terminals",
      content: {
        "application/json": {
          schema: z.object({
            enabled: z.boolean(),
            ready: z.boolean(),
            reason: z.string().nullable(),
            host: z.string().nullable(),
            launchers: z.array(LaunchKindSchema),
            terminals: z.array(TerminalSchema),
          }),
        },
      },
    },
  },
});

const createTerminalRoute = createRoute({
  method: "post",
  path: "/terminals",
  tags: ["Terminals"],
  summary: "Start a terminal: a shell, a fresh coding agent, or a resumed live session",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            kind: LaunchKindSchema.optional(),
            providerId: ProviderIdSchema.optional(),
            host: TerminalHostSchema.optional().openapi({
              description:
                "SSH config alias, or null for Local. Omit to use the configured default.",
            }),
            cwd: z.string().min(1).optional(),
            name: z.string().max(120).optional(),
            live_session_id: z.string().min(1).optional(),
            fork: z.boolean().optional().openapi({
              description:
                "With live_session_id: open a new session from that session's history instead of resuming it. The source session is left untouched.",
            }),
            worktree: z.boolean().optional().openapi({
              description: "Start an agent in a new git worktree of the cwd's repo",
            }),
            project_id: z.string().optional().openapi({
              description: "Project whose workspace environment and ports this terminal uses",
            }),
            dev: z.boolean().optional().openapi({
              description:
                "Run the project's dev script in a shell and publish the first printed URL as a preview",
            }),
            setup: AgentSetupSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Existing terminal already attached to that live session",
      content: { "application/json": { schema: TerminalSchema } },
    },
    201: {
      description: "Terminal started",
      content: { "application/json": { schema: TerminalSchema } },
    },
  },
});

const pickFolderRoute = createRoute({
  method: "post",
  path: "/terminals/pick-folder",
  tags: ["Terminals"],
  summary: "Open the native folder dialog on the API machine and return the chosen folder",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            initial: z.string().max(4096).optional(),
            host: TerminalHostSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Chosen folder, or null when the dialog was cancelled",
      content: {
        "application/json": {
          schema: z.object({ path: z.string().nullable() }),
        },
      },
    },
  },
});

const browseRoute = createRoute({
  method: "get",
  path: "/terminals/browse",
  tags: ["Terminals"],
  summary: "List the folders inside a folder on the machine where terminals run",
  request: {
    query: z.object({ path: z.string().max(4096).default(""), host: TerminalHostQuerySchema }),
  },
  responses: {
    200: {
      description: "Folders",
      content: {
        "application/json": {
          schema: z.object({
            host: z.string().nullable(),
            path: z.string(),
            parent: z.string().nullable(),
            directories: z.array(z.string()),
          }),
        },
      },
    },
  },
});

const createFolderRoute = createRoute({
  method: "post",
  path: "/terminals/browse/folders",
  tags: ["Terminals"],
  summary: "Create a folder inside a folder on the machine where terminals run",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            host: TerminalHostSchema,
            parent: z.string().min(1).max(4096),
            name: z.string().trim().min(1).max(255),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created folder",
      content: {
        "application/json": { schema: z.object({ path: z.string() }) },
      },
    },
  },
});

const getTerminalRoute = createRoute({
  method: "get",
  path: "/terminals/{id}",
  tags: ["Terminals"],
  summary: "Get a terminal",
  request: { params: idParam },
  responses: {
    200: {
      description: "Terminal",
      content: { "application/json": { schema: TerminalSchema } },
    },
  },
});

const deleteTerminalRoute = createRoute({
  method: "delete",
  path: "/terminals/{id}",
  tags: ["Terminals"],
  summary: "Kill a terminal's process and remove it",
  request: { params: idParam },
  responses: { 204: { description: "Removed" } },
});

const renameTerminalRoute = createRoute({
  method: "patch",
  path: "/terminals/{id}",
  tags: ["Terminals"],
  summary: "Rename a terminal",
  request: {
    params: idParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ name: z.string().trim().min(1).max(120) }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Renamed terminal",
      content: { "application/json": { schema: TerminalSchema } },
    },
  },
});

const ticketRoute = createRoute({
  method: "post",
  path: "/terminals/{id}/ticket",
  tags: ["Terminals"],
  summary: "Mint a single-use WebSocket ticket for one terminal",
  request: { params: idParam },
  responses: {
    200: {
      description: "Ticket",
      content: {
        "application/json": {
          schema: z.object({ ticket: z.string(), expires_in: z.number() }),
        },
      },
    },
  },
});

app.openapi(listRoute, async (c) => {
  const config = loadConfig();
  const availability = terminalsAvailability(config);
  const requested = c.req.valid("query").host;
  const host = selectedTerminalHost(config, requested === "" ? null : requested);
  let { ready, reason } = availability;
  let launchers: ReturnType<typeof availableLaunchers> = [];
  if (ready) {
    try {
      launchers = availableLaunchers(await launchDeps(config, host), config.preferences.agents);
    } catch (error) {
      ready = false;
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  return c.json(
    {
      enabled: config.terminals.enabled,
      ready,
      reason,
      host: host.kind === "ssh" ? host.alias : null,
      launchers,
      terminals: availability.ready ? getTerminalManager().list() : [],
    },
    200,
  );
});

app.openapi(createTerminalRoute, async (c) => {
  const config = loadConfig();
  requireTerminals(config);
  const body = c.req.valid("json");
  const manager = getTerminalManager();
  let host = body.live_session_id
    ? LOCAL_HOST
    : selectedTerminalHost(config, body.host !== undefined ? body.host : body.setup?.host);
  let deps = await launchDeps(config, host);
  const checkRules = (cwd: string | undefined | null): void => {
    if (!config.rules.enabled) return;
    if (new RuleStore(getSqlite()).active(cwd ?? deps.home).length)
      throw new ValidationError(
        "Protected workspace requires the Claude SDK adapter; native agent terminals have unverified hook coverage",
      );
  };
  const checkPlannedRules = async (path: string): Promise<void> => {
    if (!config.rules.enabled) return;
    let scope = path;
    while (!(await deps.isDirectory(scope))) {
      const parent = dirname(scope);
      if (parent === scope) throw new ValidationError("Cannot resolve planned workspace");
      scope = parent;
    }
    checkRules(scope);
  };

  if (body.fork && !body.live_session_id)
    throw new ValidationError("A fork needs the live session it starts from");

  if (body.setup) {
    if (body.providerId)
      throw new ValidationError("Package setups manage their own provider configuration.");
    checkRules(body.setup.cwd);
    if (body.live_session_id || body.worktree)
      throw new ValidationError(
        "Package setups launch fresh sessions in their configured project folder",
      );
    if (body.kind && body.kind !== body.setup.backend)
      throw new ValidationError("Terminal backend must match the selected setup");
    manager.assertCapacity();
    const { plan, argv } = await preparePackageLaunch(body.setup, host);
    const info = manager.create({
      launch: await launchOnHost(host, {
        kind: plan.setup.backend,
        argv,
        cwd: plan.setup.cwd,
        resume: false,
      }),
      name: body.name ?? plan.setup.name,
    });
    rememberTerminalFolder(info.cwd, info.host);
    recordAudit(c, {
      action: "terminal.created",
      subject_ids: [info.id],
      snapshot: { kind: info.kind, host: info.host, cwd: info.cwd, source: "setup" },
    });
    return c.json(info, 201);
  }

  if (body.live_session_id) {
    if (body.worktree) throw new ValidationError("A resumed session keeps its own folder");
    if (body.host !== undefined) throw new ValidationError("A resumed session keeps its own host");
    const existing = body.fork ? null : manager.findByLiveSession(body.live_session_id);
    if (existing) {
      checkRules(existing.cwd);
      return c.json(existing, 200);
    }
    const row = await getDb().query.gateway_sessions.findFirst({
      where: and(
        eq(gateway_sessions.id, body.live_session_id),
        eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
      ),
    });
    if (!row) throw new NotFoundError("Live session", body.live_session_id);
    const forking = body.fork === true;
    const handoff = forking ? null : await getHandoffService().verifyResume(row.id);
    host = execHostFor(row.execution_host ?? null, config);
    deps = await launchDeps(config, host);
    checkRules(row.cwd);
    if (!forking && (row.status === "idle" || row.status === "running")) {
      const original = manager.linkLiveSession(
        {
          id: row.id,
          pid: row.pid,
          backend: row.backend,
          createdAt: row.created_at,
          host: row.execution_host ?? null,
        },
        (info) => checkRules(info.cwd),
      );
      if (original) return c.json(original, 200);
    }
    const resumedKind = agentForSessionBackend(row.backend)?.id;
    if (resumedKind)
      deps = providerLaunchDeps(
        resumedKind,
        body.providerId ?? resumedKind,
        deps,
        host.kind === "ssh",
        true,
      );
    const launch = await buildLaunch(
      {
        live: {
          agent: row.backend,
          session_id: row.runtime_session_id ?? null,
          cwd: row.cwd ?? null,
        },
        fork: forking,
      },
      deps,
    );
    if (handoff && launch.kind === "codex" && launch.cwd) launch.argv.push("--cd", launch.cwd);
    const resumedLaunch = await launchOnHost(
      host,
      configureProviderLaunch(launch, body.providerId ?? launch.kind, true),
    );
    const concurrent = forking ? null : manager.findByLiveSession(row.id);
    if (concurrent) {
      checkRules(concurrent.cwd);
      return c.json(concurrent, 200);
    }
    checkRules(row.cwd);
    const info = manager.create({
      launch: resumedLaunch,
      name:
        body.name ??
        (forking ? `${row.display_title ?? row.title ?? row.backend} (fork)` : row.title) ??
        undefined,
      ...(forking ? {} : { liveSessionId: row.id }),
    });
    if (handoff) await getHandoffService().markResumed(row.id);
    rememberTerminalFolder(info.cwd, info.host);
    recordAudit(c, {
      action: "terminal.created",
      subject_ids: [info.id],
      snapshot: {
        kind: info.kind,
        host: info.host,
        cwd: info.cwd,
        source: forking ? "fork" : "resume",
        live_session_id: row.id,
      },
    });
    return c.json(info, 201);
  }

  // Validate the launcher and limit before making a worktree, so a failed start leaves nothing behind.
  if (body.dev && body.kind && body.kind !== "shell")
    throw new ValidationError("A dev server runs in a shell terminal");
  if (body.dev && body.providerId)
    throw new ValidationError("A dev server does not use a coding provider");
  const kind = body.dev ? "shell" : body.kind;
  deps = providerLaunchDeps(
    kind ?? "shell",
    body.dev ? undefined : body.providerId,
    deps,
    host.kind === "ssh",
  );
  const launch = configureProviderLaunch(
    await buildLaunch({ kind, cwd: body.cwd }, deps),
    body.dev ? undefined : body.providerId,
  );
  if (launch.kind !== "shell") checkRules(launch.cwd);
  if (body.worktree && launch.kind === "shell") {
    throw new ValidationError("Worktrees are only created for agent terminals");
  }
  manager.assertCapacity();
  const cwd = await prepareSessionDirectory(
    { cwd: body.cwd, worktree: body.worktree },
    { ...sessionDirDeps(deps, host), validateDirectory: checkPlannedRules },
  );
  if (launch.kind !== "shell") checkRules(cwd);
  const workspace = await workspaceLaunch(host, cwd, body.project_id);
  const project = body.project_id ? projectById(body.project_id) : resolveProjectForPath(cwd);
  const devScript = project ? projectWorkspaceConfig(project).dev_script?.trim() : null;
  if (body.dev && !devScript)
    throw new ValidationError("This project has no dev script. Add one in project settings.");
  const withWorkspace: typeof launch = {
    ...launch,
    cwd,
    env: { ...launch.env, ...workspace.env },
    ...(body.dev && devScript ? { argv: jobShellArgv(undefined, devScript, deps.platform) } : {}),
  };
  const name =
    body.name ??
    (body.dev && project
      ? `${project.name} preview`
      : cwd !== launch.cwd
        ? worktreeName(cwd)
        : undefined);
  const info = manager.create({
    launch: await launchOnHost(host, withWorkspace),
    name,
    metadata: {
      projectId: workspace.projectId,
      worktreePath: workspace.worktreePath,
      dev: Boolean(body.dev),
    },
  });
  rememberTerminalFolder(info.cwd, info.host);
  recordAudit(c, {
    action: "terminal.created",
    subject_ids: [info.id],
    snapshot: {
      kind: info.kind,
      host: info.host,
      cwd: info.cwd,
      worktree: Boolean(body.worktree),
      source: "launch",
    },
  });
  return c.json(info, 201);
});

// <repo>/.orc/worktrees/<ulid> reads as "<repo> <last 6 of the id>" in the terminal list.
function worktreeName(path: string): string {
  return `${basename(dirname(dirname(dirname(path))))} ${basename(path).slice(-6).toLowerCase()}`;
}

app.openapi(pickFolderRoute, async (c) => {
  const config = loadConfig();
  requireTerminals(config);
  const { initial, host } = c.req.valid("json");
  return c.json({ path: await pickFolderOnce(initial, selectedTerminalHost(config, host)) }, 200);
});

app.openapi(browseRoute, async (c) => {
  const config = loadConfig();
  requireTerminals(config);
  const requested = c.req.valid("query").host;
  const host = selectedTerminalHost(config, requested === "" ? null : requested);
  const listing = await listHostDirectories(host, c.req.valid("query").path);
  return c.json({ host: host.kind === "ssh" ? host.alias : null, ...listing }, 200);
});

app.openapi(createFolderRoute, async (c) => {
  const config = loadConfig();
  requireTerminals(config);
  const { host, parent, name } = c.req.valid("json");
  const path = await createHostFolder(selectedTerminalHost(config, host), parent, name);
  return c.json({ path }, 201);
});

app.openapi(getTerminalRoute, (c) => {
  requireTerminals(loadConfig());
  return c.json(getTerminalManager().get(c.req.valid("param").id), 200);
});

app.openapi(deleteTerminalRoute, (c) => {
  requireTerminals(loadConfig());
  const { id } = c.req.valid("param");
  const info = getTerminalManager().get(id);
  getTerminalManager().remove(id);
  recordAudit(c, {
    action: "terminal.removed",
    subject_ids: [id],
    snapshot: { kind: info.kind, host: info.host, cwd: info.cwd, status: info.status },
  });
  return c.body(null, 204);
});

app.openapi(renameTerminalRoute, (c) => {
  requireTerminals(loadConfig());
  return c.json(
    getTerminalManager().rename(c.req.valid("param").id, c.req.valid("json").name),
    200,
  );
});

app.openapi(ticketRoute, (c) => {
  requireTerminals(loadConfig());
  return c.json(getTerminalManager().mintTicket(c.req.valid("param").id), 200);
});

export { app as terminalsRouter };
