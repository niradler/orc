import { expect, test } from "bun:test";
import { claudeLimitEvent, codexLimitEvent } from "../provider-limits";

test("should fail a rejected Claude quota with a reset time without stopping paid overage", () => {
  expect(claudeLimitEvent({ status: "rejected", resetsAt: 1800000000 })).toEqual({
    type: "error",
    data: "Claude usage limit reached. Resets 2027-01-15T08:00:00.000Z. Retry after the limit resets.",
  });
  expect(claudeLimitEvent({ status: "rejected", overageStatus: "allowed" })?.type).toBe(
    "system_status",
  );
  expect(claudeLimitEvent({ status: "allowed_warning" })?.type).toBe("system_status");
  expect(claudeLimitEvent({ status: "allowed" })).toBeNull();
  expect(claudeLimitEvent({ status: "rejected", resetsAt: Infinity })).toBeNull();
});

test("should surface validated Codex warning windows without treating credits as a failure", () => {
  expect(codexLimitEvent({ primary: { usedPercent: 100, resetsAt: 1800000000 } })).toEqual({
    type: "system_status",
    data: "Codex usage: 100% used. Resets 2027-01-15T08:00:00.000Z.",
  });
  expect(codexLimitEvent({ primary: { usedPercent: 20 } })).toBeNull();
  expect(codexLimitEvent({ primary: { usedPercent: 101 } })).toBeNull();
});
