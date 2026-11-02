import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { globalConfigPath, updateGlobalConfig } from "@orc/core/config";
import {
  DEFAULT_MCP_PROMPTS,
  type McpPrompt,
  McpPromptListSchema,
  McpPromptSchema,
  parsePromptCommand,
  renderMcpPrompt,
} from "@orc/core/mcp-prompts";

/** Built-ins are seeded only when the table is first created, so deleting one sticks. */
export function installMcpPrompts(sqlite: Database): void {
  const exists = sqlite
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_prompts'")
    .get();
  if (exists) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE mcp_prompts (
        name TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        position INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    new McpPromptStore(sqlite).replace(DEFAULT_MCP_PROMPTS);
  })();
}

/**
 * Prompts lived in config.json `mcp.prompts` until 0.1.57. Moves them into the table once, keeps
 * built-ins the saved list lacked, then drops the key so the file no longer shadows the table.
 */
export function importConfigMcpPrompts(sqlite: Database): void {
  const path = globalConfigPath();
  if (!existsSync(path)) return;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { mcp?: { prompts?: unknown } };
  if (!Array.isArray(raw.mcp?.prompts)) return;
  const saved = (raw.mcp.prompts as Record<string, unknown>[]).map(
    ({ include_ui_catalog, ...prompt }) =>
      McpPromptSchema.parse({
        ...prompt,
        content: include_ui_catalog ? `${prompt.content}\n\n{{ui_catalog}}` : prompt.content,
      }),
  );
  const names = new Set(saved.map((prompt) => prompt.name));
  new McpPromptStore(sqlite).replace([
    ...saved,
    ...DEFAULT_MCP_PROMPTS.filter((prompt) => !names.has(prompt.name)),
  ]);
  updateGlobalConfig((config) => {
    delete (config.mcp as Record<string, unknown> | undefined)?.prompts;
  });
}

export class McpPromptStore {
  constructor(private readonly sqlite: Database) {}

  list(): McpPrompt[] {
    return this.sqlite
      .query<McpPrompt, []>(
        "SELECT name, title, description, content FROM mcp_prompts ORDER BY position, name",
      )
      .all();
  }

  get(name: string): McpPrompt | null {
    return (
      this.sqlite
        .query<McpPrompt, [string]>(
          "SELECT name, title, description, content FROM mcp_prompts WHERE name=?",
        )
        .get(name) ?? null
    );
  }

  /** Turns a chat message like `/create-task fix login` into its saved prompt; anything else is kept. */
  expand(message: string): string {
    const command = parsePromptCommand(message);
    const prompt = command && this.get(command.name);
    return command && prompt ? renderMcpPrompt(prompt, command.request) : message;
  }

  /** The settings form edits the list as a whole; order is kept as given. */
  replace(prompts: McpPrompt[]): McpPrompt[] {
    const parsed = McpPromptListSchema.parse(prompts);
    this.sqlite.transaction(() => {
      this.sqlite.exec("DELETE FROM mcp_prompts");
      const insert = this.sqlite.prepare(
        "INSERT INTO mcp_prompts (name, title, description, content, position) VALUES (?, ?, ?, ?, ?)",
      );
      parsed.forEach((prompt, index) => {
        insert.run(prompt.name, prompt.title, prompt.description, prompt.content, index);
      });
    })();
    return this.list();
  }
}
