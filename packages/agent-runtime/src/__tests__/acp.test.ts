import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSession } from "../acp.js";
import type { AgentEvent, PermissionResult, SessionOpts } from "../types.js";

const owned: { cwd: string; session: AcpSession }[] = [];
afterEach(async () => {
  for (const { cwd, session } of owned.splice(0)) {
    await session.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
function fixture(opts: Partial<SessionOpts> = {}, mode = "normal") {
  const cwd = mkdtempSync(join(tmpdir(), "orc-direct-acp-"));
  const script = join(cwd, "peer.ts");
  writeFileSync(
    script,
    `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
const update=(sessionId,update)=>emit({method:'session/update',params:{sessionId,update}});
let promptId; let session='native-acp'; const mode=${JSON.stringify(mode)};
const ask=id=>emit({id,method:'session/request_permission',params:{sessionId:session,toolCall:{toolCallId:'late',title:'Late action',kind:'execute'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);appendFileSync('wire.ndjson',line+'\\n');
 if(m.id==='client-access') {update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.error)}});emit({id:promptId,result:{stopReason:'end_turn'}});continue;}
 if(m.id==='late-cancel') {emit({id:promptId,result:{stopReason:'cancelled'}});continue;}
 if(m.method==='initialize') emit({id:m.id,result:{protocolVersion:mode==='bad-version'?99:1,agentCapabilities:{loadSession:mode!=='no-resume',promptCapabilities:{image:true},mcpCapabilities:{http:true}}}});
 else if(m.method==='session/new') {emit({id:m.id,result:{sessionId:session,...(mode==='model'?{configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'default',options:[{value:'test-model',name:'Test model'}]}]}:{})}});if(mode==='idle-permission')setTimeout(()=>ask('late-idle'),20);}
 else if(m.method==='session/set_config_option') emit({id:m.id,result:{configOptions:[]}});
 else if(m.method==='session/load') { session=m.params.sessionId;update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD HISTORY'}});emit({id:m.id,result:{}}); }
 else if(m.method==='session/prompt') {
  promptId=m.id;
  if(mode==='exit') { process.exit(2); }
  else if(mode==='oversize') process.stdout.write('x'.repeat(2100000));
  else if(mode==='cancel'||mode==='cancel-late') {}
  else if(mode==='client-fs'||mode==='client-terminal') {emit({id:'client-access',method:mode==='client-fs'?'fs/write_text_file':'terminal/create',params:mode==='client-fs'?{sessionId:session,path:process.cwd()+'/forbidden.txt',content:'must not write'}:{sessionId:session,command:'node',args:['-e',"require('fs').writeFileSync('forbidden.txt','must not run')"],env:[]}});}
  else if(mode==='result-exit') {update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'last frame'}});emit({id:promptId,result:{stopReason:'end_turn'}});process.exit(0);}
  else {
   update('other-session',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'WRONG SESSION'}});
   update(session,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Working'}});
   update(session,{sessionUpdate:'tool_call',toolCallId:'read-1',title:'Read file',kind:'read',status:'pending',rawInput:{path:'a.txt'}});
   emit({id:'permission',method:'session/request_permission',params:{sessionId:session,toolCall:{toolCallId:'read-1',title:'Read file',kind:'read'},options:[{optionId:'native-allow',name:'Yes',kind:mode==='persistent-only'?'allow_always':'allow_once'},{optionId:'native-deny',name:'No',kind:'reject_once'}]}});
  }
 } else if(m.id==='permission') {
  update(session,{sessionUpdate:'tool_call_update',toolCallId:'read-1',status:'completed',rawOutput:'file contents'});
  update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.result)}});
  emit({id:promptId,result:{stopReason:'end_turn'}});
 } else if(m.method==='session/cancel') {if(mode==='cancel-late')ask('late-cancel');else emit({id:promptId,result:{stopReason:'cancelled'}});}
}`,
  );
  const session = new AcpSession({ cwd, orcMcp: false, ...opts }, [process.execPath, script]);
  owned.push({ cwd, session });
  return { session, cwd };
}
async function run(session: AcpSession, decision: PermissionResult = "approved") {
  const events: AgentEvent[] = [];
  for await (const event of session.events()) {
    events.push(event);
    if (event.type === "permission_request")
      session.respondPermission(event.data.requestId, decision);
  }
  return events;
}
for (const decision of ["approved", "denied", "session"] as const) {
  test(`ACP streams a real protocol turn and answers ${decision} using native option IDs`, async () => {
    const { session, cwd } = fixture();
    await session.initialize();
    expect(session.capabilities).toMatchObject({
      source: "negotiated",
      resume: true,
      approvals: true,
      images: true,
      steering: false,
      fork: false,
    });
    await session.send("Inspect a file");
    const events = await run(session, decision);
    expect(events.some((e) => e.type === "thinking")).toBe(true);
    expect(events.some((e) => e.type === "tool_result" && e.data.content === "file contents")).toBe(
      true,
    );
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => e.data)
      .join("");
    expect(JSON.parse(text)).toEqual({
      outcome: {
        outcome: "selected",
        optionId: decision === "denied" ? "native-deny" : "native-allow",
      },
    });
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(wire.find((m) => m.method === "initialize").params.clientCapabilities).toEqual({});
    expect(session.getRuntimeSessionId()).toBe("native-acp");
  });
}

test("ACP resumes the saved identity without replaying old messages into a new response", async () => {
  const { session } = fixture({ runtimeSessionId: "saved-session" });
  await session.initialize();
  await session.send("Continue");
  const events = await run(session);
  expect(events.some((e) => e.type === "text" && /OLD HISTORY|WRONG SESSION/.test(e.data))).toBe(
    false,
  );
  expect(session.getRuntimeSessionId()).toBe("saved-session");
});

test("ACP refuses unsupported resume and protocol versions without creating another session", async () => {
  for (const mode of ["no-resume", "bad-version"]) {
    const { session, cwd } = fixture({ runtimeSessionId: "saved-session" }, mode);
    await expect(session.initialize()).rejects.toThrow(
      mode === "no-resume" ? "cannot resume" : "protocol version",
    );
    expect(readFileSync(join(cwd, "wire.ndjson"), "utf8")).not.toContain("session/new");
    expect(session.alive()).toBe(false);
  }
});

test("ACP never escalates a once or session reply to a persistent permission", async () => {
  const { session } = fixture({}, "persistent-only");
  await session.initialize();
  await session.send("Read");
  const events = await run(session, "session");
  const text = events
    .filter((e) => e.type === "text")
    .map((e) => e.data)
    .join("");
  expect(JSON.parse(text)).toEqual({ outcome: { outcome: "cancelled" } });
});

test("ACP cancellation completes without losing native identity", async () => {
  const { session } = fixture({}, "cancel");
  await session.initialize();
  await session.send("Wait");
  await session.interrupt();
  const events = await run(session);
  expect(events.some((e) => e.type === "system_status" && e.data.includes("stopped"))).toBe(true);
  expect(session.getRuntimeSessionId()).toBe("native-acp");
});

test("ACP agent exits and oversized frames fail the active consumer promptly", async () => {
  for (const mode of ["exit", "oversize"]) {
    const { session } = fixture({}, mode);
    await session.initialize();
    await session.send("Go");
    const events = await run(session);
    expect(events.some((e) => e.type === "error")).toBe(true);
  }
}, 5000);

test("ACP applies an advertised model config and rejects a model it cannot honor", async () => {
  const { session, cwd } = fixture({ model: "test-model" }, "model");
  await session.initialize();
  expect(session.capabilities.modelSelection).toBe(true);
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(wire.find((m) => m.method === "session/set_config_option").params).toEqual({
    sessionId: "native-acp",
    configId: "model",
    value: "test-model",
  });
  const unsupported = fixture({ model: "test-model" }).session;
  await expect(unsupported.initialize()).rejects.toThrow("does not expose model selection");
  expect(unsupported.alive()).toBe(false);
});

for (const mode of ["idle-permission", "cancel-late"]) {
  test(`ACP never auto-approves a permission outside an active uncancelled turn (${mode})`, async () => {
    const { session, cwd } = fixture({ autoApprove: true }, mode);
    await session.initialize();
    if (mode === "cancel-late") {
      await session.send("Wait");
      await session.interrupt();
      await run(session);
    } else await Bun.sleep(60);
    const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const reply = wire.find(
      (m) => m.id === (mode === "cancel-late" ? "late-cancel" : "late-idle") && !m.method,
    );
    expect(reply?.result).toEqual({ outcome: { outcome: "cancelled" } });
  });
}

test("ACP drains successful final frames before observing process exit", async () => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { session } = fixture({}, "result-exit");
    await session.initialize();
    await session.send("Complete and exit");
    const events = await run(session);
    expect(events).toContainEqual({ type: "text", data: "last frame" });
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    await session.close();
  }
});

for (const mode of ["client-fs", "client-terminal"]) {
  test(`ACP rejects unadvertised client privileges (${mode})`, async () => {
    const { session, cwd } = fixture({}, mode);
    await session.initialize();
    await session.send("Request client access");
    const events = await run(session);
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => e.data)
      .join("");
    expect(JSON.parse(text)).toMatchObject({ code: -32601 });
    expect(existsSync(join(cwd, "forbidden.txt"))).toBe(false);
  });
}
