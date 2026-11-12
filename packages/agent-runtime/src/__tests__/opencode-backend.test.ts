import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfig } from "@orc/core/config";
import { closeDb, createTestDb } from "@orc/db/client";
import { chatBackendFor, OPENCODE_CAPABILITIES } from "../capabilities.js";
import { createBackend } from "../index.js";
import type { AgentEvent } from "../types.js";

const saved = {
  db: process.env.ORC_DB_PATH,
  rules: process.env.ORC_RULES_ENABLED,
};
beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_RULES_ENABLED = "false";
  resetConfig();
  createTestDb();
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key === "db" ? "ORC_DB_PATH" : "ORC_RULES_ENABLED"];
    else process.env[key === "db" ? "ORC_DB_PATH" : "ORC_RULES_ENABLED"] = value;
  closeDb();
  resetConfig();
});

/** A minimal `opencode acp` peer: records its argv, answers the handshake and exercises forms. */
function peerSource(argvFile: string): string {
  return `import {createInterface} from 'node:readline';
import {writeFileSync,appendFileSync} from 'node:fs';
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
const update=(sessionId,u)=>emit({method:'session/update',params:{sessionId,update:u}});
const answerFile=${JSON.stringify(`${argvFile}.answers`)};
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
let forms=0;
const prompts=new Map();
const schemas={
  single:{type:'object',required:['target'],properties:{target:{type:'string',title:'Target',description:'Where should this run?',oneOf:[{const:'local-value',title:'This machine',description:'Run locally'},{const:'remote-value',title:'Remote host',description:'Run over SSH'}]}}},
  multi:{type:'object',required:['colors'],properties:{colors:{type:'array',title:'Colors',items:{anyOf:[{const:'red-value',title:'Red'},{const:'blue-value',title:'Blue'}]},minItems:1,maxItems:2}}},
  free:{type:'object',required:['note'],properties:{note:{type:'string',title:'Note',description:'Add a note'}}},
  custom:{type:'object',required:['fruit'],properties:{fruit:{type:'string',title:'Fruit',oneOf:[{const:'apple-value',title:'Apple'}]},fruit_custom:{type:'string',title:'Fruit (other)',description:'Type your own answer'}}},
  unsupported:{type:'object',properties:{choice:{type:'external',title:'Unsupported input'}}},
  cancel:{type:'object',required:['target'],properties:{target:{type:'string',title:'Target',oneOf:[{const:'local-value',title:'This machine'}]}}},
};
const ask=(scenario,sessionId)=>{const id='elicitation-'+(++forms);emit({id,method:'elicitation/create',params:{mode:'form',sessionId,message:'Agent question',_meta:{kind:'question'},requestedSchema:schemas[scenario]}});return id};
for await (const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line);appendFileSync(${JSON.stringify(`${argvFile}.wire`)},line+'\\n');
  if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true},mcpCapabilities:{http:true}}}});
  else if(m.method==='session/new')emit({id:m.id,result:{sessionId:'oc-ses-1',configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'a',options:[{value:'test/model',name:'Test'}]}]}});
  else if(m.method==='session/load')emit({id:m.id,result:{configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'a',options:[{value:'custom-provider/example-model',name:'Example model'}]}]}});
  else if(m.method==='session/set_config_option')emit({id:m.id,result:{configOptions:[]}});
  else if(m.method==='session/prompt'){
    const text=(m.params.prompt??[]).map(part=>part.type==='text'?part.text:'').join('\\n');
    const scenario=['single','multi','free','custom','unsupported','cancel'].find(name=>text.includes(name));
    if(!scenario){update('oc-ses-1',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OPENCODE REPLY'}});emit({id:m.id,result:{stopReason:'end_turn'}});}
    else prompts.set(String(ask(scenario,'oc-ses-1')),{promptId:m.id,scenario});
  }
  else if(!m.method&&m.id!==undefined){
    const entry=prompts.get(String(m.id));
    if(!entry)continue;
    prompts.delete(String(m.id));
    appendFileSync(answerFile,JSON.stringify({scenario:entry.scenario,result:m.result})+'\\n');
    if(entry.scenario==='cancel')emit({id:entry.promptId,result:{stopReason:'cancelled'}});
    else{update('oc-ses-1',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ELICITATION '+JSON.stringify(m.result)}});emit({id:entry.promptId,result:{stopReason:'end_turn'}});}
  }
}`;
}

async function drainText(session: {
  send(prompt: string): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
}): Promise<AgentEvent[]> {
  await session.send("hello");
  const events: AgentEvent[] = [];
  for await (const event of session.events()) {
    events.push(event);
    if (event.type === "result" || event.type === "error") break;
  }
  return events;
}

async function answerPrompt(
  session: {
    send(prompt: string): Promise<void>;
    respondQuestion?(requestId: string, answers: Record<string, string[]>): void | Promise<void>;
    events(): AsyncIterable<AgentEvent>;
  },
  prompt: string,
  answers: (
    question: Extract<AgentEvent, { type: "question_request" }>["data"],
  ) => Record<string, string[]> | Promise<Record<string, string[]>>,
): Promise<{
  events: AgentEvent[];
  question: Extract<AgentEvent, { type: "question_request" }>["data"];
}> {
  await session.send(prompt);
  const events: AgentEvent[] = [];
  let question: Extract<AgentEvent, { type: "question_request" }>["data"] | undefined;
  for await (const event of session.events()) {
    events.push(event);
    if (event.type === "question_request") {
      question = event.data;
      await session.respondQuestion?.(event.data.requestId, await answers(event.data));
    }
  }
  if (!question) throw new Error("The peer did not ask a question.");
  return { events, question };
}

function lastAnswer(argvFile: string): { scenario: string; result: unknown } {
  const lines = readFileSync(`${argvFile}.answers`, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}");
}

async function startPeer(cwd: string): Promise<{
  argvFile: string;
  session: Awaited<ReturnType<ReturnType<typeof createBackend>["startSession"]>>;
}> {
  const argvFile = join(cwd, "argv.json");
  const source = join(cwd, "opencode.ts");
  writeFileSync(source, `#!/usr/bin/env bun\n${peerSource(argvFile)}`, { mode: 0o755 });
  const script = process.platform === "win32" ? join(cwd, "opencode.exe") : source;
  if (process.platform === "win32")
    expect(
      Bun.spawnSync([process.execPath, "build", source, "--compile", "--outfile", script], {
        timeout: 30_000,
      }).exitCode,
    ).toBe(0);
  const session = await createBackend("opencode").startSession({
    cwd,
    orcMcp: false,
    providerExecutable: script,
    acpAgent: "opencode",
  });
  return { argvFile, session };
}

test("opencode backend runs the builtin ACP command with a provider executable override", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-opencode-backend-"));
  try {
    const argvFile = join(cwd, "argv.json");
    const source = join(cwd, "opencode.ts");
    writeFileSync(source, `#!/usr/bin/env bun\n${peerSource(argvFile)}`, { mode: 0o755 });
    const script = process.platform === "win32" ? join(cwd, "opencode.exe") : source;
    if (process.platform === "win32")
      expect(
        Bun.spawnSync([process.execPath, "build", source, "--compile", "--outfile", script], {
          timeout: 30_000,
        }).exitCode,
      ).toBe(0);
    expect(chatBackendFor("opencode")).toBe("opencode");
    const backend = createBackend("opencode");
    expect(backend.name).toBe("opencode");
    expect(OPENCODE_CAPABILITIES.questions).toBe(false);
    expect(backend.capabilities).toEqual(OPENCODE_CAPABILITIES);
    expect(backend.describe?.()).toMatchObject({ kind: "cli", source: "builtin" });
    expect(await backend.preflight({ providerExecutable: script })).toEqual({ ok: true });
    const missing = await backend.preflight({ providerExecutable: join(cwd, "absent") });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("not installed");
    const session = await backend.startSession({
      cwd,
      orcMcp: false,
      providerExecutable: script,
      acpAgent: "opencode",
      model: "custom-provider/example-model",
    });
    try {
      expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual(["acp"]);
      expect(session.capabilities).toMatchObject({
        source: "negotiated",
        resume: true,
        images: true,
        mcp: true,
        modelSelection: true,
        approvals: true,
        questions: true,
        interrupt: true,
      });
      const events = await drainText(session);
      expect(events.some((event) => event.type === "text" && event.data === "OPENCODE REPLY")).toBe(
        true,
      );
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(session.getRuntimeSessionId?.()).toBe("oc-ses-1");
    } finally {
      await session.close();
    }
    const resumed = await backend.resumeSession("oc-ses-1", {
      cwd,
      orcMcp: false,
      providerExecutable: script,
      model: "custom-provider/example-model",
    });
    try {
      expect((await drainText(resumed)).some((event) => event.type === "text")).toBe(true);
      const requests = readFileSync(`${argvFile}.wire`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.some((request) => request.method === "session/load")).toBe(true);
      expect(
        requests
          .filter((request) => request.method === "session/set_config_option")
          .map((request) => request.params.value),
      ).toEqual(["custom-provider/example-model", "custom-provider/example-model"]);
    } finally {
      await resumed.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("should answer ACP single-select, multi-select, free-text and custom questions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-opencode-forms-"));
  try {
    const { argvFile, session } = await startPeer(cwd);
    try {
      const single = await answerPrompt(session, "single select", () => ({
        target: ["Remote host"],
      }));
      expect(single.question.questions[0]?.options?.map((option) => option.label)).toEqual([
        "This machine",
        "Remote host",
      ]);
      expect(lastAnswer(argvFile)).toEqual({
        scenario: "single",
        result: { action: "accept", content: { target: "remote-value" } },
      });

      const multi = await answerPrompt(session, "multi select", () => ({
        colors: ["Red", "Blue"],
      }));
      expect(multi.question.questions[0]?.multiSelect).toBe(true);
      expect(lastAnswer(argvFile)).toEqual({
        scenario: "multi",
        result: { action: "accept", content: { colors: ["red-value", "blue-value"] } },
      });

      await answerPrompt(session, "free text", () => ({ note: ["a note"] }));
      expect(lastAnswer(argvFile)).toEqual({
        scenario: "free",
        result: { action: "accept", content: { note: "a note" } },
      });

      const custom = await answerPrompt(session, "custom answer", () => ({ fruit: ["Mango"] }));
      expect(custom.question.questions.map((question) => question.id)).toEqual(["fruit"]);
      expect(lastAnswer(argvFile)).toEqual({
        scenario: "custom",
        result: { action: "accept", content: { fruit: "Mango", fruit_custom: "Mango" } },
      });
    } finally {
      await session.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("should decline an unsupported ACP form and surface the native-client message", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-opencode-form-decline-"));
  try {
    const { argvFile, session } = await startPeer(cwd);
    try {
      await session.send("unsupported schema");
      const events: AgentEvent[] = [];
      for await (const event of session.events()) {
        events.push(event);
        if (event.type === "result" || event.type === "error") break;
      }
      expect(events.some((event) => event.type === "question_request")).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === "system_status" &&
            event.data.includes("native client") &&
            event.data.includes("Unsupported form field type"),
        ),
      ).toBe(true);
      expect(lastAnswer(argvFile)).toEqual({
        scenario: "unsupported",
        result: { action: "decline" },
      });
    } finally {
      await session.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("should cancel a pending ACP question when the turn is interrupted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-opencode-form-cancel-"));
  try {
    const { argvFile, session } = await startPeer(cwd);
    try {
      await session.send("cancel question");
      const events: AgentEvent[] = [];
      for await (const event of session.events()) {
        events.push(event);
        if (event.type === "question_request") {
          expect(session.waitingForHuman?.()).toBe(true);
          await session.interrupt?.();
        }
        if (event.type === "result" || event.type === "error") break;
      }
      expect(lastAnswer(argvFile)).toEqual({
        scenario: "cancel",
        result: { action: "cancel" },
      });
      expect(session.waitingForHuman?.()).toBe(false);
    } finally {
      await session.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("opencode preflight reports a missing install with actionable guidance", async () => {
  const backend = createBackend("opencode");
  const result = await backend.preflight({
    providerExecutable: "/definitely/not/installed/opencode",
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("npm install -g opencode-ai");
  expect(result.error).toContain("agent_loop.acp_commands.opencode");
});

test("agent_loop.acp_commands.opencode overrides the builtin command and routes chat to acp", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-opencode-config-"));
  try {
    const argvFile = join(cwd, "argv.json");
    const script = join(cwd, "peer.ts");
    writeFileSync(script, peerSource(argvFile));
    const base = loadConfig();
    loadConfig({
      agent_loop: {
        ...base.agent_loop,
        acp_commands: {
          ...(base.agent_loop.acp_commands ?? {}),
          opencode: { command: process.execPath, args: [script, "--extra"] },
        },
      },
    });
    try {
      expect(chatBackendFor("opencode")).toBe("acp");
      const backend = createBackend("opencode");
      expect(await backend.preflight({})).toEqual({ ok: true });
      const session = await backend.startSession({ cwd, orcMcp: false });
      try {
        expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual(["--extra"]);
        const events = await drainText(session);
        expect(
          events.some((event) => event.type === "text" && event.data === "OPENCODE REPLY"),
        ).toBe(true);
      } finally {
        await session.close();
      }
    } finally {
      resetConfig();
      loadConfig({ rules: { enabled: false } });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
