import type { Page } from "@playwright/test";
import { API_SECRET } from "./_helpers";
import { HOME } from "./_session-home-demo";

export const PREVIEW_FOLDER = "/home/demo/acme-shop";

/** Minimal Electron preview bridge plus the demo session's preview routes. */
export async function mockPreviewBridge(page: Page) {
  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
    const subscribe = () => () => {};
    Object.defineProperty(window, "orcDesktop", {
      value: {
        notify: () => {},
        onOpen: () => () => {},
        preview: {
          profiles: async () => [],
          selectProfile: async () => null,
          onProfiles: subscribe,
          restore: async () => null,
          chatPermission: async () => false,
          onBrowser: subscribe,
          onOpen: subscribe,
          allow: async () => {},
          dirty: async () => {},
          bounds: async () => {},
          preferences: async () => ({ agentBrowserControl: true, openLinksIn: "preview" }),
          onPreferences: subscribe,
          setPreferences: async (value: unknown) => value,
          pick: async () => null,
        },
      },
    });
  }, API_SECRET);
  await page.route("**/api/desktop-preview/session?**", (r) =>
    r.fulfill({ json: { id: HOME.chatA, cwd: PREVIEW_FOLDER, host: null, projectId: null } }),
  );
  await page.route("**/api/desktop-preview/clients", (r) =>
    r.fulfill({ json: { client_id: "e2e-preview", lease: "e2e-lease" } }),
  );
  await page.route("**/api/desktop-preview/clients/*/requests", (r) =>
    r.fulfill({ json: { requests: [] } }),
  );
  await page.route("**/api/desktop-preview/clients/*/close", (r) => r.fulfill({ json: {} }));
  await page.route("**/api/desktop-preview/file?**", (r) =>
    r.fulfill({
      json: {
        kind: "text",
        path: "src/cart/total.ts",
        root: PREVIEW_FOLDER,
        host: null,
        content: [
          "export function total(items: Item[]) {",
          "  return Math.round(items.reduce((sum, item) => sum + item.price, 0) * 100) / 100;",
          "}",
        ].join("\n"),
        editable: true,
      },
    }),
  );
  await page.route(`**/api/terminals/${HOME.terminal}/git/worktrees`, (r) =>
    r.fulfill({
      json: {
        root: PREVIEW_FOLDER,
        worktrees: [
          {
            path: PREVIEW_FOLDER,
            branch: "fix/cart-rounding",
            head: null,
            main: true,
            dirty: true,
            detached: false,
            locked: false,
            prunable: false,
          },
        ],
      },
    }),
  );
}
