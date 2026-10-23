import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSession, resolveCodexLaunch } from "../codex.js";
import type { AgentEvent } from "../types.js";

test("should drain exec JSON and resume by thread ID with stdin prompts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-codex-protocol-"));
  const script = join(cwd, "cli.ts");
  writeFileSync(
    script,
    `const prompt=await Bun.stdin.text(); console.log(JSON.stringify({type:'thread.started',thread_id:'thread-fixture'})); console.log(JSON.stringify({type:'item.started',item:{id:'tool-1',type:'mcp_tool_call',tool:'context',arguments:{project:'fixture'}}})); console.log(JSON.stringify({type:'item.completed',item:{id:'tool-1',type:'mcp_tool_call',result:{content:[{text:'scope verified'}]},status:'completed'}})); console.log(JSON.stringify({type:'item.completed',item:{id:'text-1',type:'agent_message',text:JSON.stringify({prompt,args:process.argv.slice(2)})}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}}));`,
  );
  const session = new CodexSession({ cwd, autoApprove: true }, { kind: "local" }, async () => [
    process.execPath,
    script,
  ]);
  await session.send("First work unit");
  const first: AgentEvent[] = [];
  for await (const event of session.events()) first.push(event);
  expect(first.find((event) => event.type === "result")).toMatchObject({
    data: { runtimeSessionId: "thread-fixture" },
  });
  expect(first.find((event) => event.type === "tool_result")).toMatchObject({
    data: { toolUseId: "tool-1", isError: false },
  });
  await session.send("Feedback with quotes: ' and \" and &");
  const resumed: AgentEvent[] = [];
  for await (const event of session.events()) resumed.push(event);
  const text = resumed.find((event) => event.type === "text");
  if (text?.type !== "text") throw new Error("Missing resumed text");
  const output = JSON.parse(text.data) as { prompt: string; args: string[] };
  expect(output.prompt).toBe("Feedback with quotes: ' and \" and &");
  expect(output.args.slice(0, 3)).toEqual(["exec", "resume", "thread-fixture"]);
  expect(output.args).toContain("--json");
  expect(output.args.join(" ")).not.toContain("bypass");
  expect(output.args).toContain("mcp_servers.orc.enabled=false");
  expect(output.args).not.toContainEqual(expect.stringMatching(/^mcp_servers\.orc\.url=/));
  expect(output.args).toContainEqual(
    expect.stringMatching(
      /^mcp_servers\.orc_runtime_[a-z0-9]+\.default_tools_approval_mode="approve"$/,
    ),
  );
  expect(output.args.join(" ")).not.toContain(".approval_mode=");
  await session.close();
});

test("should surface a failed exit even when stdout closes first", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-codex-exit-"));
  const script = join(cwd, "failure.ts");
  writeFileSync(
    script,
    "await Bun.stdin.text(); console.error('Authentication failed'); process.exit(7);",
  );
  const session = new CodexSession({ cwd }, { kind: "local" }, async () => [
    process.execPath,
    script,
  ]);
  await session.send("probe");
  const events: AgentEvent[] = [];
  for await (const event of session.events()) events.push(event);
  expect(events).toContainEqual({ type: "error", data: "Authentication failed" });
  expect(session.alive()).toBe(false);
});

test("should refuse an unresolvable Windows shell shim", () => {
  expect(() => resolveCodexLaunch("Z:/missing/codex.cmd", () => null)).toThrow("shell shim");
});

test("should honor native MCP configuration, operator instructions and provider thinking summaries", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-codex-chat-options-"));
  const script = join(cwd, "cli.ts");
  writeFileSync(
    script,
    `const prompt=await Bun.stdin.text(); console.log(JSON.stringify({type:'thread.started',thread_id:'options-fixture'})); console.log(JSON.stringify({type:'item.completed',item:{id:'reason-1',type:'reasoning',text:'Provider reasoning summary'}})); console.log(JSON.stringify({type:'item.completed',item:{id:'answer-1',type:'agent_message',text:JSON.stringify({prompt,args:process.argv.slice(2)})}})); console.log(JSON.stringify({type:'turn.completed'}));`,
  );
  const session = new CodexSession(
    {
      cwd,
      model: "fixture-model",
      autoApprove: false,
      orcMcp: false,
      systemPromptAppend: "Operator instructions",
    },
    { kind: "local" },
    async () => [process.execPath, script],
  );
  await session.send("Question");
  const events: AgentEvent[] = [];
  for await (const event of session.events()) events.push(event);
  expect(events).toContainEqual({ type: "thinking", data: "Provider reasoning summary" });
  const text = events.find((event) => event.type === "text");
  if (text?.type !== "text") throw new Error("No text");
  const output = JSON.parse(text.data) as { args: string[]; prompt: string };
  expect(output.args).toContain("fixture-model");
  expect(output.args).toContain('sandbox_mode="read-only"');
  expect(output.args.join(" ")).not.toContain("mcp_servers");
  expect(output.prompt).toBe("Operator instructions\n\nQuestion");
  await session.close();
});
