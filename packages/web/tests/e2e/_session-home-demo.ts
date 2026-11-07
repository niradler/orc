import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import type { Page } from "@playwright/test";
import { API_SECRET } from "./_helpers";

export const HOME = {
  chatA: "50000000-0000-4000-8000-000000000001",
  chatB: "50000000-0000-4000-8000-000000000002",
  claudeLive: "home-claude",
  codexLive: "home-codex",
  terminal: "home-terminal",
};

function thread(id: string, title: string, answer: string, updatedAt: number): ChatThread {
  return {
    id,
    title,
    config: ChatSettingsSchema.parse({ agent: "claude" }),
    cwd: "/home/demo/acme-shop",
    host: null,
    runtimeId: null,
    sourceId: null,
    backend: "claude-code",
    updatedAt,
    messages: [
      {
        id: `${id}-q`,
        role: "user",
        content: `Please ${title.toLowerCase()}.`,
        timestamp: updatedAt,
      },
      { id: `${id}-a`, role: "assistant", content: answer, timestamp: updatedAt },
    ],
  };
}

/** Two chats, one Claude agent in an ORC terminal and one Codex session started outside ORC. */
export async function mockSessionHome(page: Page, now = Date.now()) {
  const iso = (ago: number) => new Date(now - ago * 60_000).toISOString();
  const chats = [
    thread(
      HOME.chatA,
      "Plan the checkout redesign",
      "Here is the checkout plan.",
      now - 3 * 60_000,
    ),
    thread(
      HOME.chatB,
      "Summarize open billing bugs",
      "Three billing bugs are open.",
      now - 9 * 60_000,
    ),
  ];
  const live = [
    {
      id: HOME.claudeLive,
      session_id: "60000000-0000-4000-8000-000000000001",
      name: "Fix the cart total rounding",
      agent: "claude",
      status: "running",
      waiting_for_human: false,
      cwd: "/home/demo/acme-shop",
      host: null,
      project_id: null,
      task_id: null,
      task: null,
      handoff: null,
      summary: null,
      tokens_used: 21_000,
      tokens_estimated: false,
      created_at: iso(40),
      last_activity_at: iso(1),
    },
    {
      id: HOME.codexLive,
      session_id: "60000000-0000-4000-8000-000000000002",
      name: "Upgrade the payments SDK",
      agent: "codex",
      status: "running",
      waiting_for_human: true,
      cwd: "/home/demo/billing-api",
      host: null,
      project_id: null,
      task_id: null,
      task: null,
      handoff: null,
      summary: null,
      tokens_used: 34_000,
      tokens_estimated: false,
      created_at: iso(50),
      last_activity_at: iso(2),
    },
  ];
  const terminal = {
    id: HOME.terminal,
    name: "Claude: cart rounding",
    kind: "claude",
    cwd: "/home/demo/acme-shop",
    status: "running",
    exit_code: null,
    pid: 4242,
    live_session_id: HOME.claudeLive,
    host: null,
    created_at: iso(40),
  };
  await page.addInitScript(
    ({ secret }) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
    },
    { secret: API_SECRET },
  );
  await page.route("**/api/chat/models?**", (r) =>
    r.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/threads", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({
          json: {
            threads: chats.map((chat) => ({
              id: chat.id,
              title: chat.title,
              updatedAt: chat.updatedAt,
              running: false,
              agent: "claude",
            })),
          },
        })
      : r.fulfill({
          json: {
            ...thread(HOME.chatB, "Upgrade the payments SDK", "Resumed.", now),
            id: resumed,
            sourceId: HOME.codexLive,
          },
        }),
  );
  const resumed = "50000000-0000-4000-8000-000000000003";
  await page.route(`**/api/chat/threads/${resumed}/live`, (r) => r.fulfill({ status: 204 }));
  for (const chat of chats) {
    await page.route(`**/api/chat/threads/${chat.id}`, (r) => r.fulfill({ json: chat }));
    await page.route(`**/api/chat/threads/${chat.id}/live`, (r) => r.fulfill({ status: 204 }));
  }
  await page.route("**/api/sessions/live?**", (r) =>
    r.fulfill({ json: { sessions: live, total: live.length, has_more: false } }),
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
            launchers: ["shell", "claude", "codex"],
            host: null,
            terminals: [terminal],
          },
        })
      : r.fallback(),
  );
  await page.route(`**/api/terminals/${HOME.terminal}/git/status`, (r) =>
    r.fulfill({
      json: {
        root: "/home/demo/acme-shop",
        branch: "fix/cart-rounding",
        files: [{ path: "src/cart/total.ts", index: " ", working: "M", original: null }],
        branches: ["main", "fix/cart-rounding"],
      },
    }),
  );
  await page.route(`**/api/terminals/${HOME.terminal}/git/github`, (r) =>
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
          },
        ],
        errors: [],
        truncated: false,
      },
    }),
  );
  await page.route(`**/api/terminals/${HOME.terminal}/git/diff?**`, (r) =>
    r.fulfill({
      json: {
        diff: [
          "diff --git a/src/cart/total.ts b/src/cart/total.ts",
          "--- a/src/cart/total.ts",
          "+++ b/src/cart/total.ts",
          "@@ -1,3 +1,3 @@",
          " export function total(items: Item[]) {",
          "-  return items.reduce((sum, item) => sum + item.price, 0);",
          "+  return Math.round(items.reduce((sum, item) => sum + item.price, 0) * 100) / 100;",
          " }",
        ].join("\n"),
        truncated: false,
      },
    }),
  );
  return { chats, live, terminal };
}
