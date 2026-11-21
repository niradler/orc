import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import {
  loadConfig,
  REMOTE_HOST_ID,
  type RemoteHost,
  RemoteHostSchema,
  updateGlobalConfig,
} from "@orc/core/config";
import { ValidationError } from "@orc/core/errors";
import { ALIAS_PATTERN } from "@orc/core/exec-host";
import { SEND_BLOCKED_HEADERS } from "@orc/core/session-send";
import { recordAudit } from "../lib/audit-actor.js";
import { createRouter } from "../lib/router.js";
import { findRemoteHost, remoteFetch, remoteJson } from "../remote-hosts.js";

const app = createRouter();

const PublicRemoteHostSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    url: z.string(),
    has_token: z.boolean(),
    header_names: z.array(z.string()),
  })
  .openapi("RemoteHost");

const RemoteHostListSchema = z.object({ hosts: z.array(PublicRemoteHostSchema) });

const RemoteHostDraftSchema = z
  .object({
    id: z.string().regex(REMOTE_HOST_ID).optional(),
    label: z.string().trim().min(1).max(200),
    url: z.string().trim().max(2048),
    token: z.string().max(8192).optional(),
    clear_token: z.boolean().optional(),
    headers: z
      .array(
        z.object({
          // Same token shape the send path enforces; reject invalid names here
          // instead of storing one that fails opaquely at dial time.
          name: z
            .string()
            .trim()
            .min(1)
            .max(128)
            .regex(/^[A-Za-z0-9-]{1,128}$/, "Expected a valid header name"),
          value: z.string().max(8192),
        }),
      )
      .max(32)
      .optional(),
  })
  .strict();

const RemoteHostTestSchema = z
  .object({
    ok: z.boolean(),
    version: z.string().nullable(),
    error: z.string().nullable(),
  })
  .openapi("RemoteHostTest");

const RemoteHostTargetsSchema = z
  .object({
    host: z.string().nullable().openapi({ description: "The remote's default execution host" }),
    hosts: z.array(z.string()).openapi({ description: "SSH aliases configured on the remote" }),
  })
  .openapi("RemoteHostTargets");

const idParam = z.object({ id: z.string().regex(REMOTE_HOST_ID) });

const publicHost = (host: z.infer<typeof RemoteHostSchema>) => ({
  id: host.id,
  label: host.label,
  url: host.url,
  has_token: Boolean(host.token),
  header_names: host.headers.map((header) => header.name),
});

/**
 * Blank header values keep the stored secret for the same name, mirroring the access
 * token. Stored values are only carried over while the address is unchanged; a new
 * header name must come with a value.
 */
function resolveHeaders(
  draft: { name: string; value: string }[] | undefined,
  saved: RemoteHost | undefined,
  url: string,
): { name: string; value: string }[] {
  if (!draft) return saved?.headers ?? [];
  const addressUnchanged = saved !== undefined && saved.url === url;
  const kept = addressUnchanged ? (saved?.headers ?? []) : [];
  const keptByName = new Map(kept.map((header) => [header.name.toLowerCase(), header]));
  const savedNames = new Set((saved?.headers ?? []).map((header) => header.name.toLowerCase()));
  const headers: { name: string; value: string }[] = [];
  for (const header of draft) {
    const name = header.name.trim();
    if (!name) continue;
    if (header.value.trim()) {
      headers.push({ name, value: header.value });
      continue;
    }
    const prior = keptByName.get(name.toLowerCase());
    if (prior) {
      headers.push({ name: prior.name, value: prior.value });
      continue;
    }
    // A stored header left blank after an address change is dropped, like the token.
    if (savedNames.has(name.toLowerCase())) continue;
    throw new ValidationError(`Enter a value for the ${name} header`);
  }
  return headers;
}

const list = () => ({ hosts: loadConfig().remote_hosts.map(publicHost) });

function normalizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("Enter a full http:// or https:// ORC address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ValidationError("The ORC address must use http:// or https://");
  if (url.username || url.password)
    throw new ValidationError("Do not put a username or password in the address");
  if (url.search || url.hash)
    throw new ValidationError("The address cannot have a query or fragment");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path === "/api" ? "" : path;
  return url.toString().replace(/\/+$/, "");
}

app.openapi(
  createRoute({
    method: "get",
    path: "/remote-hosts",
    tags: ["System"],
    summary: "Remote ORC servers this server can run agents on",
    responses: {
      200: {
        description: "Saved remote hosts",
        content: { "application/json": { schema: RemoteHostListSchema } },
      },
    },
  }),
  (c) => c.json(list()),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/remote-hosts",
    tags: ["System"],
    summary: "Add or update a remote ORC host in ~/.orc/config.json",
    description:
      "A blank token keeps the saved one while the address is unchanged. Omitted headers keep the saved ones; a blank header value keeps the stored value for the same name.",
    request: { body: { content: { "application/json": { schema: RemoteHostDraftSchema } } } },
    responses: {
      200: {
        description: "Saved remote hosts",
        content: { "application/json": { schema: RemoteHostListSchema } },
      },
    },
  }),
  (c) => {
    const draft = c.req.valid("json");
    const url = normalizeUrl(draft.url);
    for (const header of draft.headers ?? [])
      if (SEND_BLOCKED_HEADERS.has(header.name.toLowerCase()))
        throw new ValidationError(`The ${header.name} header cannot be set here`);
    const saved = draft.id
      ? loadConfig().remote_hosts.find((host) => host.id === draft.id)
      : undefined;
    if (draft.id && !saved) throw new ValidationError("That remote host is no longer saved");
    const token =
      draft.token?.trim() || (saved && saved.url === url && !draft.clear_token ? saved.token : "");
    const host = RemoteHostSchema.parse({
      id: saved?.id ?? randomUUID().slice(0, 8),
      label: draft.label,
      url,
      token,
      headers: resolveHeaders(draft.headers, saved, url),
    });
    updateGlobalConfig((raw) => {
      const current = Array.isArray(raw.remote_hosts)
        ? (raw.remote_hosts as { id?: unknown }[])
        : [];
      raw.remote_hosts = saved
        ? current.map((item) => (item.id === host.id ? host : item))
        : [...current, host];
    });
    recordAudit(c, {
      action: saved ? "settings.remote_host_updated" : "settings.remote_host_added",
      subject_ids: [host.id],
      snapshot: { label: host.label, url: host.url },
    });
    return c.json(list());
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/remote-hosts/{id}",
    tags: ["System"],
    summary: "Remove a remote ORC host",
    request: { params: idParam },
    responses: {
      200: {
        description: "Saved remote hosts",
        content: { "application/json": { schema: RemoteHostListSchema } },
      },
    },
  }),
  (c) => {
    const { id } = c.req.valid("param");
    findRemoteHost(id);
    updateGlobalConfig((raw) => {
      const current = Array.isArray(raw.remote_hosts)
        ? (raw.remote_hosts as { id?: unknown }[])
        : [];
      raw.remote_hosts = current.filter((item) => item.id !== id);
    });
    recordAudit(c, { action: "settings.remote_host_removed", subject_ids: [id], snapshot: {} });
    return c.json(list());
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/remote-hosts/{id}/test",
    tags: ["System"],
    summary: "Check that a remote ORC answers and accepts the saved credentials",
    request: { params: idParam },
    responses: {
      200: {
        description: "Test result",
        content: { "application/json": { schema: RemoteHostTestSchema } },
      },
    },
  }),
  async (c) => {
    const host = findRemoteHost(c.req.valid("param").id);
    try {
      const health = await remoteJson<{ status?: string; version?: string }>(host, "/health");
      if (health.status !== "ok") throw new ValidationError(`${host.label} is not an ORC server`);
      const access = await remoteFetch(host, "/settings");
      if (!access.ok)
        throw new ValidationError(
          access.status === 401
            ? `${host.label} needs a valid access token`
            : `${host.label} answered HTTP ${access.status}`,
        );
      return c.json({ ok: true, version: health.version ?? null, error: null });
    } catch (error) {
      return c.json({
        ok: false,
        version: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/remote-hosts/{id}/hosts",
    tags: ["System"],
    summary: "Execution hosts configured on a remote ORC: its own machine and its SSH aliases",
    request: { params: idParam },
    responses: {
      200: {
        description: "Remote targets",
        content: { "application/json": { schema: RemoteHostTargetsSchema } },
      },
    },
  }),
  async (c) => {
    const ssh = await remoteJson<{ host: string | null; hosts: string[]; locked: boolean }>(
      findRemoteHost(c.req.valid("param").id),
      "/ssh",
    );
    return c.json({ host: ssh.host, hosts: ssh.locked ? [] : ssh.hosts });
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/remote-hosts/{id}/projects",
    tags: ["System"],
    summary: "Projects on a remote ORC, for choosing where a sent session lands",
    request: { params: idParam },
    responses: {
      200: {
        description: "Remote projects",
        content: {
          "application/json": {
            schema: z.object({
              projects: z.array(
                z.object({
                  name: z.string(),
                  git_remote_url: z.string().nullable(),
                  scope: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const { projects } = await remoteJson<{
      projects: { name: string; git_remote_url?: string | null; scope?: string | null }[];
    }>(findRemoteHost(c.req.valid("param").id), "/projects?limit=100");
    return c.json({
      projects: projects.map((project) => ({
        name: project.name,
        git_remote_url: project.git_remote_url ?? null,
        scope: project.scope ?? null,
      })),
    });
  },
);

const BrowseHostSchema = z.string().max(255).regex(ALIAS_PATTERN).nullable();
const BrowseHostQuerySchema = z
  .union([z.literal(""), z.string().max(255).regex(ALIAS_PATTERN)])
  .optional();
const BrowseListingSchema = z
  .object({
    host: z.string().nullable(),
    path: z.string(),
    parent: z.string().nullable(),
    directories: z.array(z.string()),
  })
  .openapi("RemoteHostBrowse");

app.openapi(
  createRoute({
    method: "get",
    path: "/remote-hosts/{id}/browse",
    tags: ["System"],
    summary: "List folders on a remote ORC's machine or one of its SSH hosts",
    request: {
      params: idParam,
      query: z.object({ path: z.string().max(4096).default(""), host: BrowseHostQuerySchema }),
    },
    responses: {
      200: {
        description: "Folders",
        content: { "application/json": { schema: BrowseListingSchema } },
      },
    },
  }),
  async (c) => {
    const host = findRemoteHost(c.req.valid("param").id);
    const { path, host: alias } = c.req.valid("query");
    const query = new URLSearchParams({ path });
    if (alias) query.set("host", alias);
    return c.json(
      await remoteJson<z.infer<typeof BrowseListingSchema>>(
        host,
        `/terminals/browse?${query.toString()}`,
      ),
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/remote-hosts/{id}/browse/folders",
    tags: ["System"],
    summary: "Create a folder on a remote ORC's machine or one of its SSH hosts",
    request: {
      params: idParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              host: BrowseHostSchema,
              parent: z.string().min(1).max(4096),
              name: z.string().trim().min(1).max(255),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Created folder",
        content: { "application/json": { schema: z.object({ path: z.string() }) } },
      },
    },
  }),
  async (c) => {
    const host = findRemoteHost(c.req.valid("param").id);
    const { host: alias, parent, name } = c.req.valid("json");
    return c.json(
      await remoteJson<{ path: string }>(host, "/terminals/browse/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: alias, parent, name }),
      }),
      200,
    );
  },
);

export { app as remoteHostsRouter };
