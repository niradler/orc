import { describe, expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import {
  type AppMenuActions,
  type AppMenuState,
  appMenuTemplate,
  DOCUMENTATION_URL,
  ISSUES_URL,
  nextZoomLevel,
} from "./app-menu.js";

function actions(overrides: Partial<AppMenuActions> = {}): AppMenuActions {
  return {
    showConnectionSettings: () => {},
    openViewer: () => {},
    autostart: () => false,
    setAutostart: () => {},
    reload: () => {},
    toggleDevTools: () => {},
    zoom: () => {},
    openDocumentation: () => {},
    reportIssue: () => {},
    showAbout: () => {},
    ...overrides,
  };
}

function submenu(
  template: MenuItemConstructorOptions[],
  name: string,
): MenuItemConstructorOptions[] {
  const item = template.find((entry) => entry.label === name || entry.role === name);
  if (!item?.submenu) throw new Error(`No ${name} submenu`);
  return item.submenu as MenuItemConstructorOptions[];
}

function item(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = items.find((entry) => entry.label === label);
  if (!found) throw new Error(`No ${label} item`);
  return found;
}

function state(platform: NodeJS.Platform, packaged = true): AppMenuState {
  return { platform, packaged };
}

describe("desktop application menu", () => {
  test("should lead with the macOS app menu and quit from the app menu there", () => {
    const template = appMenuTemplate(state("darwin"), actions());
    expect(template[0]).toMatchObject({ role: "appMenu" });
    expect(submenu(template, "File").at(-1)).toMatchObject({ role: "close" });
  });

  test("should offer Quit orc in the File menu where the app has no app menu", () => {
    for (const platform of ["win32", "linux"] as const) {
      const template = appMenuTemplate(state(platform), actions());
      expect(template.some((entry) => (entry as { role?: string }).role === "appMenu")).toBe(false);
      expect(submenu(template, "File").at(-1)).toMatchObject({
        role: "quit",
        label: "Quit orc",
        accelerator: "CmdOrCtrl+Q",
      });
    }
  });

  test("should open the connected server, the viewer and the login setting from File", () => {
    const calls: string[] = [];
    const template = appMenuTemplate(
      state("win32"),
      actions({
        showConnectionSettings: () => calls.push("connection"),
        openViewer: () => calls.push("viewer"),
        autostart: () => true,
        setAutostart: (enabled) => calls.push(`autostart:${enabled}`),
      }),
    );
    const file = submenu(template, "File");
    file[0]?.click?.({} as never, undefined as never, {} as never);
    expect(item(file, "Browser and files")).toMatchObject({
      id: "browser-and-files",
      accelerator: "CmdOrCtrl+Shift+B",
    });
    item(file, "Browser and files").click?.({} as never, undefined as never, {} as never);
    const login = item(file, "Start at login");
    expect(login).toMatchObject({ id: "start-at-login", type: "checkbox", checked: true });
    login.click?.({ checked: false } as never, undefined as never, {} as never);
    expect(calls).toEqual(["connection", "viewer", "autostart:false"]);
  });

  test("should route reload and zoom to the window instead of the focused page", () => {
    const calls: string[] = [];
    const template = appMenuTemplate(
      state("win32"),
      actions({
        reload: (force) => calls.push(force ? "force" : "reload"),
        zoom: (direction) => calls.push(direction),
      }),
    );
    const view = submenu(template, "View");
    item(view, "Reload").click?.({} as never, undefined as never, {} as never);
    item(view, "Force Reload").click?.({} as never, undefined as never, {} as never);
    item(view, "Actual Size").click?.({} as never, undefined as never, {} as never);
    item(view, "Zoom In").click?.({} as never, undefined as never, {} as never);
    item(view, "Zoom Out").click?.({} as never, undefined as never, {} as never);
    expect(calls).toEqual(["reload", "force", "reset", "in", "out"]);
    expect(view.some((entry) => (entry as { role?: string }).role === "viewMenu")).toBe(false);
  });

  test("should keep developer tools out of an installed build", () => {
    const dev = submenu(appMenuTemplate(state("win32", false), actions()), "View");
    expect(dev.some((entry) => entry.label === "Toggle Developer Tools")).toBe(true);
    const packaged = submenu(appMenuTemplate(state("win32", true), actions()), "View");
    expect(packaged.some((entry) => entry.label === "Toggle Developer Tools")).toBe(false);
  });

  test("should give Help working documentation, issue and about entries", () => {
    const calls: string[] = [];
    const help = submenu(
      appMenuTemplate(
        state("win32"),
        actions({
          openDocumentation: () => calls.push(DOCUMENTATION_URL),
          reportIssue: () => calls.push(ISSUES_URL),
          showAbout: () => calls.push("about"),
        }),
      ),
      "help",
    );
    for (const entry of help) entry.click?.({} as never, undefined as never, {} as never);
    expect(calls).toEqual([DOCUMENTATION_URL, ISSUES_URL, "about"]);
    expect(DOCUMENTATION_URL.startsWith("https://")).toBe(true);
    expect(ISSUES_URL.startsWith("https://")).toBe(true);
  });

  test("should leave About to the macOS app menu", () => {
    const mac = submenu(appMenuTemplate(state("darwin"), actions({ showAbout: () => {} })), "help");
    expect(mac.some((entry) => entry.label === "About orc")).toBe(false);
    expect(mac.some((entry) => entry.label === "Documentation")).toBe(true);
  });
});

describe("desktop zoom steps", () => {
  test("should step one visible level at a time and reset to actual size", () => {
    expect(nextZoomLevel(0, "in")).toBe(0.5);
    expect(nextZoomLevel(0.5, "out")).toBe(0);
    expect(nextZoomLevel(2.5, "reset")).toBe(0);
  });

  test("should stop at the limits instead of shrinking or growing without bound", () => {
    expect(nextZoomLevel(3.75, "in")).toBe(4);
    expect(nextZoomLevel(4, "in")).toBe(4);
    expect(nextZoomLevel(-3.75, "out")).toBe(-4);
    expect(nextZoomLevel(-4, "out")).toBe(-4);
  });
});
