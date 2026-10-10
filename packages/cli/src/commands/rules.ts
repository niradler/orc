import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "@orc/core/config";
import { normalizeRuleHook, type RuleHookBackend, ruleHookOutput } from "@orc/core/rule-hooks";
import { getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { createOrcClient } from "@orc/sdk";
import { Command } from "commander";

function output(result: { data: unknown; error: { error: string } | null }): void {
  if (result.error) throw new Error(result.error.error);
  console.log(JSON.stringify(result.data, null, 2));
}

export function rulesCommand(): Command {
  const command = new Command("rules").description(
    "Workspace policies, decision history and native event hooks",
  );
  command
    .command("list")
    .option("--workspace <path>")
    .action(async (opts) => output(await createOrcClient().rules.list(opts.workspace)));
  command
    .command("activate <file>")
    .option("--expected <revision>")
    .requiredOption("--reason <reason>")
    .action(async (file, opts) => {
      const policy = JSON.parse(readFileSync(resolve(file), "utf8"));
      output(await createOrcClient().rules.activate(policy, opts.expected ?? null, opts.reason));
    });
  command
    .command("revert <revision>")
    .requiredOption("--reason <reason>")
    .action(async (id, opts) => output(await createOrcClient().rules.revert(id, opts.reason)));
  command
    .command("check <file>")
    .action(async (file) =>
      output(await createOrcClient().rules.check(JSON.parse(readFileSync(resolve(file), "utf8")))),
    );
  command
    .command("hook <backend> <event>")
    .description("Native hook stdin/stdout protocol; denied/error exit 2")
    .action(async (backend, event) => {
      try {
        if (!["claude", "cursor", "gemini"].includes(backend))
          throw new Error("Unsupported hook backend");
        const decoder = new TextDecoder();
        let raw = "";
        let size = 0;
        for await (const chunk of Bun.stdin.stream()) {
          size += chunk.byteLength;
          if (size > 1_100_000) throw new Error("Rule hook input too large");
          raw += decoder.decode(chunk, { stream: true });
        }
        raw += decoder.decode();
        const normalized = normalizeRuleHook(backend as RuleHookBackend, event, JSON.parse(raw));
        const result = new RuleStore(getSqlite()).evaluate(normalized);
        console.log(JSON.stringify(ruleHookOutput(backend as RuleHookBackend, normalized, result)));
        if (result.decision === "deny") process.exitCode = 2;
      } catch (error) {
        console.error(`ORC rule hook blocked: ${String(error)}`);
        process.exitCode = 2;
      }
    });
  command
    .command("install-hook <backend>")
    .requiredOption("--target <settings-file>")
    .description("Merge Cursor hooks into explicit settings target; existing hooks preserved")
    .action((backend, opts) => {
      if (backend !== "cursor")
        throw new Error(
          "Only Cursor failClosed installation is supported. Claude SDK sessions need no installer; native Claude/Gemini failure semantics need version qualification.",
        );
      const target = resolve(opts.target);
      let previous = "";
      try {
        previous = readFileSync(target, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const settings = previous ? JSON.parse(previous) : {};
      if (!settings || typeof settings !== "object" || Array.isArray(settings))
        throw new Error("Settings must be an object");
      if (settings.version !== undefined && settings.version !== 1)
        throw new Error("Unsupported Cursor hook settings version");
      const quote = (s: string) => {
        if (/[\r\n"$`%]/.test(s))
          throw new Error("Hook command path contains unsupported shell characters");
        return `"${s}"`;
      };
      const prefix = Bun.embeddedFiles.length
        ? quote(process.execPath)
        : `${quote(process.execPath)} ${quote(resolve(process.argv[1] ?? ""))}`;
      const hooks = settings.hooks ?? {};
      if (!hooks || typeof hooks !== "object" || Array.isArray(hooks))
        throw new Error("hooks must be an object");
      for (const event of [
        "sessionStart",
        "preToolUse",
        "postToolUse",
        "postToolUseFailure",
        "sessionEnd",
      ]) {
        const entries = hooks[event] ?? [];
        if (!Array.isArray(entries)) throw new Error("Hook entries must be arrays");
        const hookCommand = `${prefix} --db ${quote(loadConfig().db.path)} rules hook cursor ${event}`;
        const existing = entries.findIndex(
          (entry: unknown) =>
            typeof entry === "object" &&
            entry !== null &&
            "command" in entry &&
            entry.command === hookCommand,
        );
        hooks[event] =
          existing < 0
            ? [...entries, { command: hookCommand, timeout: 10, failClosed: true }]
            : entries.map((entry: Record<string, unknown>, index: number) =>
                index === existing ? { ...entry, timeout: 10, failClosed: true } : entry,
              );
      }
      mkdirSync(dirname(target), { recursive: true });
      if (previous) writeFileSync(`${target}.${Date.now()}.bak`, previous, { mode: 0o600 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ ...settings, version: 1, hooks }, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, target);
      console.log(
        `Installed Cursor rule hooks in ${target}. Validate host failClosed support before relying on enforcement.`,
      );
    });
  return command;
}
