import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NOTIFICATION_PREFS,
  parseNotificationPrefs,
} from "../../src/lib/agent-notifications";

describe("notification prefs", () => {
  test("stored prefs are validated", () => {
    expect(parseNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs("not json")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs('{"sound":false,"volume":4,"mutedProjects":["p",3]}')).toEqual({
      sound: false,
      volume: 1,
      mutedProjects: ["p"],
    });
  });
});
