import { basename, dirname } from "node:path";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import {
  AgentSetupSchema,
  buildPackagePlan,
  packagePlanArgv,
  packageToolCommands,
} from "@orc/core/package-launch";
import { getDb, getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { gateway_sessions } from "@orc/db/schema";
import { and, eq } from "drizzle-orm";
import { rememberTerminalFolder } from "../git/registry.js";
import { LIVE_CHAT_ID } from "../session-watcher.js";
import { availableLaunchers, buildLaunch, LAUNCH_KINDS } from "../terminals/launch.js";
import {
  getTerminalManager,
  launchDeps,
  pickFolderOnce,
  requireTerminals,
  sessionDirDeps,
  terminalsAvailability,
} from "../terminals/service.js";
import { prepareSessionDirectory } from "../terminals/session-dir.js";

const app = new OpenAPIHono();

const LaunchKindSchema = z.enum(LAUNCH_KINDS);

const TerminalSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: LaunchKindSchema,
    cwd: z.string().nullable(),
    status: z.enum(["running", "exited"]),
    exit_code: z.number().nullable(),
    pid: z.number().nullable(),
    live_session_id: z.string().nullable(),
    created_at: z.string().datetime(),
  })
  .openapi("Terminal");

const idParam = z.object({ id: z.string() });

const listRoute = createRoute({
  method: "get",
  path: "/terminals",
  tags: ["Terminals"],
  summary: "List terminals and whether this server can start them",
  responses: {
    200: {
      description: "Terminals",
      content: {
        "application/json": {
          schema: z.object({
            enabled: z.boolean(),
            ready: z.boolean(),
            reason: z.string().nullable(),
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
            cwd: z.string().min(1).optional(),
            name: z.string().max(120).optional(),
            live_session_id: z.string().min(1).optional(),
            worktree: z
              .boolean()
              .optional()
              .openapi({ description: "Start an agent in a new git worktree of the cwd's repo" }),
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
          schema: z.object({ initial: z.string().max(4096).optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Chosen folder, or null when the dialog was cancelled",
      content: { "application/json": { schema: z.object({ path: z.string().nullable() }) } },
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
    200: { description: "Terminal", content: { "application/json": { schema: TerminalSchema } } },
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

app.openapi(listRoute, (c) => {
  const config = loadConfig();
  const { ready, reason } = terminalsAvailability(config);
  return c.json(
    {
      enabled: config.terminals.enabled,
      ready,
      reason,
      launchers: ready ? availableLaunchers(launchDeps(config)) : [],
      terminals: ready ? getTerminalManager().list() : [],
    },
    200,
  );
});

app.openapi(createTerminalRoute, async (c) => {
  const config = loadConfig();
  requireTerminals(config);
  const body = c.req.valid("json");
  const manager = getTerminalManager();
  const deps = launchDeps(config);
  const checkRules = (cwd: string | undefined | null): void => {
    if (config.rules.enabled && new RuleStore(getSqlite()).active(cwd ?? deps.home).length)
      throw new ValidationError(
        "Protected workspace requires the Claude SDK adapter; native agent terminals have unverified hook coverage",
      );
  };

  if (body.setup) {
    checkRules(body.setup.cwd);
    if (body.live_session_id || body.worktree)
      throw new ValidationError(
        "Package setups launch fresh sessions in their configured project folder",
      );
    if (body.kind && body.kind !== body.setup.backend)
      throw new ValidationError("Terminal backend must match the selected setup");
    const tools = packageToolCommands();
    if (!tools.bun) throw new ValidationError("Configured package terminals need Bun on PATH");
    manager.assertCapacity();
    const plan = buildPackagePlan(body.setup, tools);
    const info = manager.create({
      launch: {
        kind: plan.setup.backend,
        argv: packagePlanArgv(plan, tools.bun),
        cwd: plan.setup.cwd,
        resume: false,
      },
      name: body.name ?? plan.setup.name,
    });
    rememberTerminalFolder(info.cwd);
    return c.json(info, 201);
  }

  if (body.live_session_id) {
    if (body.worktree) throw new ValidationError("A resumed session keeps its own folder");
    const existing = manager.findByLiveSession(body.live_session_id);
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
    checkRules(row.cwd);
    if (row.status === "idle" || row.status === "running") {
      const original = manager.linkLiveSession({
        id: row.id,
        pid: row.pid,
        backend: row.backend,
        createdAt: row.created_at,
      });
      if (original) return c.json(original, 200);
    }
    const launch = buildLaunch(
      {
        live: {
          agent: row.backend,
          session_id: row.runtime_session_id ?? null,
          cwd: row.cwd ?? null,
        },
      },
      deps,
    );
    const info = manager.create({
      launch,
      name: body.name ?? row.title ?? undefined,
      liveSessionId: row.id,
    });
    rememberTerminalFolder(info.cwd);
    return c.json(info, 201);
  }

  // Validate the launcher and limit before making a worktree, so a failed start leaves nothing behind.
  const launch = buildLaunch({ kind: body.kind, cwd: body.cwd }, deps);
  if (launch.kind !== "shell") checkRules(launch.cwd);
  if (body.worktree && launch.kind === "shell") {
    throw new ValidationError("Worktrees are only created for agent terminals");
  }
  manager.assertCapacity();
  const cwd = await prepareSessionDirectory(
    { cwd: body.cwd, worktree: body.worktree },
    sessionDirDeps(deps),
  );
  const name = body.name ?? (cwd !== launch.cwd ? worktreeName(cwd) : undefined);
  const info = manager.create({ launch: { ...launch, cwd }, name });
  rememberTerminalFolder(info.cwd);
  return c.json(info, 201);
});

// <parent>/worktrees/<repo>/<ulid> reads as "<repo> <last 6 of the id>" in the terminal list.
function worktreeName(path: string): string {
  return `${basename(dirname(path))} ${basename(path).slice(-6).toLowerCase()}`;
}

app.openapi(pickFolderRoute, async (c) => {
  requireTerminals(loadConfig());
  const { initial } = c.req.valid("json");
  return c.json({ path: await pickFolderOnce(initial) }, 200);
});

app.openapi(getTerminalRoute, (c) => {
  requireTerminals(loadConfig());
  return c.json(getTerminalManager().get(c.req.valid("param").id), 200);
});

app.openapi(deleteTerminalRoute, (c) => {
  requireTerminals(loadConfig());
  getTerminalManager().remove(c.req.valid("param").id);
  return c.body(null, 204);
});

app.openapi(ticketRoute, (c) => {
  requireTerminals(loadConfig());
  return c.json(getTerminalManager().mintTicket(c.req.valid("param").id), 200);
});

export { app as terminalsRouter };
