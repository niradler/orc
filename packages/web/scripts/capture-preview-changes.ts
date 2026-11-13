/**
 * Captures the desktop preview panel's Changes tab from a dev server with demo
 * data. The panel is desktop-only, so a stub desktop bridge plus mocked
 * session/terminal/git routes provide the demo state; nothing here touches a
 * real workspace. Pair with an isolated dev API (see .env: 7711/3087).
 *
 * Usage: bun packages/web/scripts/capture-preview-changes.ts
 * Env: PREVIEW_URL (default http://127.0.0.1:3087),
 *      PREVIEW_OUT (default docs/public/screens).
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatSettingsSchema } from "@orc/core/chat";
import { chromium, type Page } from "@playwright/test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = process.env.PREVIEW_URL ?? "http://127.0.0.1:3087";
const OUT = process.env.PREVIEW_OUT ?? join(repoRoot, "docs", "public", "screens");
mkdirSync(OUT, { recursive: true });

const CHAT = "50000000-0000-4000-8000-0000000000a1";
const TERMINAL = "preview-changes-demo";
const FOLDER = "/home/demo/acme-shop";
const now = Date.now();

const thread = {
  id: CHAT,
  title: "Fix the cart total rounding",
  config: ChatSettingsSchema.parse({ agent: "claude" }),
  cwd: FOLDER,
  host: null,
  runtimeId: null,
  sourceId: null,
  backend: "claude-code",
  updatedAt: now - 60_000,
  messages: [
    {
      id: `${CHAT}-q`,
      role: "user",
      content:
        "The cart total shows 19.999999998 after the tax change. Please fix the rounding and add a regression test.",
      timestamp: now - 8 * 60_000,
    },
    {
      id: `${CHAT}-a`,
      role: "assistant",
      content:
        "Found it — `total()` sums raw floats. I rounded to cents at the boundary and added a regression test. The changes are in `src/cart/total.ts` and `src/cart/total.test.ts`; review them in the Changes tab.",
      timestamp: now - 60_000,
    },
  ],
};

const files = [
  { path: "src/cart/total.ts", index: " ", working: "M", original: null },
  { path: "src/cart/total.test.ts", index: "M", working: " ", original: null },
  { path: "src/cart/currency.ts", index: "A", working: " ", original: null },
  { path: "README.md", index: " ", working: "M", original: null },
  { path: "notes/rounding.md", index: "?", working: "?", original: null },
];

const diffs: Record<string, string> = {
  "src/cart/total.ts": [
    "diff --git a/src/cart/total.ts b/src/cart/total.ts",
    "--- a/src/cart/total.ts",
    "+++ b/src/cart/total.ts",
    "@@ -1,7 +1,9 @@",
    ' import type { Item } from "./types";',
    '+import { roundCents } from "./currency";',
    " ",
    " export function total(items: Item[]) {",
    "-  return items.reduce((sum, item) => sum + item.price, 0);",
    "+  const raw = items.reduce((sum, item) => sum + item.price, 0);",
    "+  return roundCents(raw);",
    " }",
  ].join("\n"),
  "src/cart/total.test.ts": [
    "diff --git a/src/cart/total.test.ts b/src/cart/total.test.ts",
    "--- a/src/cart/total.test.ts",
    "+++ b/src/cart/total.test.ts",
    '@@ -8,6 +8,12 @@ describe("total", () => {',
    '   it("sums item prices", () => {',
    "     expect(total([{ price: 10 }, { price: 9.99 }])).toBe(19.99);",
    "   });",
    "+",
    '+  it("rounds floating point drift to cents", () => {',
    "+    const items = [{ price: 0.1 }, { price: 0.2 }, { price: 19.7 }];",
    "+    expect(total(items)).toBe(20);",
    "+  });",
    " });",
  ].join("\n"),
  "src/cart/currency.ts": [
    "diff --git a/src/cart/currency.ts b/src/cart/currency.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/cart/currency.ts",
    "@@ -0,0 +1,4 @@",
    "+/** Round a float amount to whole cents, avoiding binary drift. */",
    "+export function roundCents(amount: number): number {",
    "+  return Math.round(amount * 100) / 100;",
    "+}",
  ].join("\n"),
  "README.md": [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -12,6 +12,8 @@ A tiny checkout demo used by the ORC preview screenshots.",
    " - `bun test` runs the cart suite",
    " - `bun run dev` serves the storefront",
    " ",
    "+Amounts are rounded to cents at the cart boundary; see `src/cart/currency.ts`.",
    "+",
    " ## Layout",
  ].join("\n"),
  "notes/rounding.md": [
    "diff --git a/notes/rounding.md b/notes/rounding.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/notes/rounding.md",
    "@@ -0,0 +1,3 @@",
    "+# Rounding follow-ups",
    "+",
    "+- Check tax rounding at the line level before the next release.",
  ].join("\n"),
};

async function demo(page: Page) {
  await page.addInitScript(() => {
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
  });
  await page.route("**/api/chat/models?**", (r) =>
    r.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/capabilities?**", (r) =>
    r.fulfill({
      json: {
        backend: "claude-code",
        capabilities: {
          version: 1,
          source: "adapter",
          resume: true,
          modelSelection: true,
          images: true,
          toolOutput: true,
          approvals: true,
          questions: true,
          livePermissions: true,
          interrupt: true,
          steering: true,
          mcp: true,
          fork: false,
          rollback: false,
        },
      },
    }),
  );
  await page.route("**/api/chat/threads", (r) =>
    r.fulfill({
      json: {
        threads: [
          {
            id: CHAT,
            title: thread.title,
            updatedAt: thread.updatedAt,
            running: false,
            agent: "claude",
          },
        ],
      },
    }),
  );
  await page.route(`**/api/chat/threads/${CHAT}`, (r) => r.fulfill({ json: thread }));
  await page.route(`**/api/chat/threads/${CHAT}/live`, (r) => r.fulfill({ status: 204 }));
  await page.route("**/api/sessions/live?**", (r) =>
    r.fulfill({ json: { sessions: [], total: 0, has_more: false } }),
  );
  await page.route("**/api/sessions/archive?**", (r) =>
    r.fulfill({ json: { sessions: [], has_more: false } }),
  );
  await page.route(/\/api\/terminals(\?.*)?$/, (r) =>
    r.request().method() === "GET"
      ? r.fulfill({
          json: {
            enabled: true,
            ready: true,
            reason: null,
            launchers: ["shell", "claude"],
            host: null,
            terminals: [
              {
                id: TERMINAL,
                name: "Claude: cart rounding",
                kind: "claude",
                cwd: FOLDER,
                status: "running",
                exit_code: null,
                pid: 4242,
                live_session_id: null,
                host: null,
                created_at: new Date(now - 40 * 60_000).toISOString(),
              },
            ],
          },
        })
      : r.fallback(),
  );
  await page.route(`**/api/terminals/${TERMINAL}/git/status`, (r) =>
    r.fulfill({
      json: {
        root: FOLDER,
        branch: "fix/cart-rounding",
        files,
        branches: ["main", "fix/cart-rounding"],
      },
    }),
  );
  await page.route(`**/api/terminals/${TERMINAL}/git/github`, (r) =>
    r.fulfill({ json: { auth: "gh", login: "demo", items: [], errors: [], truncated: false } }),
  );
  await page.route(`**/api/terminals/${TERMINAL}/git/worktrees`, (r) =>
    r.fulfill({
      json: {
        root: FOLDER,
        worktrees: [
          {
            path: FOLDER,
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
  await page.route(`**/api/terminals/${TERMINAL}/git/diff?**`, (r) => {
    const url = new URL(r.request().url());
    const path = url.searchParams.get("path") ?? "";
    return r.fulfill({ json: { diff: diffs[path] ?? "", truncated: false } });
  });
  await page.route("**/api/desktop-preview/session?**", (r) =>
    r.fulfill({ json: { id: CHAT, cwd: FOLDER, host: null, projectId: null } }),
  );
  await page.route("**/api/desktop-preview/clients", (r) =>
    r.fulfill({ json: { client_id: "capture-preview", lease: "capture-lease" } }),
  );
  await page.route("**/api/desktop-preview/clients/*/requests", (r) =>
    r.fulfill({ json: { requests: [] } }),
  );
  await page.route("**/api/desktop-preview/clients/*/close", (r) => r.fulfill({ json: {} }));
}

const browser = await chromium.launch();
const errors: string[] = [];

async function shoot(
  name: string,
  opts: {
    width: number;
    height: number;
    panelWidth?: number;
    theme?: "dark" | "light";
    out?: string;
    selectFile?: string;
  },
) {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.width < 700 ? 2 : 1,
    isMobile: opts.width < 700,
    hasTouch: opts.width < 700,
  });
  await context.addInitScript(
    ({ theme, panelWidth }) => {
      localStorage.setItem("orc_theme", theme);
      if (panelWidth) localStorage.setItem("orc_preview_width", String(panelWidth));
    },
    { theme: opts.theme ?? "dark", panelWidth: opts.panelWidth ?? null },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(`${name}: HTTP ${response.status()} ${response.url()}`);
  });
  await demo(page);
  await page.goto(`${BASE}/chat?project=all&chatThread=${CHAT}`);
  await page.getByTestId("chat-preview-toggle").click();
  await page.getByTestId("desktop-preview-panel").waitFor({ state: "visible" });
  await page.getByTestId("preview-changes-tab").click();
  await page.getByTestId("terminal-git-panel").waitFor({ state: "visible" });
  await page.getByTestId("git-diff-working-section").first().waitFor({ state: "visible" });
  if (opts.selectFile) {
    const entry = page.locator(`[data-testid="git-change-entry"][data-path="${opts.selectFile}"]`);
    // Combined layouts keep the file list behind the files toggle.
    if (await entry.isVisible()) await entry.click();
  }
  await page.waitForTimeout(700);
  await page.screenshot({
    path: join(opts.out ?? OUT, `${name}.png`),
    animations: "disabled",
  });
  console.log(`captured ${name}`);
  await context.close();
}

await shoot("desktop-preview-changes-wide", {
  width: 1600,
  height: 900,
  panelWidth: 860,
  selectFile: "src/cart/total.ts",
});
await shoot("desktop-preview-changes-narrow", {
  width: 1280,
  height: 800,
  selectFile: "src/cart/total.ts",
});
await shoot("desktop-preview-changes-phone", { width: 390, height: 844 });
// Theme verification copy (kept out of the published docs).
await shoot("desktop-preview-changes-light", {
  width: 1600,
  height: 900,
  panelWidth: 860,
  theme: "light",
  selectFile: "src/cart/total.ts",
  out: join(repoRoot, ".claude", "previews"),
});

/** Captures the chat surface itself, without opening the preview panel. */
async function shootChat(
  name: string,
  path: string,
  opts: { width: number; height: number; theme?: "dark" | "light"; out?: string },
) {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.width < 700 ? 2 : 1,
    isMobile: opts.width < 700,
    hasTouch: opts.width < 700,
  });
  await context.addInitScript(({ theme }) => localStorage.setItem("orc_theme", theme), {
    theme: opts.theme ?? "dark",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(`${name}: HTTP ${response.status()} ${response.url()}`);
  });
  await demo(page);
  await page.goto(`${BASE}${path}`);
  await page.getByTestId("chat-panel").waitFor({ state: "visible" });
  await page.waitForTimeout(700);
  await page.screenshot({
    path: join(opts.out ?? OUT, `${name}.png`),
    animations: "disabled",
  });
  console.log(`captured ${name}`);
  await context.close();
}

// The preview panel belongs to the chat page; the side chat stays plain (#293).
await shootChat("desktop-side-chat-plain", `/activity?project=all&chat=open&chatThread=${CHAT}`, {
  width: 1600,
  height: 900,
});
await shootChat("phone-chat-preview-closed", `/chat?project=all&chatThread=${CHAT}`, {
  width: 390,
  height: 844,
});

await browser.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("done");
