export type ChatConfig = { agent: string; autoApprove: boolean };
export const CHAT_CONFIG_KEY = "orc_chat_config";
export const DEFAULT_CONFIG: ChatConfig = { agent: "codex", autoApprove: true };
export function parseChatConfig(raw: string | null): ChatConfig {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_CONFIG;
    const config = value as Record<string, unknown>;
    if (
      typeof config.agent !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/i.test(config.agent) ||
      typeof config.autoApprove !== "boolean"
    )
      return DEFAULT_CONFIG;
    return { agent: config.agent, autoApprove: config.autoApprove };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function parseChatEvent(
  line: string,
): { type: "text"; text: string } | { type: "error"; message: string } | null {
  if (!line.startsWith("data:")) return null;
  try {
    const value: unknown = JSON.parse(line.slice(5).trim());
    if (!value || typeof value !== "object") return null;
    const event = value as Record<string, unknown>;
    if (event.type === "text" && typeof event.text === "string")
      return { type: "text", text: event.text };
    if (event.type === "error")
      return {
        type: "error",
        message:
          typeof event.message === "string"
            ? event.message
            : "The agent could not complete the response.",
      };
  } catch {
    /* Ignore invalid events; never render arbitrary structured data. */
  }
  return null;
}
