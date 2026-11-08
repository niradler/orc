import { open } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
  WebContentsView,
} from "electron";
import {
  browserUrl,
  decodeText,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  VIEWER_CHANNEL,
  VIEWER_STATE_CHANNEL,
  type ViewerState,
} from "./viewer-policy.js";

let viewer: BrowserWindow | null = null;
let navigateViewer: ((url: string) => void) | null = null;

export function openDesktopViewer(target?: string): void {
  if (viewer && !viewer.isDestroyed()) {
    viewer.show();
    viewer.focus();
    if (target) navigateViewer?.(target);
    return;
  }
  const chromeUrl = pathToFileURL(resolve(import.meta.dirname, "viewer.html")).href;
  const guestSession = session.fromPartition(`orc-browser-${crypto.randomUUID()}`);
  guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  guestSession.setPermissionCheckHandler(() => false);
  guestSession.on("will-download", (event) => event.preventDefault());
  const window = new BrowserWindow({
    title: "ORC · Browser and files",
    width: 1100,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: "#000000",
    webPreferences: {
      preload: resolve(import.meta.dirname, "viewer-preload.cjs"),
      partition: `orc-viewer-${crypto.randomUUID()}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  viewer = window;
  window.setMenuBarVisibility(false);
  const browser = new WebContentsView({
    webPreferences: {
      session: guestSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  window.contentView.addChildView(browser);
  const state: ViewerState = {
    mode: "browser",
    url: "",
    back: false,
    forward: false,
    loading: false,
    error: "",
    file: null,
    image: null,
  };
  function publish(): void {
    if (window.isDestroyed() || browser.webContents.isDestroyed()) return;
    state.back = browser.webContents.navigationHistory.canGoBack();
    state.forward = browser.webContents.navigationHistory.canGoForward();
    window.webContents.send(VIEWER_STATE_CHANNEL, state);
  }
  function resize(): void {
    const [width = 0, height = 0] = window.getContentSize();
    browser.setBounds({ x: 0, y: 96, width, height: Math.max(0, height - 96) });
  }
  function navigate(value: string): void {
    const url = browserUrl(value);
    if (!url) {
      state.error = "Enter an http:// or https:// URL without embedded credentials.";
      publish();
      return;
    }
    state.mode = "browser";
    state.error = "";
    state.url = url;
    browser.setVisible(true);
    publish();
    void browser.webContents.loadURL(url).catch(() => {});
  }
  navigateViewer = navigate;
  browser.webContents.setWindowOpenHandler(({ url }) => {
    if (browserUrl(url)) navigate(url);
    return { action: "deny" };
  });
  browser.webContents.on("will-navigate", (event, url) => {
    if (!browserUrl(url)) event.preventDefault();
  });
  browser.webContents.on("will-redirect", (event, url) => {
    if (!browserUrl(url)) event.preventDefault();
  });
  browser.webContents.on("will-frame-navigate", (event) => {
    if (!browserUrl(event.url)) event.preventDefault();
  });
  browser.webContents.on("did-navigate", (_event, url) => {
    state.url = url;
    state.error = "";
    publish();
  });
  browser.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) state.url = url;
    publish();
  });
  browser.webContents.on("did-start-loading", () => {
    state.loading = true;
    publish();
  });
  browser.webContents.on("did-stop-loading", () => {
    state.loading = false;
    publish();
  });
  browser.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) {
      state.error = `Could not load this page (${code}). Check the address or retry.`;
      publish();
    }
  });
  browser.webContents.on("render-process-gone", () => {
    state.loading = false;
    state.error = "The page stopped. Reload to try again.";
    publish();
  });
  let picking = false;
  const handle: Parameters<typeof ipcMain.handle>[1] = async (
    event,
    action: unknown,
    value: unknown,
  ) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== chromeUrl
    )
      throw new Error("Viewer access denied");
    if (action === "state") return state;
    if (action === "navigate") {
      navigate(typeof value === "string" ? value : "");
      return;
    }
    if (action === "back" && state.back) browser.webContents.navigationHistory.goBack();
    else if (action === "forward" && state.forward)
      browser.webContents.navigationHistory.goForward();
    else if (action === "reload") browser.webContents.reload();
    else if (action === "external") {
      const url = browserUrl(state.url);
      if (url) await shell.openExternal(url);
    } else if (action === "browser") {
      state.mode = "browser";
      browser.setVisible(!!state.url);
    } else if (action === "file" && !picking) {
      picking = true;
      try {
        const result = await dialog.showOpenDialog(window, {
          title: "Open image, Markdown, code or text",
          properties: ["openFile"],
        });
        if (result.canceled || !result.filePaths[0] || window.isDestroyed()) return;
        const file = await open(result.filePaths[0], "r");
        try {
          const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"].includes(
            extname(result.filePaths[0]).toLowerCase(),
          );
          const limit = isImage ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > limit)
            throw new Error(
              isImage
                ? "Choose an image smaller than 8 MiB."
                : "Choose a text file smaller than 1 MiB.",
            );
          const buffer = Buffer.alloc(limit + 1);
          let length = 0;
          while (length < buffer.length) {
            const read = await file.read(buffer, length, buffer.length - length, null);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          if (window.isDestroyed()) return;
          const bytes = buffer.subarray(0, length);
          const name = basename(result.filePaths[0]);
          if (isImage) {
            if (bytes.length > limit) throw new Error("Choose an image smaller than 8 MiB.");
            const image = nativeImage.createFromBuffer(bytes);
            const size = image.getSize();
            if (image.isEmpty() || size.width * size.height > 16_000_000)
              throw new Error("Choose a supported image up to 16 megapixels.");
            state.image = { name, url: image.toDataURL() };
            state.file = null;
            state.mode = "image";
          } else {
            state.file = { name, content: decodeText(bytes) };
            state.image = null;
            state.mode = "file";
          }
          state.error = "";
          browser.setVisible(false);
        } finally {
          await file.close();
        }
      } catch (error) {
        if (!window.isDestroyed())
          state.error = error instanceof Error ? error.message : "Could not read file.";
      } finally {
        picking = false;
      }
    }
    publish();
  };
  ipcMain.handle(VIEWER_CHANNEL, handle);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("did-finish-load", publish);
  window.on("resize", resize);
  window.on("closed", () => {
    ipcMain.removeHandler(VIEWER_CHANNEL);
    browser.webContents.close();
    viewer = null;
    navigateViewer = null;
  });
  resize();
  browser.setVisible(false);
  void window.loadURL(chromeUrl);
  if (target) navigate(target);
}
