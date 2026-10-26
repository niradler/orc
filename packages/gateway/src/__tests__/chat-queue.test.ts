import { describe, expect, test } from "bun:test";
import { createChatQueue } from "../chat-queue.js";

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("createChatQueue", () => {
  test("returns before the work finishes and keeps one chat in order", async () => {
    const enqueue = createChatQueue(() => {});
    const first = gate();
    const order: string[] = [];
    void enqueue("chat", async () => {
      await first.opened;
      order.push("first");
    });
    const second = enqueue("chat", async () => {
      order.push("second");
    });
    await Bun.sleep(5);
    expect(order).toEqual([]);
    first.open();
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  test("lets other chats run while one chat is busy", async () => {
    const enqueue = createChatQueue(() => {});
    const busy = gate();
    void enqueue("a", () => busy.opened);
    let ran = false;
    await enqueue("b", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    busy.open();
  });

  test("reports a failure and continues with the next item", async () => {
    const errors: [unknown, string][] = [];
    const enqueue = createChatQueue((err, chatId) => errors.push([err, chatId]));
    const boom = new Error("boom");
    void enqueue("chat", async () => {
      throw boom;
    });
    let ran = false;
    await enqueue("chat", async () => {
      ran = true;
    });
    expect(errors).toEqual([[boom, "chat"]]);
    expect(ran).toBe(true);
  });
});
