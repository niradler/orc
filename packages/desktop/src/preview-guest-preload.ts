import { contextBridge, ipcRenderer } from "electron";

// Electron disables prompt(). Restore only this standard page operation; never expose IPC or ORC APIs.
contextBridge.exposeInMainWorld(
  "__orcPagePrompt",
  (message?: unknown, defaultValue?: unknown): string | null =>
    ipcRenderer.sendSync("orc:preview-prompt", {
      message: String(message ?? "").slice(0, 4000),
      default_prompt: String(defaultValue ?? "").slice(0, 2000),
    }),
);
contextBridge.executeInMainWorld({
  func: () => {
    Reflect.set(globalThis, "prompt", Reflect.get(globalThis, "__orcPagePrompt"));
  },
});
