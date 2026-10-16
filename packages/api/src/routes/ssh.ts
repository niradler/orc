import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { hostClaudeLoggedIn } from "@orc/agent-runtime";
import { configuredApiSecret, loadConfig, updateGlobalConfig } from "@orc/core/config";
import { ConflictError, ValidationError } from "@orc/core/errors";
import {
  ALIAS_PATTERN,
  ensureSshMaster,
  execHostFor,
  listSshConfigHosts,
  probeHost,
  retireSshMaster,
  sshBinary,
} from "@orc/core/exec-host";
import { refreshConfiguredSessionAdapters } from "../session-watcher.js";

const app = new OpenAPIHono();

const SshStateSchema = z
  .object({
    host: z.string().nullable().openapi({ description: "Selected Host alias; null runs locally" }),
    remote_port: z.number().int().nullable().openapi({
      description: "Port the reverse tunnel opens on the host so agents there reach orc",
    }),
    hosts: z.array(z.string()).openapi({ description: "Host aliases from ~/.ssh/config" }),
    locked: z.boolean().openapi({
      description: "ORC_SSH_HOST is set, so the selection is fixed",
    }),
    supported: z.boolean(),
    unsupported_reason: z.string().nullable(),
    secret_set: z.boolean().openapi({
      description: "Whether API bearer authentication is configured",
    }),
  })
  .openapi("SshState");

const SshTestSchema = z
  .object({
    ok: z.boolean(),
    host: z.string(),
    error: z.string().nullable(),
    os: z.string().nullable(),
    home: z.string().nullable(),
    shell: z.string().nullable(),
    binaries: z.record(z.string(), z.string().nullable()),
    claude_logged_in: z.boolean().nullable().openapi({
      description: "claude auth status on the host; null when unknown or claude is missing",
    }),
    api_key_forwarded: z.boolean().openapi({
      description: "ANTHROPIC_API_KEY is set where orc runs and will be forwarded",
    }),
  })
  .openapi("SshTest");

function platformSupport(): {
  supported: boolean;
  unsupported_reason: string | null;
} {
  try {
    sshBinary();
    return { supported: true, unsupported_reason: null };
  } catch (err) {
    return {
      supported: false,
      unsupported_reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function sshState() {
  const config = loadConfig();
  let hosts: string[] = [];
  try {
    hosts = listSshConfigHosts();
  } catch {}
  return {
    host: config.ssh.host ?? null,
    remote_port: config.ssh.remote_port ?? null,
    hosts,
    locked: process.env.ORC_SSH_HOST !== undefined,
    ...platformSupport(),
    secret_set: Boolean(configuredApiSecret(config.api.secret)),
  };
}

const getRoute = createRoute({
  method: "get",
  path: "/ssh",
  tags: ["System"],
  summary: "SSH execution host: selection and the hosts ~/.ssh/config offers",
  responses: {
    200: {
      description: "SSH state",
      content: { "application/json": { schema: SshStateSchema } },
    },
  },
});

app.openapi(getRoute, (c) => c.json(sshState()));

const putRoute = createRoute({
  method: "put",
  path: "/ssh",
  tags: ["System"],
  summary: "Select the SSH host every agent, git and shell action runs on",
  description:
    "Persists ssh.host to ~/.orc/config.json. Null switches back to local. Terminals already " +
    "open keep their host; new work uses the new one.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            host: z.string().regex(ALIAS_PATTERN).nullable(),
            remote_port: z.number().int().min(1).max(65535).nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "SSH state",
      content: { "application/json": { schema: SshStateSchema } },
    },
  },
});

app.openapi(putRoute, async (c) => {
  const body = c.req.valid("json");
  const before = loadConfig();
  if (process.env.ORC_SSH_HOST !== undefined)
    throw new ConflictError("ORC_SSH_HOST is set in orc's environment; unset it to choose here");
  if (body.host) {
    const support = platformSupport();
    if (!support.supported) throw new ValidationError(support.unsupported_reason ?? "unsupported");
  }
  const after = updateGlobalConfig((raw) => {
    const ssh = { ...((raw.ssh as Record<string, unknown> | undefined) ?? {}) };
    if (body.host) ssh.host = body.host;
    else delete ssh.host;
    if (body.remote_port) ssh.remote_port = body.remote_port;
    else if (body.remote_port === null) delete ssh.remote_port;
    raw.ssh = ssh;
  });
  if ((after.ssh.host ?? null) !== body.host)
    throw new ConflictError("ssh.host is overridden by ./.orc/config.json in orc's working folder");
  if (before.ssh.host && before.ssh.host !== after.ssh.host) await retireSshMaster(before.ssh.host);
  refreshConfiguredSessionAdapters();
  return c.json(sshState());
});

const testRoute = createRoute({
  method: "post",
  path: "/ssh/test",
  tags: ["System"],
  summary: "Connect to an SSH host and report what it can run",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            host: z.string().regex(ALIAS_PATTERN).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Test result",
      content: { "application/json": { schema: SshTestSchema } },
    },
  },
});

app.openapi(testRoute, async (c) => {
  const alias = c.req.valid("json").host ?? loadConfig().ssh.host;
  if (!alias) throw new ValidationError("No SSH host selected");
  const host = execHostFor(alias);
  if (host.kind !== "ssh") throw new ValidationError("No SSH host selected");
  const apiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  try {
    await ensureSshMaster(host);
    const probe = await probeHost(host, true);
    const claude = probe.binaries.claude;
    return c.json({
      ok: true,
      host: alias,
      error: null,
      os: probe.os,
      home: probe.home,
      shell: probe.shell,
      binaries: probe.binaries,
      claude_logged_in: claude ? await hostClaudeLoggedIn(host, claude, true) : null,
      api_key_forwarded: apiKey,
    });
  } catch (err) {
    return c.json({
      ok: false,
      host: alias,
      error: err instanceof Error ? err.message : String(err),
      os: null,
      home: null,
      shell: null,
      binaries: {},
      claude_logged_in: null,
      api_key_forwarded: apiKey,
    });
  }
});

export { app as sshRouter };
