import {
  type ChannelCondition,
  type ChannelInbound,
  type ChannelRoute,
  type ChannelTimeWindow,
  channelCommand,
  validChannelCondition,
} from "@orc/core/channels";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function inTimeWindow(window: ChannelTimeWindow, now: Date): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: window.tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const [fromH, fromM] = window.from.split(":").map(Number);
  const [toH, toM] = window.to.split(":").map(Number);
  const from = (fromH ?? 0) * 60 + (fromM ?? 0);
  const to = (toH ?? 0) * 60 + (toM ?? 0);
  const day = weekdays.indexOf(String(parts.weekday));
  if (from <= to)
    return (!window.days || window.days.includes(day)) && minutes >= from && minutes < to;
  if (minutes >= from) return !window.days || window.days.includes(day);
  return minutes < to && (!window.days || window.days.includes((day + 6) % 7));
}

export function matchesCondition(
  condition: ChannelCondition,
  message: ChannelInbound,
  now = new Date(),
): boolean {
  if ("always" in condition) return true;
  if ("time" in condition) return inTimeWindow(condition.time, now);
  if ("all" in condition) return condition.all.every((c) => matchesCondition(c, message, now));
  if ("any" in condition) return condition.any.some((c) => matchesCondition(c, message, now));
  if ("not" in condition) return !matchesCondition(condition.not, message, now);
  const actual =
    condition.field === "command"
      ? (channelCommand(message.text)?.name ?? "")
      : (message[condition.field] ?? (condition.field === "is_followup" ? false : ""));
  if (condition.op === "is") return actual === condition.value;
  if (condition.op === "in")
    return Array.isArray(condition.value) && condition.value.includes(String(actual));
  if (condition.op === "contains_any") {
    const text = String(actual).toLowerCase();
    return (
      Array.isArray(condition.value) && condition.value.some((w) => text.includes(w.toLowerCase()))
    );
  }
  if (typeof actual !== "string" || typeof condition.value !== "string") return false;
  return condition.op === "contains"
    ? actual.includes(condition.value)
    : actual.startsWith(condition.value);
}

export function routeMessage(
  routes: ChannelRoute[],
  message: ChannelInbound,
  now = new Date(),
): ChannelRoute | undefined {
  return routes.find(
    (r) =>
      r.enabled &&
      validChannelCondition(r.condition) &&
      matchesCondition(r.condition, message, now),
  );
}
