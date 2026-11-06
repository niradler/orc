import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import { NOTIFY_CHANNEL, type NotifyRequest, OPEN_CHANNEL } from "./notify.js";

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
});
