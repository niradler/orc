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
});
