import { expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * Fake SDK query for streaming-input tests. `react(handle, message)` runs for
 * every input message the SDK pulls; the handle can emit output messages,
 * finish the stream and hook interrupt(). Mirrors the real SDK contract:
 * input is pulled one message at a time, abort ends the output stream, and
 * return() drains without waiting for pending input reactions.
 */
const harness = (react: string) => `
import { mock } from "bun:test";
const queries = [];
let activeQueries = 0;
let maxActiveQueries = 0;
const react = ${react};
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: [],
  query: ({ prompt, options }) => {
    const handle = { received: [], options, interrupts: 0, interruptOptions: undefined, closed: 0, returnDelay: 0 };
    queries.push(handle);
    activeQueries++;
    maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
    const out = [];
    let wake = null;
    let ended = false;
    handle.emit = (msg) => { out.push(msg); wake?.(); wake = null; };
    handle.finish = () => { ended = true; wake?.(); wake = null; };
    handle.onInterrupt = async () => {};
    options.abortController?.signal.addEventListener("abort", () => handle.finish(), { once: true });
    const inputIterator = prompt[Symbol.asyncIterator]();
    (async () => {
      while (true) {
        const next = await inputIterator.next();
        if (next.done) break;
        handle.received.push(next.value);
        await react(handle, next.value);
      }
      // Like the real SDK: once input ends the CLI exits and output ends.
      handle.finish();
    })().catch(() => {});
    const stream = (async function* () {
      while (true) {
        while (out.length > 0) yield out.shift();
        if (ended) return;
        await new Promise((resolve) => { wake = resolve; });
      }
    })();
    return {
      [Symbol.asyncIterator]: () => stream,
      interrupt: async (options) => { handle.interrupts++; handle.interruptOptions = options; await handle.onInterrupt(handle); },
      return: async () => {
        handle.closed++;
        handle.finish();
        await stream.return();
        if (handle.returnDelay) await Bun.sleep(handle.returnDelay);
        activeQueries--;
        return { value: undefined, done: true };
      },
    };
  },
}));
const {loadConfig} = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({rules:{...config.rules,enabled:false},preferences:{}});
await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
const {createBackend} = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const session = await createBackend("claude").startSession({cwd:process.cwd(),orcMcp:false,executionHost:null});
const drain = async () => { const events = []; for await (const event of session.events()) events.push(event); return events; };
const watch = () => { const events = []; const reading = (async () => { for await (const event of session.events()) events.push(event); })(); return { events, reading }; };
const waitFor = async (events, predicate) => { while (!events.some(predicate)) await Bun.sleep(5); };
const assertRejects = async (fn) => { try { await fn(); } catch { return; } throw new Error("expected rejection"); };
const resultMessage = (sessionId, userMessageUuid, extra) => ({type:"result",subtype:"success",session_id:sessionId,is_error:false,usage:{},duration_ms:1,user_message_uuid:userMessageUuid,...(extra ?? {})});
const textMessage = (text) => ({type:"assistant",message:{content:[{type:"text",text}]}});
`;

function run(script: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, "../.."),
    timeout: 20000,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function expectSuccess(script: string): void {
  const result = run(script);
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({ exitCode: 0 });
  expect(result.stdout).toContain("verified");
}

test("steer delivers into the active turn and confirms only once the SDK consumed the message", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      if (handle.received.length === 1) {
        handle.emit({type:"system",subtype:"init",session_id:"steer-fixture"});
        handle.emit(textMessage("working"));
        await gate;
        // The CLI can report an empty queue while a steer is still in flight
        // and run it as a continuation anyway (verified live).
        handle.emit(resultMessage("steer-fixture", msg.uuid, { queued_turn_count: 0 }));
      } else {
        handle.emit(textMessage("adjusted:" + msg.message.content));
        handle.emit(resultMessage("steer-fixture", msg.uuid));
        handle.finish();
      }
    }`) +
      `
let openGate;
const gate = new Promise((resolve) => { openGate = resolve; });
try {
  await session.send("start");
  const { events, reading } = watch();
  await waitFor(events, (event) => event.type === "text");
  let settled = false;
  const steering = session.steer("focus on tests").then(() => { settled = true; }, () => { settled = true; });
  await Bun.sleep(25);
  if (settled) throw new Error("steer confirmed before the SDK consumed the message");
  openGate();
  await steering;
  await reading;
  const steerMessage = queries[0].received[1];
  if (steerMessage?.message?.content !== "focus on tests") throw new Error("steer text was not delivered");
  if (steerMessage?.parent_tool_use_id !== null) throw new Error("steer must be a main-thread user message");
  if (typeof steerMessage?.uuid !== "string") throw new Error("steer must carry a trackable uuid");
  if (!events.some((event) => event.type === "text" && event.data.endsWith("adjusted:focus on tests")))
    throw new Error("steer did not land in the active turn");
  const results = events.filter((event) => event.type === "result");
  if (results.length !== 1) throw new Error("the steer continuation must not end the turn twice");
  if (results[0].data.outcome === "stopped") throw new Error("steered turn must complete normally");
  if (queries[0].closed !== 1) throw new Error("query was not closed exactly once");
  console.log("verified");
} finally { openGate(); await session.close(); }
`,
  );
});

test("interrupt ends the turn even when a steer continuation is still queued", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      if (handle.received.length === 1) {
        handle.emit({type:"system",subtype:"init",session_id:"queue-fixture"});
        handle.emit(textMessage("working"));
        handle.onInterrupt = async (h) => { h.finish(); };
        await gate;
        handle.emit(resultMessage("queue-fixture", msg.uuid));
      } else {
        handle.emit(textMessage("SHOULD-NOT-RUN"));
        handle.emit(resultMessage("queue-fixture", msg.uuid));
        handle.finish();
      }
    }`) +
      `
let openGate;
const gate = new Promise((resolve) => { openGate = resolve; });
try {
  await session.send("start");
  const { events, reading } = watch();
  await waitFor(events, (event) => event.type === "text");
  let rejected = false;
  const steering = session.steer("queued steer").catch(() => { rejected = true; });
  await session.interrupt();
  await reading;
  await steering;
  if (!rejected) throw new Error("queued steer must be unconfirmed when the turn is interrupted");
  const result = events.find((event) => event.type === "result");
  if (result?.data?.outcome !== "stopped") throw new Error("interrupted turn must end as stopped");
  if (events.some((event) => event.type === "text" && event.data.includes("SHOULD-NOT-RUN")))
    throw new Error("queued steer ran after the interrupt");
  console.log("verified");
} finally { openGate(); await session.close(); }
`,
  );
});

test("coalesced steers answered by one result complete the turn (user_message_uuids)", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      if (handle.received.length === 1) {
        handle.emit({type:"system",subtype:"init",session_id:"coalesce-fixture"});
        handle.emit(textMessage("working"));
        await gate;
        handle.emit(resultMessage("coalesce-fixture", msg.uuid));
      } else if (handle.received.length === 2) {
        await gate2;
      } else {
        handle.emit(textMessage("answered both"));
        handle.emit(resultMessage("coalesce-fixture", msg.uuid, {
          user_message_uuids: [handle.received[1].uuid, handle.received[2].uuid],
        }));
      }
    }`) +
      `
let openGate; let openGate2;
const gate = new Promise((resolve) => { openGate = resolve; });
const gate2 = new Promise((resolve) => { openGate2 = resolve; });
try {
  await session.send("start");
  const { events, reading } = watch();
  await waitFor(events, (event) => event.type === "text");
  const first = session.steer("first steer");
  const second = session.steer("second steer");
  openGate();
  openGate2();
  await Promise.all([first, second]);
  let hangTimer;
  const hang = new Promise((resolve) => { hangTimer = setTimeout(() => resolve(false), 5000); });
  const fast = await Promise.race([reading.then(() => true), hang]);
  clearTimeout(hangTimer);
  if (!fast) throw new Error("coalesced steers did not complete the turn (hang)");
  await reading;
  if (!events.some((event) => event.type === "text" && event.data.endsWith("answered both")))
    throw new Error("coalesced steer answer missing");
  const results = events.filter((event) => event.type === "result");
  if (results.length !== 1) throw new Error("coalesced steers must complete the turn exactly once");
  if (queries[0].closed !== 1) throw new Error("query was not closed exactly once");
  console.log("verified");
} finally { openGate(); openGate2(); await session.close(); }
`,
  );
}, 15000);

test("a CLI that echoes no uuids ends the steered turn without waiting for the grace", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      if (handle.received.length === 1) {
        handle.emit({type:"system",subtype:"init",session_id:"older-fixture"});
        handle.emit(textMessage("working"));
        await gate;
        handle.emit(resultMessage("older-fixture", undefined));
      } else {
        handle.emit(textMessage("answered by an older producer"));
        handle.emit(resultMessage("older-fixture", undefined));
      }
    }`) +
      `
const { setClaudeSteerContinuationGraceMs } = await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
setClaudeSteerContinuationGraceMs(5000);
let openGate;
const gate = new Promise((resolve) => { openGate = resolve; });
try {
  await session.send("start");
  const { events, reading } = watch();
  await waitFor(events, (event) => event.type === "text");
  // Without a uuid echo the turn may end before the steer is pulled; the
  // delivery then stays unconfirmed (a rejection), which is the honest outcome.
  const steering = session.steer("steer for an older CLI").catch(() => {});
  openGate();
  await steering;
  let hangTimer;
  const hang = new Promise((resolve) => { hangTimer = setTimeout(() => resolve(false), 1500); });
  const fast = await Promise.race([reading.then(() => true), hang]);
  clearTimeout(hangTimer);
  if (!fast) throw new Error("a CLI without uuid echo must end the turn without waiting for the grace");
  await reading;
  const results = events.filter((event) => event.type === "result");
  if (results.length !== 1) throw new Error("older-producer turn must complete exactly once");
  if (events.some((event) => event.type === "text" && event.data.includes("older producer")))
    throw new Error("post-result output leaked into the turn");
  console.log("verified");
} finally { openGate(); setClaudeSteerContinuationGraceMs(120000); await session.close(); }
`,
  );
}, 15000);

test("a steer uuid the CLI never answers ends the turn after the continuation grace", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      if (handle.received.length === 1) {
        handle.emit({type:"system",subtype:"init",session_id:"backstop-fixture"});
        handle.emit(textMessage("working"));
        await gate;
        handle.emit(resultMessage("backstop-fixture", msg.uuid, { queued_turn_count: 1 }));
      } else {
        handle.emit(textMessage("answered without echo"));
        handle.emit(resultMessage("backstop-fixture", "not-the-steer-uuid", { queued_turn_count: 0 }));
      }
    }`) +
      `
const { setClaudeSteerContinuationGraceMs } = await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
setClaudeSteerContinuationGraceMs(150);
let openGate;
const gate = new Promise((resolve) => { openGate = resolve; });
try {
  await session.send("start");
  const { events, reading } = watch();
  await waitFor(events, (event) => event.type === "text");
  const steering = session.steer("steer whose uuid is lost");
  openGate();
  await steering;
  await reading;
  const results = events.filter((event) => event.type === "result");
  if (results.length !== 1) throw new Error("a lost uuid must not hold the turn open forever");
  if (!events.some((event) => event.type === "system_status" && event.data.includes("not answered")))
    throw new Error("the unanswered steer must be surfaced, not silently completed");
  console.log("verified");
} finally { openGate(); setClaudeSteerContinuationGraceMs(120000); await session.close(); }
`,
  );
});

test("interrupt cancels a delivered queued steer instead of letting it run after Stop", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      if (handle.received.length === 1) {
        handle.emit({type:"system",subtype:"init",session_id:"cancel-fixture"});
        handle.emit(textMessage("working"));
        handle.cancelled = new Promise((resolve) => { handle.resolveCancelled = resolve; });
        handle.onInterrupt = async (h) => {
          h.wasCancelled = h.interruptOptions?.cancelQueued === true;
          h.resolveCancelled();
          h.emit(resultMessage("cancel-fixture", msg.uuid));
          h.finish();
        };
      } else {
        await handle.cancelled;
        if (!handle.wasCancelled) {
          handle.emit(textMessage("SHOULD-NOT-RUN"));
          handle.emit(resultMessage("cancel-fixture", msg.uuid));
        }
      }
    }`) +
      `
try {
  await session.send("start");
  const { events, reading } = watch();
  await waitFor(events, (event) => event.type === "text");
  const steering = session.steer("delivered then cancelled").catch(() => {});
  while (queries[0].received.length < 2) await Bun.sleep(5);
  await session.interrupt();
  await reading;
  await steering;
  if (queries[0].interruptOptions?.cancelQueued !== true)
    throw new Error("interrupt must cancel queued steers");
  const results = events.filter((event) => event.type === "result");
  if (results.length !== 1 || results[0].data.outcome !== "stopped")
    throw new Error("Stop must end the turn exactly once as stopped");
  if (events.some((event) => event.type === "text" && event.data.includes("SHOULD-NOT-RUN")))
    throw new Error("cancelled steer ran after the interrupt");
  console.log("verified");
} finally { await session.close(); }
`,
  );
});

test("messages emitted after the final result are ignored", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      handle.emit({type:"system",subtype:"init",session_id:"late-fixture"});
      handle.emit(textMessage("done"));
      handle.emit(resultMessage("late-fixture", msg.uuid));
      handle.emit(textMessage("LATE"));
      handle.emit(resultMessage("late-fixture", msg.uuid));
      handle.finish();
    }`) +
      `
try {
  await session.send("start");
  const events = await drain();
  const results = events.filter((event) => event.type === "result");
  if (results.length !== 1) throw new Error("late result leaked into the turn");
  if (events.some((event) => event.type === "text" && event.data.includes("LATE")))
    throw new Error("late text leaked into the turn");
  console.log("verified");
} finally { await session.close(); }
`,
  );
});

test("an attached events() consumer survives turn replacement", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      if (queries.length === 1) {
        handle.returnDelay = 30;
        handle.emit(textMessage("A"));
        await new Promise((resolve) => handle.options.abortController.signal.addEventListener("abort", resolve, { once: true }));
        handle.finish();
      } else {
        handle.emit({type:"system",subtype:"init",session_id:"replace-fixture"});
        handle.emit(textMessage("B"));
        handle.emit(resultMessage("replace-fixture", msg.uuid));
        handle.finish();
      }
    }`) +
      `
try {
  await session.send("A");
  const { events, reading } = watch();
  await waitFor(events, (event) => event.type === "text" && event.data === "A");
  await session.send("B");
  await reading;
  if (!events.some((event) => event.type === "text" && event.data === "B"))
    throw new Error("replacement turn text missing; the old unwind ended events()");
  if (!events.some((event) => event.type === "result"))
    throw new Error("replacement turn result missing; the old unwind ended events()");
  console.log("verified");
} finally { await session.close(); }
`,
  );
});

test("interrupt ends the turn cooperatively as stopped and the next send resumes the native session", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      handle.emit({type:"system",subtype:"init",session_id:"native-steer-fixture"});
      if (queries.length === 1) {
        handle.emit(textMessage("working"));
        handle.onInterrupt = async (h) => { h.emit(resultMessage("native-steer-fixture", msg.uuid)); h.finish(); };
      } else {
        handle.emit(textMessage("resumed"));
        handle.emit(resultMessage("native-steer-fixture", msg.uuid));
        handle.finish();
      }
    }`) +
      `
try {
  await session.send("start");
  const { events, reading } = watch();
  await waitFor(events, (event) => event.type === "text");
  await session.interrupt();
  await reading;
  if (queries[0].interrupts !== 1) throw new Error("SDK interrupt was not called exactly once");
  const result = events.find((event) => event.type === "result");
  if (result?.data?.outcome !== "stopped") throw new Error("interrupted turn must end as stopped");
  if (result?.data?.runtimeSessionId !== "native-steer-fixture") throw new Error("native identity was lost on stop");
  if (session.getRuntimeSessionId() !== "native-steer-fixture") throw new Error("session identity was lost on stop");
  await session.send("continue after stop");
  if (queries.length !== 2) throw new Error("next send must start a fresh per-turn query");
  if (queries[1].options.resume !== "native-steer-fixture") throw new Error("next send did not resume the native session");
  const continued = await drain();
  if (!continued.some((event) => event.type === "result")) throw new Error("resumed turn did not complete");
  console.log("verified");
} finally { await session.close(); }
`,
  );
});

test("interrupt without a native result still reports stopped with the native identity", () => {
  expectSuccess(
    harness(`async (handle) => {
      handle.emit({type:"system",subtype:"init",session_id:"quiet-stop-fixture"});
      handle.emit(textMessage("working"));
      handle.onInterrupt = async (h) => { h.finish(); };
    }`) +
      `
try {
  await session.send("start");
  const { events, reading } = watch();
  await waitFor(events, (event) => event.type === "text");
  await session.interrupt();
  await reading;
  const result = events.find((event) => event.type === "result");
  if (result?.data?.outcome !== "stopped") throw new Error("missing synthesized stopped result");
  if (result?.data?.runtimeSessionId !== "quiet-stop-fixture") throw new Error("native identity was lost");
  console.log("verified");
} finally { await session.close(); }
`,
  );
});

test("steer is rejected outside an active turn and validates its input", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      handle.emit({type:"system",subtype:"init",session_id:"guard-fixture"});
      handle.emit(resultMessage("guard-fixture", msg.uuid));
      handle.finish();
      handle.onInterrupt = async (h) => { h.finish(); };
    }`) +
      `
try {
  await assertRejects(() => session.steer("before any turn"));
  await session.send("start");
  await drain();
  await assertRejects(() => session.steer("after the turn ended"));
  await session.send("again");
  const { events, reading } = watch();
  await waitFor(events, (event) => event.type === "result");
  await session.interrupt();
  await reading;
  await assertRejects(() => session.steer("after stop"));
  await session.send("third");
  await assertRejects(() => session.steer("   "));
  await assertRejects(() => session.steer("x".repeat(100001)));
  await drain();
  console.log("verified");
} finally { await session.close(); }
`,
  );
});

test("concurrent sends never let an unwinding query end the new turn's events (R-15)", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      if (queries.length === 1) {
        handle.returnDelay = 40;
        handle.emit(textMessage("A"));
        await new Promise((resolve) => handle.options.abortController.signal.addEventListener("abort", resolve, { once: true }));
        handle.finish();
      } else {
        handle.emit({type:"system",subtype:"init",session_id:"race-fixture"});
        handle.emit(textMessage("B"));
        handle.emit(resultMessage("race-fixture", msg.uuid));
        handle.finish();
      }
    }`) +
      `
try {
  const first = session.send("A");
  const second = session.send("B");
  await Promise.all([first, second]);
  const events = await drain();
  if (!events.some((event) => event.type === "text" && event.data === "B"))
    throw new Error("new turn text missing");
  if (!events.some((event) => event.type === "result"))
    throw new Error("old query unwind ended the new turn's events (R-15)");
  if (events.some((event) => event.type === "text" && event.data === "A"))
    throw new Error("stale turn events leaked into the new turn");
  if (queries.length !== 2) throw new Error("expected exactly two queries");
  if (maxActiveQueries !== 1) throw new Error("queries overlapped; a driveQuery was orphaned");
  console.log("verified");
} finally { await session.close(); }
`,
  );
});

test("close rejects a steer whose delivery was never confirmed", () => {
  expectSuccess(
    harness(`async (handle) => {
      if (handle.received.length === 1) {
        handle.emit({type:"system",subtype:"init",session_id:"close-fixture"});
        handle.emit(textMessage("working"));
        await gate;
      }
    }`) +
      `
let openGate;
const gate = new Promise((resolve) => { openGate = resolve; });
try {
  await session.send("start");
  const { events } = watch();
  await waitFor(events, (event) => event.type === "text");
  let rejected = false;
  const steering = session.steer("pending").catch(() => { rejected = true; });
  await Bun.sleep(10);
  await session.close();
  await steering;
  if (!rejected) throw new Error("unconfirmed steer was not rejected on close");
  console.log("verified");
} finally { openGate(); await session.close(); }
`,
  );
});

test("interrupt releases a pending permission so the turn can end", () => {
  expectSuccess(
    harness(`async (handle, msg) => {
      handle.emit({type:"system",subtype:"init",session_id:"perm-fixture"});
      handle.permissionDecision = await handle.options.canUseTool("Bash", { command: "ls" }, {});
      handle.emit(resultMessage("perm-fixture", msg.uuid));
      handle.finish();
    }`) +
      `
try {
  await session.send("start");
  const { events, reading } = watch();
  await waitFor(events, (event) => event.type === "permission_request");
  await session.interrupt();
  await reading;
  if (queries[0].permissionDecision?.behavior !== "deny")
    throw new Error("pending permission was not released as denied");
  if (!events.some((event) => event.type === "request_resolved"))
    throw new Error("pending request was not resolved in the event stream");
  const result = events.find((event) => event.type === "result");
  if (result?.data?.outcome !== "stopped") throw new Error("turn did not end as stopped");
  console.log("verified");
} finally { await session.close(); }
`,
  );
});
