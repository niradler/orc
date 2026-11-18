import { expect, test } from "bun:test";
import { resolve } from "node:path";

const run = (frames: string, react = "") => {
  const script = `
import { mock } from "bun:test";
const result = (ms) => ({type:"result",subtype:"success",session_id:"sub-fixture",is_error:false,usage:{},duration_ms:ms});
const started = (task_id, extra = {}) => ({type:"system",subtype:"task_started",task_id,tool_use_id:"tu-"+task_id,description:task_id+" probe",subagent_type:"general-purpose",task_type:"local_agent",...extra});
const progress = (task_id, total_tokens) => ({type:"system",subtype:"task_progress",task_id,description:"Running Sleep 3 seconds",usage:{total_tokens,tool_uses:1,duration_ms:900}});
const notified = (task_id, status, total_tokens) => ({type:"system",subtype:"task_notification",task_id,status,output_file:"",summary:"done",usage:{total_tokens,tool_uses:1,duration_ms:9000}});
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: [],
  query: ({options}) => {
    const stream = (async function* () {
      yield {type:"system",subtype:"init",session_id:"sub-fixture"};
      ${frames}
    })();
    return { [Symbol.asyncIterator]: () => stream, close: () => {}, return: async () => stream.return() };
  },
}));
const {loadConfig} = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({rules:{...config.rules,enabled:false},preferences:{}});
await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
const {createBackend} = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const session = await createBackend("claude").startSession({cwd:process.cwd(),orcMcp:false,executionHost:null,permissionMode:"default"});
try {
  await session.send("Delegate");
  const events = [];
  for await (const event of session.events()) {
    events.push(event);
    ${react}
  }
  console.log("EVENTS" + JSON.stringify(events));
} finally { await session.close(); }
`;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, "../.."),
    timeout: 15000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = child.stdout.toString();
  const line = out.split("\n").find((entry) => entry.startsWith("EVENTS"));
  if (!line) throw new Error(`no events: ${child.stderr.toString()}`);
  return JSON.parse(line.slice(6)) as {
    type: string;
    data: Record<string, unknown> & { id?: string; status?: string };
  }[];
};

const latest = (events: ReturnType<typeof run>) => {
  const map = new Map<string, Record<string, unknown>>();
  for (const event of events)
    if (event.type === "subagent") map.set(String(event.data.id), event.data);
  return map;
};

test("Claude task events become a nested subagent tree and hold the turn until background children finish", () => {
  const events = run(`
      yield started("outer", {is_backgrounded:true, spawn_depth:1});
      yield result(1000);
      yield progress("outer", 31981);
      yield started("inner", {is_backgrounded:false, spawn_depth:2, parent_task_id:"outer"});
      yield {type:"system",subtype:"task_started",task_id:"bash1",tool_use_id:"tu-b",description:"Sleep 3",task_type:"local_bash",parent_task_id:"inner"};
      yield {type:"system",subtype:"task_notification",task_id:"bash1",status:"completed",output_file:"",summary:"Sleep 3"};
      yield {type:"system",subtype:"task_updated",task_id:"inner",patch:{status:"completed"}};
      yield notified("inner", "completed", 40402);
      yield notified("outer", "completed", 39183);
      yield {type:"system",subtype:"init",session_id:"sub-fixture"};
      yield result(2000);
  `);
  const tree = latest(events);
  expect([...tree.keys()]).toEqual(["outer", "inner"]);
  expect(tree.get("outer")).toMatchObject({ status: "completed", tokens: 39183, durationMs: 9000 });
  expect(tree.get("outer")?.parentId).toBeUndefined();
  expect(tree.get("inner")).toMatchObject({
    parentId: "outer",
    status: "completed",
    title: "inner probe",
  });
  const results = events.filter((event) => event.type === "result");
  expect(results).toHaveLength(1);
  expect(results[0]?.data.durationMs).toBe(2000);
  const outerProgress = events.find(
    (event) =>
      event.type === "subagent" && event.data.id === "outer" && event.data.tokens === 31981,
  );
  expect(outerProgress?.data.activity).toEqual([
    { type: "status", id: "outer:progress", text: "Running Sleep 3 seconds" },
  ]);
});

test("Claude subagents still running when the stream ends are marked stopped before the result", () => {
  const events = run(`
      yield started("lost", {is_backgrounded:true});
      yield result(500);
  `);
  expect(latest(events).get("lost")).toMatchObject({ status: "stopped" });
  const stoppedAt = events.findIndex(
    (event) => event.type === "subagent" && event.data.status === "stopped",
  );
  expect(stoppedAt).toBeGreaterThan(-1);
  expect(stoppedAt).toBeLessThan(events.findIndex((event) => event.type === "result"));
});

test("Claude reports a failed subagent and ignores ambient tasks and tasks without a subagent type", () => {
  const events = run(`
      yield started("broken");
      yield {type:"system",subtype:"task_started",task_id:"legacy",description:"no type"};
      yield started("watcher", {ambient:true, skip_transcript:true});
      yield {type:"system",subtype:"task_progress",task_id:"unknown",description:"x",usage:{total_tokens:1,tool_uses:0,duration_ms:1}};
      yield notified("broken", "failed", 12);
      yield result(10);
  `);
  const tree = latest(events);
  expect([...tree.keys()]).toEqual(["broken"]);
  expect(tree.get("broken")).toMatchObject({ status: "failed", tokens: 12 });
});

test("a Claude subagent waiting on a permission prompt is marked waiting, then running again", () => {
  const events = run(
    `
      yield started("asker");
      const decision = options.canUseTool("Bash", {command:"ls"}, {signal:new AbortController().signal, toolUseID:"t1", agentID:"asker"});
      await decision;
      yield notified("asker", "completed", 5);
      yield result(10);
  `,
    `if (event.type === "permission_request") session.respondPermission(event.data.requestId, "approved");`,
  );
  const statuses = events
    .filter((event) => event.type === "subagent" && event.data.id === "asker")
    .map((event) => event.data.status);
  expect(statuses).toEqual(["running", "waiting", "running", "completed"]);
});

test("Claude error results show the CLI's own text, a mapped terminal reason, or retry progress", () => {
  const failed = (extra: string) =>
    run(`
      yield {type:"system",subtype:"api_retry",attempt:1,max_retries:10,retry_delay_ms:1500,error_status:529,error:"server_error"};
      yield {type:"assistant",error:"model_not_found",message:{model:"<synthetic>",content:[{type:"text",text:"There's an issue with the selected model (claude-nonexistent-9)."}]}};
      yield {type:"result",subtype:"success",session_id:"sub-fixture",is_error:true,usage:{output_tokens:0},duration_ms:1,${extra}};
  `);
  const errorOf = (events: ReturnType<typeof run>) =>
    events.find((event) => event.type === "error")?.data as unknown;
  const model = failed(
    `result:"There's an issue with the selected model (claude-nonexistent-9).",terminal_reason:"api_error"`,
  );
  expect(model.map((event) => event.data as unknown)).toContain(
    "Claude API 529 error; retrying in 2s (attempt 1 of 10).",
  );
  expect(errorOf(model)).toBe("There's an issue with the selected model (claude-nonexistent-9).");
  expect(model.filter((event) => event.type === "text")).toEqual([]);
  expect(errorOf(failed(`result:"",terminal_reason:"prompt_too_long"`))).toBe(
    "The conversation no longer fits the context window. Run /compact or start a new chat.",
  );
  expect(errorOf(failed(`result:""`))).toBe("Claude stopped with an error (no details).");
});

test("Claude command output that never reached the model is shown as the reply", () => {
  const texts = (frames: string) =>
    run(frames)
      .filter((event) => event.type === "text")
      .map((event) => event.data as unknown);
  const result = (text: string, tokens: number) =>
    `yield {type:"result",subtype:"success",session_id:"sub-fixture",is_error:false,result:${JSON.stringify(text)},usage:{output_tokens:${tokens}},duration_ms:1};`;
  expect(texts(result("Current session: 36% used", 0))).toEqual(["Current session: 36% used"]);
  expect(
    texts(
      `yield {type:"assistant",message:{content:[{type:"text",text:"Current session: 36% used"}]}}; ${result("Current session: 36% used", 0)}`,
    ),
  ).toEqual(["Current session: 36% used"]);
  expect(texts(result("model answer", 12))).toEqual([]);
});
