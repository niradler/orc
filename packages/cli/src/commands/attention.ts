import { readFileSync } from "node:fs";
import {
  HumanRequestInputSchema,
  HumanRespondPayloadSchema,
  parseSnoozeDurationSeconds,
} from "@orc/core/human-requests";
import { createOrcClient } from "@orc/sdk";
import type { ApiResult } from "@orc/sdk/types";
import { Command } from "commander";

function unwrap<T>(result: ApiResult<T>): T {
  if (result.error) throw new Error(result.error.error);
  return result.data;
}

function parseUntilTimestamp(raw: string): number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`Invalid --until timestamp "${raw}"; use ISO-8601 (e.g. 2026-11-25T09:00:00Z)`);
  return parsed;
}

export function attentionCommand(): Command {
  const command = new Command("attention").description("Questions and approvals waiting for you");
  command.command("list").action(async () => {
    console.log(JSON.stringify(unwrap(await createOrcClient().humanRequests.list()), null, 2));
  });
  command
    .command("get <id>")
    .option("--claim", "Claim one-time secret values if this is an answered secret request")
    .action(async (id: string, opts: { claim?: boolean }) => {
      const client = createOrcClient();
      const request = unwrap(await client.humanRequests.get(id));
      if (
        opts.claim &&
        request.input.kind === "secret" &&
        request.status === "answered" &&
        request.response?.kind === "secret" &&
        !request.response.consumed
      ) {
        console.log(JSON.stringify(unwrap(await client.humanRequests.claim(id)), null, 2));
        return;
      }
      console.log(JSON.stringify(request, null, 2));
    });
  command
    .command("request <file>")
    .description("Create an idempotent request from JSON; use - for stdin")
    .option("--wait", "Wait for the response")
    .action(async (file: string, opts: { wait?: boolean }) => {
      const input = HumanRequestInputSchema.parse(
        JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8")),
      );
      const client = createOrcClient();
      let request = unwrap(await client.humanRequests.create(input));
      if (opts.wait) {
        console.error(`Waiting for human request ${request.id}`);
        while (request.status === "pending") {
          await Bun.sleep(500);
          request = unwrap(await client.humanRequests.get(request.id));
        }
        if (request.status !== "answered")
          throw new Error(`Request ${request.status}; no response delivered`);
      }
      console.log(JSON.stringify(request, null, 2));
    });
  command
    .command("respond <id> <file>")
    .description("Submit a question answer or approval JSON; use - for stdin")
    .requiredOption("--version <number>", "Version displayed when reviewing the request")
    .action(async (id: string, file: string, opts: { version: string }) => {
      const response = HumanRespondPayloadSchema.parse(
        JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8")),
      );
      console.log(
        JSON.stringify(
          unwrap(await createOrcClient().humanRequests.respond(id, Number(opts.version), response)),
          null,
          2,
        ),
      );
    });
  for (const operation of ["acknowledge", "cancel"] as const) {
    command
      .command(`${operation} <id>`)
      .requiredOption("--version <number>")
      .action(async (id: string, opts: { version: string }) => {
        console.log(
          JSON.stringify(
            unwrap(await createOrcClient().humanRequests[operation](id, Number(opts.version))),
            null,
            2,
          ),
        );
      });
  }
  command
    .command("snooze <id>")
    .description("Snooze a pending request without answering or cancelling it")
    .option("--for <duration>", "Duration such as 15m, 1h, 3h, 1h30m")
    .option("--until <iso>", "ISO-8601 timestamp or epoch ms")
    .option("--version <number>", "Expected request version")
    .action(async (id: string, opts: { for?: string; until?: string; version?: string }) => {
      if (Boolean(opts.for) === Boolean(opts.until))
        throw new Error("Supply either --for <duration> or --until <iso>");
      const client = createOrcClient();
      const version =
        opts.version !== undefined
          ? Number(opts.version)
          : unwrap(await client.humanRequests.view(id)).version;
      let payload: { version: number; after_seconds?: number; until?: number };
      if (opts.for) {
        const seconds = parseSnoozeDurationSeconds(opts.for);
        if (!seconds)
          throw new Error(`Invalid duration "${opts.for}"; use values like 15m, 1h, 3h`);
        payload = { version, after_seconds: seconds };
      } else {
        payload = { version, until: parseUntilTimestamp(opts.until ?? "") };
      }
      console.log(JSON.stringify(unwrap(await client.humanRequests.snooze(id, payload)), null, 2));
    });
  command
    .command("unsnooze <id>")
    .description("Wake a snoozed pending request immediately")
    .option("--version <number>", "Expected request version")
    .action(async (id: string, opts: { version?: string }) => {
      const version = opts.version !== undefined ? Number(opts.version) : undefined;
      console.log(
        JSON.stringify(
          unwrap(await createOrcClient().humanRequests.unsnooze(id, version)),
          null,
          2,
        ),
      );
    });
  return command;
}
