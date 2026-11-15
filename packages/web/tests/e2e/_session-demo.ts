import { ChatSettingsSchema } from "@orc/core/chat";
import type { APIRequestContext, Page, Route } from "@playwright/test";
import { API_SECRET, apiPost, tid } from "./_helpers";

type Status = "running" | "idle" | "error" | "stopped";
type DemoSession = {
  name: string;
  agent: "claude" | "codex";
  status: Status;
  wait: boolean;
  ago: number;
  project: 0 | 1 | 2;
};

export const SEEN_KEY = "orc_session_seen";

export const DEMO: DemoSession[] = [
  {
    name: "Approve database migration",
    agent: "claude",
    status: "running",
    wait: true,
    ago: 2,
    project: 0,
  },
  {
    name: "Fix flaky login test",
    agent: "codex",
    status: "error",
    wait: false,
    ago: 4,
    project: 1,
  },
  {
    name: "Refactor payment adapter",
    agent: "codex",
    status: "running",
    wait: false,
    ago: 1,
    project: 1,
  },
  { name: "Write release notes", agent: "claude", status: "idle", wait: false, ago: 6, project: 2 },
  {
    name: "Answer schema question",
    agent: "claude",
    status: "running",
    wait: true,
    ago: 8,
    project: 2,
  },
  { name: "Migrate CI to Bun", agent: "codex", status: "running", wait: false, ago: 3, project: 0 },
  {
    name: "Review API pagination",
    agent: "claude",
    status: "idle",
    wait: false,
    ago: 12,
    project: 0,
  },
  {
    name: "Update onboarding docs",
    agent: "claude",
    status: "idle",
    wait: false,
    ago: 20,
    project: 2,
  },
  {
    name: "Upgrade build tooling",
    agent: "codex",
    status: "stopped",
    wait: false,
    ago: 45,
    project: 1,
  },
  {
    name: "Tune search ranking",
    agent: "claude",
    status: "running",
    wait: false,
    ago: 0.5,
    project: 0,
  },
];

export type LiveRow = ReturnType<typeof liveRows>[number];

export function liveRows(projects: string[], now = Date.now()) {
  const iso = (ago: number) => new Date(now - ago * 60_000).toISOString();
  return DEMO.map((s, i) => ({
    id: `demo-live-${i}`,
    session_id: `0000000${i}-0000-4000-8000-00000000000${i}`,
    name: s.name,
    agent: s.agent,
    status: s.status as Status,
    waiting_for_human: s.wait,
    cwd: `/home/demo/${["acme-shop", "billing-api", "docs-site"][s.project]}`,
    host: null,
    project_id: projects[s.project] ?? null,
    task_id: null,
    task: null,
    handoff: null,
    summary: null,
    tokens_used: 18_000 + i * 3_100,
    tokens_estimated: false,
    created_at: iso(s.ago + 30),
    last_activity_at: iso(s.ago),
  }));
}

export async function demoProjects(request: APIRequestContext): Promise<string[]> {
  const created = [];
  for (const name of ["acme-shop", "billing-api", "docs-site"])
    created.push((await apiPost<{ id: string }>(request, "/projects", { name: tid(name) })).id);
  return created;
}

/** The returned array is live: mutate it and call `push` to deliver a sessions change event. */
export async function mockDemo(
  page: Page,
  sessions: LiveRow[],
  options: { since?: number; seen?: Record<string, number> } = {},
) {
  await page.addInitScript(
    ({ secret, key, seen }) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
      if (seen && !sessionStorage.getItem("demo-seeded")) {
        sessionStorage.setItem("demo-seeded", "1");
        localStorage.setItem(key, JSON.stringify(seen));
      }
    },
    {
      secret: API_SECRET,
      key: SEEN_KEY,
      seen: options.since ? { since: options.since, seen: options.seen ?? {} } : null,
    },
  );
  await page.route("**/api/chat/models?**", (r) =>
    r.fulfill({ json: { models: [], warning: null } }),
  );
  const resumed: string[] = [];
  await page.route("**/api/chat/threads", (r) => {
    if (r.request().method() !== "POST") return r.fulfill({ json: { threads: [] } });
    const { sourceSessionId } = r.request().postDataJSON() as { sourceSessionId: string };
    resumed.push(sourceSessionId);
    const index = sessions.findIndex((item) => item.id === sourceSessionId);
    const session = sessions[index];
    return r.fulfill({
      json: {
        id: `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        title: session?.name ?? sourceSessionId,
        config: ChatSettingsSchema.parse({ agent: session?.agent ?? "claude", model: "" }),
        cwd: session?.cwd ?? "/fixture",
        host: null,
        runtimeId: session?.session_id ?? null,
        sourceId: sourceSessionId,
        backend: session?.agent === "codex" ? "codex" : "claude-code",
        projectId: session?.project_id ?? undefined,
        updatedAt: Date.now(),
        messages: [],
      },
    });
  });
  await page.route("**/api/chat/threads/*/live", (r) => r.fulfill({ status: 204 }));
  await page.route("**/api/sessions/live?**", (r) =>
    r.fulfill({ json: { sessions, total: sessions.length, has_more: false } }),
  );
  await page.route(/\/api\/sessions\/live\/([^/?]+)$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const session = sessions.find((item) => item.id === id);
    return session ? route.fulfill({ json: session }) : route.fallback();
  });
  await page.route("**/api/sessions/live/*/transcript?**", (r) =>
    r.fulfill({ json: { total: 0, offset: 0, matches: [], turns: [] } }),
  );
  await page.route("**/api/sessions/archive?**", (r) =>
    r.fulfill({ json: { sessions: [], has_more: false } }),
  );
  const waiting: Route[] = [];
  await page.route("**/api/events", (route) => {
    waiting.push(route);
  });
  return {
    resumed,
    async push() {
      for (let i = 0; i < 100 && !waiting.length; i++) await page.waitForTimeout(100);
      const route = waiting.pop();
      waiting.length = 0;
      if (!route) throw new Error("No resource event stream is open");
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: 'event: change\ndata: {"resources":["sessions"]}\n\n',
      });
    },
  };
}
