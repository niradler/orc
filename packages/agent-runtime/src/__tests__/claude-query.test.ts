import { expect, test } from "bun:test";
import { resolve } from "node:path";

for (const outcome of ["success", "error", "cancel"]) {
  test(`should close the Claude SDK query after ${outcome}`, () => {
    const script = `
import { mock } from "bun:test";
let closed = 0;
let drained = false;
let streamCompleted = false;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: [],
  query: ({options}) => {
    const stream = (async function* () {
      yield {type:"system",subtype:"init",session_id:"query-fixture"};
      if (${JSON.stringify(outcome)} === "cancel") {
        await new Promise(resolve => options.abortController.signal.addEventListener("abort",resolve,{once:true}));
        return;
      }
      if (${JSON.stringify(outcome)} === "error") throw new Error("fixture stream failure");
      yield {type:"result",subtype:"success",session_id:"query-fixture",is_error:false,usage:{},duration_ms:1};
      await Bun.sleep(25);
      streamCompleted = true;
    })();
    return {
      [Symbol.asyncIterator]: () => stream,
      close: () => { closed++; },
      return: async () => { closed++; await Bun.sleep(25); drained=true; return stream.return(); },
    };
  },
}));
const {loadConfig} = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({rules:{...config.rules,enabled:false},preferences:{}});
await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
const {createBackend} = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const session = await createBackend("claude").startSession({cwd:process.cwd(),orcMcp:false,executionHost:null});
try {
  await session.send("Fixture request");
  const reading = (async () => { const events = []; for await (const event of session.events()) events.push(event); return events; })();
  if (${JSON.stringify(outcome)} === "cancel") {
    await Bun.sleep(10);
    await session.close();
    if (!drained) throw new Error("close returned before SDK subprocess shutdown");
  }
  const events = await reading;
  if (closed !== 1) throw new Error("SDK query was not closed exactly once");
  if (!drained) throw new Error("Session finished before SDK shutdown drained");
  if (${JSON.stringify(outcome)} === "success" && !streamCompleted) throw new Error("Stopped consuming SDK output before process shutdown");
  const expected = ${JSON.stringify(outcome)} === "error" ? "error" : "result";
  if (${JSON.stringify(outcome)} !== "cancel" && !events.some(event => event.type === expected)) throw new Error("Missing normalized outcome");
  console.log("SDK cleanup verified");
} finally { await session.close(); }
`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: resolve(import.meta.dir, "../.."),
      timeout: 15000,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toMatchObject({
      exitCode: 0,
    });
    expect(result.stdout.toString()).toContain("SDK cleanup verified");
  });
}
