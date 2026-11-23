import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, type Page, test } from "@playwright/test";
import { mockPreviewBridge } from "./_preview-demo";
import { HOME, mockSessionHome } from "./_session-home-demo";

const CHAT_C = "50000000-0000-4000-8000-000000000004";

async function mockThreeChats(page: Page) {
  const data = await mockSessionHome(page);
  const chatC = {
    id: CHAT_C,
    title: "Review release notes",
    config: ChatSettingsSchema.parse({ agent: "claude" }),
    cwd: "/home/demo/acme-shop",
    host: null,
    runtimeId: null,
    sourceId: null,
    backend: "claude-code",
    updatedAt: Date.now() - 12 * 60_000,
    messages: [
      {
        id: `${CHAT_C}-q`,
        role: "user" as const,
        content: "Please review release notes.",
        timestamp: Date.now() - 12 * 60_000,
      },
      {
        id: `${CHAT_C}-a`,
        role: "assistant" as const,
        content: "Release notes look ready to ship.",
        timestamp: Date.now() - 12 * 60_000,
      },
    ],
  };
  const all = [...data.chats, chatC];
  await page.route("**/api/chat/threads", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            threads: all.map((chat) => ({
              id: chat.id,
              title: chat.title,
              updatedAt: chat.updatedAt,
              running: false,
              agent: "claude",
            })),
          },
        })
      : route.fallback(),
  );
  const resumedId = "50000000-0000-4000-8000-000000000003";
  const resumedThread = {
    ...data.chats[1],
    id: resumedId,
    title: "Upgrade the payments SDK",
    sourceId: HOME.codexLive,
    messages: [
      {
        id: `${resumedId}-q`,
        role: "user" as const,
        content: "Please upgrade the payments sdk.",
        timestamp: Date.now(),
      },
      {
        id: `${resumedId}-a`,
        role: "assistant" as const,
        content: "Resumed.",
        timestamp: Date.now(),
      },
    ],
  };
  await page.route(`**/api/chat/threads/${resumedId}`, (route) =>
    route.fulfill({ json: resumedThread }),
  );
  await page.route(`**/api/chat/threads/${CHAT_C}`, (route) => route.fulfill({ json: chatC }));
  await page.route(`**/api/chat/threads/${CHAT_C}/live`, (route) => route.fulfill({ status: 204 }));
  return { ...data, chatC };
}

async function selectInRecents(container: ReturnType<Page["locator"]>, historyId: string) {
  const recents = container.getByTestId("session-navigation-recents");
  if ((await recents.getAttribute("aria-selected")) !== "true") await recents.click();
  await container.locator(`[data-history-id="${historyId}"] button`).first().click();
}

test.describe("independent side chat and Chat page", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("switching sessions in side chat and Chat page stays independent", async ({ page }) => {
    await mockThreeChats(page);
    await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);

    const pageSurface = page.getByTestId("session-home");
    const sideSurface = page.getByTestId("side-chat");

    await expect(pageSurface.getByTestId("chat-panel")).toContainText("Here is the checkout plan.");

    await page.getByTestId("chat-open-button").click();
    await expect(sideSurface.getByTestId("chat-panel")).toBeVisible();
    await expect(pageSurface.getByTestId("chat-panel")).toContainText("Here is the checkout plan.");

    await sideSurface.getByTestId("chat-sessions-button").click();
    const dialog = page.getByTestId("chat-sessions-dialog");
    await expect(dialog).toBeVisible();
    await selectInRecents(dialog, `chat:${HOME.chatB}`);

    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );
    await expect(pageSurface.getByTestId("chat-panel")).toContainText("Here is the checkout plan.");
    await expect.poll(() => new URL(page.url()).searchParams.get("chatThread")).toBe(HOME.chatA);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("sideChatThread"))
      .toBe(HOME.chatB);

    await selectInRecents(pageSurface.getByTestId("chat-session-sidebar"), `chat:${CHAT_C}`);
    await expect(pageSurface.getByTestId("chat-panel")).toContainText(
      "Release notes look ready to ship.",
    );
    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );
    await expect.poll(() => new URL(page.url()).searchParams.get("chatThread")).toBe(CHAT_C);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("sideChatThread"))
      .toBe(HOME.chatB);

    await page.getByTestId("nav-activity").click();
    await expect(page).toHaveURL(/\/activity\?/);
    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );
    await expect.poll(() => new URL(page.url()).searchParams.get("chatThread")).toBe(HOME.chatB);

    await page.getByTestId("nav-chat").click();
    await expect(page).toHaveURL(/\/chat\?/);
    await expect(pageSurface.getByTestId("chat-panel")).toContainText(
      "Release notes look ready to ship.",
    );
    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );
  });

  test("deep links target their intended surface without overwriting the other", async ({
    page,
  }) => {
    await mockThreeChats(page);
    await page.goto(
      `/chat?project=all&chatThread=${HOME.chatA}&chat=open&sideChatThread=${HOME.chatB}`,
    );

    const pageSurface = page.getByTestId("session-home");
    const sideSurface = page.getByTestId("side-chat");

    await expect(pageSurface.getByTestId("chat-panel")).toContainText("Here is the checkout plan.");
    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );

    await page.goto(
      `/chat?project=all&sessionLive=${HOME.codexLive}&chat=open&sideChatThread=${HOME.chatB}`,
    );
    await expect(pageSurface.getByTestId("chat-panel")).toContainText("Resumed.");
    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );

    await page.goto(`/activity?project=all&chat=open&chatThread=${CHAT_C}`);
    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Release notes look ready to ship.",
    );
    await page.getByTestId("nav-chat").click();
    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Release notes look ready to ship.",
    );
    await expect(pageSurface.getByTestId("chat-panel")).toContainText("Resumed.");
  });

  test("narrowing below 1280px hands the side chat conversation over to the Chat page", async ({
    page,
  }) => {
    await mockThreeChats(page);
    await page.goto(
      `/chat?project=all&chatThread=${HOME.chatA}&chat=open&sideChatThread=${HOME.chatB}`,
    );

    const pageSurface = page.getByTestId("session-home");
    const sideSurface = page.getByTestId("side-chat");
    await expect(pageSurface.getByTestId("chat-panel")).toContainText("Here is the checkout plan.");
    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(pageSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );
    await expect(page).toHaveURL(new RegExp(`/chat\\?.*chatThread=${HOME.chatB}`));
    expect(new URL(page.url()).searchParams.has("chat")).toBe(false);
    expect(new URL(page.url()).searchParams.has("sideChatThread")).toBe(false);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(pageSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );
  });

  test("narrowing preserves an unsent draft from a blank side chat", async ({ page }) => {
    await mockThreeChats(page);
    await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
    await expect(page.getByTestId("session-home")).toContainText("Here is the checkout plan.");

    await page.getByTestId("nav-activity").click();
    await page.getByTestId("chat-open-button").click();
    const sideSurface = page.getByTestId("side-chat");
    await sideSurface.getByTestId("chat-input").fill("Draft carried across breakpoint");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page).toHaveURL(/\/chat\?/);
    await expect(page.getByTestId("session-home").getByTestId("chat-input")).toHaveValue(
      "Draft carried across breakpoint",
    );
  });

  test("desktop preview stays coupled to the Chat page when side chat switches", async ({
    page,
  }) => {
    await mockThreeChats(page);
    await mockPreviewBridge(page);
    await page.goto(
      `/chat?project=all&chatThread=${HOME.chatA}&chat=open&sideChatThread=${HOME.chatB}`,
    );

    const pageSurface = page.getByTestId("session-home");
    const sideSurface = page.getByTestId("side-chat");

    await pageSurface.getByTestId("session-inspector-toggle").filter({ visible: true }).click();
    await pageSurface.getByTestId("session-inspector-tab-browser").click();
    await expect(pageSurface.getByTestId("desktop-preview-browser-surface")).toBeVisible();
    await expect(sideSurface.getByTestId("session-inspector")).toHaveCount(0);

    await sideSurface.getByTestId("chat-sessions-button").click();
    const dialog = page.getByTestId("chat-sessions-dialog");
    await expect(dialog).toBeVisible();
    await selectInRecents(dialog, `chat:${CHAT_C}`);

    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Release notes look ready to ship.",
    );
    await expect(pageSurface.getByTestId("chat-panel")).toContainText("Here is the checkout plan.");
    await expect(pageSurface.getByTestId("desktop-preview-browser-surface")).toBeVisible();
  });

  test("both open surfaces suppress completion notifications while a third thread stays unread", async ({
    page,
  }) => {
    await mockThreeChats(page);
    const now = Date.now();
    const acknowledged = new Set<string>();
    const notifications = [
      {
        id: "notif-page",
        type: "agent.finished",
        source_id: HOME.chatA,
        title: "Checkout plan finished",
        body: "",
        level: "done",
        project_id: null,
        path: `/chat?chatThread=${HOME.chatA}`,
        requires_action: false,
        created_at: now - 1000,
        expires_at: now + 60_000,
        read_at: null,
        dismissed_at: null,
      },
      {
        id: "notif-side",
        type: "agent.finished",
        source_id: HOME.chatB,
        title: "Billing bugs finished",
        body: "",
        level: "done",
        project_id: null,
        path: `/activity?chat=open&chatThread=${HOME.chatB}`,
        requires_action: false,
        created_at: now - 1000,
        expires_at: now + 60_000,
        read_at: null,
        dismissed_at: null,
      },
      {
        id: "notif-other",
        type: "agent.finished",
        source_id: CHAT_C,
        title: "Release notes finished",
        body: "",
        level: "done",
        project_id: null,
        path: `/chat?chatThread=${CHAT_C}`,
        requires_action: false,
        created_at: now - 1000,
        expires_at: now + 60_000,
        read_at: null,
        dismissed_at: null,
      },
    ];
    await page.route("**/api/notifications?**", (route) => {
      const remaining = notifications.filter((item) => !acknowledged.has(item.id));
      return route.fulfill({
        json: { notifications: remaining, unread: remaining.length, has_more: false },
      });
    });
    await page.route(/\/api\/notifications\/([^/?]+)$/, (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      const id = new URL(route.request().url()).pathname.split("/").pop() ?? "";
      acknowledged.add(id);
      return route.fulfill({ json: { ok: true } });
    });

    await page.goto(
      `/chat?project=all&chatThread=${HOME.chatA}&chat=open&sideChatThread=${HOME.chatB}`,
    );
    await expect(page.getByTestId("session-home")).toContainText("Here is the checkout plan.");
    await expect(page.getByTestId("side-chat")).toContainText("Three billing bugs are open.");

    await expect.poll(() => acknowledged.has("notif-page")).toBe(true);
    await expect.poll(() => acknowledged.has("notif-side")).toBe(true);
    expect(acknowledged.has("notif-other")).toBe(false);
    await expect(page.getByTestId("notification-unread")).toHaveText("1");
  });

  test("sessionTerminal on /chat?chat=open only occupies the Chat page and does not hijack side chat", async ({
    page,
  }) => {
    await mockThreeChats(page);
    await page.goto(
      `/chat?project=all&chatThread=${HOME.chatA}&sessionTerminal=${HOME.terminal}&chat=open&sideChatThread=${HOME.chatB}`,
    );

    const pageSurface = page.getByTestId("session-home");
    const sideSurface = page.getByTestId("side-chat");

    await expect(pageSurface.getByTestId("terminal-viewport")).toBeVisible();
    await expect(sideSurface.getByTestId("terminal-viewport")).toHaveCount(0);
    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );
    await expect(sideSurface.getByTestId("chat-input")).toBeVisible();
  });

  test("side chat Session settings on /chat?chat=open does not expose desktop browser agent access", async ({
    page,
  }) => {
    await mockThreeChats(page);
    await mockPreviewBridge(page);
    await page.goto(
      `/chat?project=all&chatThread=${HOME.chatA}&chat=open&sideChatThread=${HOME.chatB}`,
    );

    const pageSurface = page.getByTestId("session-home");
    const sideSurface = page.getByTestId("side-chat");

    await expect(pageSurface.getByTestId("chat-panel")).toContainText("Here is the checkout plan.");
    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );

    await sideSurface.getByTestId("chat-options-button").click();
    await page.getByTestId("chat-config-button").filter({ visible: true }).last().click();
    await expect(page.getByTestId("chat-config-dialog")).toBeVisible();
    await page.getByTestId("chat-settings-tab-customize").click();
    await expect(page.getByTestId("chat-browser-agent-access")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-config-dialog")).toBeHidden();

    const pageConfigButton = pageSurface.getByTestId("chat-config-button");
    if (await pageConfigButton.isVisible()) {
      await pageConfigButton.click();
    } else {
      await pageSurface.getByTestId("chat-options-button").click();
      await page.getByTestId("chat-config-button").filter({ visible: true }).last().click();
    }
    await expect(page.getByTestId("chat-config-dialog")).toBeVisible();
    await page.getByTestId("chat-settings-tab-customize").click();
    await expect(page.getByTestId("chat-browser-agent-access")).toBeVisible();
  });

  test("text selection toolbar on Chat page quotes only into the Chat page composer when side chat is open", async ({
    page,
  }) => {
    await mockThreeChats(page);
    await page.goto(
      `/chat?project=all&chatThread=${HOME.chatA}&chat=open&sideChatThread=${HOME.chatB}`,
    );

    const pageSurface = page.getByTestId("session-home");
    const sideSurface = page.getByTestId("side-chat");

    const pageReply = pageSurface
      .locator(
        '[data-testid="chat-message"][data-role="assistant"] [data-testid="chat-message-content"]',
      )
      .getByText("Here is the checkout plan.")
      .first();
    await expect(pageReply).toBeVisible();
    await expect(sideSurface.getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );

    await pageReply.click({ clickCount: 3 });
    const toolbars = page.getByTestId("chat-selection-toolbar");
    await expect(toolbars).toHaveCount(1);
    await expect(toolbars.first()).toBeVisible();

    await page.getByTestId("chat-selection-ask").click();
    await expect(toolbars).toHaveCount(0);

    const pageDraft = await pageSurface.getByTestId("chat-input").inputValue();
    expect(pageDraft).toContain("> Here is the checkout plan.");
    expect(pageDraft).toContain("Plan the checkout redesign");
    await expect(sideSurface.getByTestId("chat-input")).toHaveValue("");
  });

  test("narrow viewport deep link is not clobbered by localStorage tab restore", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const data = await mockThreeChats(page);
    await page.addInitScript(
      ({ chatA, chatB }) => {
        localStorage.setItem(
          "orc_chat_tabs",
          JSON.stringify({ threads: [chatA, chatB], active: chatA, sideActive: null }),
        );
      },
      { chatA: HOME.chatA, chatB: HOME.chatB },
    );
    await page.route(`**/api/chat/threads/${HOME.chatA}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({ json: data.chats[0] });
    });

    const restoreDone = page.waitForResponse((response) =>
      response.url().includes(`/api/chat/threads/${HOME.chatA}`),
    );
    await page.goto(`/activity?project=all&chat=open&chatThread=${HOME.chatB}`);
    await expect(page).toHaveURL(new RegExp(`/chat\\?.*chatThread=${HOME.chatB}`));
    await expect(page.getByTestId("session-home").getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );
    await restoreDone;
    await expect(page.getByTestId("session-home").getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );
    await expect.poll(() => new URL(page.url()).searchParams.get("chatThread")).toBe(HOME.chatB);
  });

  test("expanding an unsaved side chat detaches it so reopening side chat has an independent composer", async ({
    page,
  }) => {
    await mockThreeChats(page);
    await page.goto(`/activity?project=all&chat=open`);

    const sideSurface = page.getByTestId("side-chat");
    const pageSurface = page.getByTestId("session-home");

    await sideSurface.getByTestId("chat-input").fill("Unsaved draft from side");
    await sideSurface.getByTestId("chat-fullscreen-button").click();

    await expect(page).toHaveURL(/\/chat\?/);
    await expect(pageSurface.getByTestId("chat-input")).toHaveValue("Unsaved draft from side");

    await page.getByTestId("chat-open-button").click();
    await expect(sideSurface.getByTestId("chat-panel")).toBeVisible();
    await expect(sideSurface.getByTestId("chat-input")).toHaveValue("");

    await sideSurface.getByTestId("chat-input").fill("Fresh side draft");
    await expect(pageSurface.getByTestId("chat-input")).toHaveValue("Unsaved draft from side");
    await pageSurface.getByTestId("chat-input").fill("Edited page draft");
    await expect(sideSurface.getByTestId("chat-input")).toHaveValue("Fresh side draft");
  });

  test("narrowing from /chat with sessionView clears stale page views during side chat handoff", async ({
    page,
  }) => {
    await mockThreeChats(page);
    await page.goto(
      `/chat?project=all&chatThread=${HOME.chatA}&sessionView=${HOME.codexLive}&chat=open&sideChatThread=${HOME.chatB}`,
    );

    await expect(page.getByTestId("side-chat").getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page).toHaveURL(new RegExp(`/chat\\?.*chatThread=${HOME.chatB}`));
    expect(new URL(page.url()).searchParams.has("sessionView")).toBe(false);
    expect(new URL(page.url()).searchParams.has("sessionTerminal")).toBe(false);
    expect(new URL(page.url()).searchParams.has("sessionLive")).toBe(false);
    await expect(page.getByTestId("session-home").getByTestId("chat-panel")).toContainText(
      "Three billing bugs are open.",
    );
  });
});
