import { describe, expect, test } from "bun:test";
import { HumanRequestSchema, parseSnoozeDurationSeconds } from "@orc/core/human-requests";
import {
  formatSnoozeUntil,
  isRequestSnoozed,
  parseDatetimeLocalValue,
  pendingRequestsForSession,
  SNOOZE_PRESETS,
  toDatetimeLocalValue,
  tomorrowAtNine,
} from "../../src/lib/snooze";

describe("snooze helpers", () => {
  test("parses snooze durations and rejects invalid values", () => {
    expect(parseSnoozeDurationSeconds("15m")).toBe(900);
    expect(parseSnoozeDurationSeconds("1h")).toBe(3600);
    expect(parseSnoozeDurationSeconds("3h")).toBe(10800);
    expect(parseSnoozeDurationSeconds("1h30m")).toBe(5400);
    expect(parseSnoozeDurationSeconds("2d")).toBe(172800);
    expect(parseSnoozeDurationSeconds("")).toBeNull();
    expect(parseSnoozeDurationSeconds("0m")).toBeNull();
    expect(parseSnoozeDurationSeconds("-5m")).toBeNull();
    expect(parseSnoozeDurationSeconds("soon")).toBeNull();
    expect(parseSnoozeDurationSeconds("400d")).toBeNull();
  });

  test("computes tomorrow at 09:00 local time and presets", () => {
    expect(SNOOZE_PRESETS.map((preset) => preset.id)).toEqual(["15m", "1h", "3h"]);
    const base = new Date(2026, 10, 24, 14, 30, 0, 0);
    const nextNine = new Date(tomorrowAtNine(base));
    expect(nextNine.getFullYear()).toBe(2026);
    expect(nextNine.getMonth()).toBe(10);
    expect(nextNine.getDate()).toBe(25);
    expect(nextNine.getHours()).toBe(9);
    expect(nextNine.getMinutes()).toBe(0);
  });

  test("formats snooze times for today, tomorrow, and later dates", () => {
    const now = new Date(2026, 10, 24, 10, 0, 0, 0).getTime();
    const sameDay = new Date(2026, 10, 24, 14, 0, 0, 0).getTime();
    const nextDay = new Date(2026, 10, 25, 9, 0, 0, 0).getTime();
    const later = new Date(2026, 10, 28, 15, 30, 0, 0).getTime();
    expect(formatSnoozeUntil(sameDay, now)).not.toContain("Tomorrow");
    expect(formatSnoozeUntil(nextDay, now)).toContain("Tomorrow");
    expect(formatSnoozeUntil(later, now)).not.toContain("Tomorrow");
  });

  test("round-trips datetime-local values", () => {
    const original = new Date(2026, 10, 25, 9, 15, 0, 0).getTime();
    const formatted = toDatetimeLocalValue(original);
    expect(formatted).toBe("2026-11-25T09:15");
    expect(parseDatetimeLocalValue(formatted)).toBe(original);
    expect(parseDatetimeLocalValue("")).toBeNull();
  });

  test("matches pending and snoozed requests to chat threads and live sessions", () => {
    const threadId = "00000000-0000-4000-8000-000000000042";
    const pendingThread = HumanRequestSchema.parse({
      id: "req-1",
      input: {
        kind: "question",
        prompt: "Continue?",
        origin: {
          session_id: "s1",
          backend: "codex-cli",
          request_id: "r1",
          chat_thread_id: threadId,
          native_session_id: "native-1",
          execution_host: null,
        },
      },
      status: "pending",
      version: 1,
      response: null,
      created_at: 1000,
      expires_at: 100000,
      responded_at: null,
      delivered_at: null,
      snooze_until: 50000,
    });
    const answered = HumanRequestSchema.parse({
      ...pendingThread,
      id: "req-2",
      status: "answered",
      snooze_until: null,
    });

    expect(isRequestSnoozed(pendingThread, 20000)).toBe(true);
    expect(isRequestSnoozed(pendingThread, 50000)).toBe(false);
    expect(isRequestSnoozed(answered, 20000)).toBe(false);

    expect(
      pendingRequestsForSession([pendingThread, answered], { threadId }).map((r) => r.id),
    ).toEqual(["req-1"]);
    expect(
      pendingRequestsForSession([pendingThread, answered], {
        runtimeId: "native-1",
        backend: "codex",
        host: null,
      }).map((r) => r.id),
    ).toEqual(["req-1"]);
    expect(
      pendingRequestsForSession([pendingThread, answered], {
        runtimeId: "native-1",
        backend: "claude",
        host: null,
      }),
    ).toEqual([]);
  });
});
