import {
  type BrowserAction,
  PREVIEW_COMMAND,
  PREVIEW_EVENT,
  PREVIEW_OPEN_EVENT,
  PREVIEW_SETTINGS_EVENT,
  type PreviewBrowserState,
  type PreviewFile,
  type PreviewPreferences,
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
    open: (session_id: string, url: string): Promise<PreviewBrowserState> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "open", session_id, url }),
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
    control: (session_id: string, command: BrowserAction): Promise<unknown> =>
      ipcRenderer.invoke(PREVIEW_COMMAND, { action: "control", session_id, command }),
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
  onOpen: (listener: (path: string) => void) => {
    const handler = (_event: IpcRendererEvent, path: unknown) => {
      if (typeof path === "string") listener(path);
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
