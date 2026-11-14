import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, type Page, test } from "@playwright/test";
import { openChatActions } from "./_chat-ui";
import { gotoView } from "./_helpers";

const THREAD_ID = "70000000-0000-4000-8000-000000000001";
const NATIVE_ID = "native-continue";
const LIVE_ID = "live-continue";
const TERMINAL_ID = "continue-terminal";

type MockTerminal = {
  id: string;
  name: string;
  kind: string;
  cwd: string;
  host: string | null;
  status: "running" | "exited";
  pid: number;
  exit_code: number | null;
  live_session_id: string;
  created_at: string;
};

/** The chat page, one discoverable native session and a controllable terminal list. */
async function mockContinueTerminal(
  page: Page,
  options: {
    agent?: string;
    host?: string | null;
    sessionRunning?: boolean;
    discoverSession?: boolean;
    discoverAfterSync?: boolean;
    runtimeId?: string | null;
    createError?: string;
    terminals?: MockTerminal[];
  } = {},
) {
  const agent = options.agent ?? "codex";
  const host = options.host ?? null;
  const runtimeId = options.runtimeId === undefined ? NATIVE_ID : options.runtimeId;
  const now = Date.now();
  const thread: ChatThread = {
    id: THREAD_ID,
    title: "Continue round-trip",
    config: ChatSettingsSchema.parse({ agent }),
    backend: agent === "pi" ? "pi" : agent === "claude" ? "claude-code" : "codex-cli",
    runtimeId,
    sourceId: null,
    cwd: "/fixture",
    host,
    messages: [
      { id: "continue-q", role: "user", content: "Ship it.", timestamp: now - 1000 },
      { id: "continue-a", role: "assistant", content: "Ready.", timestamp: now },
    ],
    updatedAt: now,
  };
  const session = {
    id: LIVE_ID,
    session_id: NATIVE_ID,
    agent,
    status: "running",
    waiting_for_human: false,
    cwd: "/fixture",
    host,
    project_id: null,
    task_id: null,
    task: null,
    handoff: null,
    summary: null,
    tokens_used: 10,
    tokens_estimated: false,
    created_at: new Date(now - 60_000).toISOString(),
    last_activity_at: new Date(now).toISOString(),
  };
  const created: MockTerminal[] = [];
  const state = { posts: 0, includeHidden: false, discoveryCalls: 0 };

  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/threads", (route) =>
    route.fulfill({
      json: {
        threads: [
          {
            id: thread.id,
            title: thread.title,
            updatedAt: thread.updatedAt,
            running: false,
            agent,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/chat/threads/${THREAD_ID}`, (route) => route.fulfill({ json: thread }));
  await page.route(`**/api/chat/threads/${THREAD_ID}/live`, (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route(`**/api/chat/threads/${THREAD_ID}/session`, (route) =>
    route.fulfill({
      json: { changed: false, running: options.sessionRunning ?? false, queued: [] },
    }),
  );
  await page.route("**/api/sessions/live?**", (route) => {
    const url = new URL(route.request().url());
    const discovery = url.searchParams.get("include_hidden") === "true";
    if (discovery) {
      state.includeHidden = true;
      state.discoveryCalls += 1;
    }
    const found =
      options.discoverAfterSync === true
        ? state.discoveryCalls > 1
        : discovery && options.discoverSession === false
          ? false
          : options.discoverSession !== false;
    return route.fulfill({ json: { sessions: found ? [session] : [] } });
  });
  await page.route("**/api/sessions/live/sync", (route) =>
    route.fulfill({ json: { results: [] } }),
  );
  await page.route(/\/api\/terminals(\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      state.posts += 1;
      if (options.createError)
        return route.fulfill({ status: 409, json: { error: options.createError } });
      const terminal: MockTerminal = {
        id: TERMINAL_ID,
        name: "Codex: continue",
        kind: agent,
        cwd: "/fixture",
        host,
        status: "running",
        pid: 5000,
        exit_code: null,
        live_session_id: LIVE_ID,
        created_at: new Date().toISOString(),
      };
      created.push(terminal);
      return route.fulfill({ json: terminal });
    }
    return route.fulfill({
      json: {
        enabled: true,
        ready: true,
        reason: null,
        host,
        launchers: ["codex", "claude", "pi", "shell"],
        terminals: [...(options.terminals ?? []), ...created],
      },
    });
  });

  return { state, thread };
}

async function openContinueChat(page: Page, search = "") {
  await gotoView(page, "activity");
  await page.goto(`/chat?project=all&chatThread=${THREAD_ID}${search}`);
  await expect(page.getByTestId("chat-input").filter({ visible: true })).toBeVisible();
}

test("continues in the session terminal once, reuses it, and includes hidden sessions", async ({
  page,
}) => {
  const fixture = await mockContinueTerminal(page);
  await openContinueChat(page);

  await openChatActions(page);
  await page.getByTestId("chat-continue-terminal").filter({ visible: true }).dblclick();
  await expect(page).toHaveURL(new RegExp(`sessionTerminal=${TERMINAL_ID}`));
  await expect(page.getByTestId("terminal-viewport").filter({ visible: true })).toBeVisible();
  expect(fixture.state.posts).toBe(1);
  // Discovery must include sessions hidden from the history list.
  expect(fixture.state.includeHidden).toBe(true);

  await page.getByTestId("chat-terminal-back").filter({ visible: true }).click();
  await expect(page).not.toHaveURL(/sessionTerminal=/);
  await expect(page.getByTestId("chat-input").filter({ visible: true })).toBeVisible();

  await openChatActions(page);
  await page.getByTestId("chat-continue-terminal").filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`sessionTerminal=${TERMINAL_ID}`));
  await expect(page.getByTestId("terminal-viewport").filter({ visible: true })).toBeVisible();
  expect(fixture.state.posts).toBe(1);
});

test("a session running on the server keeps continuation disabled", async ({ page }) => {
  await mockContinueTerminal(page, { sessionRunning: true });
  await openContinueChat(page);

  await openChatActions(page);
  const action = page.getByTestId("chat-continue-terminal").filter({ visible: true });
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute("title", "Wait for the session to become idle.");
});

test("an exited terminal is not reused; a new terminal resumes the session", async ({ page }) => {
  const fixture = await mockContinueTerminal(page, {
    terminals: [
      {
        id: "exited-terminal",
        name: "Codex: old",
        kind: "codex",
        cwd: "/fixture",
        host: null,
        status: "exited",
        pid: 4000,
        exit_code: 0,
        live_session_id: LIVE_ID,
        created_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  });
  await openContinueChat(page);

  await openChatActions(page);
  await page.getByTestId("chat-continue-terminal").filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`sessionTerminal=${TERMINAL_ID}`));
  await expect(page).not.toHaveURL(/exited-terminal/);
  await expect(page.getByTestId("terminal-viewport").filter({ visible: true })).toBeVisible();
  expect(fixture.state.posts).toBe(1);
});

test("a deleted terminal link explains itself and still returns to chat", async ({ page }) => {
  await mockContinueTerminal(page);
  await gotoView(page, "activity");
  await page.goto(`/chat?project=all&chatThread=${THREAD_ID}&sessionTerminal=deleted-terminal`);

  await expect(page.getByTestId("session-terminal-missing")).toContainText(
    "This terminal is no longer running.",
  );
  await page.getByTestId("chat-terminal-back").filter({ visible: true }).click();
  await expect(page).not.toHaveURL(/sessionTerminal=/);
  await expect(page.getByTestId("chat-input").filter({ visible: true })).toBeVisible();
});

test("every native chat agent offers continuation", async ({ page }) => {
  await mockContinueTerminal(page, { agent: "pi" });
  await openContinueChat(page);

  await openChatActions(page);
  await expect(page.getByTestId("chat-continue-terminal").filter({ visible: true })).toBeEnabled();
});

test("an undiscovered session reports why it cannot continue yet", async ({ page }) => {
  const fixture = await mockContinueTerminal(page, { discoverSession: false });
  await openContinueChat(page);

  await openChatActions(page);
  await page.getByTestId("chat-continue-terminal").filter({ visible: true }).click();
  await expect(page.getByTestId("chat-continue-terminal-error")).toContainText(
    "not available in Sessions yet",
  );
  expect(fixture.state.posts).toBe(0);
  await expect(page).toHaveURL(/chatThread=/);
  await expect(page).not.toHaveURL(/sessionTerminal=/);
});

test("a session discovered only after a sync still continues", async ({ page }) => {
  const fixture = await mockContinueTerminal(page, { discoverAfterSync: true });
  await openContinueChat(page);

  await openChatActions(page);
  await page.getByTestId("chat-continue-terminal").filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`sessionTerminal=${TERMINAL_ID}`));
  expect(fixture.state.discoveryCalls).toBeGreaterThan(1);
  expect(fixture.state.posts).toBe(1);
});

test("a chat with no native session yet keeps continuation disabled", async ({ page }) => {
  await mockContinueTerminal(page, { runtimeId: null });
  await openContinueChat(page);

  await openChatActions(page);
  const action = page.getByTestId("chat-continue-terminal").filter({ visible: true });
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute("title", "Send a message before continuing in a terminal.");
});

test("a failed terminal launch stays in chat with the server reason", async ({ page }) => {
  const fixture = await mockContinueTerminal(page, {
    createError: "Terminal limit reached (4)",
  });
  await openContinueChat(page);

  await openChatActions(page);
  await page.getByTestId("chat-continue-terminal").filter({ visible: true }).click();
  await expect(page.getByTestId("chat-continue-terminal-error")).toContainText(
    "Terminal limit reached (4)",
  );
  expect(fixture.state.posts).toBe(1);
  await expect(page).not.toHaveURL(/sessionTerminal=/);
});

test("an SSH-hosted session matches its own host", async ({ page }) => {
  const fixture = await mockContinueTerminal(page, { host: "build-box" });
  await openContinueChat(page);

  await openChatActions(page);
  await page.getByTestId("chat-continue-terminal").filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`sessionTerminal=${TERMINAL_ID}`));
  expect(fixture.state.posts).toBe(1);
});
