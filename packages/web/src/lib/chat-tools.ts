import type { ChatActivity } from "@orc/core/chat";
import { structuredPatch } from "diff";

export type ChatTool = Extract<ChatActivity, { type: "tool" }>;
export type ToolFileChange = { path: string; diff: string; added: number; removed: number };
export type ToolView =
  | { kind: "edit"; files: ToolFileChange[] }
  | { kind: "command"; command: string; tail: string; hidden: number }
  | { kind: "lookup"; target: string }
  | { kind: "generic" };

const EDIT_TOOLS = new Set([
  "edit",
  "multiedit",
  "write",
  "replace",
  "write_file",
  "edit_file",
  "create_file",
  "str_replace",
  "filechange",
  "file_change",
  "apply_patch",
  "patch",
]);
const COMMAND_TOOLS = new Set([
  "bash",
  "shell",
  "sh",
  "powershell",
  "exec",
  "exec_command",
  "command",
  "command_execution",
  "commandexecution",
  "run_shell_command",
  "run_command",
  "terminal",
]);
const LOOKUP_TOOLS = new Set([
  "read",
  "read_file",
  "read_many_files",
  "view",
  "cat",
  "ls",
  "list",
  "list_directory",
  "glob",
  "find",
  "find_files",
  "grep",
  "search",
  "search_file_content",
  "codesearch",
  "websearch",
  "web_search",
  "webfetch",
  "web_fetch",
  "fetch",
]);
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

function diffFile(path: string, diff: string): ToolFileChange {
  return { path, diff, ...countChanges(diff) };
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
          }
        : file,
    );
  }
  return [...merged.values()];
}

export function parseApplyPatch(patch: string): ToolFileChange[] {
  const files: ToolFileChange[] = [];
  let current: { path: string; lines: string[] } | null = null;
  const flush = () => {
    if (current) files.push(diffFile(current.path, current.lines.join("\n")));
  };
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
    if (header?.[1]) {
      flush();
      current = { path: header[1].trim(), lines: [] };
    } else if (current && !line.startsWith("***")) {
      current.lines.push(line.startsWith("@@") && !/^@@ -\d/.test(line) ? "@@ -1 +1 @@" : line);
    }
  }
  flush();
  return mergeFiles(files);
}

function editFiles(input: unknown): ToolFileChange[] {
  if (typeof input === "string") return input.includes("*** ") ? parseApplyPatch(input) : [];
  if (Array.isArray(input))
    return mergeFiles(
      input.flatMap((change) => {
        const item = record(change);
        const path = text(item.path, item.file_path, item.filePath);
        if (!path) return [];
        const diff = text(item.diff, item.unified_diff, item.patch);
        if (diff) return [diffFile(path, diff)];
        const content = text(item.content, item.new_content);
        return content === undefined ? [] : [patchFile(path, "", content)];
      }),
    );
  const value = record(input);
  if (Array.isArray(value.changes)) return editFiles(value.changes);
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
  if (diff) return [diffFile(path, diff)];
  const before = text(value.old_string, value.oldString, value.old_str) ?? "";
  const after = text(value.new_string, value.newString, value.new_str, value.content) ?? "";
  return before || after ? [patchFile(path, before, after)] : [];
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

function lookupTarget(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim().split("\n")[0]?.slice(0, 300) || undefined;
  const value = record(input);
  const path = text(
    value.file_path,
    value.filePath,
    value.absolute_path,
    value.path,
    value.dir_path,
    value.directory,
  );
  const pattern = text(value.pattern, value.query, value.regex, value.glob);
  if (pattern) return path ? `${pattern} in ${path}` : pattern;
  return path ?? text(value.url, value.target);
}

export function toolDetail(view: ToolView): string {
  if (view.kind === "edit") return view.files.map((file) => file.path).join(", ");
  if (view.kind === "command") return view.command.split("\n")[0] ?? "";
  if (view.kind === "lookup") return view.target;
  return "";
}

export function toolView(tool: ChatTool): ToolView {
  const key = toolKey(tool.name);
  const input = parseInput(tool.input);
  if (EDIT_TOOLS.has(key)) {
    const files = editFiles(input);
    if (files.length) return { kind: "edit", files };
  }
  if (COMMAND_TOOLS.has(key)) {
    const command = commandText(input);
    if (command) return { kind: "command", command, ...outputTail(tool.result ?? "") };
  }
  if (LOOKUP_TOOLS.has(key)) {
    const target = lookupTarget(input);
    if (target) return { kind: "lookup", target };
  }
  return { kind: "generic" };
}
