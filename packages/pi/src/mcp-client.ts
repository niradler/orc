import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpMode, PorcConfig } from "./config.js";
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

const META_TOOLS = new Set(["tool_search", "tool_describe", "tool_invoke"]);

export class OrcMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrcMcpError";
  }
}

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

/**
 * Small MCP client for extension commands so they use the same ORC tools and
 * schemas as the model. Meta mode is normalized to `tool_invoke`.
 */
export class OrcMcpClient {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private closed = false;

  constructor(
    private readonly config: Pick<
      PorcConfig,
      "apiBase" | "mode" | "transport" | "command" | "secret" | "timeoutMs"
    >,
    private readonly sessionId: string | undefined,
    private readonly cwd: string,
  ) {}

  private async open(): Promise<Client> {
    const transport =
      this.config.transport === "http"
        ? new StreamableHTTPClientTransport(new URL(buildMcpUrl(this.config)), {
            ...(this.config.secret
              ? { requestInit: { headers: { Authorization: `Bearer ${this.config.secret}` } } }
              : {}),
          })
        : new StdioClientTransport({
            command: this.config.command,
            args: ["mcp", "--mode", this.config.mode],
            cwd: this.cwd,
            env: {
              ...inheritedEnv(),
              ORC_API_BASE: this.config.apiBase,
              ...(this.config.secret ? { ORC_API_SECRET: this.config.secret } : {}),
              ...(this.sessionId ? { ORC_SESSION_ID: this.sessionId } : {}),
            },
            stderr: "ignore",
          });
    const client = new Client({ name: "porc", version: "0.1.0" }, { capabilities: {} });
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
    const forwarded =
      this.config.mode === "meta" && !META_TOOLS.has(name)
        ? { name: "tool_invoke", arguments: { name, arguments: args } }
        : { name, arguments: args };
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

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}

export function normalizeMode(mode: McpMode): McpMode {
  return mode;
}
