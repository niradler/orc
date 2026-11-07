import type { NotificationLevel } from "./agent-notifications";

export interface DesktopNotification {
  title: string;
  body: string;
  path: string;
  level: NotificationLevel;
}

export type DesktopUpdateChannel = "stable" | "preview";

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "downloaded"
  | "current"
  | "error"
  | "unavailable";

export interface DesktopUpdateState {
  currentVersion: string;
  channel: DesktopUpdateChannel;
  checksEnabled: boolean;
  phase: DesktopUpdatePhase;
  availableVersion: string | null;
  releaseNotes: string | null;
  progress: number | null;
  lastCheckedAt: string | null;
  error: string | null;
  packaged: boolean;
}

export interface DesktopUpdates {
  state(): Promise<DesktopUpdateState>;
  setPreferences(preferences: {
    channel: DesktopUpdateChannel;
    checksEnabled: boolean;
  }): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  install(): Promise<void>;
  onChange(listener: (state: DesktopUpdateState) => void): () => void;
}

/** Exposed by the Electron preload; absent in a plain browser. */
export interface OrcDesktopBridge {
  notify(notification: DesktopNotification): void;
  onOpen(listener: (path: string) => void): () => void;
  updates?: DesktopUpdates;
}

export function desktopBridge(): OrcDesktopBridge | undefined {
  return (window as Window & { orcDesktop?: OrcDesktopBridge }).orcDesktop;
}
