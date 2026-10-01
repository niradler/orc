import { describe, expect, test } from "bun:test";
import { buildPtyEnv } from "../terminals/pty-env.js";
import { TerminalQueryResponder } from "../terminals/queries.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("TerminalQueryResponder", () => {
  test("answers primary and secondary device attributes when enabled", () => {
    const r = new TerminalQueryResponder({ answerDeviceAttributes: true });
    expect(r.feed(bytes("prompt\x1b[c\x1b[0c\x1b[>c\x1b[>0c"))).toEqual([
      "\x1b[?62;22c",
      "\x1b[?62;22c",
      "\x1b[>1;10;0c",
      "\x1b[>1;10;0c",
    ]);
  });

  test("stays silent on device attributes when the PTY layer answers them", () => {
    const r = new TerminalQueryResponder({ answerDeviceAttributes: false });
    expect(r.feed(bytes("\x1b[c\x1b[>c"))).toEqual([]);
  });

  test("always answers XTVERSION", () => {
    const r = new TerminalQueryResponder({ answerDeviceAttributes: false });
    expect(r.feed(bytes("\x1b[>0q"))).toEqual(["\x1bP>|orc\x1b\\"]);
    expect(r.feed(bytes("\x1b[>q"))).toEqual(["\x1bP>|orc\x1b\\"]);
  });

  test("answers colour queries with the terminator the query used", () => {
    const r = new TerminalQueryResponder({ answerDeviceAttributes: false });
    expect(r.feed(bytes("\x1b]10;?\x07"))).toEqual(["\x1b]10;rgb:e1e1/e5e5/f6f6\x07"]);
    expect(r.feed(bytes("\x1b]11;?\x1b\\"))).toEqual(["\x1b]11;rgb:0909/0e0e/1a1a\x1b\\"]);
  });

  test("assembles a query split across chunks, once", () => {
    const r = new TerminalQueryResponder({ answerDeviceAttributes: true });
    expect(r.feed(bytes("text\x1b"))).toEqual([]);
    expect(r.feed(bytes("[>"))).toEqual([]);
    expect(r.feed(bytes("0q more"))).toEqual(["\x1bP>|orc\x1b\\"]);
    expect(r.feed(bytes("more"))).toEqual([]);
  });

  test("ignores ordinary colour and cursor sequences", () => {
    const r = new TerminalQueryResponder({ answerDeviceAttributes: true });
    expect(r.feed(bytes("\x1b[31mred\x1b[0m\x1b[2J\x1b[?25l\x1b]0;title\x07"))).toEqual([]);
  });

  test("an OSC query whose ST terminator is split across chunks is answered once", () => {
    const r = new TerminalQueryResponder({ answerDeviceAttributes: false });
    expect(r.feed(bytes("x\x1b]11;?\x1b"))).toEqual([]);
    expect(r.feed(bytes("\\y"))).toEqual(["\x1b]11;rgb:0909/0e0e/1a1a\x1b\\"]);
    expect(r.feed(bytes("again"))).toEqual([]);
  });

  test("does not hold on to an unterminated escape forever", () => {
    const r = new TerminalQueryResponder({ answerDeviceAttributes: true });
    r.feed(bytes(`\x1b]11;${"x".repeat(40)}`));
    expect(r.feed(bytes("\x1b[c"))).toEqual(["\x1b[?62;22c"]);
  });
});

describe("buildPtyEnv", () => {
  test("describes the terminal and keeps the user's environment", () => {
    const env = buildPtyEnv({ PATH: "/bin", HOME: "/home/me", TERM: "dumb", UNSET: undefined });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/me",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "orc",
    });
  });

  test("hides parent coding-agent markers and keeps the API secret", () => {
    const env = buildPtyEnv({
      ORC_API_SECRET: "s3cret",
      CLAUDECODE: "1",
      CLAUDE_PID: "9",
      CLAUDE_AGENT_SDK_VERSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDE_CODE_SSE_PORT: "5",
      CLAUDE_CONFIG_DIR: "/home/me/.claude",
      ANTHROPIC_API_KEY: "sk-keep",
      PATH: "/bin",
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CONFIG_DIR",
        "COLORTERM",
        "ORC_API_SECRET",
        "PATH",
        "TERM",
        "TERM_PROGRAM",
      ].sort(),
    );
  });

  test("leaves NO_COLOR alone so the user's choice wins", () => {
    expect(buildPtyEnv({ NO_COLOR: "1" }).NO_COLOR).toBe("1");
  });
});
