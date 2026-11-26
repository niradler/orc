import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  ElicitRequestSchema,
  GetTaskResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PorcConfig } from "./config.js";
import { buildMcpUrl } from "./mcp.js";

export type OrcToolResult = {
  text: string;
  isError: boolean;
  raw: unknown;
};

export type OrcToolInfo = {
  name: string;
  description: string;
};

/** Durable MCP task handle returned by a task-augmented tool call. */
export type OrcTask = {
  taskId: string;
  status: string;
  ttl?: number | null | undefined;
  createdAt?: string | undefined;
  lastUpdatedAt?: string | undefined;
  pollInterval?: number | undefined;
  statusMessage?: string | undefined;
};

export type OrcTaskOptions = {
  /** Requested retention in milliseconds; the server may clamp it. */
  ttlMs?: number | undefined;
  /** Poll cadence while waiting (default: server pollInterval or 1000ms). */
  pollMs?: number | undefined;
  /** Overall wait budget for callAndWait (default 10 minutes). */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

const TERMINAL_TASK = new Set(["completed", "failed", "cancelled"]);
const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
const SKILL_ENTRY_SCHEMA = z.object({
  uri: z.string(),
  frontmatter: z.record(z.string(), z.unknown()).default({}),
  resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })),
});
const SKILLS_LIST_SCHEMA = z.object({
  skills: z.array(SKILL_ENTRY_SCHEMA),
  nextCursor: z.string().optional(),
});
const SKILLS_GET_SCHEMA = z.object({
  skill: SKILL_ENTRY_SCHEMA,
});

export type OrcElicitationHandler = (params: {
  message: string;
  requestedSchema: Record<string, unknown>;
}) => Promise<{
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]> | undefined;
}>;

const META_TOOLS = new Set(["tool_search", "tool_describe", "tool_invoke", "tool_execute"]);

export class OrcMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrcMcpError";
  }
}

export type OrcMcpClientOptions = {
  /** Test/embedding seam: resolve an already-connected client instead of a transport. */
  client?: (() => Promise<Client>) | undefined;
};

function timeout<T>(value: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OrcMcpError(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([value, limit]).finally(() => clearTimeout(timer));
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      if (item && typeof item === "object" && "text" in item) {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      }
      return [];
    })
    .join("\n");
}

function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

function requestOptions(timeoutMs: number, signal?: AbortSignal) {
  return { timeout: timeoutMs, ...(signal ? { signal } : {}) };
}

function sleepUntil(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class OrcMcpClient {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private closed = false;

  constructor(
    private readonly config: Pick<
      PorcConfig,
      "apiBase" | "transport" | "command" | "secret" | "timeoutMs"
    >,
    private readonly sessionId: string | undefined,
    private readonly cwd: string,
    private readonly onElicitation?: OrcElicitationHandler | undefined,
    private readonly options: OrcMcpClientOptions = {},
  ) {}

  private async open(): Promise<Client> {
    if (this.options.client) return this.options.client();
    const headers: Record<string, string> = {};
    if (this.config.secret) headers.Authorization = `Bearer ${this.config.secret}`;
    if (this.sessionId) headers["X-ORC-Session"] = this.sessionId;
    const transport =
      this.config.transport === "http"
        ? new StreamableHTTPClientTransport(
            new URL(buildMcpUrl(this.config.apiBase, undefined, this.sessionId)),
            {
              ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
            },
          )
        : new StdioClientTransport({
            command: this.config.command,
            args: ["mcp", "--mode", "meta"],
            cwd: this.cwd,
            env: {
              ...inheritedEnv(),
              ORC_API_BASE: this.config.apiBase,
              ...(this.config.secret ? { ORC_API_SECRET: this.config.secret } : {}),
              ...(this.sessionId ? { ORC_SESSION_ID: this.sessionId } : {}),
            },
            stderr: "ignore",
          });
    const client = new Client(
      { name: "porc", version: "0.1.0" },
      { capabilities: this.onElicitation ? { elicitation: { form: {} } } : {} },
    );
    if (this.onElicitation) {
      const handler = this.onElicitation;
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        const params = request.params as {
          message: string;
          requestedSchema?: Record<string, unknown>;
        };
        return handler({
          message: params.message,
          requestedSchema: params.requestedSchema ?? {},
        });
      });
    }
    await timeout(client.connect(transport), this.config.timeoutMs, "ORC MCP connect");
    return client;
  }

  async connect(): Promise<Client> {
    if (this.closed) throw new OrcMcpError("ORC MCP client is closed");
    if (this.client) return this.client;
    this.connecting ??= this.open()
      .then((client) => {
        this.client = client;
        return client;
      })
      .catch((err: unknown) => {
        this.connecting = undefined;
        throw err;
      });
    return this.connecting;
  }

  async listTools(): Promise<OrcToolInfo[]> {
    const client = await this.connect();
    const result = await timeout(client.listTools(), this.config.timeoutMs, "ORC MCP tool list");
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
    }));
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<OrcToolResult> {
    const client = await this.connect();
    const forwarded = META_TOOLS.has(name)
      ? { name, arguments: args }
      : { name: "tool_invoke", arguments: { name, arguments: args } };
    const result = await timeout(
      client.callTool(forwarded, undefined, { timeout: this.config.timeoutMs }),
      this.config.timeoutMs,
      `ORC tool ${name}`,
    );
    return {
      text: textOf(result.content),
      isError: result.isError === true,
      raw: result,
    };
  }

  /** Task-augmented tool call: returns a durable handle instead of blocking. */
  async callTask(
    name: string,
    args: Record<string, unknown> = {},
    options: OrcTaskOptions = {},
  ): Promise<OrcTask> {
    const client = await this.connect();
    const forwarded = META_TOOLS.has(name)
      ? { name, arguments: args }
      : { name: "tool_invoke", arguments: { name, arguments: args } };
    const result = await timeout(
      client.request(
        {
          method: "tools/call",
          params: {
            ...forwarded,
            task: options.ttlMs === undefined ? {} : { ttl: options.ttlMs },
          },
        },
        CreateTaskResultSchema,
        requestOptions(this.config.timeoutMs, options.signal),
      ),
      this.config.timeoutMs,
      `ORC task ${name}`,
    );
    return result.task;
  }

  async taskStatus(taskId: string, options: OrcTaskOptions = {}): Promise<OrcTask> {
    const client = await this.connect();
    return timeout(
      client.request(
        { method: "tasks/get", params: { taskId } },
        GetTaskResultSchema,
        requestOptions(this.config.timeoutMs, options.signal),
      ),
      this.config.timeoutMs,
      `ORC task ${taskId}`,
    );
  }

  async cancelTask(taskId: string): Promise<void> {
    const client = await this.connect();
    await timeout(
      client.request({ method: "tasks/cancel", params: { taskId } }, CancelTaskResultSchema, {
        timeout: this.config.timeoutMs,
      }),
      this.config.timeoutMs,
      `ORC task cancel ${taskId}`,
    );
  }

  async waitForTask(taskId: string, options: OrcTaskOptions = {}): Promise<OrcToolResult> {
    const client = await this.connect();
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    if (options.signal?.aborted) throw new OrcMcpError(`ORC task ${taskId} wait aborted`);
    let status = await this.taskStatus(taskId, options);
    while (!TERMINAL_TASK.has(status.status)) {
      if (options.signal?.aborted) throw new OrcMcpError(`ORC task ${taskId} wait aborted`);
      if (Date.now() >= deadline) {
        throw new OrcMcpError(
          `ORC task ${taskId} is still ${status.status} after ${options.timeoutMs ?? 600_000}ms`,
        );
      }
      const step = Math.min(
        options.pollMs ?? status.pollInterval ?? 1000,
        Math.max(1, deadline - Date.now()),
      );
      await sleepUntil(step, options.signal);
      if (options.signal?.aborted) throw new OrcMcpError(`ORC task ${taskId} wait aborted`);
      status = await this.taskStatus(taskId, options);
    }
    if (status.status === "failed")
      throw new OrcMcpError(status.statusMessage || `ORC task ${taskId} failed`);
    if (status.status === "cancelled")
      throw new OrcMcpError(status.statusMessage || `ORC task ${taskId} was cancelled`);
    const result = await timeout(
      client.request(
        { method: "tasks/result", params: { taskId } },
        CallToolResultSchema,
        requestOptions(this.config.timeoutMs, options.signal),
      ),
      this.config.timeoutMs,
      `ORC task result ${taskId}`,
    );
    return {
      text: textOf(result.content),
      isError: result.isError === true,
      raw: result,
    };
  }

  /** Start a task and wait for it, for consumers that do not manage handles. */
  async callAndWait(
    name: string,
    args: Record<string, unknown> = {},
    options: OrcTaskOptions = {},
  ): Promise<OrcToolResult> {
    const task = await this.callTask(name, args, options);
    return this.waitForTask(task.taskId, options);
  }

  /** Whether the server advertises Skills over MCP (io.modelcontextprotocol/skills). */
  async hasSkillsExtension(): Promise<boolean> {
    const capabilities = (await this.connect()).getServerCapabilities() as
      | { extensions?: Record<string, unknown> }
      | undefined;
    return Boolean(capabilities?.extensions?.[SKILLS_EXTENSION_ID]);
  }

  async listSkills(
    options: { q?: string | undefined; limit?: number | undefined } = {},
  ): Promise<OrcToolResult> {
    if (!(await this.hasSkillsExtension())) {
      return this.call("skill_list", {
        ...(options.q ? { q: options.q } : {}),
        limit: options.limit ?? 20,
      });
    }
    const client = await this.connect();
    const limit = options.limit ?? 20;
    const query = options.q?.trim().toLowerCase();
    const skills: { name: string; description: string; uri: string }[] = [];
    let cursor: string | undefined;
    do {
      const page: z.infer<typeof SKILLS_LIST_SCHEMA> = await timeout(
        client.request(
          { method: "skills/list", params: cursor ? { cursor } : {} },
          SKILLS_LIST_SCHEMA,
          { timeout: this.config.timeoutMs },
        ),
        this.config.timeoutMs,
        "ORC skills/list",
      );
      for (const skill of page.skills) {
        const name = String(
          skill.frontmatter.name ??
            skill.uri.replace(/^skill:\/\//, "").replace(/\/SKILL\.md$/, ""),
        );
        const description = String(skill.frontmatter.description ?? "");
        if (query && !`${name} ${description}`.toLowerCase().includes(query)) continue;
        skills.push({ name, description, uri: skill.uri });
        if (skills.length >= limit) break;
      }
      cursor = page.nextCursor;
    } while (cursor && skills.length < limit);
    return {
      text:
        skills
          .map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`)
          .join("\n") || "No skills.",
      isError: false,
      raw: skills,
    };
  }

  async readSkill(
    name: string,
    options: { ref?: string | undefined } = {},
  ): Promise<OrcToolResult> {
    if (!(await this.hasSkillsExtension()))
      return this.call("skill_read", {
        name,
        ...(options.ref ? { ref: options.ref } : {}),
      });
    const client = await this.connect();
    const cleanName = name.replace(/^\/+|\/+$/g, "");
    const cleanRef = (options.ref ?? "SKILL.md").replace(/^\/+/, "");
    const entryUri = `skill://${cleanName}/SKILL.md`;
    const uri = `skill://${cleanName}/${cleanRef}`;
    const entry = await timeout(
      client.request({ method: "skills/get", params: { uri: entryUri } }, SKILLS_GET_SCHEMA, {
        timeout: this.config.timeoutMs,
      }),
      this.config.timeoutMs,
      `ORC skill manifest ${name}`,
    );
    const manifest = entry.skill.resources.find((file) => file.uri === uri);
    if (!manifest) throw new OrcMcpError(`Skill resource missing from manifest: ${uri}`);
    const result = await timeout(
      client.request({ method: "resources/read", params: { uri } }, ReadResourceResultSchema, {
        timeout: this.config.timeoutMs,
      }),
      this.config.timeoutMs,
      `ORC skill ${name}`,
    );
    const item = result.contents[0];
    if (!item) throw new OrcMcpError(`Empty skill resource response: ${uri}`);
    const bytes =
      "blob" in item && typeof item.blob === "string"
        ? Buffer.from(item.blob, "base64")
        : Buffer.from("text" in item && typeof item.text === "string" ? item.text : "", "utf8");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.length !== manifest.size || digest !== manifest.digest) {
      throw new OrcMcpError(`Skill resource failed integrity check: ${uri}`);
    }
    const text = result.contents
      .map((entryItem) =>
        "text" in entryItem && typeof entryItem.text === "string" ? entryItem.text : "",
      )
      .filter(Boolean)
      .join("\n");
    return { text, isError: false, raw: result };
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}
