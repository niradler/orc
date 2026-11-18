import { expect, test } from "bun:test";
import { resolve } from "node:path";

const run = (turns: string[], react: string) => {
  const script = `
import { mock } from "bun:test";
let turn = 0;
const ask = (options, tool, input, extra = {}) =>
  options.canUseTool(tool, input, {signal:new AbortController().signal, toolUseID:"t"+turn, ...extra}).then((decision) => console.log("DECISION" + JSON.stringify(decision)));
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: [],
  query: ({options}) => {
    const frames = ${JSON.stringify(turns)}[turn++];
    console.log("OPTIONS" + JSON.stringify({allowedTools: options.allowedTools, additionalDirectories: options.additionalDirectories}));
    const stream = (async function* () {
      yield {type:"system",subtype:"init",session_id:"approvals-fixture"};
      await eval("(async () => {" + frames + "})()");
      yield {type:"result",subtype:"success",session_id:"approvals-fixture",is_error:false,usage:{},duration_ms:1};
    })();
    return { [Symbol.asyncIterator]: () => stream, close: () => {}, return: async () => stream.return(), setPermissionMode: async () => {} };
  },
}));
const {loadConfig} = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({rules:{...config.rules,enabled:false},preferences:{}});
await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
const {createBackend} = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const session = await createBackend("claude").startSession({cwd:process.cwd(),orcMcp:false,executionHost:null,permissionMode:"plan"});
try {
  for (let index = 0; index < ${turns.length}; index++) {
    await session.send("Turn " + index);
    for await (const event of session.events()) {
      if (event.type === "permission_request") console.log("REQUEST" + JSON.stringify(event.data));
      ${react}
    }
  }
} finally { await session.close(); }
`;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, "../.."),
    timeout: 15000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = child.stdout.toString().split("\n");
  const pick = (prefix: string) =>
    lines
      .filter((line) => line.startsWith(prefix))
      .map((line) => JSON.parse(line.slice(prefix.length)));
  if (!pick("OPTIONS").length) throw new Error(child.stderr.toString());
  return { decisions: pick("DECISION"), options: pick("OPTIONS"), requests: pick("REQUEST") };
};

test("Claude allow-for-session returns the suggestions as session rules and keeps them for later turns", () => {
  const { decisions, options, requests } = run(
    [
      `await ask(options, "Bash", {command:"npm test"}, {suggestions:[{type:"addRules",rules:[{toolName:"Bash",ruleContent:"npm test:*"}],behavior:"allow",destination:"localSettings"},{type:"addDirectories",directories:["/tmp/extra"],destination:"localSettings"}]});`,
      "",
    ],
    `if (event.type === "permission_request") session.respondPermission(event.data.requestId, "session");`,
  );
  expect(requests[0]).toMatchObject({ tool: "Bash", allowSession: true });
  expect(decisions[0]).toEqual({
    behavior: "allow",
    updatedInput: { command: "npm test" },
    updatedPermissions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow",
        destination: "session",
      },
      { type: "addDirectories", directories: ["/tmp/extra"], destination: "session" },
    ],
  });
  expect(options[0]).toEqual({ allowedTools: [], additionalDirectories: [] });
  expect(options[1]).toEqual({
    allowedTools: ["Bash(npm test:*)"],
    additionalDirectories: ["/tmp/extra"],
  });
});

test("Claude denies with the user's reason and hides the session grant when the agent forbids it", () => {
  const { decisions, requests } = run(
    [`await ask(options, "Bash", {command:"npm test"}, {suppressAlwaysAllowRule:true});`],
    `if (event.type === "permission_request") session.respondPermission(event.data.requestId, "denied", " use bun test ");`,
  );
  expect(requests[0]).toMatchObject({ allowSession: false });
  expect(decisions[0]).toEqual({
    behavior: "deny",
    message: "The user denied this and said: use bun test",
  });
});

test("approving a Claude plan switches the running session to the chosen mode", () => {
  const { decisions, requests } = run(
    [`await ask(options, "ExitPlanMode", {plan:"# Plan\\n- edit a.ts"});`],
    `if (event.type === "permission_request") { session.setPermissionMode("acceptEdits"); session.respondPermission(event.data.requestId, "approved"); }`,
  );
  expect(requests[0]).toMatchObject({
    tool: "ExitPlanMode",
    input: { plan: "# Plan\n- edit a.ts" },
    allowSession: false,
  });
  expect(decisions[0]).toEqual({
    behavior: "allow",
    updatedInput: { plan: "# Plan\n- edit a.ts" },
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  });
});
