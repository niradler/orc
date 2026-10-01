import { describe, expect, test } from "bun:test";
import type { Terminal } from "../../src/api/client";
import { terminalSocketUrl } from "../../src/api/client";
import { resolveTerminalKey, type TerminalKeyInput } from "../../src/lib/terminal-keys";
import { cwdTail } from "../../src/lib/terminal-kinds";
import {
  absoluteUrl,
  runningTerminalForSession,
  sessionTerminalPath,
  shareablePath,
} from "../../src/lib/terminal-links";
import {
  type ClickState,
  cellAt,
  cursorMoveKeys,
  isPlainClick,
} from "../../src/lib/terminal-mouse";

const http = { protocol: "http:", host: "localhost:9742" };
const https = { protocol: "https:", host: "orc.example.com" };

describe("terminalSocketUrl", () => {
  test("relative /api over http uses ws on the page host", () => {
    expect(terminalSocketUrl("t1", "tk", "/api", http)).toBe(
      "ws://localhost:9742/api/terminals/t1/ws?ticket=tk",
    );
  });

  test("relative /api over https uses wss", () => {
    expect(terminalSocketUrl("t1", "tk", "/api", https)).toBe(
      "wss://orc.example.com/api/terminals/t1/ws?ticket=tk",
    );
  });

  test("relative base without leading slash is normalised", () => {
    expect(terminalSocketUrl("t1", "tk", "api", http)).toBe(
      "ws://localhost:9742/api/terminals/t1/ws?ticket=tk",
    );
  });

  test("trailing slashes on the base are ignored", () => {
    expect(terminalSocketUrl("t1", "tk", "/api/", http)).toBe(
      "ws://localhost:9742/api/terminals/t1/ws?ticket=tk",
    );
  });

  test("absolute http base becomes ws", () => {
    expect(terminalSocketUrl("t1", "tk", "http://127.0.0.1:7700", https)).toBe(
      "ws://127.0.0.1:7700/terminals/t1/ws?ticket=tk",
    );
  });

  test("absolute https base becomes wss", () => {
    expect(terminalSocketUrl("t1", "tk", "https://api.example.com/", http)).toBe(
      "wss://api.example.com/terminals/t1/ws?ticket=tk",
    );
  });

  test("id and ticket are url-encoded", () => {
    expect(terminalSocketUrl("a/b", "x y&z", "/api", http)).toBe(
      "ws://localhost:9742/api/terminals/a%2Fb/ws?ticket=x%20y%26z",
    );
  });
});

function key(code: string, mods: Partial<TerminalKeyInput> = {}): TerminalKeyInput {
  return { code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods };
}

describe("resolveTerminalKey on macOS", () => {
  test("Cmd+C copies only with a selection", () => {
    expect(resolveTerminalKey(key("KeyC", { metaKey: true }), true, true)).toBe("copy");
    expect(resolveTerminalKey(key("KeyC", { metaKey: true }), true, false)).toBe("swallow");
  });

  test("Cmd+A selects all", () => {
    expect(resolveTerminalKey(key("KeyA", { metaKey: true }), true, false)).toBe("select-all");
  });

  test("Ctrl+C always reaches the PTY", () => {
    expect(resolveTerminalKey(key("KeyC", { ctrlKey: true }), true, true)).toBe("pass");
    expect(resolveTerminalKey(key("KeyC", { ctrlKey: true }), true, false)).toBe("pass");
  });

  test("Cmd+V is not intercepted", () => {
    expect(resolveTerminalKey(key("KeyV", { metaKey: true }), true, false)).toBe("pass");
  });
});

describe("resolveTerminalKey on Windows and Linux", () => {
  test("Ctrl+C is SIGINT without a selection", () => {
    expect(resolveTerminalKey(key("KeyC", { ctrlKey: true }), false, false)).toBe("pass");
  });

  test("Ctrl+C copies and clears with a selection", () => {
    expect(resolveTerminalKey(key("KeyC", { ctrlKey: true }), false, true)).toBe("copy-and-clear");
  });

  test("Ctrl+Shift+C copies with a selection and never sends SIGINT", () => {
    const k = key("KeyC", { ctrlKey: true, shiftKey: true });
    expect(resolveTerminalKey(k, false, true)).toBe("copy");
    expect(resolveTerminalKey(k, false, false)).toBe("swallow");
  });

  test("Ctrl+Shift+A selects all, plain Ctrl+A stays shell input", () => {
    expect(resolveTerminalKey(key("KeyA", { ctrlKey: true, shiftKey: true }), false, false)).toBe(
      "select-all",
    );
    expect(resolveTerminalKey(key("KeyA", { ctrlKey: true }), false, false)).toBe("pass");
  });

  test("Alt combinations pass through", () => {
    expect(resolveTerminalKey(key("KeyC", { ctrlKey: true, altKey: true }), false, true)).toBe(
      "pass",
    );
  });
});

describe("cwdTail", () => {
  test("keeps the last two segments of posix and windows paths", () => {
    expect(cwdTail("/home/nir/projects/orc")).toBe("projects/orc");
    expect(cwdTail("C:\\Projects\\orc")).toBe("Projects/orc");
  });

  test("handles null and root", () => {
    expect(cwdTail(null)).toBe("");
    expect(cwdTail("/")).toBe("/");
  });
});

describe("terminal links", () => {
  const terminal = (over: Partial<Terminal>): Terminal =>
    ({
      id: "t1",
      name: "t",
      kind: "shell",
      status: "running",
      live_session_id: null,
      ...over,
    }) as Terminal;

  test("a session link survives the terminal being reopened and encodes the id", () => {
    expect(sessionTerminalPath("a b/c")).toBe("/terminals?session=a%20b%2Fc");
    expect(shareablePath(terminal({ live_session_id: "s1" }))).toBe("/terminals?session=s1");
    expect(shareablePath(terminal({}))).toBe("/terminals/t1");
  });

  test("only a running terminal answers a session link", () => {
    const list = [
      terminal({ id: "old", live_session_id: "s1", status: "exited" }),
      terminal({ id: "other", live_session_id: "s2" }),
      terminal({ id: "live", live_session_id: "s1" }),
    ];
    expect(runningTerminalForSession(list, "s1")?.id).toBe("live");
    expect(runningTerminalForSession(list.slice(0, 2), "s1")).toBeUndefined();
    expect(runningTerminalForSession(list, "missing")).toBeUndefined();
  });

  test("absoluteUrl prefixes the origin", () => {
    expect(absoluteUrl("/terminals/t1", "https://orc.example.com")).toBe(
      "https://orc.example.com/terminals/t1",
    );
  });
});

describe("terminal mouse", () => {
  const grid = { left: 10, top: 20, width: 800, height: 400, cols: 80, rows: 20 };
  const click: ClickState = {
    alternateScreen: false,
    scrolledBack: false,
    hasSelection: false,
    wasFocused: true,
    button: 0,
    detail: 1,
    modified: false,
    dragged: false,
  };

  test("cellAt maps pixels to cells and rejects points outside the grid", () => {
    expect(cellAt(grid, 10, 20)).toEqual({ col: 0, row: 0 });
    expect(cellAt(grid, 10 + 10 * 5 + 1, 20 + 20 * 3 + 1)).toEqual({ col: 5, row: 3 });
    expect(cellAt(grid, 809, 419)).toEqual({ col: 79, row: 19 });
    expect(cellAt(grid, 9, 30)).toBeNull();
    expect(cellAt(grid, 810, 30)).toBeNull();
    expect(cellAt({ ...grid, width: 0 }, 20, 30)).toBeNull();
  });

  test("cursorMoveKeys walks right and left, and honours application cursor mode", () => {
    expect(cursorMoveKeys(2, 5, false)).toBe("\x1b[C".repeat(3));
    expect(cursorMoveKeys(5, 2, false)).toBe("\x1b[D".repeat(3));
    expect(cursorMoveKeys(5, 3, true)).toBe("\x1bOD".repeat(2));
    expect(cursorMoveKeys(4, 4, false)).toBe("");
    expect(cursorMoveKeys(0, 100_000, false).length).toBe(500 * 3);
  });

  test("only a plain click on a focused, live, normal-screen terminal counts", () => {
    expect(isPlainClick(click)).toBe(true);
    for (const override of [
      { alternateScreen: true },
      { scrolledBack: true },
      { hasSelection: true },
      { wasFocused: false },
      { button: 2 },
      { detail: 2 },
      { modified: true },
      { dragged: true },
    ]) {
      expect(isPlainClick({ ...click, ...override })).toBe(false);
    }
  });
});
