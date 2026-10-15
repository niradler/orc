export const WORKSPACE_SECTIONS = [
  {
    id: "activity",
    label: "Activity",
    path: "/activity",
    pages: [
      { id: "dashboard", label: "Activity", path: "/activity" },
      { id: "sessions", label: "Sessions", path: "/sessions" },
      { id: "jobs", label: "Jobs", path: "/jobs" },
      { id: "audit", label: "Audit", path: "/audit" },
    ],
  },
  {
    id: "tasks",
    label: "Tasks",
    path: "/tasks",
    pages: [{ id: "tasks", label: "Tasks", path: "/tasks" }],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    path: "/knowledge/wiki",
    pages: [
      { id: "wiki", label: "Wiki", path: "/knowledge/wiki" },
      { id: "knowledge", label: "Knowledge base", path: "/knowledge/base" },
      { id: "memories", label: "Memories", path: "/knowledge/memories" },
    ],
  },
  {
    id: "terminals",
    label: "Terminals",
    path: "/terminals",
    pages: [{ id: "terminals", label: "Terminals", path: "/terminals" }],
  },
  {
    id: "library",
    label: "Library",
    path: "/skills",
    pages: [
      { id: "skills", label: "Skills", path: "/skills" },
      { id: "packages", label: "Packages", path: "/packages" },
      { id: "agents", label: "Agents", path: "/packages/agents" },
      { id: "rules", label: "Rules", path: "/rules" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    pages: [{ id: "settings", label: "Settings", path: "/settings" }],
  },
] as const;

export function pathMatches(pathname: string, path: string) {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** Carry global workspace state, without leaking a page's filters into another feature. */
export function workspaceDestination(path: string, projectId: string, currentSearch: string) {
  const [pathname, destinationSearch = ""] = path.split("?", 2);
  const query = new URLSearchParams(destinationSearch);
  query.set("project", projectId);
  if (new URLSearchParams(currentSearch).get("chat") === "open") query.set("chat", "open");
  return `${pathname}?${query}`;
}

export function workspaceSection(pathname: string) {
  return WORKSPACE_SECTIONS.find((section) =>
    section.pages.some((page) => pathMatches(pathname, page.path)),
  );
}

export function workspacePage(pathname: string) {
  return workspaceSection(pathname)
    ?.pages.slice()
    .reverse()
    .find((page) => pathMatches(pathname, page.path));
}
