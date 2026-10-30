import {
  type ChatEvent,
  ChatEventSchema,
  type ChatSettings,
  ChatSettingsSchema,
} from "@orc/core/chat";

export type ChatConfig = ChatSettings;
export const DEFAULT_CONFIG: ChatConfig = ChatSettingsSchema.parse({});

/** The agent, model and permissions last picked in this browser, applied to new chats. */
export const CHAT_PREFERENCES_KEY = "orc_chat_preferences";
const ChatPreferencesSchema = ChatSettingsSchema.pick({
  agent: true,
  model: true,
  permissionMode: true,
}).partial();
export type ChatPreferences = Partial<Pick<ChatConfig, "agent" | "model" | "permissionMode">>;
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
  // A model belongs to its agent; drop it when the saved agent no longer matches.
  if (preferences.agent && preferences.agent !== config.agent && !preferences.model)
    next.model = "";
  return next;
}

/** Conversations open as chat tabs in this browser, restored after a reload. */
export const CHAT_TABS_KEY = "orc_chat_tabs";
export interface StoredChatTabs {
  threads: string[];
  active: string | null;
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
    const { threads, active, projectIds: rawProjects } = value as Record<string, unknown>;
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
    return {
      ...(Object.keys(projectIds).length
        ? { projectIds: projectIds as Record<string, string | null> }
        : {}),
      threads: ids,
      active: typeof active === "string" && ids.includes(active) ? active : null,
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
