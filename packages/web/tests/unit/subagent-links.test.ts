import { expect, test } from "bun:test";
import type { ChatActivity } from "@orc/core/chat";
import {
  isSubagentTool,
  liveSubagentTree,
  matchSubagents,
  subagentState,
} from "../../src/lib/subagent-links";

const tool = (id: string, name: string) => ({ type: "tool", id, name, input: "{}" });
const subagent = (
  id: string,
  tool_call_id: string | null,
  created_at: number,
  parent_id: string | null = null,
  status = "stopped",
) => ({
  id,
  parent_id,
  session_id: `native-${id}`,
  title: id,
  status,
  tool_call_id,
  created_at,
});
const live = (
  id: string,
  status: Extract<ChatActivity, { type: "subagent" }>["status"],
  parentId?: string,
): ChatActivity => ({
  type: "subagent",
  id,
  title: id,
  status,
  activity: [],
  ...(parentId ? { parentId } : {}),
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

test("nested subagents hang under their parent and never take a top-level call", () => {
  const messages = [{ activity: [tool("call-a", "Agent"), tool("call-b", "Agent")] }];
  const links = matchSubagents(messages, [
    subagent("outer", null, 10),
    subagent("inner", null, 11, "outer", "error"),
    subagent("deepest", null, 12, "inner", "running"),
  ]);
  expect([...links.keys()]).toEqual(["call-a"]);
  const outer = links.get("call-a");
  expect(outer?.children.map((child) => child.id)).toEqual(["inner"]);
  expect(outer?.children[0]?.children.map((child) => child.id)).toEqual(["deepest"]);
  expect(outer?.children[0]?.status).toBe("failed");
  expect(outer && subagentState(outer)).toBe("needs-you");
});

test("live subagents nest at any depth and roll failures and waits up to the parent", () => {
  const roots = liveSubagentTree([
    live("outer", "running"),
    tool("bash", "Bash") as ChatActivity,
    live("middle", "running", "outer"),
    live("inner", "waiting", "middle"),
    live("sibling", "completed"),
    live("orphan", "failed", "missing"),
  ]);
  expect(roots.map((node) => node.id)).toEqual(["outer", "sibling", "orphan"]);
  const [outer, sibling, orphan] = roots;
  expect(outer?.children[0]?.children[0]?.id).toBe("inner");
  expect(outer && subagentState(outer)).toBe("needs-you");
  expect(outer?.children[0] && subagentState(outer.children[0])).toBe("needs-you");
  expect(sibling && subagentState(sibling)).toBe("done");
  expect(orphan && subagentState(orphan)).toBe("failed");
  expect(liveSubagentTree([])).toEqual([]);
});

test("a subagent naming itself or a cycle as parent stays visible at the top", () => {
  const roots = liveSubagentTree([
    live("a", "running", "b"),
    live("b", "running", "a"),
    live("self", "running", "self"),
  ]);
  const ids = roots.flatMap(function walk(node): string[] {
    return [node.id, ...node.children.flatMap(walk)];
  });
  expect(ids.sort()).toEqual(["a", "b", "self"]);
});
