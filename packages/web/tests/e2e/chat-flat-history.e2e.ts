import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { closeChatHistory, openChatHistory } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

for (const width of [1440, 390]) {
  test(`history preserves host and archive-source identity while merging live status at ${width}px`, async ({
    page,
  }, testInfo) => {
    const now = Date.now();
    const runtimeId = "50000000-0000-4000-8000-000000000001";
    const summaries = ["host-a", "host-b"].map((host, index) => ({
      id: `50000000-0000-4000-8000-00000000000${index + 2}`,
      title: `Saved conversation on ${host}`,
      updatedAt: now - (index + 4) * 1000,
      running: false,
      agent: "codex",
      runtimeId,
      sourceId: `live-${host}`,
      host,
    }));
    const native = summaries.map((saved, index) => ({
      id: saved.sourceId,
      session_id: runtimeId,
      name: `Native alias on ${saved.host}`,
      agent: "codex",
      status: index === 0 ? "running" : "stopped",
      cwd: `/fixture/${saved.host}`,
      host: saved.host,
      project_id: null,
      task_id: null,
      created_at: new Date(saved.updatedAt).toISOString(),
      last_activity_at: new Date(now - (index + 2) * 1000).toISOString(),
    }));
    const archive = ["source-a", "source-b"].map((source, index) => ({
      id: `archive-${source}`,
      native_id: runtimeId,
      title: `Archived conversation from ${source}`,
      agent: "codex",
      source_id: source,
      project_id: null,
      metadata: { cwd: "/fixture/archive", subdirectory: "" },
      revision: 1,
      created_at: new Date(now - 10000).toISOString(),
      updated_at: new Date(now - index * 1000).toISOString(),
    }));
    await page.addInitScript((secret) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
    }, API_SECRET);
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.route("**/api/chat/threads", (route) =>
      route.fulfill({ json: { threads: summaries } }),
    );
    await page.route("**/api/sessions/live?**", (route) =>
      route.fulfill({ json: { sessions: native, has_more: false } }),
    );
    await page.route("**/api/sessions/archive?**", (route) =>
      route.fulfill({ json: { sessions: archive, has_more: false } }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tasks?chat=full");
    await openChatHistory(page);
    const list = page.getByTestId("chat-session-list");
    const rows = list.locator(":scope > [data-history-id]");
    await expect(rows).toHaveCount(4);
    await expect
      .poll(() =>
        rows.evaluateAll((elements) => elements.map((el) => el.getAttribute("data-history-id"))),
      )
      .toEqual([
        "archive:archive-source-a",
        "archive:archive-source-b",
        `chat:${summaries[0].id}`,
        `chat:${summaries[1].id}`,
      ]);
    for (const saved of summaries) {
      const row = list.locator(`[data-history-id="chat:${saved.id}"]`);
      await expect(row).toContainText(saved.title);
      await expect(row.getByTestId("chat-resume-thread")).toBeVisible();
    }
    await expect(list.getByText(/^Native alias/)).toHaveCount(0);
    await expect(rows.nth(2).getByTestId("chat-session-status")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect(rows.nth(3).getByTestId("chat-session-status")).toHaveAttribute(
      "data-state",
      "idle",
    );
    expect(
      await rows.evaluateAll((elements) =>
        elements.map((el) => Number(el.getAttribute("data-history-updated"))),
      ),
    ).toEqual([now, now - 1000, now - 2000, now - 3000]);
    for (let index = 0; index < archive.length; index++) {
      await expect(rows.nth(index)).toContainText(archive[index].title);
      await expect(rows.nth(index).getByTestId("chat-resume-archive")).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath(`flat-history-hosts-${width}.png`) });
  });
}

for (const width of [1440, 390]) {
  test(`one mixed-source history stays latest-first without duplicate native sessions at ${width}px`, async ({
    page,
  }, testInfo) => {
    const now = Date.now();
    const times = {
      saved: now - 60_000,
      native: now - 120_000,
      archive: now - 180_000,
      working: now - 240_000,
      active: now - 300_000,
    };
    const ids = {
      active: "20000000-0000-4000-8000-000000000001",
      saved: "20000000-0000-4000-8000-000000000002",
      working: "20000000-0000-4000-8000-000000000003",
      activeNative: "30000000-0000-4000-8000-000000000001",
      savedNative: "30000000-0000-4000-8000-000000000002",
      standaloneNative: "30000000-0000-4000-8000-000000000003",
      standaloneArchive: "30000000-0000-4000-8000-000000000004",
    };
    const config = ChatSettingsSchema.parse({ agent: "codex" });
    const active: ChatThread = {
      id: ids.active,
      title: "Old active conversation",
      config,
      cwd: "/fixture/active",
      host: null,
      runtimeId: ids.activeNative,
      sourceId: "live-active",
      backend: "codex-cli",
      updatedAt: times.active,
      messages: [
        {
          id: "saved-answer",
          role: "assistant",
          content: "Cached active answer",
          timestamp: times.active,
        },
      ],
    };
    const threads = [
      {
        id: ids.active,
        title: active.title,
        updatedAt: times.active,
        running: false,
        agent: "codex",
        runtimeId: ids.activeNative,
        sourceId: "live-active",
      },
      {
        id: ids.working,
        title: "Saved working conversation",
        updatedAt: times.working,
        running: true,
        agent: "codex",
        runtimeId: null,
        sourceId: null,
      },
      {
        id: ids.saved,
        title: "Newest saved conversation",
        updatedAt: times.saved,
        running: false,
        agent: "codex",
        runtimeId: ids.savedNative,
        sourceId: "live-saved",
      },
    ];
    threads.push(
      {
        id: "20000000-0000-4000-8000-000000000004",
        title: "Duplicate local saved",
        updatedAt: times.active,
        running: false,
        agent: "codex",
        runtimeId: ids.activeNative,
        sourceId: "live-active",
      },
      {
        id: "20000000-0000-4000-8000-000000000005",
        title: "Duplicate saved history",
        updatedAt: times.saved,
        running: false,
        agent: "codex",
        runtimeId: ids.savedNative,
        sourceId: "live-saved",
      },
    );
    const native = [
      {
        id: "live-active",
        session_id: ids.activeNative,
        name: "Duplicate active native",
        agent: "codex",
        status: "stopped",
        cwd: active.cwd,
        host: null,
        project_id: null,
        task: null,
        last_activity_at: new Date(times.active).toISOString(),
        created_at: new Date(times.active).toISOString(),
      },
      {
        id: "live-saved",
        session_id: ids.savedNative,
        name: "Duplicate saved native",
        agent: "codex",
        status: "stopped",
        cwd: "/fixture/saved",
        host: null,
        project_id: null,
        task: null,
        last_activity_at: new Date(times.saved).toISOString(),
        created_at: new Date(times.saved).toISOString(),
      },
      {
        id: "live-standalone",
        session_id: ids.standaloneNative,
        name: "Standalone native conversation",
        agent: "codex",
        status: "stopped",
        cwd: "/fixture/needle-native",
        host: null,
        project_id: null,
        task: null,
        last_activity_at: new Date(times.native).toISOString(),
        created_at: new Date(times.native).toISOString(),
      },
    ];
    const archive = [
      {
        id: "archive-active",
        native_id: ids.activeNative,
        title: "Duplicate active archive",
        agent: "codex",
        source_id: "local",
        project_id: null,
        metadata: { cwd: active.cwd, subdirectory: "" },
        revision: 1,
        updated_at: new Date(times.active).toISOString(),
        created_at: new Date(times.active).toISOString(),
      },
      {
        id: "archive-saved",
        native_id: ids.savedNative,
        title: "Duplicate saved archive",
        agent: "codex",
        source_id: "local",
        project_id: null,
        metadata: { cwd: "/fixture/saved", subdirectory: "" },
        revision: 1,
        updated_at: new Date(times.saved).toISOString(),
        created_at: new Date(times.saved).toISOString(),
      },
      {
        id: "archive-standalone",
        native_id: ids.standaloneArchive,
        title: "Standalone archived conversation",
        agent: "claude",
        source_id: "local",
        project_id: null,
        metadata: { cwd: "/fixture/needle-archive", subdirectory: "" },
        revision: 1,
        updated_at: new Date(times.archive).toISOString(),
        created_at: new Date(times.archive).toISOString(),
      },
    ];
    await page.addInitScript(
      ({ secret, activeId }) => {
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
        localStorage.setItem(
          "orc_chat_tabs",
          JSON.stringify({ threads: [activeId], active: activeId }),
        );
      },
      { secret: API_SECRET, activeId: active.id },
    );
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.route("**/api/chat/threads", (route) => route.fulfill({ json: { threads } }));
    await page.route(`**/api/chat/threads/${active.id}`, (route) =>
      route.fulfill({ json: active }),
    );
    await page.route(`**/api/chat/threads/${active.id}/live`, (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.route("**/api/sessions/live?**", (route) =>
      route.fulfill({ json: { sessions: native, has_more: false } }),
    );
    await page.route("**/api/sessions/archive?**", (route) => {
      const query = (new URL(route.request().url()).searchParams.get("q") || "").toLowerCase();
      const matches =
        query === "archived-body-needle"
          ? archive.filter((row) => row.id === "archive-standalone")
          : archive.filter((row) =>
              `${row.title} ${row.agent} ${row.metadata.cwd}`.toLowerCase().includes(query),
            );
      return route.fulfill({ json: { sessions: matches, has_more: false } });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks?chat=full&chatThread=${active.id}`);
    await expect(page.getByTestId("chat-message-content").last()).toContainText(
      "Cached active answer",
    );
    await openChatHistory(page);
    const list = page.getByTestId("chat-session-list");
    const rows = list.locator(":scope > [data-history-id]");
    await expect(rows).toHaveCount(5);
    await expect(list.locator("details,summary,h2,h3")).toHaveCount(0);
    const titles = [
      "Newest saved conversation",
      "Standalone native conversation",
      "Standalone archived conversation",
      "Saved working conversation",
      "Old active conversation",
    ];
    await expect
      .poll(() =>
        rows.evaluateAll(
          (elements, titles) =>
            elements.map((el) => titles.find((title) => el.textContent?.includes(title))),
          titles,
        ),
      )
      .toEqual(titles);
    const updates = await rows.evaluateAll((elements) =>
      elements.map((el) => Number(el.getAttribute("data-history-updated"))),
    );
    expect(updates).toEqual([
      times.saved,
      times.native,
      times.archive,
      times.working,
      times.active,
    ]);
    await expect(rows.last().getByTestId("chat-session-select")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(rows.last().getByTestId("chat-tab-close")).toBeVisible();
    await expect(rows.last()).toHaveAttribute("data-history-open", "true");
    await expect(rows.last().getByTestId("chat-session-status")).toHaveAttribute(
      "data-state",
      "open",
    );
    await expect(list.getByText(/^Duplicate /)).toHaveCount(0);
    await expect(rows.nth(3).getByTestId("chat-session-status")).toHaveAttribute(
      "data-state",
      "running",
    );

    await page.screenshot({ path: testInfo.outputPath(`flat-history-${width}.png`) });
    const search = page.getByTestId("chat-session-search");
    for (const [query, title] of [
      ["Newest saved", titles[0]],
      ["needle-native", titles[1]],
      ["archived-body-needle", titles[2]],
    ]) {
      await search.fill(query);
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText(title);
    }
    await search.fill("");
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText(titles[0]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("loading older history preserves one descending list and does not pin an old active session", async ({
  page,
}) => {
  const now = Date.now();
  const summaries = Array.from({ length: 70 }, (_, index) => ({
    id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    title: `Historical conversation ${String(index).padStart(2, "0")}`,
    updatedAt: now - index * 1000,
    running: false,
  }));
  const oldest = summaries[69];
  const thread: ChatThread = {
    ...oldest,
    config: ChatSettingsSchema.parse({ agent: "codex" }),
    cwd: "/fixture",
    host: null,
    runtimeId: null,
    sourceId: null,
    backend: "codex-cli",
    messages: [
      {
        id: "old-answer",
        role: "assistant",
        content: "An older selected answer",
        timestamp: oldest.updatedAt,
      },
    ],
  };
  await page.addInitScript(
    ({ secret, id }) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
      localStorage.setItem("orc_chat_tabs", JSON.stringify({ threads: [id], active: id }));
    },
    { secret: API_SECRET, id: oldest.id },
  );
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/threads", (route) =>
    route.fulfill({ json: { threads: summaries } }),
  );
  await page.route(`**/api/chat/threads/${oldest.id}`, (route) => route.fulfill({ json: thread }));
  await page.route(`**/api/chat/threads/${oldest.id}/live`, (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route("**/api/sessions/live?**", (route) => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/api/sessions/archive?**", (route) =>
    route.fulfill({ json: { sessions: [], has_more: false } }),
  );
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/tasks?chat=full&chatThread=${oldest.id}`);
  await expect(page.getByTestId("chat-message-content").last()).toContainText(
    "An older selected answer",
  );
  await openChatHistory(page);
  const list = page.getByTestId("chat-session-list"),
    rows = list.locator(":scope > [data-history-id]");
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText(summaries[0].title);
  await expect(list.locator(`[data-history-id="chat:${oldest.id}"]`)).toHaveCount(0);
  await page.getByTestId("chat-history-more").click();
  await expect(rows).toHaveCount(70);
  const updates = await rows.evaluateAll((nodes) =>
    nodes.map((node) => Number(node.getAttribute("data-history-updated"))),
  );
  expect(updates).toEqual(summaries.map((item) => item.updatedAt));
  await expect(rows.last()).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("chat-history-more")).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`a closed session needing input stays visible in the same flat history at ${width}px`, async ({
    page,
  }, testInfo) => {
    const config = ChatSettingsSchema.parse({ agent: "codex" });
    const thread: ChatThread = {
      id: "20000000-0000-4000-8000-000000000010",
      title: "Awaiting a review decision",
      config,
      cwd: "/fixture",
      host: null,
      runtimeId: null,
      sourceId: null,
      backend: "codex-cli",
      messages: [],
      updatedAt: Date.now(),
    };
    await page.addInitScript(
      ({ secret, thread }) => {
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
        const original = window.fetch.bind(window),
          encoder = new TextEncoder();
        window.fetch = async (input, init) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            location.href,
          );
          if (url.pathname !== "/api/chat/stream") return original(input, init);
          return new Response(
            new ReadableStream({
              start(controller) {
                const emit = (event: unknown) =>
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(new DOMException("Aborted", "AbortError")),
                  { once: true },
                );
                emit({ type: "thread", thread, runId: "20000000-0000-4000-8000-000000000011" });
                emit({
                  type: "permission_request",
                  data: { requestId: "review-permission", tool: "command", command: "echo review" },
                });
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        };
      },
      { secret: API_SECRET, thread },
    );
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tasks?chat=full");
    await page.getByTestId("chat-input").fill("Review this command before continuing");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("chat-permission")).toContainText("echo review");
    await openChatHistory(page);
    const list = page.getByTestId("chat-session-list");
    const pending = list.locator(`[data-history-id="chat:${thread.id}"]`);
    await expect(pending).toHaveAttribute("data-active", "true");
    await expect(pending.getByTestId("chat-session-status")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    await pending.getByTestId("chat-tab-close").click();
    await expect(pending).toBeVisible();
    await expect(pending).toHaveAttribute("data-history-open", "false");
    await expect(pending.getByTestId("chat-session-status")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    await expect(list.locator("details,summary,h2,h3")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`flat-history-waiting-${width}.png`) });
    await pending.getByTestId("chat-session-select").click();
    await closeChatHistory(page);
    await expect(page.getByTestId("chat-permission")).toContainText("echo review");
  });
}
