import type { MenuItemConstructorOptions } from "electron";

export const DOCUMENTATION_URL = "https://niradler.github.io/orc/";
export const ISSUES_URL = "https://github.com/niradler/orc/issues/new";

/** Chromium zoom levels are logarithmic: 0 is 100%, so 0.5 is one familiar step. */
export const ZOOM_STEP = 0.5;
export const ZOOM_LIMIT = 4;

export type ZoomDirection = "in" | "out" | "reset";

export interface AppMenuState {
  platform: NodeJS.Platform;
  /** Developer tools belong to source runs; an installed build ships without them. */
  packaged: boolean;
}

export interface AppMenuActions {
  showConnectionSettings: () => void;
  openViewer: () => void;
  autostart: () => boolean;
  setAutostart: (enabled: boolean) => void;
  reload: (force: boolean) => void;
  toggleDevTools: () => void;
  zoom: (direction: ZoomDirection) => void;
  openDocumentation: () => void;
  reportIssue: () => void;
  showAbout: () => void;
}

export function nextZoomLevel(current: number, direction: ZoomDirection): number {
  if (direction === "reset") return 0;
  const next = current + (direction === "in" ? ZOOM_STEP : -ZOOM_STEP);
  return Math.round(Math.min(ZOOM_LIMIT, Math.max(-ZOOM_LIMIT, next)) * 100) / 100;
}

/**
 * The window shows the dashboard and an embedded browser, so reload, developer
 * tools and zoom target the window's own contents instead of whichever guest
 * last had focus.
 */
export function appMenuTemplate(
  state: AppMenuState,
  actions: AppMenuActions,
): MenuItemConstructorOptions[] {
  const mac = state.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [];

  if (mac) template.push({ role: "appMenu" });

  template.push(
    {
      label: "File",
      submenu: [
        {
          label: "Connection…",
          accelerator: "CmdOrCtrl+,",
          click: () => actions.showConnectionSettings(),
        },
        {
          id: "browser-and-files",
          label: "Browser and files",
          accelerator: "CmdOrCtrl+Shift+B",
          click: () => actions.openViewer(),
        },
        { type: "separator" },
        {
          id: "start-at-login",
          label: "Start at login",
          type: "checkbox",
          checked: actions.autostart(),
          click: (item) => actions.setAutostart(item.checked),
        },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit", label: "Quit orc", accelerator: "CmdOrCtrl+Q" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => actions.reload(false) },
        {
          label: "Force Reload",
          accelerator: "Shift+CmdOrCtrl+R",
          click: () => actions.reload(true),
        },
        ...(state.packaged
          ? []
          : [
              {
                label: "Toggle Developer Tools",
                accelerator: mac ? "Alt+Command+I" : "Ctrl+Shift+I",
                click: () => actions.toggleDevTools(),
              } satisfies MenuItemConstructorOptions,
            ]),
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => actions.zoom("reset") },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => actions.zoom("in") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => actions.zoom("out") },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Documentation", click: () => actions.openDocumentation() },
        { label: "Report an issue", click: () => actions.reportIssue() },
        { type: "separator" },
        { label: "About orc", click: () => actions.showAbout() },
      ],
    },
  );

  return template;
}
