import { autoFixSpec, defineCatalog, type Spec, validateSpec } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

/** Fence language for a json-render spec inside a chat message. */
export const CHAT_UI_FENCE = "orc-ui";
/** MCP resource holding the agent-facing catalog reference. */
export const CHAT_UI_CATALOG_URI = "orc://ui/catalog";
export const CHAT_UI_MAX_ELEMENTS = 200;

const Tone = z.enum(["neutral", "progress", "success", "warning", "error"]);
const TaskStatus = z.enum([
  "todo",
  "queued",
  "doing",
  "review",
  "changes_requested",
  "blocked",
  "done",
  "paused",
  "cancelled",
]);
const TaskPriority = z.enum(["low", "normal", "high", "critical"]);
const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
// Dashboard paths and web links only; javascript:, data: and protocol-relative URLs are rejected.
const Href = z
  .string()
  .max(2000)
  .refine((href) => /^\/(?!\/)/.test(href) || /^https?:\/\//i.test(href), {
    message: "Use a dashboard path starting with / or an http(s) URL",
  });
const Limit = z.number().int().min(1).max(50).optional();

export const chatUiCatalog = defineCatalog(schema, {
  components: {
    Stack: {
      props: z.object({
        direction: z.enum(["vertical", "horizontal"]).optional(),
        gap: z.enum(["sm", "md", "lg"]).optional(),
      }),
      slots: ["default"],
      description: "Groups children vertically (default) or in a wrapping row.",
    },
    Grid: {
      props: z.object({ columns: z.number().int().min(1).max(4).optional() }),
      slots: ["default"],
      description: "Responsive columns (default 2); collapses to one column on phones.",
    },
    Card: {
      props: z.object({ title: z.string().optional(), description: z.string().optional() }),
      slots: ["default"],
      description: "A bordered section with an optional title. Do not nest cards.",
    },
    Heading: {
      props: z.object({
        text: z.string(),
        level: z.union([z.literal(2), z.literal(3)]).optional(),
      }),
      description: "A section heading.",
    },
    Text: {
      props: z.object({ text: z.string(), muted: z.boolean().optional() }),
      description: "A plain paragraph. Use muted for secondary details.",
    },
    Markdown: {
      props: z.object({ text: z.string() }),
      description: "Rendered Markdown (links, lists, inline code).",
    },
    Badge: {
      props: z.object({ label: z.string(), tone: Tone.optional() }),
      description: "A short status label with a colored dot.",
    },
    KeyValue: {
      props: z.object({
        items: z.array(z.object({ label: z.string(), value: Cell, href: Href.optional() })).max(40),
      }),
      description: "Aligned label/value pairs for entity details.",
    },
    Stat: {
      props: z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
        hint: z.string().optional(),
      }),
      description: "One metric. Put several in a Grid.",
    },
    Table: {
      props: z.object({
        columns: z
          .array(z.object({ key: z.string(), label: z.string() }))
          .min(1)
          .max(8),
        rows: z.array(z.record(z.string(), Cell)).max(100),
        linkKey: z.string().optional(),
      }),
      description:
        "Rows of data. linkKey names a row field holding a dashboard path; the first column links to it.",
    },
    Progress: {
      props: z.object({ value: z.number().min(0).max(100), label: z.string().optional() }),
      description: "A 0-100 progress bar.",
    },
    Alert: {
      props: z.object({
        title: z.string(),
        text: z.string().optional(),
        tone: z.enum(["info", "success", "warning", "error"]).optional(),
      }),
      description: "A notice; use error only for real failures.",
    },
    Link: {
      props: z.object({ label: z.string(), href: Href }),
      description: "A link to a dashboard path (e.g. /tasks/<id>) or an http(s) URL.",
    },
    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(["primary", "secondary", "destructive"]).optional(),
      }),
      description:
        'Runs an action on press: "on": {"press": {"action": "<name>", "params": {...}}}. Use one primary button per block.',
    },
    Divider: { props: z.object({}), description: "A quiet horizontal separator." },
    Code: {
      props: z.object({ code: z.string(), language: z.string().optional() }),
      description: "A monospace code or command block.",
    },
    Task: {
      props: z.object({ id: z.string() }),
      description:
        "Live ORC task by id: title, status/priority/progress, project and links, with a status control. Prefer this over describing a task by hand.",
    },
    TaskList: {
      props: z.object({
        projectId: z.string().optional(),
        status: TaskStatus.optional(),
        limit: Limit,
      }),
      description:
        "Live task rows, optionally filtered by project id and status (default limit 10).",
    },
    Job: {
      props: z.object({ id: z.string() }),
      description:
        "Live ORC job by id: trigger, schedule, last/next run, enabled state and Run now.",
    },
    JobList: {
      props: z.object({
        projectId: z.string().optional(),
        enabled: z.boolean().optional(),
        limit: Limit,
      }),
      description: "Live job rows, optionally filtered by project id or enabled state.",
    },
    Project: {
      props: z.object({ id: z.string() }),
      description: "Live ORC project by id with its status and task counts.",
    },
    ProjectList: {
      props: z.object({
        status: z.enum(["active", "paused", "archived"]).optional(),
        limit: Limit,
      }),
      description: "Live project rows.",
    },
    SessionList: {
      props: z.object({ projectId: z.string().optional(), limit: Limit }),
      description: "Live discovered agent sessions, most recent activity first.",
    },
    Memory: {
      props: z.object({ projectId: z.string(), name: z.string() }),
      description: "Live ORC memory (project id plus name) with its description and content.",
    },
    Pad: {
      props: z.object({ id: z.string() }),
      description: "Live scratchpad summary with a link to open it.",
    },
    Skill: {
      props: z.object({ name: z.string() }),
      description: "Live skill summary by name.",
    },
  },
  actions: {
    "task.update": {
      params: z.object({
        id: z.string(),
        status: TaskStatus.optional(),
        priority: TaskPriority.optional(),
        progress: z.number().int().min(0).max(100).optional(),
      }),
      description: "Update a task's status, priority or progress.",
    },
    "task.comment": {
      params: z.object({ id: z.string(), content: z.string().min(1).max(10000) }),
      description: "Add a comment to a task as the signed-in user.",
    },
    "task.delete": {
      params: z.object({ id: z.string() }),
      description: "Delete a task. The user always confirms first.",
    },
    "job.run": {
      params: z.object({ id: z.string() }),
      description: "Trigger a job run now. The user always confirms first.",
    },
    "job.setEnabled": {
      params: z.object({ id: z.string(), enabled: z.boolean() }),
      description: "Enable or disable a job.",
    },
  },
});

export type ChatUiActionName = keyof typeof chatUiCatalog.data.actions;
/** Actions the web client confirms with the user regardless of the spec. */
export const CHAT_UI_CONFIRMED_ACTIONS: ReadonlySet<ChatUiActionName> = new Set([
  "task.delete",
  "job.run",
]);

export type ChatUiParseResult = { ok: true; spec: Spec } | { ok: false; error: string };

/** Parses a fenced spec and checks structure, component props and action names. */
export function parseChatUiSpec(source: string): ChatUiParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${(error as Error).message}` };
  }
  const input = raw as Partial<Spec> | null;
  if (!input || typeof input !== "object" || Array.isArray(input) || !isRecord(input.elements))
    return { ok: false, error: "Spec must be an object with root and elements" };
  // Leaf elements may omit props/children; the renderer and schema expect both.
  const normalized: Spec = {
    ...input,
    root: input.root as string,
    elements: Object.fromEntries(
      Object.entries(input.elements).map(([key, element]) => [
        key,
        isRecord(element) ? normalizeElement(element) : element,
      ]),
    ) as Spec["elements"],
  };
  const { spec } = autoFixSpec(normalized);
  const elements = Object.values(spec.elements);
  if (elements.length > CHAT_UI_MAX_ELEMENTS)
    return { ok: false, error: `Spec exceeds ${CHAT_UI_MAX_ELEMENTS} elements` };
  const issues = validateSpec(spec).issues.filter((issue) => issue.severity === "error");
  if (issues.length) return { ok: false, error: issues.map((issue) => issue.message).join("; ") };
  const checked = chatUiCatalog.validate(spec);
  if (!checked.success) return { ok: false, error: issueText("spec", checked.error) };
  // The catalog schema checks element shape; props and action params are checked here.
  const { components, actions } = chatUiCatalog.data;
  for (const [key, element] of Object.entries(spec.elements)) {
    const props = components[element.type as keyof typeof components].props.safeParse(
      element.props,
    );
    if (!props.success) return { ok: false, error: issueText(`${key}.props`, props.error) };
    for (const bindings of Object.values(element.on ?? {}))
      for (const binding of [bindings].flat()) {
        const action = actions[binding.action as ChatUiActionName];
        if (!action) return { ok: false, error: `Unknown action: ${binding.action}` };
        // Dynamic params ($state etc.) are resolved at press time and re-checked by the API.
        if (!hasDynamic(binding.params)) {
          const params = action.params.safeParse(binding.params ?? {});
          if (!params.success)
            return { ok: false, error: issueText(`${key}.on.${binding.action}`, params.error) };
        }
      }
  }
  return { ok: true, spec };
}

function normalizeElement(element: Record<string, unknown>): Record<string, unknown> {
  const normalized = { props: {}, children: [], ...element };
  if (!isRecord(element.on)) return normalized;
  // Spec-level confirm waits on json-render's own dialog; ORC confirms destructive actions itself.
  const on = Object.fromEntries(
    Object.entries(element.on).map(([event, bindings]) => [
      event,
      Array.isArray(bindings) ? bindings.map(withoutConfirm) : withoutConfirm(bindings),
    ]),
  );
  return { ...normalized, on };
}

function withoutConfirm(binding: unknown): unknown {
  if (!isRecord(binding)) return binding;
  const { confirm: _confirm, ...rest } = binding;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasDynamic(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDynamic);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => key.startsWith("$") || hasDynamic(item));
}

function issueText(where: string, error: z.ZodError | undefined): string {
  return (error?.issues ?? [])
    .slice(0, 5)
    .map((issue) => `${[where, ...issue.path].join(".")}: ${issue.message}`)
    .join("; ");
}

type JsonNode = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonNode[];
  items?: JsonNode;
  properties?: Record<string, JsonNode>;
  required?: string[];
};

function describe(type: z.ZodType): string {
  return typeLabel(z.toJSONSchema(type, { unrepresentable: "any" }) as JsonNode);
}

function typeLabel(node: JsonNode): string {
  if (node.enum) return node.enum.map((item) => JSON.stringify(item)).join("|");
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.anyOf) return node.anyOf.map(typeLabel).join("|");
  if (node.type === "array") return `${node.items ? typeLabel(node.items) : "any"}[]`;
  if (node.type === "object" && node.properties) {
    const required = new Set(node.required ?? []);
    const fields = Object.entries(node.properties).map(
      ([key, item]) => `${key}${required.has(key) ? "" : "?"}: ${typeLabel(item)}`,
    );
    return fields.length ? `{ ${fields.join(", ")} }` : "{}";
  }
  if (node.type === "object") return "object";
  return [node.type ?? "any"].flat().join("|");
}

/** Agent-facing reference served as an MCP resource and tool. */
export function chatUiCatalogText(): string {
  const { components, actions } = chatUiCatalog.data;
  const componentLines = Object.entries(components).map(
    ([name, def]) =>
      `- ${name} ${describe(def.props)}${"slots" in def ? " (children)" : ""} — ${def.description}`,
  );
  const actionLines = Object.entries(actions).map(
    ([name, def]) => `- ${name} ${describe(def.params)} — ${def.description}`,
  );
  return `# ORC chat UI components

Render ORC components inside an ORC web chat reply. Only do this when the turn's
<orc-context> says the source is webchat; channels such as Telegram show the raw
JSON, so answer there in plain Markdown. Prefer live entity components (Task,
TaskList, Job, ...) over copying entity fields: they load current data as the
signed-in user and stay up to date. Resolve ids with ORC tools first; never guess.

Write a fenced block with the language \`${CHAT_UI_FENCE}\` containing one JSON spec.
Text before and after the block renders as Markdown. Keep a short sentence of
context; do not repeat what the component shows.

\`\`\`${CHAT_UI_FENCE}
{
  "root": "main",
  "elements": {
    "main": { "type": "Stack", "props": {}, "children": ["task", "open"] },
    "task": { "type": "Task", "props": { "id": "<task-id>" } },
    "open": { "type": "TaskList", "props": { "projectId": "<project-id>", "status": "doing", "limit": 5 } }
  }
}
\`\`\`

Rules:
- "root" names an element key; every key in "children" must exist in "elements".
- Only components marked (children) take children. At most ${CHAT_UI_MAX_ELEMENTS} elements.
- Buttons run actions with "on": {"press": {"action": "task.update", "params": {"id": "<id>", "status": "done"}}}.
  Actions call the ORC API as the signed-in user; destructive ones are confirmed in the UI.
- Links use dashboard paths (see the orc-platform web reference), e.g. /tasks/<task-id>.
- Invalid specs are shown to the user as raw JSON, so validate ids and props.

## Components
${componentLines.join("\n")}

## Actions
${actionLines.join("\n")}
`;
}
