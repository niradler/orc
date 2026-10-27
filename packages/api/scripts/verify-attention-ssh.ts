import assert from "node:assert/strict";
import { ALIAS_PATTERN, hostRuntime, shQuote } from "../../core/src/exec-host.js";
import { readCodexQuestionPending } from "../src/sessions/codex-attention.js";
import { remoteWriters } from "../src/sessions/ownership.js";

const hostIndex = process.argv.indexOf("--host");
const candidate = hostIndex >= 0 ? process.argv[hostIndex + 1] : undefined;
if (!process.argv.includes("--run") || !candidate || !ALIAS_PATTERN.test(candidate))
  throw new Error("Usage: bun scripts/verify-attention-ssh.ts --run --host SSH_ALIAS (read-only)");
const alias = candidate;
async function remote(argv: readonly string[], input?: string | Uint8Array) {
  const child = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", alias, argv.map(shQuote).join(" ")],
    {
      stdin: typeof input === "string" ? Buffer.from(input) : (input ?? "ignore"),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20000,
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
const snapshot = await remote([
  "python3",
  "-c",
  `
import json,os,sqlite3
home=os.path.expanduser('~/.codex')
locks=os.path.join(home,'thread-writer-locks')
db=sqlite3.connect('file:'+os.path.join(home,'state_5.sqlite')+'?mode=ro',uri=True)
rows=[dict(zip(('id','rollout_path'),r)) for r in db.execute('SELECT id,rollout_path FROM threads WHERE archived=0')]
history={}
path=os.path.join(home,'thread_history_1.sqlite')
if os.path.isfile(path):
    h=sqlite3.connect('file:'+path+'?mode=ro',uri=True)
    history=dict(h.execute('SELECT thread_id,status FROM (SELECT thread_id,status,ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY rollout_ordinal DESC) AS n FROM thread_turns) WHERE n=1'))
print(json.dumps(dict(directory=locks,exists=os.path.isdir(locks),rows=rows,history=history)))
`,
]);
assert.equal(snapshot.code, 0, "Read-only remote native database inspection failed");
const data = JSON.parse(snapshot.stdout) as {
  directory: string;
  exists: boolean;
  rows: { id: string; rollout_path: string }[];
  history: Record<string, string>;
};
assert(data.exists, "Native writer-lock directory is absent; ownership verification unavailable");
// Windows does not support ORC's multiplexed SSH host mode. Use its installed
// OpenSSH transport to exercise the exact production probe against actual locks.
const runtime = {
  ...hostRuntime(),
  host: {
    kind: "ssh" as const,
    alias,
    remotePort: 0,
    apiTarget: "",
    secret: undefined,
    connectTimeoutSecs: 5,
  },
  binary: async () => "python3",
  exec: (argv: readonly string[], options?: { input?: string | Uint8Array }) =>
    remote(argv, options?.input),
};
const owned = await remoteWriters(
  runtime,
  data.directory,
  data.rows.map((row) => row.id),
);
assert.equal(owned.size, data.rows.length);
let questions = 0;
const active = data.rows.filter((row) => owned.get(row.id));
for (const row of active.slice(0, 5))
  if (await readCodexQuestionPending(runtime, row.rollout_path)) questions++;
console.log(
  JSON.stringify({
    result: "passed",
    transport: "OpenSSH read-only",
    sessionsInspected: owned.size,
    heldWriters: active.length,
    staleInProgressWithoutWriter: data.rows.filter(
      (row) => data.history[row.id] === "inProgress" && !owned.get(row.id),
    ).length,
    activeTranscriptsInspected: Math.min(active.length, 5),
    observedQuestions: questions,
    databaseReadOnly: true,
    nativeResponsesSent: 0,
  }),
);
