import {
  type ChannelCondition,
  type ChannelInbound,
  type ChannelRoute,
  channelCommand,
  validChannelCondition,
} from "@orc/core/channels";

export function matchesCondition(condition: ChannelCondition, message: ChannelInbound): boolean {
  if ("always" in condition) return true;
  if ("all" in condition) return condition.all.every((c) => matchesCondition(c, message));
  if ("any" in condition) return condition.any.some((c) => matchesCondition(c, message));
  if ("not" in condition) return !matchesCondition(condition.not, message);
  const actual =
    condition.field === "command"
      ? (channelCommand(message.text)?.name ?? "")
      : (message[condition.field] ?? "");
  if (condition.op === "is") return actual === condition.value;
  if (condition.op === "in")
    return Array.isArray(condition.value) && condition.value.includes(String(actual));
  if (typeof actual !== "string" || typeof condition.value !== "string") return false;
  return condition.op === "contains"
    ? actual.includes(condition.value)
    : actual.startsWith(condition.value);
}

export function routeMessage(
  routes: ChannelRoute[],
  message: ChannelInbound,
): ChannelRoute | undefined {
  return routes.find(
    (r) =>
      r.enabled && validChannelCondition(r.condition) && matchesCondition(r.condition, message),
  );
}
