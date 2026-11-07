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
