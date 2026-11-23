import type { SessionDelivery } from "@orc/core/session-messages";

/**
 * Notifications and bookmarks stored before the session list moved into the
 * chat page still carry `/sessions?session=…`. Point those at the chat page
 * so an old link still opens the session it names.
 */
export function sessionPath(path: string): string {
  const url = new URL(path, "http://localhost");
  const thread = url.searchParams.get("chatThread");
  if (thread && url.searchParams.get("chat") === "open") {
    const next = new URLSearchParams({ chatThread: thread });
    next.set("project", url.searchParams.get("project") ?? "all");
    return `/chat?${next}`;
  }
  if (path !== "/sessions" && !path.startsWith("/sessions?")) return path;
  const id = url.searchParams.get("session");
  const next = new URLSearchParams(url.searchParams);
  next.delete("session");
  if (id) next.set("sessionLive", id);
  else next.set("sessionList", "show");
  const query = next.toString();
  return query ? `/chat?${query}` : "/chat";
}

export function deliverySessionHref(delivery: SessionDelivery): string | null {
  const sessionId = delivery.session_id;
  if (!sessionId) return null;
  if (delivery.kind === "child_outcome") {
    return `/chat?chatThread=${encodeURIComponent(sessionId)}`;
  }
  return `/chat?sessionLive=${encodeURIComponent(sessionId)}`;
}
