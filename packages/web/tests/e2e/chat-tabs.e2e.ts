import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { chooseChatAgent, openChatActions, openChatSettings, showSessionSection } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };
const defaults = ChatSettingsSchema.parse({});
const login = (secret: string) =>
  localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);

test.beforeEach(async ({ page, request }) => {
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
  await page.addInitScript(login, API_SECRET);
});
test.afterEach(async ({ request }) => {
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
});

test("a run keeps going in its own tab while another conversation runs, and the link opens it", async ({
  page,
  browser,
  baseURL,
}) => {
  const background = `BG-${Date.now()}`;
  const foreground = `FG-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  await showSessionSection(page, "recents");
  await panel
    .getByTestId("chat-input")
    .fill(`Respond after 2500ms. Reply with exactly: ${background}.`);
  await panel.getByTestId("chat-send-button").click();
  const tabs = panel.getByTestId("chat-session-list").getByTestId("chat-tab");
  const backgroundTab = tabs.filter({ hasText: background });
  await expect(backgroundTab).toHaveAttribute("data-state", "working");

  await panel.getByTestId("chat-clear-button").click();
  await expect(tabs).toHaveCount(1);
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${foreground}.`);
  await expect(tabs).toHaveCount(2);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(foreground);
  await expect(panel.getByTestId("chat-messages")).not.toContainText(background);

  // The first run finished unseen, so its tab asks for attention instead of being dropped.
  await expect(backgroundTab).toHaveAttribute("data-state", "done", { timeout: 10000 });
  await backgroundTab.getByTestId("chat-session-select").click();
  await expect(backgroundTab).toHaveAttribute("data-active", "true");
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(background);
  await expect(backgroundTab).toHaveAttribute("data-state", "idle");

  await expect(page).toHaveURL(/[?&]chatThread=[0-9a-f-]{36}/);
  const shared = page.url();
  const other = await browser.newContext({ baseURL });
  try {
    const visitor = await other.newPage();
    await visitor.addInitScript(login, API_SECRET);
    await visitor.goto(shared);
    await expect(
      visitor.getByTestId("chat-panel").getByTestId("chat-message-content").last(),
    ).toContainText(background);
  } finally {
    await other.close();
  }
});

test("chat preferences picked in the browser survive a reload", async ({ page }) => {
  await page.goto("/tasks?chat=full");
  await chooseChatAgent(page, "claude");
  await openChatSettings(page, "customize");
  await page.getByTestId("chat-permission-mode").selectOption("bypassPermissions");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("chat-panel").getByTestId("chat-agent-current")).toHaveText(
    "Claude Code",
  );
  await openChatSettings(page, "customize");
  await expect(page.getByTestId("chat-permission-mode")).toHaveValue("bypassPermissions");
});

test("refresh and page reload follow a real server-owned turn without starting it twice", async ({
  page,
}) => {
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/chat/stream")) posts++;
  });
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  const reply = `REFRESH-${Date.now()}`;
  await panel.getByTestId("chat-input").fill(`Respond after 3500ms. Reply with exactly: ${reply}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(page).toHaveURL(/[?&]chatThread=[0-9a-f-]{36}/);
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "true");
  await page.reload();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await expect(panel.getByTestId("chat-message-content")).toHaveCount(2);
  expect(posts).toBe(1);
});

test("stopping a reply before its run is named and closing the tab still stops the run", async ({
  page,
}) => {
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  await showSessionSection(page, "recents");
  const first = `FIRST-${Date.now()}`;
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${first}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(first);

  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/chat/stream", async (route) => {
    await held;
    await route.continue();
  });
  await panel.getByTestId("chat-clear-button").click();
  const tabs = panel.getByTestId("chat-session-list").getByTestId("chat-tab");
  await expect(tabs).toHaveCount(1);
  await panel.getByTestId("chat-input").fill("Respond after 5000ms. Reply with exactly: LATE.");
  await expect(tabs).toHaveCount(2);
  await panel.getByTestId("chat-send-button").click();
  await panel.getByTestId("chat-cancel-button").click();
  await tabs
    .filter({ has: page.locator('[data-testid="chat-session-select"][aria-current="true"]') })
    .getByTestId("chat-tab-close")
    .click();
  await expect(panel.getByTestId("chat-tab-close")).toHaveCount(1);
  const cancelled = page.waitForRequest(
    (request) =>
      request.method() === "POST" && /\/api\/chat\/runs\/[^/]+\/cancel$/.test(request.url()),
  );
  release();
  await cancelled;
});

test("a reopened tab shows a reply that finished between loading it and attaching", async ({
  page,
}) => {
  const reply = `DONE-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${reply}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  await expect(page).toHaveURL(/[?&]chatThread=[0-9a-f-]{36}/);

  // The first load sees the question still unanswered; by the time the tab attaches, the turn
  // has finished.
  let first = true;
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}$/, async (route) => {
    const response = await route.fetch();
    const thread = await response.json();
    if (first) {
      first = false;
      thread.messages = thread.messages.slice(0, -1);
    }
    await route.fulfill({ response, json: thread });
  });
  await page.reload();
  await expect(
    page.getByTestId("chat-panel").getByTestId("chat-message-content").last(),
  ).toContainText(reply);
});

test("a reply that finishes while reattach is pending is still announced", async ({ page }) => {
  const reply = `ANNOUNCE-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${reply}.`);
  await panel.getByTestId("chat-send-button").click();
  // Wait for the turn to actually finish: the streaming bubble matches the text too.
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  await expect(page).toHaveURL(/[?&]chatThread=[0-9a-f-]{36}/);

  // Every snapshot before the reattach still shows the question unanswered, and
  // the reattach is held open until the turn has finished: /live answers 204 and
  // the reply loads without streaming ever being claimed, so only the follow's
  // settlement can announce it.
  let liveRequested = false;
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}$/, async (route) => {
    const response = await route.fetch();
    const thread = await response.json();
    if (!liveRequested) thread.messages = thread.messages.slice(0, -1);
    await route.fulfill({ response, json: thread });
  });
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}\/live$/, async (route) => {
    liveRequested = true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.reload();
  // While the reattach is pending the tab reads idle and nothing is announced yet.
  await page.waitForTimeout(700);
  expect(await panel.getAttribute("data-streaming")).toBe("false");
  expect(await page.getByTestId("chat-live-announcer").textContent()).toBe("");
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  await expect(page.getByTestId("chat-live-announcer")).toContainText(reply);
});

test("a live completion announces the finished reply", async ({ page }) => {
  const reply = `LIVE-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${reply}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  // The streaming falling edge must still read the finished reply: finish()
  // appends a new message id in the same commit, so the new-reply gate passes.
  await expect(page.getByTestId("chat-live-announcer")).toContainText(reply);
});

test("a mid-turn refresh that already loads the finished reply still announces it", async ({
  page,
}) => {
  const first = `SETUP-${Date.now()}`;
  const reply = `MIDTURN-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  // A first completed turn gives the tab a thread. The second turn's stream is
  // then held unfulfilled while its server-side run finishes, so the tab keeps
  // streaming:true with no events — like a stalled connection.
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${first}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(first);

  let holding = false;
  let serverDone: () => void;
  const streamHeld = new Promise<void>((resolve) => {
    serverDone = resolve;
  });
  let snapshotLoaded: () => void;
  const refreshed = new Promise<void>((resolve) => {
    snapshotLoaded = resolve;
  });
  await page.route(/\/api\/chat\/stream$/, async (route) => {
    const response = await route.fetch(); // the run finishes server-side
    holding = true;
    serverDone();
    await refreshed; // keep the client streaming until the mid-turn refresh
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The refresh aborted this reader; fulfilling late is a no-op.
    await route.fulfill({ response }).catch(() => {});
  });
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}$/, async (route) => {
    await route.continue();
    if (holding) snapshotLoaded();
  });

  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${reply}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "true");
  await streamHeld;
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").filter({ visible: true }).click();
  // The refresh snapshot already contains the finished reply while streaming is
  // preserved; /live then answers 204 and finish() appends nothing, so only the
  // pending-completion memory can announce it.
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  await expect(page.getByTestId("chat-live-announcer")).toContainText(reply);
});

test("a mid-turn refresh that loads a reply identical to the previous one still announces it", async ({
  page,
}) => {
  const same = `SAME-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  // Two consecutive turns with the SAME reply text: the second reply matches the
  // history baseline's content, but the transcript grew (its user message
  // persisted), so it is a genuine completion, not the pre-turn history.
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${same}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(same);

  let holding = false;
  let serverDone: () => void;
  const streamHeld = new Promise<void>((resolve) => {
    serverDone = resolve;
  });
  let snapshotLoaded: () => void;
  const refreshed = new Promise<void>((resolve) => {
    snapshotLoaded = resolve;
  });
  await page.route(/\/api\/chat\/stream$/, async (route) => {
    const response = await route.fetch(); // the run finishes server-side
    holding = true;
    serverDone();
    await refreshed; // keep the client streaming until the mid-turn refresh
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The refresh aborted this reader; fulfilling late is a no-op.
    await route.fulfill({ response }).catch(() => {});
  });
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}$/, async (route) => {
    await route.continue();
    if (holding) snapshotLoaded();
  });

  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${same}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "true");
  await streamHeld;
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").filter({ visible: true }).click();
  // The snapshot already contains the finished identical-content reply while
  // streaming is preserved; /live answers 204 and finish() appends nothing. The
  // content match with the baseline must not silence a genuine new reply.
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(same);
  await expect(page.getByTestId("chat-live-announcer")).toContainText(same);
});

test("a mid-turn refresh to a truncated window still announces an identical-content reply", async ({
  page,
}) => {
  const first = `SETUP-${Date.now()}`;
  const same = `WINDOW-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  // Hold every thread GET so syncThread cannot replace the client ids: the
  // truncated refresh window below then shares no id with the loaded transcript
  // and replaces it outright (mergeLoadedHistory), shrinking the visible count.
  let allowGets = false;
  let truncate = false;
  let releaseGets: () => void;
  const getsGate = new Promise<void>((resolve) => {
    releaseGets = resolve;
  });
  let holding = false;
  let snapshotLoaded: () => void;
  const refreshed = new Promise<void>((resolve) => {
    snapshotLoaded = resolve;
  });
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}$/, async (route) => {
    if (!allowGets) {
      await getsGate;
      await route.abort().catch(() => {});
      return;
    }
    const response = await route.fetch();
    if (truncate) {
      // A bounded rebuild window: only the tail survives — fewer messages than
      // the tab had loaded, so snapshot size alone cannot prove turn progress.
      const body = await response.json();
      body.messages = body.messages.slice(-3);
      await route.fulfill({ response, json: body });
    } else {
      await route.fulfill({ response });
    }
    if (holding) snapshotLoaded();
  });
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}\/session$/, (route) =>
    route.fulfill({ json: { changed: false, running: false, live: null, queued: [] } }),
  );

  // Two setup turns give the tab a four-message transcript ending at `same`.
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${first}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${same}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(same);

  let serverDone: () => void;
  const streamHeld = new Promise<void>((resolve) => {
    serverDone = resolve;
  });
  await page.route(/\/api\/chat\/stream$/, async (route) => {
    const response = await route.fetch(); // the run finishes server-side
    holding = true;
    serverDone();
    await refreshed; // keep the client streaming until the mid-turn refresh
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The refresh aborted this reader; fulfilling late is a no-op.
    await route.fulfill({ response }).catch(() => {});
  });

  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${same}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "true");
  await streamHeld;
  allowGets = true;
  truncate = true;
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").filter({ visible: true }).click();
  // The refresh replaces the transcript with a three-message tail window while
  // streaming is preserved; /live answers 204 and finish() appends nothing. The
  // turn's persisted user message proves progress, so the identical-content
  // reply must still be announced.
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(same);
  await expect(page.getByTestId("chat-live-announcer")).toContainText(same);
  releaseGets();
});

test("a refresh that reverts to pre-turn history does not announce it", async ({ page }) => {
  const first = `BASE-${Date.now()}`;
  const second = `UNSENT-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${first}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(first);

  // The next send never reaches the server, so the snapshot still ends with the
  // historical reply while the tab optimistically claims streaming.
  let release: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/chat\/stream$/, async (route) => {
    await stalled;
    await route.abort().catch(() => {});
  });
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${second}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "true");
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").filter({ visible: true }).click();
  // The refresh reverts to the pre-turn history; /live answers 204 (no run was
  // ever started) and finish() appends nothing. History must stay silent.
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(first);
  await page.waitForTimeout(1000);
  expect(await page.getByTestId("chat-live-announcer").textContent()).not.toContain(first);
  release();
});

test("a persisted-id twin of an unsynced reply is not re-announced as a completion", async ({
  page,
}) => {
  const reply = `SWAP-${Date.now()}`;
  const second = `UNSENT2-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  // Hold every thread GET until the refresh so syncThread cannot replace the
  // client-generated reply id, and stub the session query so no auto-rebuild
  // competes for the snapshot.
  let allowGets = false;
  let releaseGets: () => void;
  const getsGate = new Promise<void>((resolve) => {
    releaseGets = resolve;
  });
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}$/, async (route) => {
    if (!allowGets) {
      await getsGate;
      await route.abort().catch(() => {});
      return;
    }
    await route.continue();
  });
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}\/session$/, (route) =>
    route.fulfill({ json: { changed: false, running: false, live: null, queued: [] } }),
  );

  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${reply}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  // The reply was announced live under its client id; syncThread is still held.

  // The next send never reaches the server; the refresh snapshot returns the
  // SAME historical reply under its persisted id while streaming is claimed.
  let releasePost: () => void;
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  await page.route(/\/api\/chat\/stream$/, async (route) => {
    await postGate;
    await route.abort().catch(() => {});
  });
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${second}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "true");
  allowGets = true;
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").filter({ visible: true }).click();
  // /live answers 204 (no run was started) and finish() appends nothing. The
  // persisted twin of the already-announced reply must not be read out again.
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  await page.waitForTimeout(1000);
  expect(await page.getByTestId("chat-live-announcer").textContent()).not.toContain(reply);
  releasePost();
  releaseGets();
});

test("a stalled send repeating identical history is not announced as a completion", async ({
  page,
}) => {
  const same = `ECHO-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  // Hold every thread GET so the tab keeps client ids, and stub the session
  // query so no auto-rebuild competes for the snapshot.
  let allowGets = false;
  let releaseGets: () => void;
  const getsGate = new Promise<void>((resolve) => {
    releaseGets = resolve;
  });
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}$/, async (route) => {
    if (!allowGets) {
      await getsGate;
      await route.abort().catch(() => {});
      return;
    }
    await route.continue();
  });
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}\/session$/, (route) =>
    route.fulfill({ json: { changed: false, running: false, live: null, queued: [] } }),
  );

  // Two completed turns with the SAME prompt and reply: the history's shape
  // now mirrors a genuine next turn exactly (user, reply, user, reply).
  for (let i = 0; i < 2; i += 1) {
    await panel.getByTestId("chat-input").fill(`Reply with exactly: ${same}.`);
    await panel.getByTestId("chat-send-button").click();
    await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
    await expect(panel.getByTestId("chat-message-content").last()).toContainText(same);
  }

  // The third identical send never reaches the server.
  let releasePost: () => void;
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  await page.route(/\/api\/chat\/stream$/, async (route) => {
    await postGate;
    await route.abort().catch(() => {});
  });
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${same}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "true");
  allowGets = true;
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").filter({ visible: true }).click();
  // The snapshot returns the two-turn history under persisted reply ids; its
  // tail (user, reply) matches the stalled send's content shape, but the send's
  // own message id is absent — no new turn happened. /live answers 204 and
  // finish() appends nothing; the history must stay silent.
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(same);
  await page.waitForTimeout(1000);
  expect(await page.getByTestId("chat-live-announcer").textContent()).not.toContain(same);
  releasePost();
  releaseGets();
});

test("a background queue dispatch whose send stalls does not announce the prior reply", async ({
  page,
}) => {
  const first = `BG-${Date.now()}`;
  const second = `BGQUEUED-${Date.now()}`;
  // Isolate from session-changed rebuilds.
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}\/session$/, (route) =>
    route.fulfill({ json: { changed: false, running: false, live: null, queued: [] } }),
  );
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");

  let postCount = 0;
  let releaseFirst: () => void;
  const secondQueued = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let dispatchStarted: () => void;
  const backgroundDispatch = new Promise<void>((resolve) => {
    dispatchStarted = resolve;
  });
  let releasePost: () => void;
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  await page.route(/\/api\/chat\/stream$/, async (route) => {
    postCount += 1;
    if (postCount === 1) {
      const response = await route.fetch(); // turn 1 finishes server-side
      await secondQueued; // keep the client streaming until turn 2 is queued
      await route.fulfill({ response }).catch(() => {});
      return;
    }
    // The background dispatch never reaches the server.
    dispatchStarted();
    await postGate;
    await route.abort().catch(() => {});
  });

  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${first}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "true");
  // Queue turn 2 while turn 1 is still streaming, then leave for a blank tab so
  // turn 1 finishes and the queue dispatches turn 2 in the BACKGROUND.
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${second}.`);
  await panel.getByTestId("chat-send-button").click();
  await panel.getByTestId("chat-clear-button").click();
  releaseFirst();
  await backgroundDispatch;

  // Return to the first tab while its background send is stalled, and refresh:
  // the snapshot reverts to turn 1's completed reply (turn 2 never reached the
  // server). That reply is the baseline captured at turn 2's dispatch — history,
  // not a completion — even though the announcer never saw the background turns.
  await showSessionSection(page, "recents");
  const tabs = panel.getByTestId("chat-session-list").getByTestId("chat-tab");
  await tabs.filter({ hasText: first }).getByTestId("chat-session-select").click();
  await expect(panel).toHaveAttribute("data-streaming", "true");
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").filter({ visible: true }).click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(first);
  await page.waitForTimeout(1000);
  expect(await page.getByTestId("chat-live-announcer").textContent()).not.toContain(first);
  releasePost();
});

test("opening a finished thread does not announce its historical reply", async ({ page }) => {
  const reply = `HISTORY-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${reply}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  await expect(page).toHaveURL(/[?&]chatThread=[0-9a-f-]{36}/);

  // Reopening the finished thread attaches and gets a 204 with nothing new to
  // load: that idle settlement must not read out the reply already on screen.
  await page.reload();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  await page.waitForTimeout(1500);
  expect(await page.getByTestId("chat-live-announcer").textContent()).toBe("");
});

test("switching between idle tabs does not announce their replies", async ({ page }) => {
  const first = `FIRST-${Date.now()}`;
  const second = `SECOND-${Date.now()}`;
  // Isolate switching from transcript rebuilds: no session changes are reported,
  // so any announcement here could only come from crossing tab state.
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}\/session$/, (route) =>
    route.fulfill({ json: { changed: false, running: false, live: null, queued: [] } }),
  );
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${first}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(first);
  // A second turn gives the first tab a different settlement count than the second.
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${first}-again.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(`${first}-again`);
  await panel.getByTestId("chat-clear-button").click();
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${second}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(second);
  await showSessionSection(page, "recents");
  const tabs = panel.getByTestId("chat-session-list").getByTestId("chat-tab");
  await expect(tabs).toHaveCount(2);

  // Switching conversations is not a completion: nothing may be read out, in
  // either direction, even though the tabs' settlement counts differ.
  await tabs.filter({ hasText: first }).getByTestId("chat-session-select").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(`${first}-again`);
  await page.waitForTimeout(800);
  expect(await page.getByTestId("chat-live-announcer").textContent()).toBe("");
  await tabs.filter({ hasText: second }).getByTestId("chat-session-select").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(second);
  await page.waitForTimeout(800);
  expect(await page.getByTestId("chat-live-announcer").textContent()).toBe("");
});

test("an unchanged refresh does not announce the reply already on screen", async ({ page }) => {
  const reply = `NOOP-${Date.now()}`;
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${reply}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);

  // Reopen the finished thread with a fresh announcer, then refresh without
  // changing the transcript: neither the idle attach nor the no-op refresh may
  // read out the historical reply. A failed refresh must stay silent too.
  await page.reload();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  await page.waitForTimeout(1200);
  expect(await page.getByTestId("chat-live-announcer").textContent()).toBe("");
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").filter({ visible: true }).click();
  await page.waitForTimeout(1500);
  expect(await page.getByTestId("chat-live-announcer").textContent()).toBe("");
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}$/, (route) =>
    route.fulfill({ status: 500, json: { error: "fixture failure" } }),
  );
  await page.getByTestId("chat-refresh-button").filter({ visible: true }).click();
  await page.waitForTimeout(1500);
  expect(await page.getByTestId("chat-live-announcer").textContent()).toBe("");
});

test("an unchanged refresh after a local completion does not re-announce", async ({ page }) => {
  const reply = `SYNC-${Date.now()}`;
  const other = `OTHER-${Date.now()}`;
  // Isolate the refresh from session-changed rebuilds.
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}\/session$/, (route) =>
    route.fulfill({ json: { changed: false, running: false, live: null, queued: [] } }),
  );
  await page.goto("/tasks?chat=full");
  const panel = page.getByTestId("chat-panel");
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${reply}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  // Let syncThread replace the client-generated message id with the persisted one.
  await page.waitForTimeout(1000);

  // A second conversation, then back to the first: the live region clears
  // without announcing; the reply on screen was already announced once, live.
  await panel.getByTestId("chat-clear-button").click();
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${other}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 15_000 });
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(other);
  await showSessionSection(page, "recents");
  const tabs = panel.getByTestId("chat-session-list").getByTestId("chat-tab");
  await expect(tabs).toHaveCount(2);
  await tabs.filter({ hasText: reply }).getByTestId("chat-session-select").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  await page.waitForTimeout(800);
  expect(await page.getByTestId("chat-live-announcer").textContent()).toBe("");

  // The persisted id differs from the announced client id, but the reply is the
  // same: an unchanged refresh must not read it out a second time.
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").filter({ visible: true }).click();
  await page.waitForTimeout(1500);
  expect(await page.getByTestId("chat-live-announcer").textContent()).toBe("");
});
