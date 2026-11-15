import { expect, test } from "bun:test";
import {
  agentForSessionBackend,
  chatRuntimeFor,
  compactionPolicy,
  DEFAULT_ENABLED_AGENTS,
  enabledAgents,
} from "./coding-agents";

test("should default to the built-in agents and drop invalid or duplicate ids", () => {
  expect(DEFAULT_ENABLED_AGENTS).toContain("opencode");
  expect(DEFAULT_ENABLED_AGENTS).not.toContain("copilot");
  expect(enabledAgents(undefined)).toEqual([...DEFAULT_ENABLED_AGENTS]);
  expect(enabledAgents([])).toEqual([]);
  expect(enabledAgents(["opencode", "opencode", "Bad Id", "qoder"])).toEqual(["opencode", "qoder"]);
});

test("should keep native runtimes for Claude and Codex, direct ACP for OpenCode, acpx otherwise", () => {
  expect(chatRuntimeFor("claude")).toBe("claude");
  expect(chatRuntimeFor("codex")).toBe("codex-cli");
  expect(chatRuntimeFor("cursor")).toBe("acpx");
  expect(chatRuntimeFor("copilot")).toBe("acpx");
  expect(chatRuntimeFor("opencode")).toBe("opencode");
  expect(chatRuntimeFor("some-new-acp-agent")).toBe("acpx");
});

test("should map imported session backends to their agent", () => {
  expect(agentForSessionBackend("cursor-agent")?.id).toBe("cursor");
  expect(agentForSessionBackend("opencode")?.id).toBe("opencode");
  expect(agentForSessionBackend("cursor")).toBeUndefined();
});

test("should state each adapter's compaction policy without inventing control", () => {
  // Claude compacts internally; ORC can still ask for a manual compaction.
  expect(compactionPolicy("claude")).toEqual({ manual: true, automatic: "agent" });
  // Codex and Pi expose their automatic limit as an ORC agent option.
  expect(compactionPolicy("codex")).toEqual({
    manual: true,
    automatic: "configurable",
    setting: "model_auto_compact_token_limit",
  });
  expect(compactionPolicy("pi")).toEqual({
    manual: true,
    automatic: "configurable",
    setting: "autoCompaction",
  });
  // OpenCode and generic ACP agents are under the agent's own control.
  expect(compactionPolicy("opencode")).toEqual({ manual: false, automatic: "agent" });
  expect(compactionPolicy("cursor")).toEqual({ manual: false, automatic: "agent" });
  expect(compactionPolicy("some-new-acp-agent")).toEqual({
    manual: false,
    automatic: "agent",
  });
});
