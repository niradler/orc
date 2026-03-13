---
name: orc-dev-contributing
description: Use when developing or contributing to the ORC codebase itself — adding MCP tools, CLI commands, API routes, gateway features, or database schema changes. Trigger when working inside C:\Projects\orc, when adding new ORC features, debugging ORC internals, running ORC tests, or understanding the ORC package architecture.
---

# ORC Development Guide

ORC is a Bun monorepo with 8 packages. The data flow is: `Agent → MCP → API → DB`. The CLI also talks through the SDK to the API.

---

## Package Map

```
packages/
├── core/    @orc/core      Zod config, types (enums), logger, ULID IDs, errors
├── db/      @orc/db        Drizzle ORM schema + bun:sqlite client + migrations
├── api/     @orc/api       Hono REST API on :7700, OpenAPI spec, auth middleware
├── sdk/     @orc/sdk       Typed HTTP client (auto-generated from OpenAPI)
├── cli/     @orc/cli       Commander.js CLI binary (`orc`)
├── mcp/     @orc/mcp       MCP server (stdio), 21 tool definitions, search logic
├── runner/  @orc/runner    Job scheduler (croner), executor (Bun.spawn), file watcher
└── gateway/ @orc/gateway   Telegram + Slack gateway, agent runtime, direct commands
```

**Dependency direction**: `core ← db ← api ← sdk ← cli/mcp/runner/gateway`

---

## Dev Commands

```bash
# Install all dependencies
bun install

# Build all packages
bun run build

# Run the API server in dev mode
bun run dev:api

# Run the full daemon in dev mode (API + runner + gateway)
bun run dev

# Run the MCP server
bun run dev:mcp

# Run tests
bun test

# Run tests in a specific package
cd packages/api && bun test

# Regenerate SDK from OpenAPI spec (do after changing API routes)
bun run sdk:generate

# Type-check all packages
bun run typecheck

# Lint
bun run lint
```

---

## Adding a New MCP Tool

MCP tools live in `packages/mcp/src/tools.ts`. Follow this pattern:

### 1. Define the tool schema (in `tools.ts`)

```typescript
{
  name: "my_new_tool",
  description: "What it does, when agents should call it",
  inputSchema: zodToJsonSchema(
    z.object({
      required_param: z.string().describe("What this is"),
      optional_param: z.number().optional().describe("What this is"),
    })
  )
}
```

### 2. Add the execution case

```typescript
case "my_new_tool": {
  const { required_param, optional_param } = args as MyNewToolArgs;
  // ... implementation using packages/db or packages/api client
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
```

### 3. Export the type (in `packages/core/src/types.ts` if new entity)

### 4. Test the tool

```bash
# Start MCP server and test with a Claude session
orc mcp
# Or test via the API route that executes MCP tools:
curl -X POST http://localhost:7700/mcp-tool -H "Content-Type: application/json" \
  -d '{"tool": "my_new_tool", "args": {"required_param": "test"}}'
```

---

## Adding a New CLI Command

CLI commands live in `packages/cli/src/commands/`. Each command file registers subcommands.

### 1. Create command file

```typescript
// packages/cli/src/commands/mycommand.ts
import { Command } from "commander";
import { createClient } from "@orc/sdk";
import { globalOptions } from "../index.js";

export function registerMyCommand(program: Command) {
  const cmd = program.command("mycommand").description("Does X");

  cmd
    .command("list")
    .description("List all Xs")
    .action(async () => {
      const opts = program.opts();
      const client = createClient(opts);
      const items = await client.listXs();
      console.table(items);
    });
}
```

### 2. Register in `packages/cli/src/index.ts`

```typescript
import { registerMyCommand } from "./commands/mycommand.js";
registerMyCommand(program);
```

### 3. SDK may need updating if new API routes added

```bash
bun run sdk:generate  # Regenerates from OpenAPI spec
```

---

## Adding a New API Route

Routes live in `packages/api/src/routes/`. Hono + Zod validation.

```typescript
// packages/api/src/routes/things.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { db } from "@orc/db";
import { things } from "@orc/db/schema";

const app = new Hono();

app.get("/", async (c) => {
  const rows = await db.select().from(things);
  return c.json(rows);
});

app.post("/", zValidator("json", createThingSchema), async (c) => {
  const body = c.req.valid("json");
  const [row] = await db.insert(things).values(body).returning();
  return c.json(row, 201);
});

export { app as thingsRoute };
```

Register in `packages/api/src/server.ts`:
```typescript
app.route("/things", thingsRoute);
```

Then regenerate SDK: `bun run sdk:generate`

---

## Database Schema Changes

Schema: `packages/db/src/schema.ts` (Drizzle ORM).

```typescript
// Add a new table
export const things = sqliteTable("things", {
  id: text("id").primaryKey().$defaultFn(generateId),
  name: text("name").notNull(),
  created_at: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
```

Then migrate:
```bash
cd packages/db
bun run generate   # Generate migration file
bun run migrate    # Apply migration to ~/.orc/orc.db
```

**Rules:**
- All IDs are ULIDs (sortable, unique). Use `generateId` from `@orc/core/ids`.
- Timestamps are `integer` with `mode: "timestamp_ms"` (milliseconds since epoch).
- Use `text` for strings, `integer` for numbers/booleans/timestamps.
- Add indexes for any column used in WHERE clauses on large tables.

---

## Hook Development

Hooks are Bun TypeScript scripts in `hooks/`. They're standalone — they communicate with ORC via the API (HTTP) not MCP.

```typescript
// hooks/my-hook.ts
const ORC_API = process.env.ORC_API_BASE || "http://127.0.0.1:7700";

// Read stdin for hook context (Claude Code passes JSON)
const input = await Bun.stdin.text();
const event = JSON.parse(input);

// Call ORC API directly
await fetch(`${ORC_API}/sessions/event`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ type: "file", data: { path: event.tool_input?.path } })
});
```

Hooks must be fast (<500ms). Use fire-and-forget for non-critical operations.

---

## Key Type Locations

All core enums and types are in `packages/core/src/types.ts`:

```typescript
TaskStatus    // "todo" | "doing" | "review" | "done" | "blocked" | "cancelled" | "changes_requested"
TaskPriority  // "low" | "normal" | "high" | "critical"
MemoryType    // "rule" | "decision" | "discovery" | "event" | "fact"
MemoryImportance  // "low" | "normal" | "high" | "critical"
JobTriggerType    // "one-shot" | "cron" | "watch" | "webhook" | "manual" | "bridge-msg"
JobStatus         // "pending" | "running" | "success" | "failed" | "cancelled" | "skipped"
BridgePlatform    // "telegram" | "slack"
GatewayMode       // "direct" | "agent:claude" | "agent:codex" | "agent:cursor" | "job:..."
SessionEventType  // "file" | "task" | "rule" | "decision" | "git" | "env" | "error" | "plan" | "intent" | "subagent"
```

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forgetting `sdk:generate` after API changes | Always run `bun run sdk:generate` — CLI/MCP use the generated client |
| Using UUID instead of ULID | `import { generateId } from "@orc/core/ids"` — all IDs are ULIDs |
| Hardcoding port 7700 | Use `process.env.ORC_API_PORT` or config system |
| Direct DB access from CLI | CLI → SDK → API → DB; never skip layers |
| Forgetting to register new routes/commands | Routes: `server.ts`; Commands: `index.ts` |
| Large hook scripts | Keep hooks under 100 lines, fast, fire-and-forget for API calls |
