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

/** A minimal `opencode acp` peer: records its argv and answers the handshake and one prompt. */
function peerSource(argvFile: string): string {
  return `import {createInterface} from 'node:readline';
import {writeFileSync,appendFileSync} from 'node:fs';
const emit=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
const update=(sessionId,u)=>emit({method:'session/update',params:{sessionId,update:u}});
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
for await (const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line);appendFileSync(${JSON.stringify(`${argvFile}.wire`)},line+'\\n');
  if(m.method==='initialize')emit({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true},mcpCapabilities:{http:true}}}});
  else if(m.method==='session/new')emit({id:m.id,result:{sessionId:'oc-ses-1',configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'a',options:[{value:'test/model',name:'Test'}]}]}});
  else if(m.method==='session/load')emit({id:m.id,result:{configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'a',options:[{value:'custom-provider/example-model',name:'Example model'}]}]}});
  else if(m.method==='session/set_config_option')emit({id:m.id,result:{configOptions:[]}});
  else if(m.method==='session/prompt'){update('oc-ses-1',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OPENCODE REPLY'}});emit({id:m.id,result:{stopReason:'end_turn'}});}
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
