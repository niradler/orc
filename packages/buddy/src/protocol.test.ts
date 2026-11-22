import { describe, expect, test } from "bun:test";
import {
  BUDDY_MAX_LINE_BYTES,
  BuddyCommandSchema,
  type BuddySnapshot,
  BuddySnapshotSchema,
  encodeLine,
  LineDecoder,
} from "./protocol.js";

describe("LineDecoder", () => {
  test("reassembles JSON lines split across chunks", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"cmd":"pi')).toEqual([]);
    expect(decoder.push('ng"}\n{"cmd":"rea')).toEqual([{ cmd: "ping" }]);
    expect(decoder.push('d","id":"n1"}\n')).toEqual([{ cmd: "read", id: "n1" }]);
  });

  test("skips boot noise and non-JSON lines", () => {
    const decoder = new LineDecoder();
    const values = decoder.push('rst:0x1 (POWERON_RESET)\n{"cmd":"ping"}\nnot json\n');
    expect(values).toEqual([{ cmd: "ping" }]);
  });

  test("drops oversized lines and keeps the buffer bounded", () => {
    const decoder = new LineDecoder();
    const huge = "x".repeat(BUDDY_MAX_LINE_BYTES + 10);
    expect(decoder.push(`${huge}\n`)).toEqual([]);
    expect(decoder.push('{"cmd":"ping"}\n')).toEqual([{ cmd: "ping" }]);
    // An unterminated oversized fragment is discarded, not buffered forever.
    expect(decoder.push(huge)).toEqual([]);
    expect(decoder.push('\n{"cmd":"ping"}\n')).toEqual([{ cmd: "ping" }]);
  });
});

describe("schemas", () => {
  test("snapshot round-trips through encodeLine", () => {
    const snapshot: BuddySnapshot = {
      v: 1,
      t: 1_775_731_234,
      mood: "busy",
      sessions: { total: 2, working: 1, waiting: 0 },
      needs_you: [],
      recent: [{ id: "n1", line: "10:42 tests passed", unread: false }],
      unread: 0,
      tokens_today: 31_200,
    };
    const line = encodeLine(snapshot);
    expect(line.endsWith("\n")).toBe(true);
    expect(BuddySnapshotSchema.parse(JSON.parse(line))).toEqual(snapshot);
  });

  test("commands are strict: unknown fields are rejected", () => {
    expect(BuddyCommandSchema.safeParse({ cmd: "ping" }).success).toBe(true);
    expect(
      BuddyCommandSchema.safeParse({ cmd: "respond", id: "r1", decision: "approve" }).success,
    ).toBe(true);
    expect(
      BuddyCommandSchema.safeParse({ cmd: "respond", id: "r1", decision: "maybe" }).success,
    ).toBe(false);
    expect(BuddyCommandSchema.safeParse({ cmd: "ping", extra: 1 }).success).toBe(false);
  });
});
