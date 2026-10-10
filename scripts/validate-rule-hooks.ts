/** Native CLI protocol and installer probe; does not alter global agent settings. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../packages/core/src/config.js";
import { closeDb, getSqlite } from "../packages/db/src/client.js";
import { RuleStore } from "../packages/db/src/rules.js";

const directory = resolve(import.meta.dir, "../.claude/tooling/rule-hooks", String(Date.now()));
mkdirSync(directory, { recursive: true });
const database = join(directory, "orc.db");
loadConfig({ db: { path: database }, rules: { enabled: true } });
const store = new RuleStore(getSqlite());
store.activate(
  {
    workspace: directory,
    project_id: null,
    rules: [{ id: "shell", kind: "deny_tools", tools: ["Bash"], reason: "No shell" }],
  },
  null,
  "Native protocol validation",
);
const executable = process.argv
  .find((a) => a.startsWith("--executable="))
  ?.slice("--executable=".length);
const prefix = executable
  ? [resolve(executable)]
  : [process.execPath, resolve(import.meta.dir, "../packages/cli/src/index.ts")];
async function run(args: string[], input?: string) {
  const proc = Bun.spawn({
    cmd: [...prefix, "--db", database, "rules", ...args],
    cwd: directory,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ORC_RULES_ENABLED: "true", ORC_DB_PATH: database },
  });
  const timer = setTimeout(() => proc.kill(), 15000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
function require(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
const records: unknown[] = [];
try {
  for (const [backend, event] of [
    ["claude", "PreToolUse"],
    ["cursor", "preToolUse"],
    ["gemini", "BeforeTool"],
  ] as const) {
    const raw = {
      session_id: "native",
      conversation_id: "native",
      tool_use_id: `tool-${backend}`,
      cwd: directory,
      tool_name: "Bash",
      tool_input: { command: "secret-input-never-store" },
    };
    const result = await run(["hook", backend, event], JSON.stringify(raw));
    records.push({ backend, result });
    require(result.code === 2 &&
      result.stdout.includes("deny"), `${backend}: denial protocol failed`);
    const duplicate = await run(["hook", backend, event], JSON.stringify(raw));
    require(duplicate.code === 2, `${backend}: duplicate did not preserve denial`);
    const allowed = await run(
      ["hook", backend, event],
      JSON.stringify({
        ...raw,
        tool_use_id: `allowed-${backend}`,
        tool_name: "Read",
        tool_input: {},
      }),
    );
    require(allowed.code === 0 &&
      allowed.stdout.trim() === "{}", `${backend}: abstention changed native permissions`);
  }
  require(!JSON.stringify(store.decisions()).includes(
    "secret-input-never-store",
  ), "Audit leaked tool input");
  require((await run(["hook", "cursor", "preToolUse"], "invalid-json")).code ===
    2, "Malformed input did not fail closed");
  require((
    await run(
      ["hook", "cursor", "preToolUse"],
      JSON.stringify({ conversation_id: "s", cwd: directory, tool_name: "Bash" }),
    )
  ).code === 2, "Missing identity did not fail closed");
  const target = join(directory, "hooks.json");
  writeFileSync(
    target,
    JSON.stringify({
      version: 1,
      custom: "retained",
      hooks: { preToolUse: [{ command: "existing-hook" }] },
    }),
  );
  require((await run(["install-hook", "cursor", "--target", target])).code ===
    0, "Installer failed");
  const first = JSON.parse(readFileSync(target, "utf8"));
  const hook = first.hooks.preToolUse.find(
    (h: { command: string }) => h.command !== "existing-hook",
  );
  hook.failClosed = false;
  writeFileSync(target, JSON.stringify(first));
  require((await run(["install-hook", "cursor", "--target", target])).code ===
    0, "Repeated installer failed");
  const current = JSON.parse(readFileSync(target, "utf8"));
  require(current.custom === "retained" &&
    current.hooks.preToolUse.length === 2 &&
    current.hooks.preToolUse[0].command ===
      "existing-hook", "Installer lost settings or duplicated hooks");
  require(current.hooks.preToolUse[1].failClosed ===
    true, "Installer retained unsafe failure setting");
  require((await run(["install-hook", "gemini", "--target", target])).code !==
    0, "Unqualified installer accepted");
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(
      { passed: true, records, decisions: store.decisions(), settings: current },
      null,
      2,
    ),
  );
  console.log(
    `Native CLI protocols and atomic installer passed: ${directory}. Host enforcement is a separate qualification.`,
  );
} finally {
  closeDb();
}
