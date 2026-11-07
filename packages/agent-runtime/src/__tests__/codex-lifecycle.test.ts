import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostSpawn } from "@orc/core/exec-host";
import { CodexAppSession } from "../codex-app.js";
import type { AgentEvent } from "../types.js";

const owned: { cwd: string; session: CodexAppSession }[] = [];
afterEach(async () => {
  for (const { cwd, session } of owned.splice(0)) {
    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
function fixture(body: string, launch?: () => Promise<void>, closeOutput = false) {
  const cwd = mkdtempSync(join(tmpdir(), "orc-codex-lifecycle-"));
  const script = join(cwd, "peer.ts");
  writeFileSync(
    script,
    `import { createInterface } from 'node:readline';
import { appendFileSync, closeSync } from 'node:fs';
const emit = value => console.log(JSON.stringify(value));
const notify = (method, params) => emit({method,params:{threadId:'native',...params}});
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line); appendFileSync('wire.ndjson',line+'\\n');
 if(m.method==='initialize') emit({id:m.id,result:{}});
 else if(m.method==='thread/start'||m.method==='thread/resume') emit({id:m.id,result:{thread:{id:'native'}}});
 else { ${body} }
}`,
  );
  const session = new CodexAppSession(
    { cwd, orcMcp: false },
    { kind: "local" },
    async () => {
      await launch?.();
      return [process.execPath, script];
    },
    async (host, args, options) => {
      const child = await hostSpawn(host, args, options);
      if (!closeOutput || !child.proc.stdout || typeof child.proc.stdout === "number") return child;
      // stdout.end() does not close Windows stdio. Close at the transport boundary
      // after a real protocol frame, while keeping the underlying process alive.
      const stdout = child.proc.stdout.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            if (new TextDecoder().decode(chunk).includes("fixture/close")) controller.terminate();
          },
        }),
      );
      return {
        ...child,
        proc: new Proxy(child.proc, {
          get(target, property) {
            return property === "stdout" ? stdout : Reflect.get(target, property, target);
          },
        }),
      };
    },
  );
  owned.push({ cwd, session });
  return { session, cwd };
}
async function collect(session: CodexAppSession): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.events()) events.push(event);
  return events;
}

test("ignores stale native turn completion and correlates the active turn", async () => {
  const { session } = fixture(`if(m.method==='turn/start') {
 emit({id:m.id,result:{turn:{id:'current'}}});
 notify('turn/completed',{turn:{id:'stale',status:'completed'}});
 setTimeout(()=>{notify('item/agentMessage/delta',{turnId:'current',itemId:'a',delta:'actual response'});notify('turn/completed',{turn:{id:'current',status:'completed'}})},25);
 }`);
  await session.send("hello");
  const events = await collect(session);
  expect(
    events
      .filter((e) => e.type === "text")
      .map((e) => e.data)
      .join(""),
  ).toBe("actual response");
  expect(events.filter((e) => e.type === "result")).toHaveLength(1);
});

test("rejects concurrent sends before asynchronous startup launches a second process", async () => {
  let launches = 0;
  const { session } = fixture(
    `if(m.method==='turn/start') emit({id:m.id,result:{turn:{id:'current'}}});`,
    async () => {
      launches++;
      await Bun.sleep(20);
    },
  );
  const results = await Promise.allSettled([session.send("one"), session.send("two")]);
  expect(launches).toBe(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
});

test("steers and interrupts the same native turn without replacing its thread", async () => {
  const { session, cwd } =
    fixture(`if(m.method==='turn/start') emit({id:m.id,result:{turn:{id:'current'}}});
 if(m.method==='turn/steer') emit({id:m.id,result:{turnId:'current'}});
 if(m.method==='turn/interrupt') { emit({id:m.id,result:{}});notify('turn/completed',{turn:{id:'current',status:'interrupted'}}); }`);
  await session.send("hello");
  await session.steer("focus on tests");
  await session.interrupt();
  const events = await collect(session);
  expect(events.some((e) => e.type === "system_status" && e.data.includes("stopped"))).toBe(true);
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(wire.find((m) => m.method === "turn/steer").params).toMatchObject({
    threadId: "native",
    expectedTurnId: "current",
  });
  expect(wire.find((m) => m.method === "turn/interrupt").params).toEqual({
    threadId: "native",
    turnId: "current",
  });
});

test("surfaces stdout closing mid-turn instead of leaving the event consumer waiting", async () => {
  const { session } = fixture(
    `if(m.method==='turn/start') {emit({id:m.id,result:{turn:{id:'current'}}});setTimeout(()=>notify('fixture/close',{}),20);}`,
    undefined,
    true,
  );
  await session.send("hello");
  const events = await collect(session);
  expect(events.some((e) => e.type === "error")).toBe(true);
}, 4000);

test("bounds unterminated protocol frames before the newline arrives", async () => {
  const { session } = fixture(
    `if(m.method==='turn/start') {emit({id:m.id,result:{turn:{id:'current'}}});process.stdout.write('x'.repeat(2100000));}`,
  );
  await session.send("hello");
  const events = await collect(session);
  expect(events.some((e) => e.type === "error" && e.data.includes("limit"))).toBe(true);
}, 4000);

test("closing during startup prevents a late process launch", async () => {
  const { session, cwd } = fixture(``, async () => {
    await Bun.sleep(40);
  });
  const sent = session.send("hello").then(
    () => {
      throw new Error("Startup unexpectedly succeeded");
    },
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  await Bun.sleep(5);
  await session.close();
  expect(await sent).toContain("closed during startup");
  expect(session.alive()).toBe(false);
  expect(() => readFileSync(join(cwd, "wire.ndjson"))).toThrow();
});

test("native image inputs, plans and token usage survive protocol normalization", async () => {
  const { session, cwd } = fixture(`if(m.method==='turn/start') {
    emit({id:m.id,result:{turn:{id:'current'}}});
    notify('turn/plan/updated',{turnId:'current',plan:[{step:'Verify files',status:'completed'}]});
    notify('thread/tokenUsage/updated',{tokenUsage:{total:{totalTokens:42},last:{totalTokens:7}}});
    notify('turn/completed',{turn:{id:'current',status:'completed'}});
  }`);
  await session.send("Read the image", [
    { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
  ]);
  const events = await collect(session);
  expect(events).toContainEqual({ type: "system_status", data: "completed: Verify files" });
  expect(events).toContainEqual({
    type: "result",
    data: {
      runtimeSessionId: "native",
      usage: { total: { totalTokens: 42 }, last: { totalTokens: 7 } },
      outcome: "completed",
    },
  });
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(wire.find((m) => m.method === "turn/start").params.input).toContainEqual({
    type: "image",
    url: "data:image/png;base64,AQID",
  });
});

test("many small frames cannot overflow the pending response buffer", async () => {
  const { session } = fixture(`if(m.method==='turn/start') {
    emit({id:m.id,result:{turn:{id:'current'}}});
    for(let i=0;i<230;i++)notify('item/agentMessage/delta',{turnId:'current',itemId:'a',delta:'x'.repeat(10000)});
  }`);
  await session.send("large output");
  await Bun.sleep(100);
  const events = await collect(session);
  expect(events.some((e) => e.type === "error" && e.data.includes("output limit"))).toBe(true);
  expect(events.some((e) => e.type === "result")).toBe(false);
}, 5000);

test("queued start acknowledgments wait for the native turn before interruption", async () => {
  const { session } = fixture(`if(m.method==='turn/start') {
    globalThis.peerStarted=false;
    emit({id:m.id,result:{turn:{id:'current',startedAt:null,status:'inProgress'}}});
    setTimeout(()=>{globalThis.peerStarted=true;notify('turn/started',{turn:{id:'current',startedAt:1,status:'inProgress'}})},50);
  }
  if(m.method==='turn/interrupt') {
    if(!globalThis.peerStarted) emit({id:m.id,error:{code:-32600,message:'no active turn to interrupt'}});
    else {emit({id:m.id,result:{}});notify('turn/completed',{turn:{id:'current',status:'interrupted'}});}
  }`);
  await session.send("queued");
  await session.interrupt();
  const events = await collect(session);
  expect(events.some((e) => e.type === "system_status" && e.data.includes("stopped"))).toBe(true);
  expect(events).toContainEqual({
    type: "result",
    data: { runtimeSessionId: "native", usage: undefined, outcome: "stopped" },
  });
});

test("a non-retryable native error settles the consumer without requiring a completion frame", async () => {
  const { session } = fixture(`if(m.method==='turn/start') {
    emit({id:m.id,result:{turn:{id:'current'}}});
    notify('error',{turnId:'current',willRetry:false,error:{message:'provider unavailable'}});
  }`);
  await session.send("fail");
  const events = await Promise.race([collect(session), Bun.sleep(150).then(() => null)]);
  expect(events).not.toBeNull();
  expect(events).toContainEqual({ type: "error", data: "provider unavailable" });
  expect(session.getRuntimeSessionId()).toBe("native");
});

test("Codex does not grant new approvals after Stop even when live permissions were loosened", async () => {
  const { session, cwd } =
    fixture(`if(m.method==='turn/start')emit({id:m.id,result:{turn:{id:'current'}}});
    if(m.method==='turn/interrupt') {
      globalThis.interruptId=m.id;
      emit({id:'late-approval',method:'item/commandExecution/requestApproval',params:{threadId:'native',turnId:'current',command:'late action'}});
    }
    if(m.id==='late-approval'&&!m.method){
      emit({id:globalThis.interruptId,result:{}});notify('turn/completed',{turn:{id:'current',status:'interrupted'}});
    }`);
  await session.send("Wait");
  session.setPermissionMode("bypassPermissions");
  await session.interrupt();
  await collect(session);
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const reply = wire.find((m) => m.id === "late-approval" && !m.method);
  expect(reply?.error).toBeDefined();
  expect(reply?.result).toBeUndefined();
});

test("Stop rejects steering while the native interruption is still in flight", async () => {
  const { session, cwd } =
    fixture(`if(m.method==='turn/start')emit({id:m.id,result:{turn:{id:'current'}}});
    if(m.method==='turn/interrupt')setTimeout(()=>{emit({id:m.id,result:{}});notify('turn/completed',{turn:{id:'current',status:'interrupted'}})},30);
    if(m.method==='turn/steer')emit({id:m.id,result:{}});`);
  await session.send("Wait");
  const stopping = session.interrupt();
  await expect(session.steer("too late")).rejects.toThrow("No active");
  await stopping;
  await collect(session);
  expect(readFileSync(join(cwd, "wire.ndjson"), "utf8")).not.toContain("turn/steer");
});

test("queued question follow-ups remain interruptible on the new native turn", async () => {
  const { session } = fixture(`if(m.method==='turn/start') {
    if(!globalThis.asked){globalThis.asked=true;emit({id:m.id,result:{turn:{id:'first'}}});
      notify('item/completed',{turnId:'first',item:{type:'agentMessage',id:'question',text:'Choose',questions:[{title:'Color?',options:['Blue']}]}});
      notify('turn/completed',{turn:{id:'first',status:'completed'}});
    } else {globalThis.ready=false;emit({id:m.id,result:{turn:{id:'followup',startedAt:null,status:'inProgress'}}});
      setTimeout(()=>{globalThis.ready=true;notify('turn/started',{turn:{id:'followup',startedAt:1,status:'inProgress'}})},30);
    }
  }
  if(m.method==='turn/interrupt'){
    if(!globalThis.ready||m.params.turnId!=='followup')emit({id:m.id,error:{code:-32600,message:'wrong turn'}});
    else {emit({id:m.id,result:{}});notify('turn/completed',{turn:{id:'followup',status:'interrupted'}});}
  }`);
  await session.send("Ask");
  let stopped = false;
  for await (const event of session.events()) {
    if (event.type === "question_request") {
      await Bun.sleep(10);
      await session.respondQuestion(event.data.requestId, { "q-0": ["Blue"] });
      await session.interrupt();
    }
    if (event.type === "system_status" && event.data.includes("stopped")) stopped = true;
  }
  expect(stopped).toBe(true);
});
