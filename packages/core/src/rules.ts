import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ruleEventCapability } from "./rule-events.js";
import { matchesRuleFilter } from "./rule-filters.js";

export type {
  RuleDecision,
  RuleEvent,
  RulePolicy,
  RuleRevision,
} from "./rule-types.js";
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

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "write_file", "replace", "WriteFile"]);

function string(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) if (typeof input[key] === "string") return input[key] as string;
  return null;
}

export function evaluateRules(
  policy: RulePolicy,
  event: RuleEvent,
  protectedPaths: readonly string[] = [],
): RuleDecision {
  const result: RuleDecision = {
    decision: "abstain",
    reasons: [],
    context: [],
    jobs: [],
  };
  const root = canonicalWorkspace(policy.workspace);
  if (!withinWorkspace(root, canonicalWorkspace(event.cwd))) return result;
  const deny = (id: string, reason: string): void => {
    result.decision = "deny";
    result.reasons.push({ rule_id: id, reason });
  };
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
            rule.target.type === "script" || rule.target.type === "rewrite_command"
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
    } else if (target.type === "job") result.jobs.push({ rule_id: rule.id, job_id: target.job_id });
    else if (target.type === "rewrite_command") {
      if (!capability?.rewrite_command) throw new Error("Agent event cannot rewrite commands");
      result.command_processors ??= [];
      result.command_processors.push({ rule_id: rule.id, target });
    } else if (target.type === "orc_action") {
      result.orc_actions ??= [];
      result.orc_actions.push({ rule_id: rule.id, target });
    } else if (target.type === "ask_user") {
      result.human_requests ??= [];
      result.human_requests.push({ rule_id: rule.id, target });
    } else {
      result.scripts ??= [];
      result.scripts.push({ rule_id: rule.id, target });
    }
  }
  return result;
}
