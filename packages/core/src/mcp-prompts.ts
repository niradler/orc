import { z } from "zod";
import { chatUiCatalogText } from "./chat-ui.js";
import { McpSettingsSchema } from "./mcp-settings.js";

export const McpPromptNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const McpPromptSchema = z
  .object({
    name: McpPromptNameSchema,
    title: z.string().trim().min(1).max(120),
    description: z.string().max(1000).default(""),
    content: z.string().trim().min(1).max(30000),
  })
  .strict();
export type McpPrompt = z.infer<typeof McpPromptSchema>;

export const McpPromptListSchema = z
  .array(McpPromptSchema)
  .max(50)
  .refine((prompts) => new Set(prompts.map((prompt) => prompt.name)).size === prompts.length, {
    message: "Prompt names must be unique",
  });

/** Settings → MCP edits the config default mode and the prompt table together. */
export const McpServerSettingsSchema = McpSettingsSchema.extend({ prompts: McpPromptListSchema });
export type McpServerSettings = z.infer<typeof McpServerSettingsSchema>;

/** Argument every prompt accepts: the user's free-text request, e.g. `/create-task fix login`. */
export const MCP_PROMPT_REQUEST_ARG = "request";
const REQUEST_SLOT = "{{request}}";
const CATALOG_SLOT = "{{ui_catalog}}";

/** Seeded into the prompt table once; afterwards they are ordinary user-editable rows. */
export const DEFAULT_MCP_PROMPTS: McpPrompt[] = [
  {
    name: "render-ui",
    title: "Render ORC components",
    description: "Answer a web chat request with live ORC components.",
    content: `For a webchat turn, answer with an orc-ui JSON block using the catalog below. Resolve real entity ids with ORC tools first. For other sources, answer in Markdown.

Request: ${REQUEST_SLOT}

${CATALOG_SLOT}`,
  },
  {
    name: "create-task",
    title: "Create a task",
    description: "Turn a request into a well-formed ORC task.",
    content: `Create an ORC task for the request below.
- Call context for the selected project first and check task_list for an existing task covering it; update that task instead of duplicating it.
- Use task_create with a short imperative title, a description stating the outcome, observable acceptance criteria and known constraints, and a priority that matches the impact.
- Split clearly independent work with task_batch_create and link dependencies.
- Reply with the task id and title.

Request: ${REQUEST_SLOT}`,
  },
  {
    name: "scratchpad",
    title: "Create a scratchpad",
    description: "Draft a plan, diagram or HTML artifact in a shared scratchpad.",
    content: `Create or update an ORC scratchpad for the request below.
- Check pad_list for an existing pad on the topic and continue it with pad_update, preserving human edits.
- Otherwise pad_create with the fitting kind: a document for plans and notes, an Excalidraw diagram for structure, or self-contained HTML (embedded data, inline code and SVG, no network access) for dashboards.
- Scope it to the selected project and share its link.

Request: ${REQUEST_SLOT}`,
  },
  {
    name: "memory",
    title: "Remember a fact",
    description: "Record or refresh a durable project memory.",
    content: `Record a durable ORC memory for the request below.
- Search memory_list first; refresh an existing memory with memory_update rather than creating a near-duplicate.
- Otherwise memory_create with a short name, a description saying when it matters, and concise content. Store stable facts and decisions, not task progress or session logs.
- Choose project scope unless the fact applies across projects.

Request: ${REQUEST_SLOT}`,
  },
  {
    name: "kb",
    title: "Search the knowledge base",
    description: "Answer from the knowledge base with cited sources.",
    content: `Answer the request below from the ORC knowledge base.
- Use kb_list to choose the relevant bases, kb_search to find passages, then kb_read or kb_evidence for the documents you rely on.
- Cite the documents you used. Say plainly when the knowledge base does not cover the question instead of guessing.
- When asked to add knowledge, use kb_write with a clear title and source.

Request: ${REQUEST_SLOT}`,
  },
  {
    name: "skill",
    title: "Find or create a skill",
    description: "Use, improve or author an ORC skill.",
    content: `Handle the skill request below.
- Search skill_list and read candidates with skill_read before acting.
- To use a skill, follow its current instructions and load supporting refs on demand.
- To change one, use skill_update with a focused edit; to author one, use skill_create with a description that says when to use it and concise, testable instructions.

Request: ${REQUEST_SLOT}`,
  },
  {
    name: "agents",
    title: "Find or set up an agent",
    description: "Discover agents and agent packages, or create one.",
    content: `Handle the agent request below.
- Search agent_list and agent_read for an existing agent that fits.
- Browse agent_package_list and agent_package_read for packaged agents; import one with agent_package_import when it fits better than a new agent.
- Create a new agent with agent_create only when nothing existing fits, with a clear role, instructions and tools.

Request: ${REQUEST_SLOT}`,
  },
];

/** Fills the placeholders; a request is appended when the prompt has no `{{request}}` slot. */
export function renderMcpPrompt(prompt: Pick<McpPrompt, "content">, request = ""): string {
  const value = request.trim();
  let text = prompt.content;
  if (text.includes(CATALOG_SLOT)) text = text.split(CATALOG_SLOT).join(chatUiCatalogText("full"));
  if (text.includes(REQUEST_SLOT))
    return text.split(REQUEST_SLOT).join(value || "(none given; ask what is needed)");
  return value ? `${text}\n\nRequest: ${value}` : text;
}

/** Splits a chat message like `/create-task fix login` into a prompt name and request. */
export function parsePromptCommand(message: string): { name: string; request: string } | null {
  const match = /^\/([a-z][a-z0-9_-]{0,63})(?:\s+([\s\S]*))?$/.exec(message.trim());
  return match?.[1] ? { name: match[1], request: match[2]?.trim() ?? "" } : null;
}
