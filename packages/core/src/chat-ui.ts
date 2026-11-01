import { defineCatalog, type Spec, validateSpec } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

/** Fence language for a json-render spec inside a chat message. */
export const CHAT_UI_FENCE = "orc-ui";
/** MCP resource holding the agent-facing catalog reference. */
export const CHAT_UI_CATALOG_URI = "orc://ui/catalog";
export const CHAT_UI_MAX_ELEMENTS = 200;

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
const Limit = z.number().int().min(1).max(50).optional();
const EntityId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

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
    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(["primary", "secondary", "destructive"]).optional(),
      }),
      description:
        'Runs an action on press: "on": {"press": {"action": "<name>", "params": {...}}}. Use one primary button per block.',
    },
    Task: {
      props: z.object({ id: EntityId }),
      description:
        "Live task with status control, progress and links; use when the user wants to follow or act on it.",
    },
    TaskList: {
      props: z.object({
        projectId: EntityId.optional(),
        status: TaskStatus.optional(),
        limit: Limit,
      }),
      description:
        "Live task rows, optionally filtered by project id and status (default limit 10).",
    },
    Job: {
      props: z.object({ id: EntityId }),
      description:
        "Live ORC job by id: trigger, schedule, last/next run, enabled state and Run now.",
    },
    JobList: {
      props: z.object({
        projectId: EntityId.optional(),
        enabled: z.boolean().optional(),
        limit: Limit,
      }),
      description: "Live job rows, optionally filtered by project id or enabled state.",
    },
    Project: {
      props: z.object({ id: EntityId }),
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
      props: z.object({ projectId: EntityId.optional(), limit: Limit }),
      description:
        "Live session activity, summaries and related task links; long content expands/fullscreens.",
    },
    Memory: {
      props: z.object({ projectId: EntityId, name: z.string().min(1).max(128) }),
      description: "Live ORC memory (project id plus name) with its description and content.",
    },
    Pad: {
      props: z.object({ id: EntityId }),
      description:
        "Live scratchpad and document preview; long text expands/fullscreens, with an editor link.",
    },
  },
  actions: {
    "task.update": {
      params: z.object({
        id: EntityId,
        status: TaskStatus.optional(),
        priority: TaskPriority.optional(),
        progress: z.number().int().min(0).max(100).optional(),
      }),
      description: "Update a task's status, priority or progress.",
    },
    "task.comment": {
      params: z.object({ id: EntityId, content: z.string().min(1).max(10000) }),
      description: "Add a comment to a task as the signed-in user.",
    },
    "task.delete": {
      params: z.object({ id: EntityId }),
      description: "Delete a task. The user always confirms first.",
    },
    "job.run": {
      params: z.object({ id: EntityId }),
      description: "Trigger a job run now. The user always confirms first.",
    },
    "job.setEnabled": {
      params: z.object({ id: EntityId, enabled: z.boolean() }),
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

const BindingSchema = z
  .object({
    action: z.string(),
    params: z.record(z.string(), z.unknown()).default({}),
    confirm: z.unknown().optional(),
  })
  .strict();
const ElementSchema = z
  .object({
    type: z.string(),
    props: z.record(z.string(), z.unknown()).default({}),
    children: z.array(z.string()).max(CHAT_UI_MAX_ELEMENTS).default([]),
    on: z.record(z.string(), z.union([BindingSchema, z.array(BindingSchema).max(10)])).optional(),
  })
  .strict();
const SpecSchema = z
  .object({
    root: z.string(),
    elements: z.record(z.string(), ElementSchema),
    state: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function actionBinding(binding: z.infer<typeof BindingSchema>) {
  return { action: binding.action, params: binding.params };
}

/** Parses a fenced spec and checks structure, component props and action names. */
export function parseChatUiSpec(source: string): ChatUiParseResult {
  if (source.length > 1_000_000) return { ok: false, error: "Spec exceeds 1 MB" };
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${(error as Error).message}` };
  }
  const input = SpecSchema.safeParse(raw);
  if (!input.success) return { ok: false, error: issueText("spec", input.error) };
  const normalized: Spec = {
    root: input.data.root,
    ...(input.data.state ? { state: input.data.state } : {}),
    elements: Object.fromEntries(
      Object.entries(input.data.elements).map(([key, element]) => [
        key,
        {
          type: element.type,
          props: element.props,
          children: element.children,
          ...(element.on
            ? {
                on: Object.fromEntries(
                  Object.entries(element.on).map(([event, bindings]) => [
                    event,
                    Array.isArray(bindings) ? bindings.map(actionBinding) : actionBinding(bindings),
                  ]),
                ),
              }
            : {}),
        },
      ]),
    ),
  };
  const spec = normalized;
  const elements = Object.values(spec.elements);
  if (elements.length > CHAT_UI_MAX_ELEMENTS)
    return { ok: false, error: `Spec exceeds ${CHAT_UI_MAX_ELEMENTS} elements` };
  // Bound rendered nodes as well as definitions: a tiny cyclic/shared graph can
  // otherwise recurse forever or expand exponentially in React.
  let rendered = 0;
  function visit(key: string, ancestors: Set<string>): boolean {
    if (!Object.keys(spec.elements).includes(key) || ancestors.has(key)) return false;
    if (++rendered > CHAT_UI_MAX_ELEMENTS) return false;
    const next = new Set(ancestors).add(key);
    return (spec.elements[key]?.children ?? []).every((child) => visit(child, next));
  }
  if (!visit(spec.root, new Set()))
    return {
      ok: false,
      error: "Invalid layout: missing element, cycle, or too many rendered nodes",
    };
  const issues = validateSpec(spec).issues.filter((issue) => issue.severity === "error");
  if (issues.length) return { ok: false, error: issues.map((issue) => issue.message).join("; ") };
  const checked = chatUiCatalog.validate(spec);
  if (!checked.success) return { ok: false, error: issueText("spec", checked.error) };
  // The catalog schema checks element shape; props and action params are checked here.
  const { components, actions } = chatUiCatalog.data;
  for (const [key, element] of Object.entries(spec.elements)) {
    if (!Object.keys(components).includes(element.type))
      return { ok: false, error: `Unknown component: ${element.type}` };
    const props = components[element.type as keyof typeof components].props.safeParse(
      element.props,
    );
    if (!props.success) return { ok: false, error: issueText(`${key}.props`, props.error) };
    element.props = props.data;
    if (element.children?.length && element.type !== "Stack")
      return { ok: false, error: `${element.type} does not accept children` };
    if (
      Object.keys(element.on ?? {}).some((event) => element.type !== "Button" || event !== "press")
    )
      return { ok: false, error: "Actions require a Button press" };
    for (const bindings of Object.values(element.on ?? {}))
      for (const binding of [bindings].flat()) {
        const action = actions[binding.action as ChatUiActionName];
        if (!Object.keys(actions).includes(binding.action))
          return { ok: false, error: `Unknown action: ${binding.action}` };
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
      `- ${name} ${describe(def.props)}${"slots" in def ? " (children)" : ""} â€” ${def.description}`,
  );
  const actionLines = Object.entries(actions).map(
    ([name, def]) => `- ${name} ${describe(def.params)} â€” ${def.description}`,
  );
  return `# ORC chat UI components

Webchat only: use components only when <orc-context> says source: webchat.
Default to Markdown. Use a component for current/live entity data, an API action,
or contextual navigation; never just to decorate text or repeat a status.
Entity components load as the signed-in user and stay live. Resolve ids first.

Reply with an orc-ui fence; ordinary text outside it is Markdown:
\`\`\`${CHAT_UI_FENCE}
{"root":"task","elements":{"task":{"type":"Task","props":{"id":"<task-id>"}}}}
\`\`\`

Rules:
- root and every child key must exist; only Stack accepts children. Max ${CHAT_UI_MAX_ELEMENTS} rendered elements.
- Button actions: "on":{"press":{"action":"task.update","params":{"id":"<id>","status":"done"}}}.
- Actions run only on press, as the signed-in user; delete/run require confirmation.
- Keep replies small. No galleries, duplicated entity fields, watchers or repeaters.
- Invalid specs display raw JSON and an error. Channels use Markdown.

## Components
${componentLines.join("\n")}

## Actions
${actionLines.join("\n")}
`;
}
