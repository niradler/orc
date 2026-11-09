import { join } from "node:path";
import {
  BrowserActionSchema,
  BrowserSelectorSchema,
  PREVIEW_COMMAND,
  PREVIEW_EVENT,
  PREVIEW_OPEN_EVENT,
  PREVIEW_PROFILES_EVENT,
  PREVIEW_SETTINGS_EVENT,
  PreviewBoundsSchema,
  PreviewPreferencesSchema,
  previewWebUrl,
} from "@orc/core/desktop-preview";
import { app, type BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { z } from "zod";
import { PreviewBrowser } from "./preview-browser.js";
import { PreviewLocalFiles } from "./preview-files.js";
import { PreviewImport } from "./preview-import.js";
import { PreviewChatPreferencesStore, PreviewPreferencesStore } from "./preview-preferences.js";
import { PreviewProfiles } from "./preview-profiles.js";
import { PreviewStoreImport } from "./preview-store-import.js";

const sessionId = z.string().min(1).max(200);
const commandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("upload"),
      session_id: sessionId,
      tab_id: z.string().uuid().optional(),
      selector: BrowserSelectorSchema,
      files: z
        .array(
          z.object({ name: z.string().min(1).max(255), data: z.string().max(11_184_812) }).strict(),
        )
        .min(1)
        .max(10),
    })
    .strict(),
  z.object({ action: z.literal("import_stores") }).strict(),
  z.object({ action: z.literal("import_store_discover"), source_id: z.string().uuid() }).strict(),
  z
    .object({ action: z.literal("display"), session_id: sessionId, command: BrowserActionSchema })
    .strict(),
  z.object({ action: z.literal("import_cancel") }).strict(),
  z
    .object({ action: z.literal("import_discover"), port: z.number().int().min(1024).max(65535) })
    .strict(),
  z
    .object({
      action: z.literal("import_transfer"),
      source_id: z.string().uuid(),
      profile_id: z.string().uuid(),
      sites: z.array(z.string().url().max(8192)).min(1).max(50),
    })
    .strict(),
  z.object({ action: z.literal("profiles") }).strict(),
  z.object({ action: z.literal("restore"), session_id: sessionId }).strict(),
  z
    .object({
      action: z.literal("page_dialog"),
      session_id: sessionId,
      accept: z.boolean(),
      text: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("profile_rename"),
      profile_id: z.string().uuid(),
      name: z.string().trim().min(1).max(80),
    })
    .strict(),
  z.object({ action: z.literal("profile_remove"), profile_id: z.string().uuid() }).strict(),
  z
    .object({ action: z.literal("profile_create"), name: z.string().trim().min(1).max(80) })
    .strict(),
  z
    .object({
      action: z.literal("profile_select"),
      session_id: sessionId,
      profile_id: z.string().uuid().nullable().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("tab"),
      session_id: sessionId,
      command: z
        .object({ action: z.enum(["tab_select", "tab_close"]), tab_id: z.string().uuid() })
        .strict(),
    })
    .strict(),
  z.object({ action: z.literal("dirty"), value: z.boolean() }).strict(),
  z.object({ action: z.literal("preferences") }).strict(),
  z
    .object({ action: z.literal("set_preferences"), preferences: PreviewPreferencesSchema })
    .strict(),
  z
    .object({
      action: z.literal("open"),
      session_id: sessionId,
      url: z.string().max(8192),
      new_tab: z.boolean().optional(),
    })
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
    .object({
      action: z.literal("chat_permission"),
      session_id: sessionId,
      enabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("control"),
      session_id: sessionId,
      command: BrowserActionSchema,
      tab_id: z.string().uuid().optional(),
    })
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
  chatPreferences: PreviewChatPreferencesStore;
  profiles: PreviewProfiles;
  importer: PreviewImport;
  storeImporter: PreviewStoreImport;
  imports: Promise<void>;
  removingProfiles: Set<string>;
  dirty: boolean;
} | null = null;
let installed = false;

export function attachDesktopPreview(window: BrowserWindow, origin: string): void {
  const profiles = new PreviewProfiles(
    join(app.getPath("userData"), "browser-profiles.json"),
    origin,
  );
  const browser = new PreviewBrowser(
    window,
    (state) => {
      if (!window.isDestroyed()) window.webContents.send(PREVIEW_EVENT, state);
    },
    (id) => {
      const profileId = profiles.selected(id);
      return { id: profileId, partition: profileId ? profiles.partition(profileId) : null };
    },
    {
      read: (id) => profiles.workspace(id),
      save: (id, value) => profiles.saveWorkspace(id, value),
    },
  );
  const files = new PreviewLocalFiles(window);
  const preferences = new PreviewPreferencesStore(
    join(app.getPath("userData"), "browser-preferences.json"),
  );
  const chatPreferences = new PreviewChatPreferencesStore(
    join(app.getPath("userData"), "browser-chat-permissions.json"),
  );
  active = {
    window,
    origin,
    browser,
    files,
    preferences,
    chatPreferences,
    profiles,
    importer: new PreviewImport(origin),
    storeImporter: new PreviewStoreImport(),
    imports: Promise.resolve(),
    removingProfiles: new Set(),
    dirty: false,
  };
  // A damaged preference file must not enable control silently.
  try {
    browser.setAgentAccess(preferences.get().agentBrowserControl);
  } catch {
    browser.setAgentAccess(false);
  }
  window.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      active?.importer.cancel();
      active?.storeImporter.cancel();
      browser.dispose();
      files.clear();
      if (active?.window === window) active.dirty = false;
    }
  });
  window.on("closed", () => {
    active?.importer.cancel();
    active?.storeImporter.cancel();
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
      case "upload":
        return host.browser.upload(input.session_id, input.selector, input.files, input.tab_id);
      case "import_stores":
        return host.storeImporter.list();
      case "import_store_discover":
        host.importer.cancel();
        return host.storeImporter.discover(input.source_id);
      case "display":
        return host.browser.userControl(input.session_id, input.command);
      case "import_cancel":
        host.importer.cancel();
        host.storeImporter.cancel();
        return;
      case "import_discover":
        host.storeImporter.cancel();
        return host.importer.discover(input.port);
      case "import_transfer": {
        const profile = host.profiles.list().find((profile) => profile.id === input.profile_id);
        const hosts = [...new Set(input.sites.map((site) => new URL(site).hostname))];
        const confirm = await dialog.showMessageBox(host.window, {
          type: "question",
          buttons: ["Cancel", "Import logins"],
          defaultId: 0,
          cancelId: 0,
          message: `Import logins into ${profile?.name ?? "browser profile"}?`,
          detail: `Cookies and site data for ${hosts.slice(0, 8).join(", ")}${hosts.length > 8 ? ` and ${hosts.length - 8} more` : ""} will be copied from your browser.`,
        });
        if (confirm.response !== 1) throw new Error("Import cancelled");
        const work = host.imports.then(() => {
          if (host.removingProfiles.has(input.profile_id))
            throw new Error("This browser profile is being removed");
          const target = session.fromPartition(host.profiles.partition(input.profile_id));
          return host.storeImporter.has(input.source_id)
            ? host.storeImporter.transfer(input.source_id, input.sites, target)
            : host.importer.transfer(input.source_id, input.sites, target);
        });
        host.imports = work.then(
          () => {},
          () => {},
        );
        return work;
      }
      case "profiles":
        return host.profiles.list();
      case "restore":
        return host.browser.restore(input.session_id);
      case "page_dialog":
        return host.browser.respondToDialog(input.session_id, input.accept, input.text);
      case "profile_rename": {
        const profile = host.profiles.rename(input.profile_id, input.name);
        host.window.webContents.send(PREVIEW_PROFILES_EVENT, host.profiles.list());
        return profile;
      }
      case "profile_remove": {
        const partition = host.profiles.partition(input.profile_id);
        const profile = host.profiles.list().find((profile) => profile.id === input.profile_id);
        const result = await dialog.showMessageBox(host.window, {
          type: "warning",
          buttons: ["Cancel", "Remove profile"],
          defaultId: 0,
          cancelId: 0,
          message: `Remove ${profile?.name ?? "browser profile"}?`,
          detail:
            "This signs out its sites and closes browser tabs using this profile. File drafts are preserved.",
        });
        if (result.response !== 1) return false;
        if (host.removingProfiles.has(input.profile_id))
          throw new Error("Profile removal is already in progress");
        host.removingProfiles.add(input.profile_id);
        host.importer.cancel();
        host.storeImporter.cancel();
        await host.imports;
        try {
          host.browser.closeProfile(input.profile_id);
          const isolated = session.fromPartition(partition);
          await isolated.clearStorageData();
          await isolated.clearCache();
          isolated.flushStorageData();
          host.profiles.remove(input.profile_id);
          host.window.webContents.send(PREVIEW_PROFILES_EVENT, host.profiles.list());
          return true;
        } finally {
          host.removingProfiles.delete(input.profile_id);
        }
      }
      case "profile_create": {
        const profile = host.profiles.create(input.name);
        host.window.webContents.send(PREVIEW_PROFILES_EVENT, host.profiles.list());
        return profile;
      }
      case "profile_select": {
        if (input.profile_id !== undefined) {
          host.profiles.select(input.session_id, input.profile_id);
          host.browser.closeSession(input.session_id);
        }
        return host.profiles.selected(input.session_id);
      }
      case "tab":
        return host.browser.tab(input.session_id, input.command);
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
        return host.browser.open(input.session_id, input.url, input.new_tab);
      case "navigation":
        return host.browser.navigation(input.session_id, input.direction);
      case "bounds":
        return host.browser.bounds(input.session_id, input.bounds, input.restore_url);
      case "allow":
        return host.browser.allow(
          input.session_id,
          input.enabled && host.chatPreferences.get(host.origin, input.session_id),
        );
      case "chat_permission": {
        if (input.enabled === undefined)
          return host.chatPreferences.get(host.origin, input.session_id);
        host.browser.allow(input.session_id, false);
        return host.chatPreferences.set(host.origin, input.session_id, input.enabled);
      }
      case "control":
        return host.browser.control(input.session_id, input.command, input.tab_id);
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
  if (
    !host ||
    host.window.isDestroyed() ||
    (target && host.preferences.snapshot().openLinksIn === "system")
  ) {
    const url = target && previewWebUrl(target);
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
