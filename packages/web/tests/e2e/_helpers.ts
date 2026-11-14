import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";

/** Theme lives in Settings → Appearance (and the command palette). Specs that
 *  only need the other theme for rendering switch it in place through the same
 *  storage event the app listens to for cross-tab sync. */
export async function toggleThemeInPlace(page: Page): Promise<void> {
  const before = (await page.locator("html").getAttribute("data-theme")) ?? "dark";
  const next = before === "dark" ? "light" : "dark";
  await page.evaluate((value) => {
    localStorage.setItem("orc_theme", value);
    window.dispatchEvent(new StorageEvent("storage", { key: "orc_theme", newValue: value }));
  }, next);
  await expect(page.locator("html")).toHaveAttribute("data-theme", next);
}

/** Theme is saved from Settings → Appearance. Switch to a specific theme through the
 *  real UI and wait for the server save so a reload keeps it. */
export async function setThemeViaSettings(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.goto("/settings?settingsSection=appearance");
  await expect(page.getByTestId(`settings-theme-${theme}`)).toBeVisible();
  if ((await page.locator("html").getAttribute("data-theme")) === theme) return;
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/settings") && response.request().method() === "PATCH",
  );
  await page.getByTestId(`settings-theme-${theme}`).click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** The phone chat page has no close button: the nav drawer moves to another page. */
export async function leavePhoneChatViaNav(page: Page, destination: string): Promise<void> {
  await page.getByTestId("mobile-nav-open").click();
  await page.getByTestId("mobile-nav-drawer").getByTestId(`nav-${destination}`).click();
  await expect(page.getByTestId("mobile-nav-drawer")).toBeHidden();
}

export async function reviewAttentionRequest(card: Locator): Promise<void> {
  const review = card.getByTestId("attention-review");
  await review.waitFor({ state: "visible" });
  if ((await review.getAttribute("aria-expanded")) !== "true") await review.click();
}

/** The inbox is an anchored popover on desktop and a full page on phones. */
export function notificationInbox(page: Page): Locator {
  return page.locator('[data-testid="notification-menu"], [data-testid="notifications-page"]');
}

export async function closeNotificationInbox(page: Page): Promise<void> {
  if ((await notificationInbox(page).count()) === 0) return;
  const close = page.getByRole("button", { name: "Close notifications", exact: true });
  if (await close.isVisible()) await close.click();
  else await page.getByTestId("notifications-back").click();
}

/** Desktop rows expose direct icon actions; phone rows keep them in a named menu. */
export async function clickNotificationMarkRead(page: Page, row: Locator): Promise<void> {
  const direct = row.getByTestId("notification-mark-read");
  if (await direct.isVisible()) await direct.click();
  else {
    await row.getByTestId("notification-actions").click();
    await page.getByTestId("notification-mark-read").click();
  }
}

export async function openTerminalOptions(page: Page, touch = false): Promise<void> {
  const button = page.locator('[data-testid="terminal-options"]:visible').first();
  if (!(await button.isVisible())) {
    const menu = page.locator('[data-testid="pane-actions"]:visible').first();
    if (touch) await menu.tap();
    else await menu.click();
  }
  if (touch) await button.tap();
  else await button.click();
}

export async function splitTerminalPane(
  pane: Locator,
  direction: "horizontal" | "vertical",
): Promise<void> {
  await pane.waitFor({ state: "visible" });
  const direct = pane.getByTestId(`pane-split-${direction}`);
  if (await direct.isVisible()) await direct.click();
  else {
    await pane.getByTestId("pane-actions").click();
    await pane.getByTestId(`pane-action-split-${direction}`).click();
  }
}

export async function terminalPaneAction(pane: Locator, action: "focus" | "close"): Promise<void> {
  const direct = pane.getByTestId(`pane-${action}`);
  if (await direct.isVisible()) await direct.click();
  else {
    await pane.getByTestId("pane-actions").click();
    await pane.getByTestId(`pane-action-${action}`).click();
  }
}

export const API_PORT = process.env.ORC_API_PORT ?? "9871";
export const API_BASE = `http://127.0.0.1:${API_PORT}/api`;
export const API_SECRET = process.env.ORC_API_SECRET ?? "";

export const AUTH_HEADERS: Record<string, string> = API_SECRET
  ? {
      Authorization: `Bearer ${API_SECRET}`,
      "Content-Type": "application/json",
    }
  : { "Content-Type": "application/json" };

/**
 * Repo root, found by walking up to the workspace package.json. The API server
 * under test runs with the repo root as its cwd, so project-scoped fixtures
 * (`./.orc/flows/...`) have to be written there and not next to the specs.
 */
export function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf-8")) as {
          workspaces?: unknown;
        };
        if (parsed.workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find the workspace root from ${process.cwd()}`);
}

/** Unique short id for test fixtures so multiple test runs don't collide. */
export function tid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Open the app, ensure web client has the bearer (if needed), and navigate to a view. */
export async function gotoView(
  page: Page,
  view:
    | "activity"
    | "notifications"
    | "tasks"
    | "jobs"
    | "memories"
    | "projects"
    | "sessions"
    | "knowledge"
    | "skills"
    | "packages"
    | "agents"
    | "terminals"
    | "rules"
    | "scratchpads"
    | "settings",
): Promise<void> {
  if (API_SECRET) {
    await page.addInitScript(
      (secret: string) =>
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
      API_SECRET,
    );
  }
  const paths: Partial<Record<typeof view, string>> = {
    notifications: "activity?notifications=open",
    memories: "knowledge/memories",
    knowledge: "knowledge/base",
    agents: "packages/agents",
    scratchpads: "scratchpad",
  };
  const path = paths[view] ?? view;
  await page.goto(`/${path}`);
}

export async function selectProject(page: Page, id: string): Promise<void> {
  await page.getByRole("banner").waitFor();
  const mobile = page.getByTestId("mobile-nav-open");
  if ((await mobile.isVisible()) && !(await page.getByTestId("mobile-nav-drawer").isVisible()))
    await mobile.click();
  const drawer = page.getByTestId("mobile-nav-drawer");
  const picker = (await drawer.isVisible())
    ? drawer.getByTestId("sidebar-project-select")
    : page.getByTestId("sidebar-project-select");
  await picker.click();
  await page.getByTestId(`project-option-${id}`).click();
  if (await drawer.isVisible()) await page.keyboard.press("Escape");
}

export async function apiDelete(request: APIRequestContext, path: string): Promise<void> {
  await connectRetry(() => request.delete(`${API_BASE}${path}`, { headers: AUTH_HEADERS }));
}

/**
 * The e2e API briefly stops accepting connections while a heavy request holds its
 * event loop; Playwright reports that as `connect ETIMEDOUT`/`ECONNREFUSED`. A
 * connect-level failure means the request never reached the server, so a bounded
 * retry cannot duplicate it. Other errors are rethrown immediately.
 */
async function connectRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 4 || !/connect (ETIMEDOUT|ECONNREFUSED)/i.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

export async function apiGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await connectRetry(() =>
    request.get(`${API_BASE}${path}`, {
      headers: AUTH_HEADERS,
    }),
  );
  if (!res.ok()) throw new Error(`GET ${path} failed: ${res.status()}`);
  return (await res.json()) as T;
}

export async function apiPost<T>(
  request: APIRequestContext,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await connectRetry(() =>
    request.post(`${API_BASE}${path}`, {
      headers: AUTH_HEADERS,
      data: body,
    }),
  );
  if (!res.ok()) throw new Error(`POST ${path} failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function apiPatch<T>(
  request: APIRequestContext,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await connectRetry(() =>
    request.patch(`${API_BASE}${path}`, {
      headers: AUTH_HEADERS,
      data: body,
    }),
  );
  if (!res.ok()) throw new Error(`PATCH ${path} failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}
