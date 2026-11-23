import {
  type ChatEvent,
  ChatEventSchema,
  type ChatSettings,
  ChatSettingsSchema,
} from "@orc/core/chat";
import { withPermissionMode } from "../lib/composer-chips";

export type ChatConfig = ChatSettings;
export const DEFAULT_CONFIG: ChatConfig = ChatSettingsSchema.parse({});

/** The agent, model and permissions last picked in this browser, applied to new chats. */
export const CHAT_PREFERENCES_KEY = "orc_chat_preferences";
const ChatPreferencesSchema = ChatSettingsSchema.pick({
  providerId: true,
  agent: true,
  model: true,
  permissionMode: true,
}).partial();
export type ChatPreferences = Partial<
  Pick<ChatConfig, "agent" | "model" | "permissionMode" | "providerId">
>;
export function parseChatPreferences(raw: string | null): ChatPreferences {
  try {
    const parsed = ChatPreferencesSchema.safeParse(JSON.parse(raw ?? "null"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
export function withPreferences(config: ChatConfig, preferences: ChatPreferences): ChatConfig {
  const next = { ...config, ...preferences };
  if (preferences.agent && !preferences.providerId && preferences.agent !== config.agent)
    next.providerId = preferences.agent;
  // A model belongs to its agent; drop it when the saved agent no longer matches.
  if (preferences.agent && preferences.agent !== config.agent && !preferences.model)
    next.model = "";
  return preferences.permissionMode ? withPermissionMode(next, preferences.permissionMode) : next;
}

export type ChatSurface = "page" | "side";

export const CHAT_THREAD_PARAM = "chatThread";
export const SIDE_CHAT_THREAD_PARAM = "sideChatThread";

export interface ChatSurfaceUrlState {
  pageShown: boolean;
  sideShown: boolean;
  redirecting: boolean;
  pageParam: typeof CHAT_THREAD_PARAM | null;
  sideParam: typeof CHAT_THREAD_PARAM | typeof SIDE_CHAT_THREAD_PARAM | null;
  pageLinked: string | null;
  sideLinked: string | null;
}

export function chatSurfaceLinks(
  pathname: string,
  search: string,
  desktopViewport: boolean,
): ChatSurfaceUrlState {
  const params = new URLSearchParams(search);
  const chatParam = params.get("chat");
  const redirecting = chatParam === "full" || (chatParam === "open" && !desktopViewport);
  const pageShown = pathname === "/chat" || chatParam === "full";
  const sideShown = chatParam === "open" && desktopViewport;
  const pageParam = pageShown ? CHAT_THREAD_PARAM : null;
  const sideParam = sideShown ? (pageShown ? SIDE_CHAT_THREAD_PARAM : CHAT_THREAD_PARAM) : null;
  const readId = (key: string | null) => {
    if (!key) return null;
    const value = params.get(key);
    return value && isChatThreadId(value) ? value : null;
  };
  return {
    pageShown,
    sideShown,
    redirecting,
    pageParam,
    sideParam,
    pageLinked: readId(pageParam),
    sideLinked: readId(sideParam),
  };
}

export function initialChatSurfaceLinks(
  pathname: string,
  search: string,
  desktopViewport: boolean,
): ChatSurfaceUrlState {
  const links = chatSurfaceLinks(pathname, search, desktopViewport);
  const params = new URLSearchParams(search);
  if (params.get("chat") !== "open" || desktopViewport) return links;
  const readId = (key: string) => {
    const value = params.get(key);
    return value && isChatThreadId(value) ? value : null;
  };
  const handoffThread = readId(SIDE_CHAT_THREAD_PARAM) ?? readId(CHAT_THREAD_PARAM);
  return handoffThread ? { ...links, pageLinked: handoffThread } : links;
}

/** Conversations open as chat tabs in this browser, restored after a reload. */
export const CHAT_TABS_KEY = "orc_chat_tabs";
export interface StoredChatTabs {
  threads: string[];
  active: string | null;
  sideActive?: string | null;
  projectIds?: Record<string, string | null>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thread ids are UUIDs; anything else from a link or storage is ignored. */
export function isChatThreadId(id: string): boolean {
  return UUID.test(id);
}
export function parseChatTabs(raw: string | null): StoredChatTabs {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return { threads: [], active: null };
    const record = value as Record<string, unknown>;
    const { threads, active, sideActive, projectIds: rawProjects } = record;
    const ids = Array.isArray(threads)
      ? threads
          .filter((id): id is string => typeof id === "string" && isChatThreadId(id))
          .slice(0, 20)
      : [];
    const projectIds = Object.fromEntries(
      rawProjects && typeof rawProjects === "object" && !Array.isArray(rawProjects)
        ? Object.entries(rawProjects).filter(
            ([id, project]) =>
              ids.includes(id) &&
              (project === null ||
                (typeof project === "string" &&
                  project.length > 0 &&
                  project.length <= 100 &&
                  !["all", "unassigned"].includes(project))),
          )
        : [],
    );
    const hasSideActive = "sideActive" in record;
    const parsedSideActive =
      typeof sideActive === "string" && ids.includes(sideActive) ? sideActive : null;
    return {
      ...(Object.keys(projectIds).length
        ? { projectIds: projectIds as Record<string, string | null> }
        : {}),
      threads: ids,
      active: typeof active === "string" && ids.includes(active) ? active : null,
      ...(hasSideActive ? { sideActive: parsedSideActive } : {}),
    };
  } catch {
    return { threads: [], active: null };
  }
}

export function parseChatEvent(line: string): ChatEvent | null {
  if (!line.startsWith("data:")) return null;
  try {
    const data: unknown = JSON.parse(line.slice(5).trim());
    if (data && typeof data === "object" && "type" in data && data.type === "done")
      return { type: "done" };
    const event = ChatEventSchema.safeParse(data);
    return event.success ? event.data : null;
  } catch {
    return null;
  }
}
