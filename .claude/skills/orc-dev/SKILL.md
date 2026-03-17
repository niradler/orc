---
name: orc-dev
description: Use when developing or contributing to the ORC codebase itself — adding MCP tools, CLI commands, API routes, gateway features, database schema changes, or hook scripts. Trigger when working inside C:\Projects\orc, when adding new ORC features, debugging ORC internals, running ORC tests, or understanding the ORC package architecture. Also trigger when the user asks about ORC's internal structure, build system, or how to extend it.
---

# ORC Development Guide

ORC is a Bun monorepo with 10 packages. Data flow: `Agent → MCP → API → DB`. CLI goes via `CLI → SDK → API → DB`.

---

## Package Map

```
packages/
├── core/     @orc/core      Config (Zod), types, logger, ULID IDs, errors
├── db/       @orc/db        Drizzle ORM schema + bun:sqlite (~/.orc/orc.db)
├── api/      @orc/api       Hono REST API + OpenAPI spec (:7700)
├── sdk/      @orc/sdk       Typed HTTP client (auto-generated from OpenAPI)
├── cli/      @orc/cli       Commander CLI binary (`orc`)
├── mcp/      @orc/mcp       MCP server (stdio), 42 tools
├── runner/   @orc/runner    Job executor + cron/watch/one-shot scheduler
├── gateway/  @orc/gateway   Telegram + Slack gateway, agent runtime, permissions
└── tui/      @orc/tui       Terminal UI (React + OpenTUI, in-progress)
```

**Dependency direction**: `core ← db ← api ← sdk ← cli/mcp/runner/gateway`

---

## Dev Commands

```bash
bun install          # Install all workspace deps
bun dev              # API + CLI in dev/watch mode
bun run dev:api      # API server only
bun run dev:mcp      # MCP server only
bun build            # Build all packages
bun test             # Run all tests
bun typecheck        # Type-check all packages
bun check            # Biome lint + format (auto-fix)
bun db:push          # Push Drizzle schema to SQLite (dev)
bun db:generate      # Generate migration files
bun sdk:generate     # Regenerate SDK from OpenAPI (API must be running)
bun run tui          # Run TUI in hot mode
```

---

## Adding a New MCP Tool

MCP tools live in `packages/mcp/src/tools.ts`. Currently 42 tools across 6 domains.

### 1. Define the tool schema

```typescript
{
  name: "my_new_tool",
  description: "What it does, when agents should call it",
  inputSchema: zodToJsonSchema(
    z.object({
      required_param: z.string().describe("What this is"),
      optional_param: z.number().optional().describe("What this is"),
      project: z.string().optional().describe("Project name (readable, not ULID)")
    })
  )
}
```

### 2. Add the execution case

```typescript
case "my_new_tool": {
  const { required_param, optional_param } = args as MyNewToolArgs;
  // Implementation using @orc/db or API client
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
```

### 3. Add corresponding API route if persistence is needed

### 4. Regenerate SDK: `bun sdk:generate` (API must be running)

---

## Adding a New CLI Command

Commands live in `packages/cli/src/commands/`. Each file registers subcommands.

```typescript
// packages/cli/src/commands/mycommand.ts
import { Command } from "commander";
import { createClient } from "@orc/sdk";

export function registerMyCommand(program: Command) {
  const cmd = program.command("mycommand").description("Does X");

  cmd.command("list").description("List all Xs").action(async () => {
    const opts = program.opts();
    const client = createClient(opts);
    const items = await client.listXs();
    console.table(items);
  });
}
```

Register in `packages/cli/src/index.ts`:
```typescript
import { registerMyCommand } from "./commands/mycommand.js";
registerMyCommand(program);
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

Register in `packages/api/src/server.ts`, then `bun sdk:generate`.

---

## Database Schema Changes

Schema: `packages/db/src/schema.ts` (Drizzle ORM). 13 tables currently.

```typescript
export const things = sqliteTable("things", {
  id: text("id").primaryKey().$defaultFn(generateId),
  name: text("name").notNull(),
  created_at: integer("created_at", { mode: "timestamp_ms" })
    .notNull().$defaultFn(() => new Date()),
});
```

Then: `bun db:generate && bun db:push`

**Rules:**
- All IDs are ULIDs — `import { generateId } from "@orc/core/ids"`
- Timestamps: `integer` with `mode: "timestamp_ms"`
- Add indexes for any column used in WHERE clauses

---

## Hook Development

Hooks are standalone Bun TypeScript scripts in `hooks/`. They talk to ORC via HTTP, not MCP.

```typescript
// hooks/my-hook.ts
const ORC_API = process.env.ORC_API_BASE || "http://127.0.0.1:7700";
const input = await Bun.stdin.text();
const event = JSON.parse(input);

await fetch(`${ORC_API}/sessions/event`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ type: "file", data: { path: event.tool_input?.path } })
});
```

Hooks must be fast (<500ms). Use fire-and-forget for non-critical ops.

---

## Key Type Locations

All core enums in `packages/core/src/types.ts`:

```typescript
TaskStatus       // todo | doing | review | done | blocked | cancelled | changes_requested
TaskPriority     // low | normal | high | critical
MemoryType       // rule | decision | discovery | event | fact
MemoryImportance // low | normal | high | critical
JobTriggerType   // one-shot | cron | watch | webhook | manual | bridge-msg
JobStatus        // pending | running | success | failed | cancelled | skipped
JobOverlap       // skip | queue | kill
BridgePlatform   // telegram | slack | discord | feishu
BridgeMode       // direct | agent:claude | agent:codex | agent:cursor | multi | job:*
TaskLinkType     // blocks | blocked_by | relates_to | duplicates | clones | subtask_of | parent_of
ProjectStatus    // active | archived | paused
```

---

## Coding Conventions

- **No barrel re-exports** — import directly from package entry or specific module
- **Zod schemas define the contract** — API routes, config, CLI args all derive from Zod
- **Types in `@orc/core/types`** — shared enums defined once
- **IDs are ULIDs** — `ulid()` from `@orc/core/ids`
- **No comments** unless explaining non-obvious intent
- **Biome** for linting/formatting — `bun check` before committing

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forgetting `sdk:generate` after API changes | Always run it — CLI/MCP use the generated client |
| Using UUID instead of ULID | `import { generateId } from "@orc/core/ids"` |
| Hardcoding port 7700 | Use `process.env.ORC_API_PORT` or config |
| Direct DB access from CLI | CLI → SDK → API → DB; never skip layers |
| Forgetting to register routes/commands | Routes: `server.ts`; Commands: `index.ts` |
| Large hook scripts | Keep under 100 lines, fast, fire-and-forget |
