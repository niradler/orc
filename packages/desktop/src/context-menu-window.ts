import { BrowserWindow, type ContextMenuParams, clipboard, Menu, type WebContents } from "electron";
import { type ContextMenuTarget, contextMenuItems } from "./context-menu.js";

function nativeTarget(contents: WebContents, params: ContextMenuParams): ContextMenuTarget {
  return {
    replaceMisspelling: (word: string) => contents.replaceMisspelling(word),
    copyLink: (url: string) => clipboard.writeText(url),
    copyImage: () => contents.copyImageAt(params.x, params.y),
  };
}

/** Right-clicking a guest can leave native editing roles aimed at the host renderer. */
function showContextMenu(contents: WebContents, params: ContextMenuParams): void {
  if (contents.isDestroyed()) return;
  contents.focus();
  const window = BrowserWindow.fromWebContents(contents);
  Menu.buildFromTemplate(contextMenuItems(params, nativeTarget(contents, params))).popup(
    params.frame ? { frame: params.frame } : window ? { window } : {},
  );
}

/** Wires right-click on a window or embedded view; the preview browser needs its own. */
export function attachContextMenu(contents: WebContents): void {
  contents.on("context-menu", (_event, params) => {
    showContextMenu(contents, params);
  });
}
