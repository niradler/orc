import { randomUUID } from "node:crypto";
import {
  type BrowserAction,
  BrowserActionSchema,
  type PreviewBrowserState,
  previewWebUrl,
} from "@orc/core/desktop-preview";
import {
  type BrowserWindow,
  type Session,
  session,
  type WebContents,
  WebContentsView,
} from "electron";

interface BrowserPage {
  view: WebContentsView;
  contents: WebContents;
  state: PreviewBrowserState;
  allowed: boolean;
  generation: number;
  temporaryPartition: string;
  pendingMutations: number;
  interrupted: boolean;
}

/** Only unprivileged guest pages are reachable here, never the ORC renderer. */
export class PreviewBrowser {
  private static readonly securedSessions = new WeakSet<Session>();
  private readonly pages = new Map<string, BrowserPage>();
  private readonly activeTabs = new Map<string, string>();
  private readonly temporaryPartitions = new Map<string, string>();
  private selected: string | null = null;
  private agentAccess = true;
  private rectangle: { x: number; y: number; width: number; height: number } | null = null;
  private readonly permissions = new Map<string, boolean>();
  constructor(
    private readonly owner: BrowserWindow,
    private readonly publish: (state: PreviewBrowserState) => void,
    private readonly profile: (sessionId: string) => {
      id: string | null;
      partition: string | null;
    } = () => ({ id: null, partition: null }),
  ) {}
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
      tabs: [...this.pages.values()]
        .filter((candidate) => candidate.state.session_id === page.state.session_id)
        .map((candidate) => ({
          tab_id: candidate.state.tab_id as string,
          url: candidate.state.url,
          profile_id: candidate.state.profile_id ?? null,
        })),
    };
  }
  open(id: string, value: string, newTab = false): PreviewBrowserState {
    const url = previewWebUrl(value);
    if (!url) throw new Error("Use an HTTP/HTTPS URL without embedded credentials");
    let tabId = !newTab ? this.activeTabs.get(id) : undefined;
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
        isolated.on("will-download", (event) => event.preventDefault());
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
        interrupted: false,
      };
      this.pages.set(tabId, page);
      this.activeTabs.set(id, tabId);
      const ownTab = tabId;
      const changed = () => this.changed(ownTab);
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
        if (!previewWebUrl(event.url)) event.preventDefault();
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
    this.publish(state);
    return state;
  }
  private changed(id: string): void {
    const page = this.pages.get(id);
    if (!page || this.owner.isDestroyed() || page.contents.isDestroyed()) return;
    page.state.back = page.contents.navigationHistory.canGoBack();
    page.state.forward = page.contents.navigationHistory.canGoForward();
    if (this.activeTabs.get(page.state.session_id) === id) this.publish(this.state(page));
  }
  bounds(
    id: string | null,
    rect: { x: number; y: number; width: number; height: number } | null,
    restoreUrl?: string,
  ): void {
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
    page.generation++;
    if (page.interrupted || page.contents.isDestroyed()) return;
    if (page.pendingMutations > 0) {
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
    if (debuggerClient.isAttached())
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
    if (!next) return null;
    const state = this.state(next);
    this.publish(state);
    return state;
  }
  closeSession(id: string): void {
    for (const [tabId, page] of this.pages)
      if (page.state.session_id === id) {
        this.cancel(page);
        this.owner.contentView.removeChildView(page.view);
        if (!page.contents.isDestroyed()) page.contents.close();
        this.pages.delete(tabId);
      }
    this.activeTabs.delete(id);
    this.temporaryPartitions.delete(id);
  }
  async control(id: string, input: BrowserAction, tabId?: string): Promise<unknown> {
    const command = BrowserActionSchema.parse(input);
    const page = this.page(id, tabId);
    if (page.interrupted || page.contents.isDestroyed())
      throw new Error("Browser action interrupted. Reload to restore this tab.");
    if (!this.agentAccess || !page.allowed || this.selected !== id || !page.view.getVisible())
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
    ].includes(command.action);
    if (mutates) page.pendingMutations++;
    try {
      return await this.perform(id, command, page);
    } catch (cause) {
      if (mutates && cause instanceof Error && /timed out/.test(cause.message)) this.cancel(page);
      throw cause;
    } finally {
      if (mutates) page.pendingMutations--;
    }
  }
  private async perform(id: string, command: BrowserAction, page: BrowserPage): Promise<unknown> {
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
    while (page.state.loading && Date.now() < until) {
      if (!this.agentAccess || !page.allowed || this.selected !== id || !page.view.getVisible())
        throw new Error("Browser control permission or selected session changed");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!this.agentAccess || !page.allowed || this.selected !== id || !page.view.getVisible())
      throw new Error("Browser control permission or selected session changed");
    if (page.state.loading || !previewWebUrl(contents.getURL()))
      throw new Error("Page is not ready. Inspect its status before retrying.");
    assertAllowed();
    if (command.action === "evaluate") {
      if (contents.debugger.isAttached()) throw new Error("Another browser evaluation is running");
      contents.debugger.attach("1.3");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await this.bounded(
          Promise.race([
            contents.debugger.sendCommand("Runtime.evaluate", {
              expression: `Promise.resolve().then(() => (${command.expression})).then(value => { const json = JSON.stringify(value ?? null); if (json.length > 64000) throw new Error('Evaluation result exceeds 64000 characters'); return JSON.parse(json); })`,
              awaitPromise: true,
              returnByValue: true,
              timeout: command.timeout_ms,
              userGesture: true,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                this.cancel(page);
                reject(new Error("Browser evaluation timed out; inspect before retrying"));
              }, command.timeout_ms);
            }),
          ]),
          assertAllowed,
          command.timeout_ms,
        );
        assertAllowed();
        if (result.exceptionDetails)
          throw new Error("Guest evaluation failed; inspect the page and expression");
        return { value: result.result.value ?? null };
      } finally {
        clearTimeout(timer);
        if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
      }
    }
    if (command.action === "wait") {
      const deadline = Date.now() + command.timeout_ms;
      while (true) {
        assertAllowed();
        const matched = await this.bounded(
          contents.executeJavaScriptInIsolatedWorld(999, [
            { code: `(${pageAction})(${JSON.stringify(command)})` },
          ]),
          assertAllowed,
          Math.max(1, deadline - Date.now()),
        );
        assertAllowed();
        if (matched) return { ok: true, state: command.state };
        if (Date.now() >= deadline) throw new Error("Browser wait timed out");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (command.action === "hover" || command.action === "drag") {
      const point = async (selector: string, scroll = true): Promise<{ x: number; y: number }> => {
        const value = await this.bounded(
          contents.executeJavaScriptInIsolatedWorld(999, [
            { code: `(${pageAction})(${JSON.stringify({ action: "point", selector, scroll })})` },
          ]),
          assertAllowed,
          10000,
        );
        assertAllowed();
        return value;
      };
      const start = await point(command.selector);
      contents.sendInputEvent({ type: "mouseMove", ...start });
      if (command.action === "hover") return { ok: true };
      const target = await point(command.target, false);
      assertAllowed();
      contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...start });
      try {
        for (let step = 1; step <= 12; step++) {
          assertAllowed();
          contents.sendInputEvent({
            type: "mouseMove",
            button: "left",
            x: Math.round(start.x + ((target.x - start.x) * step) / 12),
            y: Math.round(start.y + ((target.y - start.y) * step) / 12),
          });
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
      } finally {
        if (!contents.isDestroyed())
          contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...target });
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
      contents.sendInputEvent({ type: "keyDown", keyCode: key });
      contents.sendInputEvent({ type: "keyUp", keyCode: key });
      return { ok: true };
    }
    const code = `(${pageAction})(${JSON.stringify(command)})`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        contents.executeJavaScriptInIsolatedWorld(999, [{ code }], true),
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
  const find=selector=>{
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
    const elements=[...root.querySelectorAll("a,button,input,textarea,select,[role=button],[role=checkbox],[role=combobox],[contenteditable=true]")].filter(element=>element.getClientRects().length&&getComputedStyle(element).visibility!=="hidden").slice(0,80);
    const refs=globalThis.__orcPreviewRefs??new Map();
    const ids=globalThis.__orcPreviewIds??new WeakMap();
    let sequence=globalThis.__orcPreviewSequence??0;
    const prefix=globalThis.__orcPreviewPrefix??crypto.randomUUID().slice(0,8);
    const items=elements.map(element=>{let ref=ids.get(element);if(!ref){ref="@"+prefix+":"+(++sequence);ids.set(element,ref);}refs.set(ref,element);return {ref,tag:element.tagName.toLowerCase(),role:element.getAttribute("role"),name:(element.getAttribute("aria-label")??element.labels?.[0]?.innerText??element.innerText??element.getAttribute("placeholder")??"").slice(0,120),type:element.getAttribute("type"),disabled:element.matches(":disabled,[aria-disabled=true]")};});
    for(const [ref,element] of refs)if(!element.isConnected)refs.delete(ref);
    if(refs.size>1000){refs.clear();for(let index=0;index<items.length;index++)refs.set(items[index].ref,elements[index]);}
    globalThis.__orcPreviewRefs=refs;globalThis.__orcPreviewIds=ids;globalThis.__orcPreviewSequence=sequence;globalThis.__orcPreviewPrefix=prefix;
    const text=root.innerText??"";
    const result={untrusted:true,url:location.href.slice(0,Math.min(1000,Math.floor(limit/4))),title:document.title.slice(0,100),text:text.slice(0,Math.floor(limit/2)),elements:items,truncated:text.length>Math.floor(limit/2)};
    while(JSON.stringify(result).length>limit&&result.elements.length){result.elements.pop();result.truncated=true;}
    return result;
  }
  if(command.action==="scroll"){window.scrollBy(command.x,command.y);return {ok:true};}
  if(!["click","type","select","point"].includes(command.action))throw new Error("Unsupported page action");
  const matches=find(command.selector);
  if(matches.length!==1)throw new Error("Selector must match exactly one element. Take a fresh snapshot.");
  const element=matches[0];
  if(!element||!element.getClientRects().length||element.matches(":disabled,[aria-disabled=true]"))throw new Error("Element is hidden or disabled");
  if(command.scroll!==false)element.scrollIntoView({block:"center"});element.focus();
  const rect=element.getBoundingClientRect();const x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
  const hit=document.elementFromPoint(x,y);
  if(getComputedStyle(element).visibility==="hidden" || !hit || (hit!==element && !element.contains(hit)))throw new Error("Element is hidden or covered");
  if(command.action==="point")return {x,y};
  if(command.action==="select") {
    if(!(element instanceof HTMLSelectElement))throw new Error("Select requires a select element");
    if(!element.multiple && command.values.length!==1)throw new Error("Select accepts one value for this element");
    const options=[...element.options];
    if(command.values.some(value=>!options.some(option=>option.value===value&&!option.disabled&&!option.closest('optgroup[disabled]'))))throw new Error("Option is missing or disabled");
    for(const option of options)option.selected=command.values.includes(option.value);
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
