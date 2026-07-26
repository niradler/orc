import { probeBackends } from "@orc/agent-runtime";
import { loadConfig } from "@orc/core/config";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";

const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

/**
 * Answers "which coding agents can this install actually run, and what do I
 * install to fix the rest?" - which previously required starting a task and
 * reading the failure. Runs locally against the registry, so it works with no
 * API server up.
 */
export function doctorCommand() {
  return new Command("doctor")
    .description("Check which agent backends are usable on this machine")
    .action(async () => {
      const config = loadConfig();
      const probes = await probeBackends();
      const defaultBackend = config.agent_loop.default_backend;

      if (isJson()) {
        return jsonOut({ backends: probes, default_backend: defaultBackend });
      }

      const usable = probes.filter((p) => p.available);
      console.log(`Agent backends  ${usable.length}/${probes.length} usable`);
      console.log("");

      for (const probe of [...probes].sort((a, b) => a.name.localeCompare(b.name))) {
        const mark = probe.available ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m";
        const isDefault = probe.name === defaultBackend ? " (default)" : "";
        console.log(`${mark} ${probe.name}${isDefault}  ${DIM}${probe.kind}${RESET}`);
        if (probe.target) {
          const source = probe.source ? ` ${DIM}[${probe.source}]${RESET}` : "";
          const version = probe.version ? ` ${DIM}${probe.version}${RESET}` : "";
          console.log(`    ${probe.target}${source}${version}`);
        }
        if (!probe.available) {
          console.log(`    ${DIM}needs:${RESET} ${probe.requires || "—"}`);
          if (probe.error) console.log(`    \x1b[31m${probe.error}\x1b[0m`);
        }
      }

      if (!usable.some((p) => p.name === defaultBackend)) {
        console.log("");
        console.log(
          `\x1b[33mThe default backend "${defaultBackend}" is not usable.\x1b[0m ` +
            "Tasks will fail to start until it is, or until agent_loop.default_backend " +
            "names one of the usable backends above.",
        );
      }

      // A task can name any agent: unknown names are passed to acpx as its agent
      // identifier, so acpx being usable is what makes gemini/codex/etc reachable.
      const acpx = probes.find((p) => p.name === "acpx");
      if (acpx && !acpx.available) {
        console.log("");
        console.log(
          `${DIM}Without acpx, agents reached through it (gemini, codex, …) are unavailable; ` +
            `the built-in claude backend does not need it.${RESET}`,
        );
      }
    });
}
