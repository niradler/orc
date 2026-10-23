import {
  type ChatEvent,
  ChatEventSchema,
  type ChatSettings,
  ChatSettingsSchema,
} from "@orc/core/chat";

export type ChatConfig = ChatSettings;
export const CHAT_CONFIG_KEY = "orc_chat_config";
export const DEFAULT_CONFIG: ChatConfig = ChatSettingsSchema.parse({});
export function parseChatConfig(raw: string | null): ChatConfig {
  try {
    const parsed = ChatSettingsSchema.safeParse(JSON.parse(raw ?? "null"));
    return parsed.success ? parsed.data : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}
export function parseChatEvent(line: string): ChatEvent | null {
  if (!line.startsWith("data:")) return null;
  try {
    const event = ChatEventSchema.safeParse(JSON.parse(line.slice(5).trim()));
    return event.success ? event.data : null;
  } catch {
    return null;
  }
}
