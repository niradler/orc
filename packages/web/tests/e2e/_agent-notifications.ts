import { type HumanRequest, HumanRequestSchema } from "@orc/core/human-requests";
import type { OrcNotification } from "@orc/core/notifications";
import type { Page } from "@playwright/test";
import { API_SECRET } from "./_helpers";

const now = Date.parse("2026-11-06T09:00:00Z");

export function liveSession(index: number, status: string, waiting = false) {
  return {
    id: `notify-live-${index}`,
    session_id: `notify-native-${index}`,
    name: ["Migrate billing tables", "Fix flaky login test", "Write release notes", "Bump deps"][
      index
    ],
    agent: "codex",
    status,
    waiting_for_human: waiting,
    cwd: "/home/demo/acme-shop",
    host: null,
    project_id: null,
    task_id: null,
    task: null,
    handoff: null,
    summary: null,
    tokens_used: 1000,
    tokens_estimated: false,
    created_at: new Date(now - 60 * 60_000).toISOString(),
    last_activity_at: new Date(now - 60_000).toISOString(),
  };
}

export function approvalRequest(index = 0): HumanRequest {
  return HumanRequestSchema.parse({
    id: `notify-approval-${index}`,
    input: {
      kind: "approval",
      title: "Run the database migration",
      prompt: "Allow the agent to run the billing migration against the staging database?",
      origin: {
        backend: "codex",
        session_id: `notify-native-${index}`,
        request_id: `notify-request-${index}`,
        session_title: liveSession(index, "running").name,
      },
      action: {
        tool: "command",
        cwd: "/home/demo/acme-shop",
        host: "local",
        input: { command: "bun run db:migrate --env staging" },
      },
    },
    status: "pending",
    version: 1,
    response: null,
    created_at: now,
    expires_at: now + 86_400_000,
    responded_at: null,
    delivered_at: null,
  });
}

export type ScenarioState = {
  sessions: ReturnType<typeof liveSession>[];
  requests: HumanRequest[];
};

/** Mocks every source the notifier reads and counts synthesized chime notes. */
export async function notificationScenario(page: Page, initial: ScenarioState) {
  const state = { ...initial };
  const notifications = new Map<string, OrcNotification>();
  const snapshot = () => {
    for (const request of state.requests) {
      const id = `notification-${request.id}`;
      const previous = notifications.get(id);
      notifications.set(id, {
        id,
        type: "human.request",
        source_id: request.id,
        title: request.input.title || "Human request",
        body: request.input.origin.session_title || "",
        level: "needs-you",
        project_id: null,
        path: `/activity?notifications=open&request=${request.id}`,
        requires_action: request.status === "pending",
        created_at: now,
        expires_at: now + 30 * 86400000,
        read_at: previous?.read_at ?? null,
        dismissed_at: previous?.dismissed_at ?? null,
      });
    }
    for (const session of state.sessions.filter((session) => session.status === "idle")) {
      const id = `notification-${session.id}`;
      if (!notifications.has(id))
        notifications.set(id, {
          id,
          type: "agent.finished",
          source_id: session.id,
          title: session.name,
          body: "The agent finished its turn.",
          level: "done",
          project_id: null,
          path: `/sessions?session=${session.id}&project=all`,
          requires_action: false,
          created_at: now,
          expires_at: now + 30 * 86400000,
          read_at: null,
          dismissed_at: null,
        });
    }
    return [...notifications.values()].filter((item) => !item.dismissed_at);
  };
  const responses: Array<{ id: string; body: unknown }> = [];
  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
    const win = window as unknown as { __chimeNotes: number; AudioContext: unknown };
    win.__chimeNotes = 0;
    const param = () => ({
      value: 0,
      setValueAtTime() {},
      exponentialRampToValueAtTime() {},
    });
    const node = () => ({
      gain: param(),
      frequency: param(),
      type: "sine",
      connect: (target: unknown) => target,
      start() {
        win.__chimeNotes++;
      },
      stop() {},
    });
    win.AudioContext = class {
      state = "suspended";
      destination = {};
      get currentTime() {
        return performance.now() / 1000;
      }
      resume() {
        this.state = "running";
        return Promise.resolve();
      }
      createGain() {
        return node();
      }
      createOscillator() {
        return node();
      }
    };
  }, API_SECRET);
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/waiting", (route) => route.fulfill({ json: { waiting: [] } }));
  await page.route("**/api/notifications?**", (route) => {
    const notifications = snapshot();
    return route.fulfill({
      json: {
        notifications,
        unread: notifications.filter((item) => !item.read_at).length,
        has_more: false,
      },
    });
  });
  await page.route("**/api/notifications/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    const item = notifications.get(id);
    if (!item) return route.fulfill({ status: 404, json: { error: "Unknown notification" } });
    const update = route.request().postDataJSON();
    if (update.read !== undefined) item.read_at = update.read ? now : null;
    if (update.dismissed !== undefined) item.dismissed_at = update.dismissed ? now : null;
    return route.fulfill({ json: item });
  });
  await page.route("**/api/sessions/live?**", (route) =>
    route.fulfill({
      json: { sessions: state.sessions, total: state.sessions.length, has_more: false },
    }),
  );
  await page.route("**/api/sessions/archive?**", (route) =>
    route.fulfill({ json: { sessions: [], has_more: false } }),
  );
  await page.route("**/api/human-requests", (route) =>
    route.fulfill({ json: state.requests.filter((request) => request.status === "pending") }),
  );
  await page.route("**/api/human-requests/*/view", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    return route.fulfill({ json: state.requests.find((item) => item.id === id) });
  });
  await page.route("**/api/human-requests/*/respond", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    const body = route.request().postDataJSON() as { version: number };
    responses.push({ id, body });
    const request = state.requests.find((candidate) => candidate.id === id);
    if (!request || request.version !== body.version)
      return route.fulfill({ status: 409, json: { error: "Request changed" } });
    const answered = { ...request, status: "answered" as const, version: request.version + 1 };
    state.requests = state.requests.map((candidate) =>
      candidate.id === id ? answered : candidate,
    );
    return route.fulfill({ json: answered });
  });
  return {
    state,
    responses,
    chimeNotes: () =>
      page.evaluate(() => (window as unknown as { __chimeNotes: number }).__chimeNotes),
  };
}

/** Waits for the first snapshot of every notifier source so later changes are real changes. */
export function sourcesLoaded(page: Page) {
  return Promise.all(
    ["/api/human-requests", "/api/notifications?", "/api/sessions/live?"].map((path) =>
      page.waitForResponse((response) => response.url().includes(path)),
    ),
  );
}

/** Yields a real macrotask; the fake clock does not own MessageChannel. */
function realTurn(page: Page) {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(undefined);
      }),
  );
}

/** Reconnects the shared stream so its `ready` event refetches every notifier source. */
export async function poll(page: Page) {
  const loaded = sourcesLoaded(page);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  // Aborting the stream is async and schedules the 0 ms reconnect only after it settles,
  // so give the page real turns while advancing the fake clock that owns that timer.
  for (let attempt = 0; attempt < 5; attempt++) {
    await realTurn(page);
    await page.clock.fastForward(10);
  }
  await loaded;
  // Let React commit the refreshed data before the feed's 1 s hold window is evaluated.
  await realTurn(page);
  // NotificationFeed holds new items for 1 s and flushes on a 250 ms timer.
  await page.clock.fastForward(1_100);
}
