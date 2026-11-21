export type NotificationLevel = "needs-you" | "done";

export interface NotificationPrefs {
  sound: boolean;
  volume: number;
  mutedProjects: string[];
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  sound: true,
  volume: 0.6,
  mutedProjects: [],
};

export function parseNotificationPrefs(raw: string | null): NotificationPrefs {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_NOTIFICATION_PREFS;
    const record = value as Record<string, unknown>;
    const volume = typeof record.volume === "number" ? record.volume : NaN;
    return {
      sound: typeof record.sound === "boolean" ? record.sound : DEFAULT_NOTIFICATION_PREFS.sound,
      volume: Number.isFinite(volume)
        ? Math.min(1, Math.max(0, volume))
        : DEFAULT_NOTIFICATION_PREFS.volume,
      mutedProjects: Array.isArray(record.mutedProjects)
        ? record.mutedProjects.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}
