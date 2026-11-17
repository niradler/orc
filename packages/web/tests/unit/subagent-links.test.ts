import { expect, test } from "bun:test";
import { isSubagentTool, matchSubagents } from "../../src/lib/subagent-links";

const tool = (id: string, name: string) => ({ type: "tool", id, name, input: "{}" });
const subagent = (id: string, tool_call_id: string | null, created_at: number) => ({
  id,
  session_id: `native-${id}`,
  title: id,
  status: "stopped",
  tool_call_id,
  created_at,
});

test("subagent tools are recognized across agents", () => {
  expect(["Agent", "Task", "spawn_agent", "task", "subagent"].every(isSubagentTool)).toBe(true);
  expect(["TaskCreate", "wait_agent", "Bash", "list_agents"].some(isSubagentTool)).toBe(false);
});

test("calls match their subagent by call id, and the rest by start order", () => {
  const messages = [
    { activity: [tool("call-a", "Agent"), tool("bash-1", "Bash")] },
    { activity: [tool("call-b", "spawn_agent"), tool("call-c", "task")] },
  ];
  const links = matchSubagents(messages, [
    subagent("late", null, 30),
    subagent("exact", "call-b", 20),
    subagent("early", null, 10),
  ]);
  expect([...links].map(([call, found]) => [call, found.id])).toEqual([
    ["call-b", "exact"],
    ["call-a", "early"],
    ["call-c", "late"],
  ]);
  expect(matchSubagents(messages, []).size).toBe(0);
});
