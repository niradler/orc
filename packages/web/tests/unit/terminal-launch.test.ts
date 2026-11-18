import { expect, test } from "bun:test";
import { terminalModes, terminalProfileOptions } from "../../src/lib/terminal-launch";

test("terminal modes list only flags each CLI has, with Codex keeping Read only", () => {
  expect(terminalModes("claude")).toEqual(["plan", "acceptEdits", "auto", "bypassPermissions"]);
  expect(terminalModes("codex")).toEqual(["default", "acceptEdits", "auto", "bypassPermissions"]);
  expect(terminalModes("opencode")).toEqual(["plan"]);
  expect(terminalModes("pi")).toEqual([]);
});

test("a profile launches a terminal with only the choices its CLI supports", () => {
  const profile = { id: "p", name: "P", model: "m", effort: "high" };
  expect(terminalProfileOptions({ ...profile, agent: "claude", permissionMode: "plan" })).toEqual({
    model: "m",
    effort: "high",
    permissionMode: "plan",
  });
  expect(terminalProfileOptions({ ...profile, agent: "codex", permissionMode: "plan" })).toEqual({
    model: "m",
    effort: "high",
  });
  expect(terminalProfileOptions({ ...profile, agent: "opencode", permissionMode: "plan" })).toEqual(
    { model: "m", permissionMode: "plan" },
  );
  expect(
    terminalProfileOptions({ ...profile, agent: "claude", permissionMode: "default" }),
  ).toEqual({ model: "m", effort: "high" });
  expect(terminalProfileOptions({ ...profile, agent: "pi", model: "" })).toEqual({});
  expect(terminalProfileOptions({ ...profile, agent: "codex", model: "", effort: "" })).toEqual({});
});
