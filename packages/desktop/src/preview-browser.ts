import { randomUUID } from "node:crypto";
import {
  type BrowserAction,
  BrowserActionSchema,
  type PreviewBrowserState,
  previewWebUrl,
} from "@orc/core/desktop-preview";
import { type BrowserWindow, session, WebContentsView } from "electron";

interface BrowserPage {
  view: WebContentsView;
  state: PreviewBrowserState;
  allowed: boolean;
}

/** Only unprivileged guest pages are reachable here, never the ORC renderer. */
export class PreviewBrowser {
  private readonly pages = new Map<string, BrowserPage>();
  private selected: string | null = null;
  private agentAccess = true;
  private rectangle: { x: number; y: number; width: number; height: number } | null = null;
  private readonly permissions = new Map<string, boolean>();
  constructor(
    private readonly owner: BrowserWindow,
    private readonly publish: (state: PreviewBrowserState) => void,
  ) {}
  private page(id: string): BrowserPage {
    const page = this.pages.get(id);
    if (!page) throw new Error("Open a browser page in this session first");
    return page;
  }
  open(id: string, value: string): PreviewBrowserState {
    const url = previewWebUrl(value);
    if (!url) throw new Error("Use an HTTP/HTTPS URL without embedded credentials");
    let page = this.pages.get(id);
    if (!page) {
      if (this.pages.size >= 8) {
        const oldest = [...this.pages].find(([key]) => key !== this.selected);
        if (oldest) {
          this.owner.contentView.removeChildView(oldest[1].view);
          oldest[1].view.webContents.close();
          this.pages.delete(oldest[0]);
        }
      }
      const isolated = session.fromPartition(`orc-preview-${randomUUID()}`);
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      isolated.on("will-download", (event) => event.preventDefault());
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
        url,
        back: false,
        forward: false,
        loading: false,
        error: null,
      };
      page = { view, state, allowed: this.permissions.get(id) ?? false };
      this.pages.set(id, page);
      const changed = () => this.changed(id);
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
        if (previewWebUrl(target)) this.open(id, target);
        return { action: "deny" };
      });
    }
    page.state.url = url;
    page.state.error = null;
    if (this.selected === id && this.rectangle) this.bounds(id, this.rectangle);
    void page.view.webContents.loadURL(url).catch(() => {});
    return { ...page.state };
  }
  private changed(id: string): void {
    const page = this.pages.get(id);
    if (!page || this.owner.isDestroyed() || page.view.webContents.isDestroyed()) return;
    page.state.back = page.view.webContents.navigationHistory.canGoBack();
    page.state.forward = page.view.webContents.navigationHistory.canGoForward();
    this.publish({ ...page.state });
  }
  bounds(
    id: string | null,
    rect: { x: number; y: number; width: number; height: number } | null,
    restoreUrl?: string,
  ): void {
    if (id && rect && !this.pages.has(id) && restoreUrl) this.open(id, restoreUrl);
    this.selected = id;
    this.rectangle = rect;
    for (const [key, page] of this.pages) {
      const visible = key === id && rect !== null && rect.width > 0 && rect.height > 0;
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
    const page = this.page(id),
      history = page.view.webContents.navigationHistory;
    if (action === "back" && history.canGoBack()) history.goBack();
    else if (action === "forward" && history.canGoForward()) history.goForward();
    else if (action === "reload") page.view.webContents.reload();
  }
  allow(id: string, enabled: boolean): void {
    this.permissions.set(id, enabled);
    const page = this.pages.get(id);
    if (page) page.allowed = enabled;
  }
  setAgentAccess(enabled: boolean): void {
    this.agentAccess = enabled;
  }
  async control(id: string, input: BrowserAction): Promise<unknown> {
    const command = BrowserActionSchema.parse(input);
    const page = this.page(id);
    if (!this.agentAccess || !page.allowed || this.selected !== id || !page.view.getVisible())
      throw new Error("Agent browser control is disabled or this session is not visible");
    const contents = page.view.webContents;
    const assertAllowed = () => {
      if (
        !this.agentAccess ||
        !page.allowed ||
        this.selected !== id ||
        !page.view.getVisible() ||
        contents.isDestroyed()
      )
        throw new Error("Browser control permission or selected session changed");
    };
    const until = Date.now() + 10000;
    while (page.state.loading && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (!this.agentAccess || !page.allowed || this.selected !== id || !page.view.getVisible())
      throw new Error("Browser control permission or selected session changed");
    if (page.state.loading || !previewWebUrl(contents.getURL()))
      throw new Error("Page is not ready. Inspect its status before retrying.");
    if (command.action === "screenshot") {
      const capture = await contents.capturePage();
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
        contents.executeJavaScript(code, true),
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
      if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
    }
    this.pages.clear();
    this.permissions.clear();
    this.selected = null;
    this.rectangle = null;
  }
}

/** Fixed browser script; command text/selector are JSON data, never script fragments. */
const pageAction = `function(command) {
  if(command.action==="snapshot") {
    const elements=[...document.querySelectorAll("a,button,input,textarea,select,[role=button]")].filter(element=>element.getClientRects().length).slice(0,120);
    const selector=element=>{if(element.id&&document.querySelectorAll("#"+CSS.escape(element.id)).length===1)return "#"+CSS.escape(element.id);const parts=[];for(let current=element;current&&current!==document.body;current=current.parentElement){parts.unshift(current.tagName.toLowerCase()+":nth-child("+([...current.parentElement.children].indexOf(current)+1)+")");}return "body > "+parts.join(" > ");};
    return {url:location.href,title:document.title,text:document.body?.innerText.slice(0,24000)??"",elements:elements.map(element=>({tag:element.tagName.toLowerCase(),selector:selector(element),role:element.getAttribute("role"),name:(element.getAttribute("aria-label")??element.innerText??"").slice(0,160),type:element.getAttribute("type")}))};
  }
  if(command.action==="scroll"){window.scrollBy(command.x,command.y);return {ok:true};}
  if(command.action!=="click"&&command.action!=="type")throw new Error("Unsupported page action");
  const matches=document.querySelectorAll(command.selector);
  if(matches.length!==1)throw new Error("Selector must match exactly one element. Take a fresh snapshot.");
  const element=matches[0];
  if(!element||!element.getClientRects().length||element.matches(":disabled"))throw new Error("Element is hidden or disabled");
  element.scrollIntoView({block:"center"});element.focus();
  if(command.action==="click"){element.click();return {ok:true};}
  if(!(element instanceof HTMLInputElement)&&!(element instanceof HTMLTextAreaElement))throw new Error("Type requires a text input or textarea");
  if(element.readOnly)throw new Error("Input is read-only");
  if(element instanceof HTMLInputElement && ["file","hidden","checkbox","radio","submit","button"].includes(element.type))throw new Error("This input type is not supported");
  const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype,"value")?.set?.call(element,command.text);
  element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));
  return {ok:true};
}`;
