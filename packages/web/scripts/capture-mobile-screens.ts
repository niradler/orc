/**
 * Captures populated desktop/phone screenshots from a dev server with demo data.
 * Usage: bun packages/web/scripts/capture-mobile-screens.ts [shot-filter]
 * Env: PREVIEW_URL (default http://127.0.0.1:3087), PREVIEW_API (default :7711),
 *      PREVIEW_OUT (default <repo>/.claude/previews).
 * Seed first with .claude/scripts/seed-mobile-demo.ts against the same isolated API.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = process.env.PREVIEW_URL ?? "http://127.0.0.1:3087";
const API = process.env.PREVIEW_API ?? "http://127.0.0.1:7711";
const OUT = process.env.PREVIEW_OUT ?? join(repoRoot, ".claude", "previews");
const filter = process.argv[2] ?? "";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const errors: string[] = [];

async function shoot(
  name: string,
  opts: {
    width: number;
    height: number;
    theme?: "dark" | "light";
    path: string;
    ready?: string;
    act?: (page: Page) => Promise<void>;
  },
) {
  if (filter && !name.includes(filter)) return;
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.width < 700 ? 2 : 1,
    isMobile: opts.width < 700,
    hasTouch: opts.width < 700,
  });
  await context.addInitScript((theme) => {
    localStorage.setItem("orc_theme", theme);
  }, opts.theme ?? "dark");
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${name}: ${message.text()}`);
  });
  await page.goto(`${BASE}${opts.path}`);
  if (opts.ready) await page.waitForSelector(opts.ready, { timeout: 15_000 });
  await page.waitForTimeout(600);
  if (opts.act) await opts.act(page);
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: "disabled" });
  console.log(`captured ${name}`);
  await context.close();
}

const requests = (await (await fetch(`${API}/api/human-requests`)).json()) as Array<{
  id: string;
}>;
const requestId = requests[0]?.id ?? "";

await shoot("notifications-phone-dark", {
  width: 390,
  height: 844,
  path: "/notifications?project=all",
  ready: '[data-testid="notification-item"]',
});
await shoot("notifications-phone-light", {
  width: 390,
  height: 844,
  theme: "light",
  path: "/notifications?project=all",
  ready: '[data-testid="notification-item"]',
});
await shoot("notifications-phone-request", {
  width: 390,
  height: 844,
  path: `/notifications?project=all&request=${requestId}`,
  ready: '[data-testid="attention-review"], [data-testid="notification-item"]',
});
await shoot("notifications-phone-project", {
  width: 390,
  height: 844,
  path: "/notifications?project=all",
  ready: '[data-testid="notification-item"], [data-testid="notification-group"]',
  act: async (page) => {
    await page.getByTestId("notifications-mode-project").click();
    await page.waitForTimeout(300);
  },
});
await shoot("notifications-phone-group", {
  width: 390,
  height: 844,
  path: "/notifications?project=all",
  ready: '[data-testid="notification-group"]',
  act: async (page) => {
    await page.getByTestId("notification-group-toggle").first().click();
    await page.waitForTimeout(300);
  },
});
await shoot("chat-phone-dark", {
  width: 390,
  height: 844,
  path: "/activity?project=all&chat=open",
  ready: '[data-testid="chat-panel"]',
});
await shoot("chat-phone-sessions", {
  width: 390,
  height: 844,
  path: "/activity?project=all&chat=open",
  ready: '[data-testid="chat-panel"]',
  act: async (page) => {
    await page.getByTestId("chat-sessions-button").click();
    await page.waitForSelector('[data-testid="chat-sessions-dialog"]');
  },
});
await shoot("tasks-phone-dark", {
  width: 390,
  height: 844,
  path: "/tasks?project=all",
  ready: '[data-testid="task-row"]',
});
await shoot("notifications-desktop-dark", {
  width: 1440,
  height: 900,
  path: "/notifications?project=all",
  ready: '[data-testid="notification-item"]',
});
await shoot("notifications-desktop-popover", {
  width: 1440,
  height: 900,
  path: "/activity?project=all",
  ready: '[data-testid="notification-bell"]',
  act: async (page) => {
    await page.getByTestId("notification-bell").first().click();
    await page.waitForSelector('[data-testid="notification-menu"]');
  },
});

await browser.close();
if (errors.length) {
  console.error(`Console/page errors:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("done");
