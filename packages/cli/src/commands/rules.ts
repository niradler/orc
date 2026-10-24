import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "@orc/core/config";
import { runHumanRuleActions } from "@orc/core/human-request-client";
import { runRuleBuiltinActions } from "@orc/core/rule-builtin";
import { copyRuleTemplate, RULE_CATALOG } from "@orc/core/rule-catalog";
import { RULE_EVENT_ADAPTERS } from "@orc/core/rule-events";
import { normalizeRuleHook, type RuleHookBackend, ruleHookOutput } from "@orc/core/rule-hooks";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
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
    .command("catalog [template]")
    .option("--workspace <path>", "Wrap the selected template in a workspace policy draft")
    .description("List reusable templates or export one as JSON; does not activate rules")
    .action((id: string | undefined, opts: { workspace?: string }) => {
      if (!id) {
        console.log(
          JSON.stringify(
            RULE_CATALOG.map(({ rule: _rule, ...metadata }) => metadata),
            null,
            2,
          ),
        );
        return;
      }
      const rule = copyRuleTemplate(id);
      console.log(
        JSON.stringify(
          opts.workspace
            ? { workspace: resolve(opts.workspace), project_id: null, rules: [rule] }
            : rule,
          null,
          2,
        ),
      );
    });
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
        if (!Object.hasOwn(RULE_EVENT_ADAPTERS, backend))
          throw new Error("Unsupported hook backend");
        const raw = readFileSync(0, "utf8");
        if (Buffer.byteLength(raw) > 1_100_000) throw new Error("Rule hook input too large");
        const normalized = normalizeRuleHook(backend as RuleHookBackend, event, JSON.parse(raw));
        if (normalized.phase === "post_tool" || normalized.phase === "post_tool_failure")
          new HumanRequestStore(getSqlite()).acknowledgeToolResults(
            normalized.session_id,
            normalized.backend,
            normalized.id,
          );
        if (normalized.phase === "stop")
          new HumanRequestStore(getSqlite()).acknowledgeDeniedAtStop(
            normalized.session_id,
            normalized.backend,
          );
        const store = new RuleStore(getSqlite());
        const result = await runHumanRuleActions(
          normalized,
          await runRuleBuiltinActions(normalized, store.evaluateCommand(normalized)),
        );
        for (const error of result.action_errors ?? [])
          console.error(`${error.rule_id}: ${error.reason}`);
        console.log(JSON.stringify(ruleHookOutput(backend as RuleHookBackend, normalized, result)));
        if (result.decision === "deny" && normalized.phase !== "permission_request") {
          console.error(
            result.reasons.map((reason) => `${reason.rule_id}: ${reason.reason}`).join("; "),
          );
          process.exitCode = 2;
        }
      } catch (error) {
        console.error(`ORC rule hook blocked: ${String(error)}`);
        if (backend === "claude" && event === "PermissionRequest")
          console.log(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: event,
                decision: { behavior: "deny", message: "ORC human response unavailable" },
              },
            }),
          );
        else process.exitCode = 2;
      }
    });
  command
    .command("install-hook <backend>")
    .requiredOption("--target <settings-file>")
    .option(
      "--legacy-hooks-dir <directory>",
      "Replace only ORC continuity handlers in this explicit directory; preserve other handlers",
    )
    .option(
      "--events <events>",
      "Comma-separated shared or native event names; defaults to all supported events",
    )
    .option(
      "--timeout-seconds <seconds>",
      "Native command hook timeout; set above the Ask user request lifetime",
      "10",
    )
    .description(
      "Merge native hooks into an explicit JSON settings target; existing hooks preserved",
    )
    .action((backend, opts) => {
      if (!Object.hasOwn(RULE_EVENT_ADAPTERS, backend)) throw new Error("Unsupported hook backend");
      const hookTimeout = Number(opts.timeoutSeconds);
      if (!Number.isInteger(hookTimeout) || hookTimeout < 1 || hookTimeout > 604815)
        throw new Error("Hook timeout must be an integer from 1 to 604815 seconds");
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
      if (backend === "cursor" && settings.version !== undefined && settings.version !== 1)
        throw new Error("Unsupported Cursor hook settings version");
      if (backend !== "cursor" && settings.version !== undefined)
        throw new Error(
          "This target appears to be a Cursor hooks file; select this agent's JSON settings file",
        );
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
      const catalog = RULE_EVENT_ADAPTERS[backend as RuleHookBackend];
      const requested: string[] | undefined = opts.events
        ?.split(",")
        .map((event: string) => event.trim());
      if (
        requested?.some(
          (event) =>
            !catalog.some(
              (entry) =>
                entry.event === event ||
                entry.native === event ||
                `native:${entry.native}` === event,
            ),
        )
      )
        throw new Error("Unsupported selected event");
      for (const { native: event } of catalog.filter(
        (entry) =>
          !requested ||
          requested.includes(entry.event) ||
          requested.includes(entry.native) ||
          requested.includes(`native:${entry.native}`),
      )) {
        const previousEntries = hooks[event] ?? [];
        if (!Array.isArray(previousEntries)) throw new Error("Hook entries must be arrays");
        const legacyPaths = opts.legacyHooksDir
          ? ["session-start.ts", "post-tool-use.ts", "pre-compact.ts"].map((file) =>
              resolve(opts.legacyHooksDir, file).replaceAll("\\", "/").toLowerCase(),
            )
          : [];
        const isLegacy = (handler: Record<string, unknown>): boolean => {
          if (!handler || typeof handler !== "object") return false;
          const handlerCommand = handler.command;
          return (
            typeof handlerCommand === "string" &&
            legacyPaths.some((path) => {
              const command = handlerCommand.replaceAll("\\", "/").toLowerCase();
              const offset = command.indexOf(path);
              return (
                offset >= 0 &&
                (offset === 0 || /[\s"']/.test(command[offset - 1] ?? "")) &&
                (offset + path.length === command.length ||
                  /[\s"']/.test(command[offset + path.length] ?? ""))
              );
            })
          );
        };
        const entries = previousEntries.flatMap((entry: Record<string, unknown>) => {
          if (!entry || typeof entry !== "object") throw new Error("Hook entries must be objects");
          if (isLegacy(entry)) return [];
          if (!Array.isArray(entry.hooks)) return [entry];
          const handlers = entry.hooks.filter(
            (handler: Record<string, unknown>) => !isLegacy(handler),
          );
          return handlers.length ? [{ ...entry, hooks: handlers }] : [];
        });
        const hookCommand = `${prefix} --db ${quote(loadConfig().db.path)} rules hook ${backend} ${event}`;
        const existing = entries.findIndex(
          (entry: unknown) =>
            typeof entry === "object" &&
            entry !== null &&
            (("command" in entry && entry.command === hookCommand) ||
              ("hooks" in entry &&
                Array.isArray(entry.hooks) &&
                entry.hooks.some(
                  (handler: Record<string, unknown>) => handler.command === hookCommand,
                ))),
        );
        hooks[event] =
          existing < 0
            ? [
                ...entries,
                backend === "cursor"
                  ? { command: hookCommand, timeout: hookTimeout, failClosed: true }
                  : {
                      hooks: [
                        {
                          type: "command",
                          command: hookCommand,
                          timeout: backend === "gemini" ? hookTimeout * 1000 : hookTimeout,
                          ...(backend === "claude" ? { onFailure: "block" } : {}),
                        },
                      ],
                    },
              ]
            : entries.map((entry: Record<string, unknown>, index: number) =>
                index === existing && backend === "cursor"
                  ? { ...entry, timeout: hookTimeout, failClosed: true }
                  : index === existing && Array.isArray(entry.hooks)
                    ? {
                        ...entry,
                        hooks: entry.hooks.map((handler: Record<string, unknown>) =>
                          handler.command === hookCommand
                            ? {
                                ...handler,
                                timeout: backend === "gemini" ? hookTimeout * 1000 : hookTimeout,
                              }
                            : handler,
                        ),
                      }
                    : entry,
              );
      }
      mkdirSync(dirname(target), { recursive: true });
      if (previous) writeFileSync(`${target}.${Date.now()}.bak`, previous, { mode: 0o600 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      writeFileSync(
        temporary,
        `${JSON.stringify({ ...settings, ...(backend === "cursor" ? { version: 1 } : {}), hooks }, null, 2)}\n`,
        {
          mode: 0o600,
          flag: "wx",
        },
      );
      renameSync(temporary, target);
      console.log(
        `Installed ${backend} rule hooks in ${target}. Host version, hook trust, and failure behavior must be qualified before relying on enforcement.`,
      );
    });
  return command;
}
