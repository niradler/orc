import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClaudeSdkLaunch } from "../claude-executable.js";

describe("Claude SDK executable resolution", () => {
  test("preserves the npm SDK executable and rejects missing standalone executables", () => {
    expect(resolveClaudeSdkLaunch(false, () => null)).toEqual({});
    expect(() => resolveClaudeSdkLaunch(true, () => null)).toThrow("API key alone");
    expect(resolveClaudeSdkLaunch(true, () => "/tools/claude")).toEqual({
      pathToClaudeCodeExecutable: "/tools/claude",
    });
  });

  test("resolves a Windows npm shim to its script and an installed interpreter", () => {
    const root = mkdtempSync(join(tmpdir(), "orc-claude-executable-"));
    const shim = join(root, "claude.cmd");
    const script = join(root, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    expect(() => resolveClaudeSdkLaunch(true, () => shim)).toThrow("shell shim");
    mkdirSync(join(root, "node_modules", "@anthropic-ai", "claude-code"), { recursive: true });
    writeFileSync(script, "// retained executable-resolution fixture\n");
    const which = (name: string) => (name === "claude" ? shim : name === "bun" ? "/bun" : null);
    expect(resolveClaudeSdkLaunch(true, which)).toEqual({
      pathToClaudeCodeExecutable: script,
      executable: "bun",
    });
    expect(() => resolveClaudeSdkLaunch(true, (name) => (name === "claude" ? shim : null))).toThrow(
      "interpreter",
    );
  });
});
