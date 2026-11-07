export const UPDATE_CHANNELS = ["stable", "preview"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export type UpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "downloaded"
  | "current"
  | "error"
  | "unavailable";

export type UpdateSnapshot = {
  currentVersion: string;
  channel: UpdateChannel;
  checksEnabled: boolean;
  phase: UpdatePhase;
  availableVersion: string | null;
  releaseNotes: string | null;
  progress: number | null;
  lastCheckedAt: string | null;
  error: string | null;
  packaged: boolean;
};

export type StoredUpdateSettings = {
  channel: UpdateChannel;
  checksEnabled: boolean;
  lastCheckedAt: string | null;
  lastResult: "current" | "available" | "error" | null;
  lastVersion: string | null;
  lastError: string | null;
};

export type UpdateEvent =
  | { type: "preferences"; channel: UpdateChannel; checksEnabled: boolean }
  | { type: "checking" }
  | { type: "available"; version: string; notes: string | null }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string; notes: string | null }
  | { type: "current" }
  | { type: "error"; message: string }
  | { type: "unavailable" };

export const UPDATE_STATE_CHANNEL = "orc:update-state";
export const UPDATE_SET_CHANNEL = "orc:update-set";
export const UPDATE_CHECK_CHANNEL = "orc:update-check";
export const UPDATE_INSTALL_CHANNEL = "orc:update-install";
export const UPDATE_EVENT_CHANNEL = "orc:update-event";

export const UPDATE_REPOSITORY = { owner: "niradler", repo: "orc" } as const;
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const START_CHECK_DELAY_MS = 15_000;

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function defaultStoredSettings(): StoredUpdateSettings {
  return {
    channel: "stable",
    checksEnabled: true,
    lastCheckedAt: null,
    lastResult: null,
    lastVersion: null,
    lastError: null,
  };
}

export function allowsPrerelease(channel: UpdateChannel): boolean {
  return channel === "preview";
}

export function withAppVersion(userAgent: string, version: string): string {
  return `${userAgent.replace(/\s*\borc\/[\w.-]+/g, "").trim()} orc/${version}`;
}

export function parseStoredSettings(text: string): StoredUpdateSettings {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return defaultStoredSettings();
    const record = value as Record<string, unknown>;
    const lastResult = record.lastResult;
    return {
      channel: record.channel === "preview" ? "preview" : "stable",
      checksEnabled: typeof record.checksEnabled === "boolean" ? record.checksEnabled : true,
      lastCheckedAt: shortText(record.lastCheckedAt, 40),
      lastResult:
        lastResult === "current" || lastResult === "available" || lastResult === "error"
          ? lastResult
          : null,
      lastVersion: shortText(record.lastVersion, 40),
      lastError: shortText(record.lastError, 300),
    };
  } catch {
    return defaultStoredSettings();
  }
}

export function preferencesFromUser(value: unknown): {
  channel: UpdateChannel;
  checksEnabled: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid update settings");
  const record = value as Record<string, unknown>;
  if (record.channel !== "stable" && record.channel !== "preview")
    throw new Error("Invalid update channel");
  if (typeof record.checksEnabled !== "boolean") throw new Error("Invalid update settings");
  return { channel: record.channel, checksEnabled: record.checksEnabled };
}

export function initialSnapshot(
  currentVersion: string,
  stored: StoredUpdateSettings,
  packaged: boolean,
): UpdateSnapshot {
  const base = {
    currentVersion,
    channel: stored.channel,
    checksEnabled: stored.checksEnabled,
    availableVersion: null,
    releaseNotes: null,
    progress: null,
    lastCheckedAt: stored.lastCheckedAt,
    error: null,
    packaged,
  };
  if (!packaged) return { ...base, phase: "unavailable" };
  if (stored.lastResult === "current") return { ...base, phase: "current" };
  if (stored.lastResult === "error") return { ...base, phase: "error", error: stored.lastError };
  if (stored.lastResult === "available")
    return { ...base, phase: "idle", availableVersion: stored.lastVersion };
  return { ...base, phase: "idle" };
}

export function applyEvent(
  state: UpdateSnapshot,
  event: UpdateEvent,
  checkedAt = new Date().toISOString(),
): UpdateSnapshot {
  switch (event.type) {
    case "preferences":
      return { ...state, channel: event.channel, checksEnabled: event.checksEnabled };
    case "checking":
      return { ...state, phase: "checking", error: null };
    case "available":
      return {
        ...state,
        phase: "downloading",
        availableVersion: displayVersion(event.version),
        releaseNotes: event.notes,
        progress: null,
        error: null,
      };
    case "progress":
      if (state.phase !== "downloading" || !Number.isFinite(event.percent)) return state;
      return { ...state, progress: Math.min(100, Math.max(0, event.percent)) };
    case "downloaded":
      return {
        ...state,
        phase: "downloaded",
        availableVersion: displayVersion(event.version),
        releaseNotes: event.notes ?? state.releaseNotes,
        progress: 100,
        lastCheckedAt: checkedAt,
        error: null,
      };
    case "current":
      return {
        ...state,
        phase: "current",
        availableVersion: null,
        releaseNotes: null,
        progress: null,
        lastCheckedAt: checkedAt,
        error: null,
      };
    case "error":
      return {
        ...state,
        phase: "error",
        availableVersion: null,
        releaseNotes: null,
        progress: null,
        lastCheckedAt: checkedAt,
        error: event.message.slice(0, 300),
      };
    case "unavailable":
      return {
        ...state,
        phase: "unavailable",
        packaged: false,
        availableVersion: null,
        releaseNotes: null,
        progress: null,
        error: null,
      };
  }
}

export function plainReleaseNotes(value: unknown): string | null {
  const raw = notesToString(value);
  if (!raw) return null;
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  return text.length > 4000 ? `${text.slice(0, 3999)}…` : text;
}

export function updateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const clean = message.replace(/\s+/g, " ").trim();
  return (clean || "Update check failed").slice(0, 300);
}

export async function installDownloadedUpdate(input: {
  phase: UpdatePhase;
  stopOwnedDaemon: () => Promise<void>;
  quitAndInstall: () => void;
}): Promise<void> {
  if (input.phase !== "downloaded") throw new Error("No update is ready to install");
  await input.stopOwnedDaemon();
  input.quitAndInstall();
}

export function settingsToStore(
  state: UpdateSnapshot,
  previous: StoredUpdateSettings,
): StoredUpdateSettings {
  const lastResult =
    state.phase === "current"
      ? "current"
      : state.phase === "downloaded"
        ? "available"
        : state.phase === "error"
          ? "error"
          : state.availableVersion
            ? "available"
            : previous.lastResult;
  return {
    channel: state.channel,
    checksEnabled: state.checksEnabled,
    lastCheckedAt: state.lastCheckedAt ?? previous.lastCheckedAt,
    lastResult,
    lastVersion:
      lastResult === "available" ? (state.availableVersion ?? previous.lastVersion) : null,
    lastError: lastResult === "error" ? (state.error ?? previous.lastError) : null,
  };
}

function displayVersion(version: string): string {
  const clean = version.replace(/[^\d.A-Za-z+-]/g, "").slice(0, 40);
  if (!VERSION.test(clean)) throw new Error("Invalid update version");
  return clean;
}

function notesToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const note = (entry as { note?: unknown }).note;
    return typeof note === "string" ? [note] : [];
  });
  return parts.length ? parts.join("\n\n") : null;
}

function shortText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : null;
}
