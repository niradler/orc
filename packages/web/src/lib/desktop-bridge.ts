import type {
  BrowserAction,
  BrowserSelector,
  PreviewBrowserState,
  PreviewFile,
  PreviewImportResult,
  PreviewImportSource,
  PreviewPreferences,
  PreviewProfile,
} from "@orc/core/desktop-preview";
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
  preview?: {
    upload(
      session_id: string,
      selector: BrowserSelector,
      files: { name: string; data: string }[],
      tab_id?: string,
    ): Promise<unknown>;
    importStores(): Promise<{ id: string; name: string }[]>;
    discoverStore(source_id: string): Promise<PreviewImportSource>;
    display(session_id: string, command: BrowserAction): Promise<unknown>;
    pageDialog(session_id: string, accept: boolean, text?: string): Promise<void>;
    restore(session_id: string): Promise<PreviewBrowserState | null>;
    renameProfile(profile_id: string, name: string): Promise<PreviewProfile>;
    removeProfile(profile_id: string): Promise<boolean>;
    cancelImport(): Promise<void>;
    onProfiles(listener: (profiles: PreviewProfile[]) => void): () => void;
    discoverImport(port: number): Promise<PreviewImportSource>;
    transferImport(
      source_id: string,
      profile_id: string,
      sites: string[],
    ): Promise<PreviewImportResult>;
    profiles(): Promise<PreviewProfile[]>;
    createProfile(name: string): Promise<PreviewProfile>;
    selectProfile(session_id: string, profile_id?: string | null): Promise<string | null>;
    dirty(value: boolean): Promise<void>;
    preferences(): Promise<PreviewPreferences>;
    setPreferences(preferences: PreviewPreferences): Promise<PreviewPreferences>;
    onPreferences(listener: (preferences: PreviewPreferences) => void): () => void;
    open(session_id: string, url: string, new_tab?: boolean): Promise<PreviewBrowserState>;
    navigate(session_id: string, direction: "back" | "forward" | "reload"): Promise<void>;
    bounds(
      session_id: string | null,
      bounds: { x: number; y: number; width: number; height: number } | null,
      restore_url?: string,
    ): Promise<void>;
    allow(session_id: string, enabled: boolean): Promise<void>;
    chatPermission(session_id: string, enabled?: boolean): Promise<boolean>;
    control(session_id: string, command: BrowserAction, tab_id?: string): Promise<unknown>;
    tab(
      session_id: string,
      command: { action: "tab_select" | "tab_close"; tab_id: string },
    ): Promise<PreviewBrowserState | null>;
    pick(): Promise<PreviewFile | null>;
    read(token: string): Promise<PreviewFile>;
    release(token: string): Promise<void>;
    save(token: string, content: string, original: string): Promise<void>;
    externalUrl(url: string): Promise<void>;
    externalFile(path: string, host: string | null, reveal?: boolean): Promise<void>;
    onBrowser(listener: (state: PreviewBrowserState) => void): () => void;
    onOpen(listener: (request: { kind: "url" | "panel"; target?: string }) => void): () => void;
  };
  notify(notification: DesktopNotification): void;
  onOpen(listener: (path: string) => void): () => void;
  updates?: DesktopUpdates;
}

export function desktopBridge(): OrcDesktopBridge | undefined {
  return (window as Window & { orcDesktop?: OrcDesktopBridge }).orcDesktop;
}
