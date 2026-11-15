import { previewWebUrl } from "@orc/core/desktop-preview";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

const MAX_SUGGESTIONS = 5;

/** The clipboard work a menu entry performs, so the entries stay testable. */
export interface ContextMenuTarget {
  replaceMisspelling: (word: string) => void;
  copyLink: (url: string) => void;
  copyImage: () => void;
}

/**
 * Chromium draws no context menu inside Electron, so right-click only does
 * something when the shell builds one. Renderer handlers that call
 * preventDefault keep their own menus, because Blink stops the shell request.
 */
export function contextMenuItems(
  params: ContextMenuParams,
  target: ContextMenuTarget,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];

  if (params.misspelledWord.trim()) {
    for (const suggestion of params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS))
      items.push({ label: suggestion, click: () => target.replaceMisspelling(suggestion) });
    if (!params.dictionarySuggestions.length)
      items.push({ label: "No spelling suggestions", enabled: false });
    items.push({ type: "separator" });
  }

  // Copying a privileged URL such as `javascript:` invites pasting it back as a command.
  const link = previewWebUrl(params.linkURL);
  if (link)
    items.push(
      { label: "Copy link address", click: () => target.copyLink(link) },
      { type: "separator" },
    );

  if (params.mediaType === "image" && params.hasImageContents)
    items.push({ label: "Copy image", click: () => target.copyImage() }, { type: "separator" });

  // Roles act on the focused renderer; the caller focuses the right one first.
  items.push(
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
    { role: "selectAll", enabled: params.editFlags.canSelectAll },
  );

  return items;
}
