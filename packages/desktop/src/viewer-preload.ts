import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import {
  VIEWER_CHANNEL,
  VIEWER_STATE_CHANNEL,
  type ViewerAction,
  type ViewerState,
} from "./viewer-policy.js";

contextBridge.exposeInMainWorld("orcViewer", {
  action: (action: ViewerAction | "state", value?: string): Promise<ViewerState | undefined> =>
    ipcRenderer.invoke(VIEWER_CHANNEL, action, value),
  onState: (listener: (state: ViewerState) => void): void => {
    ipcRenderer.on(VIEWER_STATE_CHANNEL, (_event: IpcRendererEvent, state: ViewerState) =>
      listener(state),
    );
  },
});
