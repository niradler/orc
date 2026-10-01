import { describe, expect, test } from "bun:test";
import {
  availableLaunchers,
  buildLaunch,
  defaultShell,
  isValidSessionId,
  type LaunchDeps,
} from "../terminals/launch.js";

const BIN: Record<string, string> = {
  claude: "/bin/claude",
  codex: "/bin/codex",
  "cursor-agent": "/bin/cursor-agent",
  pwsh: "C:\\pwsh.exe",
  powershell: "C:\\powershell.exe",
};

function deps(over: Partial<LaunchDeps> = {}): LaunchDeps {
  return {
    platform: "linux",
    env: { SHELL: "/bin/zsh", COMSPEC: "C:\\cmd.exe" },
    which: (c) => BIN[c] ?? null,
    isDirectory: (p) => p.startsWith("/work"),
    home: "/home/me",
    ...over,
  };
}

const live = (over = {}) => ({
  agent: "claude",
  session_id: "abc-123",
  cwd: "/work/app",
  ...over,
});

describe("resume launch", () => {
  test("claude resumes with --resume and the session cwd", () => {
    const l = buildLaunch({ live: live() }, deps());
    expect(l).toEqual({
      kind: "claude",
      argv: ["/bin/claude", "--resume", "abc-123"],
      cwd: "/work/app",
      resume: true,
    });
  });

  test("codex resumes with the resume subcommand", () => {
    const l = buildLaunch({ live: live({ agent: "codex" }) }, deps());
    expect(l.argv).toEqual(["/bin/codex", "resume", "abc-123"]);
  });

  test("null cwd spawns with no cwd override", () => {
    expect(buildLaunch({ live: live({ cwd: null }) }, deps()).cwd).toBeUndefined();
  });

  test("agents without a resume command are rejected", () => {
    expect(() => buildLaunch({ live: live({ agent: "cursor" }) }, deps())).toThrow(/not supported/);
  });

  test("a missing session id is rejected", () => {
    expect(() => buildLaunch({ live: live({ session_id: null }) }, deps())).toThrow(/no agent/);
  });

  test.each([
    "has space",
    "new\nline",
    "tab\there",
    "-flag",
    "nul\u0000byte",
    "x".repeat(300),
    "a&calc",
    "a|b",
    "a%PATH%",
    "a^b",
    'a"b',
    "a;b",
    "$(id)",
  ])("a malformed session id is rejected: %j", (id) => {
    expect(isValidSessionId(id)).toBe(false);
    expect(() => buildLaunch({ live: live({ session_id: id }) }, deps())).toThrow(/Malformed/);
  });

  test.each(["33583f12-72b3-4edf-a18d-8616b7d10723", "cx-1", "thread_01.a:b"])(
    "a plausible session id is accepted: %j",
    (id) => {
      expect(isValidSessionId(id)).toBe(true);
    },
  );

  test("an empty session id counts as missing", () => {
    expect(isValidSessionId("")).toBe(false);
    expect(() => buildLaunch({ live: live({ session_id: "" }) }, deps())).toThrow(/no agent/);
  });

  test("a vanished cwd is rejected instead of silently spawning elsewhere", () => {
    expect(() => buildLaunch({ live: live({ cwd: "/gone" }) }, deps())).toThrow(/not a directory/);
  });

  test("an uninstalled agent binary is rejected", () => {
    expect(() => buildLaunch({ live: live() }, deps({ which: () => null }))).toThrow(
      /not installed/,
    );
  });
});

describe("fresh launches", () => {
  test("shell uses the platform default", () => {
    expect(buildLaunch({ kind: "shell", cwd: "/work/x" }, deps()).argv).toEqual(["/bin/zsh"]);
  });

  test("agents start with just their binary", () => {
    expect(buildLaunch({ kind: "cursor" }, deps()).argv).toEqual(["/bin/cursor-agent"]);
    expect(buildLaunch({ kind: "codex" }, deps()).argv).toEqual(["/bin/codex"]);
  });

  test("no cwd starts in the home folder", () => {
    expect(buildLaunch({ kind: "shell" }, deps()).cwd).toBe("/home/me");
    expect(buildLaunch({ kind: "codex", cwd: "" }, deps()).cwd).toBe("/home/me");
    expect(buildLaunch({ kind: "shell", cwd: "/work/x" }, deps()).cwd).toBe("/work/x");
  });

  test("cwd must be a directory", () => {
    expect(() => buildLaunch({ kind: "shell", cwd: "/etc" }, deps())).toThrow(/not a directory/);
  });

  test("unknown kind is rejected", () => {
    expect(() => buildLaunch({ kind: "rm" as never }, deps())).toThrow(/Unknown terminal kind/);
  });
});

describe("platform shells", () => {
  test("windows prefers pwsh, then powershell, then COMSPEC", () => {
    const win = { platform: "win32" as const };
    expect(defaultShell(deps(win))).toEqual(["C:\\pwsh.exe", "-NoLogo"]);
    expect(
      defaultShell(deps({ ...win, which: (c) => BIN[c === "pwsh" ? "" : c] ?? null })),
    ).toEqual(["C:\\powershell.exe", "-NoLogo"]);
    expect(defaultShell(deps({ ...win, which: () => null }))).toEqual(["C:\\cmd.exe"]);
  });

  test("mac starts a login shell, falling back to zsh", () => {
    expect(defaultShell(deps({ platform: "darwin" }))).toEqual(["/bin/zsh", "-l"]);
    expect(defaultShell(deps({ platform: "darwin", env: {} }))).toEqual(["/bin/zsh", "-l"]);
  });

  test("the configured shell wins on every platform", () => {
    expect(defaultShell(deps({ platform: "win32", shell: "D:\\fish.exe" }))).toEqual([
      "D:\\fish.exe",
    ]);
  });

  test("only installed launchers are offered", () => {
    expect(availableLaunchers(deps())).toEqual(["shell", "claude", "codex", "cursor"]);
    expect(
      availableLaunchers(deps({ which: (c) => (c === "claude" ? "/bin/claude" : null) })),
    ).toEqual(["shell", "claude"]);
  });
});
