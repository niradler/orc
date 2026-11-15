import type { ChatActivity } from "@orc/core/chat";
import { structuredPatch } from "diff";

export type ChatTool = Extract<ChatActivity, { type: "tool" }>;
export type ToolFileChange = {
  path: string;
  diff: string;
  added: number;
  removed: number;
  created?: boolean;
};
export type ToolTodoStatus = "pending" | "in_progress" | "completed" | "failed";
export type ToolTodoEntry = { id: string; content: string; status: ToolTodoStatus };
export type ToolQuestion = { header?: string; question: string; options: string[] };
export type ToolImage = { src: string; bytes: number; name?: string };
export type ToolLink = { label: string; href: string };

export type ToolView =
  | { kind: "read"; target: string; path?: string; line?: number }
  | { kind: "search"; target: string; path?: string }
  | { kind: "edit"; files: ToolFileChange[] }
  | { kind: "write"; files: ToolFileChange[] }
  | { kind: "run"; command: string; tail: string; hidden: number }
  | { kind: "mcp"; server?: string; tool: string }
  | { kind: "browser"; action: string; target?: string }
  | { kind: "todo"; entries: ToolTodoEntry[] }
  | { kind: "plan"; entries: ToolTodoEntry[]; title?: string }
  | { kind: "question"; questions: ToolQuestion[] }
  | { kind: "generic" };

const WRITE_TOOLS = new Set([
  "write",
  "write_file",
  "writefile",
  "create_file",
  "createfile",
  "create",
  "notebook_write",
  "save_file",
]);
const EDIT_TOOLS = new Set([
  "edit",
  "multiedit",
  "edit_file",
  "replace",
  "str_replace",
  "str_replace_editor",
  "filechange",
  "file_change",
  "apply_patch",
  "patch",
  "notebook_edit",
  "insert",
]);
const READ_TOOLS = new Set([
  "read",
  "read_file",
  "read_many_files",
  "view",
  "cat",
  "ls",
  "list",
  "list_directory",
  "notebook_read",
  "webfetch",
  "web_fetch",
  "fetch",
]);
const SEARCH_TOOLS = new Set([
  "grep",
  "rg",
  "glob",
  "find",
  "find_files",
  "search",
  "search_file_content",
  "codesearch",
  "code_search",
  "websearch",
  "web_search",
]);
const RUN_TOOLS = new Set([
  "bash",
  "shell",
  "sh",
  "zsh",
  "powershell",
  "exec",
  "exec_command",
  "execute",
  "execute_command",
  "command",
  "command_execution",
  "commandexecution",
  "run_shell_command",
  "run_command",
  "terminal",
]);
const BROWSER_TOOLS = new Set([
  "browser",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "navigate",
  "playwright",
  "puppeteer",
  "screenshot",
  "take_screenshot",
  "webdriver",
]);
const TODO_TOOLS = new Set([
  "todowrite",
  "todo_write",
  "todo",
  "todos",
  "updatetodos",
  "update_todos",
]);
const PLAN_TOOLS = new Set(["plan", "update_plan", "updateplan", "set_plan", "write_plan"]);
const QUESTION_TOOLS = new Set([
  "askuserquestion",
  "ask_user",
  "ask_user_question",
  "ask_question",
  "question",
  "request_user_input",
  "elicit",
  "elicitation",
]);

/** Decoded bytes allowed for one inline tool image. */
export const MAX_TOOL_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TOOL_IMAGES = 4;
/** Inline images are rendered from data URLs only; remote URLs are never fetched. */
const IMAGE_MIME = /^image\/(?:png|jpe?g|gif|webp|bmp)$/i;
const DATA_URL = /data:(image\/(?:png|jpe?g|gif|webp|bmp));base64,([a-z0-9+/=]+)/gi;
const PULL_REQUEST =
  /\bhttps:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\/[^\s<>"'`]*\/(?:pull|pull-requests|merge_requests)\/\d+/gi;
const MAX_LINK_FILES = 8;

export const OUTPUT_TAIL_LINES = 12;

export function toolKey(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .split(/__|:\s*|\.\s*/)
      .pop()
      ?.trim() ?? ""
  );
}

/** An MCP tool keeps its server, which the row shows as its origin. */
export function toolOrigin(name: string): { key: string; server?: string; mcp: boolean } {
  const trimmed = name.trim();
  const mcpPrefix = /^mcp(?:__|:\s*|\.)(.+)$/i.exec(trimmed);
  if (mcpPrefix?.[1]) {
    const rest = mcpPrefix[1];
    const [server, tool] = rest.includes("__") ? rest.split(/__(.+)/, 2) : [undefined, rest];
    return {
      key: toolKey(tool ?? rest),
      ...(server ? { server } : {}),
      mcp: true,
    };
  }
  return { key: toolKey(trimmed), mcp: false };
}

function parseInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value) return value;
  return undefined;
}

function countChanges(diff: string): Pick<ToolFileChange, "added" | "removed"> {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function patchFile(path: string, before: string, after: string): ToolFileChange {
  const patch = structuredPatch(path, path, before, after, "", "", { context: 3 });
  const diff = patch.hunks
    .map((hunk) =>
      [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines.filter((line) => !line.startsWith("\\")),
      ].join("\n"),
    )
    .join("\n");
  return { path, diff, ...countChanges(diff) };
}

function diffFile(path: string, diff: string, created = false): ToolFileChange {
  return { path, diff, ...countChanges(diff), ...(created ? { created: true } : {}) };
}

function mergeFiles(files: ToolFileChange[]): ToolFileChange[] {
  const merged = new Map<string, ToolFileChange>();
  for (const file of files) {
    const previous = merged.get(file.path);
    merged.set(
      file.path,
      previous
        ? {
            path: file.path,
            diff: [previous.diff, file.diff].filter(Boolean).join("\n"),
            added: previous.added + file.added,
            removed: previous.removed + file.removed,
            ...(previous.created && file.created ? { created: true } : {}),
          }
        : file,
    );
  }
  return [...merged.values()];
}

export function parseApplyPatch(patch: string): ToolFileChange[] {
  const files: ToolFileChange[] = [];
  let current: { path: string; lines: string[]; created: boolean } | null = null;
  const flush = () => {
    if (current) files.push(diffFile(current.path, current.lines.join("\n"), current.created));
  };
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (header?.[2]) {
      flush();
      current = { path: header[2].trim(), lines: [], created: header[1] === "Add" };
    } else if (current && !line.startsWith("***")) {
      current.lines.push(line.startsWith("@@") && !/^@@ -\d/.test(line) ? "@@ -1 +1 @@" : line);
    }
  }
  flush();
  return mergeFiles(files);
}

function editFiles(input: unknown, created = false): ToolFileChange[] {
  if (typeof input === "string") return input.includes("*** ") ? parseApplyPatch(input) : [];
  if (Array.isArray(input))
    return mergeFiles(
      input.flatMap((change) => {
        const item = record(change);
        const path = text(item.path, item.file_path, item.filePath);
        if (!path) return [];
        const createdFile = created || ["add", "create", "created"].includes(String(item.kind));
        const diff = text(item.diff, item.unified_diff, item.patch);
        if (diff) return [diffFile(path, diff, createdFile)];
        const content = text(item.content, item.new_content);
        return content === undefined ? [] : [patchFile(path, "", content)];
      }),
    );
  const value = record(input);
  if (Array.isArray(value.changes)) return editFiles(value.changes, created);
  const patch = text(value.patch, value.input);
  if (patch?.includes("*** ")) return parseApplyPatch(patch);
  const path = text(value.file_path, value.filePath, value.path, value.absolute_path, value.file);
  if (!path) return [];
  if (Array.isArray(value.edits))
    return mergeFiles(
      value.edits.map((edit) => {
        const item = record(edit);
        return patchFile(
          path,
          text(item.old_string, item.oldString, item.old_str) ?? "",
          text(item.new_string, item.newString, item.new_str) ?? "",
        );
      }),
    );
  const diff = text(value.diff, value.unified_diff);
  if (diff) return [diffFile(path, diff, created)];
  const before = text(value.old_string, value.oldString, value.old_str) ?? "";
  const after = text(value.new_string, value.newString, value.new_str, value.content) ?? "";
  return before || after ? [patchFile(path, before, after)] : [];
}

/** A write carries the whole file, so its diff is additions only. */
function writeFiles(input: unknown): ToolFileChange[] {
  const files = editFiles(input, true);
  return files.map((file) => ({ ...file, created: true }));
}

function commandText(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() || undefined;
  if (Array.isArray(input))
    return input.every((part) => typeof part === "string") ? input.join(" ") : undefined;
  if (!input || typeof input !== "object") return undefined;
  const value = record(input);
  return (
    commandText(value.command) ??
    commandText(value.cmd) ??
    text(value.script, value.commandLine)?.trim()
  );
}

export function outputTail(
  output: string,
  lines = OUTPUT_TAIL_LINES,
): { tail: string; hidden: number } {
  const all = output.replace(/\s+$/, "").split("\n");
  if (all.length === 1 && !all[0]) return { tail: "", hidden: 0 };
  return { tail: all.slice(-lines).join("\n"), hidden: Math.max(0, all.length - lines) };
}

function targetPath(input: unknown): string | undefined {
  const value = record(input);
  return text(
    value.file_path,
    value.filePath,
    value.absolute_path,
    value.path,
    value.dir_path,
    value.directory,
  );
}

function lineNumber(input: unknown): number | undefined {
  const value = record(input);
  for (const candidate of [value.offset, value.line, value.start_line, value.startLine]) {
    const parsed = typeof candidate === "string" ? Number.parseInt(candidate, 10) : candidate;
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function readTarget(input: unknown): { target: string; path?: string; line?: number } | undefined {
  if (typeof input === "string") {
    const target = input.trim().split("\n")[0]?.slice(0, 300);
    return target ? { target } : undefined;
  }
  const value = record(input);
  const path = targetPath(input);
  const url = text(value.url, value.target);
  const line = lineNumber(input);
  if (path) return { target: path, path, ...(line !== undefined ? { line } : {}) };
  return url ? { target: url } : undefined;
}

function searchTarget(input: unknown): { target: string; path?: string } | undefined {
  if (typeof input === "string") {
    const target = input.trim().split("\n")[0]?.slice(0, 300);
    return target ? { target } : undefined;
  }
  const value = record(input);
  const path = targetPath(input);
  const pattern = text(value.pattern, value.query, value.regex, value.glob, value.search);
  if (pattern)
    return { target: path ? `${pattern} in ${path}` : pattern, ...(path ? { path } : {}) };
  return path ? { target: path, path } : undefined;
}

function todoStatus(value: unknown): ToolTodoStatus {
  const key = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (key === "inprogress" || key === "active" || key === "doing") return "in_progress";
  if (key === "completed" || key === "complete" || key === "done") return "completed";
  if (key === "failed" || key === "error" || key === "cancelled" || key === "blocked")
    return "failed";
  return "pending";
}

function todoEntries(value: unknown, depth = 0): ToolTodoEntry[] {
  if (depth > 3 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    const direct = value.flatMap((item, index) => {
      const entry = record(item);
      const content = text(entry.content, entry.step, entry.text, entry.title);
      if (!content) return [];
      return [
        {
          id: text(entry.id, entry.step) ?? String(index),
          content,
          status: todoStatus(entry.status ?? entry.state),
        },
      ];
    });
    if (direct.length) return direct;
    return value.flatMap((item) => todoEntries(item, depth + 1));
  }
  const item = record(value);
  for (const key of ["todos", "plan", "steps", "items", "entries"]) {
    const entries = todoEntries(item[key], depth + 1);
    if (entries.length) return entries;
  }
  return [];
}

function questions(input: unknown): ToolQuestion[] {
  const value = record(input);
  const raw = Array.isArray(value.questions) ? value.questions : [value];
  return raw.flatMap((item) => {
    const entry = record(item);
    const question = text(entry.question, entry.prompt, entry.text, entry.message);
    if (!question) return [];
    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((option) => {
          const label =
            typeof option === "string" ? option : text(record(option).label, record(option).value);
          return label ? [label] : [];
        })
      : [];
    const header = text(entry.header);
    return [{ question, options, ...(header ? { header } : {}) }];
  });
}

function browserAction(input: unknown): { action: string; target?: string } | undefined {
  const value = record(input);
  const action = text(value.action, value.command, value.operation, value.method) ?? "Browse";
  const target = text(
    value.url,
    value.selector,
    value.text,
    value.query,
    value.target,
    value.element,
  );
  return { action, ...(target ? { target } : {}) };
}

function base64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function imageFromDataUrl(mime: string, data: string): ToolImage | undefined {
  if (!IMAGE_MIME.test(mime)) return undefined;
  const bytes = base64Bytes(data);
  if (bytes <= 0 || bytes > MAX_TOOL_IMAGE_BYTES) return undefined;
  return { src: `data:${mime.toLowerCase()};base64,${data}`, bytes };
}

function collectImages(value: unknown, seen: Set<string>, out: ToolImage[], depth = 0): void {
  if (out.length >= MAX_TOOL_IMAGES || depth > 6) return;
  if (typeof value === "string") {
    for (const match of value.matchAll(DATA_URL)) {
      const image = match[1] && match[2] ? imageFromDataUrl(match[1], match[2]) : undefined;
      if (image && !seen.has(image.src)) {
        seen.add(image.src);
        out.push(image);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImages(item, seen, out, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  const item = record(value);
  if ((item.type === "image" || item.type === "base64") && typeof item.data === "string") {
    const mime = text(item.mimeType, item.media_type, item.mediaType);
    const image = mime ? imageFromDataUrl(mime, item.data) : undefined;
    if (image && !seen.has(image.src)) {
      seen.add(image.src);
      out.push(image);
    }
  }
  const nestedKeys = [
    "image_url",
    "input_image",
    "source",
    "image",
    "content",
    "result",
    "data",
    "url",
  ];
  for (const key of nestedKeys) {
    const nested = item[key];
    // A provider URL that is not a data URL is never loaded.
    if (typeof nested === "string" && (key === "image_url" || key === "url")) {
      if (!nested.startsWith("data:")) continue;
      for (const match of nested.matchAll(DATA_URL)) {
        const image = match[1] && match[2] ? imageFromDataUrl(match[1], match[2]) : undefined;
        if (image && !seen.has(image.src)) {
          seen.add(image.src);
          out.push(image);
        }
      }
      continue;
    }
    collectImages(nested, seen, out, depth + 1);
  }
}

/**
 * Inline images are decoded from the result itself, never fetched: a remote URL
 * in tool output stays text. SVG is excluded because it can carry script.
 */
export function toolImages(result: string | undefined): ToolImage[] {
  if (!result || result.length < 32) return [];
  const out: ToolImage[] = [];
  const seen = new Set<string>();
  collectImages(result, seen, out);
  try {
    collectImages(JSON.parse(result), seen, out);
  } catch {}
  return out.slice(0, MAX_TOOL_IMAGES);
}

/** Keeps a base64 image out of the readable result text once it renders as a figure. */
export function stripInlineImages(result: string): string {
  if (!result.includes(";base64,")) return result;
  return result.replace(DATA_URL, "[image]").trim();
}

function cleanHref(value: string): string {
  return value.replace(/[.,;:)\]}'"]+$/, "");
}

export function pullRequestLinks(output: string): ToolLink[] {
  const links: ToolLink[] = [];
  const seen = new Set<string>();
  for (const match of output.matchAll(PULL_REQUEST)) {
    const href = cleanHref(match[0]);
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ href, label: `PR ${href.split("/").pop() ?? ""}` });
    if (links.length >= 3) break;
  }
  return links;
}

const BRANCH_PATTERNS = [
  /^\s*On branch ([^\s'"]+)/m,
  /^\s*Switched to a new branch '([^']+)'/m,
  /^\s*Switched to branch '([^']+)'/m,
  /^\s*Already on '([^']+)'/m,
];

/** The branch a Git result names, if it names one. */
export function resultBranch(command: string, output: string): string | undefined {
  if (!/^\s*git\b/.test(command)) return undefined;
  for (const pattern of BRANCH_PATTERNS) {
    const match = pattern.exec(output);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

const FILE_PATTERNS = [
  /^\+\+\+ b\/(.+)$/gm,
  /^--- a\/(.+)$/gm,
  /^modified:\s+(.+)$/gm,
  /^new file:\s+(.+)$/gm,
  /^deleted:\s+(.+)$/gm,
  /^\s{0,2}[MADRCU?!]{1,2}\s+(.+)$/gm,
];

/** Paths a Git result lists. Only called for `git` commands, so log lines are not links. */
export function resultFiles(command: string, output: string): string[] {
  if (!/^\s*git\b/.test(command)) return [];
  const files: string[] = [];
  const seen = new Set<string>();
  for (const pattern of FILE_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      const path = match[1]?.trim();
      if (!path || seen.has(path) || path.includes("=>") || /^https?:/i.test(path)) continue;
      if (path === "/dev/null") continue;
      seen.add(path);
      files.push(path);
      if (files.length >= MAX_LINK_FILES) return files;
    }
  }
  return files;
}

export function toolDetail(view: ToolView): string {
  if (view.kind === "read" || view.kind === "search") return view.target;
  if (view.kind === "edit" || view.kind === "write")
    return view.files.map((file) => file.path).join(", ");
  if (view.kind === "run") return view.command.split("\n")[0] ?? "";
  if (view.kind === "mcp") return view.server ? `${view.server}: ${view.tool}` : view.tool;
  if (view.kind === "browser") return view.target ? `${view.action} ${view.target}` : view.action;
  if (view.kind === "todo" || view.kind === "plan") {
    const done = view.entries.filter((entry) => entry.status === "completed").length;
    return `${done} of ${view.entries.length} steps`;
  }
  if (view.kind === "question") return view.questions[0]?.question ?? "Question";
  return "";
}

export function toolView(tool: ChatTool): ToolView {
  const origin = toolOrigin(tool.name);
  const input = parseInput(tool.input);
  if (origin.mcp)
    return {
      kind: "mcp",
      tool: toolKey(origin.key) || tool.name,
      ...(origin.server ? { server: origin.server } : {}),
    };
  const key = origin.key;
  if (TODO_TOOLS.has(key)) {
    const entries = todoEntries(input);
    if (entries.length) return { kind: "todo", entries };
  }
  if (PLAN_TOOLS.has(key)) {
    const entries = todoEntries(input);
    const title = text(record(input).title, record(input).explanation);
    if (entries.length)
      return { kind: "plan", entries, ...(title && title.length <= 200 ? { title } : {}) };
  }
  if (QUESTION_TOOLS.has(key)) {
    const asked = questions(input);
    if (asked.length) return { kind: "question", questions: asked };
  }
  if (BROWSER_TOOLS.has(key)) {
    const browser = browserAction(input);
    if (browser) return { kind: "browser", ...browser };
  }
  if (WRITE_TOOLS.has(key)) {
    const files = writeFiles(input);
    if (files.length) return { kind: "write", files };
  }
  if (EDIT_TOOLS.has(key)) {
    const files = editFiles(input);
    if (files.length) return { kind: "edit", files };
  }
  if (RUN_TOOLS.has(key)) {
    const command = commandText(input);
    if (command)
      return {
        kind: "run",
        command,
        ...outputTail(tool.result === undefined ? "" : stripInlineImages(tool.result)),
      };
  }
  if (SEARCH_TOOLS.has(key)) {
    const target = searchTarget(input);
    if (target) return { kind: "search", ...target };
  }
  if (READ_TOOLS.has(key)) {
    const target = readTarget(input);
    if (target) return { kind: "read", ...target };
  }
  return { kind: "generic" };
}
