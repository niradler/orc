import {
  type BrowserAction,
  type BrowserSelector,
  PREVIEW_COMMAND,
  PREVIEW_EVENT,
  PREVIEW_OPEN_EVENT,
  PREVIEW_PROFILES_EVENT,
  PREVIEW_SETTINGS_EVENT,
  type PreviewBrowserState,
  type PreviewFile,
  type PreviewImportResult,
  type PreviewImportSource,
  type PreviewPreferences,
  type PreviewProfile,
} from "@orc/core/desktop-preview";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import { NOTIFY_CHANNEL, type NotifyRequest, OPEN_CHANNEL } from "./notify.js";
import {
  desktopUpdatesSupported,
  UPDATE_CHECK_CHANNEL,
  UPDATE_EVENT_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_SET_CHANNEL,
  UPDATE_STATE_CHANNEL,
  type UpdateChannel,
  type UpdateSnapshot,
} from "./update-policy.js";

contextBridge.exposeInMainWorld("orcDesktop", {
  preview: {
    upload: (
      session_id: string,
      selector: BrowserSelector,
      files: { name: string; data: string }[],
      tab_id?: string,
    ): Promise<unknown> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, {
        action: "upload",
        session_id,
        selector,
        files,
        ...(tab_id ? { tab_id } : {}),
      }),
    importStores: (): Promise<{ id: string; name: string }[]> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "import_stores" }),
    discoverStore: (source_id: string): Promise<PreviewImportSource> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "import_store_discover", source_id }),
    display: (session_id: string, command: BrowserAction): Promise<unknown> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "display", session_id, command }),
    pageDialog: (session_id: string, accept: boolean, text?: string): Promise<void> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, {
        action: "page_dialog",
        session_id,
        accept,
        ...(text === undefined ? {} : { text }),
      }),
    restore: (session_id: string): Promise<PreviewBrowserState | null> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "restore", session_id }),
    renameProfile: (profile_id: string, name: string): Promise<PreviewProfile> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "profile_rename", profile_id, name }),
    removeProfile: (profile_id: string): Promise<boolean> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "profile_remove", profile_id }),
    cancelImport: (): Promise<void> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "import_cancel" }),
    onProfiles: (listener: (profiles: PreviewProfile[]) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, profiles: PreviewProfile[]) => listener(profiles);
      ipcRenderer.on(PREVIEW_PROFILES_EVENT, handler);
      return () => ipcRenderer.removeListener(PREVIEW_PROFILES_EVENT, handler);
    },
    discoverImport: (port: number): Promise<PreviewImportSource> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "import_discover", port }),
    transferImport: (
      source_id: string,
      profile_id: string,
      sites: string[],
    ): Promise<PreviewImportResult> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, {
        action: "import_transfer",
        source_id,
        profile_id,
        sites,
      }),
    profiles: (): Promise<PreviewProfile[]> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "profiles" }),
    createProfile: (name: string): Promise<PreviewProfile> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "profile_create", name }),
    selectProfile: (session_id: string, profile_id?: string | null): Promise<string | null> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, {
        action: "profile_select",
        session_id,
        ...(profile_id === undefined ? {} : { profile_id }),
      }),
    dirty: (value: boolean): Promise<void> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "dirty", value }),
    preferences: (): Promise<PreviewPreferences> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "preferences" }),
    setPreferences: (preferences: PreviewPreferences): Promise<PreviewPreferences> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "set_preferences", preferences }),
    onPreferences: (listener: (preferences: PreviewPreferences) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, preferences: PreviewPreferences) =>
        listener(preferences);
      ipcRenderer.on(PREVIEW_SETTINGS_EVENT, handler);
      return () => ipcRenderer.removeListener(PREVIEW_SETTINGS_EVENT, handler);
    },
    open: (session_id: string, url: string, new_tab?: boolean): Promise<PreviewBrowserState> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, {
        action: "open",
        session_id,
        url,
        ...(new_tab === undefined ? {} : { new_tab }),
      }),
    navigate: (session_id: string, direction: "back" | "forward" | "reload"): Promise<void> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "navigation", session_id, direction }),
    bounds: (
      session_id: string | null,
      bounds: { x: number; y: number; width: number; height: number } | null,
      restore_url?: string,
    ): Promise<void> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, {
        action: "bounds",
        session_id,
        bounds,
        ...(restore_url ? { restore_url } : {}),
      }),
    allow: (session_id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "allow", session_id, enabled }),
    chatPermission: (session_id: string, enabled?: boolean): Promise<boolean> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, {
        action: "chat_permission",
        session_id,
        ...(enabled === undefined ? {} : { enabled }),
      }),
    control: (session_id: string, command: BrowserAction, tab_id?: string): Promise<unknown> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, {
        action: "control",
        session_id,
        command,
        ...(tab_id ? { tab_id } : {}),
      }),
    tab: (
      session_id: string,
      command: { action: "tab_select" | "tab_close"; tab_id: string },
    ): Promise<PreviewBrowserState | null> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "tab", session_id, command }),
    pick: (): Promise<PreviewFile | null> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "pick" }),
    read: (token: string): Promise<PreviewFile> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "read_local", token }),
    release: (token: string): Promise<void> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "release", token }),
    save: (token: string, content: string, original: string): Promise<void> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "save", token, content, original }),
    externalUrl: (url: string): Promise<void> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "external_url", url }),
    externalFile: (path: string, host: string | null, reveal = false): Promise<void> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "external_file", path, host, reveal }),
    onBrowser: (listener: (state: PreviewBrowserState) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: PreviewBrowserState) => listener(state);
      ipcRenderer.on(PREVIEW_EVENT, handler);
      return () => ipcRenderer.removeListener(PREVIEW_EVENT, handler);
    },
    onOpen: (
      listener: (request: { kind: "url" | "panel"; target?: string }) => void,
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        request: { kind: "url" | "panel"; target?: string },
      ) => listener(request);
      ipcRenderer.on(PREVIEW_OPEN_EVENT, handler);
      return () => ipcRenderer.removeListener(PREVIEW_OPEN_EVENT, handler);
    },
  },
  notify: (notification: NotifyRequest) => ipcRenderer.send(NOTIFY_CHANNEL, notification),
  onOpen: (listener: (path: string, id?: string) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => {
      if (typeof payload === "string") {
        listener(payload);
        return;
      }
      if (payload && typeof payload === "object") {
        const { path, id } = payload as { path?: unknown; id?: unknown };
        if (typeof path === "string") listener(path, typeof id === "string" ? id : undefined);
      }
    };
    ipcRenderer.on(OPEN_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(OPEN_CHANNEL, handler);
    };
  },
  updates: desktopUpdatesSupported(process.platform)
    ? {
        state: (): Promise<UpdateSnapshot> => ipcRenderer.invoke(UPDATE_STATE_CHANNEL),
        setPreferences: (preferences: {
          channel: UpdateChannel;
          checksEnabled: boolean;
        }): Promise<UpdateSnapshot> => ipcRenderer.invoke(UPDATE_SET_CHANNEL, preferences),
        check: (): Promise<UpdateSnapshot> => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
        install: (): Promise<void> => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
        onChange: (listener: (state: UpdateSnapshot) => void): (() => void) => {
          const handler = (_event: IpcRendererEvent, state: UpdateSnapshot) => listener(state);
          ipcRenderer.on(UPDATE_EVENT_CHANNEL, handler);
          return () => ipcRenderer.removeListener(UPDATE_EVENT_CHANNEL, handler);
        },
      }
    : undefined,
});
