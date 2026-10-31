import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { HumanRequestStore } from "../human-requests";

test("should retain one command claim across store recreation and never replay an interrupted run", () => {
  const db = new Database(":memory:");
  let now = Date.now();
  const store = new HumanRequestStore(db, () => now);
  const request = store.create({
    kind: "command",
    prompt: "Run",
    origin: { backend: "test", session_id: "origin", request_id: "once" },
    command: { host: null, cwd: "/tmp", script: "true" },
  });
  const claimed = store.claimCommand(request.id, 1);
  const reopened = new HumanRequestStore(db, () => now);
  expect(reopened.get(request.id).status).toBe("running");
  expect(() => reopened.claimCommand(request.id, claimed.version)).toThrow("already started");
  now += 331000;
  expect(reopened.get(request.id).status).toBe("unavailable");
  expect(() => reopened.claimCommand(request.id, reopened.get(request.id).version)).toThrow(
    "already started",
  );
  expect(() =>
    reopened.completeCommand(request.id, claimed.version, {
      kind: "command",
      exit_code: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }),
  ).toThrow("no longer owns");
  db.close();
});
