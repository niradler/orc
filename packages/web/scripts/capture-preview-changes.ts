/**
 * Captures the single inspector from a dev server with demo data: the desktop
 * Overview, Changes (working tree and PR review) and phone tabs. The Browser
 * tab is desktop-only and needs the Electron bridge, so a stub bridge plus
 * mocked session/terminal/git/project routes provide the demo state; nothing
 * here touches a real workspace. Pair with an isolated dev API (see .env:
 * 7711/3087).
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
const PROJECT = "60000000-0000-4000-8000-0000000000b1";
const TERMINAL = "preview-changes-demo";
const FOLDER = "/home/demo/acme-shop";
const now = Date.now();

const thread = {
  id: CHAT,
  title: "Fix the cart total rounding",
  config: ChatSettingsSchema.parse({ agent: "claude" }),
  cwd: FOLDER,
  projectId: PROJECT,
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

const fileTree: Record<string, { name: string; path: string; directory: boolean }[]> = {
  "": [
    { name: "src", path: "src", directory: true },
    { name: "notes", path: "notes", directory: true },
    { name: "README.md", path: "README.md", directory: false },
    { name: "package.json", path: "package.json", directory: false },
  ],
  src: [{ name: "cart", path: "src/cart", directory: true }],
  "src/cart": [
    { name: "currency.ts", path: "src/cart/currency.ts", directory: false },
    { name: "total.test.ts", path: "src/cart/total.test.ts", directory: false },
    { name: "total.ts", path: "src/cart/total.ts", directory: false },
  ],
  notes: [{ name: "rounding.md", path: "notes/rounding.md", directory: false }],
};

const fileContents: Record<string, string> = {
  "src/cart/total.ts": [
    'import type { Item } from "./types";',
    'import { roundCents } from "./currency";',
    "",
    "export function total(items: Item[]) {",
    "  const raw = items.reduce((sum, item) => sum + item.price, 0);",
    "  return roundCents(raw);",
    "}",
    "",
  ].join("\n"),
  "src/cart/total.test.ts": [
    'import { describe, expect, it } from "bun:test";',
    'import { total } from "./total";',
    "",
    'describe("total", () => {',
    '  it("sums item prices", () => {',
    "    expect(total([{ price: 10 }, { price: 9.99 }])).toBe(19.99);",
    "  });",
    "",
    '  it("rounds floating point drift to cents", () => {',
    "    const items = [{ price: 0.1 }, { price: 0.2 }, { price: 19.7 }];",
    "    expect(total(items)).toBe(20);",
    "  });",
    "});",
    "",
  ].join("\n"),
  "src/cart/currency.ts": [
    "/** Round a float amount to whole cents, avoiding binary drift. */",
    "export function roundCents(amount: number): number {",
    "  return Math.round(amount * 100) / 100;",
    "}",
    "",
  ].join("\n"),
  "README.md": [
    "# Acme Shop",
    "",
    "A tiny checkout demo used by the ORC preview screenshots.",
    "",
    "- `bun test` runs the cart suite",
    "- `bun run dev` serves the storefront",
    "",
    "Amounts are rounded to cents at the cart boundary; see `src/cart/currency.ts`.",
    "",
    "## Layout",
    "",
  ].join("\n"),
  "notes/rounding.md": [
    "# Rounding follow-ups",
    "",
    "- Check tax rounding at the line level before the next release.",
    "",
  ].join("\n"),
};

const pull = {
  repo: "acme/shop",
  number: 418,
  title: "Round cart totals to cents",
  body: "Closes #412.\n\n`total()` summed raw floats, so tax at 8.25% produced 19.999999998.\nRounds once at the cart boundary and adds a regression test.",
  state: "open",
  url: "https://github.com/acme/shop/pull/418",
  author: "demo",
  head: "8f3c1a9d2e4b6c7d8e9f0a1b2c3d4e5f60718293",
  branch: "fix/cart-rounding",
  base: "main",
  changed_files: 3,
  files: [
    {
      filename: "src/cart/total.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      patch: [
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
      patch_truncated: false,
    },
    {
      filename: "src/cart/currency.ts",
      status: "added",
      additions: 4,
      deletions: 0,
      patch: [
        "@@ -0,0 +1,4 @@",
        "+/** Round a float amount to whole cents, avoiding binary drift. */",
        "+export function roundCents(amount: number): number {",
        "+  return Math.round(amount * 100) / 100;",
        "+}",
      ].join("\n"),
      patch_truncated: false,
    },
    {
      filename: "src/cart/total.test.ts",
      status: "modified",
      additions: 6,
      deletions: 0,
      patch: [
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
      patch_truncated: false,
    },
  ],
  comments: [
    {
      id: 9001,
      body: "Rounding at the boundary reads well. One nit: `roundCents` could be shared with invoice totals.",
      user: { login: "octo-reviewer" },
      html_url: "https://github.com/acme/shop/pull/418#discussion_r9001",
      created_at: new Date(now - 12 * 60_000).toISOString(),
      path: "src/cart/currency.ts",
      line: 3,
      original_line: 3,
      side: "RIGHT",
    },
  ],
  discussion: [
    {
      id: 9002,
      body: "Added the regression test from the issue. CI is green on all six checks.",
      user: { login: "demo" },
      html_url: "https://github.com/acme/shop/pull/418#issuecomment-9002",
      created_at: new Date(now - 9 * 60_000).toISOString(),
    },
  ],
  reviews: [
    {
      id: 9003,
      body: "Approving — the drift case is covered now.",
      user: { login: "octo-reviewer" },
      html_url: "https://github.com/acme/shop/pull/418#pullrequestreview-9003",
      created_at: new Date(now - 6 * 60_000).toISOString(),
      state: "APPROVED",
    },
  ],
  truncated: false,
};

async function demo(page: Page, desktop = true) {
  if (desktop)
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
            read: async () => null,
            release: async () => {},
            save: async () => {},
            open: async () => null,
            tab: async () => null,
            navigate: async () => {},
            display: async () => ({}),
            control: async () => ({}),
            upload: async () => ({}),
            pageDialog: async () => {},
            externalUrl: async () => {},
            externalFile: async () => {},
          },
        },
      });
    });
  await page.route(/\/api\/projects(\?.*)?$/, (r) =>
    r.fulfill({
      json: {
        projects: [
          {
            id: PROJECT,
            name: "Acme Shop",
            description: "Checkout demo for the preview screenshots",
            status: "active",
            tags: [],
            created_at: new Date(now - 30 * 24 * 60 * 60_000).toISOString(),
            updated_at: new Date(now - 60_000).toISOString(),
          },
        ],
      },
    }),
  );
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
    r.fulfill({
      json: {
        auth: "gh",
        login: "demo",
        items: [
          {
            repo: "acme/shop",
            number: 418,
            title: "Round cart totals to cents",
            url: "https://github.com/acme/shop/pull/418",
            kind: "pr",
            state: "open",
            branch: "fix/cart-rounding",
            assignees: [],
            task_ids: [],
            ci: {
              state: "success",
              total: 6,
              url: "https://github.com/acme/shop/pull/418/checks",
            },
          },
        ],
        errors: [],
        truncated: false,
      },
    }),
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
  await page.route("**/api/git/worktrees?**", (r) =>
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
  await page.route(`**/api/terminals/${TERMINAL}/git/pulls/418`, (r) => r.fulfill({ json: pull }));
  await page.route(`**/api/terminals/${TERMINAL}/files?**`, (r) => {
    const path = new URL(r.request().url()).searchParams.get("path") ?? "";
    return r.fulfill({
      json: {
        root: FOLDER,
        path,
        entries: fileTree[path] ?? null,
        content: fileContents[path] ?? null,
        binary: false,
        truncated: false,
      },
    });
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

type InspectorTabId = "overview" | "diff" | "files" | "browser";

async function shoot(
  name: string,
  opts: {
    width: number;
    height: number;
    panelWidth?: number;
    theme?: "dark" | "light";
    out?: string;
    tab?: InspectorTabId;
    /** Open the combined Changes tab in PR review mode. */
    pr?: number;
    /** Open a checkout file in the Files tab. */
    file?: string;
    /** Markdown editor mode for the Files tab: read, edit or split. */
    editorMode?: "read" | "edit" | "split";
    selectFile?: string;
    /** Stub the Electron bridge; web and phone captures leave it out. */
    desktop?: boolean;
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
      if (panelWidth) localStorage.setItem("orc_session_inspector_width", String(panelWidth));
    },
    { theme: opts.theme ?? "dark", panelWidth: opts.panelWidth ?? null },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(`${name}: HTTP ${response.status()} ${response.url()}`);
  });
  await demo(page, opts.desktop ?? opts.width >= 700);
  const tab = opts.tab ?? "diff";
  const params = new URLSearchParams({ project: "all", chatThread: CHAT, inspector: tab });
  if (opts.pr) {
    params.set("pr", String(opts.pr));
    params.set("pane", "session-inspector");
    params.set("paneTerminal", TERMINAL);
    params.set("view", "git");
  }
  if (opts.file) {
    params.set("file", opts.file);
    params.set("pane", "session-inspector");
    params.set("paneTerminal", TERMINAL);
    params.set("view", "files");
  }
  if (opts.editorMode) params.set("editorMode", opts.editorMode);
  await page.goto(`${BASE}/chat?${params}`);
  await page.getByTestId("session-inspector").waitFor({ state: "visible" });
  if (tab === "diff") {
    await page.getByTestId("terminal-git-panel").waitFor({ state: "visible" });
    if (opts.pr) {
      await page.getByTestId("pr-status").waitFor({ state: "visible" });
      await page.getByTestId("pr-diff").first().waitFor({ state: "visible" });
    } else {
      await page.getByTestId("git-diff-working-section").first().waitFor({ state: "visible" });
      if (opts.selectFile) {
        const entry = page.locator(
          `[data-testid="git-change-entry"][data-path="${opts.selectFile}"]`,
        );
        // Combined layouts keep the file list behind the files toggle.
        if (await entry.isVisible()) await entry.click();
      }
    }
  } else if (tab === "files") {
    await page.getByTestId("file-panel").waitFor({ state: "visible" });
    await page.getByTestId(opts.file ? "file-editor" : "files-tree").waitFor({ state: "visible" });
  } else {
    await page.getByTestId("session-inspector-overview").waitFor({ state: "visible" });
  }
  await page.waitForTimeout(700);
  await page.screenshot({
    path: join(opts.out ?? OUT, `${name}.png`),
    animations: "disabled",
  });
  console.log(`captured ${name}`);
  await context.close();
}

// The single inspector on desktop, opened on its Overview tab.
await shoot("session-home-desktop", { width: 1440, height: 900, tab: "overview" });
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
// Markdown editing in the inspector's Files tab.
await shoot("desktop-preview-markdown", {
  width: 1600,
  height: 900,
  panelWidth: 700,
  tab: "files",
  file: "notes/rounding.md",
  editorMode: "edit",
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
// Review copies of the desktop PR review and Files tab (kept out of the docs).
await shoot("desktop-preview-pr-wide", {
  width: 1600,
  height: 900,
  panelWidth: 860,
  pr: 418,
  out: join(repoRoot, ".claude", "previews"),
});
await shoot("desktop-preview-files-wide", {
  width: 1600,
  height: 900,
  panelWidth: 760,
  tab: "files",
  file: "README.md",
  out: join(repoRoot, ".claude", "previews"),
});

// The phone inspector: Overview, Changes, PR review and Files (no Browser tab).
await shoot("session-inspector-phone", { width: 390, height: 844, tab: "overview" });
await shoot("session-inspector-changes-phone", {
  width: 390,
  height: 844,
  selectFile: "src/cart/total.ts",
});
await shoot("session-inspector-pr-phone", { width: 390, height: 844, pr: 418 });
await shoot("session-inspector-files-phone", {
  width: 390,
  height: 844,
  tab: "files",
  file: "src/cart/total.ts",
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
