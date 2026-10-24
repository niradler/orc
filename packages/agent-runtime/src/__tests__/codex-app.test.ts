import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppSession } from "../codex-app";
import type { AgentEvent, SessionOpts } from "../types";

function fixture(opts: Partial<SessionOpts> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "orc-app-protocol-"));
  const script = join(cwd, "app.ts");
  writeFileSync(
    script,
    `
import { createInterface } from "node:readline";
const emit = value => console.log(JSON.stringify(value));
const notify = (method, params) => emit({method, params: {threadId:'native-fixture', ...params}});
let received = {}; let thread = {}; let turn = 0;
for await (const line of createInterface({input:process.stdin})) {
 const msg = JSON.parse(line);
 if(msg.method === 'initialize') emit({id:msg.id,result:{}});
 if(msg.method === 'thread/start' || msg.method === 'thread/resume') { thread=msg.params; emit({id:msg.id,result:{thread:{id:'native-fixture'}}}); }
 if(msg.method === 'turn/start') {
   turn++; received={}; emit({id:msg.id,result:{turn:{id:'turn-'+turn}}});
   emit({id:'approval-'+turn,method:'item/commandExecution/requestApproval',params:{threadId:'native-fixture',turnId:'turn-'+turn,command:'echo harmless',cwd:thread.cwd}});
   emit({id:'question-'+turn,method:'item/tool/requestUserInput',params:{threadId:'native-fixture',turnId:'turn-'+turn,questions:[{id:'color',header:'Color',question:'Choose color',options:[{label:'Blue',description:'Blue color'}]}]}});
 }
 if(!msg.method && typeof msg.id === 'string') {
   received[msg.id.startsWith('approval')?'approval':'question']=msg.result;
   if(Object.keys(received).length===2) {
     notify('item/agentMessage/delta',{delta:JSON.stringify({received,thread,args:process.argv.slice(2)})});
     notify('turn/completed',{turn:{id:'turn-'+turn,status:'completed'}});
   }
 }
}

`,
  );
  return new CodexAppSession({ cwd, orcMcp: false, ...opts }, { kind: "local" }, async () => [
    process.execPath,
    script,
  ]);
}

test("should retain exact file changes and deliver a typed MCP form on the same native thread", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-file-form-"));
  const script = join(cwd, "native.ts");
  writeFileSync(
    script,
    `
import { createInterface } from 'node:readline';
const emit = value => console.log(JSON.stringify(value));
const received = {};
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.method==='initialize') emit({id:m.id,result:{}});
 else if(m.method==='thread/start') emit({id:m.id,result:{thread:{id:'file-form'}}});
 else if(m.method==='turn/start') {
  emit({id:m.id,result:{}});
  emit({method:'item/started',params:{threadId:'file-form',item:{type:'fileChange',id:'patch',changes:[{path:'a.ts',kind:'update',diff:'+safe change'}]}}});
  emit({id:'file',method:'item/fileChange/requestApproval',params:{threadId:'file-form',itemId:'patch',grantRoot:'${cwd.replaceAll("\\", "\\\\")}',reason:'Review patch'}});
  emit({id:'form',method:'mcpServer/elicitation/request',params:{threadId:'file-form',serverName:'fixture',mode:'form',message:'Choose',requestedSchema:{type:'object',required:['enabled'],properties:{enabled:{type:'boolean'}}}}});
 } else if(m.id==='file' || m.id==='form') {
  received[m.id]=m.result;
  if(Object.keys(received).length===2) {
   emit({method:'item/agentMessage/delta',params:{threadId:'file-form',delta:JSON.stringify(received)}});
   emit({method:'turn/completed',params:{threadId:'file-form',turn:{status:'completed'}}});
  }
 }
}`,
  );
  const session = new CodexAppSession({ cwd, orcMcp: false }, { kind: "local" }, async () => [
    process.execPath,
    script,
  ]);
  try {
    await session.send("Review");
    for await (const event of session.events()) {
      if (event.type === "permission_request") {
        expect(JSON.stringify(event.data.input)).toContain("+safe change");
        session.respondPermission(event.data.requestId, "denied");
      }
      if (event.type === "question_request")
        await session.respondQuestion(event.data.requestId, { enabled: ["true"] });
      if (event.type === "text")
        expect(JSON.parse(event.data)).toEqual({
          file: { decision: "decline" },
          form: { action: "accept", content: { enabled: true } },
        });
    }
  } finally {
    await session.close();
  }
});

for (const [mode, sandbox, approval] of [
  ["default", "read-only", "on-request"],
  ["acceptEdits", "workspace-write", "never"],
  ["bypassPermissions", "danger-full-access", "never"],
] as const) {
  test(`should round-trip approvals and questions with ${mode} and resume the same conversation`, async () => {
    const session = fixture({
      permissionMode: mode,
      chatAgentOptions: { runtime: "codex", args: ["-c", 'model_reasoning_effort="low"'] },
    });
    try {
      for (const decision of ["approved", "denied"] as const) {
        await session.send("Question");
        const events: AgentEvent[] = [];
        for await (const event of session.events()) {
          events.push(event);
          if (event.type === "permission_request") {
            expect(() => session.respondPermission("stale", "approved")).toThrow(
              "no longer pending",
            );
            session.respondPermission(event.data.requestId, decision);
            expect(() => session.respondPermission(event.data.requestId, decision)).toThrow(
              "no longer pending",
            );
          }
          if (event.type === "question_request") {
            await expect(
              session.respondQuestion(event.data.requestId, { wrong: ["x"] }),
            ).rejects.toThrow("every question");
            await session.respondQuestion(event.data.requestId, { color: ["Blue"] });
          }
        }
        const text = events.find((event) => event.type === "text");
        if (text?.type !== "text") throw new Error("No reply after responding");
        const result = JSON.parse(text.data);
        expect(result.received.approval.decision).toBe(
          decision === "approved" ? "accept" : "decline",
        );
        expect(result.received.question.answers).toEqual({ color: { answers: ["Blue"] } });
        expect(result.thread).toMatchObject({ sandbox, approvalPolicy: approval });
        expect(result.args.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"]);
        expect(result.args).toContain('approvals_reviewer="user"');
        expect(result.args).toContain("features.default_mode_request_user_input=true");
        expect(result.thread.approvalsReviewer).toBe("user");
        expect(result.args).toContain('model_reasoning_effort="low"');
        expect(events.filter((event) => event.type === "request_resolved")).toHaveLength(2);
        expect(session.getRuntimeSessionId()).toBe("native-fixture");
      }
    } finally {
      await session.close();
    }
  });
}

test("should restore an existing native thread without creating a replacement", async () => {
  const session = fixture({ runtimeSessionId: "native-fixture" });
  try {
    await session.send("Continue");
    for await (const event of session.events()) {
      if (event.type === "permission_request")
        session.respondPermission(event.data.requestId, "denied");
      if (event.type === "question_request")
        await session.respondQuestion(event.data.requestId, { color: ["Blue"] });
      if (event.type === "text")
        expect(JSON.parse(event.data).thread.threadId).toBe("native-fixture");
    }
  } finally {
    await session.close();
  }
});

for (const decision of ["approved", "denied"] as const) {
  test(`should ${decision === "approved" ? "grant only requested" : "deny"} native permission profiles`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-permission-profile-"));
    const script = join(cwd, "profile.ts");
    writeFileSync(
      script,
      `
import { createInterface } from 'node:readline';
const emit = value => console.log(JSON.stringify(value));
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.method==='initialize') emit({id:m.id,result:{}});
 else if(m.method==='thread/start') emit({id:m.id,result:{thread:{id:'profile-native'}}});
 else if(m.method==='turn/start') {
  emit({id:m.id,result:{}});
  emit({id:'grant',method:'item/permissions/requestApproval',params:{threadId:'profile-native',turnId:'turn-1',permissions:{network:{enabled:true}},reason:'Validation network request'}});
 } else if(m.id==='grant') {
  emit({method:'item/agentMessage/delta',params:{threadId:'profile-native',delta:JSON.stringify(m.result)}});
  emit({method:'turn/completed',params:{threadId:'profile-native',turn:{status:'completed'}}});
 }
}`,
    );
    const session = new CodexAppSession({ cwd, orcMcp: false }, { kind: "local" }, async () => [
      process.execPath,
      script,
    ]);
    try {
      await session.send("Request access");
      for await (const event of session.events()) {
        if (event.type === "permission_request") {
          expect(event.data.command).toContain('"network"');
          session.respondPermission(event.data.requestId, decision);
        }
        if (event.type === "text")
          expect(JSON.parse(event.data)).toEqual({
            permissions: decision === "approved" ? { network: { enabled: true } } : {},
            scope: "turn",
          });
      }
    } finally {
      await session.close();
    }
  });
}

for (const completeBeforeAnswer of [false, true]) {
  test(`should answer asynchronous questions ${completeBeforeAnswer ? "after turn completion" : "during the active turn"}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-async-question-"));
    const script = join(cwd, "async.ts");
    writeFileSync(
      script,
      `
import { createInterface } from 'node:readline';
const emit = value => console.log(JSON.stringify(value));
let started = false;
for await (const line of createInterface({input:process.stdin})) {
 const m = JSON.parse(line);
 if(m.method==='initialize') emit({id:m.id,result:{}});
 else if(m.method==='thread/start') emit({id:m.id,result:{thread:{id:'async-native'}}});
 else if(m.method==='turn/start' && !started) {
  started=true; emit({id:m.id,result:{turn:{id:'turn-1'}}});
  emit({method:'item/completed',params:{threadId:'async-native',turnId:'turn-1',item:{type:'agentMessage',id:'question-item',text:'Pick a color',questions:[{title:'Which color?',options:['Red','Blue']}]}}});
  if(${completeBeforeAnswer}) emit({method:'turn/completed',params:{threadId:'async-native',turn:{id:'turn-1',status:'completed'}}});
 } else if(m.method==='turn/steer' || m.method==='turn/start') {
  emit({id:m.id,result:{}});
  emit({method:'item/agentMessage/delta',params:{threadId:'async-native',itemId:'answer',delta:JSON.stringify(m)}});
  emit({method:'turn/completed',params:{threadId:'async-native',turn:{id:'turn-2',status:'completed'}}});
 }
}`,
    );
    const session = new CodexAppSession({ cwd, orcMcp: false }, { kind: "local" }, async () => [
      process.execPath,
      script,
    ]);
    try {
      await session.send("Ask");
      let answered = false;
      let result = false;
      for await (const event of session.events()) {
        if (event.type === "question_request") {
          // Let the completed notification arrive before replying, exercising both paths.
          await Bun.sleep(20);
          await session.respondQuestion(event.data.requestId, { "q-0": ["Blue"] });
          answered = true;
        } else if (event.type === "text" && event.data.startsWith("{")) {
          const reply = JSON.parse(event.data);
          expect(reply.method).toBe(completeBeforeAnswer ? "turn/start" : "turn/steer");
          expect(reply.params.input[0].text).toContain("Blue");
          if (!completeBeforeAnswer) expect(reply.params.expectedTurnId).toBe("turn-1");
        } else if (event.type === "result") result = true;
      }
      expect(answered && result).toBe(true);
    } finally {
      await session.close();
    }
  });
}
