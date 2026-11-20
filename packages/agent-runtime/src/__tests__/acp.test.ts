import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCapabilities } from "@orc/core/types";
import { AcpSession, SteerNotConsumedError } from "../acp.js";
import { OPENCODE_CAPABILITIES } from "../capabilities.js";
import type { AgentEvent, PermissionResult, SessionOpts } from "../types.js";

const owned: { cwd: string; session: AcpSession }[] = [];
afterEach(async () => {
  for (const { cwd, session } of owned.splice(0)) {
    await session.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
function fixture(opts: Partial<SessionOpts> = {}, mode = "normal", initial?: AgentCapabilities) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "orc-direct-acp-")));
  if (mode === "moved-session") mkdirSync(join(cwd, "moved"), { recursive: true });
  const script = join(cwd, "peer.ts");
  writeFileSync(
    script,
    `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
const update=(sessionId,update)=>emit({method:'session/update',params:{sessionId,update}});
let promptId; const promptIds=[]; let session='native-acp'; let answered=0; const mode=${JSON.stringify(mode)};
const moved=join(process.cwd(),'moved');
const ask=id=>emit({id,method:'session/request_permission',params:{sessionId:session,toolCall:{toolCallId:'late',title:'Late action',kind:'execute'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);appendFileSync('wire.ndjson',line+'\\n');
 if(m.id==='client-access') {update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.error)}});emit({id:promptId,result:{stopReason:'end_turn'}});continue;}
 if(m.id==='late-cancel') {emit({id:promptId,result:{stopReason:'cancelled'}});continue;}
 if(m.method==='initialize') emit({id:m.id,result:{protocolVersion:mode==='bad-version'?99:1,...(mode==='steer-extension'||mode==='steer-decline'||mode==='deny-continue'?{_meta:{steering:{supported:true}}}:{}),agentCapabilities:{loadSession:mode!=='no-resume',...(mode==='moved-session'?{sessionCapabilities:{list:{}}}:{}),promptCapabilities:{image:true},mcpCapabilities:{http:true}}}});
 else if(m.method==='session/new') {emit({id:m.id,result:{sessionId:session,...(mode==='model-effort'?{configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'default',options:[{value:'big-model',name:'Big model'}]},{id:'effort',name:'Effort',category:'thought_level',type:'select',currentValue:'default',options:[{value:'none',name:'None'},{value:'high',name:'High'}]}]}:{}),...(mode==='model'?{configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'default',options:[{value:'test-model',name:'Test model'}]}]}:{}),...(['effort','effort-switch','child-updates','child-permission'].includes(mode)?{configOptions:[{id:'effort',name:'Effort',category:'thought_level',type:'select',currentValue:'default',options:[{value:'none',name:'None'},{value:'high',name:'High'},{value:'default',name:'Default'}]}]}:{})}});if(mode==='idle-permission')setTimeout(()=>ask('late-idle'),20);}
 else if(m.method==='session/set_config_option') emit({id:m.id,result:{configOptions:mode==='model-effort'&&m.params.configId==='model'?[{id:'model',name:'Model',category:'model',type:'select',currentValue:m.params.value,options:[{value:'big-model',name:'Big model'}]},{id:'effort',name:'Effort',category:'thought_level',type:'select',currentValue:'low',options:[{value:'low',name:'Low'},{value:'max',name:'Max'}]}]:[]}});
 else if(m.method==='session/list') emit({id:m.id,result:{sessions:[{sessionId:session,cwd:moved,title:'Moved'}]}});
 else if(m.method==='session/load') { if(mode==='missing-session') {emit({id:m.id,error:{code:-32602,message:'Invalid params: session not found: '+m.params.sessionId,data:{sessionId:m.params.sessionId}}});continue;} if(mode==='moved-session'&&m.params.cwd!==moved) {session=m.params.sessionId;emit({id:m.id,error:{code:-32602,message:'Invalid params: session '+m.params.sessionId+' does not belong to cwd: '+m.params.cwd,data:{sessionId:m.params.sessionId,cwd:m.params.cwd}}});continue;} session=m.params.sessionId;update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD HISTORY'}});emit({id:m.id,result:{}}); }
 else if(m.method==='session/prompt') {
  promptId=m.id;promptIds.push(m.id);
  if(mode==='exit') { process.exit(2); }
  else if(mode==='oversize') process.stdout.write('x'.repeat(2100000));
  else if(mode==='deny-twice'&&promptIds.length===1) {ask('p1');ask('p2');}
  else if(mode==='deny-continue'&&promptIds.length===1) ask('c1');
  else if((mode==='deny-reason'||mode==='deny-twice')&&promptIds.length>1) {update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'FOLLOW-UP '+m.params.prompt[0].text}});emit({id:m.id,result:{stopReason:'end_turn'}});}
  else if(mode==='cancel'||mode==='cancel-late'||mode==='cancel-hold'||mode==='steer-extension'||mode==='steer-decline'||mode==='steer-legacy') {}
  else if(mode==='client-fs'||mode==='client-terminal') {emit({id:'client-access',method:mode==='client-fs'?'fs/write_text_file':'terminal/create',params:mode==='client-fs'?{sessionId:session,path:process.cwd()+'/forbidden.txt',content:'must not write'}:{sessionId:session,command:'node',args:['-e',"require('fs').writeFileSync('forbidden.txt','must not run')"],env:[]}});}
  else if(mode==='result-exit') {update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'last frame'}});emit({id:promptId,result:{stopReason:'end_turn'}});process.exit(0);}
  else if(mode==='usage') {update(session,{sessionUpdate:'usage_update',used:0,size:0});update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'USAGE'}});update(session,{sessionUpdate:'usage_update',used:19828,size:200000,cost:{amount:0,currency:'USD'}});emit({id:promptId,result:{stopReason:'end_turn'}});}
  else if(mode==='effort') {update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'EFFORT OK'}});emit({id:promptId,result:{stopReason:'end_turn'}});}
  else if(mode==='effort-switch') {update(session,{sessionUpdate:'config_option_update',configOptions:[{id:'effort',name:'Effort',category:'thought_level',type:'select',currentValue:'low',options:[{value:'low',name:'Low'},{value:'medium',name:'Medium'}]}]});update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'SWITCHED'}});emit({id:promptId,result:{stopReason:'end_turn'}});}
  else if(mode==='child-chatty') {
   const child={id:'ses_child',parentID:session,depth:1,title:'Long delegation'};
   update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'.repeat(90000)},_meta:{'opencode/child-session':child}});
   for(let i=0;i<40;i++){update(session,{sessionUpdate:'tool_call',toolCallId:'ses_child:t'+i,title:'Read',kind:'read',status:'pending',rawInput:{path:'f'+i},_meta:{'opencode/child-session':child}});update(session,{sessionUpdate:'tool_call_update',toolCallId:'ses_child:t'+i,status:'completed',rawOutput:'ok',_meta:{'opencode/child-session':child}});}
   update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PARENT ANSWER'}});
   emit({id:promptId,result:{stopReason:'end_turn'}});
  }
  else if(mode==='child-updates') {
   const child={id:'ses_child',parentID:session,depth:1,title:'Explore the codebase'};
   update(session,{sessionUpdate:'tool_call',toolCallId:'task-1',title:'task',kind:'other',status:'pending',rawInput:{description:'Explore',subagent_type:'explore'}});
   update(session,{sessionUpdate:'tool_call',toolCallId:'ses_child:read-1',title:'Explore: Read file',kind:'read',status:'pending',rawInput:{path:'b.txt'},_meta:{'opencode/child-session':child}});
   update(session,{sessionUpdate:'tool_call_update',toolCallId:'ses_child:read-1',status:'completed',rawOutput:'child file contents',_meta:{'opencode/child-session':child}});
   update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'CHILD ANSWER'},_meta:{'opencode/child-session':child}});
   update(session,{sessionUpdate:'tool_call_update',toolCallId:'task-1',status:'completed',rawOutput:{metadata:{sessionId:'ses_child'}}});
   update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PARENT ANSWER'}});
   emit({id:promptId,result:{stopReason:'end_turn'}});
  }
  else if(mode==='task-only') {
   update(session,{sessionUpdate:'tool_call',toolCallId:'task-1',title:'task',kind:'think',status:'pending',rawInput:{}});
   update(session,{sessionUpdate:'tool_call_update',toolCallId:'task-1',status:'in_progress',kind:'think',title:'outer probe',rawInput:{description:'outer probe',prompt:'Run it',subagent_type:'general'}});
   update(session,{sessionUpdate:'tool_call_update',toolCallId:'task-2',status:'in_progress',kind:'think',title:'broken probe',rawInput:{description:'broken probe',prompt:'Fail',subagent_type:'general'}});
   update(session,{sessionUpdate:'tool_call_update',toolCallId:'task-1',status:'completed',title:'outer probe',rawOutput:{output:'<task id="ses_a" state="completed">done</task>',metadata:{parentSessionId:session,sessionId:'ses_a'}}});
   update(session,{sessionUpdate:'tool_call_update',toolCallId:'task-2',status:'failed',title:'broken probe',rawOutput:{output:'boom'}});
   emit({id:promptId,result:{stopReason:'end_turn'}});
  }
  else if(mode==='child-nested') {
   const outer={id:'ses_outer',parentID:session,depth:1,title:'Outer'};
   const inner={id:'ses_inner',parentID:'ses_outer',depth:2,title:'Inner'};
   update(session,{sessionUpdate:'tool_call',toolCallId:'ses_outer:t1',title:'Read',kind:'read',status:'pending',rawInput:{path:'a'},_meta:{'opencode/child-session':outer}});
   update(session,{sessionUpdate:'tool_call',toolCallId:'ses_inner:t1',title:'Read',kind:'read',status:'pending',rawInput:{path:'b'},_meta:{'opencode/child-session':inner}});
   emit({id:promptId,result:{stopReason:'end_turn'}});
  }
  else if(mode==='child-permission') {emit({id:'child-permission',method:'session/request_permission',params:{sessionId:session,toolCall:{toolCallId:'ses_child:run-1',title:'Run a command',kind:'execute',_meta:{'opencode/child-session':{id:'ses_child',parentID:session,depth:1,title:'Explore the codebase'}}},options:[{optionId:'native-allow',name:'Yes',kind:'allow_once'},{optionId:'native-deny',name:'No',kind:'reject_once'}]}});}
  else {
   update('other-session',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'WRONG SESSION'}});
   update(session,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Working'}});
   update(session,{sessionUpdate:'tool_call',toolCallId:'read-1',title:'Read file',kind:'read',status:'pending',rawInput:{path:'a.txt'}});
   emit({id:'permission',method:'session/request_permission',params:{sessionId:session,toolCall:{toolCallId:'read-1',...(mode==='speak'?{title:'orc_speak'}:mode==='speak-named'?{name:'orc_speak',title:'Talk to the user'}:mode==='speak-spoofed'?{name:'bash',title:'orc_speak'}:{title:'Read file'}),kind:'read'},options:mode==='session-grant'?[{optionId:'native-once',name:'Yes',kind:'allow_once'},{optionId:'native-always',name:'Always allow',kind:'allow_always'},{optionId:'native-deny',name:'No',kind:'reject_once'}]:[{optionId:'native-allow',name:'Yes',kind:mode==='persistent-only'?'allow_always':'allow_once'},{optionId:'native-deny',name:'No',kind:'reject_once'}]}});
  }
 } else if(m.id==='child-permission') {update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'CHILD DONE'}});emit({id:promptId,result:{stopReason:'end_turn'}});
 } else if(m.id==='p1'||m.id==='p2') {if(++answered===2)emit({id:promptId,result:{stopReason:'end_turn'}});
 } else if(m.id==='c1') {update(session,{sessionUpdate:'tool_call_update',toolCallId:'late',status:'failed'});update(session,{sessionUpdate:'tool_call',toolCallId:'next-1',title:'Next step',kind:'read',status:'pending'});
 } else if(mode==='deny-continue'&&m.method==='_session/steering') {emit({id:m.id,result:{outcome:'injected'}});update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'STEERED '+m.params.prompt[0].text}});emit({id:promptId,result:{stopReason:'end_turn'}});
 } else if(m.id==='permission') {
  update(session,{sessionUpdate:'tool_call_update',toolCallId:'read-1',status:'completed',rawOutput:'file contents'});
  update(session,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m.result)}});
  emit({id:promptId,result:{stopReason:'end_turn'}});
 } else if(m.method==='_session/steering') emit({id:m.id,result:mode==='steer-decline'?{outcome:'promptRequired',reason:'noRunningTurn'}:{outcome:'injected'}});
 else if(m.method==='session/cancel') {if(mode==='cancel-late')ask('late-cancel');else if(mode!=='cancel-hold')for(const id of promptIds)emit({id,result:{stopReason:'cancelled'}});}
}`,
  );
  const session = new AcpSession(
    { cwd, orcMcp: false, ...opts },
    [process.execPath, script],
    initial,
  );
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
    expect(wire.find((m) => m.method === "initialize").params.clientCapabilities).toEqual({
      elicitation: { form: {} },
      _meta: { "opencode/child-session-updates": true },
    });
    expect(session.capabilities.questions).toBe(true);
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

test("ACP follows a saved session the agent moved into another folder", async () => {
  const { session, cwd } = fixture({ runtimeSessionId: "saved-session" }, "moved-session");
  await session.initialize();
  await session.send("Continue");
  const events = await run(session);
  expect(events).toContainEqual({
    type: "system_status",
    data: `This session moved to ${join(cwd, "moved")}; continuing there.`,
  });
  expect(events.find((event) => event.type === "result")?.data).toMatchObject({
    runtimeSessionId: "saved-session",
    cwd: join(cwd, "moved"),
  });
  const loads = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((message) => message.method === "session/load");
  expect(loads.map((message) => message.params.cwd)).toEqual([cwd, join(cwd, "moved")]);
});

test("ACP reports the agent's own session/load failure instead of a generic hint", async () => {
  const { session } = fixture({ runtimeSessionId: "saved-session" }, "missing-session");
  await expect(session.initialize()).rejects.toThrow(
    "ACP session/load failed: Invalid params: session not found: saved-session",
  );
  expect(session.alive()).toBe(false);
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

test("ACP grants a session approval with the agent's allow_always option", async () => {
  const { session } = fixture({}, "session-grant");
  await session.initialize();
  await session.send("Read");
  const events = await run(session, "session");
  const text = events
    .filter((e) => e.type === "text")
    .map((e) => e.data)
    .join("");
  expect(JSON.parse(text)).toEqual({
    outcome: { outcome: "selected", optionId: "native-always" },
  });
});

test("ACP never escalates an ordinary approval to allow_always when it is the only grant", async () => {
  const { session } = fixture({}, "persistent-only");
  await session.initialize();
  await session.send("Read");
  const events = await run(session, "approved");
  const text = events
    .filter((e) => e.type === "text")
    .map((e) => e.data)
    .join("");
  expect(JSON.parse(text)).toEqual({ outcome: { outcome: "cancelled" } });
});

test("ACP falls back to allow_once for a session approval when allow_always is absent", async () => {
  const { session } = fixture();
  await session.initialize();
  await session.send("Read");
  const events = await run(session, "session");
  const text = events
    .filter((e) => e.type === "text")
    .map((e) => e.data)
    .join("");
  expect(JSON.parse(text)).toEqual({
    outcome: { outcome: "selected", optionId: "native-allow" },
  });
});

test("ACP refuses to steer without a declared capability and sends nothing", async () => {
  const { session, cwd } = fixture({}, "cancel");
  await session.initialize();
  await session.send("Wait");
  await expect(session.steer("steer")).rejects.toThrow("does not accept steering");
  await session.interrupt();
  await run(session);
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(wire.filter((m) => m.method === "session/prompt")).toHaveLength(1);
});

test("ACP steers through _session/steering when advertised and keeps a single prompt", async () => {
  const { session, cwd } = fixture({}, "steer-extension", OPENCODE_CAPABILITIES);
  await session.initialize();
  await session.send("Wait");
  await session.steer("steer");
  expect(session.capabilities.steering).toBe(true);
  await session.interrupt();
  await run(session);
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(wire.filter((m) => m.method === "session/prompt")).toHaveLength(1);
  expect(wire.find((m) => m.method === "_session/steering").params).toEqual({
    sessionId: "native-acp",
    prompt: [{ type: "text", text: "steer" }],
    _meta: { steering: { idleBehavior: "promptRequired" } },
  });
});

test("ACP rejects an approval and sends the reason as the next prompt of the same turn", async () => {
  const { session, cwd } = fixture({}, "deny-reason");
  await session.initialize();
  await session.send("Inspect a file");
  const events: AgentEvent[] = [];
  for await (const event of session.events()) {
    events.push(event);
    if (event.type === "permission_request")
      session.respondPermission(event.data.requestId, "denied", " use bun, not npm ");
  }
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(wire.find((m) => m.id === "permission").result).toEqual({
    outcome: { outcome: "selected", optionId: "native-deny" },
  });
  expect(wire.filter((m) => m.method === "session/prompt")[1].params.prompt).toEqual([
    { type: "text", text: "use bun, not npm" },
  ]);
  expect(events.filter((e) => e.type === "result")).toHaveLength(1);
  expect(events.some((e) => e.type === "text" && e.data === "FOLLOW-UP use bun, not npm")).toBe(
    true,
  );
});

test("ACP joins every denial reason into one follow-up prompt", async () => {
  const { session, cwd } = fixture({}, "deny-twice");
  await session.initialize();
  await session.send("Two actions");
  const events: AgentEvent[] = [];
  let index = 0;
  for await (const event of session.events()) {
    events.push(event);
    if (event.type === "permission_request")
      session.respondPermission(event.data.requestId, "denied", `reason ${++index}`);
  }
  const prompts = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((m) => m.method === "session/prompt");
  expect(prompts).toHaveLength(2);
  expect(prompts[1].params.prompt).toEqual([{ type: "text", text: "reason 1\n\nreason 2" }]);
  expect(events.filter((e) => e.type === "result")).toHaveLength(1);
});

test("ACP steers the reason instead of a follow-up when the agent keeps working after a denial", async () => {
  const { session, cwd } = fixture({}, "deny-continue", OPENCODE_CAPABILITIES);
  await session.initialize();
  await session.send("Keep going");
  const events: AgentEvent[] = [];
  for await (const event of session.events()) {
    events.push(event);
    if (event.type === "permission_request")
      session.respondPermission(event.data.requestId, "denied", "use bun");
  }
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(wire.filter((m) => m.method === "session/prompt")).toHaveLength(1);
  expect(wire.find((m) => m.method === "_session/steering").params.prompt).toEqual([
    { type: "text", text: "use bun" },
  ]);
  expect(events.some((e) => e.type === "text" && e.data === "STEERED use bun")).toBe(true);
});

test("ACP offers a session grant only with allow_always and keys it on the tool input", async () => {
  for (const [mode, allowSession] of [
    ["session-grant", true],
    ["normal", false],
  ] as const) {
    const { session } = fixture({}, mode);
    await session.initialize();
    await session.send("Read");
    const events = await run(session, "approved");
    const request = events.find((e) => e.type === "permission_request");
    expect(request?.type === "permission_request" && request.data).toMatchObject({
      allowSession,
      grant: JSON.stringify("Read file"),
    });
  }
});

test("ACP surfaces a promptRequired steer decline as not consumed and keeps the capability", async () => {
  const { session, cwd } = fixture({}, "steer-decline", OPENCODE_CAPABILITIES);
  await session.initialize();
  await session.send("Wait");
  let declineError: unknown;
  try {
    await session.steer("steer");
  } catch (error) {
    declineError = error;
  }
  expect(declineError).toBeInstanceOf(SteerNotConsumedError);
  expect(session.capabilities.steering).toBe(true);
  await session.interrupt();
  await run(session);
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(wire.filter((m) => m.method === "session/prompt")).toHaveLength(1);
});

test("ACP without the steering extension still steers via a second prompt", async () => {
  const { session, cwd } = fixture({}, "steer-legacy", OPENCODE_CAPABILITIES);
  await session.initialize();
  await session.send("Wait");
  await session.steer("steer");
  await session.interrupt();
  await run(session);
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(wire.filter((m) => m.method === "session/prompt")).toHaveLength(2);
  expect(wire.some((m) => m.method === "_session/steering")).toBe(false);
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

test("ACP closing after an explicit Stop does not send a second session/cancel", async () => {
  // cancel-hold acknowledges nothing, so the turn stays busy; a close that
  // re-cancels would put a second session/cancel on the wire.
  const { session, cwd } = fixture({}, "cancel-hold");
  await session.initialize();
  await session.send("Wait");
  await session.interrupt();
  await session.close();
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(wire.filter((m) => m.method === "session/cancel")).toHaveLength(1);
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

for (const [mode, prompted] of [
  ["speak", false],
  ["speak-named", false],
  ["speak-spoofed", true],
] as const)
  test(`ACP auto-approves only the ORC speak tool, by name before title (${mode})`, async () => {
    const { session } = fixture({}, mode);
    await session.initialize();
    await session.send("Say it");
    const events = await run(session, "denied");
    expect(events.some((e) => e.type === "permission_request")).toBe(prompted);
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => e.data)
      .join("");
    expect(JSON.parse(text)).toEqual({
      outcome: { outcome: "selected", optionId: prompted ? "native-deny" : "native-allow" },
    });
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

test("ACP applies the saved OpenCode effort and exposes the live choices", async () => {
  const { session, cwd } = fixture(
    { chatAgentOptions: { runtime: "opencode", options: { effort: "high" } } },
    "effort",
  );
  await session.initialize();
  expect(session.capabilities.effortChoices).toEqual([
    { value: "none", label: "None" },
    { value: "high", label: "High" },
    { value: "default", label: "Default" },
  ]);
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8");
  expect(wire).toContain('"configId":"effort"');
  expect(wire).toContain('"value":"high"');
  await session.send("Go");
  const events = await run(session);
  expect(events.some((e) => e.type === "text" && e.data === "EFFORT OK")).toBe(true);
});

test("ACP reads effort levels from the chosen model, not the session default", async () => {
  const { session, cwd } = fixture(
    { model: "big-model", chatAgentOptions: { runtime: "opencode", options: { effort: "max" } } },
    "model-effort",
  );
  await session.initialize();
  expect(session.capabilities.effortChoices).toEqual([
    { value: "low", label: "Low" },
    { value: "max", label: "Max" },
  ]);
  const wire = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((m) => m.method === "session/set_config_option");
  expect(wire.map((m) => [m.params.configId, m.params.value])).toEqual([
    ["model", "big-model"],
    ["effort", "max"],
  ]);
});

test("ACP keeps the agent default when the saved effort is unavailable for the model", async () => {
  const { session, cwd } = fixture(
    { chatAgentOptions: { runtime: "opencode", options: { effort: "xhigh" } } },
    "effort",
  );
  await session.initialize();
  await session.send("Go");
  const events = await run(session);
  expect(
    events.some(
      (e) =>
        e.type === "system_status" &&
        e.data.includes('Effort "xhigh" is not available for this model'),
    ),
  ).toBe(true);
  expect(readFileSync(join(cwd, "wire.ndjson"), "utf8")).not.toContain('"configId":"effort"');
});

test("ACP refreshes effort choices when the agent reports a config option update", async () => {
  const { session } = fixture({}, "effort-switch");
  await session.initialize();
  await session.send("Switch model");
  const events = await run(session);
  const updates = events.filter((e) => e.type === "capabilities");
  const last = updates[updates.length - 1];
  expect(last?.data.effortChoices).toEqual([
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
  ]);
});

test("ACP reports the context window from the agent's usage update and omits it when none came", async () => {
  const { session } = fixture({}, "usage");
  await session.initialize();
  await session.send("Hi");
  const events = await run(session);
  expect(events.find((e) => e.type === "text")?.data).toBe("USAGE");
  expect(events.find((e) => e.type === "result")?.data).toMatchObject({ contextWindow: 200000 });
  const quiet = fixture({}, "effort").session;
  await quiet.initialize();
  await quiet.send("Hi");
  const result = (await run(quiet)).find((e) => e.type === "result");
  expect(result?.type === "result" && "contextWindow" in result.data).toBe(false);
});

test("ACP sends the ORC preamble once on the first real turn, and slash commands bare", async () => {
  const { session, cwd } = fixture({ systemPromptAppend: "ORC PREAMBLE" }, "effort");
  await session.initialize();
  await session.send("/hello world");
  await run(session);
  await session.send("/var/log/app.log is empty");
  await run(session);
  await session.send("any update since then?");
  await run(session);
  const prompts = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((message) => message.method === "session/prompt")
    .map((message) => message.params.prompt[0].text);
  expect(prompts).toEqual([
    "/hello world",
    "ORC PREAMBLE\n\n/var/log/app.log is empty",
    "any update since then?",
  ]);
});

test("ACP never re-sends the ORC preamble into a resumed session", async () => {
  const { session, cwd } = fixture({
    runtimeSessionId: "saved-session",
    systemPromptAppend: "ORC PREAMBLE",
  });
  await session.initialize();
  await session.send("Continue");
  await run(session);
  await session.send("And then?");
  await run(session);
  const prompts = readFileSync(join(cwd, "wire.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((message) => message.method === "session/prompt")
    .map((message) => message.params.prompt[0].text);
  expect(prompts).toEqual(["Continue", "And then?"]);
});

test("ACP keeps a long subagent delegation under the output limit", async () => {
  const { session } = fixture({}, "child-chatty");
  await session.initialize();
  await session.send("Delegate");
  const events = await run(session);
  expect(events.filter((e) => e.type === "error")).toEqual([]);
  expect(events.filter((e) => e.type === "subagent").length).toBeGreaterThan(40);
  expect(events.some((e) => e.type === "text" && e.data === "PARENT ANSWER")).toBe(true);
});

test("ACP streams OpenCode child-session updates as one inline subagent transcript", async () => {
  const { session } = fixture({}, "child-updates");
  await session.initialize();
  await session.send("Delegate the exploration");
  const events = await run(session);
  const subagents = events.filter((e) => e.type === "subagent");
  expect(subagents.length).toBeGreaterThan(0);
  expect(new Set(subagents.map((event) => event.data.id))).toEqual(new Set(["task-1"]));
  const last = subagents[subagents.length - 1];
  expect(last?.data).toMatchObject({
    id: "task-1",
    title: "Explore the codebase",
    status: "completed",
    text: "CHILD ANSWER",
  });
  const tools = last?.data.activity.filter((item) => item.type === "tool") ?? [];
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ id: "ses_child:read-1", result: "child file contents" });
  // The child's answer never leaks into the parent's text stream.
  const text = events
    .filter((e) => e.type === "text")
    .map((e) => e.data)
    .join("");
  expect(text).toBe("PARENT ANSWER");
  // The parent keeps its own task call.
  expect(events.some((e) => e.type === "tool_use" && e.data.id === "task-1")).toBe(true);
});

test("ACP shows OpenCode task calls as subagents when the child session is not streamed", async () => {
  const { session } = fixture({}, "task-only");
  await session.initialize();
  await session.send("Delegate");
  const events = await run(session);
  const latest = new Map<string, Extract<AgentEvent, { type: "subagent" }>["data"]>();
  for (const event of events) if (event.type === "subagent") latest.set(event.data.id, event.data);
  expect([...latest.keys()]).toEqual(["task-1", "task-2"]);
  expect(latest.get("task-1")).toMatchObject({ title: "outer probe", status: "completed" });
  expect(latest.get("task-2")).toMatchObject({ title: "broken probe", status: "failed" });
  expect(latest.get("task-1")?.durationMs).toBeGreaterThanOrEqual(0);
  const first = events.find((event) => event.type === "subagent");
  expect(first?.type === "subagent" && first.data.status).toBe("running");
});

test("ACP starts each turn's task subagents fresh", async () => {
  const { session } = fixture({}, "task-only");
  await session.initialize();
  await session.send("Delegate");
  await run(session);
  await Bun.sleep(20);
  const secondTurn = Date.now();
  await session.send("Delegate again");
  const events = await run(session);
  const first = events.find((event) => event.type === "subagent" && event.data.id === "task-1");
  expect(first?.type === "subagent" && first.data.status).toBe("running");
  expect(first?.type === "subagent" && (first.data.startedAt ?? 0)).toBeGreaterThanOrEqual(
    secondTurn,
  );
});

test("ACP nests a child session under the child that spawned it", async () => {
  const { session } = fixture({}, "child-nested");
  await session.initialize();
  await session.send("Delegate twice");
  const events = await run(session);
  const last = (id: string) =>
    events.findLast((event) => event.type === "subagent" && event.data.id === id);
  const inner = last("ses_inner");
  const outer = last("ses_outer");
  expect(inner?.type === "subagent" && inner.data.parentId).toBe("ses_outer");
  expect(outer?.type === "subagent" && outer.data.parentId).toBeUndefined();
});

test("ACP names the subagent on a child session's permission request", async () => {
  const { session } = fixture({}, "child-permission");
  await session.initialize();
  await session.send("Delegate");
  const events: AgentEvent[] = [];
  for await (const event of session.events()) {
    events.push(event);
    if (event.type === "permission_request") {
      expect(event.data.command).toBe("Explore the codebase: Run a command");
      session.respondPermission(event.data.requestId, "approved");
    }
  }
  expect(events.some((e) => e.type === "result")).toBe(true);
});
