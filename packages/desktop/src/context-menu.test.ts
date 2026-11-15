import { describe, expect, test } from "bun:test";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { type ContextMenuTarget, contextMenuItems } from "./context-menu.js";

function target(): ContextMenuTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    replaceMisspelling: (word) => calls.push(`spell:${word}`),
    copyLink: (url) => calls.push(`link:${url}`),
    copyImage: () => calls.push("image"),
  };
}

function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    x: 12,
    y: 34,
    frame: null,
    linkURL: "",
    linkText: "",
    pageURL: "http://127.0.0.1:3077/",
    frameURL: "http://127.0.0.1:3077/",
    srcURL: "",
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    titleText: "",
    altText: "",
    misspelledWord: "",
    dictionarySuggestions: [],
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: true,
      canEditRichly: false,
    },
    ...overrides,
  } as ContextMenuParams;
}

function click(items: MenuItemConstructorOptions[], label: string): void {
  const item = items.find((entry) => entry.label === label);
  if (!item) throw new Error(`No ${label} item`);
  item.click?.({} as never, undefined as never, {} as never);
}

function editItems(items: MenuItemConstructorOptions[]) {
  return items.filter((item) => typeof item.role === "string");
}

describe("desktop context menu entries", () => {
  test("should offer the native editing roles with their real availability", () => {
    const items = contextMenuItems(
      params({
        isEditable: true,
        editFlags: { ...params().editFlags, canCopy: true, canCut: true, canPaste: true },
      }),
      target(),
    );
    expect(editItems(items)).toEqual([
      { role: "cut", enabled: true },
      { role: "copy", enabled: true },
      { role: "paste", enabled: true },
      { role: "selectAll", enabled: true },
    ]);
  });

  test("should keep the menu stable when nothing is editable or selected", () => {
    expect(editItems(contextMenuItems(params(), target()))).toEqual([
      { role: "cut", enabled: false },
      { role: "copy", enabled: false },
      { role: "paste", enabled: false },
      { role: "selectAll", enabled: true },
    ]);
  });

  test("should copy web links and skip privileged schemes", () => {
    const copy = target();
    click(
      contextMenuItems(params({ linkURL: "https://example.com/a?b=c" }), copy),
      "Copy link address",
    );
    expect(copy.calls).toEqual(["link:https://example.com/a?b=c"]);

    for (const linkURL of ["javascript:alert(1)", "file:///C:/secret.txt", ""])
      expect(
        contextMenuItems(params({ linkURL }), copy).some(
          (item) => item.label === "Copy link address",
        ),
      ).toBe(false);
  });

  test("should copy the image under the pointer only when it has contents", () => {
    const copy = target();
    click(
      contextMenuItems(
        params({ mediaType: "image", hasImageContents: true, srcURL: "http://127.0.0.1/a.png" }),
        copy,
      ),
      "Copy image",
    );
    expect(copy.calls).toEqual(["image"]);
    expect(
      contextMenuItems(params({ mediaType: "image" }), copy).some(
        (item) => item.label === "Copy image",
      ),
    ).toBe(false);
  });

  test("should offer at most five spelling suggestions and say when there are none", () => {
    const copy = target();
    const suggestions = contextMenuItems(
      params({ misspelledWord: "recieve", dictionarySuggestions: ["a", "b", "c", "d", "e", "f"] }),
      copy,
    ).filter((item) => !item.role && item.type !== "separator");
    expect(suggestions.map((item) => item.label)).toEqual(["a", "b", "c", "d", "e"]);
    click(suggestions, "a");
    expect(copy.calls).toEqual(["spell:a"]);
    expect(
      contextMenuItems(params({ misspelledWord: "recieve" }), copy).some(
        (item) => item.label === "No spelling suggestions",
      ),
    ).toBe(true);
  });
});
