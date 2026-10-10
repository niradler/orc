import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { ruleEventCapability } from "./rule-events.js";
import { matchesRuleFilter } from "./rule-filters.js";

export type { RuleDecision, RuleEvent, RulePolicy, RuleRevision } from "./rule-types.js";
export { RuleEventSchema, RulePolicySchema, RuleSchema } from "./rule-types.js";

import type { RuleDecision, RuleEvent, RulePolicy } from "./rule-types.js";

export function canonicalWorkspace(path: string): string {
  const actual = realpathSync(resolve(path));
  if (!statSync(actual).isDirectory()) throw new Error("Workspace must be a directory");
  return actual;
}

function editTarget(path: string): string {
  let parent = path;
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) throw new Error("Cannot resolve file target");
    parent = next;
  }
  return resolve(realpathSync(parent), relative(parent, path));
}

function controlPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.split("/").includes(".orc") ||
    /(?:^|\/)(?:\.claude\/settings(?:\.local)?\.json|\.cursor\/hooks\.json|\.gemini\/settings\.json|\.codex\/(?:hooks\.json|config\.toml))$/.test(
      normalized,
    )
  );
}

export function withinWorkspace(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

const READ_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "read_file",
  "list_directory",
  "grep_search",
  "glob",
  "ReadFile",
  "Search",
  "mcp__orc__context",
  "mcp__orc__memory_search",
  "mcp__orc__memory_get",
  "mcp__orc__wiki_search",
  "mcp__orc__wiki_read",
  "mcp__orc__skill_read",
  "mcp__orc__skill_list",
  "mcp__orc__flow_report",
  "mcp__orc__session_log",
  "mcp__orc__session_event",
  "mcp__orc__task_get",
]);
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "write_file", "replace", "WriteFile"]);

function string(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) if (typeof input[key] === "string") return input[key] as string;
  return null;
}

function proposedFile(
  event: RuleEvent,
  root: string,
): { path: string; before: string; after: string } {
  const file = string(event.input, "file_path", "path");
  if (!file) throw new Error("Edit lacks a supported file path");
  const path = resolve(event.cwd, file);
  const actual = existsSync(path) ? realpathSync(path) : canonicalWorkspace(resolve(path, ".."));
  if (!withinWorkspace(root, actual)) throw new Error("File is outside the policy workspace");
  if (existsSync(path)) {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 1_000_000)
      throw new Error("Comment checking requires a bounded regular file");
  }
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (before.length > 1_000_000) throw new Error("File exceeds comment-check size limit");
  let after = string(event.input, "content");
  if (after === null) {
    after = before;
    const edits = event.tool === "MultiEdit" ? event.input.edits : [event.input];
    if (!Array.isArray(edits) || edits.length > 100) throw new Error("Unsupported edit payload");
    for (const raw of edits) {
      if (!raw || typeof raw !== "object") throw new Error("Malformed edit");
      const edit = raw as Record<string, unknown>;
      const oldText = string(edit, "old_string", "oldText");
      const newText = string(edit, "new_string", "newText");
      if (!oldText || newText === null || !after.includes(oldText))
        throw new Error("Edit cannot be reconstructed");
      if (edit.replace_all === true) after = after.split(oldText).join(newText);
      else {
        if (after.indexOf(oldText) !== after.lastIndexOf(oldText))
          throw new Error("Ambiguous edit");
        after = after.replace(oldText, () => newText);
      }
    }
  }
  if (after.length > 1_000_000) throw new Error("Edit exceeds comment-check size limit");
  return { path, before, after };
}

export function commentTokens(path: string, content: string): string[] {
  if (!/\.[cm]?[jt]sx?$/i.test(path))
    throw new Error("Comment checking supports JavaScript/TypeScript only");
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics.length) throw new Error("Cannot check comments in syntactically invalid code");
  const literals = new Map<number, number>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateLiteralToken(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isJsxText(node)
    )
      literals.set(node.getStart(source), node.end);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, source.languageVariant, content);
  const comments: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const end = literals.get(scanner.getTokenPos());
    if (end !== undefined) scanner.setTextPos(end);
    else if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    )
      comments.push(scanner.getTokenText());
  }
  return comments;
}

function newComments(file: { path: string; before: string; after: string }): boolean {
  const counts = new Map<string, number>();
  for (const token of commentTokens(file.path, file.before))
    counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of commentTokens(file.path, file.after)) {
    const count = counts.get(token) ?? 0;
    if (!count) return true;
    counts.set(token, count - 1);
  }
  return false;
}

export function evaluateRules(
  policy: RulePolicy,
  event: RuleEvent,
  protectedPaths: readonly string[] = [],
): RuleDecision {
  const result: RuleDecision = { decision: "abstain", reasons: [], context: [], jobs: [] };
  const root = canonicalWorkspace(policy.workspace);
  if (!withinWorkspace(root, canonicalWorkspace(event.cwd))) return result;
  const deny = (id: string, reason: string): void => {
    result.decision = "deny";
    result.reasons.push({ rule_id: id, reason });
  };
  let comments: boolean | Error | undefined;
  if (event.phase === "pre_tool" && EDIT_TOOLS.has(event.tool ?? "")) {
    const file = string(event.input, "file_path", "path");
    if (file) {
      const path = resolve(event.cwd, file);
      const actual = editTarget(path);
      if (controlPath(path) || controlPath(actual)) {
        deny("orc-control-settings", "Agent cannot edit policy or hook configuration");
        return result;
      }
      if (
        [
          ...protectedPaths,
          ...policy.rules.flatMap((rule) =>
            rule.kind === "event" && rule.target.type === "script"
              ? rule.target.argv
                  .filter((arg) => existsSync(resolve(event.cwd, arg)))
                  .map((arg) => resolve(event.cwd, arg))
              : [],
          ),
        ].some(
          (p) =>
            p !== ":memory:" &&
            relative(existsSync(p) ? realpathSync(p) : resolve(p), actual) === "",
        )
      ) {
        deny("orc-control-storage", "Agent cannot edit ORC policy storage");
        return result;
      }
    }
  }
  for (const rule of policy.rules) {
    if (rule.kind === "event") {
      if (
        !rule.enabled ||
        (rule.scope.agents !== "all" &&
          !rule.scope.agents.includes(event.backend as "claude" | "cursor" | "gemini" | "codex"))
      )
        continue;
      if (
        !rule.scope.events.some(
          (name) => name === event.phase || name === `native:${event.native_event}`,
        )
      )
        continue;
      if (!matchesRuleFilter(rule.filter, event)) continue;
      const capability = ruleEventCapability(
        event.backend,
        event.native_event ? `native:${event.native_event}` : event.phase,
      );
      const target = rule.target;
      if (target.type === "block") {
        if (!capability?.block) throw new Error("Agent event does not support blocking");
        deny(rule.id, rule.reason);
      } else if (target.type === "inject_context") {
        if (!capability?.context) throw new Error("Agent event does not support context injection");
        result.context.push(target.content);
      } else if (target.type === "job")
        result.jobs.push({ rule_id: rule.id, job_id: target.job_id });
      else {
        result.scripts ??= [];
        result.scripts.push({ rule_id: rule.id, target });
      }
      continue;
    }
    if (rule.kind === "context" && event.phase === "session_start")
      result.context.push(rule.content);
    if (
      rule.kind === "enqueue_job" &&
      event.phase === rule.event &&
      !event.failed &&
      (!rule.tools.length || (event.tool && rule.tools.includes(event.tool)))
    )
      result.jobs.push({ rule_id: rule.id, job_id: rule.job_id });
    if (event.phase !== "pre_tool") continue;
    const tool = event.tool ?? "";
    if (rule.kind === "deny_tools" && rule.tools.includes(tool)) deny(rule.id, rule.reason);
    if (rule.kind === "deny_delete" || rule.kind === "deny_comments") {
      if (READ_TOOLS.has(tool)) continue;
      if (!EDIT_TOOLS.has(tool)) {
        deny(
          rule.id,
          `${rule.reason}: tool ${tool || "unknown"} has no verified structured-edit coverage`,
        );
        continue;
      }
      try {
        const file = string(event.input, "file_path", "path");
        if (!file) throw new Error("Missing file path");
        const path = resolve(event.cwd, file);
        const actual = existsSync(path)
          ? realpathSync(path)
          : canonicalWorkspace(resolve(path, ".."));
        if (!withinWorkspace(root, actual)) throw new Error("File is outside the policy workspace");
        if (existsSync(path) && !statSync(path).isFile())
          throw new Error("Structured edits require a regular file");
      } catch (error) {
        deny(
          rule.id,
          `${rule.reason}: ${error instanceof Error ? error.message : "unverified path"}`,
        );
        continue;
      }
      if (rule.kind === "deny_comments") {
        try {
          if (comments === undefined) {
            try {
              comments = newComments(proposedFile(event, root));
            } catch (error) {
              comments = error instanceof Error ? error : new Error("Cannot validate edit");
            }
          }
          if (comments instanceof Error) throw comments;
          if (comments) deny(rule.id, rule.reason);
        } catch (error) {
          deny(
            rule.id,
            `${rule.reason}: ${error instanceof Error ? error.message : "cannot validate edit"}`,
          );
        }
      }
    }
  }
  return result;
}
