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
  gemini: "/bin/gemini",
  opencode: "/bin/opencode",
  pi: "/bin/pi",
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
  test("Windows resume normalizes extended drive cwd before validating and launching", async () => {
    const cwd = "C:\\Projects\\orc";
    const launch = await buildLaunch(
      { live: live({ cwd: `\\\\?\\${cwd}` }) },
      deps({ platform: "win32", isDirectory: (path) => path === cwd }),
    );
    expect(launch.cwd).toBe(cwd);
  });

  test.skipIf(process.platform !== "win32")(
    "Windows command shims retain the normalized cwd",
    async () => {
      const cwd = process.cwd();
      const launch = await buildLaunch(
        { live: live({ cwd: `\\\\?\\${cwd}` }) },
        deps({ platform: "win32", isDirectory: () => true }),
      );
      const result = Bun.spawnSync(["cmd.exe", "/d", "/c", "cd"], {
        ...(launch.cwd ? { cwd: launch.cwd } : {}),
        timeout: 10000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim().toLowerCase()).toBe(cwd.toLowerCase());
      expect(result.stderr.toString()).toBe("");
    },
  );

  test("claude resumes with --resume and the session cwd", async () => {
    const l = await buildLaunch({ live: live() }, deps());
    expect(l).toEqual({
      kind: "claude",
      argv: ["/bin/claude", "--resume", "abc-123"],
      cwd: "/work/app",
      resume: true,
    });
  });

  test("codex resumes with the resume subcommand", async () => {
    const l = await buildLaunch({ live: live({ agent: "codex" }) }, deps());
    expect(l.argv).toEqual(["/bin/codex", "resume", "abc-123"]);
  });

  test.each(["cursor-agent", "gemini"])(
    "should resume %s with its original id and working folder",
    async (agent) => {
      const launch = await buildLaunch({ live: live({ agent }) }, deps());
      expect(launch).toMatchObject({
        kind: agent === "cursor-agent" ? "cursor" : "gemini",
        cwd: "/work/app",
        resume: true,
      });
      expect(launch.argv).toEqual([
        agent === "cursor-agent" ? "/bin/cursor-agent" : "/bin/gemini",
        "--resume",
        "abc-123",
      ]);
    },
  );

  test("should resume an OpenCode session with --session", async () => {
    const launch = await buildLaunch({ live: live({ agent: "opencode" }) }, deps());
    expect(launch).toMatchObject({ kind: "opencode", resume: true });
    expect(launch.argv).toEqual(["/bin/opencode", "--session", "abc-123"]);
  });

  test("null cwd spawns with no cwd override", async () => {
    expect((await buildLaunch({ live: live({ cwd: null }) }, deps())).cwd).toBeUndefined();
  });

  test("claude forks with --resume and --fork-session", async () => {
    const launch = await buildLaunch({ live: live(), fork: true }, deps());
    expect(launch).toEqual({
      kind: "claude",
      argv: ["/bin/claude", "--resume", "abc-123", "--fork-session"],
      cwd: "/work/app",
      resume: true,
    });
  });

  test("pi forks with --fork and the source id", async () => {
    const launch = await buildLaunch({ live: live({ agent: "pi" }), fork: true }, deps());
    expect(launch.argv).toEqual(["/bin/pi", "--fork", "abc-123"]);
  });

  test("a backend without a native CLI fork is rejected instead of resuming the source", async () => {
    await expect(
      buildLaunch({ live: live({ agent: "codex" }), fork: true }, deps()),
    ).rejects.toThrow(/Fork is not supported/);
  });

  test("a fork never reaches spawn with a malformed session id", async () => {
    await expect(
      buildLaunch({ live: live({ session_id: "x; rm -rf /" }), fork: true }, deps()),
    ).rejects.toThrow(/Malformed/);
  });

  test("agents without a resume command are rejected", async () => {
    await expect(buildLaunch({ live: live({ agent: "cursor" }) }, deps())).rejects.toThrow(
      /not supported/,
    );
  });

  test("a missing session id is rejected", async () => {
    await expect(buildLaunch({ live: live({ session_id: null }) }, deps())).rejects.toThrow(
      /no agent/,
    );
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
  ])("a malformed session id is rejected: %j", async (id) => {
    expect(isValidSessionId(id)).toBe(false);
    await expect(buildLaunch({ live: live({ session_id: id }) }, deps())).rejects.toThrow(
      /Malformed/,
    );
  });

  test.each(["33583f12-72b3-4edf-a18d-8616b7d10723", "cx-1", "thread_01.a:b"])(
    "a plausible session id is accepted: %j",
    async (id) => {
      expect(isValidSessionId(id)).toBe(true);
    },
  );

  test("an empty session id counts as missing", async () => {
    expect(isValidSessionId("")).toBe(false);
    await expect(buildLaunch({ live: live({ session_id: "" }) }, deps())).rejects.toThrow(
      /no agent/,
    );
  });

  test("a vanished cwd is rejected instead of silently spawning elsewhere", async () => {
    await expect(buildLaunch({ live: live({ cwd: "/gone" }) }, deps())).rejects.toThrow(
      /not a directory/,
    );
  });

  test("an uninstalled agent binary is rejected", async () => {
    await expect(buildLaunch({ live: live() }, deps({ which: () => null }))).rejects.toThrow(
      /not installed/,
    );
  });
});

describe("fresh launches", () => {
  test("shell uses the platform default", async () => {
    expect((await buildLaunch({ kind: "shell", cwd: "/work/x" }, deps())).argv).toEqual([
      "/bin/zsh",
    ]);
  });

  test("agents start with just their binary", async () => {
    expect((await buildLaunch({ kind: "cursor" }, deps())).argv).toEqual(["/bin/cursor-agent"]);
    expect((await buildLaunch({ kind: "codex" }, deps())).argv).toEqual(["/bin/codex"]);
  });

  test("cursor falls back to the newer agent binary", async () => {
    const which = (c: string) => (c === "agent" ? "/bin/agent" : null);
    expect((await buildLaunch({ kind: "cursor" }, deps({ which }))).argv).toEqual(["/bin/agent"]);
    expect(availableLaunchers(deps({ which, shell: "/bin/sh" }))).toEqual(["shell", "cursor"]);
  });

  test("no cwd starts in the home folder", async () => {
    expect((await buildLaunch({ kind: "shell" }, deps())).cwd).toBe("/home/me");
    expect((await buildLaunch({ kind: "codex", cwd: "" }, deps())).cwd).toBe("/home/me");
    expect((await buildLaunch({ kind: "shell", cwd: "/work/x" }, deps())).cwd).toBe("/work/x");
  });

  test("cwd must be a directory", async () => {
    await expect(buildLaunch({ kind: "shell", cwd: "/etc" }, deps())).rejects.toThrow(
      /not a directory/,
    );
  });

  test("unknown kind is rejected", async () => {
    await expect(buildLaunch({ kind: "rm" as never }, deps())).rejects.toThrow(
      /Unknown terminal kind/,
    );
  });
});

describe("platform shells", () => {
  test("should preserve configured shell arguments literally without adding or parsing flags", () => {
    const shell = ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoProfile", "a & b", ""];
    const argv = defaultShell(deps({ platform: "win32", shell }));
    expect(argv).toEqual(shell);
    expect(argv).not.toBe(shell);
    expect(() => defaultShell(deps({ shell: [] }))).toThrow("needs an executable");
  });
  test("windows prefers pwsh, then powershell, then COMSPEC", async () => {
    const win = { platform: "win32" as const };
    expect(defaultShell(deps(win))).toEqual(["C:\\pwsh.exe", "-NoLogo"]);
    expect(
      defaultShell(deps({ ...win, which: (c) => BIN[c === "pwsh" ? "" : c] ?? null })),
    ).toEqual(["C:\\powershell.exe", "-NoLogo"]);
    expect(defaultShell(deps({ ...win, which: () => null }))).toEqual(["C:\\cmd.exe"]);
  });

  test("mac starts a login shell, falling back to zsh", async () => {
    expect(defaultShell(deps({ platform: "darwin" }))).toEqual(["/bin/zsh", "-l"]);
    expect(defaultShell(deps({ platform: "darwin", env: {} }))).toEqual(["/bin/zsh", "-l"]);
  });

  test("the configured shell wins on every platform", async () => {
    expect(defaultShell(deps({ platform: "win32", shell: "D:\\fish.exe" }))).toEqual([
      "D:\\fish.exe",
    ]);
  });

  test("only installed launchers are offered", async () => {
    expect(availableLaunchers(deps())).toEqual([
      "shell",
      "claude",
      "codex",
      "cursor",
      "gemini",
      "opencode",
    ]);
    expect(
      availableLaunchers(deps({ which: (c) => (c === "claude" ? "/bin/claude" : null) })),
    ).toEqual(["shell", "claude"]);
  });

  test("should offer only enabled agents that are installed, in catalog order", async () => {
    expect(availableLaunchers(deps(), ["opencode", "gemini", "kimi", "custom-acp"])).toEqual([
      "shell",
      "gemini",
      "opencode",
    ]);
  });
});

test("Pi terminal launch uses the native binary when enabled and installed", async () => {
  const local = deps({ which: (command) => (command === "pi" ? "/bin/pi" : null) });
  expect(availableLaunchers(local, ["pi"])).toContain("pi");
  expect(availableLaunchers(local, [])).not.toContain("pi");
  expect((await buildLaunch({ kind: "pi", cwd: "/work/pi" }, local)).argv).toEqual(["/bin/pi"]);
});
