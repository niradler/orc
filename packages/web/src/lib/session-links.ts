/**
 * Notifications and bookmarks stored before the session list moved into the
 * chat page still carry `/sessions?session=…`. Point those at the chat page's
 * read-only viewer so an old link still opens the session it names.
 */
export function sessionPath(path: string): string {
  if (path !== "/sessions" && !path.startsWith("/sessions?")) return path;
  const url = new URL(path, "http://localhost");
  const id = url.searchParams.get("session");
  const next = new URLSearchParams(url.searchParams);
  next.delete("session");
  if (id) next.set("sessionView", id);
  else next.set("sessionList", "show");
  const query = next.toString();
  return query ? `/chat?${query}` : "/chat";
}
