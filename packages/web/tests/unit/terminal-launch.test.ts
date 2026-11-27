import { expect, test } from "bun:test";
import { terminalModes } from "../../src/lib/terminal-launch";

test("terminal modes list only flags each CLI has, with Codex keeping Read only", () => {
  expect(terminalModes("claude")).toEqual(["plan", "acceptEdits", "auto", "bypassPermissions"]);
  expect(terminalModes("codex")).toEqual(["default", "acceptEdits", "auto", "bypassPermissions"]);
  expect(terminalModes("opencode")).toEqual(["plan"]);
  expect(terminalModes("pi")).toEqual([]);
});
