import { join } from "node:path";
import {
  BrowserActionSchema,
  PREVIEW_COMMAND,
  PREVIEW_EVENT,
  PREVIEW_OPEN_EVENT,
  PREVIEW_SETTINGS_EVENT,
  PreviewBoundsSchema,
  PreviewPreferencesSchema,
  previewWebUrl,
} from "@orc/core/desktop-preview";
import { app, type BrowserWindow, ipcMain, shell } from "electron";
import { z } from "zod";
import { PreviewBrowser } from "./preview-browser.js";
import { PreviewLocalFiles } from "./preview-files.js";
import { PreviewPreferencesStore } from "./preview-preferences.js";

const sessionId = z.string().min(1).max(200);
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("dirty"), value: z.boolean() }).strict(),
  z.object({ action: z.literal("preferences") }).strict(),
  z
    .object({ action: z.literal("set_preferences"), preferences: PreviewPreferencesSchema })
    .strict(),
  z
    .object({ action: z.literal("open"), session_id: sessionId, url: z.string().max(8192) })
    .strict(),
  z
    .object({
      action: z.literal("navigation"),
      session_id: sessionId,
      direction: z.enum(["back", "forward", "reload"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("bounds"),
      session_id: sessionId.nullable(),
      bounds: PreviewBoundsSchema.nullable(),
      restore_url: z.string().max(8192).optional(),
    })
    .strict(),
  z.object({ action: z.literal("allow"), session_id: sessionId, enabled: z.boolean() }).strict(),
  z
    .object({ action: z.literal("control"), session_id: sessionId, command: BrowserActionSchema })
    .strict(),
  z.object({ action: z.literal("pick") }).strict(),
  z.object({ action: z.literal("read_local"), token: z.string().uuid() }).strict(),
  z.object({ action: z.literal("release"), token: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("save"),
      token: z.string().uuid(),
      content: z.string().max(200_000),
      original: z.string().max(200_000),
    })
    .strict(),
  z.object({ action: z.literal("external_url"), url: z.string().max(8192) }).strict(),
  z
    .object({
      action: z.literal("external_file"),
      path: z.string().min(1).max(4096),
      host: z.string().max(255).nullable(),
      reveal: z.boolean().default(false),
    })
    .strict(),
]);
let active: {
  window: BrowserWindow;
  origin: string;
  browser: PreviewBrowser;
  files: PreviewLocalFiles;
  preferences: PreviewPreferencesStore;
  dirty: boolean;
} | null = null;
let installed = false;

export function attachDesktopPreview(window: BrowserWindow, origin: string): void {
  const browser = new PreviewBrowser(window, (state) => {
    if (!window.isDestroyed()) window.webContents.send(PREVIEW_EVENT, state);
  });
  const files = new PreviewLocalFiles(window);
  const preferences = new PreviewPreferencesStore(
    join(app.getPath("userData"), "browser-preferences.json"),
  );
  active = { window, origin, browser, files, preferences, dirty: false };
  // A damaged preference file must not enable control silently.
  try {
    browser.setAgentAccess(preferences.get().agentBrowserControl);
  } catch {
    browser.setAgentAccess(false);
  }
  window.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      browser.dispose();
      files.clear();
      if (active?.window === window) active.dirty = false;
    }
  });
  window.on("closed", () => {
    browser.dispose();
    if (active?.window === window) active = null;
  });
  if (installed) return;
  installed = true;
  ipcMain.handle(PREVIEW_COMMAND, async (event, payload: unknown) => {
    const host = active;
    if (
      !host ||
      host.window.isDestroyed() ||
      event.sender !== host.window.webContents ||
      event.senderFrame !== host.window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== host.origin
    )
      throw new Error("Desktop preview access denied");
    const input = commandSchema.parse(payload);
    switch (input.action) {
      case "dirty":
        host.dirty = input.value;
        return;
      case "preferences":
        return host.preferences.get();
      case "set_preferences": {
        const settings = host.preferences.set(input.preferences);
        host.browser.setAgentAccess(settings.agentBrowserControl);
        host.window.webContents.send(PREVIEW_SETTINGS_EVENT, settings);
        return settings;
      }
      case "open":
        return host.browser.open(input.session_id, input.url);
      case "navigation":
        return host.browser.navigation(input.session_id, input.direction);
      case "bounds":
        return host.browser.bounds(input.session_id, input.bounds, input.restore_url);
      case "allow":
        return host.browser.allow(input.session_id, input.enabled);
      case "control":
        return host.browser.control(input.session_id, input.command);
      case "pick":
        return host.files.pick();
      case "read_local":
        return host.files.read(input.token);
      case "release":
        return host.files.release(input.token);
      case "save":
        return host.files.save(input.token, input.content, input.original);
      case "external_url": {
        const url = previewWebUrl(input.url);
        if (!url) throw new Error("Only HTTP/HTTPS URLs can open externally");
        await shell.openExternal(url);
        return;
      }
      case "external_file": {
        if ([...input.path].some((char) => char.charCodeAt(0) < 32))
          throw new Error("Invalid file path");
        if (input.host && !/^[A-Za-z0-9_.@-]+$/.test(input.host))
          throw new Error("Invalid session host");
        if (input.reveal && !input.host) {
          shell.showItemInFolder(input.path);
          return;
        }
        const path = input.path.replace(/\\/g, "/");
        const uri = new URL(input.host ? "vscode://vscode-remote/" : "vscode://file/");
        uri.pathname =
          (input.host ? `ssh-remote+${encodeURIComponent(input.host)}/` : "") +
          path.replace(/^\/+/, "");
        await shell.openExternal(uri.href);
        return;
      }
    }
  });
}

/** Menu and unhandled external links reveal the integrated panel, not a new window. */
export function openDesktopViewer(target?: string): void {
  const host = active;
  if (!host || host.window.isDestroyed()) return;
  if (target && host.preferences.get().openLinksIn === "system") {
    const url = previewWebUrl(target);
    if (url) void shell.openExternal(url);
    return;
  }
  host.window.show();
  host.window.focus();
  const open = () =>
    host.window.webContents.send(
      PREVIEW_OPEN_EVENT,
      target ? { kind: "url", target } : { kind: "panel" },
    );
  if (host.window.webContents.isLoadingMainFrame())
    host.window.webContents.once("did-finish-load", open);
  else open();
}

export function hasUnsavedPreview(): boolean {
  return active?.dirty ?? false;
}
