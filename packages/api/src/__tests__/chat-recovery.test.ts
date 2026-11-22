import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { hostname } from "node:os";
import { CHAT_TURN_LEASE_STALE_MS, type ChatTurnLease, parseChatThread } from "@orc/core/chat";
import { ChatStore, installChat } from "@orc/db/chat";
import {
  reconcileChatTurnLeases,
  TURN_INTERRUPTED_NOTICE,
  TURN_INTERRUPTED_NOTICE_NO_SESSION,
} from "../chat-recovery.js";

function seed(lease: ChatTurnLease, runtimeId: string | null = "ses_native") {
  const db = new Database(":memory:");
  installChat(db);
  const id = crypto.randomUUID();
  new ChatStore(db).save(
    parseChatThread({
      id,
      title: "Recovered chat",
      config: { agent: "opencode" },
      cwd: "C:/repo",
      host: null,
      backend: "opencode",
      sourceId: null,
      runtimeId,
      messages: [],
      updatedAt: 1,
      turn: lease,
    }),
  );
  return { db, id };
}

const deadLease: ChatTurnLease = {
  runId: crypto.randomUUID(),
  startedAt: 1_000,
  status: "running",
  pid: 4_000_000, // cannot be a live pid
  host: hostname(),
  lastHeartbeatAt: 2_000,
  epoch: 1,
};

test("a running lease whose process is gone becomes interrupted exactly once", async () => {
  const { db, id } = seed(deadLease);
  const first = await reconcileChatTurnLeases({ db, now: 5_000 });
  expect(first).toMatchObject({ scanned: 1, interrupted: 1, live: 0 });

  const thread = new ChatStore(db).get(id);
  expect(thread?.turn?.status).toBe("interrupted");
  // The resumable identity survives, so the next send resumes the same session.
  expect(thread?.runtimeId).toBe("ses_native");
  const note = thread?.messages.at(-1);
  expect(note?.turn?.outcome).toBe("interrupted");
  expect(note?.activity?.[0]).toMatchObject({ type: "status", text: TURN_INTERRUPTED_NOTICE });

  const second = await reconcileChatTurnLeases({ db, now: 6_000 });
  expect(second).toMatchObject({ scanned: 0, interrupted: 0 });
  expect(new ChatStore(db).get(id)?.messages).toHaveLength(1);
});

test("a lease with no provider session says so instead of claiming a resume", async () => {
  const { db, id } = seed(deadLease, null);
  await reconcileChatTurnLeases({ db, now: 5_000 });
  expect(new ChatStore(db).get(id)?.messages.at(-1)?.activity?.[0]).toMatchObject({
    text: TURN_INTERRUPTED_NOTICE_NO_SESSION,
  });
});

test("a live lease on this host is left running", async () => {
  const { db } = seed({ ...deadLease, pid: process.pid });
  const summary = await reconcileChatTurnLeases({ db, now: 5_000 });
  expect(summary).toMatchObject({ scanned: 1, interrupted: 0, live: 1 });
});

test("a lease from another host is never assumed live", async () => {
  const { db } = seed({ ...deadLease, pid: process.pid, host: "some-other-machine" });
  const summary = await reconcileChatTurnLeases({ db, now: 5_000 });
  expect(summary).toMatchObject({ interrupted: 1, live: 0 });
});

test("a lease older than the turn hard limit is settled even if its pid was recycled", async () => {
  const { db } = seed({ ...deadLease, pid: process.pid });
  const summary = await reconcileChatTurnLeases({ db, now: 1_000 + CHAT_TURN_LEASE_STALE_MS + 1 });
  expect(summary).toMatchObject({ interrupted: 1, live: 0 });
});
