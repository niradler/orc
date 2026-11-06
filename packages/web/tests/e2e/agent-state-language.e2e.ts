import { expect, type Page, test } from "@playwright/test";
import { openChatHistory } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

const now = Date.now();
const demo = [
  {
    name: "Approve database migration",
    status: "running",
    wait: true,
    state: "needs-you",
    label: "Needs you",
  },
  { name: "Fix flaky login test", status: "error", wait: false, state: "failed", label: "Failed" },
  {
    name: "Refactor payment adapter",
    status: "running",
    wait: false,
    state: "working",
    label: "Working",
  },
  { name: "Write release notes", status: "idle", wait: false, state: "idle", label: "Idle" },
] as const;
const sessions = demo.map((s, i) => ({
  id: `state-live-${i}`,
  session_id: `1000000${i}-0000-4000-8000-00000000000${i}`,
  name: s.name,
  agent: "claude",
  status: s.status,
  waiting_for_human: s.wait,
  cwd: "/home/demo/acme-shop",
  host: null,
  project_id: null,
  task_id: null,
  task: null,
  handoff: null,
  summary: null,
  tokens_used: 1000,
  tokens_estimated: false,
  created_at: new Date(now - (i + 30) * 60_000).toISOString(),
  last_activity_at: new Date(now - (i + 1) * 60_000).toISOString(),
}));

async function mockSessions(page: Page) {
  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
  }, API_SECRET);
  await page.route("**/api/chat/models?**", (r) =>
    r.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/sessions/live?**", (r) =>
    r.fulfill({ json: { sessions, total: sessions.length, has_more: false } }),
  );
  await page.route("**/api/sessions/archive?**", (r) =>
    r.fulfill({ json: { sessions: [], has_more: false } }),
  );
}

test("Watch: every session surface speaks the same state word and icon, and the tab title counts Needs you", async ({
  page,
}) => {
  await mockSessions(page);
  await page.goto("/sessions");
  await expect(page).toHaveTitle(/^\(1\) /);

  const icons = new Map<string, string>();
  for (const s of demo) {
    const row = page.locator(
      `[data-testid="live-session-row"][data-session-id="${sessions[demo.indexOf(s)].session_id}"]`,
    );
    const badge = row.getByTestId("live-status").getByTestId("state-badge");
    await expect(badge).toHaveAttribute("data-state", s.state);
    await expect(badge).toHaveText(s.label);
    icons.set(s.state, (await badge.locator("svg").getAttribute("class")) ?? "");
  }
  const shapes = [...icons.values()].map((c) => c.match(/lucide-[a-z-]+/g)?.at(-1));
  expect(new Set(shapes).size).toBe(demo.length);

  await page.goto("/tasks?chat=full");
  await openChatHistory(page);
  const list = page.getByTestId("chat-session-list");
  for (const s of demo) {
    const row = list.getByTestId("chat-history-row").filter({ hasText: s.name });
    const badge = row.getByTestId("chat-session-status");
    await expect(badge).toHaveAttribute("data-state", s.state);
    await expect(badge).toHaveAttribute("aria-label", `claude · ${s.label}`);
    const shape = (await badge.locator("svg").getAttribute("class"))
      ?.match(/lucide-[a-z-]+/g)
      ?.at(-1);
    expect(shape).toBe(
      icons
        .get(s.state)
        ?.match(/lucide-[a-z-]+/g)
        ?.at(-1),
    );
  }
  await expect(page).toHaveTitle(/^\(1\) /);
});
