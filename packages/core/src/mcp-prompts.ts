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
    description: "Answer with live ORC components in web chat, Markdown elsewhere.",
    content: `Answer the request below.
- Only when <orc-context> says source: webchat, add an orc-ui fence from the catalog for tasks, jobs, sessions or pads the user wants to watch, act on or open. Write everything else in Markdown, including anything the catalog has no component for (such as flow status); with any other or no source, reply in Markdown only.
- Use real ids, never names or placeholders: task ids from task_list or task_get (find a task the request names with search and resources ["tasks"]), the project id from project_list, job ids from job_list, pad ids from pad_list or pad_create.
- Use only the component types, props and actions in the catalog; anything else makes the block invalid.
- Components let the user act: do not run jobs or change tasks yourself when the request is to show them. Job already has Run now, so it needs no extra button.
- TaskList filters one status; for all open work, stack one list per active status (doing, review, changes_requested, blocked, queued, paused, todo), skipping ones the user does not need.

Request: ${REQUEST_SLOT}

${CATALOG_SLOT}`,
  },
  {
    name: "create-task",
    title: "Create a task",
    description: "Turn a request into a well-formed ORC task.",
    content: `Create an ORC task for the request below.
- If the request is too vague to write acceptance criteria, ask one focused question and stop.
- Call context, passing project when the request names one (otherwise the active project applies), and pass the same project to every later call. Its Active Tasks list shows existing work; also search with the request keywords and resources ["tasks"], and task_get any likely match.
- If a task already covers the request, reply with that task instead of creating a duplicate: add small details as a task_update comment, and replace the body (merged with the text you read) only when the scope changes.
- Otherwise call task_create with a short imperative title and a Markdown body with Outcome, Acceptance criteria (observable, checkable bullets) and Constraints sections. Set priority low, normal, high or critical by impact (normal by default), add a few area tags, and leave required_review on unless the user says otherwise.
- For work with separately deliverable parts, use one task_batch_create: give each task a ref (T1, T2, ...), order them with depends_on refs, and point subtask_of at a parent task's ref in the same batch. Refs link tasks only within that batch; for work under an existing task, name the parent task id in the body instead.
- Reply with the id and title of every task you created or updated.

Request: ${REQUEST_SLOT}`,
  },
  {
    name: "scratchpad",
    title: "Create a scratchpad",
    description: "Draft a plan, diagram or HTML artifact in a shared scratchpad.",
    content: `Create or update an ORC scratchpad for the request below.
- Pad tools do not default to the active project: pass project as the name the request gives, else the active project's name (call context if you do not know it). Call pad_list with it and q set to topic keywords (if nothing matches, retry once with unassigned:true instead of project); open a likely match with pad_get.
- To continue a pad, merge your change into the full text pad_get returned (content replaces the whole file) and call pad_update with if_revision set to the revision you read. If that fails, the pad changed: re-read, merge and retry.
- Otherwise call pad_create with title, project, content and kind: doc for plans and notes (Markdown; mermaid blocks render as diagrams), diagram for a freeform Excalidraw canvas, or html for a standalone dashboard page. An html page embeds a current snapshot of its data gathered with ORC tools and inlines its code (or pins CDN scripts with integrity); window.orc.fetch works only when the human opts in, so check for window.orc and fall back to the snapshot.
- For very large content, create the pad empty, then pad_update with via:"url" and upload the file to the returned URL with curl -T.
- Reply with the pad's title and link.

Request: ${REQUEST_SLOT}`,
  },
  {
    name: "memory",
    title: "Remember a fact",
    description: "Record or refresh a durable project memory.",
    content: `Record a durable ORC memory for the request below.
- A memory is a short fact or decision for one project: pass project on every call when the request names one, otherwise the active project applies. There is no global memory; for a preference that spans projects, say so and offer a global skill (skill_create with scope global and a full SKILL.md) without creating it unasked.
- Do not store secrets, task progress (offer to record it on the task with task_update instead), session logs, or procedures and long guidance (those belong in a skill). Say why instead of saving.
- Call memory_list with q set to keywords and memory_read likely matches. If one covers the fact, memory_update only the fields that change, with a reason.
- Otherwise call memory_create with a lowercase-hyphenated name, a description (up to 300 characters) saying when it matters, the fact itself as short content (800 characters by default), and a priority from 0 to 100 only when it should load before other memories.
- Reply with the memory name and whether you created or updated it.

Request: ${REQUEST_SLOT}`,
  },
  {
    name: "kb",
    title: "Search the knowledge base",
    description: "Answer from the knowledge base with cited sources, or add to it.",
    content: `Answer the request below from the ORC knowledge base.
- For a question, call kb_evidence with it: it returns cited passages from the knowledge bases visible to the project. Use kb_search to locate documents, and kb_read for one document, heading or citation when you need more context.
- Cite inline with the handles the tools return (kb:<doc>@<rev>#<n>). Passages flagged as derived are summaries of other documents, not independent sources.
- If nothing relevant comes back, retry once with kb_search and different terms; if that also fails, say the knowledge base does not cover it. Do not present general knowledge as coming from it.
- To add or correct knowledge, call kb_list for the knowledge bases you may edit and their kb_id, then kb_search for an existing document on the topic. To change one, kb_read it (start_line and end_line show numbered lines) for its text and revision, then call kb_document with action edit, document_id, expected_revision set to that revision, edits (each {old, new} for exact text or {start_line, end_line, new} for whole lines) and a note. If the knowledge base is not editable from here, kb_comment with action add, kb_id, document_id and a body describing the correction instead. If no document covers it, call kb_write with kb_id (an editable base; ask if several fit), title, content ending in a "Source:" line (a URL, a document, or "user in chat" with the date), and a note saying why.

Request: ${REQUEST_SLOT}`,
  },
  {
    name: "skill",
    title: "Find or create a skill",
    description: "Use, improve or author an ORC skill.",
    content: `Handle the skill request below.
- Find: call skill_list with q set to keywords from the request; it covers the selected project's skills and global ones. If nothing fits, retry once with different keywords before concluding there is none, then offer to create one.
- Use: read the best match with skill_read and follow its SKILL.md as written. Its file inventory lists supporting files; load a reference only when the instructions call for it, with skill_read and ref set to its path (e.g. references/guide.md; a bare filename reads references/).
- Scripts and assets: call skill_read with ref and download:true for a signed URL (valid ten minutes) and its sha256. Download it right away to a fresh local folder and verify the hash; if it differs, stop and report. Read it, then run it yourself as the skill directs. Never retype a script from displayed text; ORC never runs it for you.
- Change: check the lesson against the code or the user first. Read the raw file with skill_read and ref "SKILL.md": the result starts with a "# SKILL.md" line added by the tool; everything after it is the file, frontmatter and title included. Call skill_update with skill_name, content set to the full new SKILL.md (name unchanged), expected_content set to that file text exactly, and a reason. Pass the same project or scope you found the skill under to both calls. For a script or other supporting file, read it with skill_read and its ref, then call skill_file_write with path, the full new content, expected_content set to that text (null adds a new file) and a reason.
- Create: when Find turned up nothing equivalent, call skill_create with a lowercase-hyphenated name and content set to a full SKILL.md: frontmatter with name and a description saying when to use it, then concise, testable steps. Put long material in files (references/ or scripts/ paths). Pass scope global only for a skill every project should see.
- Unless the request asks for that exact change or new skill, confirm it with the user before writing.

Request: ${REQUEST_SLOT}`,
  },
  {
    name: "need-attention",
    title: "Ask the user to act",
    description:
      "Ask the user to answer, approve or run something you lack permission for or were told not to run.",
    content: `Ask the user through ORC's Notifications menu for the request below. Use it when you lack permission, need privileges or secrets you do not have, or the user or project said not to run something yourself. Never work around the block.
- To have the user run a command, call command_request (not human_request with kind command) with a short title, a prompt saying why it is needed and what it changes, and command: the exact host (null for the ORC API host), cwd, a non-interactive script for that host's default shell, and arguments for any value only the user should type (passwords, tokens, OTPs), each with name (uppercase, e.g. SUDO_PASSWORD), label and required. Reference them in the script as quoted $ORC_INPUT_<name> in bash/zsh or $env:ORC_INPUT_<name> in PowerShell, and feed secrets on stdin rather than waiting at a prompt (e.g. printf '%s\\n' "$ORC_INPUT_SUDO_PASSWORD" | sudo -S ...). Never ask for secrets in chat.
- For a decision, call human_request with title, prompt and kind question (choices for fixed options), or kind approval with action set to the exact tool, its input, cwd and host (a hostname string, never null) you want to run (no choices; the user approves or denies).
- Every call needs origin: session_id (your ORC session id if you were given one, else your native session id), backend (your agent name, e.g. claude-code) and a request_id unique to this ask; reuse the same origin only to resend the identical request. Pass project set to the current project name.
- Right after creating it, tell the user in one line what you asked for and that it waits in Notifications.
- Keep the returned id and call human_request_get with id and wait_seconds 30, repeating while it is pending or running; meanwhile continue only work that does not depend on it. After about ten polls with no answer, tell the user it is still waiting and end your turn; check it again when resumed. Never act before an answer.
- Use the answer or command result only for this task, then call human_request_acknowledge with the id and the version from the last human_request_get, including after a denial.
- Denied, cancelled, expired or unavailable means do not run it and do not retry another way; a command that ran but failed is a result to report, not permission to try something else. Report it and stop that step.

Request: ${REQUEST_SLOT}`,
  },
  {
    name: "agents",
    title: "Find or set up an agent",
    description: "Discover agents and agent packages, or create one.",
    content: `Handle the agent request below.
- agent_list returns every shared agent, including those from packages as <package>/<agent> ids, and flags malformed ones with validation errors; skip those. Scan it and agent_read the likely matches.
- agent_package_list shows packages that are already shared, and agent_package_read shows a package's manifest and files. Their agents are already usable by id, so never re-import a listed package: import rejects an existing name, so for a newer version tell the user it is already shared rather than importing under another name.
- Use agent_package_import only for a package that is not listed yet: name, format (apm or agent-plugin), content set to the original apm.yml or plugin.json, and files with every other file at its package-relative path (binary files as base64). Read a local package yourself; ask the user only if you cannot reach it.
- Use agent_create only when nothing fits, with id (a lowercase-hyphenated name) and content set to an .agent.md with YAML frontmatter: agent_read an existing agent and follow its frontmatter keys (with none to copy, use name, description, model and tools), and give the new one a focused role, clear instructions and only the tools it needs.
- Confirm the drafted agent with the user before agent_create unless they supplied its content, and confirm an import unless they named the package. Reply with the agent ids to use.

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
