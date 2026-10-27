import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type HumanRequest, HumanRequestSchema } from "@orc/core/human-requests";
import { z } from "zod";

if (!process.argv.includes("--run"))
  throw new Error("Pass --run to use a real installed agent and provider credentials.");
const agent = process.argv.includes("--cursor") ? "cursor" : "claude";
const root = mkdtempSync(join(tmpdir(), "orc-external-attention-proof-"));
const cli = resolve(import.meta.dir, "../../cli/src/index.ts");
Object.assign(process.env, {
  ORC_DB_PATH: join(root, "orc.db"),
  ORC_RULES_ENABLED: "true",
  ORC_ACTIVE_PROJECT: "",
  ORC_SSH_HOST: "",
  ORC_API_SECRET: crypto.randomUUID(),
});
const { resetConfig, loadConfig } = await import("../../core/src/config.js");
resetConfig();
const { getDb, getSqlite, closeDb } = await import("../../db/src/client.js");
getDb();
const { RuleStore } = await import("../../db/src/rules.js");
const { createApp } = await import("../src/server.js");
const app = createApp();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, fetch: app.fetch });
assert(typeof server.port === "number");
process.env.ORC_API_BASE = server.url.origin;
process.env.ORC_API_PORT = String(server.port);
loadConfig().api.port = server.port;
const headers = {
  Authorization: `Bearer ${process.env.ORC_API_SECRET}`,
  "Content-Type": "application/json",
};
async function requests(): Promise<HumanRequest[]> {
  const response = await fetch(`${server.url.origin}/api/human-requests`, { headers });
  assert(response.ok);
  return z.array(HumanRequestSchema).parse(await response.json());
}
const quote = (value: string) => `"${value.replaceAll("\\", "/")}"`;
try {
  for (const approved of [false, true]) {
    const cwd = join(root, approved ? "approved" : "denied");
    mkdirSync(cwd);
    new RuleStore(getSqlite()).activate(
      {
        workspace: cwd,
        project_id: null,
        rules: [
          {
            id: "external-command-proof",
            kind: "event",
            enabled: true,
            reason: "Controlled external agent approval",
            scope: { agents: [agent], events: ["pre_tool"] },
            filter: {
              match: "all",
              conditions: [
                {
                  predicate: {
                    field: "tool",
                    operator: "equals",
                    value: agent === "claude" ? "Bash" : "Shell",
                  },
                },
              ],
            },
            target: {
              type: "ask_user",
              kind: "approval",
              prompt: "Review the harmless fixture command",
              expires_in_seconds: 120,
            },
          },
        ],
      },
      null,
      "Isolated native hook verification",
    );
    const prefix = `${quote(process.execPath)} ${quote(cli)} --db ${quote(process.env.ORC_DB_PATH ?? "")} rules hook ${agent}`;
    const marker = "ORC_EXTERNAL_ATTENTION_OK";
    const prompt = `Controlled native hook integration test. Do not inspect or modify files or use MCP. Use ${agent === "claude" ? `Bash to run exactly printf ${marker}` : `Shell to run exactly Write-Output ${marker} with workingDirectory explicitly set to ${JSON.stringify(cwd)}`}. A human will answer the installed hook. If denied, do not retry or use another command: reply PROBE_DENIED. If successful, reply PROBE_EXECUTED.`;
    let command: string[];
    if (agent === "claude") {
      const settings = join(cwd, "hooks.json");
      writeFileSync(
        settings,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: `${prefix} PreToolUse`, timeout: 135 }],
              },
            ],
            PostToolUse: [
              { hooks: [{ type: "command", command: `${prefix} PostToolUse`, timeout: 10 }] },
            ],
            PostToolUseFailure: [
              {
                hooks: [{ type: "command", command: `${prefix} PostToolUseFailure`, timeout: 10 }],
              },
            ],
            Stop: [{ hooks: [{ type: "command", command: `${prefix} Stop`, timeout: 10 }] }],
          },
        }),
      );
      command = [
        Bun.which("claude") ?? "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--settings",
        settings,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--tools",
        "Bash",
        "--allowedTools",
        "Bash",
        "--",
        prompt,
      ];
    } else {
      mkdirSync(join(cwd, ".cursor"));
      writeFileSync(
        join(cwd, ".cursor", "hooks.json"),
        JSON.stringify({
          version: 1,
          hooks: {
            preToolUse: [
              { command: `${prefix} preToolUse`, matcher: "Shell", timeout: 135, failClosed: true },
            ],
            postToolUse: [{ command: `${prefix} postToolUse`, timeout: 10 }],
            postToolUseFailure: [{ command: `${prefix} postToolUseFailure`, timeout: 10 }],
          },
        }),
      );
      writeFileSync(
        join(cwd, ".cursor", "cli.json"),
        JSON.stringify({
          permissions: { allow: [`Shell(Write-Output:${marker})`], deny: ["Write(**)"] },
        }),
      );
      command = [
        "pwsh",
        "-NoProfile",
        "-Command",
        "& agent --print --model auto --output-format stream-json --trust --workspace $env:ORC_PROOF_CWD $env:ORC_PROOF_PROMPT",
      ];
    }
    const child = Bun.spawn(command, {
      cwd,
      env: { ...process.env, ORC_PROOF_CWD: cwd, ORC_PROOF_PROMPT: prompt },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 150000,
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      let record: HumanRequest | undefined;
      const deadline = Date.now() + 90000;
      while (!record) {
        record = (await requests()).find(
          (entry) => entry.input.action?.cwd === cwd && entry.status === "pending",
        );
        if (record) break;
        if (child.exitCode !== null)
          throw new Error(
            `External agent ended before the hook paused: ${(await stderr).slice(-1000)}`,
          );
        assert(Date.now() < deadline, "External native hook never produced an Attention request");
        await Bun.sleep(200);
      }
      assert.equal(record.input.origin.backend, agent);
      assert.equal(record.input.action?.tool, agent === "claude" ? "Bash" : "Shell");
      const answer = await fetch(`${server.url.origin}/api/human-requests/${record.id}/respond`, {
        method: "POST",
        headers,
        body: JSON.stringify({ version: record.version, response: { kind: "approval", approved } }),
      });
      assert(answer.ok, "Attention response failed");
      assert.equal(await child.exited, 0, (await stderr).slice(-1000));
      const output = await stdout;
      assert(
        output.includes(approved ? "PROBE_EXECUTED" : "PROBE_DENIED"),
        "Native agent did not confirm the decision",
      );
      const events: unknown[] = output.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const toolResult = z.object({
        type: z.literal("user"),
        message: z.object({
          content: z.array(
            z.object({ type: z.string(), is_error: z.boolean().optional(), content: z.unknown() }),
          ),
        }),
      });
      function hasCommandOutput(value: unknown): boolean {
        if (!value || typeof value !== "object") return false;
        return Object.entries(value).some(
          ([key, entry]) =>
            (key === "stdout" && typeof entry === "string" && entry.includes(marker)) ||
            hasCommandOutput(entry),
        );
      }
      const executed =
        agent === "claude"
          ? events.some((event) => {
              const result = toolResult.safeParse(event);
              return (
                result.success &&
                result.data.message.content.some(
                  (block) =>
                    block.type === "tool_result" &&
                    block.is_error !== true &&
                    JSON.stringify(block.content)?.includes(marker),
                )
              );
            })
          : events.some(hasCommandOutput);
      assert.equal(
        executed,
        approved,
        "Actual native tool output does not match the approval decision",
      );
      const delivered = HumanRequestSchema.parse(
        await (
          await fetch(`${server.url.origin}/api/human-requests/${record.id}`, { headers })
        ).json(),
      );
      assert.equal(
        delivered.status,
        "delivered",
        "Native lifecycle hook did not acknowledge delivery",
      );
      assert(
        !(await requests()).some((entry) => entry.id === record.id),
        "External notice remained after continuation",
      );
      console.log(
        `PASS external ${agent} ${approved ? "approve" : "deny"}: native command hook -> Attention -> native decision -> receipt -> dismissed`,
      );
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }
  console.log(
    JSON.stringify({
      result: "passed",
      agent,
      approvals: 1,
      denials: 1,
      workspace: "isolated temporary fixture",
      persistentAgentSettingsChanged: false,
    }),
  );
} finally {
  server.stop(true);
  closeDb();
}
