import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type ChatThread, parseChatThread } from "@orc/core/chat";
import { ChatStore, installChat } from "../chat.js";

function thread(id: string): ChatThread {
  return parseChatThread({
    id,
    title: "Lease fence",
    config: { agent: "opencode" },
    cwd: "C:/repo",
    host: null,
    backend: "opencode",
    sourceId: null,
    runtimeId: null,
    messages: [],
    updatedAt: 1,
  });
}

function store(): ChatStore {
  const db = new Database(":memory:");
  installChat(db);
  return new ChatStore(db);
}

test("saveTurn inserts a new conversation and accepts the current epoch", () => {
  const chats = store();
  const first = thread(crypto.randomUUID());
  first.turn = { runId: crypto.randomUUID(), startedAt: 10, status: "running", epoch: 1 };
  chats.saveTurn(first, 1);
  expect(chats.get(first.id)?.turn?.epoch).toBe(1);
});

test("saveTurn refuses an older epoch once a newer turn claimed the thread", () => {
  const chats = store();
  const live = thread(crypto.randomUUID());
  const runId = crypto.randomUUID();
  live.turn = { runId, startedAt: 10, status: "running", epoch: 2 };
  chats.saveTurn(live, 2);

  const stale = { ...live, turn: { ...live.turn, runId: crypto.randomUUID(), epoch: 1 } };
  expect(() => chats.saveTurn(stale, 1)).toThrow("Another turn claimed this conversation");
  // The newer lease is intact.
  expect(chats.get(live.id)?.turn?.epoch).toBe(2);
  expect(chats.get(live.id)?.turn?.runId).toBe(runId);
});

test("saveTurn lets the owning epoch finalize the same turn", () => {
  const chats = store();
  const live = thread(crypto.randomUUID());
  live.turn = { runId: crypto.randomUUID(), startedAt: 10, status: "running", epoch: 3 };
  chats.saveTurn(live, 3);
  live.turn = { ...live.turn, status: "completed", lastHeartbeatAt: 20 };
  chats.saveTurn(live, 3);
  expect(chats.get(live.id)?.turn?.status).toBe("completed");
});

test("targeted lease writes are dropped when runId, epoch or status no longer match", () => {
  const chats = store();
  const live = thread(crypto.randomUUID());
  const runId = crypto.randomUUID();
  live.turn = { runId, startedAt: 10, status: "running", epoch: 4 };
  chats.saveTurn(live, 4);

  chats.setRuntimeRef(live.id, runId, 3, "ses_wrong_epoch", []);
  expect(chats.get(live.id)?.runtimeId).toBeNull();

  chats.setRuntimeRef(live.id, runId, 4, "ses_ok", [
    {
      backend: "opencode",
      host: null,
      runtimeId: "ses_ok",
      cwd: "C:/repo",
      attachedAt: 11,
      source: "started",
    },
  ]);
  expect(chats.get(live.id)?.runtimeId).toBe("ses_ok");

  chats.heartbeatTurnLease(live.id, runId, 4, 99);
  expect(chats.get(live.id)?.turn?.lastHeartbeatAt).toBe(99);

  // A terminal lease never accepts another beat or ref write.
  const done = chats.get(live.id) ?? live;
  done.turn = { ...(done.turn as NonNullable<typeof done.turn>), status: "completed" };
  chats.saveTurn(done, 4);
  chats.heartbeatTurnLease(live.id, runId, 4, 123);
  expect(chats.get(live.id)?.turn?.lastHeartbeatAt).toBe(99);
});
test("claimTurn accepts one writer per observed epoch and refuses the rest", () => {
  const chats = store();
  const live = thread(crypto.randomUUID());
  const runA = crypto.randomUUID();
  expect(chats.claimTurn(live, { runId: runA, startedAt: 10, status: "running", pid: 1 })).toBe(1);
  expect(chats.get(live.id)?.turn?.epoch).toBe(1);

  // Two requests that both loaded the thread before any lease existed compute the
  // same claim (expected epoch 0). Only the first one may start a turn.
  const racer = thread(live.id);
  expect(() =>
    chats.claimTurn(racer, { runId: crypto.randomUUID(), startedAt: 20, status: "running" }),
  ).toThrow("Another turn claimed");
  const racer2 = thread(live.id);
  expect(() =>
    chats.claimTurn(racer2, { runId: crypto.randomUUID(), startedAt: 20, status: "running" }, 0),
  ).toThrow("Another turn claimed");

  // The stored lease is untouched by the losers.
  expect(chats.get(live.id)?.turn?.runId).toBe(runA);
  expect(chats.get(live.id)?.turn?.epoch).toBe(1);
});

test("claimTurn replaces a leftover lease from the epoch it observed and advances", () => {
  const chats = store();
  const live = thread(crypto.randomUUID());
  chats.claimTurn(live, { runId: crypto.randomUUID(), startedAt: 10, status: "running" });
  const next = crypto.randomUUID();
  // The caller saw epoch 1 as a leftover with no live owner and claims it.
  expect(chats.claimTurn(live, { runId: next, startedAt: 20, status: "running" }, 1)).toBe(2);
  expect(chats.get(live.id)?.turn?.runId).toBe(next);
  expect(chats.get(live.id)?.turn?.epoch).toBe(2);
});
