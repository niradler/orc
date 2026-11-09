import { expect, test } from "bun:test";
import { dailyCron, parseDailyCron } from "../../src/lib/job-schedule";

test("should round-trip a weekday time and recognize legacy daily schedules", () => {
  expect(dailyCron("09:05", [5, 1, 3])).toBe("5 9 * * 1,3,5");
  expect(parseDailyCron("5 9 * * 1,3,5")).toEqual({ time: "09:05", days: [1, 3, 5] });
  expect(parseDailyCron("0 0 * * *")).toEqual({ time: "00:00", days: [0, 1, 2, 3, 4, 5, 6] });
});

test("should keep schedules that simple time/day controls cannot represent in cron mode", () => {
  for (const value of [
    "*/5 * * * *",
    "0 9 1 * *",
    "0 9 * * MON-FRI",
    "0 0 9 * * *",
    "60 9 * * *",
    "0 24 * * *",
  ])
    expect(parseDailyCron(value)).toBeNull();
});
