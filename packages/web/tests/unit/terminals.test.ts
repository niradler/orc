import { describe, expect, test } from "bun:test";
import { terminalSocketUrl } from "../../src/api/client";
import { resolveTerminalKey, type TerminalKeyInput } from "../../src/lib/terminal-keys";
import { cwdTail } from "../../src/lib/terminal-kinds";

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
