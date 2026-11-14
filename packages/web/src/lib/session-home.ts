export const SESSION_TERMINAL_PARAM = "sessionTerminal";
export const SESSION_LIVE_PARAM = "sessionLive";
export const SESSION_LIST_PARAM = "sessionList";
export const INSPECTOR_PARAM = "inspector";
export const DRAWER_PARAM = "drawer";

export type InspectorTab = "overview" | "diff" | "files" | "pr";

export const INSPECTOR_TABS: InspectorTab[] = ["overview", "diff", "files", "pr"];

export interface SessionHomeState {
  terminalId: string | null;
  liveId: string | null;
  listHidden: boolean;
  listOpen: boolean;
  inspector: InspectorTab | null;
  drawer: boolean;
}

const HOME_PARAMS = [
  SESSION_TERMINAL_PARAM,
  SESSION_LIVE_PARAM,
  SESSION_LIST_PARAM,
  INSPECTOR_PARAM,
  DRAWER_PARAM,
];

export function readSessionHome(params: URLSearchParams): SessionHomeState {
  const inspector = params.get(INSPECTOR_PARAM);
  return {
    terminalId: params.get(SESSION_TERMINAL_PARAM) || null,
    liveId: params.get(SESSION_LIVE_PARAM) || null,
    listHidden: params.get(SESSION_LIST_PARAM) === "hide",
    listOpen: params.get(SESSION_LIST_PARAM) === "show",
    inspector: INSPECTOR_TABS.includes(inspector as InspectorTab)
      ? (inspector as InspectorTab)
      : null,
    drawer: params.get(DRAWER_PARAM) === "terminal",
  };
}

function put(params: URLSearchParams, key: string, value: string | null) {
  if (value) params.set(key, value);
  else params.delete(key);
}

export function patchSessionHome(
  params: URLSearchParams,
  patch: Partial<SessionHomeState>,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if ("terminalId" in patch) put(next, SESSION_TERMINAL_PARAM, patch.terminalId ?? null);
  if ("liveId" in patch) put(next, SESSION_LIVE_PARAM, patch.liveId ?? null);
  if ("listHidden" in patch) put(next, SESSION_LIST_PARAM, patch.listHidden ? "hide" : null);
  if ("listOpen" in patch) {
    if (patch.listOpen) next.set(SESSION_LIST_PARAM, "show");
    else if (next.get(SESSION_LIST_PARAM) === "show") next.delete(SESSION_LIST_PARAM);
  }
  if ("inspector" in patch) put(next, INSPECTOR_PARAM, patch.inspector ?? null);
  if ("drawer" in patch) put(next, DRAWER_PARAM, patch.drawer ? "terminal" : null);
  return next;
}

export function clearSessionHome(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of HOME_PARAMS) next.delete(key);
  return next;
}

/** A link into the Chat page from another page, keeping the project scope. */
export function sessionHomeSearch(
  search: string,
  target: { terminalId?: string; liveId?: string } = {},
): string {
  const current = new URLSearchParams(search);
  const next = new URLSearchParams();
  const project = current.get("project");
  if (project) next.set("project", project);
  if (target.terminalId) next.set(SESSION_TERMINAL_PARAM, target.terminalId);
  else if (target.liveId) next.set(SESSION_LIVE_PARAM, target.liveId);
  return `?${next.toString()}`;
}
