import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type BrowserAction,
  BrowserActionSchema,
  type BrowserSelector,
  type PreviewBrowserState,
  previewWebUrl,
} from "@orc/core/desktop-preview";
import {
  app,
  type BrowserWindow,
  type Event as ElectronEvent,
  type IpcMainEvent,
  ipcMain,
  type Session,
  session,
  type WebContents,
  WebContentsView,
} from "electron";
import { z } from "zod";
import { PreviewDownloads } from "./preview-downloads.js";
import { PreviewFrames } from "./preview-frames.js";
import { previewObservation } from "./preview-observation.js";
import { PreviewRecording } from "./preview-recording.js";

interface BrowserPage {
  view: WebContentsView;
  contents: WebContents;
  state: PreviewBrowserState;
  allowed: boolean;
  generation: number;
  temporaryPartition: string;
  pendingMutations: number;
  pendingReads: number;
  interrupted: boolean;
  frames: PreviewFrames;
  dialogOpened: (() => void) | null;
  recording?: PreviewRecording | undefined;
  prompt?: IpcMainEvent | undefined;
  downloads: PreviewDownloads;
}

/** Only unprivileged guest pages are reachable here, never the ORC renderer. */
export class PreviewBrowser {
  private static promptInstalled = false;
  private static readonly promptPages = new WeakMap<
    WebContents,
    { page: BrowserPage; changed(): void }
  >();
  private static readonly securedSessions = new WeakSet<Session>();
  private static readonly downloadPages = new WeakMap<
    WebContents,
    { page: BrowserPage; visible(): boolean }
  >();
  private readonly pages = new Map<string, BrowserPage>();
  private readonly activeTabs = new Map<string, string>();
  private readonly temporaryPartitions = new Map<string, string>();
  private selected: string | null = null;
  private agentAccess = true;
  private rectangle: { x: number; y: number; width: number; height: number } | null = null;
  private readonly permissions = new Map<string, boolean>();
  private readonly savedSignatures = new Map<string, string>();
  private readonly restoring = new Set<string>();
  constructor(
    private readonly owner: BrowserWindow,
    private readonly publish: (state: PreviewBrowserState) => void,
    private readonly profile: (sessionId: string) => {
      id: string | null;
      partition: string | null;
    } = () => ({ id: null, partition: null }),
    private readonly workspace?: {
      read(id: string): { selected: string; tabs: { id: string; url: string }[] } | null;
      save(
        id: string,
        value: { selected: string; tabs: { id: string; url: string }[] } | null,
      ): void;
    },
  ) {
    if (!PreviewBrowser.promptInstalled) {
      PreviewBrowser.promptInstalled = true;
      ipcMain.on("orc:preview-prompt", (event, value: unknown) => {
        const own = PreviewBrowser.promptPages.get(event.sender);
        const parsed = z
          .object({ message: z.string().max(4000), default_prompt: z.string().max(2000) })
          .strict()
          .safeParse(value);
        if (
          !own ||
          !parsed.success ||
          own.page.interrupted ||
          own.page.prompt ||
          !event.senderFrame ||
          !event.sender.mainFrame.framesInSubtree.includes(event.senderFrame)
        ) {
          event.returnValue = null;
          return;
        }
        own.page.prompt = event;
        own.page.state.dialog = { type: "prompt", ...parsed.data };
        own.page.dialogOpened?.();
        own.changed();
      });
    }
  }
  private persist(id: string): void {
    if (!this.workspace || this.restoring.has(id)) return;
    const selected = this.activeTabs.get(id);
    const tabs = [...this.pages.values()]
      .filter((page) => page.state.session_id === id)
      .map((page) => ({ id: page.state.tab_id as string, url: page.state.url }));
    const value = selected && tabs.length ? { selected, tabs } : null;
    const signature = JSON.stringify(value);
    if (this.savedSignatures.get(id) === signature) return;
    this.workspace.save(id, value);
    this.savedSignatures.set(id, signature);
  }
  restore(id: string): PreviewBrowserState | null {
    if (this.activeTabs.has(id)) return this.state(this.page(id));
    const saved = this.workspace?.read(id);
    if (!saved) return null;
    if (this.pages.size + saved.tabs.length > 24)
      throw new Error("Close unused browser tabs before restoring this chat (24 total)");
    this.restoring.add(id);
    try {
      for (const tab of saved.tabs) this.open(id, tab.url, true, tab.id);
    } finally {
      this.restoring.delete(id);
    }
    this.activeTabs.set(
      id,
      saved.tabs.some((tab) => tab.id === saved.selected)
        ? saved.selected
        : (saved.tabs[0]?.id as string),
    );
    this.persist(id);
    return this.state(this.page(id));
  }
  private page(id: string, tabId?: string): BrowserPage {
    const page = this.pages.get(tabId ?? this.activeTabs.get(id) ?? "");
    if (!page || page.state.session_id !== id)
      throw new Error(
        "Browser tab is unavailable for this session. List tabs and take a fresh snapshot.",
      );
    return page;
  }
  private state(page: BrowserPage): PreviewBrowserState {
    return {
      ...page.state,
      downloads: page.downloads.list(),
      tabs: [...this.pages.values()]
        .filter((candidate) => candidate.state.session_id === page.state.session_id)
        .map((candidate) => ({
          tab_id: candidate.state.tab_id as string,
          url: candidate.state.url,
          profile_id: candidate.state.profile_id ?? null,
        })),
    };
  }
  open(id: string, value: string, newTab = false, restoredTabId?: string): PreviewBrowserState {
    const url = previewWebUrl(value);
    if (!url) throw new Error("Use an HTTP/HTTPS URL without embedded credentials");
    let tabId = restoredTabId ?? (!newTab ? this.activeTabs.get(id) : undefined);
    let page = tabId ? this.pages.get(tabId) : undefined;
    if (page && (page.interrupted || page.contents.isDestroyed())) {
      this.owner.contentView.removeChildView(page.view);
      this.pages.delete(tabId as string);
      page = undefined;
    }
    if (!page) {
      if (
        this.pages.size >= 24 ||
        [...this.pages.values()].filter((page) => page.state.session_id === id).length >= 8
      )
        throw new Error("Close unused browser tabs before opening more (8 per chat, 24 total)");
      tabId ??= randomUUID();
      const profile = this.profile(id);
      let temporaryPartition = this.temporaryPartitions.get(id);
      if (!temporaryPartition) {
        temporaryPartition = `orc-preview-${randomUUID()}`;
        this.temporaryPartitions.set(id, temporaryPartition);
      }
      const isolated = session.fromPartition(profile.partition ?? temporaryPartition);
      if (!PreviewBrowser.securedSessions.has(isolated)) {
        isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        isolated.setPermissionCheckHandler(() => false);
        isolated.on("will-download", (event, item, contents) => {
          const own = PreviewBrowser.downloadPages.get(contents);
          if (!own || own.page.interrupted || !own.visible()) {
            event.preventDefault();
            return;
          }
          try {
            own.page.downloads.start(item);
          } catch {
            item.cancel();
            own.page.state.error = "Download could not be staged. Check disk space and retry.";
          }
        });
        PreviewBrowser.securedSessions.add(isolated);
      }
      const view = new WebContentsView({
        webPreferences: {
          session: isolated,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
          disableHtmlFullscreenWindowResize: true,
          preload: join(import.meta.dirname, "preview-guest-preload.cjs"),
        },
      });
      view.setVisible(false);
      this.owner.contentView.addChildView(view);
      const state: PreviewBrowserState = {
        session_id: id,
        tab_id: tabId,
        profile_id: profile.id,
        url,
        back: false,
        forward: false,
        loading: false,
        error: null,
      };
      page = {
        view,
        contents: view.webContents,
        state,
        allowed: this.permissions.get(id) ?? false,
        generation: 0,
        temporaryPartition,
        pendingMutations: 0,
        pendingReads: 0,
        interrupted: false,
        frames: new PreviewFrames(view.webContents),
        dialogOpened: null,
        downloads: new PreviewDownloads(app.getPath("userData"), () =>
          this.changed(tabId as string),
        ),
      };
      this.pages.set(tabId, page);
      this.activeTabs.set(id, tabId);
      const ownTab = tabId;
      const changed = () => this.changed(ownTab);
      const ownPage = page;
      PreviewBrowser.downloadPages.set(view.webContents, {
        page,
        visible: () => this.selected === id && view.getVisible(),
      });
      PreviewBrowser.promptPages.set(view.webContents, { page, changed });
      view.webContents.debugger.attach("1.3");
      view.webContents.debugger.on("message", (_event, method, parameters) => {
        if (method === "Page.javascriptDialogOpening") {
          state.dialog = {
            type: String(parameters.type).slice(0, 40),
            message: String(parameters.message).slice(0, 4000),
            default_prompt: String(parameters.defaultPrompt ?? "").slice(0, 2000),
          };
          ownPage.dialogOpened?.();
          changed();
        } else if (method === "Page.javascriptDialogClosed") {
          state.dialog = null;
          changed();
        }
      });
      void view.webContents.debugger.sendCommand("Page.enable").catch(() => {
        state.error = "Browser dialog automation could not start. Reload this tab.";
        changed();
      });
      view.webContents.on("did-navigate", (_event, target) => {
        state.url = target;
        state.error = null;
        changed();
      });
      view.webContents.on("did-navigate-in-page", (_event, target, main) => {
        if (main) state.url = target;
        changed();
      });
      view.webContents.on("did-start-loading", () => {
        state.loading = true;
        changed();
      });
      view.webContents.on("did-stop-loading", () => {
        state.loading = false;
        changed();
      });
      view.webContents.on("did-fail-load", (_event, code, _reason, _url, main) => {
        if (main && code !== -3) {
          state.error = `Page could not load (${code}). Check the address and retry.`;
          changed();
        }
      });
      view.webContents.on("render-process-gone", () => {
        state.loading = false;
        state.error = "Page stopped. Reload to try again.";
        changed();
      });
      view.webContents.on("will-navigate", (event, target) => {
        if (!previewWebUrl(target)) event.preventDefault();
      });
      view.webContents.on("will-redirect", (event, target) => {
        if (!previewWebUrl(target)) event.preventDefault();
      });
      view.webContents.on("will-frame-navigate", (event) => {
        const childDocument =
          !event.isMainFrame &&
          (/^about:(blank|srcdoc)(?:#.*)?$/.test(event.url) ||
            (event.url.startsWith("blob:") && previewWebUrl(event.url.slice(5)) !== null));
        if (!previewWebUrl(event.url) && !childDocument) event.preventDefault();
      });
      view.webContents.setWindowOpenHandler(({ url: target }) => {
        if (previewWebUrl(target)) {
          try {
            this.open(id, target, true);
          } catch {
            state.error = "Close an unused browser tab before opening another";
            changed();
          }
        }
        return { action: "deny" };
      });
    }
    page.state.url = url;
    page.state.error = null;
    if (this.selected === id && this.rectangle) this.bounds(id, this.rectangle);
    void page.contents.loadURL(url).catch(() => {});
    const state = this.state(page);
    this.persist(id);
    this.publish(state);
    return state;
  }
  private changed(id: string): void {
    const page = this.pages.get(id);
    if (!page || this.owner.isDestroyed() || page.contents.isDestroyed()) return;
    page.state.back = page.contents.navigationHistory.canGoBack();
    page.state.forward = page.contents.navigationHistory.canGoForward();
    try {
      this.persist(page.state.session_id);
    } catch {
      page.state.error =
        "Browser tabs could not be saved. Check available disk space; current tabs remain open.";
    }
    if (this.activeTabs.get(page.state.session_id) === id) this.publish(this.state(page));
  }
  bounds(
    id: string | null,
    rect: { x: number; y: number; width: number; height: number } | null,
    restoreUrl?: string,
  ): void {
    if (
      id === null &&
      this.selected &&
      [...this.pages.values()].some(
        (page) => page.state.session_id === this.selected && page.state.dialog,
      )
    ) {
      for (const page of this.pages.values()) page.view.setVisible(false);
      return;
    }
    if (id && rect && !this.activeTabs.has(id) && restoreUrl) this.open(id, restoreUrl);
    if (this.selected !== id) {
      for (const page of this.pages.values())
        if (page.state.session_id === this.selected) this.cancel(page);
    }
    this.selected = id;
    this.rectangle = rect;
    for (const [key, page] of this.pages) {
      if (page.interrupted || page.contents.isDestroyed()) {
        page.view.setVisible(false);
        continue;
      }
      const visible =
        page.state.session_id === id &&
        this.activeTabs.get(id) === key &&
        rect !== null &&
        rect.width > 0 &&
        rect.height > 0;
      if (visible && rect) {
        const [width = 0, height = 0] = this.owner.getContentSize();
        const zoom = this.owner.webContents.getZoomFactor();
        const x = Math.min(width, Math.round(rect.x * zoom)),
          y = Math.min(height, Math.round(rect.y * zoom));
        page.view.setBounds({
          x,
          y,
          width: Math.max(0, Math.min(width - x, Math.round(rect.width * zoom))),
          height: Math.max(0, Math.min(height - y, Math.round(rect.height * zoom))),
        });
      }
      page.view.setVisible(visible);
    }
  }
  navigation(id: string, action: "back" | "forward" | "reload"): void {
    const page = this.page(id);
    if (page.interrupted || page.contents.isDestroyed()) {
      if (action === "reload") {
        this.open(id, page.state.url);
        return;
      }
      throw new Error("Browser page stopped. Reload to restore this tab.");
    }
    const history = page.contents.navigationHistory;
    if (action === "back" && history.canGoBack()) history.goBack();
    else if (action === "forward" && history.canGoForward()) history.goForward();
    else if (action === "reload") page.contents.reload();
  }
  allow(id: string, enabled: boolean): void {
    this.permissions.set(id, enabled);
    for (const page of this.pages.values())
      if (page.state.session_id === id) {
        if (!enabled) this.cancel(page);
        page.allowed = enabled;
      }
  }
  setAgentAccess(enabled: boolean): void {
    if (!enabled) for (const page of this.pages.values()) this.cancel(page);
    this.agentAccess = enabled;
  }
  private cancel(page: BrowserPage): void {
    page.downloads.cancelActive();
    if (page.prompt) {
      page.prompt.returnValue = null;
      page.prompt = undefined;
    }
    page.recording?.cancel();
    page.recording = undefined;
    page.state.recording = false;
    page.state.recording_available = false;
    page.generation++;
    if (page.interrupted || page.contents.isDestroyed()) return;
    if (page.pendingMutations > 0 || page.state.dialog) {
      page.interrupted = true;
      page.state.loading = false;
      page.state.back = false;
      page.state.forward = false;
      page.state.error =
        "Browser action interrupted. Reload to restore this tab; file drafts and profile data are preserved.";
      page.view.setVisible(false);
      page.contents.close({ waitForBeforeUnload: false });
      this.publish(this.state(page));
      return;
    }
    const debuggerClient = page.contents.debugger;
    if (page.pendingReads > 0 && debuggerClient.isAttached())
      void debuggerClient.sendCommand("Runtime.terminateExecution").catch(() => {});
  }
  private async bounded<T>(
    work: Promise<T>,
    assertAllowed: () => void,
    timeout: number,
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setInterval(() => {
            try {
              assertAllowed();
              if (Date.now() >= deadline)
                throw new Error("Browser action timed out; inspect before retrying");
            } catch (cause) {
              reject(cause);
            }
          }, 25);
        }),
      ]);
    } finally {
      clearInterval(timer);
    }
  }
  tab(
    id: string,
    command: { action: "tab_select" | "tab_close"; tab_id: string },
  ): PreviewBrowserState | null {
    const page = this.page(id, command.tab_id);
    for (const candidate of this.pages.values())
      if (candidate.state.session_id === id) this.cancel(candidate);
    if (command.action === "tab_close") {
      page.downloads.dispose();
      this.owner.contentView.removeChildView(page.view);
      if (!page.contents.isDestroyed()) page.contents.close();
      this.pages.delete(command.tab_id);
      if (this.activeTabs.get(id) === command.tab_id) {
        const next = [...this.pages].find(([, candidate]) => candidate.state.session_id === id);
        if (next) this.activeTabs.set(id, next[0]);
        else this.activeTabs.delete(id);
      }
    } else this.activeTabs.set(id, command.tab_id);
    if (this.selected === id) this.bounds(id, this.rectangle);
    const active = this.activeTabs.get(id);
    const next = active ? this.pages.get(active) : undefined;
    this.persist(id);
    if (!next) return null;
    const state = this.state(next);
    this.publish(state);
    return state;
  }
  closeSession(id: string): void {
    for (const [tabId, page] of this.pages)
      if (page.state.session_id === id) {
        page.downloads.dispose();
        this.cancel(page);
        this.owner.contentView.removeChildView(page.view);
        if (!page.contents.isDestroyed()) page.contents.close();
        this.pages.delete(tabId);
      }
    this.activeTabs.delete(id);
    this.temporaryPartitions.delete(id);
    this.workspace?.save(id, null);
    this.savedSignatures.delete(id);
  }
  closeProfile(profileId: string): void {
    const sessions = [
      ...new Set(
        [...this.pages.values()]
          .filter((page) => page.state.profile_id === profileId)
          .map((page) => page.state.session_id),
      ),
    ];
    for (const id of sessions) this.closeSession(id);
  }
  async respondToDialog(id: string, accept: boolean, text?: string, tabId?: string): Promise<void> {
    const page = this.page(id, tabId);
    if (!page.state.dialog || page.interrupted || page.contents.isDestroyed())
      throw new Error("No page dialog is pending");
    if (page.prompt) {
      const event = page.prompt;
      page.prompt = undefined;
      event.returnValue = accept ? (text ?? page.state.dialog.default_prompt) : null;
      page.state.dialog = null;
      this.publish(this.state(page));
      return;
    }
    await page.contents.debugger.sendCommand("Page.handleJavaScriptDialog", {
      accept,
      ...(text === undefined ? {} : { promptText: text }),
    });
  }
  async userControl(id: string, input: BrowserAction): Promise<unknown> {
    const command = BrowserActionSchema.parse(input);
    if (
      ![
        "appearance",
        "resize",
        "resize_reset",
        "recording_start",
        "recording_stop",
        "download",
      ].includes(command.action)
    )
      throw new Error("Unsupported browser display action");
    const page = this.page(id);
    if (this.selected !== id || !page.view.getVisible() || page.contents.isDestroyed())
      throw new Error("Open this browser tab before changing its display");
    return this.perform(id, command, page);
  }
  async upload(
    id: string,
    selector: BrowserSelector,
    files: { name: string; data: string }[],
    tabId?: string,
  ): Promise<unknown> {
    const page = this.page(id, tabId),
      generation = page.generation;
    const assertAllowed = () => {
      if (
        !this.agentAccess ||
        !page.allowed ||
        this.selected !== id ||
        !page.view.getVisible() ||
        page.generation !== generation ||
        page.contents.isDestroyed()
      )
        throw new Error("Browser upload permission or selected session changed");
    };
    assertAllowed();
    if (files.reduce((total, file) => total + file.data.length, 0) > 22_369_624)
      throw new Error("Browser uploads must total at most 16 MiB");
    for (const file of files)
      if (
        !/^[a-z0-9+/]*={0,2}$/i.test(file.data) ||
        /[\\/]/.test(file.name) ||
        [...file.name].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error("Invalid upload file");
    page.pendingMutations++;
    try {
      const result = await this.bounded(
        page.frames.run(pageAction, { action: "upload", selector, files }),
        assertAllowed,
        10000,
      );
      assertAllowed();
      return result;
    } catch (cause) {
      if (cause instanceof Error && /timed out/.test(cause.message)) this.cancel(page);
      throw cause;
    } finally {
      page.pendingMutations--;
    }
  }
  async control(id: string, input: BrowserAction, tabId?: string): Promise<unknown> {
    const command = BrowserActionSchema.parse(input);
    const page = this.page(id, tabId);
    if (page.interrupted || page.contents.isDestroyed() || page.contents.isCrashed())
      throw new Error("Browser action interrupted. Reload to restore this tab.");
    if (
      !this.agentAccess ||
      !page.allowed ||
      this.selected !== id ||
      (!page.view.getVisible() && command.action !== "dialog")
    )
      throw new Error("Agent browser control is disabled or this session is not visible");
    const mutates = [
      "click",
      "type",
      "select",
      "scroll",
      "hover",
      "drag",
      "press",
      "evaluate",
      "dialog",
      "appearance",
      "resize",
      "resize_reset",
      "recording_start",
      "recording_stop",
    ].includes(command.action);
    const reads = ["snapshot", "wait", "frames", "screenshot"].includes(command.action);
    if (mutates) page.pendingMutations++;
    if (reads) page.pendingReads++;
    try {
      const work = this.perform(id, command, page);
      if (mutates && command.action !== "dialog")
        return await Promise.race([
          work,
          new Promise((resolve) => {
            page.dialogOpened = () =>
              resolve({ ok: true, dialog: page.state.dialog, requires_response: true });
          }),
        ]);
      return await work;
    } catch (cause) {
      if (mutates && cause instanceof Error && /timed out/.test(cause.message)) this.cancel(page);
      throw cause;
    } finally {
      if (mutates) page.pendingMutations--;
      if (reads) page.pendingReads--;
      page.dialogOpened = null;
    }
  }
  private async perform(id: string, command: BrowserAction, page: BrowserPage): Promise<unknown> {
    if (command.action === "resize_reset") {
      await page.contents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      return { ok: true, viewport: "panel" };
    }
    if (command.action === "download") return page.downloads.read(command.download_id);
    if (command.action === "recording_start") {
      if (page.recording) throw new Error("Stop the current recording before starting another");
      const recording = new PreviewRecording();
      const generation = page.generation;
      page.recording = recording;
      try {
        await recording.start(page.contents, command.max_seconds, () => {
          page.state.recording = false;
          this.publish(this.state(page));
        });
        if (page.generation !== generation || page.contents.isDestroyed())
          throw new Error("Recording was interrupted");
      } catch (cause) {
        recording.cancel();
        page.recording = undefined;
        throw cause;
      }
      page.state.recording = recording.running;
      page.state.recording_available = true;
      this.publish(this.state(page));
      return { recording: true, max_seconds: command.max_seconds };
    }
    if (command.action === "recording_stop") {
      if (!page.recording) throw new Error("No browser recording is available");
      const recording = page.recording;
      const generation = page.generation;
      try {
        const result = await recording.stop();
        if (page.generation !== generation || page.contents.isDestroyed())
          throw new Error("Recording was interrupted");
        return result;
      } finally {
        if (page.recording === recording) page.recording = undefined;
        page.state.recording = false;
        page.state.recording_available = false;
        this.publish(this.state(page));
      }
    }
    if (command.action === "dialog") {
      if (command.response === "status") return { dialog: page.state.dialog ?? null };
      if (!page.state.dialog) throw new Error("No JavaScript dialog is pending in this tab");
      await this.respondToDialog(
        id,
        command.response === "accept",
        command.text,
        page.state.tab_id,
      );
      return { ok: true };
    }
    if (command.action === "appearance") {
      await page.contents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [
          {
            name: "prefers-color-scheme",
            value: command.color_scheme === "system" ? "" : command.color_scheme,
          },
          ...(command.reduced_motion === undefined
            ? []
            : [
                {
                  name: "prefers-reduced-motion",
                  value: command.reduced_motion ? "reduce" : "no-preference",
                },
              ]),
        ],
      });
      page.state.color_scheme = command.color_scheme;
      this.publish(this.state(page));
      return { ok: true, color_scheme: command.color_scheme };
    }
    if (command.action === "resize") {
      if (command.width * command.height * command.device_scale_factor ** 2 > 16_777_216)
        throw new Error("Emulated viewport must be at most 16 megapixels");
      await page.contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: command.width,
        height: command.height,
        deviceScaleFactor: command.device_scale_factor,
        mobile: command.mobile,
      });
      return { width: command.width, height: command.height, mobile: command.mobile };
    }
    if (command.action === "tabs") return this.state(page);
    if (command.action === "tab_select" || command.action === "tab_close")
      return this.tab(id, command);
    if (command.action === "new_tab") return this.open(id, command.url, true);
    if (command.action === "navigate") return this.open(id, command.url);
    if (command.action === "back" || command.action === "forward" || command.action === "reload") {
      this.navigation(id, command.action);
      return this.state(page);
    }
    const contents = page.contents;
    const generation = page.generation;
    const assertAllowed = () => {
      if (
        !this.agentAccess ||
        !page.allowed ||
        this.selected !== id ||
        !page.view.getVisible() ||
        page.generation !== generation ||
        contents.isDestroyed()
      )
        throw new Error("Browser control permission or selected session changed");
    };
    const until = Date.now() + 10000;
    while (contents.isLoadingMainFrame() && Date.now() < until) {
      if (!this.agentAccess || !page.allowed || this.selected !== id || !page.view.getVisible())
        throw new Error("Browser control permission or selected session changed");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!this.agentAccess || !page.allowed || this.selected !== id || !page.view.getVisible())
      throw new Error("Browser control permission or selected session changed");
    if (contents.isLoadingMainFrame() || !previewWebUrl(contents.getURL()))
      throw new Error("Page is not ready. Inspect its status before retrying.");
    assertAllowed();
    if (command.action === "frames")
      return this.bounded(
        previewObservation(async () => ({ frames: page.frames.list() }), assertAllowed),
        assertAllowed,
        10000,
      );
    if (command.action === "frame") {
      page.frames.select(command.frame_id);
      return { frame_id: command.frame_id };
    }
    if (command.action === "evaluate") {
      const value = await this.bounded(
        page.frames.evaluate(command.expression),
        assertAllowed,
        command.timeout_ms,
      );
      assertAllowed();
      return { value };
    }
    if (command.action === "snapshot")
      return this.bounded(
        previewObservation(() => page.frames.snapshot(pageAction, command), assertAllowed),
        assertAllowed,
        10000,
      );
    if (command.action === "wait") {
      const deadline = Date.now() + command.timeout_ms;
      while (true) {
        assertAllowed();
        const matched = await this.bounded(
          page.frames.run(pageAction, command),
          assertAllowed,
          Math.max(1, deadline - Date.now()),
        );
        assertAllowed();
        if (matched) return { ok: true, state: command.state };
        if (Date.now() >= deadline) throw new Error("Browser wait timed out");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (command.action === "click" || command.action === "hover" || command.action === "drag") {
      const point = async (
        selector: BrowserSelector,
        scroll = true,
      ): Promise<{ x: number; y: number }> => {
        const value = await this.bounded(
          page.frames.run(pageAction, { action: "point", selector, scroll }),
          assertAllowed,
          10000,
        );
        assertAllowed();
        return value as { x: number; y: number };
      };
      const start = await point(command.selector);
      await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...start,
      });
      if (command.action === "hover") return { ok: true };
      if (command.action === "click") {
        assertAllowed();
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          ...start,
        });
        assertAllowed();
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount: 1,
          ...start,
        });
        return { ok: true };
      }
      const target = await point(command.target, false);
      assertAllowed();
      const dragSchema = z.object({
        items: z
          .array(
            z.object({
              mimeType: z.string().max(255),
              data: z.string().max(64000),
              title: z.string().max(1000).optional(),
              baseURL: z.string().max(8192).optional(),
            }),
          )
          .max(20),
        dragOperationsMask: z.number().int(),
        files: z.array(z.string()).max(0).optional(),
      });
      let dragData: z.infer<typeof dragSchema> | null = null;
      const intercepted = (
        _event: ElectronEvent,
        method: string,
        parameters: Record<string, unknown>,
      ) => {
        if (method === "Input.dragIntercepted") {
          const data = dragSchema.safeParse(parameters.data);
          if (data.success) dragData = data.data;
        }
      };
      contents.debugger.on("message", intercepted);
      try {
        await contents.debugger.sendCommand("Input.setInterceptDrags", { enabled: true });
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          buttons: 1,
          clickCount: 1,
          ...start,
        });
        for (let step = 1; step <= 12; step++) {
          assertAllowed();
          await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            button: "left",
            buttons: 1,
            x: Math.round(start.x + ((target.x - start.x) * step) / 12),
            y: Math.round(start.y + ((target.y - start.y) * step) / 12),
          });
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
        if (dragData)
          for (const type of ["dragEnter", "dragOver", "drop"]) {
            assertAllowed();
            await contents.debugger.sendCommand("Input.dispatchDragEvent", {
              type,
              ...target,
              data: dragData,
            });
          }
      } finally {
        contents.debugger.removeListener("message", intercepted);
        if (!contents.isDestroyed()) {
          await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
            buttons: 0,
            clickCount: 1,
            ...target,
          });
          await contents.debugger.sendCommand("Input.setInterceptDrags", { enabled: false });
        }
      }
      assertAllowed();
      return { ok: true };
    }
    if (command.action === "screenshot") {
      const capture = await this.bounded(contents.capturePage(), assertAllowed, 10000);
      assertAllowed();
      const size = capture.getSize();
      const image = size.width > 1280 ? capture.resize({ width: 1280 }) : capture;
      const data = image.toJPEG(60).toString("base64");
      if (data.length > 1_100_000) throw new Error("Screenshot exceeds the tool result limit");
      return { type: "image", mimeType: "image/jpeg", data };
    }
    if (command.action === "press") {
      const key = command.key === "Space" ? " " : command.key;
      if (
        command.modifiers?.some((value) => value === "Control" || value === "Meta") &&
        /^[cvx]$/i.test(key)
      )
        throw new Error("Clipboard shortcuts are not available to browser agents");
      const modifiers = command.modifiers?.map(
        (value) =>
          (({ Control: "control", Alt: "alt", Meta: "meta", Shift: "shift" }) as const)[value],
      );
      contents.sendInputEvent({
        type: "keyDown",
        keyCode: key,
        ...(modifiers ? { modifiers } : {}),
      });
      if (key.length === 1 && !command.modifiers?.length)
        contents.sendInputEvent({ type: "char", keyCode: key });
      contents.sendInputEvent({ type: "keyUp", keyCode: key, ...(modifiers ? { modifiers } : {}) });
      return { ok: true };
    }
    if (command.action === "type") {
      await this.bounded(
        page.frames.run(pageAction, { ...command, action: "prepare_type" }),
        assertAllowed,
        10000,
      );
      assertAllowed();
      contents.selectAll();
      await contents.debugger.sendCommand("Input.insertText", { text: command.text });
      assertAllowed();
      return { ok: true };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        page.frames.run(pageAction, command),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Browser action timed out; inspect before retrying")),
            10_000,
          );
        }),
      ]);
      assertAllowed();
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
  dispose(): void {
    for (const page of this.pages.values()) {
      page.downloads.dispose();
      if (page.prompt) {
        page.prompt.returnValue = null;
        page.prompt = undefined;
      }
      page.recording?.cancel();
      if (!this.owner.isDestroyed()) this.owner.contentView.removeChildView(page.view);
      if (!page.contents.isDestroyed()) page.contents.close();
    }
    this.pages.clear();
    this.activeTabs.clear();
    this.temporaryPartitions.clear();
    this.permissions.clear();
    this.selected = null;
    this.rectangle = null;
  }
}

/** Fixed browser script; command text/selector are JSON data, never script fragments. */
const pageAction = `function(command) {
  const name=element=>{const labelled=(element.getAttribute('aria-labelledby')??'').split(/\\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent??'').join(' ');return (element.getAttribute('aria-label')??(labelled||[...(element.labels??[])].map(label=>label.innerText).join(' ')||element.getAttribute('alt')||element.getAttribute('placeholder')||(['button','submit','reset'].includes(element.type)?element.value:'')||element.innerText||'')).trim();};
  const role=element=>element.getAttribute('role')??(element.isContentEditable?'textbox':({BUTTON:'button',SUMMARY:'button',A:element.hasAttribute('href')?'link':null,SELECT:element.multiple||element.size>1?'listbox':'combobox',TEXTAREA:'textbox',INPUT:['checkbox','radio'].includes(element.type)?element.type:['button','submit','reset'].includes(element.type)?'button':({number:'spinbutton',range:'slider',search:'searchbox',hidden:null}[element.type]??'textbox'),IMG:'img',H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading'}[element.tagName]??null));
  const find=selector=>{
    if(typeof selector==='object') {
      if(selector.by==='css')return [...document.querySelectorAll(selector.value)];
      const matches=(actual,expected)=>selector.exact===false?actual.toLowerCase().includes(expected.toLowerCase()):actual===expected;
      const elements=[...document.querySelectorAll('*')];
      return elements.filter(element=>selector.by==='role'?role(element)===selector.value&&(selector.name===undefined||matches(name(element),selector.name)):selector.by==='label'?matches(name(element),selector.value)&&element.matches('input,select,textarea,[contenteditable]'):selector.by==='placeholder'?matches(element.getAttribute('placeholder')??'',selector.value):selector.by==='testid'?element.getAttribute('data-testid')===selector.value:matches((element.textContent??'').trim(),selector.value)&&![...element.children].some(child=>matches((child.textContent??'').trim(),selector.value)));
    }
    if(!selector.startsWith("@"))return [...document.querySelectorAll(selector)];
    const element=globalThis.__orcPreviewRefs?.get(selector);
    if(!element||!element.isConnected)throw new Error("Stale browser ref. Take a fresh snapshot; nothing was executed.");
    return [element];
  };
  if(command.action==="wait") {
    if(command.text && !(document.body?.innerText??"").includes(command.text))return false;
    if(command.url_includes && !location.href.includes(command.url_includes))return false;
    if(!command.selector)return true;
    const matches=find(command.selector);
    const visible=[...matches].some(element=>element.getClientRects().length && getComputedStyle(element).visibility!=="hidden");
    return command.state==="attached" ? matches.length>0 : command.state==="detached" ? matches.length===0 : command.state==="visible" ? visible : !visible;
  }
  if(command.action==="snapshot") {
    const roots=command.selector?find(command.selector):[document.body];
    if(roots.length!==1||!roots[0])throw new Error("Snapshot scope must match exactly one element");
    const root=roots[0],limit=command.max_chars??12000;
    const elements=[...root.querySelectorAll("a,button,input,textarea,select,summary,[role=button],[role=checkbox],[role=combobox],[contenteditable]:not([contenteditable=false])")].filter(element=>element.getClientRects().length&&getComputedStyle(element).visibility!=="hidden").slice(0,80);
    const refs=globalThis.__orcPreviewRefs??new Map();
    const ids=globalThis.__orcPreviewIds??new WeakMap();
    let sequence=globalThis.__orcPreviewSequence??0;
    const prefix=globalThis.__orcPreviewPrefix??[...crypto.getRandomValues(new Uint8Array(8))].map(value=>value.toString(16).padStart(2,"0")).join("");
    const items=elements.map(element=>{let ref=ids.get(element);if(!ref){ref="@"+prefix+":"+(++sequence);ids.set(element,ref);}refs.set(ref,element);return {ref,tag:element.tagName.toLowerCase(),role:role(element),name:name(element).slice(0,120),type:element.getAttribute("type"),disabled:element.matches(":disabled,[aria-disabled=true]")};});
    for(const [ref,element] of refs)if(!element.isConnected)refs.delete(ref);
    if(refs.size>1000){refs.clear();for(let index=0;index<items.length;index++)refs.set(items[index].ref,elements[index]);}
    globalThis.__orcPreviewRefs=refs;globalThis.__orcPreviewIds=ids;globalThis.__orcPreviewSequence=sequence;globalThis.__orcPreviewPrefix=prefix;
    const text=root.innerText??"";
    const result={untrusted:true,url:location.href.slice(0,Math.min(1000,Math.floor(limit/4))),title:document.title.slice(0,100),text:text.slice(0,Math.floor(limit/2)),elements:items,truncated:text.length>Math.floor(limit/2)};
    while(JSON.stringify(result).length>limit&&result.elements.length){result.elements.pop();result.truncated=true;}
    return result;
  }
  if(command.action==="scroll"){const matches=command.selector?find(command.selector):[window];if(matches.length!==1)throw new Error("Scroll target must match exactly one element");matches[0].scrollBy(command.x,command.y);return {ok:true};}
  if(!["click","type","prepare_type","select","point","upload"].includes(command.action))throw new Error("Unsupported page action");
  const matches=find(command.selector);
  if(matches.length!==1)throw new Error("Selector must match exactly one element. Take a fresh snapshot.");
  const element=matches[0];
  if(!element||!element.getClientRects().length||element.matches(":disabled,[aria-disabled=true]"))throw new Error("Element is hidden or disabled");
  if(command.scroll!==false)element.scrollIntoView({block:"center"});if(command.action!=="point")element.focus();
  const rect=element.getBoundingClientRect();const x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
  const hit=document.elementFromPoint(x,y);
  if(getComputedStyle(element).visibility==="hidden" || !hit || (hit!==element && !element.contains(hit)))throw new Error("Element is hidden or covered");
  if(command.action==="point")return {x,y};
  if(command.action==="upload") {
    if(!(element instanceof HTMLInputElement)||element.type!=="file")throw new Error("Upload requires a file input");
    if(!element.multiple&&command.files.length!==1)throw new Error("This input accepts one file");
    const transfer=new DataTransfer();for(const file of command.files)transfer.items.add(new File([Uint8Array.from(atob(file.data),character=>character.charCodeAt(0))],file.name,{type:'application/octet-stream'}));
    element.files=transfer.files;element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,files:command.files.map(file=>file.name)};
  }
  if(command.action==="prepare_type") {
    if(!element.isContentEditable && !(element instanceof HTMLInputElement)&&!(element instanceof HTMLTextAreaElement))throw new Error("Type requires an editable element");
    if(element.readOnly||element instanceof HTMLInputElement&&["file","hidden","checkbox","radio","submit","button","range","color","date","datetime-local","month","week","time"].includes(element.type))throw new Error("This input is not editable text");
    return {ok:true};
  }
  if(command.action==="select") {
    if(!(element instanceof HTMLSelectElement))throw new Error("Select requires a select element");
    if(!element.multiple && command.values.length>1)throw new Error("Select accepts one value for this element");
    const options=[...element.options];
    if(command.values.some(value=>!options.some(option=>option.value===value&&!option.disabled&&!option.closest('optgroup[disabled]'))))throw new Error("Option is missing or disabled");
    for(const option of options)option.selected=command.values.includes(option.value);if(command.values.length===0)element.selectedIndex=-1;
    element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));return {ok:true,values:[...element.selectedOptions].map(option=>option.value)};
  }
  if(command.action==="click"){element.click();return {ok:true};}
  if(!(element instanceof HTMLInputElement)&&!(element instanceof HTMLTextAreaElement))throw new Error("Type requires a text input or textarea");
  if(element.readOnly)throw new Error("Input is read-only");
  if(element instanceof HTMLInputElement && ["file","hidden","checkbox","radio","submit","button"].includes(element.type))throw new Error("This input type is not supported");
  const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype,"value")?.set?.call(element,command.text);
  element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));
  return {ok:true};
}`;
