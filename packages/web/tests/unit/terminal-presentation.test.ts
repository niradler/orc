import { expect, test } from "bun:test";
import type { Terminal } from "../../src/api/client";
import { filterTerminals, terminalStatus } from "../../src/lib/terminal-presentation";

const terminal: Terminal = {
  id: "one",
  name: "API debugging",
  kind: "shell",
  cwd: "C:/work/orc",
  status: "running",
  exit_code: null,
  pid: 42,
  live_session_id: null,
  host: "devbox",
  created_at: "2026-10-23T09:00:00Z",
};

test("should match session names, folders, agents and hosts while respecting process filters", () => {
  const sessions = [
    terminal,
    { ...terminal, id: "two", name: "Review", kind: "codex" as const, status: "exited" as const },
  ];
  expect(filterTerminals(sessions, " DEBUG ", "all").map((item) => item.id)).toEqual(["one"]);
  expect(filterTerminals(sessions, "codex", "running")).toHaveLength(0);
  expect(filterTerminals(sessions, "DEVBOX", "exited").map((item) => item.id)).toEqual(["two"]);
  expect(filterTerminals(sessions, "work/orc", "all")).toHaveLength(2);
});

test("should show transport failure separately from process exit without inventing agent activity", () => {
  expect(terminalStatus(terminal, "closed")).toBe("Disconnected");
  expect(terminalStatus(terminal, "reconnecting")).toBe("Reconnecting");
  expect(terminalStatus(terminal)).toBe("Running");
  expect(terminalStatus({ ...terminal, status: "exited", exit_code: 1 }, "closed")).toBe(
    "Exited (1)",
  );
});
