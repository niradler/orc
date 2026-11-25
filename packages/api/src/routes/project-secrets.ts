import { createRoute, z } from "@hono/zod-openapi";
import { changes } from "@orc/core/changes";
import { loadConfig } from "@orc/core/config";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import { expandHostPath, hostBinary, hostExec, hostIsDirectory } from "@orc/core/exec-host";
import {
  type ProjectSecretCheck,
  ProjectSecretCheckResultSchema,
  ProjectSecretCheckSchema,
  ProjectSecretMetadataSchema,
  ProjectSecretNameSchema,
  ProjectSecretRotateSchema,
  ProjectSecretUpsertSchema,
} from "@orc/core/project-secrets";
import { getRegisteredSecrets, redactRegisteredSecrets } from "@orc/core/secret-redactor";
import { getSqlite } from "@orc/db/client";
import { ProjectSecretStore } from "@orc/db/project-secrets";
import { bodyLimit } from "hono/body-limit";
import { auditActor } from "../lib/audit-actor.js";
import { commandShell } from "../lib/command-shell.js";
import { createRouter } from "../lib/router.js";
import { selectedTerminalHost } from "../terminals/host.js";
import { launchDeps } from "../terminals/service.js";

const app = createRouter();
app.use("/projects/*/secrets", bodyLimit({ maxSize: 80000 }));
app.use("/projects/*/secrets/*", bodyLimit({ maxSize: 80000 }));

const projectParam = z.object({ id: z.string().min(1).max(128) });
const secretParam = z.object({
  id: z.string().min(1).max(128),
  name: ProjectSecretNameSchema,
});

function store(): ProjectSecretStore {
  return new ProjectSecretStore(getSqlite());
}

const CHECK_EXEC = `import {spawn,spawnSync} from "node:child_process";
const data = await Bun.stdin.json();
const secrets = [...new Set(data.secrets.filter(Boolean))].sort((a,b) => b.length-a.length);
const redact = text => { for (const secret of secrets) text = text.split(secret).join("[REDACTED]"); return text; };
const read = async stream => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, {stream:true});
    if (text.length > 16000) { text = text.slice(0, 16000); break; }
  }
  text += decoder.decode();
  return redact(text).slice(0, 4000);
};
try {
  const env = {...process.env, [data.envName]: data.secretValue};
  const [shell, ...args] = data.shell;
  const windows = process.platform === "win32";
  const proc = spawn(shell, [...args, data.script], {
    cwd: data.cwd,
    env,
    detached: !windows,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", code => resolve(code ?? -1));
  });
  const stop = () => {
    if (!proc.pid) return;
    if (windows) spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {windowsHide:true, stdio:"ignore", timeout:5000});
    else { try { process.kill(-proc.pid, "SIGKILL"); } catch {} }
  };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, data.timeout * 1000);
  let stdout, stderr, exit_code;
  try { [stdout, stderr, exit_code] = await Promise.all([read(proc.stdout), read(proc.stderr), exited]); }
  catch (err) { stop(); throw err; }
  finally { clearTimeout(timer); }
  if (timedOut) { exit_code = -1; stderr = "Validation command timed out"; }
  console.log(JSON.stringify({ exit_code, stdout, stderr }));
} catch {
  console.log(JSON.stringify({ exit_code: -1, stdout: "", stderr: "Validation command could not complete" }));
}`;

async function runCheck(
  projectId: string,
  secretValue: string,
  check: ProjectSecretCheck,
): Promise<{ ok: boolean; mode: "http" | "command"; status: number | null; message: string }> {
  if (check.type === "http") {
    try {
      const response = await fetch(check.url, {
        method: check.method,
        headers: {
          [check.header_name]: `${check.value_prefix}${secretValue}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(check.timeout_seconds * 1000),
      });
      const expected = check.expected_status;
      const ok = expected
        ? expected.includes(response.status)
        : response.status >= 200 && response.status < 300;
      return {
        ok,
        mode: "http",
        status: response.status,
        message: ok
          ? `HTTP ${response.status} succeeded.`
          : `HTTP ${response.status} did not match expected status.`,
      };
    } catch (error) {
      const reason = redactRegisteredSecrets(
        error instanceof Error ? error.message : "HTTP check failed",
        [secretValue],
      );
      return {
        ok: false,
        mode: "http",
        status: null,
        message: reason.slice(0, 300),
      };
    }
  }

  const config = loadConfig();
  const host = selectedTerminalHost(config, check.host);
  const projectScope = getSqlite()
    .query<{ scope: string | null }, [string]>("SELECT scope FROM projects WHERE id = ?")
    .get(projectId)?.scope;
  const rawCwd = check.cwd ?? projectScope ?? process.cwd();
  const cwd = await expandHostPath(host, rawCwd);
  if (!(await hostIsDirectory(host, cwd))) {
    throw new ValidationError("The validation command folder is unavailable on the selected host");
  }
  const bun = await hostBinary(host, "bun");
  if (!bun) throw new ValidationError("Command validation requires Bun on the selected host");
  const shell = commandShell(await launchDeps(config, host));
  const secrets = [...new Set([secretValue, ...getRegisteredSecrets()])];
  const result = await hostExec(host, [bun, "--eval", CHECK_EXEC], {
    input: JSON.stringify({
      script: check.script,
      cwd,
      shell,
      envName: check.env_name,
      secretValue,
      secrets,
      timeout: check.timeout_seconds,
    }),
    timeoutMs: (check.timeout_seconds + 10) * 1000,
    login: false,
  });
  if (result.code !== 0) {
    return {
      ok: false,
      mode: "command",
      status: result.code ?? -1,
      message: "Validation command transport failed.",
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      exit_code: number;
      stdout: string;
      stderr: string;
    };
    const ok = parsed.exit_code === 0;
    const detail = redactRegisteredSecrets(
      (ok ? parsed.stdout : parsed.stderr || parsed.stdout).trim(),
      [secretValue],
    );
    return {
      ok,
      mode: "command",
      status: parsed.exit_code,
      message: detail
        ? detail.slice(0, 300)
        : ok
          ? "Validation command exited with code 0."
          : `Validation command failed with exit code ${parsed.exit_code}.`,
    };
  } catch {
    return {
      ok: false,
      mode: "command",
      status: -1,
      message: "Validation command returned an unreadable result.",
    };
  }
}

app.openapi(
  createRoute({
    method: "get",
    path: "/projects/{id}/secrets",
    tags: ["Project secrets"],
    summary: "List project secret metadata (never returns values)",
    request: { params: projectParam },
    responses: {
      200: {
        description: "Project secret metadata",
        content: {
          "application/json": {
            schema: z.object({ secrets: z.array(ProjectSecretMetadataSchema) }),
          },
        },
      },
    },
  }),
  (c) => {
    const { id } = c.req.valid("param");
    c.header("Cache-Control", "no-store");
    return c.json({ secrets: store().list(id) }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/projects/{id}/secrets",
    tags: ["Project secrets"],
    summary: "Create or rotate a project secret",
    request: {
      params: projectParam,
      body: { content: { "application/json": { schema: ProjectSecretUpsertSchema } } },
    },
    responses: {
      200: {
        description: "Rotated project secret metadata",
        content: { "application/json": { schema: ProjectSecretMetadataSchema } },
      },
      201: {
        description: "Created project secret metadata",
        content: { "application/json": { schema: ProjectSecretMetadataSchema } },
      },
    },
  }),
  (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = store().upsert(id, body, auditActor(c));
    changes.publish("project-secrets");
    c.header("Cache-Control", "no-store");
    return c.json(result.secret, result.created ? 201 : 200);
  },
);

app.openapi(
  createRoute({
    method: "put",
    path: "/projects/{id}/secrets/{name}",
    tags: ["Project secrets"],
    summary: "Rotate a project secret value or update its metadata",
    request: {
      params: secretParam,
      body: { content: { "application/json": { schema: ProjectSecretRotateSchema } } },
    },
    responses: {
      200: {
        description: "Updated project secret metadata",
        content: { "application/json": { schema: ProjectSecretMetadataSchema } },
      },
    },
  }),
  (c) => {
    const { id, name } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = store().rotate(id, name, body, auditActor(c));
    changes.publish("project-secrets");
    c.header("Cache-Control", "no-store");
    return c.json(updated, 200);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/projects/{id}/secrets/{name}",
    tags: ["Project secrets"],
    summary: "Delete a project secret",
    request: { params: secretParam },
    responses: {
      204: { description: "Deleted" },
    },
  }),
  (c) => {
    const { id, name } = c.req.valid("param");
    store().delete(id, name, auditActor(c));
    changes.publish("project-secrets");
    c.header("Cache-Control", "no-store");
    return new Response(null, { status: 204 });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/projects/{id}/secrets/{name}/check",
    tags: ["Project secrets"],
    summary: "Validate a project secret reference without revealing its value",
    request: {
      params: secretParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({ check: ProjectSecretCheckSchema.optional() }).strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Validation result without secret values",
        content: { "application/json": { schema: ProjectSecretCheckResultSchema } },
      },
    },
  }),
  async (c) => {
    const { id, name } = c.req.valid("param");
    const secrets = store();
    const metadata = secrets.getMetadata(id, name);
    let overrideCheck: ProjectSecretCheck | undefined;
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === "object" && "check" in raw && raw.check !== undefined) {
        overrideCheck = ProjectSecretCheckSchema.parse(raw.check);
      }
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
    }

    const value = secrets.resolveValue(id, name);
    if (value === null) throw new NotFoundError("Project secret", metadata.reference);

    const activeCheck = overrideCheck ?? metadata.check;
    const outcome = activeCheck
      ? await runCheck(id, value, activeCheck)
      : {
          ok: true,
          mode: "stored" as const,
          status: null,
          message: "Secret is stored and decryptable.",
        };

    secrets.recordCheck(
      id,
      name,
      { mode: outcome.mode, ok: outcome.ok, status: outcome.status },
      auditActor(c),
    );
    changes.publish("project-secrets");
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        ok: outcome.ok,
        reference: metadata.reference,
        mode: outcome.mode,
        status: outcome.status,
        message: outcome.message,
        checked_at: new Date().toISOString(),
      },
      200,
    );
  },
);

export { app as projectSecretsRouter };
